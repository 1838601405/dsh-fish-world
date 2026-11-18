// 双阶连携（herframe 设计移植）。
//
// 要解决的问题：同一个人连着发几条时，现有攒批是「安静窗口后整批投」，
// 但她不知道「这几句是被补进来的」——于是可能只回第一句，或者把补充当新问题。
//
// 这一层只做三件事（不改攒批本身）：
//   1. **入口攒 1.2 秒**（硬顶 3 秒）：给「他还在打字」留半步。
//   2. **发话前认领补充的句子**：把后进来的句子标成「补充」，如实告诉她是补的。
//   3. **带图/视频的补充不吸收**：图不是「补一句话」，那是新内容，
//      吸收进来会让「补了 2 句」变成「补了 2 句 + 3 张图」，她分不清该回应哪个。
//
// ★ 为什么不直接改 qq-inbox 的 readyToFlush：
//   那条路径上压着几十条判据（安静窗口/未说完/上限/失败重试/游标）。
//   这里做成**纯函数 + 小状态机**，由调用方在合适的位置问一句「现在该投了吗」，
//   攒批本身的语义一个字不动。

/** 入口攒：同人连发时等这么久，给他补字的机会。 */
export const LINK_QUIET_MS = 1200

/** 硬顶：等再久也不等了（防止一直有零碎消息导致永远不开口）。 */
export const LINK_HARD_CAP_MS = 3000

/**
 * 判断这一桶现在该不该投。
 *
 * @param {object} batch  { firstAt, lastAt, messages }
 * @param {number} [at]   当前时刻
 * @returns {{flush:boolean, reason:string, waitedMs:number}}
 */
export function linkDecision(batch, at = Date.now()) {
  const firstAt = Number(batch && batch.firstAt) || 0
  const lastAt = Number(batch && batch.lastAt) || firstAt
  if (!firstAt) return { flush: false, reason: 'empty', waitedMs: 0 }
  const waited = Math.max(0, at - firstAt)
  const quiet = Math.max(0, at - lastAt)

  // 硬顶优先：等太久就投，不管安静窗口
  if (waited >= LINK_HARD_CAP_MS) {
    return { flush: true, reason: 'hard-cap', waitedMs: waited }
  }
  // 安静够了（1.2 秒没新消息）就投
  if (quiet >= LINK_QUIET_MS) {
    return { flush: true, reason: 'quiet', waitedMs: waited }
  }
  return { flush: false, reason: 'waiting', waitedMs: waited }
}

/** 这条消息是不是「带图/带视频」——那种不吸收成补充。 */
export function hasMedia(message) {
  if (!message || typeof message !== 'object') return false
  if (Array.isArray(message.images) && message.images.length) return true
  if (Array.isArray(message.videos) && message.videos.length) return true
  if (Array.isArray(message.parts)) {
    return message.parts.some((p) => p && (p.kind === 'image' || p.kind === 'mface' || p.kind === 'face' || p.kind === 'video'))
  }
  return false
}

/**
 * 把这一桶拆成「主句」和「补充句」。
 *
 * 规则：
 *   · 第一条主句（决定「她在回什么」）；
 *   · 后面同一人发、且**不带图/视频**的纯文字 → 补充；
 *   · 带图/视频的、换了人说的 → 不算补充（它们是独立内容，交回原有合并逻辑）。
 *
 * @returns {{main:object|null, supplements:object[], others:object[]}}
 */
export function splitSupplements(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : []
  if (!list.length) return { main: null, supplements: [], others: [] }
  const main = list[0]
  const mainSpeaker = String(main.userId == null ? '' : main.userId)
  const supplements = []
  const others = []
  for (let i = 1; i < list.length; i++) {
    const m = list[i]
    const sameSpeaker = String(m.userId == null ? '' : m.userId) === mainSpeaker
    if (!sameSpeaker) { others.push(m); continue }
    if (hasMedia(m)) { others.push(m); continue }
    supplements.push(m)
  }
  return { main, supplements, others }
}

/**
 * 生成「如实告知被补了句子」的那一行。
 *
 * ★ 为什么要如实说：不说的话她会把补充当成新的独立提问，
 *   于是回一句「嗯？」或者干脆只接最后一句，前面那句就丢了。
 *   说了之后**由她自己决定**改写/照发/不说——这里不替她决定。
 */
export function supplementNotice(supplements) {
  const list = (Array.isArray(supplements) ? supplements : []).filter(Boolean)
  if (!list.length) return ''
  const texts = list
    .map((m) => String(m && m.text != null ? m.text : '').trim())
    .filter(Boolean)
  if (!texts.length) return ''
  const quoted = texts.map((t) => '「' + (t.length > 60 ? t.slice(0, 60) + '…' : t) + '」').join('')
  return `〔他在这之后又补了 ${texts.length} 句：${quoted}。`
    + '这些是补充，不是新问题：你可以把前面那句改一下一起回，也可以只回补充的那点，'
    + '如果觉得没必要接就照原样回，不用特意提「你补了」。〕'
}

/**
 * 连携状态机：按 chatKey 记住「这一桶是何时开始的」。
 * 只读不写磁盘——这是进程内的短命状态，重启就没了，正好。
 */
export function createLinkTracker({ quietMs = LINK_QUIET_MS, hardCapMs = LINK_HARD_CAP_MS, now = () => Date.now() } = {}) {
  const buckets = new Map()

  function touch(chatKey, message) {
    const key = String(chatKey || '')
    if (!key) return null
    const at = now()
    const cur = buckets.get(key)
    if (!cur) {
      const b = { firstAt: at, lastAt: at, messages: [message].filter(Boolean), absorbed: 0 }
      buckets.set(key, b)
      return b
    }
    // 带图/视频的不吸收成「补充」，但要记进去（它是这一轮的内容）
    if (message) {
      cur.messages.push(message)
      if (hasMedia(message)) cur.absorbed += 0
      else cur.absorbed += 1
    }
    cur.lastAt = at
    return cur
  }

  function decide(chatKey) {
    const key = String(chatKey || '')
    const b = buckets.get(key)
    if (!b) return { flush: false, reason: 'empty', waitedMs: 0 }
    const at = now()
    const waited = Math.max(0, at - b.firstAt)
    const quiet = Math.max(0, at - b.lastAt)
    if (waited >= hardCapMs) return { flush: true, reason: 'hard-cap', waitedMs: waited }
    if (quiet >= quietMs) return { flush: true, reason: 'quiet', waitedMs: waited }
    return { flush: false, reason: 'waiting', waitedMs: waited }
  }

  function take(chatKey) {
    const key = String(chatKey || '')
    const b = buckets.get(key) || null
    buckets.delete(key)
    return b
  }

  function peek(chatKey) {
    return buckets.get(String(chatKey || '')) || null
  }

  function size() { return buckets.size }

  return { touch, decide, take, peek, size }
}
