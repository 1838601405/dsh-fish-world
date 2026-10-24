// 鱼的发言 API：给「说话」单独配一个模型端点。
//
// 为什么不复用 DSH 主模型：
//  - 评论、聊天这类短文本对语气要求高，用语言特化模型效果更好；
//  - 它是可选的：不配就用宿主模型，配了才替换。
//
// 安全底线（这是密钥，必须守住）：
//  1. 密钥单独落盘（$DSH_HOME/fish-world-voice.json，权限 0600），
//     不进主配置、不进日志、不进提示词；
//  2. 读接口只返回 hasKey 与打码预览，永不返回明文；
//  3. 只允许 http(s)，且必须 https（本机回环允许 http）；
//  4. 请求失败不回显响应体里的敏感内容，只报状态码；
//  5. 发送到模型的内容由这里统一裁剪长度，避免把整篇日记贴出去。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const VOICE_FILE = join(DSH_HOME, 'fish-world-voice.json')
const MAX_KEYS = 200
const DEFAULT_TIMEOUT = 30000
const MAX_OUTPUT_CHARS = 2000

export const DEFAULT_VOICE = {
  enabled: false,
  // OpenAI 兼容的 chat/completions 端点
  baseUrl: '',
  model: '',
  // 采样参数
  temperature: 0.9,
  maxTokens: 400,
  timeoutMs: DEFAULT_TIMEOUT,
  // 哪些场景用这个端点
  scenarios: { chat: true, comment: true, diary: false, greeting: false },
  // 系统提示词由人设卡驱动；这里只放一段补充要求
  stylePrompt: '',
}

const BOOLEAN_SCENARIOS = new Set(['chat', 'comment', 'diary', 'greeting'])

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

/** 校验 baseUrl：只允许 https；本机回环才允许 http。 */
export function validateBaseUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return { ok: true, url: '' }
  let url
  try { url = new URL(text) } catch { return { ok: false, error: '地址格式不对，需要完整 URL' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: '只支持 http(s) 地址' }
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, error: '非本机地址必须用 https，避免密钥明文传输' }
  }
  if (url.username || url.password) {
    return { ok: false, error: '不要把账号密码写在地址里，请用单独的 API Key 字段' }
  }
  return { ok: true, url: text.replace(/\/+$/, '') }
}

/** 归一化配置：只收白名单字段，数值夹紧。 */
export function normalizeVoice(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const checked = validateBaseUrl(src.baseUrl)
  const scenarios = {}
  for (const key of BOOLEAN_SCENARIOS) {
    // 未显式给出时用默认值（chat / comment 默认开，diary / greeting 默认关）。
    scenarios[key] = typeof src.scenarios?.[key] === 'boolean'
      ? src.scenarios[key] === true
      : DEFAULT_VOICE.scenarios[key] === true
  }
  return {
    enabled: src.enabled === true,
    baseUrl: checked.ok ? checked.url : '',
    model: String(src.model || '').trim().slice(0, 120),
    temperature: Math.max(0, Math.min(2, Number(src.temperature) >= 0 ? Number(src.temperature) : DEFAULT_VOICE.temperature)),
    maxTokens: Math.max(16, Math.min(4096, Math.round(Number(src.maxTokens) || DEFAULT_VOICE.maxTokens))),
    timeoutMs: Math.max(3000, Math.min(120000, Math.round(Number(src.timeoutMs) || DEFAULT_VOICE.timeoutMs))),
    scenarios,
    stylePrompt: String(src.stylePrompt || '').slice(0, 2000),
  }
}

/** 打码：只留最后 4 位，用于界面确认"存的是哪把钥匙"。 */
export function maskKey(key) {
  const text = String(key || '')
  if (!text) return ''
  if (text.length <= 4) return '••••'
  return '••••' + text.slice(-4)
}

function readStore(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

function writeStore(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  // 尽量收紧权限：密钥文件只给当前用户读。
  try { chmodSync(file, 0o600) } catch {}
  return true
}

export function createVoice({ home = DSH_HOME, configStore, logger } = {}) {
  const file = home === DSH_HOME ? VOICE_FILE : join(home, 'fish-world-voice.json')

  function stored() {
    return readStore(file)
  }

  /** 合并后的完整配置（含密钥，绝不外传）。 */
  function config() {
    const store = stored()
    const fromStore = normalizeVoice(store.voice || {})
    const fromConfig = normalizeVoice(configStore?.getConfig?.()?.voice || {})
    // 主配置只放非敏感字段；以文件里的为准，缺的用主配置补。
    return {
      ...fromConfig,
      ...fromStore,
      scenarios: { ...fromConfig.scenarios, ...fromStore.scenarios },
    }
  }

  /** 给界面看的视图：永远不含密钥明文。 */
  function view() {
    const cfg = config()
    const store = stored()
    const key = String(store.apiKey || '')
    return {
      ok: true,
      ...cfg,
      hasKey: key.length > 0,
      keyPreview: maskKey(key),
      keyUpdatedAt: store.apiKeyUpdatedAt || null,
      // 运行时是否真的会用它
      active: cfg.enabled && cfg.baseUrl !== '' && cfg.model !== '' && key.length > 0,
      supportedScenarios: [...BOOLEAN_SCENARIOS],
    }
  }

  /**
   * 保存设置。apiKey 传空字符串表示"不修改"；传 null 表示清除。
   */
  function save(patch = {}) {
    const current = config()
    const checked = validateBaseUrl(patch.baseUrl != null ? patch.baseUrl : current.baseUrl)
    if (!checked.ok) throw new Error(checked.error)

    const next = normalizeVoice({
      ...current,
      ...patch,
      baseUrl: patch.baseUrl != null ? patch.baseUrl : current.baseUrl,
      scenarios: { ...current.scenarios, ...(patch.scenarios || {}) },
    })

    const store = stored()
    store.voice = next
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
      if (patch.apiKey === null) {
        delete store.apiKey
        delete store.apiKeyUpdatedAt
      } else if (String(patch.apiKey).trim()) {
        store.apiKey = String(patch.apiKey).trim()
        store.apiKeyUpdatedAt = new Date().toISOString()
      }
      // 空字符串 = 保持原密钥不变
    }

    writeStore(file, store)
    // 非敏感字段同步进主配置，便于外部工具读取（不含密钥）
    if (configStore?.saveConfig) {
      try {
        configStore.saveConfig({
          voice: {
            enabled: next.enabled,
            baseUrl: next.baseUrl,
            model: next.model,
            temperature: next.temperature,
            maxTokens: next.maxTokens,
            timeoutMs: next.timeoutMs,
            scenarios: next.scenarios,
            stylePrompt: next.stylePrompt,
          },
        })
      } catch {}
    }
    return view()
  }

  function scenarioEnabled(scenario) {
    const cfg = config()
    return cfg.enabled && cfg.scenarios?.[scenario] === true
  }

  function ready() {
    const cfg = config()
    const key = String(stored().apiKey || '')
    return cfg.enabled && cfg.baseUrl !== '' && cfg.model !== '' && key.length > 0
  }

  /**
   * 调用发言模型。失败时抛错或返回 { ok:false }，绝不返回半截内容冒充成功。
   * @param {{ messages: Array<{role:string, content:string}>, scenario?: string }} input
   */
  async function speak({ messages, scenario = 'chat' } = {}) {
    const cfg = config()
    const key = String(stored().apiKey || '')
    if (!cfg.enabled) throw new Error('发言 API 未启用')
    if (!cfg.baseUrl || !cfg.model) throw new Error('发言 API 还缺地址或模型名')
    if (!key) throw new Error('发言 API 还没有填写密钥')
    if (!scenarioEnabled(scenario)) throw new Error(`场景「${scenario}」没有开启使用发言 API`)

    const cleaned = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && typeof m.content === 'string')
      .map((m) => ({
        role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
        content: String(m.content).slice(0, 8000),
      }))
    if (!cleaned.length) throw new Error('没有可发送的内容')
    if (cfg.stylePrompt) cleaned.unshift({ role: 'system', content: cfg.stylePrompt.slice(0, 2000) })

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), cfg.timeoutMs) : null
    try {
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: cleaned,
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
        }),
        signal: controller ? controller.signal : undefined,
      })
      if (!response.ok) {
        // 只报状态码，不回显响应体——里面可能含有密钥或账号信息
        throw new Error(`发言 API 返回 HTTP ${response.status}`)
      }
      const data = await response.json()
      const text = String(data?.choices?.[0]?.message?.content || '').trim()
      if (!text) throw new Error('发言 API 返回了空内容')
      return {
        ok: true,
        text: text.slice(0, MAX_OUTPUT_CHARS),
        usage: data?.usage || null,
        model: String(data?.model || cfg.model),
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('发言 API 超时')
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 测试连通性：发一句极短的话，确认地址/密钥/模型都对。 */
  async function test() {
    try {
      const result = await speak({
        messages: [{ role: 'user', content: '回一个字：在' }],
        scenario: Object.keys(BOOLEAN_SCENARIOS).find((key) => scenarioEnabled(key)) || 'chat',
      })
      return { ok: true, text: result.text, model: result.model }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  return {
    file: () => file,
    view,
    save,
    config,
    ready,
    scenarioEnabled,
    speak,
    test,
    __test: { normalizeVoice, validateBaseUrl, maskKey },
  }
}

export { MAX_KEYS }
