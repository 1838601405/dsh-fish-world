// 出口闸单点（herframe 设计移植）。
//
// 目标：**所有出站消息过同一函数**。判断顺序固定，不各写各的。
//
// 六道闸（顺序有意义）：
//   ① 时段（quiet hours / 深夜）—— 绝对不发，排最前
//   ② 额度（每小时/每天）—— 用配额前先看还剩多少
//   ③ 群闸（这个群允不允许开口 / 群内限频）
//   ④ 重复（同一句话短时间重复发）
//   ⑤ 敏感（不该发出去的内容）
//   ⑥ 放行
//
// ★ 为什么是「单点」而不是「各处各判」：
//   现在至少有三套过滤散在不同地方（send_fence 连发合并 / meme_gate 梗闸 /
//   chat-api 路由）。三套各判一次的结果是：新加一条出站路径时，没人知道
//   它到底过没过闸。单点的价值不在「判得更准」，在**「不可能绕过」**。
//
// ★ 这里**不重新实现**那些过滤器：`extraGates` 允许调用方把已有的
//   send_fence / meme_gate 作为闸接入，保持原行为不变（它们仍在自己位置生效）。
//   出口闸只保证「有一次统一的、可审计的判定」。

/** 闸门标签（审计与日志用同一套词）。 */
export const GATE = Object.freeze({
  QUIET: 'quiet-hours',
  QUOTA: 'quota',
  GROUP: 'group',
  DUP: 'duplicate',
  SENSITIVE: 'sensitive',
  CUSTOM: 'custom',
  PASS: 'pass'
})

/** 敏感内容：口令/密钥形态的东西不该被发到 QQ。 */
const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,                    // API key 形态
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,          // bearer token
  /(?:password|passwd|密码|口令)\s*[:=]\s*\S{6,}/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/            // 长 base64 串（凭据常见形态）
]

/**
 * 动作计数的键前缀（2026-11-20）。
 *
 * ★ 为什么要有：主人纠正「点赞/改名片/撤回/贴表情 计入独立频控，
 *   **不占发言额度**」。所以动作单独一个命名空间，不和发消息抢同一个预算。
 */
const ACT_PREFIX = 'act:'

/** 动作默认频控：每小时 30 次（0 = 不限）。这是"对外可见动作"的总阀门。 */
const DEFAULT_ACTION_MAX_PER_HOUR = 30
/** 动作默认每天上限。 */
const DEFAULT_ACTION_MAX_PER_DAY = 200

function numOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function hourInShanghai(at) {
  const d = new Date(Number(at) + 8 * 3600 * 1000)
  return d.getUTCHours()
}

/** 「23:30-07:00」这种跨零点时段。 */
export function inQuietHours(at, spec) {
  const text = String(spec || '').trim()
  if (!text) return false
  const m = text.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return false
  const startMin = Number(m[1]) * 60 + Number(m[2])
  const endMin = Number(m[3]) * 60 + Number(m[4])
  const d = new Date(Number(at) + 8 * 3600 * 1000)
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes()
  // 跨零点：23:30-07:00 → cur >= 1410 || cur < 420
  if (startMin <= endMin) return cur >= startMin && cur < endMin
  return cur >= startMin || cur < endMin
}

/**
 * 创建出口闸。
 *
 * @param {object} opts
 * @param {() => object} [opts.config]   取设置（quietHours / maxPerHour / maxPerDay / groupMaxPerHour / dedupeWindowMs）
 * @param {() => number} [opts.now]
 * @param {(info) => void} [opts.log]    审计回调
 */
export function createOutboundGate({ config, now = () => Date.now(), log } = {}) {
  const cfg = () => {
    try { return (typeof config === 'function' ? config() : config) || {} } catch { return {} }
  }
  const logger = typeof log === 'function' ? log : () => {}

  /** 每小时/每天的计数：key = chatKey。 */
  const hourCounts = new Map()
  const dayCounts = new Map()
  /** 最近发出的文本（防重复）：key = chatKey|text → at */
  const recent = new Map()

  function bump(map, key, windowMs) {
    const at = now()
    const cur = map.get(key)
    if (!cur || at - cur.since >= windowMs) {
      map.set(key, { since: at, n: 1 })
      return 1
    }
    cur.n += 1
    return cur.n
  }

  function shouldBlockDuplicate(chatKey, text) {
    const windowMs = numOr(cfg().dedupeWindowMs, 60_000)
    const key = String(chatKey) + '|' + String(text || '').trim()
    const at = now()
    const last = recent.get(key)
    recent.set(key, at)
    // 顺手清掉过期项，避免无限涨
    if (recent.size > 500) {
      for (const [k, v] of recent) if (at - v > windowMs) recent.delete(k)
    }
    return last != null && at - last < windowMs
  }

  /**
   * 判一条出站消息要不要发。
   *
   * 返回 {ok:true} 或 {ok:false, gate, reason}。
   * **不抛异常**：出站判定不能自己把发送弄挂。
   */
  function check({ chatKey = '', text = '', kind = '', at = now() } = {}) {
    const s = cfg()
    const body = String(text == null ? '' : text)
    // 空消息没有发的意义（不是闸，是常识）
    if (!body.trim()) return { ok: false, gate: GATE.SENSITIVE, reason: '空消息' }

    // ① 时段
    if (inQuietHours(at, s.quietHours)) {
      return { ok: false, gate: GATE.QUIET, reason: `安静时段（${s.quietHours}）` }
    }

    // ② 额度
    const maxHour = numOr(s.maxPerHour, 0)
    if (maxHour > 0) {
      const cur = hourCounts.get(chatKey)
      const n = cur && at - cur.since < 3600_000 ? cur.n : 0
      if (n >= maxHour) return { ok: false, gate: GATE.QUOTA, reason: `每小时上限 ${maxHour}` }
    }
    const maxDay = numOr(s.maxPerDay, 0)
    if (maxDay > 0) {
      const cur = dayCounts.get(chatKey)
      const n = cur && at - cur.since < 86400_000 ? cur.n : 0
      if (n >= maxDay) return { ok: false, gate: GATE.QUOTA, reason: `每天上限 ${maxDay}` }
    }

    // ③ 群闸
    if (String(kind) === 'group' || String(chatKey).startsWith('group:')) {
      const groupMax = numOr(s.groupMaxPerHour, 0)
      if (groupMax > 0) {
        const cur = hourCounts.get('g:' + chatKey)
        const n = cur && at - cur.since < 3600_000 ? cur.n : 0
        if (n >= groupMax) return { ok: false, gate: GATE.GROUP, reason: `群内每小时上限 ${groupMax}` }
      }
    }

    // ④ 重复
    if (s.dedupe !== false && shouldBlockDuplicate(chatKey, body)) {
      return { ok: false, gate: GATE.DUP, reason: '刚说过同一句' }
    }

    // ⑤ 敏感
    for (const re of SENSITIVE_PATTERNS) {
      if (re.test(body)) return { ok: false, gate: GATE.SENSITIVE, reason: '内容像凭据口令' }
    }

    return { ok: true, gate: GATE.PASS }
  }

  /**
   * 判一个**没有正文**的对外动作用不用放行（2026-11-20）。
   *
   * 撤回 / 拍一拍 / 点赞 / 贴表情 / 改群名片 这些都没有"一句话"可以判。
   *
   * ── ★ 2026-11-20 主人纠正：这些不占"发言额度" ──
   *   原话：「点赞名片、改群名片、撤回、贴表情都是「对外可见」动作：
   *          计入独立频控，不占"发言额度"」
   *   第一版拿 hourCounts/dayCounts 去判，等于「给一个赞就少说一句话」——
   *   这是把两种完全不同的打扰混成一个预算。现在改成独立计数（ACT_PREFIX）。
   *
   * 仍然保留的闸：
   *   · 安静时段 —— 半夜在群里改名片 / 连续拍人一样很怪
   *   · 群闸     —— 群级的总量控制，不分发言还是动作
   *   · 敏感     —— label 里也不该出现凭据形态的东西
   *
   * @param {object} opts { chatKey, kind, label }
   */
  function checkAction({ chatKey = '', kind = 'action', label = '', at = now() } = {}) {
    const s = cfg()
    const body = String(label || '').trim()

    // ① 时段
    if (inQuietHours(at, s.quietHours)) {
      return { ok: false, gate: GATE.QUIET, reason: `安静时段（${s.quietHours}）` }
    }

    // ② 独立动作频控（**不吃发言额度**）
    const maxActHour = numOr(s.actionMaxPerHour, DEFAULT_ACTION_MAX_PER_HOUR)
    if (maxActHour > 0) {
      const cur = hourCounts.get(ACT_PREFIX + chatKey)
      const n = cur && at - cur.since < 3600_000 ? cur.n : 0
      if (n >= maxActHour) {
        return { ok: false, gate: GATE.QUOTA, reason: `动作太频繁（每小时上限 ${maxActHour}）` }
      }
    }
    const maxActDay = numOr(s.actionMaxPerDay, DEFAULT_ACTION_MAX_PER_DAY)
    if (maxActDay > 0) {
      const cur = dayCounts.get(ACT_PREFIX + chatKey)
      const n = cur && at - cur.since < 86400_000 ? cur.n : 0
      if (n >= maxActDay) {
        return { ok: false, gate: GATE.QUOTA, reason: `今天动作太多了（上限 ${maxActDay}）` }
      }
    }

    // ③ 群闸（群级总量，不分发言还是动作）
    if (String(chatKey).startsWith('group:')) {
      const groupMax = numOr(s.groupMaxPerHour, 0)
      if (groupMax > 0) {
        const cur = hourCounts.get('g:' + chatKey)
        const n = cur && at - cur.since < 3600_000 ? cur.n : 0
        if (n >= groupMax) return { ok: false, gate: GATE.GROUP, reason: `群内每小时上限 ${groupMax}` }
      }
    }

    // ④ 敏感
    for (const re of SENSITIVE_PATTERNS) {
      if (re.test(body)) return { ok: false, gate: GATE.SENSITIVE, reason: '内容像凭据口令' }
    }

    return { ok: true, gate: GATE.PASS }
  }

  /**
   * 动作真正做成之后记账（**独立于发言计数**）。
   * 只有成功才记 —— 失败不该占额度。
   */
  function noteAction(chatKey = '', { at = now() } = {}) {
    const key = ACT_PREFIX + String(chatKey || '')
    const h = hourCounts.get(key)
    if (h && at - h.since < 3600_000) h.n += 1
    else hourCounts.set(key, { since: at, n: 1 })
    const d = dayCounts.get(key)
    if (d && at - d.since < 86400_000) d.n += 1
    else dayCounts.set(key, { since: at, n: 1 })
  }

  /** 真正发出去之后记账（成功才记，失败不占额度）。 */
  function noteSent({ chatKey = '', text = '', at = now() } = {}) {
    bump(hourCounts, chatKey, 3600_000)
    bump(dayCounts, chatKey, 86400_000)
    if (String(chatKey).startsWith('group:')) bump(hourCounts, 'g:' + chatKey, 3600_000)
    logger({ at, chatKey, text: String(text || '').slice(0, 60) })
  }

  /**
   * 包一个发送函数：**先过闸，过了才发，发成功才记账**。
   * 所有出站路径都该走这个，而不是各自直接调 qq.send。
   */
  function wrap(sendFn) {
    if (typeof sendFn !== 'function') throw new Error('出口闸：要包一个发送函数')
    return async function gatedSend(chatKey, segments, options = {}) {
      const text = (Array.isArray(segments) ? segments : [])
        .filter((s) => s && s.type === 'text')
        .map((s) => String(s.text || ''))
        .join('\n')
      // ★ 必须把 kind 和 at 传进去：漏了 at 就会用系统时钟（假测试里时间对不上），
      //   漏了 kind 群闸就永远不生效。
      const verdict = check({
        chatKey,
        text,
        kind: String(chatKey).startsWith('group:') ? 'group' : 'private',
        at: now()
      })
      if (!verdict.ok) {
        // 被拦下的不抛错，返回结构化结果——调用方要能区分「没发」和「发失败」。
        return { ok: false, blocked: true, gate: verdict.gate, error: verdict.reason }
      }
      const r = await sendFn(chatKey, segments, options)
      // 只有真发成功才记，失败不占额度
      if (!(r && r.ok === false)) noteSent({ chatKey, text })
      return r
    }
  }

  return { check, checkAction, noteSent, noteAction, wrap, inQuietHours, GATE }
}
