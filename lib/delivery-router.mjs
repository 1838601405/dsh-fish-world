// 投递决策：会话优先，不在就 API 直回（2026-11-19 主人定）。
//
// 为什么单独成一个模块：
//   原来的 deliverAny 是**静态**判断——只看「有没有绑会话」，不看「会话活不活着」。
//   于是会话关着时会尝试唤醒，唤醒失败就直接返回错误，主人发的消息没人回。
//   这套决策链要同时满足三件事（互相有张力）：
//     · 会话优先（会话里的 agent 有人格/上下文，比裸 API 好）；
//     · 会话不在就立刻兜底，不许排队等；
//     · 一条消息只能被回一次（防双回）。
//
// 三条硬规则：
//   1. **一条消息只走一条路**：投会话成功就不再走 API。
//   2. **投递成功率不等于回复率**：投进会话只是「送到了」，
//      会话里的 agent 可能因为超窗/报错不回。所以要在 N 秒内观察有没有回复，
//      没有才允许 API 兜底**一次**。
//   3. **两条路都发过必须能查到**：日志记下 mode / reason / 是否有兜底。

/** 会话"活着"的判定缓存时长：避免每条消息都问宿主。 */
const ALIVE_CACHE_MS = 1000

/** 投递后等多久没回复才允许兜底（主人建议 15 秒）。 */
export const FALLBACK_AFTER_MS = 15_000

/**
 * @param {object} deps
 * @param {() => object} deps.services   取宿主服务（agents.get）
 * @param {(msg) => Promise<object>} deps.deliverToSession
 * @param {(msg) => Promise<object>} deps.deliverViaApi
 * @param {(chatKey, text) => boolean} [deps.hasRecentReply]  判断这段会话最近有没有产出回复
 * @param {() => number} [deps.now]
 * @param {(line) => void} [deps.log]
 */
export function createDeliveryRouter({
  services,
  deliverToSession,
  deliverViaApi,
  hasRecentReply,
  now = () => Date.now(),
  log
} = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  const aliveCache = new Map()
  /**
   * 等待中的兜底任务：chatKey → { message, sessionId, at, timer, apiMode, apiReason }
   * 会话在窗口内回了就把这条删掉（不兜底）。
   */
  const pending = new Map()
  /** 每条消息的处理记录（最近 50 条），给「两条路都发过」留痕。 */
  const records = []

  function record(entry) {
    records.push({ at: new Date(now()).toISOString(), ...entry })
    if (records.length > 50) records.shift()
    logger(`[deliver] ${entry.chatKey} mode=${entry.mode} reason=${entry.reason || '-'}` +
      (entry.fallback ? ' fallback=yes' : '') +
      (entry.error ? ` error=${String(entry.error).slice(0, 80)}` : ''))
  }

  /** 会话活不活着。带 1 秒缓存，避免每条消息都问宿主。 */
  function sessionAlive(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return false
    const hit = aliveCache.get(id)
    const at = now()
    if (hit && at - hit.at < ALIVE_CACHE_MS) return hit.alive
    let alive = false
    try {
      const agents = typeof services === 'function' ? services()?.agents : null
      if (agents && typeof agents.get === 'function') {
        // 宿主两套 id 形态都要试（session-x / x）
        const ids = [id, id.startsWith('session-') ? id.slice('session-'.length) : 'session-' + id]
        alive = ids.some((cand) => {
          try { return Boolean(agents.get(cand)) } catch { return false }
        })
      }
    } catch {}
    aliveCache.set(id, { at, alive })
    return alive
  }

  /**
   * 决策 + 投递。返回：
   *   { ok, mode: 'session'|'api', reason, fallback, waiting }
   *
   * mode=session 且 waiting=true 表示「已送进会话，正在等它自己回」——
   * 15 秒内没回会自动兜底（如果调用方给了 onFallback）。
   */
  async function deliver(message, options = {}) {
    const chatKey = String(message?.chatKey || '')
    const sessionId = String(message?.sessionId || options.sessionId || '').trim()
    const forceApi = options.forceApi === true
    const allowFallback = options.allowFallback !== false

    // 规则 1：没会话 / 会话不活 → 直接走 API，不排队等
    if (forceApi || !sessionId || !sessionAlive(sessionId)) {
      const reason = forceApi
        ? 'forced'
        : (!sessionId ? 'no-session' : 'session-not-alive')
      const r = await deliverViaApi(message)
      record({ chatKey, sessionId, mode: 'api', reason, ok: r?.ok !== false, error: r?.error })
      // waiting 一律给 false：API 路径是同步回，不存在「等会话」这回事。
      return { ...r, mode: 'api', reason, fallback: false, waiting: false }
    }

    // 规则 1 的另一半：会话活着 → 投进去
    let sent = null
    try {
      sent = await deliverToSession(message)
    } catch (error) {
      sent = { ok: false, error: String(error?.message || error) }
    }

    if (!sent || sent.ok === false) {
      // 投递失败：**立刻**走 API，不排队（主人要求「不许排队等会话活」）
      const reason = 'session-deliver-failed'
      const r = await deliverViaApi(message)
      record({
        chatKey, sessionId, mode: 'api', reason,
        ok: r?.ok !== false, error: r?.error || sent?.error
      })
      return { ...r, mode: 'api', reason, fallback: false, sessionError: sent?.error }
    }

    record({ chatKey, sessionId, mode: 'session', reason: 'session-alive', ok: true })

    // 规则 2：投进去了，但要观察有没有真回复
    if (!allowFallback) return { ...sent, mode: 'session', fallback: false, waiting: false }
    scheduleFallbackCheck({ message, chatKey, sessionId })
    return { ...sent, mode: 'session', fallback: false, waiting: true }
  }

  function scheduleFallbackCheck({ message, chatKey, sessionId }) {
    // 同一个 chatKey 只保留一个待观察任务：连发多条时不该排队兜底多次
    const prev = pending.get(chatKey)
    if (prev?.timer) clearTimeout(prev.timer)
    const entry = { message, sessionId, at: now(), timer: null, fired: false }
    entry.timer = setTimeout(() => {
      entry.fired = true
      runFallbackOnce(chatKey).catch(() => {})
    }, FALLBACK_AFTER_MS)
    entry.timer.unref?.()
    pending.set(chatKey, entry)
  }

  /** 会话在这个窗口内有没有产出回复；有就清掉待观察任务。 */
  function noteSessionReply(chatKey) {
    const key = String(chatKey || '')
    const entry = pending.get(key)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(key)
    record({ chatKey: key, mode: 'session', reason: 'replied-in-window', ok: true, noFallback: true })
    return true
  }

  /**
   * 到点还没回复 → 兜底一次。
   * ★ 只在「确实没回复」时才发；发过就标 fallback 留痕，绝不重复兜底。
   */
  async function runFallbackOnce(chatKey) {
    const key = String(chatKey || '')
    const entry = pending.get(key)
    if (!entry) return { ok: false, skipped: 'no-pending' }
    pending.delete(key)
    // 双保险：调用方若给了 hasRecentReply，再问一次
    try {
      if (typeof hasRecentReply === 'function' && hasRecentReply(key)) {
        record({ chatKey: key, mode: 'session', reason: 'replied-late', ok: true, noFallback: true })
        return { ok: false, skipped: 'replied' }
      }
    } catch {}
    const r = await deliverViaApi(entry.message)
    record({
      chatKey: key,
      sessionId: entry.sessionId,
      mode: 'api',
      reason: 'session-no-reply-in-' + Math.round(FALLBACK_AFTER_MS / 1000) + 's',
      ok: r?.ok !== false,
      fallback: true,
      error: r?.error
    })
    return { ...r, mode: 'api', reason: 'fallback', fallback: true }
  }

  /** 面板/排查用：当前待观察的有几条、最近处理记录。 */
  function snapshot() {
    return {
      waiting: [...pending.entries()].map(([chatKey, e]) => ({
        chatKey,
        sessionId: e.sessionId,
        waitingMs: now() - e.at,
        willFallbackAtMs: Math.max(0, FALLBACK_AFTER_MS - (now() - e.at))
      })),
      records: records.slice(-20),
      fallbackAfterMs: FALLBACK_AFTER_MS
    }
  }

  /** 清掉所有计时器（进程退出/测试用）。 */
  function dispose() {
    for (const [, e] of pending) if (e.timer) clearTimeout(e.timer)
    pending.clear()
    aliveCache.clear()
  }

  return { deliver, sessionAlive, noteSessionReply, runFallbackOnce, snapshot, dispose, FALLBACK_AFTER_MS }
}
