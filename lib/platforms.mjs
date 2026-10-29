// 鱼与外部平台：QQ、B站、抖音、微信。
//
// 这四个平台都由独立的第三方插件提供能力，鱼世界只做三件事：
//  1. 检测插件是否装好、能不能用（不假装可用）；
//  2. 保存每个平台的独立开关与额度；
//  3. 对所有"外发"动作统一默认关闭，并要求显式开启。
//
// 微信是唯一「没有自己的协议实现」的平台：收发、扫码、人格与行为全在
// `dsh-wechat-plugin` 那边（腾讯 iLink / ClawBot，设置页在「设置 → 微信」）。
// 鱼世界不实现微信协议、不代管人格、不代持凭据，只把开关闸门与
// 「装没装 / 状态接口通不通 / 通道开没开 / 账号连上没」如实上报。
//
// 安全模型沿用抖音插件自己的原则：默认关闭、独立开关、次数上限、时间限制，
// 结果不确定就暂停而不是重试。鱼世界不代替这些插件做写入，只决定"允许不允许"。
import { join } from 'node:path'
import { DEPENDENCIES, resolveDependency } from './env.mjs'
import { readJson, writeJson } from './util.mjs'
import { DOUYIN_UPSTREAM_KEYS } from './douyin-settings.mjs'

// 四个平台的静态定义。这里只描述能力与默认值，不包含任何账号凭据。
//
// 四个平台共享同一套设置结构，便于面板用同一套控件渲染：
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
      // 合并转发：默认开（主人 2026-10-27：收到聊天记录卡片就该看见卡片里的全部内容）。
      // 展开要逐条取原文，比拉一条历史贵一些，但看不见内容等于这条消息白收。
      forwardExpand: true,
      // 回复 / 引用：别人回的是哪一句，要单独取回来才看得见。只多一次 get_msg，
      // 默认开着；关了之后消息照常收，只是看不到被引用的原文。
      quoteExpand: true,
      // 读历史时一次最多取多少条：主人可以按流量与隐私偏好收紧。
      historyLimit: 20,
      sendMessage: false,
      qzoneEnabled: false,
      // 每天写完日记就发一条空间日记、顺便看看别人在她空间的赞与评论。
      // 默认关：这是会被真人看见的外发，和空间发帖同级，要主人单独打开。
      // 开着也只是「触发提醒 + 只读互动」；点赞 / 回评仍受空间额度与 qzoneEnabled 约束。
      qzoneDailyDiary: false,
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
      // 私聊单独给一个窗口：主人 2026-10-28 要「私聊每次看一百条上下文」。
      // 0 = 跟着 liveContextCount 走。
      privateContextCount: 100,
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
    // 真源已切到 bili-whale（主人 2026-10-29 决策）：它能力更深（字幕 + 弹幕 + 热评 +
    // 抽帧 + 硬字幕拼图），深度浏览与人设注入在它自己的页面 / 配置里
    // （`$DSH_HOME/bili-whale.config.json`、`~/.bili-ai/persona.md`），鱼世界不代管。
    // bili-subagent 降为可选：复用微信那套「任一装上即就位」的 availability 逻辑，
    // bili-whale 排在前面，所以 version 取它。
    plugin: 'dsh-bili-whale',
    plugins: ['dsh-bili-whale', 'dsh-bili-subagent'],
    description: '浏览视频、理解内容、整理自己的观看笔记；深度浏览（字幕 / 弹幕 / 热评 / 抽帧）由 bili-whale 提供。',
    // 2026-10-29：面板这批项**直接读写 bili-whale 自己的配置文件**（见 BILI_WHALE_FIELDS），
    // 不再另存一份镜像，所以 bili-duty/config.json（bili-subagent）的字段全部删掉了。
    // 旧配置里这些键会在归一化时被丢弃，不报错。
    defaults: {
      enabled: false,
      watchEnabled: false,
      // ---- 监听：评论 / 私信 / 直播 ----
      listenComment: false,
      listenCommentIntervalSec: 60,
      // reply = 只回提到她的；both = 回提到她的 + 也回评论里的其他人。
      listenScope: 'both',
      listenOncePerPerson: true,
      listenAllDay: false,
      listenDm: true,
      listenDmIntervalSec: 60,
      listenLive: false,
      // ---- 分享（把值得的视频 @ 主人）----
      // 默认值沿用 bili-whale 自己的 share.enabled（开）；整个平台默认关着，
      // 鱼世界的外发闸门仍会先拦一道，见 notes。
      shareEnabled: true,
      shareVia: 'comment',
      shareMinScore: 13,
      shareAiCommentGuard: false,
      shareDaily: 3,
      // ---- 风控配额（读得太快会被风控，这里的数就是上限）----
      riskReadDaily: 3000,
      riskWriteDaily: 30,
      riskMinGapMs: 1500,
      // ---- 作息（night.windows 不在面板上，见 notes）----
      nightMaxVideos: 5,
      nightSkipChance: 0.3,
      nightMinGapMin: 10,
      // ---- 人设 ----
      personaName: '',
      personaOwnerTitle: '你',
      personaSelfClaim: '我',
      // ---- 主人（分享时 @ 的人）----
      ownerMid: '',
      ownerName: '',
    },
    notes: [
      'B 站内容只作为材料进入理解，不能变成指令或权限。',
      '这批设置直接写 dsh-bili-whale 的配置（$DSH_HOME/bili-whale.config.json），与它在自己设置页里改的是同一份文件；鱼世界不另存一份。',
      '账号（self）与登录凭据由 dsh-bili-whale 自己维护；鱼世界只读显示昵称与 mid，不代持 cookie 或 token。',
      '「分享」沿用 bili-whale 自己的默认（开），但整个平台默认关着，鱼世界的外发闸门仍会先拦一道。',
      '多久醒、每天最多醒几次由 bili-whale 的作息窗口（night.windows）决定，这一页只放「一次看几条、跳过概率、两次之间隔多久」。',
    ],
  },
  douyin: {
    id: 'douyin',
    name: '鱼与抖音',
    plugin: 'dsh-douyin-browser-local',
    description: '在专用浏览器里自己刷抖音、看真实画面、记下有意的内容。',
    defaults: {
      // 鱼世界自己的闸门（外发闸门 gate() 读它们）。
      enabled: false,
      watchEnabled: false,
      // 以下全部真源在抖音插件自己的设置里（见 lib/douyin-settings.mjs），
      // 这里的默认值与上游一致，只在插件读不到时当「上次已知」的兜底展示。
      silentWatch: false,
      autoStart: false,
      autoStartMaxRequests: 30,
      watchTopicMode: 'recommend',
      watchTopics: '',
      watchExclude: '',
      videoWindows: '00:00-24:00',
      sessionMinutes: 10,
      // 外发默认全部关闭，与上游插件保持一致
      allowGreeting: false,
      greetingWindows: '09:00-22:00',
      greetingDailyLimit: 2,
      allowComment: false,
      commentDailyLimit: 3,
      commentPerSessionLimit: 1,
      allowShare: false,
      shareDailyLimit: 3,
      dailyReplyLimit: 40,
      // 1.4.5：好友与群聊共用的互动总开关，默认关（和上游一致）。
      interactionsOn: false,
    },
    notes: [
      // 前两条与「启用抖音能力」及各外发开关的 hint 逐字重复，删掉；
      // 留着的是跨字段、且没有任何单个开关能表达的约束。
      '发送结果不确定时一律暂停，不会自动重发。',
      '鱼世界不保存抖音账号密码，登录由你在专用浏览器里自己完成。',
    ],
  },
  wechat: {
    id: 'wechat',
    name: '鱼与微信',
    // 微信收发、扫码、绑定、人格与行为都由正规 DSH 插件 `dsh-wechat-plugin` 管
    // （npm 包名，仓库 xcisxc29/dsh-wechat；设置页在「设置 → 微信」，改完立即生效）。
    // 鱼世界只认这一个插件名：它没装，微信这条就只是摆着。
    plugin: 'dsh-wechat-plugin',
    plugins: ['dsh-wechat-plugin'],
    description: '微信收发、扫码与人格由 dsh-wechat-plugin 负责，鱼世界只做只读展示与开关闸门。',
    defaults: {
      // 外发一律默认关闭：和 QQ / 空间同级，要主人逐项打开。
      enabled: false,
      // 读消息与发消息分开：可以只看不说（比如只把手机当监视窗口）。
      readMessages: false,
      sendMessage: false,
      // 群聊默认不参与。微信群比 QQ 群更难撤回、更容易被不熟的人看到。
      allowGroup: false,
      // 数量与体积沿用 QQ 那套额度键，面板与 gate 都能直接复用，不另造字段名。
      dailyMessages: 200,
      maxCharsPerMessage: 500,
      // 收信轮询间隔（秒）。实际收发在 dsh-wechat-plugin 那边，这个值只表达主人的偏好。
      pollSeconds: 5,
    },
    notes: [
      '收发、扫码登录、绑定账号、人格与行为都由 dsh-wechat-plugin 管（设置 → 微信）；鱼世界只读展示，不代管人格、不代持登录凭据。',
      '鱼世界只保留自己的读 / 发 / 群聊闸门与每日条数、单条字数、轮询间隔（默认全关）；实际收发在 dsh-wechat-plugin 那边。',
    ],
  },
})

// 数字字段的合法范围只有这一份：归一化靠它，面板控件的上下界也从它核对
// （scripts/check.mjs 会比对 ui/panel.js，改一边漏一边就红）。
const ENUM_RULES = {
  // B 站：与 bili-whale 自己的校验口径一致（lib/index.js 的 KNOWN + 设置页下拉）。
  //   listen.scope  reply = 只回提到她的；both = 也回评论里的其他人
  //   share.via     comment = 发评论 @ 主人；dm = 私信
  listenScope: ['reply', 'both'],
  shareVia: ['comment', 'dm'],
  // 抖音观看方式（上游 watch-options）。
  watchTopicMode: ['recommend', 'topic'],
}

// 文本字段的长度上限：只防止误粘贴巨量内容，不替上游做语义校验。
const STRING_LIMITS = {
  ownerName: 40,
  ownerMid: 20,
  personaName: 40,
  personaOwnerTitle: 20,
  personaSelfClaim: 20,
  watchTopics: 2000,
  watchExclude: 2000,
  videoWindows: 500,
  greetingWindows: 500,
}

export const NUMERIC_RULES = {
  // B 站：范围与 bili-whale 自己的设置页一致（面板 min/max 必须与这里相同，scripts/check.mjs 会比对）。
  listenCommentIntervalSec: [10, 3600],
  listenDmIntervalSec: [10, 3600],
  shareMinScore: [0, 100],
  shareDaily: [0, 20],
  riskReadDaily: [0, 30000],
  riskWriteDaily: [0, 300],
  riskMinGapMs: [100, 60000],
  nightMaxVideos: [1, 20],
  nightSkipChance: [0, 1],
  nightMinGapMin: [0, 240],
  // 抖音：sessionMinutes 0 = 不限单轮时长（上游的 null）。
  autoStartMaxRequests: [1, 10000],
  sessionMinutes: [0, 1440],
  greetingDailyLimit: [1, 2],
  commentDailyLimit: [1, 20],
  commentPerSessionLimit: [1, 3],
  shareDailyLimit: [1, 20],
  dailyReplyLimit: [1, 200],
  // 3000 是「一天最多说 3000 句」的硬上限；要完全不限就填 0。
  dailyMessages: [0, 3000],
  dailyQzonePosts: [0, 50],
  historyLimit: [1, 100],
  minSendIntervalSec: [0, 3600],
  maxCharsPerMessage: [1, 2000],
  pollSeconds: [2, 300],
  batchQuietSec: [1, 120],
  batchMaxWaitSec: [5, 600],
  batchUnfinishedExtraSec: [0, 120],
  liveContextCount: [0, 60],
  privateContextCount: [0, 200],
  stickerSubType: [0, 1],
}

// 可以是小数的数值字段：其余字段一律按整数收敛（Math.round）。
// nightSkipChance 是「这次醒来跳过的概率」，0.3 被四舍五入成 0 就等于悄悄关掉了它。
const FLOAT_KEYS = new Set(['nightSkipChance'])

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
  'enabled', 'readHistory', 'superviseProtocol', 'groupNotice', 'videoFrames', 'forwardExpand', 'quoteExpand', 'sendMessage', 'qzoneEnabled',
  'qzoneDailyDiary',
  // 微信：读写与群聊各自独立（sendMessage 与 QQ 共用同一个键名）。
  'readMessages', 'allowGroup',
  'watchEnabled',
  // B 站：监听 / 分享（bili-whale 的 listen.* 与 share.*）。
  'listenComment', 'listenOncePerPerson', 'listenAllDay', 'listenDm', 'listenLive',
  'shareEnabled', 'shareAiCommentGuard',
  'allowComment',
  'silentWatch', 'allowShare', 'allowGreeting', 'autoStart',
  'batchEnabled', 'autoPokeBack', 'pokeTalk',
  'interactionsOn',
])

// 聊天目标（群号 / 好友 QQ 号）不在这里存：那属于「鱼认识谁」，
// 由 lib/world.mjs 的关系表（鱼的关系/people.json）管，每条自带 chatKey 与 sessionId。

function clampInt(value, min, max, fallback, float = false) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.max(min, Math.min(max, float ? n : Math.round(n)))
  return clamped
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
    if (typeof fallback === 'string') {
      const text = typeof src[key] === 'string' ? src[key].slice(0, STRING_LIMITS[key] || 2000) : fallback
      out[key] = text
      continue
    }
    const range = NUMERIC_RULES[key]
    out[key] = range ? clampInt(src[key], range[0], range[1], fallback, FLOAT_KEYS.has(key)) : fallback
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
    // 有些平台可以有几条通道实现（B 站：真源 bili-whale + 降为可选的 bili-subagent）。
    // 装了任意一条就算可用，版本取第一个找到的；plugin 仍报主插件名，排错时按它找。
    // 没有 plugins 数组的平台（qq / douyin）走的是和以前完全一样的一条路径。
    const names = Array.isArray(def.plugins) && def.plugins.length ? def.plugins : [def.plugin]
    const channels = names.map((name) => {
      const hit = resolveDependency(name, { home, profile })
      return { name, installed: hit.found, version: hit.version || '' }
    })
    const found = channels.find((item) => item.installed) || null
    const meta = DEPENDENCIES.find((item) => item.name === (found?.name || def.plugin))
    const entry = {
      plugin: def.plugin,
      installed: Boolean(found),
      version: found?.version || '',
      label: meta?.label || def.plugin,
    }
    // 只有声明了多条通道的平台才展开明细：qq / douyin 的返回形状保持不变。
    if (def.plugins) entry.channels = channels
    out[id] = entry
  }
  return out
}

// 闸门里的「动作 → 开关名」。各平台共用这一张表。
const ACTION_FLAGS = {
  comment: 'allowComment',
  share: 'allowShare',
  greeting: 'allowGreeting',
  watch: 'watchEnabled',
  // QQ 的读写与空间开关
  read: 'readHistory',
  send: 'sendMessage',
  qzone: 'qzoneEnabled',
}

// 个别平台的同名动作对应不同的开关：微信没有「读历史」的概念，只有「读消息」。
// 用覆盖表而不是改上面那张表，QQ 的 read → readHistory 语义一行都不用动。
const PLATFORM_ACTION_FLAGS = {
  wechat: { read: 'readMessages', send: 'sendMessage' },
  // B 站的外发只剩「分享」（评论 @ 主人 或 私信）这一种，闸门看它自己的开关。
  // 以前是 allowComment（bili-subagent 的字段），那个插件停用后这个键已不存在——
  // 不改这里的话 action=comment 会永远报「没有开启」，看起来像配置问题。
  bili: { comment: 'shareEnabled', share: 'shareEnabled' },
}

// ---- 按路径读写 bili-whale 的配置 ----
// 面板字段 ↔ 配置里的一串键，不是一个扁平键名。这里只做「按路径取/写」，
// 保证写回时不动插件自己的其它键（preferences / notify / aliases / diary / 未知键…）。

/** 读 ['listen','comment'] 这样的嵌套值；中间任何一层不是对象就返回 undefined。 */
export function getPath(root, path) {
  let cursor = root
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

/** 写 ['listen','comment'] 这样的嵌套值；只改这条路径，其余键原样保留。 */
export function setPath(root, path, value) {
  const target = root && typeof root === 'object' && !Array.isArray(root) ? root : {}
  let cursor = target
  for (const key of path.slice(0, -1)) {
    const next = cursor[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[path[path.length - 1]] = value
  return target
}

/** 删掉一条嵌套键（父级跟着空了也不清理，免得动到插件自己的空对象）。 */
export function deletePath(root, path) {
  let cursor = root
  for (const key of path.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return root
    cursor = cursor[key]
  }
  if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)) delete cursor[path[path.length - 1]]
  return root
}

export function createPlatforms({ configStore, home, profile, douyin, wechatPlugin } = {}) {
  function config() {
    return configStore.getConfig().platforms
  }

  // B 站的面板设置**直接读写 bili-whale 自己的配置文件**（主人 2026-10-29 的决策：
  // 只保留 bili-whale，bili-subagent 已停用）。面板不另存一份镜像：同一份文件，
  // 它自己的设置页与鱼世界改的是同一处，不会两边各说一套。
  // 文件不存在时读操作原样返回、一个字都不写；只有面板真的改了才创建。
  // 路径与 bili-whale 自己的 tools/lib/paths.mjs 一致：优先 BILI_WHALE_CONFIG，
  // 否则 $DSH_HOME/bili-whale.config.json。两边不读同一份文件就会各改各的。
  const biliFile = process.env.BILI_WHALE_CONFIG || join(home, 'bili-whale.config.json')

  // 面板字段 → bili-whale 配置里的路径（见它的 tools/lib/config.mjs DEFAULTS）。
  // 不在表里的字段（enabled / watchEnabled）是鱼世界自己的闸门，只存本地配置。
  const BILI_WHALE_FIELDS = {
    listenComment: ['listen', 'comment'],
    listenCommentIntervalSec: ['listen', 'commentIntervalSec'],
    listenScope: ['listen', 'scope'],
    listenOncePerPerson: ['listen', 'oncePerPerson'],
    listenAllDay: ['listen', 'allDay'],
    listenDm: ['listen', 'dm'],
    listenDmIntervalSec: ['listen', 'dmIntervalSec'],
    listenLive: ['listen', 'live'],
    shareEnabled: ['share', 'enabled'],
    shareVia: ['share', 'via'],
    shareMinScore: ['share', 'minScore'],
    shareAiCommentGuard: ['share', 'aiCommentGuard'],
    shareDaily: ['quota', 'shareDaily'],
    riskReadDaily: ['risk', 'readDaily'],
    riskWriteDaily: ['risk', 'writeDaily'],
    riskMinGapMs: ['risk', 'minGapMs'],
    nightMaxVideos: ['night', 'maxVideos'],
    nightSkipChance: ['night', 'skipChance'],
    nightMinGapMin: ['night', 'minGapMin'],
    personaName: ['persona', 'name'],
    personaOwnerTitle: ['persona', 'ownerTitle'],
    personaSelfClaim: ['persona', 'selfClaim'],
    ownerMid: ['owner', 'mid'],
    ownerName: ['owner', 'name'],
  }

  /** 读 bili-whale 的配置；读不出来（没有文件 / JSON 坏了）返回 fallback，并告诉调用方是不是「文件坏了」。 */
  function readBiliConfig() {
    let broken = false
    const raw = readJson(biliFile, null, () => { broken = true })
    const ok = raw && typeof raw === 'object' && !Array.isArray(raw)
    return { raw: ok ? raw : null, broken }
  }

  function biliOverlay(cfg) {
    const { raw } = readBiliConfig()
    // 没有文件 / 读不出来：用面板自己那份配置原样显示，不报错也不建文件。
    if (!raw) return cfg
    const def = PLATFORMS.bili.defaults
    const out = { ...cfg }
    for (const [key, path] of Object.entries(BILI_WHALE_FIELDS)) {
      const got = getPath(raw, path)
      // 文件是唯一真源：文件里没有这一项就回默认值，不能残留本地那份旧值
      // （否则插件里删掉一项，面板还显示以前的数，改下一项时又会把它写回去）。
      const fallback = def[key]
      if (got === undefined || got === null) {
        out[key] = fallback
        continue
      }
      if (typeof fallback === 'boolean') {
        // 上游存的是布尔就照抄；类型不对（比如手改成字符串）就当没读到，不猜。
        out[key] = typeof got === 'boolean' ? got : fallback
        continue
      }
      if (typeof fallback === 'string') {
        out[key] = typeof got === 'string' || typeof got === 'number' ? String(got) : fallback
        continue
      }
      const n = Number(got)
      out[key] = Number.isFinite(n) ? n : fallback
    }
    return out
  }

  /** 把面板改动写回 bili-whale 的配置。范围已经由 normalizePlatform 钳过。 */
  function biliSync(patch, merged) {
    if (!patch) return
    const keys = Object.keys(BILI_WHALE_FIELDS).filter((key) => key in patch)
    if (!keys.length) return
    const { raw, broken } = readBiliConfig()
    // 文件存在但解析不了 = 写到一半被打断。这时写回去会把插件自己的设置整个覆盖掉，
    // 宁可报错让主人看见（AGENTS ③：不许用默认值掩盖失败）。
    if (broken) throw new Error(`B 站配置 ${biliFile} 解析失败，没有写入，避免覆盖 bili-whale 自己的设置`)
    const next = raw ? { ...raw } : {}
    for (const key of keys) {
      const path = BILI_WHALE_FIELDS[key]
      const value = merged[key]
      // 文本留空 = 删掉这一键，让 bili-whale 回到它自己的默认（而不是把空串写进去）。
      if (typeof value === 'string' && !value.trim()) deletePath(next, path)
      else setPath(next, path, value)
    }
    writeJson(biliFile, next)
  }

  /** 账号信息只读：bili-whale 把登录后的昵称 / mid 写在配置的 self 里，界面照抄，不编模型等级。 */
  function biliSelf() {
    const { raw } = readBiliConfig()
    const self = raw && raw.self && typeof raw.self === 'object' && !Array.isArray(raw.self) ? raw.self : null
    return {
      mid: self && self.mid != null ? String(self.mid) : '',
      name: self && self.name != null ? String(self.name) : '',
    }
  }

  // 抖音：上游的设置在它自己那里。这里只缓存「最近一次读到的」，并记下读失败的原因，
  // 让面板能如实说「读不到」，而不是悄悄展示旧值。
  let douyinCache = null
  // 微信：dsh-wechat-plugin 的只读快照（插件 / 地址 / 状态接口 / 通道 / 账号）。
  // accounts() 是同步的，所以这里缓存最近一次探到的结果；还没探过时如实报「还没检查」。
  let wechatCache = null

  async function refreshDouyin() {
    if (!douyin) return
    if (!platformAvailability({ home, profile }).douyin.installed) {
      douyinCache = { values: douyinCache?.values || null, error: '抖音插件还没安装' }
      return
    }
    try {
      douyinCache = { values: await douyin.read(), error: '' }
    } catch (error) {
      douyinCache = { values: douyinCache?.values || null, error: String(error?.message || error) }
    }
  }

  async function refreshWechat() {
    if (!wechatPlugin || typeof wechatPlugin.status !== 'function') return
    try {
      wechatCache = await wechatPlugin.status()
    } catch (error) {
      // 探不通只影响这一张卡，不能让整页平台状态读不出来。
      wechatCache = {
        ok: false,
        installed: platformAvailability({ home, profile }).wechat.installed,
        version: '',
        origin: '',
        route: '/.dsh-wechat-plugin/status',
        reachable: false,
        enabled: null,
        connected: null,
        accounts: [],
        lastError: String(error?.message || error),
        note: `dsh-wechat-plugin 状态读取失败：${String(error?.message || error)}`,
      }
    }
  }

  /** 刷新各平台的上游当前值（面板每次拉状态前调用）。失败只记录原因，不抛。 */
  async function refresh() {
    await Promise.all([refreshDouyin(), refreshWechat()])
  }

  /** 把抖音相关的改动先推给上游；推失败就抛出去，由调用方报给面板，本地也不记。 */
  async function pushUpstream(id, patch) {
    if (id !== 'douyin' || !douyin) return
    const keys = Object.keys(patch || {}).filter((key) => DOUYIN_UPSTREAM_KEYS.has(key))
    if (!keys.length) return
    const merged = normalizePlatform(id, { ...platform(id), ...(patch || {}) })
    const subset = Object.fromEntries(keys.map((key) => [key, merged[key]]))
    const values = await douyin.write(subset)
    douyinCache = { values, error: '' }
  }

  function platform(id) {
    const cfg = config()
    const value = cfg?.[id] || normalizePlatform(id, null)
    if (id === 'bili') return normalizePlatform(id, biliOverlay(value))
    if (id === 'douyin' && douyinCache?.values) return normalizePlatform(id, { ...value, ...douyinCache.values })
    return value
  }

  function update(id, patch) {
    if (!PLATFORMS[id]) throw new Error(`未知平台：${id}`)
    const merged = normalizePlatform(id, { ...platform(id), ...(patch || {}) })
    // 先写插件那份再写本地：插件写失败就整次不生效（抛出去给面板看见），
    // 不能出现「本地显示改了、插件其实没改」的假成功。
    if (id === 'bili') biliSync(patch || {}, merged)
    const current = config()
    const saved = configStore.saveConfig({ platforms: { ...current, [id]: merged } })
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
    const flag = { ...ACTION_FLAGS, ...(PLATFORM_ACTION_FLAGS[id] || {}) }[action]
    // 私信回复由抖音插件自己启停（它没有单独的许可开关），这里不再拦 reply。
    if (flag && cfg[flag] !== true) {
      return { ok: false, reason: `${def.name} 的「${action}」没有开启；请在设置里单独打开` }
    }
    return { ok: true, config: cfg }
  }

  /**
   * 各平台的账号情况。
   * QQ：直接读 dsh-qq-bridge 的配置（登录号、目标会话、私聊/群、图片方向）。
   * B 站：读 bili-whale 配置里的 self（昵称 / mid），只读显示，不代持凭据。
   * 抖音：本插件不持有账号凭据，只能如实报告"由你登录"。
   * 微信：dsh-wechat-plugin 的只读快照（插件 / 地址 / 状态接口 / 通道 / 账号）。
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
      // 抖音：鱼世界不代持账号，如实说明
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

    // 微信：收发、扫码、绑定、人格与行为都在 dsh-wechat-plugin 那边。鱼世界没有、
    // 也不该有登录态；这里只把 wechatPlugin 探到的只读快照交出去。
    // 还没探过就如实写「还没检查」，不猜成可达。
    const wechatAvailability = platformAvailability({ home, profile }).wechat
    const wechat = wechatCache || {
      ok: true,
      installed: wechatAvailability.installed,
      version: wechatAvailability.version || '',
      origin: '',
      route: '/.dsh-wechat-plugin/status',
      // null = 还没探过（不是「不通」）。面板据它显示「还没检查」。
      reachable: null,
      enabled: null,
      connected: null,
      accounts: [],
      lastError: '',
      note: wechatAvailability.installed
        ? '还没探过 dsh-wechat-plugin 的状态接口（打开面板时会自动探一次）'
        : '还没安装 dsh-wechat-plugin；装完重启 DSH。收发 / 扫码 / 绑定都在「设置 → 微信」。',
    }

    // B 站：账号信息来自 bili-whale 自己写下的 self（登录成功后它会把 mid / 昵称存进配置）。
    // 鱼世界只读这两项，不读 credentials.json、不碰 cookie；没有 self 就如实说还没登录。
    const biliAvailability = platformAvailability({ home, profile }).bili
    // 只装了 bili-subagent 的机器也确实就位，这时说「需要先安装 dsh-bili-whale」是假话；
    // 两个都没装才按主插件名提示。
    const biliChannels = biliAvailability.channels || []
    const biliName = biliChannels.find((item) => item.installed)?.name || 'dsh-bili-whale'
    const self = biliSelf()
    const bili = {
      ok: true,
      loggedIn: Boolean(self.mid),
      account: self.mid ? { nickname: self.name || '', userId: String(self.mid) } : null,
      managed: false,
      source: 'bili-whale',
      // 面板只显示昵称与 mid；模型 / 等级这类 bili-whale 没写进配置的东西一律不编。
      self: { mid: self.mid, name: self.name },
      // 人设同步状态（由 index.js 的 biliPersonaSync.status() 现算，经 extra 传进来）。
      // null = 没接上（面板如实写「状态未知」），不是「已同步」。
      persona: extra.biliPersona || null,
      note: self.mid
        ? '登录由 dsh-bili-whale 自己管理；鱼世界只读显示账号，不代持凭据'
        : biliAvailability.installed
          ? '还没登录或还没生成配置（bili-whale.config.json 里没有 self）；登录请在 bili-whale 的登录页完成'
          : `还没登录或还没生成配置；另外 ${biliName} 还没安装`,
    }

    return {
      qq: accountFor('qq', 'dsh-qq-bridge'),
      bili,
      douyin: accountFor('douyin', 'dsh-douyin-browser-local'),
      wechat,
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
        // 上游设置读不到时的原因（只有抖音有上游设置接口；B 站读的是本地文件）。
        syncError: id === 'douyin' ? (douyinCache?.error || '') : '',
      })),
    }
  }

  return { status, platform, update, gate, refresh, pushUpstream, PLATFORMS }
}
