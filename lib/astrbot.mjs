// AstrBot 接入：把 AstrBot 当成鱼的 QQ 通道，并借用它的 Agent 与插件工具。
//
// 两条互相独立的线，各自有开关：
//   1. QQ 通道（useForQQ）：鱼的每一次 call(action, params) 交给 AstrBot 的 OneBot 适配器执行。
//      AstrBot 内部用的是 bot.call_action，属于全量透传，所以群历史、合并转发、戳一戳、
//      get_cookies（QQ 空间登录态）都不会丢。
//   2. 借用 Agent（borrowTools）：鱼把一段 prompt 交给 AstrBot 的 Agent 跑，由 AstrBot
//      决定调用哪些已装插件的工具。默认关闭——它会真的执行别人的插件。
//
// 通信对象是 AstrBot 里那个「鱼世界桥」插件自己起的本机 HTTP 服务（默认 127.0.0.1:6210），
// 不走 AstrBot 的 dashboard，所以不需要 AstrBot 的登录态，只要一个共享 token。
//
// 安全底线（token 就是密钥，必须守住）：
//   1. token 单独落盘（$DSH_HOME/fish-world-astrbot.json，权限 0600），不进主配置、不进日志、不进提示词；
//   2. 读接口只返回 hasToken 与打码预览，永不返回明文；
//   3. 只允许 http(s)；非本机地址必须 https，防止 token 明文过网；
//   4. 失败时不回显响应体，只报状态码，避免把对端内容带进日志。
import { chmodSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME } from './paths.mjs'
import { clampNumber } from './util.mjs'

export const ASTRBOT_FILE = join(DSH_HOME, 'fish-world-astrbot.json')

// 桥插件默认监听 6210。探测时顺带试几个相邻端口：
// 主人改了端口又忘了填进鱼世界，是最常见的卡住原因。
export const CANDIDATE_PORTS = Object.freeze([6210, 6211, 6212])

export const DEFAULT_ASTRBOT = {
  enabled: false,
  // 桥插件自己起的本机服务地址。
  baseUrl: 'http://127.0.0.1:6210',
  // 当作 QQ 通道使用（line 1）。
  useForQQ: false,
  // 借用 AstrBot 的插件工具（line 2）。默认关：会真的执行别人的插件。
  // 只借"手"不借"嘴"：AstrBot 执行工具并返回原始结果，表达仍由鱼自己完成。
  borrowTools: false,
  // AstrBot 里要用哪个会话当"主人会话"，用于推导身份与默认目标。
  // 留空时桥插件会用最后一条收到的消息推导。
  ownerUmo: '',
  timeoutMs: 15000,
  // 轮询新消息的间隔。
  pollMs: 3000,
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

/** 校验 baseUrl：只允许 http(s)；非本机必须 https。 */
export function validateAstrBotUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return { ok: true, url: '' }
  let url
  try { url = new URL(text) } catch { return { ok: false, error: '地址格式不对，需要完整 URL' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: '只支持 http(s) 地址' }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, error: '非本机地址必须用 https，否则 token 会明文过网' }
  }
  if (url.username || url.password) return { ok: false, error: '不要把凭据写在地址里，请用单独的 token 字段' }
  return { ok: true, url: text.replace(/\/+$/, '') }
}

export function normalizeAstrbot(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const checked = validateAstrBotUrl(src.baseUrl != null ? src.baseUrl : DEFAULT_ASTRBOT.baseUrl)
  return {
    enabled: src.enabled === true,
    baseUrl: checked.ok ? checked.url : DEFAULT_ASTRBOT.baseUrl,
    useForQQ: src.useForQQ === true,
    borrowTools: src.borrowTools === true,
    ownerUmo: String(src.ownerUmo || '').trim().slice(0, 200),
    timeoutMs: clampNumber(src.timeoutMs, 1000, 120000, DEFAULT_ASTRBOT.timeoutMs),
    pollMs: clampNumber(src.pollMs, 1000, 60000, DEFAULT_ASTRBOT.pollMs),
  }
}

/** 打码：只留最后 4 位。 */
export function maskToken(token) {
  const text = String(token || '')
  if (!text) return ''
  if (text.length <= 4) return '••••'
  return '••••' + text.slice(-4)
}

function readStore(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
}

function writeStore(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  // token 文件只给当前用户读。
  try { chmodSync(file, 0o600) } catch {}
  return true
}

/**
 * AstrBot 桥的客户端。
 *
 * 只有 callOneBot 是"热路径"（鱼的每一次 QQ 操作都会走它）；
 * pollEvents / tools / agent 是可选能力，失败都安静降级，不拖垮主流程。
 */
export function createAstrbot({ home = DSH_HOME, configStore, logger } = {}) {
  const file = home === DSH_HOME ? ASTRBOT_FILE : join(home, 'fish-world-astrbot.json')

  // 落盘缓存：按 mtime 判断是否重读。view()/config() 会被 QQ 热路径频繁调用，
  // 不能每次调用都同步读一次文件。
  let cache = { mtime: -1, size: -1, value: null }

  function stored() {
    try {
      const stat = statSync(file)
      if (stat.mtimeMs === cache.mtime && stat.size === cache.size && cache.value) return cache.value
      const value = readStore(file)
      cache = { mtime: stat.mtimeMs, size: stat.size, value }
      return value
    } catch {
      // 文件不存在：给空对象，但不要缓存，方便主人刚创建就被读到。
      return {}
    }
  }

  // AstrBot 侧的身份信息（登录号 / 主人会话）。桥的健康检查会刷新它，
  // 供没有 dsh-qq-bridge 配置文件的用户使用。
  let identity = { userId: '', nickname: '', umo: '', at: 0 }

  function identityView() {
    return { ...identity }
  }

  function updateIdentity(patch = {}) {
    const next = {
      userId: String(patch.userId || identity.userId || ''),
      nickname: String(patch.nickname || identity.nickname || ''),
      umo: String(patch.umo || identity.umo || ''),
      at: Date.now(),
    }
    identity = next
    return identityView()
  }

  function config() {
    const store = stored()
    const fromStore = normalizeAstrbot(store.astrbot || {})
    const fromConfig = normalizeAstrbot(configStore?.getConfig?.()?.astrbot || {})
    return { ...fromConfig, ...fromStore }
  }

  function token() {
    return String(stored().token || '')
  }

  /** 给界面看的视图：永远不含 token 明文。 */
  function view() {
    const cfg = config()
    const key = token()
    return {
      ok: true,
      ...cfg,
      hasToken: key.length > 0,
      tokenPreview: maskToken(key),
      tokenUpdatedAt: stored().tokenUpdatedAt || null,
      // 真正能不能用：开了开关 + 有地址 + 有 token
      active: cfg.enabled && cfg.baseUrl !== '' && key.length > 0,
      canUseForQQ: cfg.enabled && cfg.useForQQ && cfg.baseUrl !== '' && key.length > 0,
      canBorrowTools: cfg.enabled && cfg.borrowTools && cfg.baseUrl !== '' && key.length > 0,
      // 界面直接读这个，不用自己再拼一遍开关逻辑。
      transport: cfg.enabled && cfg.useForQQ && cfg.baseUrl !== '' && key.length > 0 ? 'astrbot' : 'snowluma',
    }
  }

  /**
   * 切 QQ 通道：'astrbot' 交给 AstrBot，'snowluma' 直连协议端。
   * 切不过去就抛错（没地址 / 没 token），绝不静默落回默认值 —— 那种"显示切了、其实没切"最难查。
   * 切回 snowluma 只关 useForQQ，不动 enabled：「借用 AstrBot 的工具」是另一件事。
   */
  function setTransport(mode) {
    const want = String(mode == null ? '' : mode).trim().toLowerCase()
    if (want === 'astrbot') {
      const cfg = config()
      if (!cfg.baseUrl) throw new Error('还没填 AstrBot 桥的地址，切不过去')
      if (!token()) throw new Error('还没配 AstrBot 桥的 token，切不过去')
      return save({ enabled: true, useForQQ: true })
    }
    if (want === 'snowluma' || want === 'bridge') return save({ useForQQ: false })
    throw new Error('只认 astrbot / snowluma 两种通道')
  }

  /** 保存设置。token 传空字符串 = 不改；传 null = 清除。 */
  function save(patch = {}) {
    const current = config()
    // 先校验主人填的原始地址：normalizeAstrbot 会把非法地址静默换成默认值，
    // 那样用户填错了也"保存成功"，之后所有请求都打到默认端口，非常难排查。
    const rawUrl = patch.baseUrl != null ? patch.baseUrl : current.baseUrl
    const checked = validateAstrBotUrl(rawUrl)
    if (!checked.ok) throw new Error(checked.error)

    const next = normalizeAstrbot({ ...current, ...patch, baseUrl: checked.url })

    const store = stored()
    store.astrbot = next
    if (Object.prototype.hasOwnProperty.call(patch, 'token')) {
      if (patch.token === null) {
        delete store.token
        delete store.tokenUpdatedAt
      } else if (String(patch.token).trim()) {
        store.token = String(patch.token).trim()
        store.tokenUpdatedAt = new Date().toISOString()
      }
    }
    writeStore(file, store)
    // 非敏感字段同步进主配置，方便外部工具读取（不含 token）。
    if (configStore?.saveConfig) {
      try { configStore.saveConfig({ astrbot: next }) } catch {}
    }
    return view()
  }

  function generateToken() {
    const bytes = new Uint8Array(24)
    try { globalThis.crypto.getRandomValues(bytes) } catch {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    }
    return 'fw_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** 生成新 token 并落盘；返回给界面的视图不含明文。 */
  function rotateToken() {
    save({ token: generateToken() })
    return view()
  }

  /**
   * 生成新 token，并连同明文一起返回。
   * 只有面板上「需要主人复制去 AstrBot」这一刻才用得上；
   * 因此单独一个函数，避免普通 GET 也带上明文。
   */
  function rotateTokenWithSecret() {
    const value = generateToken()
    save({ token: value })
    return { ok: true, token: value, ...view() }
  }

  function headers() {
    const key = token()
    return {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    }
  }

  /** 统一请求：失败只报状态码，不回显对端响应体。 */
  async function request(path, { method = 'GET', body, timeoutMs } = {}) {
    const cfg = config()
    if (!cfg.baseUrl) return { ok: false, error: '还没有配置 AstrBot 桥的地址' }
    const key = token()
    if (!key) return { ok: false, error: '还没有配置 AstrBot 桥的 token' }
    const ms = Number(timeoutMs) || cfg.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      const response = await fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: headers(),
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        // 桥自己给出的 { ok:false, error } 是可操作的信息（例如"没有这个工具"），
        // 要转达；但不能整段回显，避免把对端无关内容带进日志。
        let detail = ''
        try {
          const payload = await response.json()
          if (payload && typeof payload.error === 'string') detail = payload.error.slice(0, 160)
        } catch {}
        return {
          ok: false,
          status: response.status,
          error: detail || `桥返回 ${response.status}`,
        }
      }
      const json = await response.json().catch(() => null)
      if (!json || typeof json !== 'object') return { ok: false, error: '桥返回的不是 JSON' }
      return { ok: true, status: response.status, json }
    } catch (error) {
      const message = String(error?.message || error)
      return { ok: false, error: controller.signal.aborted ? '桥请求超时' : message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 把一次 OneBot 动作交给 AstrBot 执行。
   * 返回结构与 qq.mjs 的 call() 完全一致，所以能直接当 transport 用。
   */
  async function callOneBot(action, body = {}, { timeoutMs } = {}) {
    const name = String(action || '').trim()
    if (!name) return { action: '', ok: false, data: null, error: '缺少 action' }
    const result = await request('/onebot', { method: 'POST', body: { action: name, params: body || {} }, timeoutMs })
    if (!result.ok) return { action: name, ok: false, data: null, error: result.error }
    const payload = result.json || {}
    // 桥统一回 { status, retcode, data, message }，与 OneBot 11 原生一致。
    const ok = payload.status === 'ok' || payload.retcode === 0 || payload.ok === true
    return {
      action: name,
      ok,
      data: payload.data ?? null,
      error: ok ? '' : String(payload.message || payload.error || 'onebot-error').slice(0, 200),
    }
  }

  /** 桥与 AstrBot 的连通性。顺带记下 AstrBot 侧的身份（登录号 / 主人会话）。 */
  async function health() {
    const result = await request('/health', { timeoutMs: 5000 })
    if (!result.ok) return { ok: false, error: result.error }
    const json = result.json || {}
    try {
      updateIdentity({
        userId: json.userId || json.user_id,
        nickname: json.nickname,
        umo: json.ownerUmo || json.owner_umo,
      })
    } catch {}
    return { ok: true, ...json }
  }

  /** 列出 AstrBot 里已注册的插件工具（只读，给界面看）。 */
  async function tools() {
    const result = await request('/tools', { timeoutMs: 8000 })
    if (!result.ok) return { ok: false, error: result.error, tools: [] }
    return { ok: true, tools: Array.isArray(result.json?.tools) ? result.json.tools : [] }
  }

  /** 读自某个游标之后的新消息。 */
  async function pollEvents(since = 0) {
    const cursor = Number(since) || 0
    const result = await request(`/events?since=${encodeURIComponent(cursor)}`, { timeoutMs: 8000 })
    if (!result.ok) return { ok: false, error: result.error, events: [], cursor }
    const json = result.json || {}
    return {
      ok: true,
      events: Array.isArray(json.events) ? json.events : [],
      cursor: Number(json.cursor) || cursor,
    }
  }

  /**
   * 执行 AstrBot 里的一个工具，拿到原始输出。
   *
   * 注意这里**不是**"让 AstrBot 帮忙回答"：AstrBot 只出手，不出嘴。
   * 鱼的模型、人格、记忆、语气全在 DSH 这一侧，AstrBot 返回的只是工具原始结果，
   * 由鱼自己决定怎么理解、要不要说、怎么说。这样无论加多少外部能力，
   * 说话的始终是同一条鱼。
   */
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

  /**
   * 探测本机哪个端口上躺着鱼世界桥。
   *
   * 只认两种回应：200 = 桥在且 token 正确；403 = 桥在但 token 不对。
   * 其它情况（连不上、404、非 JSON）都算"这里没有桥"，不猜。
   * 带不带 token 都能探：没配 token 时桥会回 403，同样能认出它。
   */
  async function probe({ ports = [], timeoutMs = 1200 } = {}) {
    const key = token()
    const wanted = []
    for (const item of ports) {
      const text = String(item || '').trim()
      if (text && !wanted.includes(text)) wanted.push(text.replace(/\/+$/, ''))
    }
    const cfg = config()
    if (cfg.baseUrl && !wanted.includes(cfg.baseUrl)) wanted.unshift(cfg.baseUrl)
    for (const port of CANDIDATE_PORTS) {
      const url = `http://127.0.0.1:${port}`
      if (!wanted.includes(url)) wanted.push(url)
    }

    const tried = []
    for (const base of wanted) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${base}/health`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: controller.signal,
        })
        clearTimeout(timer)
        tried.push({ base, status: response.status })
        // 桥在，但 token 不对：立刻报告，不用再试其它端口。
        if (response.status === 403) return { ok: true, base, tried, match: false, status: 403 }
        if (response.status !== 200) continue
        const json = await response.json().catch(() => null)
        const payload = json && typeof json === 'object' ? json : {}
        return {
          ok: true,
          base,
          tried,
          match: true,
          userId: String(payload.userId || payload.user_id || ''),
          nickname: String(payload.nickname || ''),
          hasAdapter: payload.hasAdapter !== false,
          listening: payload.listening !== false,
        }
      } catch (error) {
        clearTimeout(timer)
        tried.push({ base, status: 0, error: controller.signal.aborted ? '超时' : String(error?.message || error).slice(0, 60) })
      }
    }
    return { ok: false, base: '', tried, match: false, error: '本机没找到鱼世界桥' }
  }

  return { file, config, view, save, setTransport, rotateToken, rotateTokenWithSecret, token, callOneBot, health, tools, pollEvents, runTool, identityView, updateIdentity, probe }
}
