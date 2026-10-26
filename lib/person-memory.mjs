// 群友的本地记忆：一个 QQ 号一份，只记「跟她真的说过话」的那些片段。
//
// 为什么按 QQ 号而不是按会话：同一个群友会在好几个群里出现，按会话分会把同一个人
// 拆成好几份互不相认的记忆。这里以人为单位，群只是相遇的地点。
//
// 三条边界（主人 2026-10-26 定的）：
//  · 不能「一进来就记」：不扫历史、不在第一次见面时写任何东西；
//  · 只记跟她聊过的部分：她只是旁听的那些话不进记忆；
//  · 记忆是给她看的线索，不是聊天记录备份：每人只留最近几十段，正文截断。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PERSON_MEMORY_FOLDER = '群友'
const MAX_EXCHANGES = 40
const MAX_SIDE_CHARS = 160

function cleanQq(value) {
  return String(value == null ? '' : value).replace(/\D/g, '')
}

export function personMemoryDir(worldRoot) {
  return join(String(worldRoot || ''), '鱼的记忆', PERSON_MEMORY_FOLDER)
}

export function personMemoryPath(worldRoot, qq) {
  const id = cleanQq(qq)
  if (!id) return ''
  return join(personMemoryDir(worldRoot), id + '.json')
}

function clip(text) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > MAX_SIDE_CHARS ? value.slice(0, MAX_SIDE_CHARS) + '…' : value
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
  const file = personMemoryPath(root, id)
  try {
    mkdirSync(personMemoryDir(root), { recursive: true })
    const prev = readPersonMemory(root, id) || { qq: id, exchanges: [] }
    const exchanges = Array.isArray(prev.exchanges) ? prev.exchanges : []
    exchanges.push({ at: Number(at) || Date.now(), chatKey: String(chatKey || ''), he: said, she: reply })
    const record = {
      qq: id,
      nickname: String(nickname || prev.nickname || '').slice(0, 40),
      updatedAt: Number(at) || Date.now(),
      exchanges: exchanges.slice(-MAX_EXCHANGES),
    }
    writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
    return { ok: true, record }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 跟她说话时用得上的那几行：最近几段，带时间（只到分钟）。 */
export function personBrief(worldRoot, qq, limit = 2) {
  const record = readPersonMemory(worldRoot, qq)
  if (!record || !Array.isArray(record.exchanges) || !record.exchanges.length) return ''
  const rows = record.exchanges.slice(-Math.max(1, Math.min(Number(limit) || 2, 6)))
  return rows.map((item) => {
    const when = formatDay(item.at)
    return `${when} 他说「${item.he}」，你回「${item.she}」`
  }).join('；')
}

function formatDay(ms) {
  const n = Number(ms)
  if (!n) return ''
  const d = new Date(n)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
