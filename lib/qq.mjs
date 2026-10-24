// OneBot 11 HTTP 客户端 + dsh-qq-bridge 配置门。
//
// 关键点：适配器不绕过 bridge 的安全开关。默认情况下：
//   总开关关 → 一条都不发；试运行开 → 只返回 dryRun 回执；转私聊/转群关 → 不许发对应目标。
// 需要强制发送时，调用方必须显式传 { force: true }（只有适配器自己的「测试发送」会用）。
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { BRIDGE_CONFIG } from './paths.mjs'
import { readJson, textOf } from './util.mjs'

const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const DEFAULT_BRIDGE = {
  总开关: false,
  试运行: true,
  目标会话: '',
  私聊QQ: '',
  群号: '',
  转私聊: true,
  转群: false,
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

function imageSegmentOf(image, { sandbox = null, trusted = false } = {}) {
  if (!image || typeof image !== 'object') throw new Error('图片参数必须是对象')
  const url = String(image.url || '').trim()
  if (url) return { type: 'image', data: { file: url, url } }

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
    return { type: 'image', data: { file: 'base64://' + b64 } }
  }

  const b64 = base64Of(image.dataUrl || image.base64)
  if (b64) {
    const bytes = Math.floor((b64.length * 3) / 4)
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB`)
    return { type: 'image', data: { file: 'base64://' + b64 } }
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
    return { kind: type, label: SEGMENT_LABELS[type], name: String(data.name || data.file || '') }
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
function normalizeMessage(row, chatKey) {
  const message = row && typeof row === 'object' ? row : {}
  const segments = Array.isArray(message.message) ? message.message
    : Array.isArray(message.content) ? message.content
    : []
  const parts = segments.map(classifySegment).filter(Boolean)
  const text = parts.filter((part) => part.kind === 'text').map((part) => part.text).join('')
  return {
    id: String(message.message_id ?? message.id ?? ''),
    chatKey,
    userId: String(message.user_id ?? message.sender?.user_id ?? ''),
    nickname: String(message.sender?.nickname || message.sender?.card || message.nickname || ''),
    text,
    parts,
    images: segments.filter((seg) => seg && (seg.type === 'image' || seg.type === 'mface')),
    forwards: parts.filter((part) => part.kind === 'forward' && part.id).map((part) => part.id),
    at: Number(message.time ? message.time * 1000 : Date.now()),
  }
}

export function createQQ({ home, config, logger, sandbox }) {
  const qqSandbox = sandbox || null
  const bridgePath = home ? `${home}/qq-bridge-config.json` : BRIDGE_CONFIG

  function bridgeConfig() {
    const raw = readJson(bridgePath, null)
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_BRIDGE, _missing: true }
    return { ...DEFAULT_BRIDGE, ...raw }
  }

  function baseUrl() {
    return String(bridgeConfig().NapCat || DEFAULT_BRIDGE.NapCat).replace(/\/+$/, '')
  }

  async function call(action, body = {}, { timeoutMs } = {}) {
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

  function resolveTargets(chatKey) {
    const bridge = bridgeConfig()
    const parsed = parseChatKey(chatKey)
    const allowForeign = config().qq.allowForeignTargets === true
    const privateQq = String(bridge.私聊QQ || '').trim()
    const groupId = String(bridge.群号 || '').trim()
    const targets = []
    const rejected = []

    const pushPrivate = (id) => {
      const number = toNumber(id)
      if (!number) return rejected.push({ kind: 'private', id, reason: 'bad-id' })
      if (!allowForeign && privateQq && number !== toNumber(privateQq)) {
        return rejected.push({ kind: 'private', id, reason: 'foreign-target' })
      }
      if (bridge.转私聊 === false && !allowForeign) return rejected.push({ kind: 'private', id, reason: 'bridge-private-off' })
      targets.push({ kind: 'private', id: number })
    }
    const pushGroup = (id) => {
      const number = toNumber(id)
      if (!number) return rejected.push({ kind: 'group', id, reason: 'bad-id' })
      if (!allowForeign && groupId && number !== toNumber(groupId)) {
        return rejected.push({ kind: 'group', id, reason: 'foreign-target' })
      }
      if (bridge.转群 === false && !allowForeign) return rejected.push({ kind: 'group', id, reason: 'bridge-group-off' })
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

  async function send(chatKey, segments, options = {}) {
    const gateResult = gate(options)
    if (!gateResult.ok) return { ok: false, reason: gateResult.reason, sent: [], failed: [] }
    if (gateResult.dryRun) {
      const flat = (Array.isArray(segments) ? segments : [segments])
        .map((seg) => (typeof seg === 'string' ? seg : textOf(seg && seg.type === 'text' ? [seg] : [])))
        .filter(Boolean)
        .join('')
      logger?.info?.(`[qq] 试运行，未发送（${gateResult.reason}）：${flat.slice(0, 80)}`)
      return { ok: true, dryRun: true, reason: gateResult.reason, sent: [], failed: [], targets: [] }
    }

    const { targets, rejected } = resolveTargets(chatKey)
    const failed = rejected.map((item) => ({ ...item, error: item.reason }))
    if (!targets.length) return { ok: false, reason: 'no-valid-target', sent: [], failed, targets: [] }

    const normalized = []
    for (const segment of Array.isArray(segments) ? segments : [segments]) {
      const converted = toOneBotSegment(segment, {
        sandbox: qqSandbox,
        trusted: options.trustedLocalPath === true,
      })
      if (converted) normalized.push(converted)
    }
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
    // 表情文件来自插件自己的收藏库或鲸鱼资源，不是模型传入的任意路径。
    return sendImage(chatKey, image, { ...options, trustedLocalPath: true })
  }

  async function poke(chatKey, { groupId, userId } = {}) {
    const parsed = parseChatKey(chatKey)
    const bridge = bridgeConfig()
    const targetGroup = String(groupId || (parsed.kind === 'group' ? parsed.id : '') || bridge.群号 || '').trim()
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
        at: Number(node && node.time ? node.time * 1000 : 0),
      }
    })
    return { ok: true, id: key, entries }
  }

  function snapshot() {
    const bridge = bridgeConfig()
    return {
      bridgeConfigPath: bridgePath,
      bridgeMissing: bridge._missing === true,
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
    if (!existsSync(bridgePath)) throw new Error('找不到 QQ 桥配置文件：' + bridgePath)
    let raw
    try {
      raw = JSON.parse(readFileSync(bridgePath, 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      throw new Error('QQ 桥配置解析失败：' + error.message)
    }
    raw[name] = value === true
    writeFileSync(bridgePath, JSON.stringify(raw, null, 2), 'utf8')
    return snapshot()
  }

  return {
    bridgePath,
    bridgeConfig,
    call,
    send,
    sendTextBatch,
    sendImage,
    sendSticker,
    poke,
    loginInfo,
    recent,
    forward,
    snapshot,
    setSafetySwitch,
    parseChatKey,
    resolveTargets,
  }
}

/** 把多次发送回执合并成一个。 */
export function mergeReceipts(receipts) {
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
