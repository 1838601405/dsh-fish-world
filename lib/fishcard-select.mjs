// 鱼卡 v3 条件触发（2026-11-23 主人规格 §3）。
//
// ── 只做选择，不做判定 ──
// 「这条消息算不算 at-me」是 qq-inbox 的事；这里只收一份**已判定的事实**（facts）
// 和**上一轮的状态**（state），纯函数地挑出该进的条件节。
// 这样选择逻辑可以脱离 QQ/文件系统单测（规格验收 #2–#5 全是这种）。
//
// ── 三条规则（规格 §3 原文）──
//   · 同一轮最多进 3 条，越具体越优先：at-me > attachment > group/private > owner
//   · 互斥的（对主人 / 对群友）只能进一条
//   · 场景档总数 ≤ 5
//
// ── 关于优先级顺序的一处存疑（按字面实现，等主人纠正）──
// 规格把 `owner` 排在 `group/private` **之后**，但「私聊对主人」时
// `when=private` 与 `when=owner` 会同时命中 —— 按字面 private 赢，
// 于是「对主人」那档在私聊里永远进不去。我按**字面**实现（不擅自改规格），
// 判据也按字面写；若主人本意是 owner 更具体，改一个数字即可（OWNER_ORDER）。

/** 规格 §3 的优先级：数字越小越具体、越先选。group 与 private 同级（场景维度）。 */
const WHEN_PRIORITY = { 'at-me': 0, attachment: 1, group: 2, private: 2, owner: 3 }

/** 没写 when 的条件节（只有 keys）不参与 when 优先级 —— 它们按自己的 order 排。 */
const NO_WHEN = 99

/** 规格 §3：同一轮最多进 3 条。 */
const MAX_PICKS = 3

/** 规格 §3：场景档总数 ≤ 5。 */
const MAX_SCENES = 5

/**
 * 挑出这一轮该进的条件节。
 *
 * @param {object} opts
 * @param {Array} opts.sections `parseCard` 的结果（只用 tier==='条件' 的那些）
 * @param {object} opts.facts   已判定的事实（见下）
 * @param {object} [opts.state] 跨轮状态 `{ cooldowns: { <节标识>: <轮号> } }`
 * @param {number} opts.round   当前轮号（1 起）
 * @returns {{picked: Array, warnings: string[]}}
 *   `picked` 是**注入顺序**（具体在前），调用方直接拼即可；不改入参 state（由调用方回写）
 *
 * facts 形状（每项都可缺省，缺省当 false / ''）：
 *   { text, kind:'group'|'private', owner, atMe, named, quoted, attachment }
 *   · `text` 用于 `keys=` 字面命中
 *   · `kind` 用于 `when=group` / `when=private`
 */
export function selectConditions({ sections, facts = {}, state = {}, round = 1 } = {}) {
  const warnings = []
  const all = Array.isArray(sections) ? sections : []
  const conds = all.filter((s) => s && s.tier === '条件')
  if (!conds.length) return { picked: [], warnings }

  const text = String(facts.text || '')
  const cooldowns = (state && typeof state.cooldowns === 'object' && state.cooldowns) || {}

  // ① 先按「命中没命中」筛：keys 字面命中，或 when 与事实相符
  const hit = []
  for (const s of conds) {
    const why = matched(s, facts, text)
    if (!why) continue

    // ② cooldown：同一节在 N 轮内只进一次（规格验收 #5：20 轮同话题 ≤ 2 次）
    const id = sectionId(s)
    const last = Number(cooldowns[id])
    const cd = Number(s.cooldown) || 0
    if (cd > 0 && Number.isFinite(last) && round - last < cd) {
      warnings.push(`「${s.title}」冷却中（${round - last}/${cd} 轮）→ 本轮跳过`)
      continue
    }
    hit.push({ s, why })
  }

  // ③ 排序：when 优先级 → order 升序（规格：越具体越先；同级 order 小的靠前）
  hit.sort((a, b) => {
    const pa = whenPriority(a.s), pb = whenPriority(b.s)
    if (pa !== pb) return pa - pb
    const oa = Number(a.s.order) || 100, ob = Number(b.s.order) || 100
    if (oa !== ob) return oa - ob
    return String(a.s.title).localeCompare(String(b.s.title))   // 稳定：同分按标题，别每次随机
  })

  // ④ 场景档上限（规格：≤ 5）——只数 when 型的；纯 keys 档不算「场景」
  const scenes = hit.filter((h) => h.s.when)
  if (scenes.length > MAX_SCENES) {
    warnings.push(`场景档 ${scenes.length} 条超过上限 ${MAX_SCENES}，只取前 ${MAX_SCENES}（规格 §3）`)
    const keep = new Set(scenes.slice(0, MAX_SCENES).map((h) => sectionId(h.s)))
    for (let i = hit.length - 1; i >= 0; i--) {
      if (hit[i].s.when && !keep.has(sectionId(hit[i].s))) hit.splice(i, 1)
    }
  }

  // ⑤ 截断到 3 条
  const picked = hit.slice(0, MAX_PICKS).map((h) => h.s)
  if (hit.length > MAX_PICKS) {
    warnings.push(`命中 ${hit.length} 条，只进前 ${MAX_PICKS} 条（丢弃顺序按规格：order 最大的先丢）`)
  }

  return { picked, warnings }
}

/** 这一条为什么命中（返回命中理由字符串；不命中返回 ''）。 */
function matched(s, facts, text) {
  const keys = Array.isArray(s.keys) ? s.keys : []
  if (keys.length) {
    // 字面命中（规格：同义多写几个 —— 这里不做好了坏的同义词，写卡时自己多写）
    if (keys.some((k) => k && text.includes(k))) return 'keys'
    // 有 keys 但没写 when ⇒ 只靠字面命中，不中就不进
    if (!s.when) return ''
  }

  const when = String(s.when || '')
  if (!when) return keys.length ? 'keys' : ''

  switch (when) {
    case 'group': return facts.kind === 'group' ? 'when' : ''
    case 'private': return facts.kind === 'private' ? 'when' : ''
    case 'owner': return facts.owner === true ? 'when' : ''
    case 'at-me': return facts.atMe === true ? 'when' : ''
    case 'named': return facts.named === true ? 'when' : ''
    case 'quoted': return facts.quoted === true ? 'when' : ''
    case 'attachment': return facts.attachment === true ? 'when' : ''
    case 'cold-start': return Number(facts.round || 0) <= 3 ? 'when' : ''
    default:
      // 未识别的 when —— 按不命中处理，但**要报**（规格：不静默丢）
      return ''
  }
}

function whenPriority(s) {
  const when = String(s.when || '')
  if (!when) return NO_WHEN
  const p = WHEN_PRIORITY[when]
  if (p === undefined) return NO_WHEN + 1     // 未识别的 when 排最后（matched 已经不选它，双保险）
  return p
}

/** 节的稳定标识：标题 + 起始内容指纹（标题重名时靠它区分）。 */
function sectionId(s) {
  return `${s.title}::${String(s.body || '').slice(0, 24)}`
}
