// 小工具集合：不依赖任何 DSH 内部模块，方便单测。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 读 JSON；文件不存在 / 解析失败都返回 fallback（并可选把错误交给 onError）。 */
export function readJson(file, fallback = null, onError) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code !== 'ENOENT' && typeof onError === 'function') {
      try { onError(error) } catch {}
    }
    return fallback
  }
}

/** 原子写 JSON（先写 .tmp 再 rename），避免半份文件。 */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
  return true
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 取宿主的一个服务，取不到就当没有（返回 null）。
 *
 * 宿主的 ctx 是个带闸门的代理：没 inject 过的服务，**直接读属性就会抛**
 * `cannot get property "attachments" without inject`。2026-10-28 群 681145756
 * 的投递就是这么整条失败的（图还没处理，异常先把 followup 之前整段打断了）。
 * 想读哪个服务一律走这里：先 get()，再退回属性，两条路都兜住异常。
 */
export function serviceOf(ctx, name) {
  const key = String(name || '')
  if (!ctx || !key) return null
  try {
    if (typeof ctx.get === 'function') {
      const found = ctx.get(key)
      if (found) return found
    }
  } catch {}
  try {
    return ctx[key] || null
  } catch {
    return null
  }
}

export function fileMtime(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

export function fileExists(file) {
  try { return existsSync(file) } catch { return false }
}

/** 把消息 content（字符串 / 块数组）压成纯文本。 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => {
      if (!block || typeof block !== 'object') return false
      // 思维链 / 分析块不是她说的话：宁可少拼一段，也不能把内部盘算当正文发出去。
      const type = String(block.type || '')
      return !/reason|think|analysis|scratch/i.test(type)
    })
    .map((block) => {
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      return ''
    })
    .join('')
}

// 有些轮次模型会把「内部盘算」当正文吐出来：英文的 The user is … / Reply short …
// 这些不是她说的话，也不是群里该看见的东西。
//
// 两种粒度：
//  · BLOCK：整段都是盘算或复读的上下文（英文长句、`user[QQ 群 …]`、〔…〕标注）⇒ 整块丢。
//  · LINE：中文的判断句（「这条和上一条重复了」「回完就停」）常常和真回话挤在同一段里
//    （只隔一个换行）⇒ 只删那一行。以前整段丢，会把同一段里的真回话一起带走。
const BLOCK_PATTERNS = [
  /^\s*The user (is|said|asked)\b/im,
  /^\s*Group chat, one person to reply/im,
  /\bNeed to respond (as|to)\b/i,
  /\bReply (short|in persona|as the character)\b/i,
  /\bI'm the fish in the group\b/i,
  /\(each message = separate bubble/i,
  /\bDon'?t respond to others\b/i,
  /\bHis line:\s*["“]/i,
  // 复读投递文本（主人 2026-10-26 贴的群记录）：她把整段上下文当正文发了出来 ——
  // 「user[QQ 群 …] 某某：…」、〔此刻群里的现场…〕、〔群聊：优先聊天…〕。
  // 这些是我们投递时加的标注，一个字都不该出现在 QQ 里。
  /^\s*user\s*\[/i,
  /^\s*\[QQ\s*(群|私聊)/,
  /^\s*〔/,
]

// 中文的内部盘算（2026-10-27 记录：「我可以接一句，别绕回人设」「这轮只重复了…回完就停」
// 「这条和上一条重复了」）。这些是她在判断要不要回，不是她要说的那句。
const LINE_PATTERNS = [
  /这轮(?:不说话|不接|先不|只|就|算了)/,
  /回完就停/,
  /已经回过/,
  /不用再接/,
  /(?:和|跟)?上一[条句]重复/,
  /重复的(?:话)?就不(?:接|回)/,
  /这条(?:就|先)?(?:不|别)接/,
  /没有新内容/,
  /别绕回/,
  /又绕回/,
  /可以[^。]{0,6}接一句/,
  /跳过(?:这|那)?(?:条|句)/,
  /先不(?:接|回)(?:了|这)/,
  // 主人 2026-10-27 贴的群记录：这句单独成行时（被空行拆成块），
  // 「大星只是重复了」这半句不命中「已经回过」，会漏出半句盘算。
  // 必须紧跟引号内容才算：她真在复述别人的话时（「你刚才只是重复了一个字」）不删。
  /只是重复了[^。]{0,40}[「『]/,
  // 2026-10-28 群 681145756：换了 magpie/group/deepseel 之后，她把「先自嘲一下、短」
  // 这种边想边改的旁白也当正文发了出去（候选回话还带着引号）。
  /让我(?:就着|先|再|来)/,
  /还没发出去/,
  /^接一句[：:]/,
  /自嘲[。，]?\s*(?:短|换|$)/,
  /重复[。，]\s*换/,
  /第二个和之前/,
  /变成群里的梗/,
  // 整行只有一个引号包的候选句 = 草稿，不是她真在说话（上面的「换。 "1都成接头暗号了"」
  // 就是这么漏出去的）。她真要复述别人的话，句子里还会有别的字。
  /^\s*["“][^"”]{1,60}["”]\s*$/,
  // 2026-10-28 群 681145756 又一种漏法：她在数条数、挑第几条、说「保留第二条即可」，
  // 还夹着英文的 hmm。真实回话往往挤在同一行的尾巴上 —— 这一行要么整行丢，
  // 要么在 stripLeakedPlanner 里按句切开只留干净那段。
  /第[一二三四]条/,
  /^两条[：:]/,
  /一条就行/,
  /(?:发|留)[一二两]条/,
  /保留[^。]{0,6}即可/,
  /认一下/,
  /\bhmm\b/i,
  // 2026-10-28 群 681145756：她把「印象：咕咕的大肥魚认命认得利索…」这种写进记忆的
  // 东西当聊天发了出来。群聊里只许出现人话 —— 印象 / 记忆 / 备注这类带标签的段落一律不发。
  /^\s*(?:印象|记忆|备注|群友记忆)[：:]/,
  /工具(?:调用|结果)/,
]

// 引号里包着的是「候选回话」——她自言自语时才会这么写。
const QUOTED = /["“「『][^"”」』]{1,60}["”」』]/g
// 同一个形状的单次判断版：带 g 的正则调 .test 会留下 lastIndex，下一行就会被误判。
const HAS_QUOTED = /["“「『][^"”」』]{1,60}["”」』]/

// 旁白词：出现它们在猜「怎么回」而不是在回。
const META_WORDS = /接一句|回一句|说一句|换[。，]|重复|自嘲|让我|还没发出去|误发|群里的梗|判断|改成|好听点|短一点/

/** 一整行只剩几个引号包起来的句子（外加 / 、 这种分隔符）⇒ 这是候选草稿清单。 */
function isDraftOnlyLine(line) {
  const quoted = String(line).match(QUOTED)
  if (!quoted) return false
  const rest = String(line).replace(QUOTED, '')
  return /^[\s/／|、，。.·\-—_+()（）]*$/.test(rest)
}

/** 一行里既有引号候选句、又有旁白词 ⇒ 她在盘算怎么说，不是已经说的话。 */
function isMetaLine(line) {
  return HAS_QUOTED.test(String(line)) && META_WORDS.test(String(line))
}

/**
 * 一行里既有旁白、尾巴上又挤着真回话（「两条： 保留第二条即可… 颜面尽失 那我刚夸的那句收回」）。
 *
 * 只在整行带着「数条数 / 挑第几条 / 保留第几条 / hmm」这类特征时才走这条路：
 * 按句号和冒号切开逐段判断，旁白段丢掉、干净段留下；全丢就返回空串（这行当没说）。
 * 老的那些漏法（接一句、自嘲、换、让我…）仍然是整行丢 —— 那些行里没有可信的尾巴。
 */
const DRAFT_COUNTING = /第[一二三四]条|^两条[：:]|[一二两]条[。：:]|保留[^。]{0,6}即可|认一下|\bhmm\b/i

function salvageLine(line) {
  const raw = String(line)
  if (!DRAFT_COUNTING.test(raw)) {
    return LINE_PATTERNS.some((re) => re.test(raw)) || isMetaLine(raw) || isDraftOnlyLine(raw) ? '' : raw
  }
  const parts = raw.split(/[。．：:]/).map((s) => s.trim()).filter(Boolean)
  const kept = parts.filter((seg) => {
    if (LINE_PATTERNS.some((re) => re.test(seg))) return false
    if (isDraftOnlyLine(seg) || isMetaLine(seg)) return false
    return true
  })
  // 切开以后可能只剩一个括号之类的渣：那不是话，别发。
  const text = kept.join(' ').replace(/^[）)】\]]+|[（(【\[]+$/g, '').trim()
  return /[\u4e00-\u9fa5A-Za-z0-9]/.test(text) ? text : ''
}

/** 去掉漏出来的内部盘算；全被丢光就返回空串（这一轮当作没说话）。 */
export function stripLeakedPlanner(text) {
  const value = String(text == null ? '' : text)
  if (!value.trim()) return ''
  const kept = value
    .split(/\n{2,}/)
    .filter((block) => !BLOCK_PATTERNS.some((re) => re.test(block)))
    .map((block) => block
      .split('\n')
      .map((line) => (line.trim() ? salvageLine(line) : ''))
      .filter((line) => line.trim())
      .join('\n'))
    .filter((block) => block.trim())
  return stripBannedPhrases(kept.join('\n\n').trim())
}

/**
 * 主人明确拉黑的三句（2026-10-27）：「这条我记下了」「这条我认」「本鱼最喜欢的一句话」。
 * 提示词里已经写了别用，这里再拦一道：只删包含它的那一行，别把整段真话一起扔了。
 */
export const BANNED_PHRASES = ['这条我记下了', '这条我认', '本鱼最喜欢的一句话']

export function stripBannedPhrases(text) {
  const value = String(text == null ? '' : text)
  if (!value.trim()) return ''
  const kept = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !BANNED_PHRASES.some((phrase) => line.includes(phrase)))
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 一轮说的话拆成几个气泡：**每一个换行都算一条**。
 *
 * 原来只认空行，理由是「单换行可能是一句长话的折行」。但实测模型不用空行分段，
 * 它写两条消息时就是一个换行（主人 2026-10-26：「存不了 图在桥的临时目录 /
 * 你丢进 大肥鱼 目录 我再收」又被合成了一条，说这完全是 BUG）。
 * 折行和分条在聊天里本来就分不开，宁可多一条也不要把两句压成一个气泡。
 *
 * 另外人设卡的示例里用「／」当分隔符（「不许说胖！… ／ ？你再说一遍试试」），
 * 所以单独一个全角 ／、或者两侧带空格的半角 /，也当分条 —— 规则和提示词对齐，
 * 不然她按示例写、代码却当成一句话。半角斜杠只在两侧有空格时才拆，免得切坏 5/10 这种。
 */
export function splitBubbles(text) {
  const value = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  const parts = value
    .split(/\n+|／+|\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  return capBubbles(parts, MAX_BUBBLES)
}

/** 一轮最多发几条：超出的不丢，并进第 5 条，宁可长一条也不刷屏。 */
export const MAX_BUBBLES = 5

export function capBubbles(parts, limit = MAX_BUBBLES) {
  const list = Array.isArray(parts) ? parts.filter(Boolean) : []
  if (list.length <= limit) return list
  const kept = list.slice(0, Math.max(1, limit - 1))
  kept.push(list.slice(Math.max(1, limit - 1)).join(' '))
  return kept
}

/** 从 content 里挑出图片块（保留原始块，调用方自己决定怎么处理）。 */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block && block.type === 'image')
}

export function oneLine(value, max = 160) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 工具名 / 扩展 id 只留安全字符。 */
export function sanitizeId(value, fallback = 'x') {
  const text = String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '')
  return text || fallback
}

/** 截断但不切出半个代理对。 */
export function sliceSafe(text, max) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  let end = max
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return s.slice(0, end)
}

/**
 * 浅合并：只覆盖对象里显式给出的键；数组整体替换。
 * 用于设置补丁，避免把默认值里的嵌套对象丢掉。
 */
export function mergePatch(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergePatch(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}
