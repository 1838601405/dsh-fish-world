// 主动翻记录（2026-11-20 主人要求二）。
//
// 两个用途：
//   A. **校正记忆**：对方说「上次」「之前」「我说过」「你不记得了」→ 去核对原文；
//   B. **补上下文**：她听不懂当前话题时，自己看看前面聊了什么。
//
// B 的触发（写给模型看的，代码只负责「翻得对不对」）：
//   1. 刚进群 / 刚被拉进一个已经聊开的群；
//   2. 指代接不上：「那个」「他说」「刚才那个图」「还是那事」；
//   3. 出现没见过的黑话、缩写、内部梗；
//   4. 有人插进来问「你们在说什么」，而她也不清楚。
//   判断口诀：先问「这段对话是不是在我进来之前就开始了」，是 → 翻。
//
// ── 代码层硬约束（这几条不能靠模型自觉）──
//   · 只翻当前群/当前会话（chatKey 由调用方给，**不接受指定别人的会话**）；
//   · 时间窗 24 小时，更旧的不翻；
//   · 每轮最多 1 次（同一条不重复展开）；
//   · 合并转发最多展开 2 层（防止一层套一层把上下文炸掉）；
//   · 查不到就说查不到，不许编（返回值里 hit=false 让模型照实说）；
//   · activity 记 kind=history-recall（查询词、条数、命中）。
//
// ★ 「绝不跨群、绝不翻私聊去解释群里的别人」—— 这条是安全边界，不是偏好：
//   群 A 的事不该用群 B 的上下文来解释，那会把两个场子的人混在一起。

/** 时间窗：只翻 24 小时内。 */
export const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
/** 默认翻多少条。 */
export const DEFAULT_LIMIT = 50
/** 上限（协议端 get_*_msg_history 的 count 上限也是 100）。 */
export const MAX_LIMIT = 100
/** 合并转发最多展开几层。 */
export const MAX_FORWARD_DEPTH = 2

function cleanId(v) {
  return String(v == null ? '' : v).trim()
}

/**
 * @param {object} deps
 * @param {object} deps.qq          qq 模块（recent / forward）
 * @param {object} deps.activity    activity store
 * @param {() => number} [deps.now]
 * @param {(line:string)=>void} [deps.log]
 */
export function createHistoryRecall({ qq, activity, now = () => Date.now(), log } = {}) {
  const logger = typeof log === 'function' ? log : () => {}

  /** 本轮是否已经翻过（每轮最多 1 次）。 */
  let usedThisTurn = false
  /** 上次翻记录的时刻：用来兜底判"是不是新的一轮"。 */
  let lastUsedAt = 0
  /**
   * 「一轮」的时间分辨率。
   *
   * ★ 为什么不只靠 beginTurn()：
   *   "轮"的边界在异步流程里是有歧义的（工具可能在回复生成中途被调，
   *   而 turn/end 事件在宿主侧），挂死在一个钩子上容易出现"这一轮永远不重置"
   *   或者"同一轮被重置两次"。所以做双保险：
   *   显式调 beginTurn() 立即重置；没调的话，距上次翻超过这个时间也当新的一轮。
   *   30 秒 ≈ 一条消息从进来 gen 到发出去的典型跨度。
   */
  const TURN_GAP_MS = 30_000
  /** 已经展开过的合并转发 id（同一条不重复展开）。 */
  const expandedForwards = new Set()
  /** 展开层级：forwardId → 深度。 */
  const forwardDepth = new Map()

  function act({ chatKey, query, count, hit, error }) {
    try {
      activity?.append?.({
        platform: 'qq',
        kind: 'history-recall',
        actor: 'fish',
        text: query
          ? `翻了前面的记录（找「${String(query).slice(0, 30)}」，${count} 条${hit ? '，找到了' : '，没找到'}）`
          : `翻了前面的记录（${count} 条）`,
        ref: String(count || 0),
        tone: error ? 'failed' : (hit ? '' : 'miss')
      })
    } catch {}
    try { logger(`[history-recall] ${chatKey} query=${query || '-'} count=${count} hit=${hit}`) } catch {}
  }

  /** 新的一轮开始：重置"每轮 1 次"。 */
  function beginTurn() {
    usedThisTurn = false
    lastUsedAt = 0
  }

  /** 现在还能不能翻（给模型看的判断依据）。 */
  function canRecall() {
    if (!usedThisTurn) return true
    // 兜底：距上次翻够久了，也算新的一轮
    return lastUsedAt > 0 && now() - lastUsedAt > TURN_GAP_MS
  }

  /**
   * 翻当前会话的记录。
   *
   * @param {object} opts
   * @param {string} opts.chatKey   当前会话（**只可能是这个**，调用方不该传别人的）
   * @param {string} [opts.query]   要找的词（用于标记"命中"，也写进 activity）
   * @param {number} [opts.limit]   翻多少条，默认 50，最多 100
   */
  async function recall({ chatKey = '', query = '', limit = DEFAULT_LIMIT } = {}) {
    const key = cleanId(chatKey)
    if (!key) return { ok: false, hit: false, messages: [], say: '不知道该翻哪个会话' }

    if (usedThisTurn && !canRecall()) {
      // ★ 每轮最多 1 次：翻太多次会把她自己的上下文也搅乱
      return { ok: false, hit: false, messages: [], say: '这一轮已经翻过了，直接答吧' }
    }
    usedThisTurn = true
    lastUsedAt = now()

    const count = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT))
    let r = null
    try {
      r = await qq.recent(key, count)
    } catch (error) {
      r = { ok: false, reason: String(error?.message || error) }
    }

    if (!r || r.ok === false) {
      const why = String(r?.reason || '').slice(0, 80)
      act({ chatKey: key, query, count: 0, hit: false, error: why })
      return {
        ok: false, hit: false, messages: [],
        say: '翻不到前面的记录' + (why ? `（${why}）` : '')
      }
    }

    const raw = Array.isArray(r.messages) ? r.messages : []
    const 现在 = now()
    // 时间窗：只留 24 小时内的。没有时间戳的保留（协议端不一定都给）。
    const inWindow = raw.filter((m) => {
      const at = Number(m?.at || 0)
      if (!at) return true
      return 现在 - at <= HISTORY_WINDOW_MS
    })
    // 时间正序（旧的在前），方便模型顺着读
    inWindow.sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0))

    const q = cleanId(query)
    const hit = q ? inWindow.some((m) => String(m?.text || '').includes(q)) : inWindow.length > 0

    act({ chatKey: key, query: q, count: inWindow.length, hit })

    return {
      ok: true,
      hit,
      messages: inWindow.map((m) => ({
        userId: cleanId(m?.userId),
        nickname: String(m?.nickname || ''),
        text: String(m?.text || ''),
        at: Number(m?.at || 0),
        // 合并转发在这里只是一个占位（真内容要 expand 才拿得到）
        forwardId: cleanId(m?.forwardId || m?.id || '')
      })),
      say: inWindow.length
        ? (q && !hit ? '翻了前面的记录，但没看到那句' : '翻了前面的记录')
        : '前面没有记录'
    }
  }

  /**
   * 展开一条合并转发。最多 2 层（防一层套一层把上下文炸掉）。
   *
   * @param {object} opts
   * @param {string} opts.forwardId
   * @param {number} [opts.depth]  当前层级（内部用；调用方不传就是第 1 层）
   */
  async function expand({ forwardId = '', depth = 1 } = {}) {
    const id = cleanId(forwardId)
    if (!id) return { ok: false, entries: [], say: '不知道展开哪条' }

    if (depth > MAX_FORWARD_DEPTH) {
      return { ok: false, entries: [], say: '这层套得太深了，不往下翻了' }
    }
    if (expandedForwards.has(id)) {
      // ★ 同一条不重复展开：重复展会把同样内容灌两遍，白占上下文
      return { ok: false, entries: [], say: '这条已经展开过了', alreadyExpanded: true }
    }

    let r = null
    try {
      r = await qq.forward(id)
    } catch (error) {
      r = { ok: false, reason: String(error?.message || error), entries: [] }
    }
    if (!r || r.ok === false) {
      const why = String(r?.reason || '').slice(0, 80)
      return { ok: false, entries: [], say: '展开不了' + (why ? `（${why}）` : '') }
    }

    expandedForwards.add(id)
    const entries = Array.isArray(r.entries) ? r.entries : []
    // 记录这条的深度：里面若还有合并转发，上层据此判断能不能再展开
    for (const e of entries) forwardDepth.set(cleanId(e?.forwardId || ''), depth + 1)

    return {
      ok: true,
      entries: entries.slice(0, 50).map((e) => ({
        nickname: String(e?.nickname || ''),
        userId: cleanId(e?.userId),
        text: String(e?.text || ''),
        at: Number(e?.at || 0)
      })),
      depth,
      say: `展开 ${entries.length} 条`
    }
  }

  /** 排查用：这轮翻过没有、展开过哪些。 */
  function snapshot() {
    return {
      usedThisTurn,
      expanded: [...expandedForwards],
      maxDepth: MAX_FORWARD_DEPTH,
      windowHours: HISTORY_WINDOW_MS / 3600000
    }
  }

  return {
    beginTurn,
    canRecall,
    recall,
    expand,
    snapshot,
    HISTORY_WINDOW_MS,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MAX_FORWARD_DEPTH
  }
}