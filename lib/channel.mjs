// 通道契约（2026-11-23 主人《发给 AI.md》任务二 ①：入口 = 通道）。
//
// ── 为什么做这一层 ──
// 「多端不是做 UI，是把**以后不做就得拆**的地基先埋下」。
// 现在「收」在 `qq-inbox.mjs`（5 处直接调 `deliver(payload)`）、
// 「发」在 `index.js`（`deliverViaChatApi` / `deliverToSession` / `deliverAny`），
// 平台判断散在各处 —— 以后加第二个端（手机 / 桌面 / orb）就得把 QQ 的假设抄一遍。
//
// 这一层**只做契约**：每个通道实现「收」和「发」两个函数，中间是同一套内核。
// ★ **不是从零写**：`lib/delivery-router.mjs` 的三阶段（会话优先 → API 兜底 → 记失败）
//   就是路由雏形，本层把它收拢进契约（`route` 是内核的一环，不属于任何通道）。
//
// ── 契约 ──
//   通道 = { id, receive(msg) → 归一后的内部消息, send(reply) → 平台动作 }
//   · **归一**（receive）：平台自己的形状 → 内核的内部消息
//   · **投递**（send）：内核的回包 → 平台自己的动作
//   · 内核**只认 registry**，不认识 qq / panel / mobile / orb（加通道不改内核）
//
// ── 边界（明确不做）──
//   不做：手机 UI、账号体系、跨设备同步协议（《发给 AI.md》原话）。
//   ②③④（会话记角色、v1 接口圈定、鉴权骨架）**本轮不做**，只登记。

import { createHash } from 'node:crypto'

/**
 * 内部消息的统一形状（内核认这个，不认平台形状）。
 *
 * @typedef {object} InternalMessage
 * @property {string}   channelId  来源通道 id（如 'qq'）
 * @property {string}   chatKey    会话键（内部唯一，如 'group:123' / 'private:456'）
 * @property {string}   text       正文
 * @property {string}   [userId]   对方 id
 * @property {string}   [nickname] 对方昵称
 * @property {Array}    [parts]    附件等结构化部分（各通道自己的形状，内核只透传）
 * @property {number}   [at]       收到时间戳
 */

/**
 * 一个通道要提供什么。
 *
 * @typedef {object} Channel
 * @property {string} id                 通道 id（唯一）
 * @property {(msg:any, ctx?:object) => Promise<InternalMessage>} [receive]
 *           **收**：平台形状 → 内部消息。不实现 = 只发不收
 * @property {(reply:any, ctx?:object) => Promise<object>} [send]
 *           **发**：内部回包 → 平台动作。不实现 = 只收不发
 * @property {boolean} [passive]         被动通道（如桌面面板：只收不发，或只发不收）
 */

/** 通道 id 的合法形态（防注入：id 会进日志/文件名）。 */
const ID_RE = /^[a-z][a-z0-9_-]{0,23}$/

/**
 * 通道注册表：内核唯一认识的入口。
 *
 * ★ 内核**只通过 registry** 收发 —— 加一个通道 = 注册一次，**内核代码一行不动**
 *   （这就是《发给 AI.md》验收 2 的判据）。
 */
export function createChannelRegistry({ logger } = {}) {
  /** @type {Map<string, Channel>} */
  const channels = new Map()
  const log = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : () => {}

  /**
   * 注册一个通道。
   * @param {Channel} channel
   * @returns {{ok:boolean, error?:string}}
   */
  function register(channel) {
    const id = String(channel?.id || '')
    if (!ID_RE.test(id)) {
      const error = `通道 id 不合法：「${id}」（要小写字母开头，字母数字/下划线/连字符，≤24）`
      log(`fish-world: ${error}`)
      return { ok: false, error }
    }
    if (channels.has(id)) {
      const error = `通道「${id}」已注册`
      log(`fish-world: ${error}`)
      return { ok: false, error }
    }
    if (typeof channel.receive !== 'function' && typeof channel.send !== 'function') {
      const error = `通道「${id}」既没有 receive 也没有 send（至少要有一个）`
      log(`fish-world: ${error}`)
      return { ok: false, error }
    }
    channels.set(id, channel)
    return { ok: true }
  }

  function get(id) {
    return channels.get(String(id || '')) || null
  }

  function has(id) {
    return channels.has(String(id || ''))
  }

  function list() {
    return [...channels.keys()].sort()
  }

  /**
   * **收**：平台消息 → 内部消息。
   * @param {string} id 通道 id
   * @param {any} raw 平台形状
   * @param {object} [ctx] 通道自己的上下文
   */
  async function receive(id, raw, ctx) {
    const ch = get(id)
    if (!ch) return { ok: false, error: `没有这个通道：${id}` }
    if (typeof ch.receive !== 'function') return { ok: false, error: `通道「${id}」不收（只有发）` }
    try {
      const msg = await ch.receive(raw, ctx)
      if (!msg || typeof msg !== 'object') {
        return { ok: false, error: `通道「${id}」的 receive 没给出内部消息` }
      }
      // 归一后的 channelId 必须与注册 id 一致（内核按 id 找通道，串了就错）
      return { ok: true, message: { ...msg, channelId: id } }
    } catch (error) {
      return { ok: false, error: `通道「${id}」收失败：${error?.message || error}` }
    }
  }

  /**
   * **发**：内部回包 → 平台动作。
   *
   * ★ **成功时直接返回通道自己的结果，不包一层** —— 验收 1 要求「QQ 那条路的输出
   *   与改动前逐字节一致」。`qq-inbox` 里是 `sent = await deliver(payload)` 用返回值的，
   *   包一层就改了形状。通道自己抛错时才返回 `{ok:false,error}`（那是**错误**，不是结果）。
   *
   * @param {string} id 通道 id
   * @param {any} reply 内部回包
   * @param {object} [ctx]
   */
  async function send(id, reply, ctx) {
    const ch = get(id)
    if (!ch) return { ok: false, error: `没有这个通道：${id}` }
    if (typeof ch.send !== 'function') return { ok: false, error: `通道「${id}」不发（只有收）` }
    try {
      // ★ 原样透传：通道成功返回什么就是什么（不包 {ok,result}）
      return await ch.send(reply, ctx)
    } catch (error) {
      return { ok: false, error: `通道「${id}」发失败：${error?.message || error}` }
    }
  }

  return { register, get, has, list, receive, send, size: () => channels.size }
}

/**
 * 造一个**只 echo 的假通道**（《发给 AI.md》验收 2：能让它完整收发一轮，
 * 且**不需要改内核的任何代码**）。
 *
 * 它把收到什么原样记下来、把发过来的原样回声 —— 于是「收发一轮」能被真断言，
 * 而不用真 QQ、不用真网络。
 *
 * @param {object} [opts]
 * @param {string} [opts.id] 通道 id（默认 'echo'）
 * @returns {{channel: Channel, received: InternalMessage[], sent: any[]}}
 */
export function createEchoChannel({ id = 'echo' } = {}) {
  const received = []
  const sent = []
  return {
    received,
    sent,
    channel: {
      id,
      async receive(raw) {
        // 归一：把平台形状（这里就是原样）变成内部消息
        const msg = {
          channelId: id,
          chatKey: String(raw?.chatKey || `echo:${raw?.text || ''}`),
          text: String(raw?.text || ''),
          userId: raw?.userId ? String(raw.userId) : '',
          nickname: raw?.nickname ? String(raw.nickname) : '',
          parts: Array.isArray(raw?.parts) ? raw.parts : [],
          at: Number(raw?.at) || Date.now(),
        }
        received.push(msg)
        return msg
      },
      async send(reply) {
        const payload = { ok: true, channel: id, echo: reply }
        sent.push(payload)
        return payload
      },
    },
  }
}

/** 一个内部消息的稳定指纹（测试与排查用；同内容同指纹）。 */
export function messageFingerprint(msg) {
  return createHash('sha256')
    .update(JSON.stringify({ chatKey: msg?.chatKey || '', text: msg?.text || '', userId: msg?.userId || '' }), 'utf8')
    .digest('hex')
    .slice(0, 12)
}
