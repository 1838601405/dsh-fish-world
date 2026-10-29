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
import { DEFAULT_KNOWLEDGE, normalizeKnowledge } from './knowledge.mjs'
import { DEFAULT_STICKER_VISION, normalizeStickerVision } from './sticker-vision.mjs'

/** 存储根目录只接受绝对路径：相对路径会随 cwd 漂移，宁可退回默认位置。 */
function isAbsolutePath(value) {
  const text = String(value == null ? '' : value).trim()
  return Boolean(text) && isAbsolute(text)
}

const DEFAULT_CONFIG = {
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
  // 鱼的基础设定：名字、对主人的称呼、外显角色卡。
  fish: {
    // 鱼的名字；空字符串表示沿用角色卡里的名字。
    name: '',
    // 鱼怎么称呼主人。
    ownerTitle: '主人',
    // 角色卡 id；auto = 用鱼世界自己的角色（fish-world-roles/roles.json 的 current）。
    persona: 'auto',
    // 发 QQ 时是否加「角色名：」前缀。
    rolePrefix: false,
    // 是否把「当前外显角色」写进 DSH 系统提示词（默认关，避免覆盖宿主原人格）。
    injectRole: false,
  },
  // 四个外部平台（QQ / B 站 / 抖音 / 微信）的默认值不在这里：真源是 lib/platforms.mjs 的 PLATFORMS
  // （normalizeConfig 直接调 normalizeAllPlatforms，从不读这份 DEFAULT_CONFIG）。
  // 这里以前还抄了一份 qq/bili/douyin 的默认值（含 dailyMessages: 20），
  // 改额度时很容易改错地方——2026-10-26 主人调每日上限就撞上过。
  // 存储位置：空字符串表示跟随工作区（没绑定工作区时落到桌面的「鱼的世界」）。
  // 主人在面板里「选择目录」后写入这里，所有收藏与平台记录都存到这个根目录下。
  // gallery / sites 可单独指定；留空就从 root 推导（鱼之宝库/图库、网站链接）。
  storage: {
    root: '',
    gallery: '',
    sites: '',
  },
  stickers: {
    enabled: true,
    // 每小时最多收藏几张表情；由主人在设置面板中调整。
    hourlyLimit: 5,
    // 同步过 QQ 收藏的表情（索引里有 emojiId）优先用 send_custom_face 发；
    // 关掉就一律退回老的 image + sub_type 路径。没同步的表情不受这个开关影响。
    useCustomFace: true,
  },
  // 链接收藏（资源链接）的额度。
  linkLibrary: {
    enabled: true,
    hourlyLimit: 10,
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
    // 借用 AstrBot 的插件工具。默认关：会真的执行别人的插件。
    // 只借"手"不借"嘴"：AstrBot 执行工具并返回原始结果，表达仍由鱼自己完成。
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
  knowledge: DEFAULT_KNOWLEDGE,
  // 图片整理（看图打标签）。密钥单独存 fish-world-sticker-vision.json，不进这里。
  stickerVision: DEFAULT_STICKER_VISION,
  // 视频工具（复用已装的 dsh-ffmpeg）。可执行文件留空 = 用系统 PATH 里的 ffmpeg / ffprobe；
  // 额度只允许往小里调：单次最多 5 分钟、输入最多 500MB（见 lib/media-tools.mjs）。
  media: {
    ffmpegPath: '',
    ffprobePath: '',
    timeoutMs: 300000,
    maxInputMB: 500,
    // 为空 = 写到 <世界>/鱼的产出。
    outputDir: '',
  },
  // B 站人设同步：自动把鱼世界的人设卡写到 bili-whale 的 persona.md。
  biliPersonaSync: {
    auto: true,
  },
  // 每日记忆摘要：按天压缩全局记忆，注入所有平台的 systemPrompt。
  memoryDigest: {
    enabled: true,
    maxChars: 1200,
    topK: 24,
  },
  logLimit: 200,
}

const DEFAULT_STATE = {
  version: 1,
  enabled: {},
  settings: {},
  storage: {},
  updatedAt: null,
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
    fish: {
      name: String(src.fish?.name || '').trim().slice(0, 32),
      ownerTitle: String(src.fish?.ownerTitle || '主人').trim().slice(0, 16) || '主人',
      persona: String(src.fish?.persona || 'auto'),
      rolePrefix: src.fish?.rolePrefix === true,
      injectRole: src.fish?.injectRole === true,
    },
    platforms: normalizeAllPlatforms(src.platforms),
    storage: {
      // 只接受绝对路径；其它一律当作"跟随工作区"。
      root: isAbsolutePath(src.storage?.root) ? String(src.storage.root).trim() : '',
      gallery: isAbsolutePath(src.storage?.gallery) ? String(src.storage.gallery).trim() : '',
      sites: isAbsolutePath(src.storage?.sites) ? String(src.storage.sites).trim() : '',
    },
    stickers: {
      enabled: src.stickers?.enabled !== false,
      hourlyLimit: clampNumber(src.stickers?.hourlyLimit, 0, 1000, DEFAULT_CONFIG.stickers.hourlyLimit),
      useCustomFace: src.stickers?.useCustomFace !== false,
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
    knowledge: normalizeKnowledge(src.knowledge),
    stickerVision: normalizeStickerVision(src.stickerVision),
    media: {
      // 可执行文件路径由主人指定；空字符串 = 让系统 PATH 去找。
      ffmpegPath: String(src.media?.ffmpegPath || '').trim(),
      ffprobePath: String(src.media?.ffprobePath || '').trim(),
      // 上限固定（只许往小里调）：单次 5 分钟、输入 500MB。
      timeoutMs: clampNumber(src.media?.timeoutMs, 5000, 300000, DEFAULT_CONFIG.media.timeoutMs),
      maxInputMB: clampNumber(src.media?.maxInputMB, 1, 500, DEFAULT_CONFIG.media.maxInputMB),
      // 只接受绝对路径；相对路径会随 cwd 漂移，宁可退回「世界/鱼的产出」。
      outputDir: isAbsolutePath(src.media?.outputDir) ? String(src.media.outputDir).trim() : '',
    },
    biliPersonaSync: {
      auto: src.biliPersonaSync?.auto !== false,
    },
    memoryDigest: {
      enabled: src.memoryDigest?.enabled !== false,
      maxChars: clampNumber(src.memoryDigest?.maxChars, 200, 3000, DEFAULT_CONFIG.memoryDigest.maxChars),
      topK: clampNumber(src.memoryDigest?.topK, 4, 100, DEFAULT_CONFIG.memoryDigest.topK),
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
