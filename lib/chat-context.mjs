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

  function load(chatKey) {
    try {
      const data = readJson(fileFor(chatKey), [])
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  function save(chatKey, list) {
    try {
      writeJson(fileFor(chatKey), Array.isArray(list) ? list : [])
      return true
    } catch {
      return false
    }
  }

  function append(chatKey, message, options = {}) {
    const next = trimHistory([...load(chatKey), message], options)
    save(chatKey, next)
    return next
  }

  function clear(chatKey) {
    return save(chatKey, [])
  }

  return { dir: () => dir, fileFor, load, save, append, trim: trimHistory, clear }
}
