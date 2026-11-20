// 聊天动作补齐（2026-11-20 主人列了七项）。
//
// 已具备、本模块不重复造：发文字 / 发图片 / 发表情包 / 发说说 / 评论说说。
// 本模块只管这七件「一句话就能做的日常动作」：
//   1. 回复引用（reply 段）
//   2. @ 某人（at 段，只群聊）
//   3. 撤回自己的消息（delete_msg，限 2 分钟）
//   4. 拍一拍（send_poke）
//   5. 点赞名片（send_like，同一人每天 1 次）
//   6. 改群名片 / 头衔（set_group_card / set_group_special_title）
//   7. 贴表情回应（set_msg_emoji_like，每条消息 1 次）
//
// ── 三条统一要求（主人定的）──
//   · 全部走同一条出站闸（checkAction：时段 / 额度 / 群闸 / 敏感）；
//   · 每个动作记 activity（kind=poke/like/recall/emoji/card），面板能查；
//   · 失败必须回一句人话，不许静默。
//
// ── 明确不做（高危动作单独走确认，不在本单）──
//   @全体 / 踢人 / 禁言 / 退群 / 加好友。
//
// ── 第 1、2 项为什么不单独做接口 ──
//   `reply` 和 `at` 的**段构造早就支持了**（qq.mjs 的 toOneBotSegment），
//   缺的不是能力，是「什么时候该带」的判断。所以这里做成
//   `withQuote()` / `withAt()` 两个**装饰函数**：给普通发送包一层，
//   而不是另开一条发送路径（另开路径会绕过出站闸，也会让"一条只发一次"的约定失守）。

/** 拍一拍频控：同一人 10 分钟最多 1 次。 */
export const POKE_WINDOW_MS = 10 * 60 * 1000
/** 点赞频控：同一人每天最多 1 次。 */
export const LIKE_WINDOW_MS = 24 * 60 * 60 * 1000
/** 撤回窗口：只在 2 分钟内的自己的消息可撤。 */
export const RECALL_WINDOW_MS = 2 * 60 * 1000
/** 贴表情频控窗口：同一条消息只能贴一次（用超长窗口表达「一次性」）。 */
const EMOJI_WINDOW_MS = 24 * 60 * 60 * 1000

function numOr(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * 从 `qq.send` 的返回值里取出所有 msgId。
 *
 * ★ 为什么单独抽出来（2026-11-20 真机踩的坑）：
 *   `qq.send` 的返回是 `{ ok, dryRun, reason, sent: [{ msgId, ... }], failed, targets }`
 *   —— **msgId 不在顶层**。第一版在 index.js 里写 `r.msgId`，永远取不到值，
 *   结果撤回一直回「那条不是我发的」。
 *   抽成纯函数才能被判据用**真实形状**钉住，而不是只查源码里有没有那行字。
 *
 * @param {any} result qq.send 的返回值
 * @returns {string[]} 本次发出去的消息 id（可能多条）
 */
export function msgIdsOf(result) {
  const list = result && Array.isArray(result.sent) ? result.sent : []
  const out = []
  for (const one of list) {
    const id = one && one.msgId
    if (id != null && String(id).trim()) out.push(String(id).trim())
  }
  return out
}

/**
 * @param {object} deps
 * @param {object} deps.qq          qq 模块（call / send / poke）
 * @param {object} deps.gate        outbound-gate（checkAction / noteSent）
 * @param {object} deps.activity    activity store（append）
 * @param {() => object} [deps.config]  取设置
 * @param {() => number} [deps.now]
 * @param {(line:string)=>void} [deps.log]
 */
export function createChatActions({ qq, gate, activity, config, now = () => Date.now(), log } = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  const cfg = () => { try { return (typeof config === 'function' ? config() : config) || {} } catch { return {} } }

  // ── 频控状态（进程内，重启清零；这类日常动作不需要跨重启记忆）──
  const pokeAt = new Map()     // userId → 上次戳的毫秒
  const likeAt = new Map()     // userId → 上次赞的毫秒
  const emojiAt = new Map()    // messageId → 上次贴表情的毫秒
  // 自己发过哪些消息（撤回要用）：messageId → { chatKey, at, text }
  const ownMessages = new Map()
  const OWN_LIMIT = 100

  function act(kind, { chatKey = '', text = '', ref = '', tone = '' } = {}) {
    try {
      activity?.append?.({ platform: 'qq', kind, actor: 'fish', text: String(text || '').slice(0, 200), ref: String(ref || ''), tone: String(tone || '') })
    } catch {}
    logger(`[${kind}] ${text}`)
  }

  /** 记住自己发出去的消息（撤回要用）。 */
  function noteOwn({ chatKey, messageId, text }) {
    const id = String(messageId || '').trim()
    if (!id) return
    ownMessages.set(id, { chatKey: String(chatKey || ''), at: now(), text: String(text || '').slice(0, 80) })
    while (ownMessages.size > OWN_LIMIT) {
      const first = ownMessages.keys().next().value
      ownMessages.delete(first)
    }
  }
  /** 统一的闸：不过就说人话。 */
  function passGate({ chatKey, kind, label }) {
    try {
      if (!gate || typeof gate.checkAction !== 'function') return { ok: true }
      return gate.checkAction({ chatKey, kind, label })
    } catch { return { ok: true } }
  }

  // ───────────────────────── 1. 回复引用 ─────────────────────────

  /**
   * 给一条要发的消息加上引用（reply 段放第一个）。
   *
   * ★ 主人要求：「她回的这句明显是接某条具体消息时才带；普通聊天不带，别每条都引用。」
   *   所以这是个**装饰器**，不是默认行为 —— 调用方自己判断该不该带。
   */
  function withQuote(segments, messageId) {
    const id = String(messageId || '').trim()
    if (!id) return segments
    const list = Array.isArray(segments) ? segments : [segments]
    // reply 必须在第一个段，否则 OneBot 不认
    return [{ type: 'reply', id }, ...list]
  }

  // ───────────────────────── 2. @ 某人 ─────────────────────────

  /**
   * 给消息加 @（at 段 + 一个空格）。
   *
   * ★ 只群聊用；不 @ 全体（那是高危动作，单独走确认）。
   */
  function withAt(segments, targetQQ, { chatKey = '' } = {}) {
    const qqId = String(targetQQ || '').trim()
    if (!qqId) return segments
    // @全体 是高危动作，这里直接拒绝 —— 不让它从这条口子溜过去
    if (qqId === 'all' || qqId === '0') {
      throw new Error('@全体是高危动作，不在日常动作里；要走确认')
    }
    if (!String(chatKey).startsWith('group:')) {
      throw new Error('只有群聊能 @ 人')
    }
    const list = Array.isArray(segments) ? segments : [segments]
    // at 段后面跟一个空格，不然会紧贴正文
    return [{ type: 'at', qq: qqId }, { type: 'text', text: ' ' }, ...list]
  }

  // ───────────────────────── 3. 撤回 ─────────────────────────

  /**
   * 撤回自己发的一条消息。
   *
   * 三条约束（主人要求）：
   *   · 只允许撤她自己发的；
   *   · 限 2 分钟内；
   *   · 撤完说一句「撤了」。
   */
  async function recall({ chatKey = '', messageId = '' } = {}) {
    const id = String(messageId || '').trim()
    if (!id) return { ok: false, say: '要撤哪条？给我消息号' }

    const own = ownMessages.get(id)
    if (!own) {
      // ★ 这是安全边界：不认识的 id 一律不撤（可能撤掉别人的）
      return { ok: false, say: '那条不是我发的，不能撤' }
    }
    const 龄 = now() - own.at
    if (龄 > RECALL_WINDOW_MS) {
      return { ok: false, say: '超过 2 分钟了，撤不回来了' }
    }

    const g = passGate({ chatKey: chatKey || own.chatKey, kind: 'recall', label: '撤回消息' })
    if (!g.ok) return { ok: false, say: `现在不能撤：${g.reason}` }

    let r = null
    try {
      r = await qq.call('delete_msg', { message_id: id })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || r?.data?.message || '').slice(0, 80)
      act('recall', { chatKey: chatKey || own.chatKey, text: `撤回失败：${own.text}`, ref: id, tone: 'failed' })
      return { ok: false, say: '撤不掉，可能已经超时了' + (why ? `（${why}）` : '') }
    }
    ownMessages.delete(id)
    act('recall', { chatKey: chatKey || own.chatKey, text: `撤回了「${own.text}」`, ref: id })
    return { ok: true, say: '撤了' }
  }

  // ───────────────────────── 4. 拍一拍 ─────────────────────────

  /**
   * 拍一拍。
   * 频控：同一人 10 分钟最多 1 次。失败给人话（「戳不动，可能对方关了」）。
   */
  async function poke({ chatKey = '', userId = '', groupId = '' } = {}) {
    const uid = String(userId || '').trim()
    if (!uid) return { ok: false, say: '要戳谁？给我 QQ 号' }

    const last = pokeAt.get(uid) || 0
    const 剩 = POKE_WINDOW_MS - (now() - last)
    if (last && 剩 > 0) {
      const 分 = Math.ceil(剩 / 60000)
      return { ok: false, say: `刚戳过，${分} 分钟后才能再戳同一个` }
    }

    const g = passGate({ chatKey, kind: 'poke', label: '拍一拍' })
    if (!g.ok) return { ok: false, say: `现在不能戳：${g.reason}` }

    let r = null
    try {
      r = await qq.poke(chatKey, { userId: uid, groupId })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || r?.reason || '').slice(0, 80)
      act('poke', { chatKey, text: `戳 ${uid} 失败`, ref: uid, tone: 'failed' })
      return { ok: false, say: '戳不动，可能对方关了' + (why ? `（${why}）` : '') }
    }
    pokeAt.set(uid, now())
    act('poke', { chatKey, text: `戳了戳 ${uid}`, ref: uid })
    return { ok: true, say: '戳了' }
  }

  // ───────────────────────── 5. 点赞 ─────────────────────────

  /**
   * 给名片点赞。同一人每天最多 1 次；只对聊过的人用。
   */
  async function like({ userId = '', chatKey = '' } = {}) {
    const uid = String(userId || '').trim()
    if (!uid) return { ok: false, say: '要给谁点赞？给我 QQ 号' }

    const last = likeAt.get(uid) || 0
    const 剩 = LIKE_WINDOW_MS - (now() - last)
    if (last && 剩 > 0) {
      const 时 = Math.max(1, Math.ceil(剩 / 3600000))
      return { ok: false, say: `${时} 小时后才能再给同一个人点赞` }
    }

    const g = passGate({ chatKey, kind: 'like', label: '点赞' })
    if (!g.ok) return { ok: false, say: `现在不能点：${g.reason}` }

    let r = null
    try {
      r = await qq.call('send_like', { user_id: uid, times: 1 })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || '').slice(0, 80)
      act('like', { chatKey, text: `给 ${uid} 点赞失败`, ref: uid, tone: 'failed' })
      return { ok: false, say: '赞不上去' + (why ? `（${why}）` : '') }
    }
    likeAt.set(uid, now())
    act('like', { chatKey, text: `给 ${uid} 点了个赞`, ref: uid })
    return { ok: true, say: '赞了' }
  }

  // ───────────────────────── 6. 群名片 / 头衔 ─────────────────────────

  /**
   * 改**她自己**的群名片。不改别人。
   */
  async function setCard({ chatKey = '', groupId = '', card = '' } = {}) {
    const gid = String(groupId || (String(chatKey).startsWith('group:') ? String(chatKey).slice(6) : '')).trim()
    if (!gid) return { ok: false, say: '要在群里才能改群名片' }
    const 文本 = String(card || '').trim()
    if (!文本) return { ok: false, say: '名片要改成什么？' }

    const g = passGate({ chatKey, kind: 'card', label: 文本 })
    if (!g.ok) return { ok: false, say: `现在不能改：${g.reason}` }

    // 自己的号：从登录信息拿（不硬编码，也不猜）
    let selfId = ''
    try {
      const info = await qq.loginInfo?.()
      selfId = String(info?.userId || info?.user_id || '').trim()
    } catch {}
    if (!selfId) return { ok: false, say: '不知道自己 QQ 号，改不了名片' }

    let r = null
    try {
      r = await qq.call('set_group_card', { group_id: gid, user_id: selfId, card: 文本 })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || '').slice(0, 80)
      act('card', { chatKey, text: `改群名片为「${文本}」失败`, ref: gid, tone: 'failed' })
      return { ok: false, say: '改不了' + (why ? `（${why}）` : '') }
    }
    act('card', { chatKey, text: `群名片改成「${文本}」`, ref: gid })
    return { ok: true, say: `名片改成「${文本}」了` }
  }

  /**
   * 改群头衔。需要管理员权限 —— **失败要如实说没权限**（主人点名要求）。
   */
  async function setTitle({ chatKey = '', groupId = '', title = '' } = {}) {
    const gid = String(groupId || (String(chatKey).startsWith('group:') ? String(chatKey).slice(6) : '')).trim()
    if (!gid) return { ok: false, say: '要在群里才能改头衔' }
    const 文本 = String(title || '').trim()
    if (!文本) return { ok: false, say: '头衔要改成什么？' }

    const g = passGate({ chatKey, kind: 'card', label: 文本 })
    if (!g.ok) return { ok: false, say: `现在不能改：${g.reason}` }

    let selfId = ''
    try {
      const info = await qq.loginInfo?.()
      selfId = String(info?.userId || info?.user_id || '').trim()
    } catch {}
    if (!selfId) return { ok: false, say: '不知道自己 QQ 号，改不了头衔' }

    let r = null
    try {
      r = await qq.call('set_group_special_title', { group_id: gid, user_id: selfId, special_title: 文本 })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || '').slice(0, 100)
      act('card', { chatKey, text: `改头衔为「${文本}」失败`, ref: gid, tone: 'failed' })
      // ★ 主人点名：「失败要如实说没权限」—— 不要含糊成「改不了」
      return { ok: false, say: '改不了头衔：我不是管理员' + (why ? `（${why}）` : '') }
    }
    act('card', { chatKey, text: `头衔改成「${文本}」`, ref: gid })
    return { ok: true, say: `头衔改成「${文本}」了` }
  }

  // ───────────────────────── 7. 贴表情 ─────────────────────────

  /**
   * 给某条消息贴一个表情回应。
   *
   * 用在「只想应一声、不想发一条消息」的场合；每条消息最多贴一次。
   *
   * ★ 私聊不支持（2026-11-20 真机实证）：SnowLuma 内部明确拒绝
   *   `emoji reactions are not supported on private messages` —— 这是 QQ 的限制。
   *   所以**在调接口之前**就说清楚，不让它白跑一趟再给个没头没脑的失败。
   */
  async function emoji({ chatKey = '', messageId = '', emojiId = '' } = {}) {
    const mid = String(messageId || '').trim()
    const eid = String(emojiId || '').trim()
    if (!mid) return { ok: false, say: '要贴哪条消息？给我消息号' }
    if (!eid) return { ok: false, say: '贴哪个表情？给我表情 id' }

    // 私聊没有表情回应（QQ 侧限制）—— 提前说，别等失败
    if (!String(chatKey).startsWith('group:')) {
      return { ok: false, say: '私聊没有表情回应，只有群里能贴' }
    }

    const last = emojiAt.get(mid) || 0
    if (last && now() - last < EMOJI_WINDOW_MS) {
      return { ok: false, say: '这条已经贴过了' }
    }

    const g = passGate({ chatKey, kind: 'emoji', label: '贴表情' })
    if (!g.ok) return { ok: false, say: `现在不能贴：${g.reason}` }

    let r = null
    try {
      r = await qq.call('set_msg_emoji_like', { message_id: mid, emoji_id: eid })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || r?.data?.wording || r?.data?.message || '').slice(0, 80)
      act('emoji', { chatKey, text: `贴表情失败`, ref: mid, tone: 'failed' })
      // 真机上 SnowLuma 会把原因吞掉（ok=false 且 data 为空），
      // 所以兜一句可能是为什么，别只给「贴不上」三个字。
      return { ok: false, say: '贴不上' + (why ? `（${why}）` : '（可能这条消息太旧了，或者表情不可用）') }
    }
    emojiAt.set(mid, now())
    act('emoji', { chatKey, text: `贴了个表情 ${eid}`, ref: mid })
    return { ok: true, say: '贴上了' }
  }

  /** 排查用：现在记得哪些自己的消息（撤回能撤哪些）。 */
  function ownSnapshot(limit = 10) {
    const list = [...ownMessages.entries()]
      .map(([id, v]) => ({ messageId: id, ...v, ageMs: now() - v.at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
    return list
  }

  return {
    withQuote,
    withAt,
    noteOwn,
    recall,
    poke,
    like,
    setCard,
    setTitle,
    emoji,
    ownSnapshot,
    // 常量也导出去，面板/判据能直接用
    POKE_WINDOW_MS,
    LIKE_WINDOW_MS,
    RECALL_WINDOW_MS
  }
}