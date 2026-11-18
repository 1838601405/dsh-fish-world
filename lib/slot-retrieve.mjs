// 双通道检索 + 打分 + 四道闸 + 打包。
//
// 顺序固定（规格第 5/6 节）：硬过滤 → 双通道 → 打分 → 打包 → 用不用（四道闸）。
// 硬过滤是**排除**，不是扣分；四道闸决定「能不能用」，比「找不找得到」更靠后也更严格。
import { KIND, SCORE_WEIGHTS, DIMENSIONS, cosine, encodeFallback, slotVector } from './slots.mjs'

/** 通道 B 的字面命中最低长度（太短会乱撞）。 */
export const FRAGMENT_MIN_LEN = 5
/** 容错半径：允许 1–2 字差异（同音 / 漏字）。 */
export const FRAGMENT_MAX_DIFF = 2
/** 同一个梗 N 分钟内只接一次。 */
export const MEME_COOLDOWN_MS = 30 * 60 * 1000
/** 一次对话的配额。 */
export const QUOTA = Object.freeze({ 表情: 2, 梗: 2 })

/** 限制编辑距离的 Levenshtein（超上限就提前返回上限+1）。 */
export function editDistance(a, b, cap = FRAGMENT_MAX_DIFF) {
  const s = String(a || '')
  const t = String(b || '')
  if (s === t) return 0
  if (Math.abs(s.length - t.length) > cap) return cap + 1
  const prev = new Array(t.length + 1)
  const cur = new Array(t.length + 1)
  for (let j = 0; j <= t.length; j += 1) prev[j] = j
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > cap) return cap + 1
    for (let j = 0; j <= t.length; j += 1) prev[j] = cur[j]
  }
  return prev[t.length]
}

/** 字面命中：触发词是查询的子串，或整体编辑距离 ≤ 容错半径。 */
export function literalHit(query, trigger, { maxDiff = FRAGMENT_MAX_DIFF } = {}) {
  const q = String(query || '').trim()
  const t = String(trigger || '').trim()
  if (!q || !t) return { hit: false, kind: 'none' }
  if (t.length < FRAGMENT_MIN_LEN && q.length < FRAGMENT_MIN_LEN) return { hit: false, kind: 'none' }
  if (q.includes(t) || t.includes(q)) return { hit: true, kind: 'contains', diff: 0 }
  // 漏字 / 同音：逐窗口比编辑距离
  const span = Math.max(t.length, q.length)
  if (Math.abs(q.length - t.length) <= maxDiff) {
    const d = editDistance(q, t, maxDiff)
    if (d <= maxDiff) return { hit: true, kind: 'fuzzy', diff: d }
  }
  for (let i = 0; i + span <= q.length; i += 1) {
    const win = q.slice(i, i + span)
    const d = editDistance(win, t, maxDiff)
    if (d <= maxDiff) return { hit: true, kind: 'window', diff: d }
  }
  return { hit: false, kind: 'none' }
}

/** 硬过滤：不是扣分项 —— 不满足的直接出局。 */
export function hardFilter({ slots = [], audience = null } = {}) {
  const aud = audience || {}
  return (Array.isArray(slots) ? slots : []).filter((slot) => {
    if (!slot || slot.status !== 'active') return false
    const source = String(slot.source || '')
    const person = String(slot.person || '')
    // 群聊：只放公开话题类；任何私聊内容零注入。
    if (aud.kind === 'group') return slot.publicTopic === true
    if (!aud.kind) return true
    // 私聊：当事人的槽 + 本房间的槽 + 公开话题。
    // 缺 source/person 的按私密处理（宁严勿漏）：只有「本人私聊」才可能命中。
    if (slot.publicTopic === true) return true
    if (person && aud.person && person === aud.person) return true
    if (slot.room && aud.chatKey && slot.room === aud.chatKey) return true
    if (!person && !slot.room && aud.person && !source) return false
    return false
  })
}

function freshnessOf(slot, now) {
  const at = Date.parse(String(slot?.at || ''))
  if (!Number.isFinite(at)) return 0.5
  const days = Math.max(0, (now - at) / 86400000)
  return Math.exp(-days / 30)
}

function tagHitOf(slot, query) {
  const q = String(query || '')
  const words = Object.values(slot.tags || {}).filter(Boolean)
  if (!words.length) return 0
  let hit = 0
  for (const word of words) if (q.includes(String(word))) hit += 1
  return hit / words.length
}

/** 打分：相对分，不归一化到 1（规格就是这么定的）。 */
export function scoreSlot({ slot, query = '', queryVec = null, now = Date.now(), audience = null } = {}) {
  const w = SCORE_WEIGHTS
  const tag = tagHitOf(slot, query)
  const vec = slotVector(slot)
  const cos = queryVec && vec ? Math.max(0, cosine(queryVec, vec)) : 0
  const fresh = freshnessOf(slot, now)
  const samePerson = audience && audience.person && slot.person === audience.person ? 1 : 0
  const longTerm = slot.kind === KIND.FACT ? 1 : 0
  return {
    score: w.tag * tag + w.cosine * cos + w.freshness * fresh + w.samePerson * samePerson + w.longTerm * longTerm,
    parts: { tag, cos, fresh, samePerson, longTerm },
  }
}

/**
 * 四道闸：难过时不给嘲讽、冷却、配额、负反馈。
 * 返回 { ok, why }
 */
export function gateCheck({ slot, audience = {}, state = {}, now = Date.now(), options = {} } = {}) {
  const negative = state.negative || {}
  if (negative[slot.id]) return { ok: false, why: 'negative' }
  // 1 硬条件：对方难过/生气 → caution 槽直接排除；对陌生人连情绪图也不给
  if (audience.sad === true) {
    if (slot.caution === true) return { ok: false, why: 'sad-caution' }
    if (slot.kind === KIND.STICKER) return { ok: false, why: 'sad-sticker' }
    if (audience.stranger === true && (slot.tags?.情绪 || '')) return { ok: false, why: 'sad-stranger' }
  }
  const cooldownMs = Number(options.cooldownMs) || MEME_COOLDOWN_MS
  const uses = state.uses || {}
  const last = Number(uses[slot.id] || 0)
  if (last && now - last < cooldownMs) return { ok: false, why: 'cooldown' }
  // 3 配额：一次对话最多 N 张图 / N 次接梗
  const quota = { ...QUOTA, ...(options.quota || {}) }
  const counts = state.counts || {}
  if (slot.kind === KIND.STICKER && Number(counts.表情 || 0) >= quota.表情) return { ok: false, why: 'quota-sticker' }
  if (slot.kind === KIND.MEME && Number(counts.梗 || 0) >= quota.梗) return { ok: false, why: 'quota-meme' }
  return { ok: true, why: '' }
}

/** 打包：去重 → 按 token 预算裁（超了从低分丢）→ 每条标来源。 */
export function packResults({ results = [], budget = 400, estimateTokens = (t) => Math.ceil(String(t).length / 1.6) } = {}) {
  const seen = new Set()
  const deduped = []
  for (const row of results) {
    // 按槽 id 去重：同一张图的不同语义槽是各自独立的，不能被 vId 折成一个
    const key = row.slot.id || row.slot.vId || row.slot.semantic
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }
  deduped.sort((a, b) => b.score - a.score)
  const kept = []
  let used = 0
  let dropped = 0
  for (const row of deduped) {
    const text = row.slot.response || row.slot.semantic || ''
    const cost = estimateTokens(text)
    if (used + cost > budget) {
      dropped += 1
      continue
    }
    used += cost
    kept.push({ ...row, text, label: row.slot.source ? `[来自 ${row.slot.source}${row.slot.person ? '/' + row.slot.person : ''}]` : '' })
  }
  return { kept, dropped, tokens: used }
}

/**
 * 检索主入口。
 * channelA：事实/表情（向量 + 情境标签）
 * channelB：梗/歌词/口头禅（字面片段 + 容错半径）
 */
export function retrieve({
  query = '',
  slots = [],
  audience = null,
  state = {},
  now = Date.now(),
  budget = 400,
  encode = encodeFallback,
  options = {},
} = {}) {
  const q = String(query || '').trim()
  const allowed = hardFilter({ slots, audience })
  const queryVec = encode(q)
  const rows = []
  const trace = { total: (slots || []).length, allowed: allowed.length, channelA: 0, channelB: 0, gated: 0 }

  for (const slot of allowed) {
    let hit = false
    if (slot.kind === KIND.FACT || slot.kind === KIND.STICKER) {
      const { score } = scoreSlot({ slot, query: q, queryVec, now, audience })
      if (score > 0.25) {
        hit = true
        trace.channelA += 1
        rows.push({ slot, score, channel: 'A' })
      }
    }
    if (!hit && (slot.kind === KIND.MEME || (slot.trigger && slot.trigger.length))) {
      let best = null
      for (const trigger of slot.trigger || []) {
        const got = literalHit(q, trigger, { maxDiff: options.maxDiff ?? FRAGMENT_MAX_DIFF })
        if (got.hit) {
          best = got
          break
        }
      }
      if (best) {
        trace.channelB += 1
        rows.push({ slot, score: 0.6 + (best.diff === 0 ? 0.1 : 0), channel: 'B', hit: best })
      }
    }
  }

  const gated = []
  for (const row of rows) {
    const gate = gateCheck({ slot: row.slot, audience: audience || {}, state, now, options })
    if (!gate.ok) {
      trace.gated += 1
      continue
    }
    gated.push(row)
  }

  const packed = packResults({ results: gated, budget })
  return { ...packed, trace }
}

/** 维护（后台，不在主链路）：命中记账、90 天衰减只看不用、冲突标 superseded。 */
export function noteHit({ state = {}, slotId, now = Date.now() } = {}) {
  const next = { ...state }
  next.uses = { ...(next.uses || {}), [slotId]: now }
  next.hits = { ...(next.hits || {}) }
  next.hits[slotId] = Number(next.hits[slotId] || 0) + 1
  const kind = String(next.kinds?.[slotId] || '')
  next.counts = { ...(next.counts || {}) }
  if (kind) next.counts[kind] = Number(next.counts[kind] || 0) + 1
  return next
}

export function noteNegative({ state = {}, slotId } = {}) {
  const next = { ...state }
  next.negative = { ...(next.negative || {}), [slotId]: Date.now() }
  return next
}

/** 90 天未用 → 分数衰减（不改数据，只在打分时乘系数）。 */
export function decayFactor({ lastUsedAt = 0, now = Date.now(), days = 90 } = {}) {
  if (!lastUsedAt) return 1
  const age = (now - lastUsedAt) / 86400000
  if (age <= days) return 1
  return Math.max(0.2, 1 - (age - days) / (days * 3))
}

/** 容量：槽数上限 + 归档最久未用。 */
export function enforceCapacity({ slots = [], state = {}, limit = 50000 } = {}) {
  if (slots.length <= limit) return { slots, archived: [] }
  const uses = state.uses || {}
  const sorted = [...slots].sort((a, b) => Number(uses[a.id] || 0) - Number(uses[b.id] || 0))
  const drop = sorted.slice(0, slots.length - limit).map((s) => s.id)
  const dropSet = new Set(drop)
  return { slots: slots.filter((s) => !dropSet.has(s.id)), archived: drop }
}

/** 换 encoder → 全库重建（kVersion 升号；重建期读旧版由调用方决定）。 */
export function rebuildForEncoder({ slots = [], encode = encodeFallback, encoder = '', kVersion = 0 } = {}) {
  return slots.map((slot) => {
    const vec = encode([slot.semantic, slot.response, ...(slot.trigger || [])].join(' '))
    const quant = { q: Array.from(vec, (v) => Math.max(-127, Math.min(127, Math.round(v * 127)))), scale: 1 }
    return { ...slot, vec: quant, encoder: encoder || slot.encoder, kVersion: Number(kVersion) || slot.kVersion }
  })
}

export { DIMENSIONS }
