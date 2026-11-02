// 鱼的聊天 API：群聊 / 好友私聊由鱼世界**直接**调模型，不再塞进 DSH 会话。
//
// 为什么：DSH 的会话是给主人和鱼聊天用的；群聊如果也塞进去，历史会无限增长
// （实测 4.3M token，超过窗口后每轮都失败、消息只能排队）。这里让群聊走独立
// 的 OpenAI 兼容接口，上下文只保留最近几条，DSH 只负责主人 QQ 的私聊。
//
// 约定：
//  · 默认走本机 magpie 网关（http://127.0.0.1:3425/v1），模型 group/cheap-first；
//  · 密钥只从环境变量（apiKeyEnv，默认 MAGPIE_GATEWAY_KEY）或单独的
//    `fish-world-chat-api.json` 读，**不写进主配置、不进日志、不返回明文**；
//  · 非本机地址必须 https；本机允许 http。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_CHAT_API = Object.freeze({
  // 群聊/好友私聊用 API；主人私聊仍走 DSH 会话。
  enabled: true,
  baseUrl: 'http://127.0.0.1:3425/v1',
  model: 'group/cheap-first',
  apiKeyEnv: 'MAGPIE_GATEWAY_KEY',
  maxTokens: 800,
  temperature: 0.8,
  timeoutMs: 60000,
  // 每个会话带多少条历史（user/assistant 各算一条）。
  historyLimit: 20,
  // 历史总字符上限，防止把上下文撑大。
  maxChars: 8000,
})

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/** 只允许 http(s)；非本机必须 https；拒绝夹带账号密码。 */
export function normalizeChatBaseUrl(value) {
  const text = String(value == null ? '' : value).trim().replace(/\/+$/, '')
  if (!text) return DEFAULT_CHAT_API.baseUrl
  let url = null
  try { url = new URL(text) } catch { return DEFAULT_CHAT_API.baseUrl }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_CHAT_API.baseUrl
  if (url.username || url.password) return DEFAULT_CHAT_API.baseUrl
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return DEFAULT_CHAT_API.baseUrl
  return text
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 这条消息走不走聊天 API。
 * 主人自己的 QQ 私聊永远走 DSH（用户只保留主人 QQ 的会话能力）；
 * 群聊 / 好友私聊走 API。
 */
export function shouldUseChatApi({ kind, userId, ownerQQ, enabled } = {}) {
  if (enabled !== true) return false
  const k = String(kind || '')
  const u = String(userId || '')
  const owner = String(ownerQQ || '')
  if (k === 'private' && owner && u === owner) return false
  return true
}

export function normalizeChatApi(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const d = DEFAULT_CHAT_API
  return {
    enabled: src.enabled !== false,
    baseUrl: normalizeChatBaseUrl(src.baseUrl),
    model: String(src.model || d.model).trim().slice(0, 120) || d.model,
    apiKeyEnv: String(src.apiKeyEnv || d.apiKeyEnv).trim().slice(0, 80) || d.apiKeyEnv,
    maxTokens: Math.round(clamp(src.maxTokens, 1, 8192, d.maxTokens)),
    temperature: clamp(src.temperature, 0, 2, d.temperature),
    timeoutMs: Math.round(clamp(src.timeoutMs, 5000, 300000, d.timeoutMs)),
    historyLimit: Math.round(clamp(src.historyLimit, 0, 100, d.historyLimit)),
    maxChars: Math.round(clamp(src.maxChars, 1000, 60000, d.maxChars)),
  }
}

/** 从 $DSH_HOME/.env 里取一个键（只读、不打印）。 */
function readDotEnv(home, key) {
  try {
    const file = join(home, '.env')
    if (!existsSync(file)) return ''
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!m || m[1] !== key) continue
      return m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {}
  return ''
}

/**
 * @param {{ home: string, getConfig?: () => any, logger?: any, fetchImpl?: typeof fetch }} options
 */
export function createChatApi({ home, getConfig, logger, fetchImpl } = {}) {
  const cfg = () => normalizeChatApi(typeof getConfig === 'function' ? getConfig() : getConfig)

  function apiKey(config = cfg()) {
    const envName = String(config.apiKeyEnv || '').trim()
    if (envName && process.env[envName]) return String(process.env[envName]).trim()
    // 单独的密钥文件：{ "apiKey": "..." }（面板写入时会 chmod 0600）
    try {
      const file = join(home, 'fish-world-chat-api.json')
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
        const key = String(data?.apiKey || '').trim()
        if (key) return key
      }
    } catch {}
    if (envName) {
      const fromEnv = readDotEnv(home, envName)
      if (fromEnv) return fromEnv
    }
    return ''
  }

  function enabled() {
    const config = cfg()
    return config.enabled === true && Boolean(apiKey(config))
  }

  function status() {
    const config = cfg()
    const key = apiKey(config)
    return {
      ok: true,
      enabled: config.enabled === true && Boolean(key),
      configured: config.enabled === true,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyEnv: config.apiKeyEnv,
      hasKey: Boolean(key),
      historyLimit: config.historyLimit,
      maxChars: config.maxChars,
      note: config.enabled === true
        ? (key ? '群聊/好友私聊走 API；主人私聊仍走 DSH 会话' : `没有读到密钥（环境变量 ${config.apiKeyEnv} 或 fish-world-chat-api.json）`)
        : '已关闭：群聊/好友私聊仍走 DSH 会话',
    }
  }

  /**
   * 调一次聊天接口。永不抛，失败如实返回。
   * @param {{ messages: Array<{role:string,content:string}>, maxTokens?: number, temperature?: number, signal?: AbortSignal }} input
   */
  async function reply({ messages, maxTokens, temperature, signal } = {}) {
    const config = cfg()
    const key = apiKey(config)
    if (config.enabled !== true) return { ok: false, reason: 'disabled', error: '聊天 API 已关闭' }
    if (!key) return { ok: false, reason: 'no-key', error: `没有读到密钥（${config.apiKeyEnv}）` }
    const list = Array.isArray(messages) ? messages.filter((m) => m && m.role && m.content) : []
    if (!list.length) return { ok: false, reason: 'empty', error: '没有要发送的消息' }
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch
    const timeout = AbortSignal.timeout(Math.max(5000, Number(config.timeoutMs) || 60000))
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await doFetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: config.model,
          messages: list,
          max_tokens: Math.max(1, Number(maxTokens) || config.maxTokens),
          temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : config.temperature,
          stream: false,
        }),
        signal: combined,
      })
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, reason: `http-${res.status}`, error: `HTTP ${res.status}：${text.slice(0, 240)}` }
      }
      let data = null
      try { data = JSON.parse(text) } catch {}
      const content = data?.choices?.[0]?.message?.content
      if (content == null || String(content).trim() === '') {
        return { ok: false, reason: 'empty-reply', error: '模型没有返回内容' }
      }
      return { ok: true, text: String(content).trim(), usage: data.usage || null, model: data.model || config.model }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return { ok: false, reason: 'timeout', error: `请求超时（${config.timeoutMs}ms）` }
      }
      try { logger?.warn?.(`fish-world: 聊天 API 请求失败：${error?.message || error}`) } catch {}
      return { ok: false, reason: 'network', error: String(error?.message || error).slice(0, 240) }
    }
  }

  return { cfg, enabled, status, reply, apiKey }
}
