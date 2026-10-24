import { isAbsolute, join } from 'node:path'
import {
  FISH_WORLD_CONFIG,
  FISH_WORLD_STATE,
  DEFAULT_PLUGIN_DIR,
  DEFAULT_SKILL_DIR,
  DSH_HOME,
} from './paths.mjs'
import { clampNumber, mergePatch, readJson, writeJson } from './util.mjs'
import { normalizeAllPlatforms } from './platforms.mjs'
import { normalizeAstrbot } from './astrbot.mjs'

/** 存储根目录只接受绝对路径：相对路径会随 cwd 漂移，宁可退回默认位置。 */
function isAbsolutePath(value) {
  const text = String(value == null ? '' : value).trim()
  return Boolean(text) && isAbsolute(text)
}

export const DEFAULT_CONFIG = {
  enabled: true,
  // 扫描目录。默认放在 $DSH_HOME/plugin-ecosystem 下，和 QQ Agent 的
  // skills/ plugins/ 目录语义保持一致。
  extensionDirs: [DEFAULT_SKILL_DIR, DEFAULT_PLUGIN_DIR],
  // 新扩展默认是否跟着清单里的 enabledByDefault 走。
  loadEnabledByDefault: true,
  // 即使清单 enabledByDefault=true，也强制先禁用（更安全的策略，默认关）。
  forceDisabledByDefault: false,
  qq: {
    enabled: true,
    // 跟随 dsh-qq-bridge 的「总开关 / 试运行 / 转私聊 / 转群」。
    respectBridgeSwitches: true,
    // 适配器自己的试运行：true = 只记账，不发给 OneBot。
    dryRun: false,
    // 允许扩展发到 bridge 配置之外的 QQ 号 / 群（默认禁止）。
    allowForeignTargets: false,
    // 单次发送超时。
    timeoutMs: 15000,
  },
  whale: {
    enabled: true,
    // 发 QQ 时是否加「角色名：」前缀。
    rolePrefix: false,
    // 当前角色；auto = 用 whale 挂件里置顶/最新的角色。
    role: 'auto',
    // 把 whale 的内置/自定义表情图暴露给扩展。
    exposeStickers: true,
    // 是否把「当前外显角色」写进 DSH 系统提示词（默认关，避免覆盖宿主原人格）。
    injectPersona: false,
  },
  // 鱼的基础设定：名字、对主人的称呼、外显角色卡。
  fish: {
    // 鱼的名字；空字符串表示沿用角色卡里的名字。
    name: '',
    // 鱼怎么称呼主人。
    ownerTitle: '主人',
    // 角色卡 id；auto = 跟随 whale 置顶/最新角色。
    persona: 'auto',
  },
  // 三个外部平台的独立开关与额度。全部默认关闭：需主人在面板里逐项打开。
  platforms: {
    qq: {
      enabled: false,
      readHistory: false,
      sendMessage: false,
      qzoneEnabled: false,
      dailyMessages: 20,
      dailyQzonePosts: 2,
    },
    bili: {
      enabled: false,
      watchEnabled: false,
      dailyWatchLimit: 3,
      allowComment: false,
      allowFavorite: false,
      allowLike: false,
      dailyCommentLimit: 3,
      dailyLikeLimit: 10,
    },
    douyin: {
      enabled: false,
      watchEnabled: false,
      minutesPerRound: 10,
      dailyRounds: 2,
      silentWatch: false,
      allowShare: false,
      allowGreeting: false,
      allowReply: false,
      allowComment: false,
      dailyShareLimit: 3,
      dailyCommentLimit: 3,
      autoStart: false,
    },
  },
  // 存储位置：空字符串表示跟随工作区（没绑定工作区时落到桌面的「鱼的世界」）。
  // 主人在面板里「选择目录」后写入这里，所有收藏与平台记录都存到这个根目录下。
  // gallery / sites 可单独指定；留空就从 root 推导（鱼的收藏/1 图库、2 网站链接）。
  storage: {
    root: '',
    gallery: '',
    sites: '',
  },
  stickers: {
    enabled: true,
    // 每小时最多收藏几张表情；由主人在设置面板中调整。
    hourlyLimit: 5,
  },
  // 链接收藏（资源链接）的额度。
  linkLibrary: {
    enabled: true,
    hourlyLimit: 10,
  },
  // 发言 API 的非敏感部分。密钥单独存在 fish-world-voice.json，不进这里。
  voice: {
    enabled: false,
    baseUrl: '',
    model: '',
    temperature: 0.9,
    maxTokens: 400,
    timeoutMs: 30000,
    scenarios: { chat: true, comment: true, diary: false, greeting: false },
    stylePrompt: '',
  },
  tts: {
    // TTS is opt-in; an explicit true is the user's choice to enable autoplay.
    auto: false,
  },
  // AstrBot 接入的非敏感部分。token 单独存在 fish-world-astrbot.json，不进这里。
  astrbot: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:6210',
    // 把 AstrBot 当鱼的 QQ 通道（走它的 OneBot 适配器）。
    useForQQ: false,
    // 借用 AstrBot 的 Agent 与插件工具。默认关：会真的执行别人的插件。
    borrowTools: false,
    ownerUmo: '',
    timeoutMs: 15000,
    pollMs: 3000,
  },
  qzone: {
    enabled: true,
    postsPerDay: 2,
    likesPerDay: 2,
    commentsPerDay: 2,
    repliesPerDay: 2,
    maxPostChars: 500,
    maxCommentChars: 200,
    maxFeeds: 10,
  },
  prompt: {
    enabled: true,
    // 扩展 prompt 片段插在系统提示词的最后（避免破坏前缀缓存）。
    order: 89990,
  },
  logLimit: 200,
}

export const DEFAULT_STATE = {
  version: 1,
  enabled: {},
  settings: {},
  storage: {},
  updatedAt: null,
}

// 发言 API 的非敏感字段归一化。密钥不在这里处理。
function normalizeVoiceDefaults(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const scenarios = {}
  for (const key of ['chat', 'comment', 'diary', 'greeting']) {
    scenarios[key] = src.scenarios?.[key] === true
  }
  return {
    enabled: src.enabled === true,
    baseUrl: String(src.baseUrl || '').trim().slice(0, 500),
    model: String(src.model || '').trim().slice(0, 120),
    temperature: clampNumber(src.temperature, 0, 2, DEFAULT_CONFIG.voice.temperature),
    maxTokens: clampNumber(src.maxTokens, 16, 4096, DEFAULT_CONFIG.voice.maxTokens),
    timeoutMs: clampNumber(src.timeoutMs, 3000, 120000, DEFAULT_CONFIG.voice.timeoutMs),
    scenarios,
    stylePrompt: String(src.stylePrompt || '').slice(0, 2000),
  }
}

function normalizeConfig(raw) {  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const dirs = Array.isArray(src.extensionDirs)
    ? src.extensionDirs.map((x) => String(x || '').trim()).filter(Boolean)
    : DEFAULT_CONFIG.extensionDirs
  return {
    enabled: src.enabled !== false,
    extensionDirs: dirs.length ? dirs : DEFAULT_CONFIG.extensionDirs,
    loadEnabledByDefault: src.loadEnabledByDefault !== false,
    forceDisabledByDefault: src.forceDisabledByDefault === true,
    qq: {
      enabled: src.qq?.enabled !== false,
      respectBridgeSwitches: src.qq?.respectBridgeSwitches !== false,
      dryRun: src.qq?.dryRun === true,
      allowForeignTargets: src.qq?.allowForeignTargets === true,
      timeoutMs: clampNumber(src.qq?.timeoutMs, 1000, 120000, DEFAULT_CONFIG.qq.timeoutMs),
    },
    whale: {
      enabled: src.whale?.enabled !== false,
      rolePrefix: src.whale?.rolePrefix === true,
      role: String(src.whale?.role || 'auto'),
      exposeStickers: src.whale?.exposeStickers !== false,
      injectPersona: src.whale?.injectPersona === true,
    },
    fish: {
      name: String(src.fish?.name || '').trim().slice(0, 32),
      ownerTitle: String(src.fish?.ownerTitle || '主人').trim().slice(0, 16) || '主人',
      persona: String(src.fish?.persona || 'auto'),
    },
    platforms: normalizeAllPlatforms(src.platforms),
    voice: normalizeVoiceDefaults(src.voice),
    storage: {
      // 只接受绝对路径；其它一律当作"跟随工作区"。
      root: isAbsolutePath(src.storage?.root) ? String(src.storage.root).trim() : '',
      gallery: isAbsolutePath(src.storage?.gallery) ? String(src.storage.gallery).trim() : '',
      sites: isAbsolutePath(src.storage?.sites) ? String(src.storage.sites).trim() : '',
    },
    stickers: {
      enabled: src.stickers?.enabled !== false,
      hourlyLimit: clampNumber(src.stickers?.hourlyLimit, 0, 1000, DEFAULT_CONFIG.stickers.hourlyLimit),
    },
    linkLibrary: {
      enabled: src.linkLibrary?.enabled !== false,
      hourlyLimit: clampNumber(src.linkLibrary?.hourlyLimit, 0, 1000, DEFAULT_CONFIG.linkLibrary.hourlyLimit),
    },
    tts: {
      auto: src.tts?.auto === true,
    },
    astrbot: normalizeAstrbot(src.astrbot),
    qzone: {
      enabled: src.qzone?.enabled !== false,
      postsPerDay: clampNumber(src.qzone?.postsPerDay, 0, 100, DEFAULT_CONFIG.qzone.postsPerDay),
      likesPerDay: clampNumber(src.qzone?.likesPerDay, 0, 100, DEFAULT_CONFIG.qzone.likesPerDay),
      commentsPerDay: clampNumber(src.qzone?.commentsPerDay, 0, 100, DEFAULT_CONFIG.qzone.commentsPerDay),
      repliesPerDay: clampNumber(src.qzone?.repliesPerDay, 0, 100, DEFAULT_CONFIG.qzone.repliesPerDay),
      maxPostChars: clampNumber(src.qzone?.maxPostChars, 1, 5000, DEFAULT_CONFIG.qzone.maxPostChars),
      maxCommentChars: clampNumber(src.qzone?.maxCommentChars, 1, 1000, DEFAULT_CONFIG.qzone.maxCommentChars),
      maxFeeds: clampNumber(src.qzone?.maxFeeds, 1, 20, DEFAULT_CONFIG.qzone.maxFeeds),
    },
    prompt: {
      enabled: src.prompt?.enabled !== false,
      order: clampNumber(src.prompt?.order, 0, 99999, DEFAULT_CONFIG.prompt.order),
    },
    logLimit: clampNumber(src.logLimit, 20, 2000, DEFAULT_CONFIG.logLimit),
  }
}

export function createConfigStore({ home = DSH_HOME } = {}) {
  const configPath = home === DSH_HOME ? FISH_WORLD_CONFIG : join(home, 'fish-world-config.json')
  const statePath = home === DSH_HOME ? FISH_WORLD_STATE : join(home, 'plugin-ecosystem', 'fish-world', '.state.json')

  let config = normalizeConfig(readJson(configPath, null))
  let state = { ...DEFAULT_STATE, ...(readJson(statePath, null) || {}) }
  if (!state.enabled || typeof state.enabled !== 'object') state.enabled = {}
  if (!state.settings || typeof state.settings !== 'object') state.settings = {}
  if (!state.storage || typeof state.storage !== 'object') state.storage = {}

  const listeners = new Set()
  const settingsListeners = new Map()

  function notify() {
    for (const fn of [...listeners]) {
      try { fn(getConfig()) } catch {}
    }
  }

  function getConfig() {
    return config
  }

  function saveConfig(patch) {
    config = normalizeConfig(mergePatch(config, patch))
    writeJson(configPath, config)
    notify()
    return config
  }

  function getState() {
    return state
  }

  function saveState() {
    state.updatedAt = new Date().toISOString()
    writeJson(statePath, state)
    return state
  }

  function isEnabled(id, enabledByDefault) {
    const key = String(id)
    if (Object.prototype.hasOwnProperty.call(state.enabled, key)) return state.enabled[key] === true
    if (config.forceDisabledByDefault) return false
    if (!config.loadEnabledByDefault) return false
    return enabledByDefault === true
  }

  function setEnabled(id, value) {
    state.enabled[String(id)] = value === true
    saveState()
    return state.enabled[String(id)]
  }

  function settingsOf(id, defaults) {
    const saved = state.settings[String(id)]
    return {
      ...(defaults && typeof defaults === 'object' ? defaults : {}),
      ...(saved && typeof saved === 'object' ? saved : {}),
    }
  }

  function saveSettings(id, patch) {
    const key = String(id)
    state.settings[key] = mergePatch(state.settings[key] || {}, patch)
    saveState()
    for (const fn of [...(settingsListeners.get(key) || [])]) {
      try { fn(state.settings[key]) } catch {}
    }
    return state.settings[key]
  }

  function clearSettings(id, keys = []) {
    const key = String(id)
    const saved = state.settings[key]
    if (!saved || typeof saved !== 'object') return {}
    for (const field of keys) delete saved[String(field)]
    if (Object.keys(saved).length === 0) delete state.settings[key]
    saveState()
    for (const fn of [...(settingsListeners.get(key) || [])]) {
      try { fn(state.settings[key] || {}) } catch {}
    }
    return state.settings[key] || {}
  }

  function onSettingsChange(id, fn) {
    const key = String(id)
    if (typeof fn !== 'function') return () => {}
    let set = settingsListeners.get(key)
    if (!set) settingsListeners.set(key, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) settingsListeners.delete(key)
    }
  }

  function storageOf(id) {
    const key = String(id)
    if (!state.storage[key] || typeof state.storage[key] !== 'object') state.storage[key] = {}
    return state.storage[key]
  }

  function flushStorage() {
    saveState()
  }

  function onConfigChange(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return {
    configPath,
    statePath,
    getConfig,
    saveConfig,
    getState,
    saveState,
    isEnabled,
    setEnabled,
    settingsOf,
    saveSettings,
    clearSettings,
    storageOf,
    flushStorage,
    onConfigChange,
    onSettingsChange,
  }
}

export { normalizeConfig }
