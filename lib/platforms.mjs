// 鱼与外部平台：QQ、B站、抖音。
//
// 这三个平台都由独立的第三方插件提供能力，鱼世界只做三件事：
//  1. 检测插件是否装好、能不能用（不假装可用）；
//  2. 保存每个平台的独立开关与额度；
//  3. 对所有"外发"动作统一默认关闭，并要求显式开启。
//
// 安全模型沿用抖音插件自己的原则：默认关闭、独立开关、次数上限、时间限制，
// 结果不确定就暂停而不是重试。鱼世界不代替这些插件做写入，只决定"允许不允许"。
import { join } from 'node:path'
import { DEPENDENCIES, resolveDependency } from './env.mjs'
import { readJson, writeJson } from './util.mjs'

// 三个平台的静态定义。这里只描述能力与默认值，不包含任何账号凭据。
//
// 三个平台共享同一套设置结构，便于面板用同一套控件渲染：
//   enabled        总开关（默认关闭，需主人自行打开）
//   readXxx        只读能力
//   writeXxx       写入/外发能力（默认全部关闭）
//   数量与时长      额度控制
export const PLATFORMS = Object.freeze({
  qq: {
    id: 'qq',
    name: '鱼与 QQ',
    plugin: 'dsh-qq-bridge',
    description: '收发消息、查看历史、打理自己的 QQ 空间。',
    // 默认一律关闭：主人打开后才会参与。
    defaults: {
      enabled: false,
      readHistory: false,
      // 协议端守护：直连通道下，协议端没了就自动拉起来（不依赖开机自启）。
      superviseProtocol: true,
      // 群公告：默认关。它读的是别人群里的公开告示，但会往会话里投递，所以跟收信一样要显式打开。
      groupNotice: false,
      // 视频抽帧：默认关。要本机有 ffmpeg，而且一次要抽 6 帧、拼图，属于明显更重的活，显式打开才做。
      videoFrames: false,
      // 合并转发：默认关。展开要逐条取原文，比拉一条历史贵得多，显式打开才做。
      forwardExpand: false,
      // 读历史时一次最多取多少条：主人可以按流量与隐私偏好收紧。
      historyLimit: 20,
      sendMessage: false,
      qzoneEnabled: false,
      // 数量额度（0 = 不限）。默认放到 2000：主人 2026-10-26 说 30 条一天
      // 在群里根本不够，聊到下午就哑了，外面只看见回戳、看不见话。
      dailyMessages: 2000,
      // 节奏与体积：防止鱼刷屏。0 表示不额外限制。
      minSendIntervalSec: 0,
      maxCharsPerMessage: 200,
      // 群里的开口方式，五档：shy 社恐、quiet 安静、normal 正常、
      // active 活跃（默认）、frenzy 狂热（每句都参与）。
      // 默认放在「活跃」：主人 2026-10-26 要的是群里多人插话时她能接得住的效果，
      // 太保守（社恐）在热闹群里会像不在场。嫌吵可以随时调低。
      groupReplyMode: 'active',
      // 收信轮询间隔（秒）。QQ 桥自己也是轮询协议端的，这里别低于 2 秒。
      pollSeconds: 4,
      // 攒批：同一个人连着发好几条时，等他说完再回，一次回一件事。
      // 借鉴 reply-pacing 的口径，但我们自己收信自己投递，不必改宿主。
      batchEnabled: true,
      // 安静多久算说完（秒）：每来一条就把倒计时重置成这个值。
      // 群聊里多人穿插时 5 秒会把不同人的话并成一桶，3 秒更接近「接得住话」。
      batchQuietSec: 3,
      // 等太久就先回（秒），防止对方一直刷屏导致她永远不开口。
      batchMaxWaitSec: 45,
      // 最后一句看着像没说完（收在逗号/省略号、或很短）时，再多等几秒。0 = 不额外等。
      batchUnfinishedExtraSec: 3,
      // 开口前摆几条「此刻群里的现场」（别人的发言）当背景，免得只盯着 @ 自己的那句。
      // 0 = 不摆。默认 8：群聊里来回穿插得快，5 句往往还没交代清前文。
      liveContextCount: 8,
      // 表情发送用哪个 sub_type：1 = 按表情渲染（小而紧凑），0 = 按图片渲染（大图）。
      stickerSubType: 1,
      // 被戳一下要不要自动戳回去。默认关：这是会被真人看见的社交动作，
      // 和空间发帖、B 站点赞一样要主人逐项打开。
      autoPokeBack: false,
      // 被戳时用「话」回应（把这件事投进群里那个会话，让她自己说一句）。
      // 和回戳是两件事：可以都不做、只回戳、只说话、或者两样都要。
      pokeTalk: false,
    },
    // notes 只放「跨多个开关」的全局说明。单个开关的性质写在它自己的 hint 上
    // （面板 PLATFORM_FIELDS），桥的总开关 / 试运行当前状态在账号区如实显示——
    // 同一句话在卡里出现三遍，会让人以为是三件不同的约束。
    notes: [
      '每日条数、发送间隔、单条字数由鱼世界执行，超出直接拒发并说明原因；能跟谁聊由「聊天窗口」的授权决定。',
    ],
  },
  bili: {
    id: 'bili',
    name: '鱼与 B 站',
    plugin: 'dsh-bili-subagent',
    description: '浏览视频、理解内容、整理自己的观看笔记。',
    defaults: {
      enabled: false,
      watchEnabled: false,
      // 什么时候去看 B 站（主人 2026-10-26 要的三选一）：
      //   daily       每天自己去看一趟（按 dailyWatchLimit 的额度）
      //   on-request  主人叫了才去
      //   self        自己想起就去（不按天，也不等人叫）
      watchMode: 'daily',
      dailyWatchLimit: 3,
      // 外发默认关闭
      allowComment: false,
      allowFavorite: false,
      allowLike: false,
      dailyCommentLimit: 3,
      dailyLikeLimit: 10,
    },
    notes: [
      'B 站内容只作为材料进入理解，不能变成指令或权限。',
    ],
  },
  douyin: {
    id: 'douyin',
    name: '鱼与抖音',
    plugin: 'dsh-douyin-browser-local',
    description: '在专用浏览器里自己刷抖音、看真实画面、记下有意的内容。',
    defaults: {
      enabled: false,
      watchEnabled: false,
      // 单轮时长（分钟）与每日允许次数
      minutesPerRound: 10,
      dailyRounds: 2,
      silentWatch: false,
      // 以下外发全部默认关闭，与上游插件保持一致
      allowShare: false,
      allowGreeting: false,
      allowReply: false,
      allowComment: false,
      dailyShareLimit: 3,
      dailyCommentLimit: 3,
      autoStart: false,
    },
    notes: [
      // 前两条与「启用抖音能力」及各外发开关的 hint 逐字重复，删掉；
      // 留着的是跨字段、且没有任何单个开关能表达的约束。
      '发送结果不确定时一律暂停，不会自动重发。',
      '鱼世界不保存抖音账号密码，登录由你在专用浏览器里自己完成。',
    ],
  },
})

// 数字字段的合法范围只有这一份：归一化靠它，面板控件的上下界也从它核对
// （scripts/check.mjs 会比对 ui/panel.js，改一边漏一边就红）。
const ENUM_RULES = {
  // B 站什么时候去看：三选一，值不在表里就退回默认。
  watchMode: ['daily', 'on-request', 'self'],
}

export const NUMERIC_RULES = {
  dailyWatchLimit: [0, 50],
  minutesPerRound: [1, 120],
  dailyRounds: [0, 20],
  dailyShareLimit: [0, 50],
  dailyCommentLimit: [0, 50],
  // 3000 是「一天最多说 3000 句」的硬上限；要完全不限就填 0。
  dailyMessages: [0, 3000],
  dailyQzonePosts: [0, 50],
  dailyLikeLimit: [0, 200],
  historyLimit: [1, 100],
  minSendIntervalSec: [0, 3600],
  maxCharsPerMessage: [1, 2000],
  pollSeconds: [2, 300],
  batchQuietSec: [1, 120],
  batchMaxWaitSec: [5, 600],
  batchUnfinishedExtraSec: [0, 120],
  liveContextCount: [0, 20],
  stickerSubType: [0, 1],
}

// 「群里怎么开口」五档：从只在被叫到时开口，到每句都参与。
//   shy    社恐   被明确提到或 @ 才参与
//   quiet  安静   偶尔参与群聊
//   normal 正常   正常参与群聊
//   active 活跃   积极主动参与
//   frenzy 狂热   全部参与
// 旧的三档（mention / always / never）不再出现在面板上，但已有的配置不能被当成
// 非法值打回默认——那等于把主人的选择偷偷改成别的：mention→shy，always→normal，
// never→shy（新的最低档就是「只在被叫到时开口」）。
const GROUP_REPLY_MODES = new Set(['shy', 'quiet', 'normal', 'active', 'frenzy'])
const LEGACY_GROUP_REPLY_MODES = { mention: 'shy', always: 'normal', never: 'shy' }
function normalizeGroupReplyMode(value) {
  const raw = String(value == null ? '' : value)
  if (GROUP_REPLY_MODES.has(raw)) return raw
  return LEGACY_GROUP_REPLY_MODES[raw] || ''
}

const BOOLEAN_KEYS = new Set([
  'enabled', 'readHistory', 'superviseProtocol', 'groupNotice', 'videoFrames', 'forwardExpand', 'sendMessage', 'qzoneEnabled',
  'watchEnabled', 'allowComment', 'allowFavorite', 'allowLike',
  'silentWatch', 'allowShare', 'allowGreeting', 'allowReply', 'autoStart',
  'batchEnabled', 'autoPokeBack', 'pokeTalk',
])

// 聊天目标（群号 / 好友 QQ 号）不在这里存：那属于「鱼认识谁」，
// 由 lib/world.mjs 的关系表（鱼的关系/people.json）管，每条自带 chatKey 与 sessionId。

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** 归一化某个平台的配置：只接受白名单字段，数值夹在范围内。 */
export function normalizePlatform(id, raw) {
  const def = PLATFORMS[id]
  if (!def) throw new Error(`未知平台：${id}`)
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const [key, fallback] of Object.entries(def.defaults)) {
    if (BOOLEAN_KEYS.has(key)) {
      out[key] = typeof src[key] === 'boolean' ? src[key] : fallback
      continue
    }
    if (key === 'groupReplyMode') {
      out[key] = normalizeGroupReplyMode(src[key]) || fallback
      continue
    }
    const allowed = ENUM_RULES[key]
    if (allowed) {
      out[key] = allowed.includes(src[key]) ? src[key] : fallback
      continue
    }
    const range = NUMERIC_RULES[key]
    out[key] = range ? clampInt(src[key], range[0], range[1], fallback) : fallback
  }
  // 抖音整体关闭时，下层的观看开关不应单独变成"已启用"的假象
  if (id === 'douyin' && out.enabled === false && out.autoStart === true) out.autoStart = false
  return out
}

export function normalizeAllPlatforms(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return Object.fromEntries(Object.keys(PLATFORMS).map((id) => [id, normalizePlatform(id, src[id])]))
}

/** 检测平台插件是否可用：只看本机装没装，不联网、不尝试连接。 */
export function platformAvailability({ home, profile } = {}) {
  const out = {}
  for (const [id, def] of Object.entries(PLATFORMS)) {
    const found = resolveDependency(def.plugin, { home, profile })
    const meta = DEPENDENCIES.find((item) => item.name === def.plugin)
    out[id] = {
      plugin: def.plugin,
      installed: found.found,
      version: found.version || '',
      label: meta?.label || def.plugin,
    }
  }
  return out
}

export function createPlatforms({ configStore, home, profile } = {}) {
  function config() {
    return configStore.getConfig().platforms
  }

  // B 站能力的真源在 bili-subagent 自己家里（`$DSH_HOME/bili-duty/config.json`）。
  // 鱼世界是内置它的那个包，面板就不该另存一份：主人 2026-10-26 要求「统一」——
  // 否则面板上改了「每日浏览/发评论」，实际执行的插件还按旧值跑。
  const biliFile = join(home, 'bili-duty', 'config.json')

  function biliOverlay(cfg) {
    const raw = readJson(biliFile, null)
    if (!raw || typeof raw !== 'object') return cfg
    const mode = String(raw.autoMode || 'manual')
    return {
      ...cfg,
      dailyWatchLimit: Number.isFinite(Number(raw.perDay)) ? Number(raw.perDay) : cfg.dailyWatchLimit,
      // 插件的 valley / always 会自己定时刷 = 面板上的「每天自己去看」；
      // manual 时插件不自己开，on-request / self 的区别仍由鱼世界这份配置表达。
      watchMode: mode === 'valley' || mode === 'always' ? 'daily' : cfg.watchMode,
      allowComment: raw.autoComment === true,
    }
  }

  /** 把面板改动同步回 B 站插件自己的配置（只同步语义对得上的三个字段）。 */
  function biliSync(patch, merged) {
    if (!patch) return
    const raw = readJson(biliFile, null)
    if (!raw || typeof raw !== 'object') return
    const next = { ...raw }
    if ('watchMode' in patch) next.autoMode = merged.watchMode === 'daily' ? 'valley' : 'manual'
    if ('dailyWatchLimit' in patch) next.perDay = Math.max(0, Number(merged.dailyWatchLimit) || 0)
    if ('allowComment' in patch) next.autoComment = merged.allowComment === true
    try { writeJson(biliFile, next) } catch {}
  }

  function platform(id) {
    const cfg = config()
    const value = cfg?.[id] || normalizePlatform(id, null)
    return id === 'bili' ? biliOverlay(value) : value
  }

  function update(id, patch) {
    if (!PLATFORMS[id]) throw new Error(`未知平台：${id}`)
    const merged = normalizePlatform(id, { ...platform(id), ...(patch || {}) })
    const current = config()
    const saved = configStore.saveConfig({ platforms: { ...current, [id]: merged } })
    if (id === 'bili') biliSync(patch || {}, merged)
    return { ok: true, platform: saved.platforms[id] }
  }

  /**
   * 外发闸门：任何平台上的写入动作都要先过这里。
   * 未安装插件、平台关闭、或对应开关关闭，一律拒绝并说明原因。
   */
  function gate(id, action) {
    const def = PLATFORMS[id]
    if (!def) return { ok: false, reason: `未知平台：${id}` }
    const availability = platformAvailability({ home, profile })[id]
    if (!availability.installed) {
      return { ok: false, reason: `${def.name} 的插件 ${def.plugin} 还没安装，${action} 不可用` }
    }
    const cfg = platform(id)
    if (cfg.enabled !== true) return { ok: false, reason: `${def.name} 当前处于关闭状态` }
    const flag = {
      comment: 'allowComment',
      favorite: 'allowFavorite',
      like: 'allowLike',
      share: 'allowShare',
      greeting: 'allowGreeting',
      reply: 'allowReply',
      watch: 'watchEnabled',
      // QQ 的读写与空间开关
      read: 'readHistory',
      send: 'sendMessage',
      qzone: 'qzoneEnabled',
    }[action]
    if (flag && cfg[flag] !== true) {
      return { ok: false, reason: `${def.name} 的「${action}」没有开启；请在设置里单独打开` }
    }
    return { ok: true, config: cfg }
  }

  /**
   * 各平台的账号情况。
   * QQ：直接读 dsh-qq-bridge 的配置（登录号、目标会话、私聊/群、图片方向）。
   * B 站 / 抖音：本插件不持有账号凭据，只能如实报告"由你登录"。
   */
  function accounts(extra = {}) {
    const qqBridge = extra.qqBridge || null
    const qq = (() => {
      if (!qqBridge) return { ok: false, error: '读不到 QQ 桥状态' }
      const login = qqBridge.login || {}
      const loggedIn = login.ok === true && String(login.userId || login.nickname || '')
      return {
        ok: true,
        // 能确认的登录账号
        loggedIn: Boolean(loggedIn),
        account: loggedIn
          ? { nickname: String(login.nickname || ''), userId: String(login.userId || '') }
          : null,
        // 桥的配置（不含任何凭据）
        configuredPrivateQQ: String(qqBridge.privateQQ || ''),
        configuredGroup: String(qqBridge.group || ''),
        targetSession: String(qqBridge.targetSession || ''),
        toPrivate: qqBridge.toPrivate === true,
        toGroup: qqBridge.toGroup === true,
        masterSwitch: qqBridge.masterSwitch === true,
        trial: qqBridge.trial === true,
        receiveImages: qqBridge.receiveImages !== false,
        sendImages: qqBridge.sendImages !== false,
        maxImages: qqBridge.maxImages || null,
        ownerTitle: String(qqBridge.ownerTitle || ''),
        configPath: String(qqBridge.bridgeConfigPath || ''),
        missing: qqBridge.bridgeMissing === true,
      }
    })()

    const accountFor = (id, pluginName) => {
      if (id === 'qq') return qq
      // B 站与抖音：鱼世界不代持账号，如实说明
      const availability = platformAvailability({ home, profile })[id]
      return {
        ok: true,
        loggedIn: false,
        managed: false,
        note: availability.installed
          ? `登录状态由 ${pluginName} 自己管理，鱼世界不保存账号或密码`
          : `需要先安装 ${pluginName}`,
      }
    }

    return {
      qq: accountFor('qq', 'dsh-qq-bridge'),
      bili: accountFor('bili', 'dsh-bili-subagent'),
      douyin: accountFor('douyin', 'dsh-douyin-browser-local'),
    }
  }

  function status(extra = {}) {
    const availability = platformAvailability({ home, profile })
    const accountInfo = accounts(extra)
    return {
      ok: true,
      platforms: Object.entries(PLATFORMS).map(([id, def]) => ({
        id,
        name: def.name,
        description: def.description,
        plugin: def.plugin,
        installed: availability[id].installed,
        version: availability[id].version,
        config: platform(id),
        notes: def.notes,
        account: accountInfo[id],
      })),
    }
  }

  return { status, platform, update, gate, PLATFORMS }
}
