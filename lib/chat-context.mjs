// 每个 QQ 会话的短上下文：群聊/好友私聊走 API 时，只带最近几条。
//
// 为什么单独存：这些会话不再进 DSH，历史不能靠 DSH 的会话；但又不能无限长
// （群聊很快就能刷到几十万 token）。这里按会话存一个小数组，条数和总字符都有上限。
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from './util.mjs'

function safeKey(chatKey) {
  const raw = String(chatKey || 'unknown')
  const tag = createHash('sha1').update(raw).digest('hex').slice(0, 8)
  const readable = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60)
  return `${readable || 'chat'}-${tag}`
}

/** 只保留最近 limit 条、且总字符不超过 maxChars（从最旧的开始丢）。 */
export function trimHistory(list, { limit = 20, maxChars = 8000 } = {}) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: String(m.content) }))
  const max = Math.max(0, Math.round(Number(limit) || 0))
  const chars = Math.max(1000, Math.round(Number(maxChars) || 0))
  let kept = max > 0 ? rows.slice(-max) : []
  // 从最旧的一条开始丢，直到总字符压到上限内。
  while (kept.length > 1 && kept.reduce((sum, m) => sum + m.content.length, 0) > chars) kept.shift()
  return kept
}

/**
 * @param {{ home: string }} options
 */
export function createChatContext({ home }) {
  const dir = join(home, 'plugin-ecosystem', '.storage', 'fish-world', 'chat-context')

  function fileFor(chatKey) {
    return join(dir, `${safeKey(chatKey)}.json`)
  }

  // ── 文件格式（2026-11-23 升级，**向后兼容**）──
  //   旧：纯数组 `[msg, …]`
  //   新：`{ messages: [msg, …], round: N, cooldowns: {节标识: 轮号} }`
  // ★ 升级理由（施工单 §5 判据 #5/#7）：条件档的 `cooldown` 与惦记的「20 轮内重提 ≤1 次」
  //   都需要**每会话的轮号与冷却状态**，而它们天然跟会话走 —— 和历史存一起最省事
  //   （主人 2026-11-23 选 A：`chatContext` 加 round 字段）。
  // ★ 旧数组文件照读（`read` 里包一层），**历史一条都不能丢**。
  function read(chatKey) {
    try {
      const data = readJson(fileFor(chatKey), [])
      if (Array.isArray(data)) return { messages: data, round: 0, cooldowns: {}, lastAt: 0 }
      return {
        messages: Array.isArray(data.messages) ? data.messages : [],
        round: Math.max(0, Math.round(Number(data.round) || 0)),
        cooldowns: data.cooldowns && typeof data.cooldowns === 'object' ? data.cooldowns : {},
        // §3.1 时间感：**上一轮**的时间戳（当前轮据此算「距上次对话过去了 <X>」）
        lastAt: Math.max(0, Number(data.lastAt) || 0),
      }
    } catch {
      return { messages: [], round: 0, cooldowns: {}, lastAt: 0 }
    }
  }

  function write(chatKey, next) {
    try {
      writeJson(fileFor(chatKey), {
        messages: Array.isArray(next.messages) ? next.messages : [],
        round: Math.max(0, Math.round(Number(next.round) || 0)),
        cooldowns: next.cooldowns && typeof next.cooldowns === 'object' ? next.cooldowns : {},
        lastAt: Math.max(0, Number(next.lastAt) || 0),
      })
      remember(chatKey)
      return true
    } catch {
      return false
    }
  }

  function load(chatKey) {
    // ★ 对外仍返回**消息数组**（现有调用方全按数组用，签名不变）
    return read(chatKey).messages
  }

  function save(chatKey, list) {
    // 只换 messages，**保留 round / cooldowns**（否则每次存历史都把状态清了）
    return write(chatKey, { ...read(chatKey), messages: Array.isArray(list) ? list : [] })
  }

  /** 每会话状态（施工单 §5 + §3.1）：轮号、条件冷却、上一轮时间 —— 只读副本，改要走 patchState。 */
  function state(chatKey) {
    const s = read(chatKey)
    return { round: s.round, cooldowns: { ...s.cooldowns }, lastAt: s.lastAt }
  }

  /** 轮号 +1，返回新值（每条用户消息调一次）。 */
  function bumpRound(chatKey) {
    const s = read(chatKey)
    s.round += 1
    write(chatKey, s)
    return s.round
  }

  /** 合并写入状态（cooldowns 浅合并；round / lastAt 显式给才覆盖）。 */
  function patchState(chatKey, patch = {}) {
    const s = read(chatKey)
    if (patch.cooldowns && typeof patch.cooldowns === 'object') s.cooldowns = { ...s.cooldowns, ...patch.cooldowns }
    const r = Number(patch.round)
    if (Number.isFinite(r)) s.round = Math.max(0, Math.round(r))
    const t = Number(patch.lastAt)
    if (Number.isFinite(t)) s.lastAt = Math.max(0, Math.round(t))
    write(chatKey, s)
    return state(chatKey)
  }

  // safeKey 是哈希后的文件名；压缩器要按「聊天」而不是文件名枚举，这里记一份映射。
  function indexPath() {
    return join(dir, 'index.json')
  }

  function remember(chatKey) {
    try {
      const map = readJson(indexPath(), {})
      const key = safeKey(chatKey)
      if (!map || map[key] !== chatKey) {
        const next = map && typeof map === 'object' ? { ...map } : {}
        next[key] = chatKey
        writeJson(indexPath(), next)
      }
    } catch {}
  }

  function chats() {
    try {
      const map = readJson(indexPath(), {})
      return Object.values(map || {}).filter((value) => typeof value === 'string')
    } catch {
      return []
    }
  }

  function append(chatKey, message, options = {}) {
    const next = trimHistory([...load(chatKey), message], options)
    save(chatKey, next)
    return next
  }

  function clear(chatKey) {
    // ★ 清历史 = 重置会话 ⇒ round / cooldowns / lastAt 一起归零
    //   （lastAt 不清的话，新会话第一条会算出「距上次对话过去了很久」——那是假的）
    return write(chatKey, { messages: [], round: 0, cooldowns: {}, lastAt: 0 })
  }

  return { dir: () => dir, fileFor, load, save, append, trim: trimHistory, clear, chats, state, bumpRound, patchState }
}
