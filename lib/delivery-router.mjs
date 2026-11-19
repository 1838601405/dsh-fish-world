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
// ── 2026-11-20 三处返修（都是"常见场景会打开"的坑）──
//
// 1. **回复口径按时间点，不按"有没有"**
//    旧写法 `hasRecentReply(chatKey)` 只看「这个会话最近发过没有」。
//    后果：她 30 秒前回过**上一句** → 这条新消息的兜底被误取消 → 没人回。
//    现在：投递时刻 T 记进待观察任务，判的是「T 之后有没有发出过」。
//
// 2. **in-flight 判断（防双回）**
//    旧写法投进会话后固定 15 秒计时。后果：需要工具/多轮的回合超过 15 秒
//    → 先兜底 API 回一条，会话随后又回 → 双回。
//    现在：能拿到「会话正在处理」就**不启动**计时，等它空闲了再起；
//    拿不到就把窗口放到 40 秒（可配），且兜底前**再确认一次**。
//
// 3. **异常兜底方向反了**（在 index.js 的 catch 里，见该文件注释）
//    决策链挂掉时退回"没有兜底的会话路径"，等于退回死选项。
//    改成先退 API，再不行才记「投递失败」。

/** 默认兜底窗口：40 秒（主人建议 30–45 秒区间取中）。 */
export const DEFAULT_FALLBACK_MS = 40_000

/**
 * @param {object} deps
 * @param {() => object} deps.services   取宿主服务（agents.get）
 * @param {(msg) => Promise<object>} deps.deliverToSession
 * @param {(msg) => Promise<object>} deps.deliverViaApi
 * @param {(chatKey, sinceMs) => boolean} [deps.hasReplySince]  判断「T 之后发出过没有」
 * @param {(sessionId) => boolean} [deps.isSessionBusy]  会话是否正在处理（in-flight）
 * @param {() => number} [deps.now]
 * @param {(line) => void} [deps.log]
 */
export function createDeliveryRouter({
  services,
  deliverToSession,
  deliverViaApi,
  hasReplySince,
  isSessionBusy,
  now = () => Date.now(),
  log,
  fallbackAfterMs = DEFAULT_FALLBACK_MS
} = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  const aliveCache = new Map()
  /**
   * 等待中的兜底任务：chatKey → { message, sessionId, messageT, timer, started, fired }
   *  - messageT：本条消息的投递时刻，用于按时间点判断回复
   *  - started：计时是否已启动（in-flight 时不启动，等空闲再起）
   */
  const pending = new Map()
  /** 每条消息的处理记录（最近 50 条），给「两条路都发过」留痕。 */
  const records = []

  function record(entry) {
    records.push({ at: new Date(now()).toISOString(), ...entry })
    if (records.length > 50) records.shift()
    // ★ 排障结论必须落 activity（不只是内存里的 records）。
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
    if (hit && at - hit.at < 1000) return hit.alive
    let alive = false
    try {
      const agents = typeof services === 'function' ? services()?.agents : null
      if (agents && typeof agents.get === 'function') {
        const ids = [id, id.startsWith('session-') ? id.slice('session-'.length) : 'session-' + id]
        alive = ids.some((cand) => {
          try { return Boolean(agents.get(cand)) } catch { return false }
        })
      }
    } catch {}
    aliveCache.set(id, { at, alive })
    return alive
  }

  /** 按时间点判「这条消息之后有没有发出过回复」。 */
  function repliedSince(chatKey, sinceMs) {
    if (typeof hasReplySince !== 'function') return false
    try { return Boolean(hasReplySince(chatKey, sinceMs)) } catch { return false }
  }

  /**
   * 决策 + 投递。返回：
   *   { ok, mode: 'session'|'api', reason, fallback, waiting }
   *
   * mode=session 且 waiting=true 表示「已送进会话，正在等它自己回」。
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
      return { ...r, mode: 'api', reason, fallback: false, waiting: false }
    }

    // 规则 1 的另一半：会话活着 → 投进去
    const messageT = now()   // ★ 本条消息的投递时刻
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
      return { ...r, mode: 'api', reason, fallback: false, sessionError: sent?.error, waiting: false }
    }

    record({ chatKey, sessionId, mode: 'session', reason: 'session-alive', ok: true })

    // 规则 2：投进去了，但要观察有没有真回复
    if (!allowFallback) return { ...sent, mode: 'session', fallback: false, waiting: false }
    scheduleFallbackCheck({ message, chatKey, sessionId, messageT })
    return { ...sent, mode: 'session', fallback: false, waiting: true }
  }

  function scheduleFallbackCheck({ message, chatKey, sessionId, messageT }) {
    // 同一个 chatKey 只保留一个待观察任务：连发多条时不该排队兜底多次
    const prev = pending.get(chatKey)
    if (prev?.timer) clearTimeout(prev.timer)
    const entry = { message, sessionId, messageT, timer: null, started: false, fired: false }
    pending.set(chatKey, entry)
    // ★ 返修 2：会话正在处理（in-flight）就不启动计时，等它空闲再起。
    //   否则需要工具/多轮的回合会先被兜底 API 抢答，然后会话又回 → 双回。
    if (typeof isSessionBusy === 'function' && isSessionBusy(sessionId)) {
      record({
        chatKey, sessionId, mode: 'session',
        reason: 'in-flight（等会话处理完再计时，避免长回合被误判超时）', ok: true, waiting: true
      })
      return
    }
    startTimer(chatKey, entry)
  }

  function startTimer(chatKey, entry) {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.fired = true
      runFallbackOnce(chatKey).catch(() => {})
    }, Math.max(1000, Number(fallbackAfterMs) || DEFAULT_FALLBACK_MS))
    entry.timer.unref?.()
  }

  /** 会话处理完了（不再忙）：若有待观察任务且计时没启动，现在启动。 */
  function noteSessionIdle(chatKey) {
    const key = String(chatKey || '')
    const entry = pending.get(key)
    if (!entry || entry.started) return false
    entry.started = true
    startTimer(key, entry)
    record({ chatKey: key, mode: 'session', reason: 'session-idle（开始计时）', ok: true, waiting: true })
    return true
  }

  /** 会话在这个窗口内产出了回复；有就清掉待观察任务。 */
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
   * ★ 只在「这条消息之后确实没回过」时才发；发过就标 fallback 留痕，绝不重复兜底。
   */
  async function runFallbackOnce(chatKey) {
    const key = String(chatKey || '')
    const entry = pending.get(key)
    if (!entry) return { ok: false, skipped: 'no-pending' }
    pending.delete(key)
    // 双保险：按时间点再确认一次（返修 1）
    try {
      if (repliedSince(key, entry.messageT)) {
        record({ chatKey: key, mode: 'session', reason: 'replied-after-window', ok: true, noFallback: true })
        return { ok: false, skipped: 'replied' }
      }
    } catch {}
    const r = await deliverViaApi(entry.message)
    record({
      chatKey: key,
      sessionId: entry.sessionId,
      mode: 'api',
      reason: 'session-no-reply-in-' + Math.round(Math.max(1000, Number(fallbackAfterMs) || DEFAULT_FALLBACK_MS) / 1000) + 's',
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
        messageT: new Date(e.messageT).toISOString(),
        started: e.started,
        waitingMs: now() - e.messageT,
        willFallbackAtMs: Math.max(0,
          (e.started ? Math.max(1000, Number(fallbackAfterMs) || DEFAULT_FALLBACK_MS) : Infinity)
          - (now() - e.messageT)
        )
      })),
      records: records.slice(-20),
      fallbackAfterMs: Number(fallbackAfterMs) || DEFAULT_FALLBACK_MS
    }
  }

  /** 清掉所有计时器（进程退出/测试用）。 */
  function dispose() {
    for (const [, e] of pending) if (e.timer) clearTimeout(e.timer)
    pending.clear()
    aliveCache.clear()
  }

  return {
    deliver,
    sessionAlive,
    noteSessionReply,
    noteSessionIdle,
    runFallbackOnce,
    snapshot,
    dispose,
    fallbackAfterMs: Number(fallbackAfterMs) || DEFAULT_FALLBACK_MS
  }
}
