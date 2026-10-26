// QQ Agent 借手通道：把 QQ-agent 里的插件工具借过来执行。
//
// 和 AstrBot 那条是同一种关系：**只借手，不借嘴**。
// QQ-agent 执行工具、返回原始输出；理解、说话、人设、记忆全在 DSH 这一侧。
//
// 为什么要单独一条通道：QQ-agent 用自己的加载器读插件（index.js + plugin.json），
// DSH 读不了那些插件；但两边可以共用同一个协议端（SnowLuma）。
// 所以「共用协议端」只管收发消息，「借插件」得另外接一根线 —— 就是这里。
//
// 对端是配套插件 (companions/qqagent-plugin)，契约和 AstrBot 桥一致：
//   GET  /tools  -> { ok:true, tools:[{ name, description, params? }] }
//   POST /tool   -> { ok:true, output:"..." } | { ok:false, error:"..." }
//   GET  /health -> { ok:true, version?, account? }
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME } from './paths.mjs'
import { maskToken, validateAstrBotUrl } from './astrbot.mjs'

const QQAGENT_FILE = join(DSH_HOME, 'fish-world-qqagent.json')

export const DEFAULT_QQAGENT = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:3211',
  timeoutMs: 15000,
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function normalizeQQAgent(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const checked = validateAstrBotUrl(src.baseUrl == null ? DEFAULT_QQAGENT.baseUrl : src.baseUrl)
  return {
    enabled: src.enabled === true,
    baseUrl: checked.ok ? checked.url : DEFAULT_QQAGENT.baseUrl,
    timeoutMs: clampNumber(src.timeoutMs, 1000, 60000, DEFAULT_QQAGENT.timeoutMs),
  }
}

function readStore(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
}

/**
 * @param {{ home?: string, logger?: object, fetchImpl?: Function }} options
 *   fetchImpl 只为测试注入；生产用全局 fetch。
 */
export function createQQAgent({ home = DSH_HOME, logger, fetchImpl } = {}) {
  const file = home === DSH_HOME ? QQAGENT_FILE : join(home, 'fish-world-qqagent.json')
  const doFetch = fetchImpl || globalThis.fetch
  let cache = { mtime: -1, value: null }

  function stored() {
    try {
      const stat = statSync(file)
      if (stat.mtimeMs === cache.mtime && cache.value) return cache.value
      cache = { mtime: stat.mtimeMs, value: readStore(file) }
      return cache.value
    } catch {
      return {}
    }
  }

  function config() {
    return normalizeQQAgent(stored().qqagent || {})
  }

  function token() {
    return String(stored().token || '')
  }

  function view() {
    const cfg = config()
    const key = token()
    return {
      ok: true,
      ...cfg,
      hasToken: key.length > 0,
      tokenPreview: maskToken(key),
      active: cfg.enabled && cfg.baseUrl !== '' && key.length > 0,
    }
  }

  function save(patch = {}) {
    const current = config()
    const rawUrl = patch.baseUrl != null ? patch.baseUrl : current.baseUrl
    const checked = validateAstrBotUrl(rawUrl)
    if (!checked.ok) throw new Error(checked.error)
    const next = normalizeQQAgent({ ...current, ...patch, baseUrl: checked.url })
    const store = stored()
    store.qqagent = next
    if (Object.prototype.hasOwnProperty.call(patch, 'token')) {
      if (patch.token === null) delete store.token
      else if (String(patch.token).trim()) store.token = String(patch.token).trim()
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch {}
    cache = { mtime: -1, value: null }
    return view()
  }

  /** 生成一个 token（面板点「生成」时用）；返回明文一次，之后只给打码预览。 */
  function rotateToken() {
    const value = 'fq_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    const store = stored()
    store.token = value
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
    cache = { mtime: -1, value: null }
    return { ok: true, token: value, ...view() }
  }

  async function request(path, { method = 'GET', body, timeoutMs } = {}) {
    const cfg = config()
    if (!cfg.baseUrl) return { ok: false, error: '还没配 QQ Agent 桥的地址' }
    const key = token()
    if (!key) return { ok: false, error: '还没配 QQ Agent 桥的 token' }
    const ms = Number(timeoutMs) || cfg.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      const response = await doFetch(cfg.baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        let detail = ''
        try {
          const payload = await response.json()
          if (payload && typeof payload.error === 'string') detail = payload.error.slice(0, 160)
        } catch {}
        return { ok: false, status: response.status, error: detail || 'QQ Agent 桥返回 ' + response.status }
      }
      const json = await response.json().catch(() => null)
      if (!json || typeof json !== 'object') return { ok: false, error: 'QQ Agent 桥返回的不是 JSON' }
      return { ok: true, status: response.status, json }
    } catch (error) {
      const message = String((error && error.message) || error)
      return { ok: false, error: controller.signal.aborted ? 'QQ Agent 桥请求超时' : message }
    } finally {
      clearTimeout(timer)
    }
  }

  async function health() {
    const result = await request('/health', { timeoutMs: 5000 })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, ...result.json }
  }

  /** 列出 QQ-agent 里注册的插件工具。 */
  async function tools() {
    const result = await request('/tools', { timeoutMs: 8000 })
    if (!result.ok) return { ok: false, error: result.error, tools: [] }
    return { ok: true, tools: Array.isArray(result.json?.tools) ? result.json.tools : [] }
  }

  /** 执行一个插件工具，只拿原始输出。 */
  async function runTool({ name, params = {}, timeoutMs } = {}) {
    const tool = String(name || '').trim()
    if (!tool) return { ok: false, error: '缺少工具名' }
    const result = await request('/tool', {
      method: 'POST',
      body: { name: tool, params: params && typeof params === 'object' ? params : {} },
      timeoutMs: Number(timeoutMs) || 60000,
    })
    if (!result.ok) return { ok: false, error: result.error }
    const json = result.json || {}
    if (json.ok === false) return { ok: false, error: String(json.error || '工具执行失败').slice(0, 200) }
    return { ok: true, name: tool, output: String(json.output || '') }
  }

  return { file, config, view, save, rotateToken, token, health, tools, runTool }
}
