// 扩展发现 / 加载 / 卸载 / 工具与提示词注册。
//
// 兼容两代 QQ Agent 扩展：
//   0.5 原生：export default { setup(ctx) }，ctx.registerTool({ params, handler })
//   0.4 旧版：export default { setup(api) }，api.registerTool({ parameters, execute(ctx,args) })
// 两代都用同一个 callable ctx（log/config 做成「函数 + 方法」双形态）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSdk } from './sdk.mjs'
import { STORAGE_ROOT } from './paths.mjs'
import { ensureDir, fileMtime, oneLine, readJson, sanitizeId } from './util.mjs'
import { version as adapterVersion } from './version.mjs'

const MANIFEST_NAMES = ['skill.json', 'plugin.json']
const MAX_TOOL_NAME = 64
const MAX_PROMPT_CHARS = 20000

function importModule(file) {
  const url = pathToFileURL(file).href + '?t=' + Math.round(fileMtime(file))
  return import(url)
}

function readManifest(dir) {
  for (const name of MANIFEST_NAMES) {
    const file = join(dir, name)
    try {
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      const raw = JSON.parse(text)
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return { raw, file, name }
      }
      return { error: `${name} 不是对象`, file, name }
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      return { error: `${name} 解析失败：${error.message}`, file, name }
    }
  }
  return { error: '缺少 skill.json / plugin.json' }
}

function normalizeManifest(raw, dir) {
  const id = String(raw.id || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`扩展 id 不合法：${id || '(空)'}`)
  const kind = raw.kind === 'skill' ? 'skill' : 'plugin'
  const apiVersion = raw.apiVersion === undefined ? 1 : Number(raw.apiVersion)
  if (!Number.isFinite(apiVersion) || apiVersion < 0 || apiVersion > 1) {
    throw new Error(`不支持的 apiVersion：${raw.apiVersion}（适配器支持 0 / 1）`)
  }
  const legacy = apiVersion === 0
    || String(raw.compat || '') === '04'
    || raw.compat04 === true
    || String(raw.legacyApi || '') === '0.4'
  const entry = String(raw.entry || 'index.js')
  const entryPath = resolve(dir, entry)
  if (!entryPath.startsWith(resolve(dir) + sep) && entryPath !== resolve(dir)) {
    throw new Error(`entry 越过了扩展目录：${entry}`)
  }
  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.map((x) => String(x)).filter(Boolean)
    : []
  const requires = Array.isArray(raw.requires) ? raw.requires.map((x) => String(x)).filter(Boolean) : []
  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? raw.settings
    : {}
  return {
    id,
    name: String(raw.name || id),
    version: String(raw.version || '0.0.0'),
    description: String(raw.description || ''),
    kind,
    apiVersion,
    legacy,
    entry,
    entryPath,
    enabledByDefault: raw.enabledByDefault !== false,
    permissions,
    requires,
    settings,
    configSchema: raw.configSchema && typeof raw.configSchema === 'object' ? raw.configSchema : {},
    author: String(raw.author || ''),
    prompt: raw.prompt && typeof raw.prompt === 'object' ? raw.prompt : null,
    raw,
  }
}

function legacyPromptText(manifest) {
  const prompt = manifest.prompt
  if (!prompt || typeof prompt !== 'object') return []
  if (Array.isArray(prompt.sections)) {
    return prompt.sections
      .filter((section) => section && typeof section.content === 'string')
      .map((section, index) => ({
        id: String(section.id || `manifest-${index}`),
        title: String(section.title || ''),
        priority: Number(section.priority) || 50,
        content: section.content,
      }))
  }
  // 0.4 的 { when, examples, instruction } 形态
  const lines = []
  if (prompt.when) lines.push(`何时使用：${String(prompt.when).trim()}`)
  if (Array.isArray(prompt.examples) && prompt.examples.length) {
    lines.push(`示例：${prompt.examples.map((x) => String(x || '').trim()).filter(Boolean).join(' / ')}`)
  }
  if (prompt.instruction) lines.push(String(prompt.instruction).trim())
  if (!lines.length) return []
  return [{ id: 'legacy', title: String(manifest.name || ''), priority: 50, content: lines.join('\n') }]
}

export function createLoader({
  configStore,
  bus,
  qq,
  roles,
  stickers,
  logger,
  dshTools,
  defaultChatKey,
}) {
  const extensions = new Map()
  const capabilities = new Map()
  const hooks = new Map()
  const promptSections = new Map()
  const usedToolNames = new Set()
  const toolDisposers = new Map()
  const logs = []
  const toolCatalog = []
  let loading = null

  function logLine(text, level = 'info') {
    const line = { at: Date.now(), level, text: String(text) }
    logs.push(line)
    if (logs.length > 500) logs.shift()
    try { logger?.[level]?.(`fish-world: ${line.text}`) } catch {}
  }

  function defaultSettingsFor(manifest) {
    return configStore.settingsOf(manifest.id, manifest.settings)
  }

  function makeHost(manifest, dir, sdkRef) {
    return {
      logger: {
        info: (...args) => logLine(`[${manifest.id}] ` + args.join(' '), 'info'),
        warn: (...args) => logLine(`[${manifest.id}] ` + args.join(' '), 'warn'),
        error: (...args) => logLine(`[${manifest.id}] ` + args.join(' '), 'error'),
        debug: (...args) => logLine(`[${manifest.id}] ` + args.join(' '), 'debug'),
      },
      settings: () => defaultSettingsFor(manifest),
      onSettingsChange: (fn) => configStore.onSettingsChange(manifest.id, () => {
        try { fn(defaultSettingsFor(manifest)) } catch {}
      }),
      storageDir: ensureDir(join(STORAGE_ROOT, manifest.id)),
      storage: () => configStore.storageOf(manifest.id),
      persistStorage: () => configStore.flushStorage(),
      bus,
      qq,
      roles,
      signal: sdkRef.signal,
      defaultChatKey,
      rolePrefix: () => {
        if (configStore.getConfig().fish?.rolePrefix !== true) return ''
        try { return roles.current().name || '' } catch { return '' }
      },
      listChats,
      isActive: (id) => extensions.get(String(id))?.status === 'loaded',
      registerTool: (def) => registerTool(manifest, def),
      unregisterTool,
      registerPrompt,
      registerCapability,
      unregisterCapability,
      capability: (name, ...args) => callCapability(name, ...args),
      hasCapability,
      builtinCapability: (name) => builtinCapability(name, manifest),
      registerHook,
      runHooks: (name, payload) => runHooks(name, manifest.id, payload),
      unsupported: (name) => {
        throw new Error(`${name} 在 DSH 适配器里没有对应实现`)
      },
    }
  }

  // ---------- 能力 ----------

  function registerCapability(name, provider, options = {}, owner = '') {
    const key = String(name || '')
    if (!key) throw new Error('能力名不能为空')
    if (!provider || (typeof provider !== 'function' && typeof provider !== 'object')) {
      throw new Error(`能力 ${key} 的 provider 必须是函数或对象`)
    }
    let list = capabilities.get(key)
    if (!list) capabilities.set(key, (list = []))
    list.push({ provider, owner, options: options || {}, order: list.length })
    return () => {
      const current = capabilities.get(key)
      if (!current) return
      const index = current.findIndex((item) => item.provider === provider && item.owner === owner)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) capabilities.delete(key)
    }
  }

  function unregisterCapability(name, owner) {
    const key = String(name || '')
    const list = capabilities.get(key)
    if (!list) return false
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].owner === owner) list.splice(i, 1)
    if (list.length === 0) capabilities.delete(key)
    return true
  }

  function pickProvider(name) {
    const list = capabilities.get(String(name || ''))
    if (!list || !list.length) return undefined
    const active = list.filter((item) => item.options?.default !== true)
    const pool = active.length ? active : list
    return pool[pool.length - 1].provider
  }

  function callCapability(name, ...args) {
    const provider = pickProvider(name)
    if (provider === undefined) return undefined
    if (typeof provider === 'function') return provider(...args)
    return provider
  }

  function hasCapability(name) {
    return pickProvider(name) !== undefined
  }

  function builtinCapability(name, manifest) {
    const key = String(name || '')
    if (key === 'core.send') {
      return {
        sendTextBatch: (chatKey, texts, options) => qq.sendTextBatch(chatKey, texts, options),
        sendImage: (chatKey, image, options) => qq.sendImage(chatKey, image, options),
        sendSegments: (chatKey, segments, options) => qq.send(chatKey, segments, options),
        sendSticker: (chatKey, sticker, options) => qq.sendSticker(chatKey, sticker, options),
        poke: (chatKey, target) => qq.poke(chatKey, target),
      }
    }
    if (key === 'data.messages') {
      return {
        recent: async (chatKey, n) => {
          const result = await qq.recent(chatKey || defaultChatKey(), n)
          return result.ok ? result.messages : []
        },
        listChats,
      }
    }
    if (key === 'data.stickers') {
      return {
        all: () => [],
        list: () => [],
        get: () => null,
      }
    }
    if (key === 'fish.stickers') {
      return stickers ? {
        all: () => stickers.list().map((item) => stickers.toView(item)),
        list: () => stickers.list().map((item) => stickers.toView(item)),
        get: (id) => { const item = stickers.get(id); return item ? stickers.toView(item) : null },
        byTag: (tag) => stickers.byTag(tag).map((item) => stickers.toView(item)),
        search: (query) => stickers.search(query).map((item) => stickers.toView(item)),
        collect: (source, opts) => stickers.add(source, opts || {}),
        send: (chatKey, id, opts) => stickers.send(qq, chatKey, id, opts || {}),
      } : undefined
    }
    if (key === 'host.environment') {
      return { version: adapterVersion, profile: process.env.DSH_PROFILE || 'desktop' }
    }
    if (key === 'host.config') {
      return {
        get: () => defaultSettingsFor(manifest),
        onChange: (fn) => configStore.onConfigChange((cfg) => {
          try { fn(defaultSettingsFor(manifest), cfg) } catch {}
        }),
      }
    }
    if (key === 'extensions.state') {
      return {
        isActive: (id) => extensions.get(String(id))?.status === 'loaded',
        isEnabled: (id) => configStore.isEnabled(String(id), extensions.get(String(id))?.manifest?.enabledByDefault),
      }
    }
    if (key === 'tools.catalog') {
      return { list: () => toolCatalog.slice() }
    }
    if (key === 'fish.role') return { get: () => roles.current() }
    if (key === 'bridge.state') return { get: () => qq.snapshot() }
    return undefined
  }

  // ---------- 工具 ----------

  function uniqueToolName(extId, toolId) {
    const prefix = sanitizeId(extId, 'ext').slice(0, 16)
    const tail = sanitizeId(toolId, 'tool').slice(0, 40)
    let base = `qce_${prefix}_${tail}`.slice(0, MAX_TOOL_NAME - 3)
    let name = base
    let n = 2
    while (usedToolNames.has(name)) {
      name = `${base}_${n}`.slice(0, MAX_TOOL_NAME)
      n += 1
      if (n > 999) break
    }
    usedToolNames.add(name)
    return name
  }

  function registerTool(manifest, def) {
    const name = uniqueToolName(manifest.id, def.toolId)
    const tool = {
      name,
      description: oneLine(`${def.description}${def.extId ? `（来自扩展 ${def.extId}）` : ''}`, 900),
      parameters: def.parameters,
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            content: { type: 'string' },
            error: { type: 'string' },
            result: { type: 'object', additionalProperties: true, properties: {} },
          },
        },
        render: (_args, value) => {
          const text = value && typeof value === 'object'
            ? (typeof value.content === 'string' ? value.content : JSON.stringify(value.result ?? value, null, 2))
            : String(value ?? '')
          return [{ type: 'text', text }]
        },
      },
      async execute(args) {
        const blocked = runHooks('before-tool', manifest.id, {
          toolName: name, argsRaw: JSON.stringify(args ?? {}), args, pluginId: manifest.id,
        })
        if (blocked && blocked.block === true) {
          return { ok: false, content: `被扩展钩子拦截：${blocked.reason || '未说明原因'}`, error: 'blocked-by-hook' }
        }
        const result = await def.run(args)
        runHooks('after-tool', manifest.id, { toolName: name, argsRaw: JSON.stringify(args ?? {}), args, result })
        return result
      },
    }
    let dispose = () => {}
    try {
      const returned = dshTools.register(tool)
      if (typeof returned === 'function') dispose = returned
      else if (returned && typeof returned.dispose === 'function') dispose = () => returned.dispose()
      toolCatalog.push({ name, description: tool.description, extension: manifest.id })
      toolDisposers.set(name, { owner: manifest.id, dispose })
      const record = extensions.get(manifest.id)
      if (record) record.tools = [...(record.tools || []), name]
      logLine(`注册工具 ${name}（${manifest.id}）`)
    } catch (error) {
      usedToolNames.delete(name)
      throw error
    }
    return name
  }

  function unregisterTool(name) {
    const entry = toolDisposers.get(String(name))
    if (!entry) return false
    toolDisposers.delete(String(name))
    usedToolNames.delete(String(name))
    const index = toolCatalog.findIndex((item) => item.name === String(name))
    if (index >= 0) toolCatalog.splice(index, 1)
    try { entry.dispose() } catch (error) { logLine(`卸载工具 ${name} 失败：${error.message}`, 'warn') }
    return true
  }

  // ---------- 钩子 / 提示词 ----------

  function registerHook(owner, name, fn) {
    const key = String(name || '')
    if (typeof fn !== 'function') return () => {}
    let list = hooks.get(key)
    if (!list) hooks.set(key, (list = []))
    const entry = { owner, fn }
    list.push(entry)
    return () => {
      const current = hooks.get(key)
      if (!current) return
      const index = current.indexOf(entry)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) hooks.delete(key)
    }
  }

  function runHooks(name, owner, payload) {
    const list = hooks.get(String(name))
    if (!list || !list.length) return undefined
    let last
    for (const entry of [...list]) {
      if (owner && entry.owner !== owner) continue
      try { last = entry.fn(payload) } catch (error) { logLine(`钩子 ${name} 失败：${error.message}`, 'warn') }
    }
    return last
  }

  function registerPrompt(owner, section) {
    let map = promptSections.get(owner)
    if (!map) promptSections.set(owner, (map = new Map()))
    map.set(String(section.id), section)
    return () => {
      const current = promptSections.get(owner)
      if (!current) return
      current.delete(String(section.id))
      if (current.size === 0) promptSections.delete(owner)
    }
  }

  function promptText() {
    const all = []
    for (const [owner, map] of promptSections) {
      if (extensions.get(owner)?.status !== 'loaded') continue
      for (const section of map.values()) all.push({ owner, ...section })
    }
    all.sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id).localeCompare(String(b.id)))
    const parts = []
    for (const section of all) {
      let text = section.content || ''
      if (section.render) {
        try { text = String(section.render({}) || '') } catch (error) { logLine(`提示词 ${section.id} 渲染失败：${error.message}`, 'warn') }
      }
      if (!text.trim()) continue
      const title = section.title ? `### ${section.title}\n` : ''
      parts.push(`${title}${text.trim()}`)
    }
    return parts.join('\n\n').slice(0, MAX_PROMPT_CHARS)
  }

  // ---------- 发现 / 加载 ----------

  function discover() {
    const cfg = configStore.getConfig()
    const dirs = Array.isArray(cfg.extensionDirs) ? cfg.extensionDirs : []
    const found = []
    const seen = new Set()
    for (const root of dirs) {
      let entries = []
      try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
        const dir = join(root, entry.name)
        if (seen.has(resolve(dir))) continue
        seen.add(resolve(dir))
        const got = readManifest(dir)
        if (got.error) {
          found.push({ dir, error: got.error, dirName: entry.name })
          continue
        }
        try {
          const manifest = normalizeManifest(got.raw, dir)
          found.push({ dir, manifestPath: got.file, manifest, dirName: entry.name, error: '' })
        } catch (error) {
          found.push({ dir, error: error.message, dirName: entry.name })
        }
      }
    }
    return found
  }

  async function loadEntry(entry) {
    const manifest = entry.manifest
    const id = manifest.id
    if (!manifest.entryPath || !statSyncSafe(manifest.entryPath)) {
      throw new Error(`入口文件不存在：${manifest.entry}`)
    }
    const missing = manifest.requires.filter((name) => builtinCapability(name, manifest) === undefined && !hasCapability(name))
    if (missing.length) {
      const error = `缺少硬依赖能力：${missing.join(', ')}`
      const record = {
        id, manifest, dir: entry.dir, manifestPath: entry.manifestPath,
        status: 'blocked', error, tools: [], loadedAt: null,
      }
      extensions.set(id, record)
      logLine(`${id} 未激活：${error}`, 'warn')
      return record
    }

    const controller = new AbortController()
    const sdkRef = { signal: controller.signal }
    const host = makeHost(manifest, entry.dir, sdkRef)
    const sdk = createSdk({ manifest, dir: entry.dir, host })
    const record = {
      id,
      manifest,
      dir: entry.dir,
      manifestPath: entry.manifestPath,
      status: 'loading',
      error: '',
      tools: [],
      loadedAt: null,
      sdk,
      controller,
    }
    extensions.set(id, record)

    // 清单里的静态 prompt 片段先登记（0.4 的 when/instruction 也在这里转换）。
    for (const section of legacyPromptText(manifest)) registerPrompt(id, section)

    try {
      const mod = await importModule(manifest.entryPath)
      const impl = mod.default && typeof mod.default === 'object' ? mod.default : mod
      const setup = impl.setup || impl.register
      if (typeof setup !== 'function' && !impl.providers && !impl.hooks && typeof impl.activate !== 'function') {
        throw new Error('入口没有导出 setup/register/providers/hooks/activate')
      }
      if (impl.providers && typeof impl.providers === 'object') {
        for (const [name, provider] of Object.entries(impl.providers)) {
          registerCapability(name, provider, {}, id)
        }
      }
      if (impl.hooks && typeof impl.hooks === 'object') {
        for (const [name, declared] of Object.entries(impl.hooks)) {
          for (const fn of Array.isArray(declared) ? declared : [declared]) registerHook(id, name, fn)
        }
      }
      if (typeof setup === 'function') await setup.call(impl, sdk.ctx)
      if (typeof impl.activate === 'function') await impl.activate.call(impl, sdk.ctx)
      record.impl = impl
      record.status = 'loaded'
      record.loadedAt = Date.now()
      bus.emit('plugin.loaded', { id, kind: manifest.kind, name: manifest.name })
      logLine(`已加载 ${id}@${manifest.version}（${manifest.kind}）`)
    } catch (error) {
      record.status = 'error'
      record.error = String(error && error.message ? error.message : error)
      logLine(`${id} 加载失败：${record.error}`, 'error')
      bus.emit('adapter.error', { id, error: record.error })
      try { sdk.dispose() } catch {}
      record.tools = []
    }
    return record
  }

  function statSyncSafe(file) {
    try { return statSync(file).isFile() } catch { return false }
  }

  async function unload(id) {
    const record = extensions.get(String(id))
    if (!record) return false
    try { record.sdk?.ctx?.lifecycle?.signal?.throwIfAborted?.() } catch {}
    try { record.controller?.abort() } catch {}
    const impl = record.impl
    try { if (impl && typeof impl.deactivate === 'function') await impl.deactivate.call(impl) } catch (error) {
      logLine(`${id} deactivate 失败：${error.message}`, 'warn')
    }
    try { if (impl && typeof impl.dispose === 'function') await impl.dispose.call(impl) } catch (error) {
      logLine(`${id} dispose 失败：${error.message}`, 'warn')
    }
    try { record.sdk?.dispose() } catch (error) {
      logLine(`${id} 清理失败：${error.message}`, 'warn')
    }
    for (const name of [...toolDisposers.keys()]) {
      const entry = toolDisposers.get(name)
      if (entry && entry.owner === id) unregisterTool(name)
    }
    for (const [key, list] of capabilities) {
      for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].owner === id) list.splice(i, 1)
      if (list.length === 0) capabilities.delete(key)
    }
    for (const [key, list] of hooks) {
      for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].owner === id) list.splice(i, 1)
      if (list.length === 0) hooks.delete(key)
    }
    promptSections.delete(id)
    extensions.delete(String(id))
    bus.emit('plugin.unloaded', { id: String(id) })
    logLine(`已卸载 ${id}`)
    return true
  }

  async function unloadAll() {
    for (const id of [...extensions.keys()]) await unload(id)
    return true
  }

  async function reload() {    if (loading) return loading
    loading = (async () => {
      for (const id of [...extensions.keys()]) await unload(id)
      const found = discover()
      const list = []
      for (const entry of found) {
        if (entry.error) {
          list.push({ id: entry.dirName, status: 'error', error: entry.error, dir: entry.dir })
          extensions.set(entry.dirName, {
            id: entry.dirName,
            manifest: { id: entry.dirName, name: entry.dirName, version: '', kind: 'plugin', permissions: [], requires: [] },
            dir: entry.dir,
            manifestPath: '',
            status: 'error',
            error: entry.error,
            tools: [],
            loadedAt: null,
          })
          logLine(`${entry.dirName} 清单不可用：${entry.error}`, 'warn')
          continue
        }
        const enabled = configStore.isEnabled(entry.manifest.id, entry.manifest.enabledByDefault)
        if (!enabled) {
          extensions.set(entry.manifest.id, {
            id: entry.manifest.id,
            manifest: entry.manifest,
            dir: entry.dir,
            manifestPath: entry.manifestPath,
            status: 'disabled',
            error: '',
            tools: [],
            loadedAt: null,
          })
          continue
        }
        try {
          const record = await loadEntry(entry)
          list.push(record)
        } catch (error) {
          list.push({ id: entry.manifest.id, status: 'error', error: String(error && error.message ? error.message : error) })
          logLine(`${entry.manifest.id} 加载失败：${error.message}`, 'error')
        }
      }
      adapterReady = true
      bus.emit('adapter.ready', { at: Date.now(), extensions: list.length })
      bus.emit('server.ready', { at: Date.now() })
      return list
    })().finally(() => { loading = null })
    return loading
  }

  let adapterReady = false

  function disabledRecord(entry) {
    return {
      id: entry.manifest.id,
      manifest: entry.manifest,
      dir: entry.dir,
      manifestPath: entry.manifestPath,
      status: 'disabled',
      error: '',
      tools: [],
      loadedAt: null,
    }
  }

  async function setEnabled(id, value) {
    const key = String(id)
    const entry = discover().find((item) => item.manifest?.id === key)
    if (!entry) throw new Error(`没有找到扩展：${key}`)
    if (entry.error) throw new Error(entry.error)
    configStore.setEnabled(key, value === true)

    const current = extensions.get(key)
    if (current?.status === 'loaded' || current?.status === 'blocked' || current?.status === 'error') {
      await unload(key)
    } else if (current) {
      extensions.delete(key)
    }

    if (value !== true) {
      const record = disabledRecord(entry)
      extensions.set(key, record)
      return record
    }
    const record = await loadEntry(entry)
    return record
  }

  async function reloadOne(id) {
    const key = String(id)
    const entry = discover().find((item) => item.manifest?.id === key)
    if (!entry) throw new Error(`没有找到扩展：${key}`)
    const enabled = configStore.isEnabled(key, entry.manifest.enabledByDefault)
    const current = extensions.get(key)
    if (current && current.status === 'loaded') await unload(key)
    else if (current) extensions.delete(key)
    const record = enabled ? await loadEntry(entry) : disabledRecord(entry)
    extensions.set(key, record)
    return record
  }

  /** 将刚下载到本地、尚未执行的新扩展登记为 disabled。 */
  function refreshInstalled() {
    const added = []
    for (const entry of discover()) {
      if (!entry.manifest || extensions.has(entry.manifest.id)) continue
      const record = disabledRecord(entry)
      extensions.set(record.id, record)
      added.push(record.id)
    }
    return { added, extensions: list() }
  }

  function detail(id) {
    const record = extensions.get(String(id))
    if (!record?.manifest) return null
    const manifest = record.manifest
    const schema = manifest.configSchema && typeof manifest.configSchema === 'object' ? manifest.configSchema : {}
    const values = configStore.settingsOf(manifest.id, manifest.settings)
    const settings = {}
    const hasSecrets = {}
    for (const [key, field] of Object.entries(schema)) {
      const value = values[key]
      if (field?.secret === true) {
        hasSecrets[key] = typeof value === 'string' && value.length > 0
        settings[key] = ''
      } else if (value !== undefined) {
        settings[key] = value
      }
    }
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      description: manifest.description,
      status: record.status,
      error: record.error || '',
      enabled: configStore.isEnabled(manifest.id, manifest.enabledByDefault),
      enabledByDefault: manifest.enabledByDefault,
      permissions: manifest.permissions || [],
      requires: manifest.requires || [],
      configSchema: schema,
      settings,
      hasSecrets,
      tools: record.tools || [],
    }
  }

  function saveExtensionSettings(id, patch, clearSecrets = []) {
    const record = extensions.get(String(id))
    if (!record?.manifest) throw new Error(`没有找到扩展：${id}`)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象')
    if (!Array.isArray(clearSecrets)) throw new Error('clearSecrets 必须是数组')
    const schema = record.manifest.configSchema || {}
    const safePatch = {}
    const clear = new Set(clearSecrets.map(String))
    for (const key of clear) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`设置键无效：${key}`)
      if (!schema[key] || schema[key].secret !== true) throw new Error(`不能清除未声明的密钥设置：${key}`)
    }
    for (const [key, value] of Object.entries(patch)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`设置键无效：${key}`)
      const field = schema[key]
      if (!field || typeof field !== 'object') throw new Error(`设置未在 configSchema 声明：${key}`)
      if (clear.has(key)) throw new Error(`设置 ${key} 不能同时保存和清除`)
      if (field.secret === true && (value === '' || value == null)) continue
      const type = field.type || 'string'
      const valid = type === 'string' ? typeof value === 'string'
        : type === 'boolean' ? typeof value === 'boolean'
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : type === 'integer' ? Number.isInteger(value)
              : type === 'array' ? Array.isArray(value)
                : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
                  : false
      if (!valid) throw new Error(`${key} 类型应为 ${type}`)
      if (Array.isArray(field.enum) && !field.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
        throw new Error(`${key} 不在允许选项中`)
      }
      if (typeof value === 'number') {
        if (Number.isFinite(field.minimum) && value < field.minimum) throw new Error(`${key} 不能小于 ${field.minimum}`)
        if (Number.isFinite(field.maximum) && value > field.maximum) throw new Error(`${key} 不能大于 ${field.maximum}`)
      }
      if (typeof value === 'string') {
        if (Number.isFinite(field.minLength) && value.length < field.minLength) throw new Error(`${key} 长度不足`)
        if (Number.isFinite(field.maxLength) && value.length > field.maxLength) throw new Error(`${key} 长度超限`)
      }
      const serialized = JSON.stringify(value)
      if (serialized.length > 64 * 1024) throw new Error(`${key} 设置过大`)
      safePatch[key] = value
    }
    if (Object.keys(safePatch).length) configStore.saveSettings(record.manifest.id, safePatch)
    if (clear.size) configStore.clearSettings(record.manifest.id, [...clear])
    return detail(record.manifest.id)
  }

  function list() {
    return [...extensions.values()].map((record) => ({
      id: record.id,
      name: record.manifest?.name || record.id,
      version: record.manifest?.version || '',
      kind: record.manifest?.kind || '',
      status: record.status,
      enabled: record.manifest ? configStore.isEnabled(record.id, record.manifest.enabledByDefault) : false,
      error: record.error || '',
      dir: record.dir || '',
      description: record.manifest?.description || '',
      permissions: record.manifest?.permissions || [],
      requires: record.manifest?.requires || [],
      tools: record.tools || [],
      loadedAt: record.loadedAt || null,
    }))
  }

  function listChats() {
    const bridge = qq.snapshot()
    const chats = []
    if (bridge.privateQQ) chats.push({ chatKey: `private:${bridge.privateQQ}`, kind: 'private', id: bridge.privateQQ, name: 'QQ 私聊', lastActive: 0, lastText: '', unread: 0, count: 0 })
    if (bridge.group) chats.push({ chatKey: `group:${bridge.group}`, kind: 'group', id: bridge.group, name: 'QQ 群', lastActive: 0, lastText: '', unread: 0, count: 0 })
    return chats
  }

  async function status() {
    return {
      ok: true,
      ready: adapterReady,
      version: adapterVersion,
      extensions: list(),
      tools: toolCatalog.slice(),
      capabilities: [...capabilities.keys()],
      bridge: qq.snapshot(),
      roles: roles.summary(),
      logs: logs.slice(-80),
    }
  }

  return {
    discover,
    reload,
    unload,
    unloadAll,
    list,
    status,
    promptText,
    getVersion: () => adapterVersion,
    promptSectionCount: () => [...promptSections.values()].reduce((n, map) => n + map.size, 0),
    get: (id) => extensions.get(String(id)),
    setEnabled,
    reloadOne,
    refreshInstalled,
    detail,
    saveExtensionSettings,
    listChats,
    builtinCapability,
    callCapability,
    hasCapability,
    registerTool,
    unregisterTool,
    registerHook,
    runHooks,
    registerPrompt,
    toolDisposers,
    toolCatalog,
    isReady: () => adapterReady,
  }
}
