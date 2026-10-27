// OneBot 11 HTTP 客户端 + dsh-qq-bridge 配置门。
//
// 关键点：适配器不绕过 bridge 的安全开关。默认情况下：
//   总开关关 → 一条都不发；试运行开 → 只返回 dryRun 回执；转私聊/转群关 → 不许发对应目标。
// 需要强制发送时，调用方必须显式传 { force: true }（只有适配器自己的「测试发送」会用）。
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { BRIDGE_CONFIG } from './paths.mjs'
import { readJson, sliceSafe } from './util.mjs'

const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const DEFAULT_BRIDGE = {
  总开关: false,
  试运行: true,
  目标会话: '',
  私聊QQ: '',
  群号: '',
  转私聊: true,
  转群: false,
  // 键名叫 NapCat 是桥的字段名（地址），我们对面跑的是 SnowLuma；改名会把桥弄断。
  NapCat: 'http://127.0.0.1:3000',
  发图: true,
  图上限MB: 5,
}

function headers() {
  const token = String(process.env.DSH_ONEBOT_ACCESS_TOKEN || '').trim()
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

function toNumber(value) {
  const n = Number(String(value == null ? '' : value).replace(/\D/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function base64Of(dataUrlOrBase64) {
  const text = String(dataUrlOrBase64 || '')
  const comma = text.indexOf(',')
  if (text.startsWith('data:') && comma >= 0) return text.slice(comma + 1)
  return text.replace(/^base64:\/\//, '')
}

function imageSegmentOf(image, { sandbox = null, trusted = false, subType } = {}) {
  if (!image || typeof image !== 'object') throw new Error('图片参数必须是对象')
  // QQ 用 data.sub_type 区分「图片」与「表情」：0 = 按原图尺寸渲染（表情库那种
  // 1080×1080 的图会撑满气泡），1 = 按表情渲染（小而紧凑、可长按收藏）。
  // 这个字段协议端接受并原样保留（回读 get_msg 实测），所以表情走 1。
  const withSub = (data) => {
    const n = Number(subType)
    if (Number.isFinite(n) && n >= 0) data.sub_type = n
    return { type: 'image', data }
  }
  const url = String(image.url || '').trim()
  if (url) return withSub({ file: url, url })

  const file = String(image.localPath || image.file || '').trim()
  if (file) {
    // 安全边界：本机图片只允许来自鱼箱。内部调用（表情库、收藏库自己的文件）
    // 传 trusted=true，因为那些路径由插件自己生成，不是模型输入。
    let target = file
    if (!trusted) {
      if (!sandbox) throw new Error('鱼箱未初始化，拒绝发送本机图片')
      target = sandbox.resolveInside(file, { mustExist: true })
    } else if (!existsSync(file)) {
      throw new Error('图片文件不存在')
    }
    const stat = statSync(target)
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB`)
    const b64 = readFileSync(target).toString('base64')
    return withSub({ file: 'base64://' + b64 })
  }

  const b64 = base64Of(image.dataUrl || image.base64)
  if (b64) {
    const bytes = Math.floor((b64.length * 3) / 4)
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB`)
    return withSub({ file: 'base64://' + b64 })
  }
  throw new Error('图片需要 url / localPath / base64 / dataUrl 之一')
}

/** 把 QQ Agent 风格的扁平段转成 OneBot 段。 */
export function toOneBotSegment(segment, options = {}) {
  if (segment == null) return null
  if (typeof segment === 'string') return { type: 'text', data: { text: segment } }
  if (typeof segment !== 'object') return { type: 'text', data: { text: String(segment) } }
  const type = String(segment.type || 'text')
  if (type === 'text') return { type: 'text', data: { text: String(segment.text ?? '') } }
  if (type === 'at') {
    const qq = String(segment.id ?? segment.qq ?? '').trim()
    return qq ? { type: 'at', data: { qq } } : null
  }
  if (type === 'reply') {
    const id = String(segment.id ?? segment.messageId ?? '').trim()
    return id ? { type: 'reply', data: { id } } : null
  }
  if (type === 'face') {
    const id = String(segment.id ?? '').trim()
    return id ? { type: 'face', data: { id } } : null
  }
  if (type === 'image') return imageSegmentOf(segment, options)
  if (type === 'record' || type === 'video' || type === 'file') {
    const file = String(segment.url || segment.file || segment.localPath || '').trim()
    if (!file) throw new Error(`${type} 段缺少 url/file`)
    const data = { file }
    if (segment.url) data.url = segment.url
    return { type, data }
  }
  if (type === 'json') {
    const data = typeof segment.data === 'string' ? segment.data : JSON.stringify(segment.data ?? {})
    return { type: 'json', data: { data } }
  }
  if (type === 'forward') {
    const id = String(segment.id ?? '').trim()
    return id ? { type: 'forward', data: { id } } : null
  }
  // 未知段不猜字段，直接拒绝（避免把脏数据丢给协议端）。
  throw new Error(`不支持的段类型：${type}`)
}

/** 解析 chatKey：private:123 / p:123 / group:456 / g:456 / 空。 */
export function parseChatKey(chatKey) {
  const raw = String(chatKey == null ? '' : chatKey).trim()
  if (!raw || raw === '*') return { kind: raw === '*' ? 'all' : 'default', id: '' }
  let m = /^(?:private|p|user|u)[:：](\d+)$/i.exec(raw)
  if (m) return { kind: 'private', id: m[1] }
  m = /^(?:group|g)[:：](\d+)$/i.exec(raw)
  if (m) return { kind: 'group', id: m[1] }
  m = /^(\d+)$/.exec(raw)
  if (m) return { kind: 'private', id: m[1] }
  return { kind: 'invalid', id: '', raw }
}

// —— 收消息段识别 ——
//
// OneBot 11 的 message 是一串段：文字、图片、表情、语音、视频、合并转发的聊天记录、
// 卡片、回复引用……适配器不猜内容，只把每段归成「模型能看懂的类型」并保留可回查的 id，
// 由 history / forward 拼成人话。这样即使协议端换了实现，也不会把未知段当文字塞进去。

const SEGMENT_LABELS = {
  mface: '表情包',
  face: '表情',
  record: '语音',
  video: '视频',
  file: '文件',
  json: '卡片',
  xml: '卡片',
  markdown: '卡片',
  forward: '聊天记录',
  node: '聊天记录',
  reply: '回复',
  at: '提及',
  poke: '戳一戳',
  dice: '骰子',
  rps: '猜拳',
  shake: '窗口抖动',
  music: '音乐',
  contact: '名片',
  location: '位置',
}

function segmentData(segment) {
  return segment && segment.data && typeof segment.data === 'object' ? segment.data : {}
}

/** 图片段是不是动图：看后缀、看协议端给的摘要，不靠 sub_type 猜。 */
function isGifImage(data) {
  const d = data || {}
  if (/动画表情|动图|\bgif\b/i.test(String(d.summary || ''))) return true
  return /\.gif(?:[?#]|$)/i.test(String(d.file || d.path || d.url || ''))
}

/**
 * 把 OneBot 段归类。返回 null 表示这段没有信息（例如空文字）。
 * kind=text 时带 text；其余带 label，能回查的带 id（聊天记录）或 url。
 */
export function classifySegment(segment) {
  if (!segment || typeof segment !== 'object') return null
  const type = String(segment.type || '')
  const data = segmentData(segment)
  if (type === 'text') {
    const text = String(data.text ?? '')
    return text ? { kind: 'text', text } : null
  }
  if (type === 'image') {
    const gif = isGifImage(data)
    const emoji = data.sub_type === 1 || /表情/.test(String(data.summary || ''))
    return {
      kind: 'image',
      label: gif ? '动图' : (emoji ? '表情包' : '图片'),
      gif,
      emoji,
      url: String(data.url || ''),
      file: String(data.file || ''),
      summary: String(data.summary || ''),
    }
  }
  if (type === 'mface') {
    return { kind: 'mface', label: '表情包', summary: String(data.summary || '') }
  }
  if (type === 'forward' || type === 'node') {
    const id = String(data.id || data.message_id || '').trim()
    return { kind: 'forward', label: '聊天记录', id, title: String(data.title || data.prompt || '') }
  }
  if (type === 'reply') {
    return { kind: 'reply', label: '回复', id: String(data.id || '').trim() }
  }
  if (type === 'at') {
    const qq = String(data.qq ?? '').trim()
    return { kind: 'at', label: qq ? `@${qq}` : '提及', id: qq }
  }
  if (type === 'face') {
    return { kind: 'face', label: '表情', id: String(data.id || '').trim() }
  }
  if (type === 'record') {
    return { kind: 'record', label: '语音', url: String(data.url || data.file || '') }
  }
  if (type === 'video' || type === 'file') {
    // 视频要能抽帧：url 必须留着，光有名字没法取字节。
    return { kind: type, label: SEGMENT_LABELS[type], name: String(data.name || data.file || ''), url: String(data.url || '') }
  }
  return { kind: type || 'unknown', label: SEGMENT_LABELS[type] || (type ? `未知段:${type}` : '未知段') }
}

/** 把非文字段压成一行标记，例如「[动图] [聊天记录:7431...]」。 */
export function describeSegments(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part && part.kind !== 'text')
    .map((part) => `[${part.label}${part.kind === 'forward' && part.id ? ':' + part.id : ''}]`)
    .join(' ')
}

/** 把一条 OneBot 消息归一成「文字 + 分段类型」，文字和图片之外的段不再被丢掉。 */
export function normalizeMessage(row, chatKey) {
  const message = row && typeof row === 'object' ? row : {}
  const segments = Array.isArray(message.message) ? message.message
    : Array.isArray(message.content) ? message.content
    : []
  const parts = segments.map(classifySegment).filter(Boolean)
  const 文字段 = parts.filter((part) => part.kind === 'text').map((part) => part.text)
  // QQ 自己会把语音转成文字放在 record 段的 data.text 里；有就一并当正文，别只留一个 [语音]。
  const 语音译文 = segments
    .filter((seg) => seg && seg.type === 'record')
    .map((seg) => String((seg.data && seg.data.text) || '').trim())
    .filter(Boolean)
  const text = [...文字段, ...语音译文.map((t) => '[语音] ' + t)].join('')
  return {
    id: String(message.message_id ?? message.id ?? ''),
    chatKey,
    userId: String(message.user_id ?? message.sender?.user_id ?? ''),
    nickname: String(message.sender?.nickname || message.sender?.card || message.nickname || ''),
    text,
    parts,
    // 图片段归一成 {url,file}：上层（投递 / 转发展开 / 工具）只需要地址，
    // 留着原始段会让调用方各猜一层 data.url —— 群里的图和聊天记录里的图都是这么丢的。
    images: segments
      .filter((seg) => seg && (seg.type === 'image' || seg.type === 'mface'))
      .map((seg) => ({
        url: String(seg.data?.url || ''),
        file: String(seg.data?.file || seg.data?.path || ''),
      }))
      .filter((image) => image.url || image.file),
    videos: segments
      .filter((seg) => seg && seg.type === 'video')
      .map((seg) => ({ url: String(seg.data?.url || ''), name: String(seg.data?.file || '') }))
      .filter((video) => video.url),
    forwards: parts.filter((part) => part.kind === 'forward' && part.id).map((part) => part.id),
    at: Number(message.time ? message.time * 1000 : Date.now()),
  }
}

export function createQQ({ home, config, logger, sandbox, astrbot, platforms, journal, chatSource, relationSource }) {
  const qqSandbox = sandbox || null
  const bridgePath = home ? `${home}/qq-bridge-config.json` : BRIDGE_CONFIG
  // 上次发送的时间只用于「最小间隔」，进程内记一份就够；重启后间隔从零算，
  // 不会因为重启就把主人设的间隔绕过去（下一条仍然要等）。
  let lastSendAt = 0

  /** 往来台账：与 activity.store 共用一份，不另开一套。可能晚于本模块创建。 */
  function journalStore() {
    try {
      return typeof journal === 'function' ? journal() : (journal || null)
    } catch {
      return null
    }
  }

  /** QQ 平台的设置（额度、节奏、开口方式）。读不到就当作默认，不额外放开。 */
  function qqChatConfig() {
    try {
      return platforms?.platform?.('qq') || {}
    } catch {
      return {}
    }
  }

  /**
   * 主人授权鱼聊天的目标（群 / 好友）。
   *
   * 这份名单就是「鱼的关系」那张表：每条关系自带 chatKey 与 sessionId，
   * 拉黑（role=blocked）或停用的条目自动不在名单里。不在这里再存一份群号，
   * 免得「鱼认识谁」和「鱼能在哪说话」变成两处需要各自维护的真相。
   */
  function allowedTargets() {
    try {
      const list = typeof chatSource === 'function' ? chatSource() : []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  function allowed(kind, id) {
    const key = `${kind}:${id}`
    return allowedTargets().some((item) => String(item.chatKey) === key)
  }

  /**
   * QQ 通道选择。默认走 dsh-qq-bridge 配的协议端地址（本机是 SnowLuma，正向 HTTP）；
   * 当主人在「鱼与 QQ」里打开了 AstrBot 通道时，改由 AstrBot 的桥插件代执行。
   * 两条通道的 call() 返回结构完全一致，所以上层代码一行都不用改。
   */
  function transportMode() {
    try {
      const bot = astrbot?.view?.()
      if (bot && bot.canUseForQQ) return 'astrbot'
    } catch {}
    return 'bridge'
  }

  function bridgeConfig() {
    const raw = readJson(bridgePath, null)
    if (!raw || typeof raw !== 'object') {
      // 没有 QQ 桥配置文件时，若主人已经把 AstrBot 当通道，就用 AstrBot 的开关当总闸：
      // 「启用 AstrBot + 用它收发 QQ」这两个开关本身就是主人的显式授权。
      // 这里如实标注来源，界面不会把它伪装成 QQ 桥的配置。
      if (transportMode() === 'astrbot') {
        // 能用 AstrBot 侧已知的登录号补上「私聊QQ」，默认目标才不会落空。
        let ownerQq = ''
        try { ownerQq = String(astrbot?.identityView?.().userId || '') } catch {}
        return {
          ...DEFAULT_BRIDGE,
          总开关: true,
          试运行: false,
          转群: true,
          私聊QQ: ownerQq,
          _missing: true,
          _fromAstrbot: true,
        }
      }
      return { ...DEFAULT_BRIDGE, _missing: true }
    }
    return { ...DEFAULT_BRIDGE, ...raw }
  }

  function baseUrl() {
    return String(bridgeConfig().NapCat || DEFAULT_BRIDGE.NapCat).replace(/\/+$/, '')
  }

  async function call(action, body = {}, { timeoutMs } = {}) {
    // AstrBot 通道：交给桥插件转发给 AstrBot 的 OneBot 适配器（bot.call_action，全量透传）。
    if (transportMode() === 'astrbot') {
      try {
        const viaBot = await astrbot.callOneBot(action, body, { timeoutMs })
        // 通道故障时不要把整条链拖死：明确报错，让上层如实显示"通道不可用"。
        return viaBot
      } catch (error) {
        return { action, ok: false, data: null, error: String(error?.message || error) }
      }
    }
    const ms = Number(timeoutMs) || Number(config().qq.timeoutMs) || 15000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      const response = await fetch(`${baseUrl()}/${action}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      })
      const json = await response.json().catch(() => null)
      const ok = !!(json && (json.status === 'ok' || json.retcode === 0))
      return { action, ok, data: json?.data ?? null, raw: json }
    } catch (error) {
      return { action, ok: false, data: null, error: String(error && error.message ? error.message : error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 决定一条消息能发给谁。
   *
   * 三层，从宽到严：
   *  1. QQ 桥自己的单目标配置（私聊QQ / 群号 + 转私聊 / 转群）——照旧尊重；
   *  2. 「鱼的关系」里主人授权过的聊天目标（chatKey → 独立 DSH 会话）——用来补桥
   *     只能盯一个目标的老限制，让鱼能在多个群和好友那里聊天。拉黑的人不在名单里。
   *     白名单只放开「目标」这一层，总开关与试运行仍然优先，越不过去。
   *  3. allowForeignTargets（旧的全放行）保留兼容，不再是唯一出路。
   */
  function resolveTargets(chatKey, options = {}) {
    const bridge = bridgeConfig()
    const parsed = parseChatKey(chatKey)
    const allowForeign = config().qq.allowForeignTargets === true
    const privateQq = String(bridge.私聊QQ || '').trim()
    const groupId = String(bridge.群号 || '').trim()
    const targets = []
    const rejected = []

    const parseSelf = toNumber(options.selfId)
    const pushPrivate = (id) => {
      const number = toNumber(id)
      if (!number) return rejected.push({ kind: 'private', id, reason: 'bad-id' })
      // 发给机器人自己登录的号：说得清楚一点，而不是笼统的 foreign-target。
      if (parseSelf && number === parseSelf) {
        return rejected.push({ kind: 'private', id: String(number), reason: 'self-target' })
      }
      const isBridgeTarget = number === toNumber(privateQq)
      const authorized = isBridgeTarget || allowed('private', number)
      if (!allowForeign && !authorized) {
        return rejected.push({ kind: 'private', id: String(number), reason: 'foreign-target' })
      }
      // 桥的「转私聊」只管它自己那个号；主人另外授权的会话不受它约束。
      if (isBridgeTarget && bridge.转私聊 === false && !allowed('private', number) && !allowForeign) {
        return rejected.push({ kind: 'private', id: String(number), reason: 'bridge-private-off' })
      }
      targets.push({ kind: 'private', id: number })
    }
    const pushGroup = (id) => {
      const number = toNumber(id)
      if (!number) return rejected.push({ kind: 'group', id, reason: 'bad-id' })
      // 群号不可能等于机器人自己的 QQ 号，但不排除有人把登录号当群号传进来。
      if (parseSelf && number === parseSelf) {
        return rejected.push({ kind: 'group', id: String(number), reason: 'self-target' })
      }
      const isBridgeTarget = !!groupId && number === toNumber(groupId)
      const authorized = isBridgeTarget || allowed('group', number)
      if (!allowForeign && !authorized) {
        return rejected.push({ kind: 'group', id: String(number), reason: 'foreign-target' })
      }
      if (isBridgeTarget && bridge.转群 === false && !allowed('group', number) && !allowForeign) {
        return rejected.push({ kind: 'group', id: String(number), reason: 'bridge-group-off' })
      }
      targets.push({ kind: 'group', id: number })
    }

    if (parsed.kind === 'private') pushPrivate(parsed.id)
    else if (parsed.kind === 'group') pushGroup(parsed.id)
    else if (parsed.kind === 'invalid') rejected.push({ kind: 'invalid', id: parsed.raw, reason: 'bad-chat-key' })
    else {
      const wantPrivate = parsed.kind === 'all' || (bridge.转私聊 !== false && !!privateQq)
      const wantGroup = parsed.kind === 'all' || (bridge.转群 === true && !!groupId)
      if (wantPrivate && privateQq) pushPrivate(privateQq)
      if (wantGroup && groupId) pushGroup(groupId)
      if (!targets.length && !rejected.length) rejected.push({ kind: 'none', id: '', reason: 'no-target-configured' })
    }
    return { targets, rejected, bridge }
  }

  /** 这个 QQ 号被主人拉黑了吗（关系表 role=blocked）：拉黑后消息不进会话、也不留存。 */
  function isMuted(userId) {
    const number = toNumber(userId)
    if (!number) return false
    try {
      const people = typeof relationSource === 'function' ? relationSource() : []
      return (people || []).some((person) => toNumber(person.qqId) === number && person.role === 'blocked')
    } catch {
      return false
    }
  }

  /** 超长按字数截断：只裁文字段，图片 / 表情等段原样保留。 */
  function trimText(segments, maxChars) {
    const budget = Math.max(0, Number(maxChars) || 0)
    let left = budget
    // 从头往后分额度：先说的那句先占位置。反过来从尾部开始，会把开头的正文
    // 挤掉，只剩最后半句话——裁断的目的是缩短，不是换内容。
    for (const seg of segments) {
      if (!seg || seg.type !== 'text') continue
      const text = String(seg.data?.text ?? '')
      if (!text.length) continue
      if (text.length <= left) { left -= text.length; continue }
      // 留一个位置给省略号，保证「裁完的总长」仍然不超过 budget。
      const keep = left > 0 ? left - 1 : 0
      seg.data = { ...seg.data, text: keep > 0 ? `${sliceSafe(text, keep)}…` : '' }
      left = 0
    }
    // 裁完没有文字了，就不要留一串空文字段。
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i]?.type === 'text' && !String(segments[i].data?.text ?? '').length) segments.splice(i, 1)
    }
  }

  /** 今天已经发出去多少条：直接数本地留存的 send 记录，不另开一套台账。 */
  function sendCountToday() {
    try {
      return Number(journalStore()?.countToday?.('qq', 'send')) || 0
    } catch {
      return 0
    }
  }

  const recentSentMap = new Map()

  function noteSent(chatKey, segments) {
    lastSendAt = Date.now()
    const said = flatText(segments)
    // 记住她在这个会话里刚说过什么：投递群消息时摆出来，免得一句口头禅连说三遍
    // （主人 2026-10-26：「今天第几个了」连着三次，像复读机）。
    try {
      if (chatKey && said) {
        const list = recentSentMap.get(chatKey) || []
        list.push(said)
        while (list.length > 12) list.shift()
        recentSentMap.set(chatKey, list)
      }
    } catch {}
    try {
      journalStore()?.append?.({ platform: 'qq', kind: 'send', actor: 'fish', text: `发到 ${chatKey}：${said}` })
    } catch {}
  }

  /** 最近在这个会话里说过的话（按时间先后，取最后几条）。 */
  function recentSent(chatKey, limit = 5) {
    const list = recentSentMap.get(String(chatKey || '')) || []
    const count = Math.max(0, Math.min(Number(limit) || 5, 12))
    return list.slice(-count)
  }

  function gate(options) {
    const bridge = bridgeConfig()
    const cfg = config()
    const force = options && options.force === true
    if (!cfg.qq.enabled) return { ok: false, reason: 'adapter-qq-disabled', bridge }
    if (cfg.qq.respectBridgeSwitches && !force && bridge.总开关 !== true) {
      return { ok: false, reason: 'bridge-switch-off', bridge }
    }
    if (cfg.qq.respectBridgeSwitches && !force && bridge.试运行 === true) {
      return { ok: true, dryRun: true, reason: 'bridge-trial-mode', bridge }
    }
    if (cfg.qq.dryRun && !force) return { ok: true, dryRun: true, reason: 'adapter-dry-run', bridge }
    return { ok: true, dryRun: false, bridge }
  }

  /**
   * 把段列表里的文字抽成一句话（试运行日志与发送记账共用同一种抽法）。
   * 注意两种段形状都有人传：QQ Agent 风格是 {type:'text', text}，
   * OneBot 风格是 {type:'text', data:{text}}，只认一种会让台账记成空的。
   */
  function flatText(segments) {
    return (Array.isArray(segments) ? segments : [segments])
      .map((seg) => {
        if (typeof seg === 'string') return seg
        if (!seg || seg.type !== 'text') return ''
        const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
        return String(seg.text ?? data.text ?? '')
      })
      .filter(Boolean)
      .join('')
  }

  async function send(chatKey, segments, options = {}) {
    const gateResult = gate(options)
    if (!gateResult.ok) return { ok: false, reason: gateResult.reason, sent: [], failed: [] }
    if (gateResult.dryRun) {
      const flat = flatText(segments)
      logger?.info?.(`[qq] 试运行，未发送（${gateResult.reason}）：${flat.slice(0, 80)}`)
      return { ok: true, dryRun: true, reason: gateResult.reason, sent: [], failed: [], targets: [] }
    }

    // 取一次机器人自己的登录号，用来把「发给机器人自己」这种目标说清楚。
    // 只做诊断，不改变授权判断：拿不到就跳过，不阻塞发送。
    // 注意：正常有目标可发时不查自己号——多一次网络往返不划算，
    // 也免得打乱那些「只应发生 N 次 fetch」的调用方。只在真要拒绝时才查。
    let selfId = options.selfId || ''
    let resolved = resolveTargets(chatKey, { ...options, selfId })
    if (!resolved.targets.length && !selfId) {
      const looked = await selfLoginId()
      if (looked) {
        selfId = looked
        resolved = resolveTargets(chatKey, { ...options, selfId })
      }
    }
    const { targets, rejected } = resolved
    const failed = rejected.map((item) => ({ ...item, error: item.reason }))
    if (!targets.length) return { ok: false, reason: 'no-valid-target', sent: [], failed, targets: [] }

    const normalized = []
    for (const segment of Array.isArray(segments) ? segments : [segments]) {
      const converted = toOneBotSegment(segment, {
        sandbox: qqSandbox,
        trusted: options.trustedLocalPath === true,
        subType: options.subType,
      })
      if (converted) normalized.push(converted)
    }
    if (!normalized.length) return { ok: false, reason: 'empty-message', sent: [], failed, targets }

    // 主人给这个平台定的节奏与体积：每日条数、发送间隔、单条字数。
    // 与桥的开关不同，这一层是「意愿」而不是「能力」，越界就明确拒发并说明原因。
    const chat = qqChatConfig()
    if (!options.force) {
      const limit = Number(chat.dailyMessages) || 0
      if (limit > 0 && sendCountToday() >= limit) {
        return { ok: false, reason: `daily-limit（今天已发 ${sendCountToday()}/${limit} 条）`, sent: [], failed, targets }
      }
      const gapMs = (Number(chat.minSendIntervalSec) || 0) * 1000
      if (gapMs > 0 && lastSendAt && Date.now() - lastSendAt < gapMs) {
        const wait = Math.ceil((gapMs - (Date.now() - lastSendAt)) / 1000)
        return { ok: false, reason: `send-interval（请再等 ${wait} 秒）`, sent: [], failed, targets }
      }
    }
    const maxChars = Number(chat.maxCharsPerMessage) || 0
    if (maxChars > 0) trimText(normalized, maxChars)
    if (!normalized.length) return { ok: false, reason: 'empty-message', sent: [], failed, targets }

    const sent = []
    for (const target of targets) {
      const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const body = target.kind === 'group'
        ? { group_id: target.id, message: normalized }
        : { user_id: target.id, message: normalized }
      const result = await call(action, body, options)
      sent.push({
        kind: target.kind,
        id: target.id,
        action,
        ok: result.ok,
        msgId: result.data && result.data.message_id != null ? String(result.data.message_id) : '',
        error: result.ok ? '' : (result.error || JSON.stringify(result.raw || {}).slice(0, 200)),
      })
    }
    const ok = sent.length > 0 && sent.every((item) => item.ok)
    // 成功发出去的那几条才计入今日额度与「上次发送时间」；
    // 逐个记账，不要整体失败时把已经发成功的那部分漏掉（否则额度会少算）。
    for (const item of sent) if (item.ok) noteSent(`${item.kind}:${item.id}`, normalized)
    return { ok, dryRun: false, reason: ok ? '' : 'send-failed', sent, failed, targets }
  }

  async function sendTextBatch(chatKey, texts, options = {}) {
    const list = (Array.isArray(texts) ? texts : [texts])
      .map((text) => String(text == null ? '' : text))
      .filter((text) => text.length > 0)
    if (!list.length) return { ok: false, reason: 'empty-text', sent: [], failed: [] }
    const results = []
    for (let index = 0; index < list.length; index += 1) {
      const result = await send(chatKey, [{ type: 'text', text: list[index] }], options)
      results.push(result)
      if (!result.ok) break
      if (index < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return mergeReceipts(results)
  }

  async function sendImage(chatKey, image, options = {}) {
    const receipt = await send(chatKey, [{ type: 'image', ...(image || {}) }], options)
    if (options.note && receipt.ok && !receipt.dryRun) {
      const note = String(options.note).slice(0, 500)
      if (note) {
        const extra = await send(chatKey, [{ type: 'text', text: note }], options)
        return mergeReceipts([receipt, extra])
      }
    }
    return receipt
  }

  async function sendSticker(chatKey, sticker, options = {}) {
    const source = sticker && typeof sticker === 'object' ? sticker : {}
    const image = {
      url: source.url,
      localPath: source.localPath || source.path,
      file: source.file,
      base64: source.base64,
      dataUrl: source.dataUrl,
    }
    // 表情文件来自插件自己的收藏库，不是模型传入的任意路径。
    // subType: 1 = 让客户端按「表情」渲染；不带这个字段协议端会当成普通图片，
    // 于是收藏库里 1080×1080 的图会撑成一张大图（参考包给了 get_msg 回读实测依据）。
    // 主人可以在 QQ 平台配置里改回 0（`stickerSubType`），不改就按表情发。
    const subType = (() => {
      const n = Number(qqChatConfig().stickerSubType)
      return Number.isFinite(n) && n >= 0 ? n : 1
    })()
    return sendImage(chatKey, image, { ...options, trustedLocalPath: true, subType })
  }

  async function poke(chatKey, { groupId, userId } = {}) {
    const parsed = parseChatKey(chatKey)
    const bridge = bridgeConfig()
    // 哪里戳的就回哪里：私聊不带上群号。以前这里兜底成桥配置的群号，
    // 结果私聊戳一下会在群里回戳。
    const targetGroup = String(groupId || (parsed.kind === 'group' ? parsed.id : '')).trim()
    const targetUser = String(userId || (parsed.kind === 'private' ? parsed.id : '') || '').trim()
    if (!targetUser) return { ok: false, reason: 'missing-user-id' }
    const body = { user_id: toNumber(targetUser) }
    if (targetGroup) body.group_id = toNumber(targetGroup)
    const result = await call('send_poke', body)
    return { ok: result.ok, data: result.data, error: result.error || '' }
  }

  async function loginInfo() {
    const result = await call('get_login_info', {}, { timeoutMs: 5000 })
    if (!result.ok) return { ok: false, error: result.error || 'onebot-unreachable' }
    return {
      ok: true,
      userId: result.data && result.data.user_id != null ? String(result.data.user_id) : '',
      nickname: result.data && result.data.nickname ? String(result.data.nickname) : '',
    }
  }

  // 机器人自己登录的 QQ 号：缓存住，发送前用它把「发给机器人自己」判清楚。
  // 拿不到就返回空串（不影响任何授权逻辑）。
  let selfIdCache = ''
  async function selfLoginId() {
    if (selfIdCache) return selfIdCache
    try {
      const info = await loginInfo()
      if (info.ok && info.userId) selfIdCache = info.userId
    } catch {}
    return selfIdCache
  }

  async function recent(chatKey, limit = 20) {
    const parsed = parseChatKey(chatKey)
    const bridge = bridgeConfig()
    const group = parsed.kind === 'group' ? parsed.id : (parsed.kind === 'default' ? bridge.群号 : '')
    const privateId = parsed.kind === 'private' ? parsed.id : (parsed.kind === 'default' ? bridge.私聊QQ : '')
    const count = Math.max(1, Math.min(Number(limit) || 20, 100))
    let result
    if (group) result = await call('get_group_msg_history', { group_id: toNumber(group), count })
    else if (privateId) result = await call('get_friend_msg_history', { user_id: toNumber(privateId), count })
    else return { ok: false, reason: 'no-target-configured', messages: [] }
    if (!result.ok) return { ok: false, reason: result.error || 'onebot-error', messages: [] }
    const list = Array.isArray(result.data?.messages) ? result.data.messages : []
    const messages = list.map((row) => normalizeMessage(row, group ? `group:${group}` : `private:${privateId}`))
    return { ok: true, messages }
  }

  /**
   * 群公告。SnowLuma 把接口叫 `_get_group_notice`，标准名 `get_group_notice` 会返回
   * retcode 1404 UNKNOWN_ACTION —— 所以先试带下划线的，再退回标准名，别让命名差异把功能卡死。
   */
  async function groupNotices(groupId) {
    const group = String(groupId || '').trim()
    if (!group) return { ok: false, reason: 'missing-group-id', notices: [] }
    let result = await call('_get_group_notice', { group_id: toNumber(group) })
    if (!result.ok) result = await call('get_group_notice', { group_id: toNumber(group) })
    if (!result.ok) return { ok: false, reason: result.error || 'onebot-error', notices: [] }
    const list = Array.isArray(result.data) ? result.data
      : Array.isArray(result.data?.notices) ? result.data.notices : []
    const notices = list.map((row) => ({
      id: String(row?.notice_id || row?.fid || ''),
      senderId: String(row?.sender_id || row?.u || ''),
      // publish_time 是秒；内部一律用毫秒，跟别的事件对齐。
      at: Number(row?.publish_time || row?.pubt || 0) * 1000,
      text: String(row?.message?.text || row?.msg?.text || '').trim(),
      pinned: Boolean(row?.pinned),
    })).filter((notice) => notice.id || notice.text)
    return { ok: true, notices }
  }

  /** 展开一条合并转发的聊天记录（OneBot get_forward_msg）。 */
  async function forward(id) {
    const key = String(id || '').trim()
    if (!key) return { ok: false, reason: 'missing-id', entries: [] }
    // 不同协议端一个认 id、一个认 message_id，先试 id 再回退，别让字段名把功能卡死。
    let result = await call('get_forward_msg', { id: key })
    if (!result.ok) result = await call('get_forward_msg', { message_id: key })
    if (!result.ok) return { ok: false, reason: result.error || 'onebot-error', entries: [] }
    const data = result.data || {}
    const rows = Array.isArray(data.messages) ? data.messages
      : Array.isArray(data.message) ? data.message
      : Array.isArray(data.content) ? data.content
      : []
    const entries = rows.map((row) => {
      // 有的实现把每条包成 { type: 'node', data: {...} }。
      const node = row && row.type === 'node' && row.data && typeof row.data === 'object' ? row.data : row
      const normalized = normalizeMessage(node, '')
      return {
        nickname: normalized.nickname,
        userId: normalized.userId,
        text: normalized.text,
        parts: normalized.parts,
        // 记录里的图要能交出去：上层拿不到地址就只能写出一个 [图片] 标记。
        images: normalized.images,
        at: Number(node && node.time ? node.time * 1000 : 0),
      }
    })
    return { ok: true, id: key, entries }
  }

  /**
   * 取「被回复 / 被引用」的那条消息（OneBot get_msg）。
   * 群里有人回一句「你说的这个」，只看得到回复段的话根本不知道指的是哪句 ——
   * 这里把那条原文取回来，交给收信层和 history 拼在消息旁边。
   */
  async function quote(id) {
    const key = String(id || '').trim()
    if (!key) return { ok: false, reason: 'missing-id' }
    // 各实现对 message_id 的类型要求不一致：先给数字，不行再原样给字符串。
    const numeric = Number(key)
    let result = await call('get_msg', { message_id: Number.isFinite(numeric) && String(numeric) === key ? numeric : key })
    if (!result.ok) result = await call('get_msg', { message_id: key })
    if (!result.ok) return { ok: false, reason: result.error || 'onebot-error' }
    const data = result.data || {}
    const normalized = normalizeMessage(data, '')
    return {
      ok: true,
      id: key,
      userId: normalized.userId,
      nickname: normalized.nickname,
      text: normalized.text,
      parts: normalized.parts,
      images: normalized.images,
      at: normalized.at,
    }
  }

  function snapshot() {
    const bridge = bridgeConfig()
    return {
      bridgeConfigPath: bridgePath,
      bridgeMissing: bridge._missing === true,
      // 当前实际用的是哪条通道。界面据此显示"由 AstrBot 转发"还是"由 QQ 桥直连"。
      transport: transportMode(),
      napCat: bridge.NapCat,
      masterSwitch: bridge.总开关 === true,
      trial: bridge.试运行 === true,
      targetSession: String(bridge.目标会话 || ''),
      privateQQ: String(bridge.私聊QQ || ''),
      group: String(bridge.群号 || ''),
      toPrivate: bridge.转私聊 !== false,
      toGroup: bridge.转群 === true,
      // 图片方向与限额：面板要能据此展示"能不能收/发图"
      receiveImages: bridge.收图 !== false,
      sendImages: bridge.发图 !== false,
      maxImages: Number(bridge.单条最多图) || 4,
      maxImageMB: Number(bridge.单张最大MB) || 5,
      imageRoot: String(bridge.图片根目录 || ''),
      ownerTitle: String(bridge.称呼 || '主人'),
    }
  }

  /**
   * 改桥的总开关 / 试运行。这两个是"安全开关"，鱼世界可以代主人拨动，
   * 但只允许这两个键，不接受任意 patch。
   */
  function setSafetySwitch(name, value) {
    if (name !== '总开关' && name !== '试运行') throw new Error('只允许切换总开关与试运行')
    return writeBridgeKey(name, value === true)
  }

  /**
   * 面板上「账号情况」那几行要能直接改：发送到（私聊/群）、目标会话、图片收/发。
   *
   * 这里刻意只开**白名单**，不是「任意 patch」：
   *   · 只允许这几个键，别的一律拒绝（NapCat 地址、token 之类不该从面板改）；
   *   · 群号必须是纯数字，长度合理 —— 写错一个号就是发给陌生人；
   *   · 每次只改被点的那一个键，其它字段原样保留（桥是别人的配置，不许整份覆盖）。
   * 主人私聊号与目标会话不在这里改：那是「谁是主人」，属于 setOwner（fish/profile）的职责。
   */
  const BRIDGE_EDITABLE = {
    转私聊: 'boolean',
    转群: 'boolean',
    群号: 'digits',
    收图: 'boolean',
    发图: 'boolean',
  }

  function setBridgeField(name, value) {
    const key = String(name || '')
    const kind = BRIDGE_EDITABLE[key]
    if (!kind) throw new Error(`这个配置项不允许从面板修改：${key || '（空）'}`)
    if (kind === 'boolean') return writeBridgeKey(key, value === true)
    // digits：群号。空字符串是合法的，意思是「不发到群」。
    const digits = String(value == null ? '' : value).replace(/\D/g, '')
    if (digits && !/^\d{5,12}$/.test(digits)) throw new Error(`群号不合法：${String(value).slice(0, 20)}`)
    return writeBridgeKey(key, digits)
  }

  function readBridgeRaw() {
    if (!existsSync(bridgePath)) throw new Error('找不到 QQ 桥配置文件：' + bridgePath)
    try {
      return JSON.parse(readFileSync(bridgePath, 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      throw new Error('QQ 桥配置解析失败：' + error.message)
    }
  }

  /** 只改一个键再写回，别的字段原样保留（桥是别人的配置，不许整份覆盖）。 */
  function writeBridgeKey(key, value) {
    const raw = readBridgeRaw()
    raw[key] = value
    writeFileSync(bridgePath, JSON.stringify(raw, null, 2), 'utf8')
    return snapshot()
  }

  /**
   * 设「主人」：私聊号 + 目标会话。
   *
   * 这是主人绑定的真源（世界设置与关系表里的 owner 只是影子，下次进工作区自动跟过来）。
   * 所以只能从「鱼的设定 → 主人」里改，并且：
   *   · 主人私聊号必须是数字 QQ 号，写进去就代表鱼把它当主人；
   *   · 目标会话必须是一个**真实存在**的 DSH 会话 id —— 2026-10-25 真断过一次，
   *     世界设置里的 ownerSession 指向的会话在会话目录里已经不存在，日记/请求/成长全空。
   * 校验由调用方做（它才拿得到会话清单），这里只如实写盘，写失败就抛。
   */
  function setOwnerBinding({ privateQQ, targetSession } = {}) {
    const owner = String(privateQQ == null ? '' : privateQQ).trim()
    const session = String(targetSession == null ? '' : targetSession).trim()
    if (owner && !/^\d{5,12}$/.test(owner)) throw new Error('主人私聊号要填数字 QQ 号')
    const patch = {}
    if (privateQQ != null) patch['私聊QQ'] = owner
    if (targetSession != null) patch['目标会话'] = session
    if (!Object.keys(patch).length) throw new Error('没有要改的内容')
    const raw = readBridgeRaw()
    for (const [key, value] of Object.entries(patch)) raw[key] = value
    writeFileSync(bridgePath, JSON.stringify(raw, null, 2), 'utf8')
    return snapshot()
  }

  return {
    bridgePath,
    bridgeConfig,
    call,
    send,
    sendTextBatch,
    recentSent,
    sendImage,
    sendSticker,
    poke,
    loginInfo,
    recent,
    forward,
    quote,
    groupNotices,
    snapshot,
    setSafetySwitch,
    setBridgeField,
    setOwnerBinding,
    parseChatKey,
    resolveTargets,
    // chatTargets 不在这里导出：能聊哪些目标是「鱼的关系」的事，
    // 由 world.chatTargets() 一处提供（index.js 把它当 chatSource 传进来）。
    isMuted,
  }
}

/** 把多次发送回执合并成一个。 */
function mergeReceipts(receipts) {
  const list = (Array.isArray(receipts) ? receipts : [receipts]).filter(Boolean)
  const sent = list.flatMap((item) => (Array.isArray(item.sent) ? item.sent : []))
  const failed = list.flatMap((item) => (Array.isArray(item.failed) ? item.failed : []))
  const dryRun = list.length > 0 && list.every((item) => item.dryRun === true)
  return {
    ok: list.length > 0 && list.every((item) => item.ok === true),
    dryRun,
    reason: dryRun ? (list.find((item) => item.reason)?.reason || 'dry-run') : (list.find((item) => !item.ok)?.reason || ''),
    sent,
    failed,
  }
}
