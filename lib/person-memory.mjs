// 群友记忆：一个 QQ 号一份，记的是「鱼对 TA 的印象」+ 最近的来回。
//
// 为什么按 QQ 号而不是按会话：同一个群友会在好几个群里出现，按会话分会把同一个人
// 拆成好几份互不相认的记忆。这里以人为单位，群只是相遇的地点。
//
// 三条边界（主人 2026-10-26 定的）：
//  · 不能「一进来就记」：不扫历史、不在第一次见面时写任何东西；
//  · 只记跟她聊过的部分：她只是旁听的那些话不进记忆；
//  · 记忆主体是**每隔一段时间的印象总结**，不是聊天记录备份：跟同一个人聊满
//    100 个来回才更新一次印象，中间只留最近几条来回当素材。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PERSON_MEMORY_FOLDER = '群友'
// 聊满多少个来回更新一次印象。
export const SUMMARY_EVERY = 100
// 留多少条最近的来回当素材（写印象时用，也能在简报里带一句）。
const MAX_EXCHANGES = 40
const MAX_SIDE_CHARS = 160
const MAX_SUMMARY_CHARS = 400

function cleanQq(value) {
  return String(value == null ? '' : value).replace(/\D/g, '')
}

function personMemoryDir(worldRoot) {
  return join(String(worldRoot || ''), '鱼的记忆', PERSON_MEMORY_FOLDER)
}

export function personMemoryPath(worldRoot, qq) {
  const id = cleanQq(qq)
  if (!id) return ''
  return join(personMemoryDir(worldRoot), id + '.json')
}

function clip(text, max = MAX_SIDE_CHARS) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}

/** 读某人的记忆；没记过就返回 null（不是空对象——「没这个人」和「记了但空」要能分开）。 */
export function readPersonMemory(worldRoot, qq) {
  const file = personMemoryPath(worldRoot, qq)
  if (!file || !existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

function save(worldRoot, id, record) {
  mkdirSync(personMemoryDir(worldRoot), { recursive: true })
  writeFileSync(personMemoryPath(worldRoot, id), JSON.stringify(record, null, 2), 'utf8')
  return record
}

/**
 * 记下一段「他跟她说的话 ↔ 她的回话」。
 *
 * 只有真的来回过才写：她没回的那段不算「跟自己聊天」，不该进记忆。
 * 返回 { ok, record } 或 { ok:false, error }，调用方按需记日志，不抛。
 */
export function noteExchange(worldRoot, { qq, nickname, heSaid, sheSaid, at, chatKey } = {}) {
  const id = cleanQq(qq)
  const said = clip(heSaid)
  const reply = clip(sheSaid)
  if (!id || !said || !reply) return { ok: false, error: '缺 qq / 他说的话 / 她的回话' }
  const root = String(worldRoot || '')
  if (!root) return { ok: false, error: '工作区还没绑定' }
  try {
    const prev = readPersonMemory(root, id) || { qq: id, total: 0, sinceSummary: 0, exchanges: [] }
    const exchanges = (Array.isArray(prev.exchanges) ? prev.exchanges : []).concat([{
      at: Number(at) || Date.now(),
      chatKey: String(chatKey || ''),
      he: said,
      she: reply,
    }])
    const record = {
      ...prev,
      qq: id,
      nickname: String(nickname || prev.nickname || '').slice(0, 40),
      total: (Number(prev.total) || 0) + 1,
      sinceSummary: (Number(prev.sinceSummary) || 0) + 1,
      updatedAt: Number(at) || Date.now(),
      exchanges: exchanges.slice(-MAX_EXCHANGES),
    }
    save(root, id, record)
    return { ok: true, record }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 该更新印象了吗：聊满 SUMMARY_EVERY 个来回，且这次更新之后没更新过。 */
export function needsSummary(worldRoot, qq) {
  const record = readPersonMemory(worldRoot, qq)
  if (!record) return false
  return (Number(record.sinceSummary) || 0) >= SUMMARY_EVERY
}

/**
 * 把她写下的印象存起来，计数归零。空内容不覆盖旧印象。
 *
 * opts.addToWardrobe：群聊里写下的印象顺手也进「衣柜」（dsh-fish-memory 的会话库）——
 * 那是她跟主人聊天时真正会被想起来的那一份。不进来的话就是两条互不相认的鱼：
 * 群友那边记得这个人，跟主人聊的时候一点都想不起来。
 * 默认关，由接线方显式打开；双写失败只记在返回值里，不影响群友记忆本身。
 */
export function saveSummary(worldRoot, qq, text, opts = {}) {
  const id = cleanQq(qq)
  const root = String(worldRoot || '')
  const value = clip(text, MAX_SUMMARY_CHARS)
  if (!id || !root || !value) return { ok: false, error: '缺 qq / 印象内容' }
  try {
    const prev = readPersonMemory(root, id)
    if (!prev) return { ok: false, error: '没有这个人的记录' }
    const record = {
      ...prev,
      sinceSummary: 0,
      updatedAt: Date.now(),
      summary: { text: value, at: Date.now(), total: Number(prev.total) || 0 },
    }
    save(root, id, record)
    let shared = null
    if (typeof opts.addToWardrobe === 'function') {
      try {
        const nickname = String(prev.nickname || '').trim()
        shared = opts.addToWardrobe({
          text: `我对 ${nickname || id} 的印象：${value}`,
          tags: ['群友', '印象'].concat(nickname ? [nickname] : []),
          // 同一个人的印象只有一个键：再写就取代旧的，衣柜里永远只有最新那份。
          事实键: `群友.${id}.印象`,
        })
      } catch (error) {
        shared = { ok: false, error: String((error && error.message) || error) }
      }
    }
    return { ok: true, record, shared }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 写印象用的素材：最近这些来回，一行一条。 */
export function summaryMaterial(worldRoot, qq, limit = 20) {
  const record = readPersonMemory(worldRoot, qq)
  if (!record || !Array.isArray(record.exchanges) || !record.exchanges.length) return ''
  return record.exchanges
    .slice(-Math.max(1, Math.min(Number(limit) || 20, MAX_EXCHANGES)))
    .map((item) => `他说「${item.he}」，你回「${item.she}」`)
    .join('\n')
}

/** 跟她说话时用得上的那几行：先给印象，再给最近一段。 */
export function personBrief(worldRoot, qq, limit = 1) {
  const record = readPersonMemory(worldRoot, qq)
  if (!record) return ''
  const rows = []
  if (record.summary && record.summary.text) rows.push(`你对 TA 的印象：${record.summary.text}`)
  const exchanges = Array.isArray(record.exchanges) ? record.exchanges : []
  if (exchanges.length) {
    const when = formatDay(exchanges[exchanges.length - 1].at)
    const last = exchanges[exchanges.length - 1]
    rows.push(`${when} TA 说「${last.he}」，你回「${last.she}」`)
  }
  return rows.join('；')
}

function formatDay(ms) {
  const n = Number(ms)
  if (!n) return ''
  const d = new Date(n)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
