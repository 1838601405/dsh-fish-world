// QQ Agent 0.5 的 setup(ctx) 兼容层（含 0.4 旧 API 的软兼容）。
//
// 原则：
//   1. 只实现普通扩展需要的窄接口，不暴露 DSH 内核对象；
//   2. 声明了权限也不等于自动放行——每次调用仍按 manifest.permissions 检查；
//   3. 没有对应实现的宿主能力（面板 / 记忆 / 提醒 / 原始 OneBot）明确报不支持，
//      不做「看起来成功」的假实现。
import util from 'node:util'

const SCOPE_ALIASES = {
  web_fetch: 'net.outbound',
}
const SUPPORTED_HOOKS = new Set([
  'before-tool',
  'after-tool',
  'message.in',
  'message.out',
  'before-send',
])
const MAX_TOOL_NAME = 64

function scopeOf(scope) {
  const name = String(scope || '')
  return SCOPE_ALIASES[name] || name
}

function resultText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(resultText).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if (typeof value.content === 'string') return value.content
    if (Array.isArray(value.content)) return resultText(value.content)
    if (typeof value.text === 'string') return value.text
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

/** 把扩展返回值归一成 DSH 工具能渲染的对象。 */
export function normalizeToolResult(value) {
  if (value && typeof value === 'object' && value.isError === true) {
    return {
      ok: false,
      isError: true,
      content: resultText(value.content ?? value.error ?? '扩展返回了错误'),
      result: value,
    }
  }
  if (value && typeof value === 'object' && value.ok === false && value.error) {
    return { ok: false, isError: true, content: resultText(value.content ?? value.error), result: value }
  }
  if (value && typeof value === 'object' && (Object.hasOwn(value, 'content') || Object.hasOwn(value, 'result'))) {
    return {
      ok: value.isError !== true,
      content: resultText(value.content ?? value.result),
      result: value,
    }
  }
  return { ok: true, content: resultText(value), result: value }
}

export function createSdk({ manifest, dir, host }) {
  const extId = String(manifest.id)
  const permissions = new Set((Array.isArray(manifest.permissions) ? manifest.permissions : []).map(scopeOf))
  const disposers = new Set()
  const tools = new Map()
  const timers = new Set()

  function allowed(scope) {
    return permissions.has(scopeOf(scope))
  }

  function requireScope(scope, detail) {
    if (allowed(scope)) return
    throw new Error(`扩展 ${extId} 没有声明 ${scope} 权限${detail ? `（${detail}）` : ''}`)
  }

  function remember(disposer) {
    if (typeof disposer !== 'function') return () => {}
    const wrapped = () => {
      if (!disposers.has(wrapped)) return
      disposers.delete(wrapped)
      try { disposer() } catch {}
    }
    disposers.add(wrapped)
    return wrapped
  }

  const logger = host.logger || console

  // 既可调用（0.4 的 api.log(...)），又有 .info/.warn/.error/.debug（0.5 的 ctx.log.info(...)）。
  function makeLog(method) {
    return (...args) => {
      try {
        logger[method]?.(util.format(...args))
      } catch {}
    }
  }
  const log = makeLog('info')
  log.info = makeLog('info')
  log.warn = makeLog('warn')
  log.error = makeLog('error')
  log.debug = makeLog('debug')

  function settings() {
    return host.settings()
  }
  const config = () => settings()
  config.get = (key) => {
    const all = settings()
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined
  }
  config.all = () => ({ ...settings() })
  config.onChange = (fn) => host.onSettingsChange(fn)

  const storage = {
    get(key) {
      const all = host.storage()
      return Object.prototype.hasOwnProperty.call(all, String(key)) ? all[String(key)] : undefined
    },
    set(key, value) {
      const all = host.storage()
      all[String(key)] = value
      host.persistStorage()
      return value
    },
    delete(key) {
      const all = host.storage()
      const had = Object.prototype.hasOwnProperty.call(all, String(key))
      delete all[String(key)]
      host.persistStorage()
      return had
    },
    dir: host.storageDir,
  }

  function buildSendFacade() {
    if (!allowed('qq.send')) {
      const deny = () => { throw new Error(`扩展 ${extId} 没有声明 qq.send 权限`) }
      return {
        sendTextBatch: deny,
        sendImage: deny,
        sendSegments: deny,
        sendSticker: deny,
        poke: deny,
      }
    }
    return {
      sendTextBatch: (chatKey, texts, options = {}) => host.qq.sendTextBatch(chatKey, texts, options),
      sendImage: (chatKey, image, options = {}) => host.qq.sendImage(chatKey, image, options),
      sendSegments: (chatKey, segments, options = {}) => host.qq.send(chatKey, segments, options),
      sendSticker: (chatKey, sticker, options = {}) => host.qq.sendSticker(chatKey, sticker, options),
      poke: (chatKey, target) => host.qq.poke(chatKey, target),
    }
  }

  function buildExecution() {
    const chatKey = host.defaultChatKey()
    const send = buildSendFacade()
    return {
      // 与 QQ Agent 的 execution.send / execution.chatKey 对齐。
      send,
      chatKey,
      signal: host.signal,
      get store() {
        return {
          recent: async (key = chatKey, n = 20) => {
            requireScope('data.sessions.read')
            const result = await host.qq.recent(key, n)
            return result.ok ? result.messages : []
          },
          listChats: () => {
            requireScope('data.sessions.read')
            return host.listChats()
          },
        }
      },
      get stickers() {
        return {
          all: () => {
            requireScope('data.sessions.read')
            return []
          },
          get: (key) => {
            requireScope('data.sessions.read')
            return null
          },
          list: () => {
            requireScope('data.sessions.read')
            return []
          },
        }
      },
      get memory() { return host.unsupported('data.memory（DSH 请用 dsh-fish-memory）') },
      get reminders() { return host.unsupported('data.reminders') },
      get sessions() { return host.unsupported('data.sessions（适配器只提供只读 recent）') },
      get mediaReader() { return host.unsupported('media.reader') },
      get transport() {
        return {
          actions: {
            poke: (key, target) => {
              requireScope('qq.send')
              return host.qq.poke(key, target)
            },
            getMembers: async (groupId) => {
              requireScope('data.sessions.read')
              const result = await host.qq.call('get_group_member_list', { group_id: Number(groupId) })
              return result.ok ? (result.data || []) : []
            },
          },
        }
      },
    }
  }

  function normalizeSchema(def) {
    const schema = def.params || def.parameters
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return { type: 'object', properties: {}, additionalProperties: false }
    }
    let copy
    try { copy = JSON.parse(JSON.stringify(schema)) } catch { copy = { ...schema } }
    // DSH 的硬规则：每个 object 节点都要显式写 additionalProperties。
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      const isObject = node.type === 'object' || (node.properties && typeof node.properties === 'object')
      if (isObject) {
        if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) node.properties = {}
        if (!Object.hasOwn(node, 'additionalProperties')) node.additionalProperties = true
        for (const child of Object.values(node.properties)) walk(child)
      }
      if (node.items) walk(node.items)
      for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(node[key])) for (const child of node[key]) walk(child)
      }
    }
    walk(copy)
    if (!copy.type) copy.type = 'object'
    if (copy.type === 'object' && !copy.properties) copy.properties = {}
    if (copy.type === 'object' && !Object.hasOwn(copy, 'additionalProperties')) copy.additionalProperties = true
    return copy
  }

  function registerTool(def) {
    if (!def || typeof def !== 'object') throw new Error('工具定义必须是对象')
    const handler = def.handler || def.execute
    if (typeof handler !== 'function') throw new Error('工具缺少 handler/execute')
    const rawId = String(def.id || def.name || '').trim()
    if (!rawId) throw new Error('工具缺少 id')
    // 兼容 0.4：有 parameters（没有 params）且用 execute 的旧工具按 execute(ctx, args) 调用。
    // 有 handler 或 params 的按 0.5 原生 handler(args, execution) 调用。
    const native = typeof def.handler === 'function' || Object.hasOwn(def, 'params')
    const finalId = host.registerTool({
      extId,
      toolId: rawId,
      title: String(def.name || rawId),
      description: String(def.description || def.name || rawId),
      parameters: normalizeSchema(def),
      async run(args, execution) {
        try {
          const value = native
            ? await handler.call(def, args, execution || buildExecution())
            : await handler.call(def, legacyApi, args)
          return normalizeToolResult(value)
        } catch (error) {
          return {
            ok: false,
            isError: true,
            content: `扩展工具 ${rawId} 执行失败：${String(error && error.message ? error.message : error)}`,
            error: String(error && error.message ? error.message : error),
          }
        }
      },
    })
    tools.set(finalId, rawId)
    remember(() => host.unregisterTool(finalId))
    return finalId
  }

  function unregisterTool(finalId) {
    const id = String(finalId || '')
    if (!tools.has(id)) return false
    tools.delete(id)
    return host.unregisterTool(id) !== false
  }

  function registerCapability(name, provider, options = {}) {
    return remember(host.registerCapability(String(name), provider, options, extId))
  }

  function unregisterCapability(name) {
    return host.unregisterCapability(String(name), extId)
  }

  function capability(name, ...args) {
    const key = String(name)
    if (key === 'core.send' && !allowed('qq.send')) {
      throw new Error(`扩展 ${extId} 没有声明 qq.send 权限，不能使用 core.send`)
    }
    if ((key === 'data.stickers' || key === 'data.messages') && !allowed('data.sessions.read')) {
      throw new Error(`扩展 ${extId} 没有声明 data.sessions.read 权限，不能使用 ${key}`)
    }
    const builtin = host.builtinCapability(key)
    if (builtin !== undefined) {
      if (typeof builtin === 'function') return builtin(...args)
      return builtin
    }
    return host.capability(key, ...args)
  }

  function hasCapability(name) {
    const key = String(name)
    if (host.builtinCapability(key) !== undefined) return true
    return host.hasCapability(key)
  }

  function requireCapability(name) {
    if (!hasCapability(name)) throw new Error(`缺少能力：${name}`)
    return capability(name)
  }

  function isSkillActive(id) {
    return host.isActive(String(id))
  }

  function onEvent(name, fn) {
    return remember(host.bus.on(String(name), fn, extId))
  }

  function promptAdd(section) {
    if (!section || typeof section !== 'object') return () => {}
    const id = String(section.id || `prompt-${tools.size + 1}`)
    return remember(host.registerPrompt(extId, {
      id,
      title: String(section.title || ''),
      priority: Number(section.priority) || 50,
      content: typeof section.content === 'string' ? section.content : '',
      render: typeof section.render === 'function' ? section.render : null,
    }))
  }

  function scheduleEvery(ms, fn, options = {}) {
    const interval = Math.max(50, Number(ms) || 1000)
    if (typeof fn !== 'function') throw new Error('scheduler.every 需要回调函数')
    const run = () => {
      if (host.signal.aborted) return
      try {
        const value = fn()
        if (value && typeof value.catch === 'function') value.catch((error) => log.warn('定时任务失败：' + (error?.message ?? error)))
      } catch (error) {
        log.warn('定时任务失败：' + (error?.message ?? error))
      }
    }
    const timer = setInterval(run, interval)
    if (typeof timer.unref === 'function') timer.unref()
    const entry = { stop: () => { clearInterval(timer); timers.delete(entry) }, name: String(options.name || '') }
    timers.add(entry)
    remember(entry.stop)
    return entry
  }

  function scheduleAt(when, fn, options = {}) {
    if (typeof fn !== 'function') throw new Error('scheduler.at 需要回调函数')
    let next = 0
    if (when instanceof Date) next = when.getTime()
    else {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(when || ''))
      if (!m) throw new Error('scheduler.at 的时间格式应为 HH:MM 或 Date')
      const hour = Math.max(0, Math.min(23, Number(m[1])))
      const minute = Math.max(0, Math.min(59, Number(m[2])))
      const now = new Date()
      const target = new Date(now)
      target.setHours(hour, minute, 0, 0)
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
      next = target.getTime()
    }
    let timer = null
    const entry = {
      name: String(options.name || ''),
      stop() {
        if (timer) clearTimeout(timer)
        timer = null
        timers.delete(entry)
      },
    }
    const arm = () => {
      if (host.signal.aborted) return
      const delay = Math.max(0, next - Date.now())
      timer = setTimeout(async () => {
        try {
          if (!host.signal.aborted) await fn()
        } catch (error) {
          log.warn('定时任务失败：' + (error?.message ?? error))
        }
        if (typeof when === 'string' && !host.signal.aborted) {
          next = Date.now() + 24 * 60 * 60 * 1000
          arm()
        } else {
          timers.delete(entry)
        }
      }, delay)
      if (typeof timer.unref === 'function') timer.unref()
    }
    arm()
    timers.add(entry)
    remember(entry.stop)
    return entry
  }

  async function httpFetch(url, options = {}) {
    requireScope('net.outbound', 'ctx.http.fetch')
    const target = String(url || '')
    if (!/^https?:\/\//i.test(target)) throw new Error('ctx.http.fetch 只允许 http/https')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || 20000))
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      return await fetch(target, { ...options, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }

  async function send(chatKey, segments, options = {}) {
    requireScope('qq.send', 'ctx.send')
    const blocked = host.runHooks ? host.runHooks('before-send', { chatKey, segments }) : undefined
    if (blocked && blocked.block === true) {
      return { ok: false, reason: 'blocked-by-hook', sent: [], failed: [{ reason: blocked.reason || 'blocked' }] }
    }
    let body = segments
    const prefix = host.rolePrefix ? host.rolePrefix() : ''
    if (prefix) {
      const list = Array.isArray(segments) ? segments.slice() : [segments]
      const firstText = list.findIndex((seg) => (typeof seg === 'string') || (seg && seg.type === 'text'))
      if (firstText >= 0) {
        const seg = list[firstText]
        if (typeof seg === 'string') list[firstText] = `${prefix}：${seg}`
        else list[firstText] = { ...seg, text: `${prefix}：${seg.text ?? ''}` }
        body = list
      }
    }
    return host.qq.send(chatKey, body, { ...options, signal: host.signal })
  }

  const hooks = {
    on(name, fn) {
      const key = String(name)
      if (key === 'message.in' || key === 'message.out') {
        return remember(host.bus.on(key, fn, extId))
      }
      if (!SUPPORTED_HOOKS.has(key)) {
        log.warn(`钩子 ${key} 在当前适配器里没有触发点，已忽略`)
        return () => {}
      }
      return remember(host.registerHook(extId, key, fn))
    },
  }

  const lifecycle = {
    signal: host.signal,
    onStop(fn) {
      return remember(fn)
    },
  }

  const permissionsApi = {
    status(scope) {
      const key = scopeOf(scope)
      return allowed(key)
        ? { decision: 'allow' }
        : { decision: 'deny', reason: `manifest.permissions 未声明 ${key}` }
    },
    async request(scope) {
      const status = permissionsApi.status(scope)
      if (status.decision !== 'allow') log.warn(`扩展请求了未声明的权限：${scope}`)
      return status
    },
  }

  const ui = {
    panel: {
      async register() {
        throw new Error('DSH 适配器暂不支持 QQ Agent 的自有面板（ui.panel）')
      },
    },
  }

  const events = {
    on: onEvent,
    emit(name, payload) {
      // QQ Agent 也把普通自定义事件当作非公共总线；扩展间通信请用 capability。
      log.warn(`events.emit(${String(name)}) 在 DSH 适配器里不开放；请用 registerCapability`)
      return 0
    },
  }

  const zeroFourApi = {
    registerTool,
    config,
    isSkillActive,
    capability,
    hasCapability,
    log,
    warn: log.warn,
    error: log.error,
    fetch: (url, init) => {
      if (!allowed('net.outbound')) return Promise.reject(new Error(`扩展 ${extId} 没有声明 net.outbound/web_fetch 权限`))
      return httpFetch(url, init)
    },
    utils: {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
      safeJsonParse: (value, fallback = null) => {
        try { return JSON.parse(value) } catch { return fallback }
      },
    },
  }

  const ctx = {
    id: extId,
    kind: String(manifest.kind || 'plugin'),
    bundled: false,
    log,
    config,
    storage,
    registerTool,
    unregisterTool,
    registerCapability,
    unregisterCapability,
    capability,
    hasCapability,
    requireCapability,
    isSkillActive,
    hooks,
    prompt: { add: promptAdd },
    scheduler: { every: scheduleEvery, at: scheduleAt },
    events,
    http: { fetch: httpFetch },
    send,
    // 0.4 常见别名
    fetch: zeroFourApi.fetch,
    utils: zeroFourApi.utils,
    lifecycle,
    permissions: permissionsApi,
    ui,
    registerTransport() {
      throw new Error('DSH 适配器不实现 managed transport.provider；QQ 传输由 dsh-qq-bridge 负责')
    },
  }

  // 0.4 旧入口把 ctx 直接当 api 用：log/config 已经做成「函数 + 方法」双形态，
  // 这里再补上 warn/error 顶层别名。
  ctx.warn = log.warn
  ctx.error = log.error

  const legacyApi = zeroFourApi

  function dispose() {
    for (const entry of [...timers]) {
      try { entry.stop() } catch {}
    }
    timers.clear()
    for (const disposer of [...disposers].reverse()) {
      try { disposer() } catch {}
    }
    disposers.clear()
    tools.clear()
  }

  return { ctx, legacyApi, dispose, tools, extId, permissions, allowed, buildExecution }
}

export { MAX_TOOL_NAME }
