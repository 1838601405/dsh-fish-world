// 真人发言库：只收「真人怎么接话」，开口前只借「接法」，不借用词。
//
// 主人 2026-11-17 的原话：
//   「只做『收真人发言 + 开口前参考接法』；收：群聊/评论里的真人句子入库，每条带来源（群/人/时间）；
//     参考时只借『接法』（先怼还是先问、几个字），不借『用词』；召回要有阈值，找不到就正常说，不硬套。」
//
// 于是这个模块的**灵魂**在 recallShape()：返回值里一条原始句子都不许有。
// 只给「开头动作 + 长度档 + 来源/时间/长度」，不给样本文本。
// 一旦返回样本句子，就等于把用词也借出去了 —— 那这半条链路就白做了。
//
// 落盘：JSONL，一行一条 { text, chatKey, who, qqId, at, len }。
// 文件会一直长：超过 5000 行就裁到最近 3000 行，重写用「临时文件 + rename」的原子写，
// 免得进程半路死掉留下半份文件。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一条真人发言最多留多少字：再长就不是「接一句」了，是文章。 */
const MAX_TEXT_LEN = 200
/** 文件超过这个行数就裁剪（行数会一直长，得有个天花板）。 */
const MAX_LINES = 5000
/** 裁剪时只留最近这么多行。 */
const KEEP_LINES = 3000
/** 2-gram Jaccard 相似度阈值：低于它算「不是同一类话」，不硬套。 */
const JACCARD_THRESHOLD = 0.2
/** 命中少于这个数就不给建议 —— 样本不够就正常说。 */
const MIN_HITS = 3
/** 同一个人同一个文本，这个窗口内再出现算重发/回声。 */
const DUP_WINDOW_MS = 5 * 60 * 1000
/** 长度分档：≤6 / 7–12 / >12。 */
const SHORT_MAX = 6
const MID_MAX = 12

// ---- 入库前的过滤：这些都不是「真人接的一句话」----

/** 纯链接：一条消息只有一个 URL，没有可学的接法。 */
const URL_ONLY = /^(?:https?:\/\/|www\.)\S+$/i
/** 工具调用语法（各家写法按结构认，不枚举某一种标签）。 */
const TOOL_MARKUP = /<\/?(?:antml:)?(?:invoke|function_calls|function_call|parameter|tool_call|tool_calls|tool_result|tool_use)\b|<[｜|][^>｜|]*[｜|]>|\bto=functions?\.\w+/i
/** 裸 JSON 调用参数。 */
const TOOL_JSON = /"(?:name|tool)"\s*:\s*"[A-Za-z_][\w.-]*"[\s\S]*?"(?:arguments|parameters|input|args)"\s*:/
/** markdown 排版：标题 / 列表 / 引用 / 加粗 / 链接 / 代码。真人聊天不打这个。 */
const MD_MARKUP = /^\s*(?:#{1,6}\s|[-*+]\s|>\s|\d+\.\s)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`{1,3}/
/** AI 自述：这种句子不是真人在接话。 */
const ROBOT_PHRASE = /作为\s*(?:AI|人工智能|助手|语言模型)|我是\s*(?:AI|助手|人工智能|语言模型)/i
/** 至少得有一个汉字 / 字母 / 数字，纯标点表情不算发言。 */
const HAS_WORD = /[\u4e00-\u9fa5A-Za-z0-9]/

/** 开头动作（问 / 怼 / 顺着接）→ hint 里的说法。 */
const OPENER_WORD = { 问: '问一句', 怼: '怼一句', 顺着接: '顺着接话' }
/** 开头动作的固定优先序：票数相同时按这个顺序定，保证同样输入给同样结果。 */
const OPENER_ORDER = ['问', '怼', '顺着接']

/** 怼：开头那几个字就在反驳 / 起哄。只看前 12 个字 —— 位置在句首才叫「开头动作」。 */
const REFUTE = /才不是|你才|谁说|谁要|哪有|哪儿有|别闹|别扯|离谱|难绷|绷不住|服了|笑死|就这|真的假的|哼|^6/
/** 问：句尾问号或疑问词。 */
const ASK = /[？?]|吗|呢|啥|什么|怎么|为什么|哪|多少|是不是|要不要|能不能|行不行/

/** 收掉控制字符、零宽字符，空白压成一个空格。 */
function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** at 统一成 ISO 字符串；给的是时间戳 / Date 也认；认不出来就原样留着（来源就是来源）。 */
function isoOf(at, now = Date.now()) {
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? new Date(now).toISOString() : at.toISOString()
  if (typeof at === 'number' && Number.isFinite(at)) return new Date(at).toISOString()
  const raw = String(at == null ? '' : at).trim()
  if (!raw) return new Date(now).toISOString()
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw
}

/** 时间戳（毫秒）；解析不出来给 NaN，调用方自己判。 */
function msOf(value) {
  const ms = Date.parse(String(value == null ? '' : value))
  return Number.isFinite(ms) ? ms : NaN
}

/** 读 JSONL：坏行跳过，不算数据。 */
function readRows(file) {
  if (!file || !existsSync(file)) return []
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return []
  }
  const rows = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && typeof row.text === 'string') rows.push(row)
    } catch {}
  }
  return rows
}

/** 原子重写整个文件：先写临时文件，再 rename 覆盖。写坏了只会坏掉临时文件。 */
function writeAtomicLines(file, lines) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf8')
  renameSync(tmp, file)
}

/** 追加一行（JSONL 只追加，不改已有行）。 */
function appendRow(file, row) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', flag: 'a' })
}

/** 行数天花板：超了就只留最近 KEEP_LINES 行。返回是否真的裁了。 */
function trimIfNeeded(file, rows) {
  if (rows.length <= MAX_LINES) return false
  const kept = rows.slice(-KEEP_LINES)
  writeAtomicLines(file, kept.map((row) => JSON.stringify(row)))
  return true
}

/** 只由 URL 组成的文本（末尾的标点不算内容）。 */
function isOnlyUrl(text) {
  return URL_ONLY.test(text.replace(/[。，、！？…~～]+$/g, ''))
}

/** 像工具调用 / markdown 的都不收：那不是人话。 */
function looksLikeToolOrMarkdown(text) {
  if (TOOL_MARKUP.test(text)) return true
  if (TOOL_JSON.test(text)) return true
  return MD_MARKUP.test(text)
}

/** 入库前的判断：返回跳过理由，空串表示可以收。 */
function skipReasonOf(text) {
  if (!text) return '空文本'
  if (text.length > MAX_TEXT_LEN) return '太长'
  if (isOnlyUrl(text)) return '纯链接'
  if (looksLikeToolOrMarkdown(text)) return '像工具调用或 markdown'
  if (ROBOT_PHRASE.test(text)) return '像 AI 自述'
  if (!HAS_WORD.test(text)) return '没有文字'
  return ''
}

/** 中文/通用 2-gram 集合：相似度只看「字的搭配」，不看分词。 */
function bigrams(text) {
  const s = normalizeText(text).replace(/[\s\p{P}\p{S}]/gu, '')
  const grams = new Set()
  if (s.length <= 1) {
    if (s) grams.add(s)
    return grams
  }
  for (let i = 0; i + 1 < s.length; i += 1) grams.add(s.slice(i, i + 2))
  return grams
}

/** Jaccard：交集 / 并集。两边都空算 0。 */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const gram of a) if (b.has(gram)) hit += 1
  const union = a.size + b.size - hit
  return union > 0 ? hit / union : 0
}

/** 开头动作：先看句首有没有在怼，再看有没有在问，都不是就是顺着接。 */
function openerOf(text) {
  const head = String(text == null ? '' : text).slice(0, 12)
  if (REFUTE.test(head)) return '怼'
  if (ASK.test(text == null ? '' : text)) return '问'
  return '顺着接'
}

/** 长度：优先用入库时算好的 len，没有再数文本。 */
function lenOf(row) {
  const n = Number(row?.len)
  if (Number.isFinite(n) && n > 0) return n
  return String(row?.text == null ? '' : row.text).length
}

/** 中位数（偶数取中间两个的平均，四舍五入）。 */
function medianOf(values) {
  const list = (Array.isArray(values) ? values : []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!list.length) return 0
  const mid = Math.floor(list.length / 2)
  const value = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2
  return Math.round(value)
}

/** 长度档：只报档位，不报原句。 */
function lenPhrase(len) {
  if (len <= SHORT_MAX) return `${SHORT_MAX} 个字以内`
  if (len <= MID_MAX) return `7 到 ${MID_MAX} 个字`
  return '十几个字'
}

/** 多数票；票数相同按 OPENER_ORDER 定，保证稳定。 */
function pickMajority(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  let best = OPENER_ORDER[0]
  let bestCount = -1
  for (const key of OPENER_ORDER) {
    const count = counts.get(key) || 0
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

/**
 * 收一条真人发言。
 *
 * @returns {{ok: true, at: string, len: number, trimmed?: boolean} | {ok: false, skipped: string}}
 *   ok:false 时 skipped 是跳过理由（空文本 / 太长 / 纯链接 / 像工具调用或 markdown /
 *   像 AI 自述 / 没有文字 / 重复 / 已收过）。
 */
export function rememberHumanLine({ file, text, chatKey = '', who = '', qqId = '', at = '', now = Date.now() } = {}) {
  if (!file) return { ok: false, skipped: '没有文件路径' }
  const clean = normalizeText(text)
  const skipped = skipReasonOf(clean)
  if (skipped) return { ok: false, skipped }

  const rows = readRows(file)
  const when = isoOf(at, now)
  const chat = String(chatKey == null ? '' : chatKey)
  const person = String(who == null ? '' : who)

  // ① 同一个人 5 分钟内又说了同一句：重发 / 回声，不重复记（跨群也算）。
  const whenMs = msOf(when)
  const recent = rows.find((row) => {
    if (String(row.who == null ? '' : row.who) !== person) return false
    if (String(row.text || '') !== clean) return false
    const rowMs = msOf(row.at)
    if (!Number.isFinite(rowMs) || !Number.isFinite(whenMs)) return false
    return Math.abs(whenMs - rowMs) <= DUP_WINDOW_MS
  })
  if (recent) return { ok: false, skipped: '重复' }

  // ② 幂等：同一个 (群, 人, 原话) 已经在库里了，不管多久以前。
  if (rows.some((row) => String(row.chatKey || '') === chat
    && String(row.who == null ? '' : row.who) === person
    && String(row.text || '') === clean)) {
    return { ok: false, skipped: '已收过' }
  }

  const row = {
    text: clean,
    chatKey: chat,
    who: person,
    qqId: String(qqId == null ? '' : qqId),
    at: when,
    len: clean.length,
  }
  appendRow(file, row)
  const trimmed = trimIfNeeded(file, [...rows, row])
  const result = { ok: true, at: row.at, len: row.len }
  if (trimmed) result.trimmed = true
  return result
}

/**
 * 开口前问一句「以前这种话真人是怎么接的」。
 *
 * **只回接法，不回原句**：hint 是固定句式 + 开头动作 + 长度档拼出来的，
 * sample 里只有 chatKey / at / len，stats 里只有 n / opener / medianLen。
 * 返回值里一个原始句子都不许出现 —— 借了用词就不是「借接法」了。
 *
 * @returns {{ok: true, hint: string, stats: {n: number, opener: string, medianLen: number},
 *            sample: Array<{chatKey: string, at: string, len: number}>}
 *          | {ok: false, reason: string, hint: string, stats: {...}, sample: [...]}}
 */
export function recallShape({ file, text, limit = 3, threshold = JACCARD_THRESHOLD } = {}) {
  const clean = normalizeText(text)
  const emptyStats = { n: 0, opener: '', medianLen: 0 }
  const miss = (reason, stats = emptyStats, sample = []) => ({ ok: false, reason, hint: '', stats, sample })
  if (!file || !clean) return miss('没有可比的话')

  const want = bigrams(clean)
  if (!want.size) return miss('没有可比的话')

  const rows = readRows(file)
  const scored = []
  for (const row of rows) {
    const sim = jaccard(want, bigrams(row.text))
    if (sim >= threshold) scored.push({ row, sim })
  }
  scored.sort((a, b) => b.sim - a.sim)

  const sampleOf = (row) => ({
    chatKey: String(row.chatKey == null ? '' : row.chatKey),
    at: String(row.at == null ? '' : row.at),
    len: lenOf(row),
  })

  // 样本不够就正常说：不硬套一个「接法」出来。
  if (scored.length < MIN_HITS) {
    const near = scored.slice(0, Math.max(1, Math.min(Number(limit) || 3, 20))).map((hit) => sampleOf(hit.row))
    return miss('样本不够', { n: scored.length, opener: '', medianLen: 0 }, near)
  }

  const hits = scored.slice(0, Math.max(1, Math.min(Number(limit) || 3, 20)))
  const opener = pickMajority(hits.map((hit) => openerOf(hit.row.text)))
  const medianLen = medianOf(hits.map((hit) => lenOf(hit.row)))
  const hint = `以前这种话真人多是先${OPENER_WORD[opener]}；常用 ${lenPhrase(medianLen)}`

  return {
    ok: true,
    hint,
    stats: { n: hits.length, opener, medianLen },
    sample: hits.map((hit) => sampleOf(hit.row)),
  }
}

/** 总账：面板 / 体检用。只数条目和来源，不吐正文。 */
export function statsOf(file) {
  const rows = readRows(file)
  const byChat = {}
  let lastAt = null
  for (const row of rows) {
    const key = String(row.chatKey == null ? '' : row.chatKey) || '未知'
    byChat[key] = (byChat[key] || 0) + 1
    const at = String(row.at == null ? '' : row.at)
    if (at && (!lastAt || at > lastAt)) lastAt = at
  }
  return { total: rows.length, byChat, lastAt }
}

/** 单测用的内部件（生产代码别依赖）。 */
export const __test = {
  bigrams,
  jaccard,
  openerOf,
  lenPhrase,
  medianOf,
  skipReasonOf,
  MAX_TEXT_LEN,
  MAX_LINES,
  KEEP_LINES,
  JACCARD_THRESHOLD,
  MIN_HITS,
}

// 留一个空目录清理口：裁剪失败时临时文件可能残留，体检可以扫一下。
export function leftoverTempFiles(file) {
  try {
    const dir = dirname(file)
    const base = file.split(/[\\/]/).pop()
    return readdirSync(dir).filter((name) => name.startsWith(base + '.tmp-'))
  } catch {
    return []
  }
}
