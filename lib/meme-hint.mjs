// 梗百科提示：QQ 自动回复路径上的「要不要查梗」判断 + 只注入命中那一条。
//
// 背景（主人 2026-11-18 查实）：
//   dsh-memewiki 的预查注入走 ctx.systemPrompt.context，只对 DSH 主会话生效；
//   鱼的 QQ 自动回复走 lib/qq-inbox.mjs，那条路以前一条引用都没有 —— 真是断的。
//
// 本模块做三件事：
//   1. 复用 memewiki 的「提取查询」口径（问梗模式 / 裸词模式），**并扩展留白接龙**
//      （句尾「……」「～」「就像是」这类未完成结构，也算在问/在等你接）；
//   2. 查到就只回命中的**一条**（禁用的不吐正文，交给 meme-gate）；
//   3. 查不到就明说，让模型别硬编。
//
// 只注入一条、不注整本：整本会把语气带成词典腔。
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultBlockedFile, findDb, lookup as gateLookup } from './meme-gate.mjs'

// ---------- 提取查询（口径对齐 dsh-memewiki v0.1.20 lib/index.js L652-707） ----------

const 问梗模式 = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|啊这是)?[？?。！!~～]*$/
const 裸词模式 = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/
const 无语义词 = new Set(['这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面'])
const 停用词 = new Set(['在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安', '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐'])
const 句子成分 = /怎么样|怎么|多少|为什么|能不能|是不是|什么|了吗|了没|一下|你说|要不要|有没有/
const 唤醒词 = ['小鲸鱼', '大鲸鱼', '大肥鲸', '小肥鲸', '大肥鱼', '奶鱼', '鲸鱼', 'deepseek', 'ds']

/** 句尾留白：话没说完、在等你接（这类以前永远触发不了查梗）。 */
const 留白尾巴 = /(……+|\.{3,}|～+|~+|就像是|就像|好比|比如|算是一种|大概是)\s*$/

function 清文本(text) {
  let t = String(text || '').trim()
  t = t.replace(/^(@\S+\s*)+/, '')
  for (const w of 唤醒词) {
    if (t.toLowerCase().startsWith(w)) {
      t = t.slice(w.length).trim().replace(/^[，,。.！!？?:：]+|[，,。.！!？?:：]+$/g, '')
      break
    }
  }
  return t.trim()
}

/** 留白接龙：把尾巴剥掉，取前面那段当候选（2–12 字）。 */
function 留白候选(text) {
  const t = String(text || '').trim()
  if (!留白尾巴.test(t)) return ''
  const head = t.replace(留白尾巴, '').replace(/[，,。.！!？?：:；;]+$/g, '').trim()
  if (!head) return ''
  // 取最后一个分句（「窗外的雨滴，就像是」→ 窗外的雨滴）
  const last = head.split(/[，,。！!？?；;\n]/).filter(Boolean).pop() || ''
  const cand = last.trim()
  return cand.length >= 2 && cand.length <= 12 ? cand : ''
}

/** 从一句话里提取候选词条；不是问梗/留白就返回 null。 */
export function extractQuery(text) {
  const t = 清文本(text)
  if (!t) return null
  const m = 问梗模式.exec(t)
  if (m) {
    let head = t.slice(0, m.index).replace(/^[ ，,。.！!？?]+|[ ，,。.！!？?]+$/g, '')
    head = head.replace(/^[是]+|[是]+$/g, '').trim()
    head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个)$/, '').trim()
    head = head.replace(/(到底|究竟)$/, '').trim()
    if (无语义词.has(head)) return null
    if (head.length <= 2 && '这那它他她'.includes(head[0])) return null
    if (head.length > 1 && head.length <= 12) return { query: head, mode: 'ask' }
    return null
  }
  // 裸词：只认「像一个梗的词」，句子味道的一律不算（QQ 路径每句都过，必须更严）。
  if (裸词模式.test(t) && !停用词.has(t)) {
    if (句子成分.test(t)) return null
    if (/[吗呢吧啊呀哦嘛么？?！!]$/.test(t)) return null
    return { query: t, mode: 'word' }
  }
  const blank = 留白候选(t)
  if (blank) return { query: blank, mode: 'blank' }
  return null
}

// ---------- 查一条 + 拼成一行提示 ----------

function 一句(text, limit = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

function appendLog(logFile, message) {
  try { appendFileSync(logFile, `[${new Date().toISOString()}] [fish-world] ${message}\n`) } catch {}
}

/**
 * 给这一轮消息算一条梗百科提示。
 * 返回 { triggered, query, mode, found, line }
 * line 为空串 = 不用往上下文里加任何东西。
 */
export async function memeHintFor({ text, home = '', worldRoot = '', logFile = '' } = {}) {
  const got = extractQuery(text)
  if (!got) return { triggered: false, query: '', mode: '', found: false, line: '' }

  const dbPath = findDb({ home })
  const blockedFile = defaultBlockedFile(worldRoot)
  const log = logFile || (home ? join(home, 'memewiki.log') : '')

  let hit = null
  try {
    const out = await gateLookup({ dbPath, blockedFile, query: got.query, limit: 3 })
    if (out.ok) hit = (out.items || []).find((item) => !item.blocked) || null
  } catch { /* 查不动就当没查到，不假装 */ }

  if (hit) {
    if (log) appendLog(log, `qq-inbox 查梗命中「${hit.title}」（query=${got.query} mode=${got.mode}）`)
    const line = `〔梗百科：「${hit.title}」${hit.summary ? '——' + 一句(hit.summary) : ''}（用自己一句话说，别念定义）〕`
    return { triggered: true, query: got.query, mode: got.mode, found: true, line, title: hit.title }
  }
  if (log) appendLog(log, `qq-inbox 查梗未命中（query=${got.query} mode=${got.mode}）`)
  // 只有「明确在问梗 / 留白等你接」才往上下文里说「没收录」；裸词查不到就静默，
  // 否则每句四个字的闲聊都挂一行提示，prompt 会被噪声塞满。
  const line = got.mode === 'word'
    ? ''
    : '〔这条词库没收录：别硬编，短接一句（「这什么梗」「学到了」都行）〕'
  return { triggered: true, query: got.query, mode: got.mode, found: false, line }
}