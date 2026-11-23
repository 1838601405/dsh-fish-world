// 鱼卡 v3 装配（2026-11-23 主人规格 §5 的 11 步）。
//
// ── 为什么抽成一个函数 ──
// 仓库里有**三条**投递路径（`deliverViaChatApi` / `deliverToSession` / `deliverInbound`），
// 各自拼提示词就会各拼各的 —— 顺序漂一点、少一行标签行，行为就不一样。
// 规格 §5 给的是**一套顺序**，所以这里只负责「按顺序拼」，**内容全部由调用方给**：
// 这一层不读文件、不查记忆、不算事实，纯函数（能脱离 QQ/文件系统单测）。
//
// ── 第 3 行是硬的 ──
// 规格 §5 原文：「第 3 行必须有。第一人称裸拼进对话，模型会读成用户在自述。」
// 所以只要后面有「她自己的话」（常驻/风格/条件/语料任一），标签行就摆在它们前面。

import { parseCard } from './fishcard.mjs'
import { selectConditions, sectionId } from './fishcard-select.mjs'
import { loadStyle } from './fishcard-style.mjs'
import { applySwitches } from './fishcard-switch.mjs'

/** 语料只在会话前 3 轮出现（规格 §5 第 6 步）。 */
const COLD_START_ROUNDS = 3

/** 记忆召回上限（规格 §5 第 7 步：≤6 条）——调用方给多少这里不裁，只在注释里记口径。 */
const MAX_MEMORY_HINTS = 6

/** 槽命中上限（规格 §5 第 10 步：最多 2 条）。 */
const MAX_HABITS = 2

/** 惦记上限（规格 §5 第 8 步：≤3 条话头）。 */
const MAX_THOUGHTS = 3

/**
 * §4 预算（主人定：不省，体验优先）。
 *
 * ★ 为什么必须有它：§4 同时明令「**不许从尾部砍字符**（personaForPrompt 就是这么干的，要改掉）」——
 *   砍字符那道兜底去掉之后，**得有按段丢弃的兜底**，否则超长卡会整张塞进 prompt。
 * ★ 键名对应 front-matter 的 `budget: { resident, lore, sample }`：`lore` = 这里的 `condition`。
 *   front-matter 那份只当 lint 用（§12：只能 lint 不能校验），运行时以这张表为准。
 */
const DEFAULT_BUDGET = {
  resident: 3000,   // 常驻
  condition: 1500,  // 条件（front-matter 里叫 lore）
  sample: 500,      // 语料
  style: 200,       // 风格
  thought: 150,     // 惦记
  memory: 400,      // 记忆召回
  habit: 200,       // 槽命中
  growth: 60,       // 成长反哺
}

/** 一批节的总字数。 */
function charLen(list) {
  return (Array.isArray(list) ? list : []).reduce((n, s) => n + String((s && s.body) || '').length, 0)
}

// ── §3.1 时间感 ──
// 每轮在场景锚后面加一行「距上次对话过去了 <X>」。
// ★ 施工单原文：「超过 15 分钟才写，20 分钟内不写」—— 主句是**超过 15 分钟**（15 分钟以下
//   的快速对话不提醒），「20 分钟内不写」是同义补充（快速对话本就 <15）。阈值取 15 分钟。
// ★ **只给时长，不给解释**（不写「请考虑这个间隔」这种替她下结论的话）。
/** 超过这个间隔才写时间感行（ms）。 */
const GAP_MS = 15 * 60 * 1000

/** 时长格式化：只给时长，不给解释。小时优先，分钟兜底。 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const hours = Math.floor(total / 3600000)
  const minutes = Math.floor((total % 3600000) / 60000)
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
  return `${Math.max(1, minutes)} 分钟`
}

/**
 * 按规格 §5 的 11 步拼出 system prompt。
 *
 * @param {object} o
 * @param {string} o.name         角色显示名（第 1 步）
 * @param {string} [o.role]       角色 id（第 1 步；没有就只给名字）
 * @param {string} [o.scene]      场景锚的场景（第 2 步，如 `QQ 群` / `私聊` / `面板`）
 * @param {string} [o.who]        场景锚的对象（第 2 步，如 `某人` / `主人`）
 * @param {number} [o.lastAt]     §3.1 时间感：**最近一条消息的时间戳**（ms）；>0 且距现在超过
 *                                15 分钟时，在场景锚后加「距上次对话过去了 <X>」一行。
 *                                不给（或 <=0）就不写这一行
 * @param {number} [o.now]        当前时间（ms），默认 Date.now()（测试注入用）
 * @param {string} [o.card]       卡全文（第 4/6/9 步的来源）
 * @param {object} [o.facts]      已判定的事实（喂给条件选择，见 fishcard-select）
 * @param {object} [o.state]      跨轮状态 `{cooldowns}`（条件冷却）
 * @param {number} [o.round]      当前轮号（1 起；语料只在 ≤3 轮出现）
 * @param {string} [o.styleScene] 风格场景（不给就按 facts 选）
 * @param {string} [o.styleHome]  人设根（给了才读风格层文件）
 * @param {string|string[]} [o.memory]     第 7 步：记忆召回（≤6 条）
 * @param {string[]} [o.thoughts] 第 8 步：惦记话头（≤3 条，按新旧）
 * @param {string|string[]} [o.habits]     第 10 步：槽命中（行为纠正，≤2 条）
 * @param {string} [o.growth]     第 11 步：成长反哺（一句）
 * @param {object} [o.budget]     覆盖 §4 预算表（测试用；默认见 DEFAULT_BUDGET）
 * @returns {{ text: string, warnings: string[], dropped: Array<{tier:string,title:string,order?:number}>,
 *            used: { conditions: number, style: string|null, legacy: boolean } }}
 *   `dropped` 是 §4 预算丢掉的段（判据 #6 要求面板能列出「丢了哪几条」）；没超预算就是空数组
 */
export function assemblePrompt(o = {}) {
  const warnings = []
  const round = Number(o.round) || 1
  const facts = o.facts || {}

  // ── 第 4/6/9 步的来源：先把卡摊开 ──
  const parsed = parseCard(o.card || '')
  warnings.push(...parsed.warnings)

  // ★ 条件档开关（酒馆做法三：开关和内容分开）——
  //   关掉的条件节**从选择器输入里滤掉**，卡文件一个字节不动（sidecar 存开关）。
  const switched = applySwitches(parsed.sections, o.switches)
  if (switched.off.length) {
    warnings.push(`条件档已关闭（不影响卡）：${switched.off.join('、')}`)
  }
  const sectionsForSelect = switched.kept

  const residents = sectionsForSelect.filter((s) => s.tier === '常驻')
  const samples = sectionsForSelect.filter((s) => s.tier === '语料')

  // ── 第 9 步：条件命中（P2 的选择器；它自己管 ≤3 条、优先级、cooldown） ──
  const sel = selectConditions({
    sections: sectionsForSelect,
    facts: { ...facts, round },
    state: o.state || {},
    round,
  })
  warnings.push(...sel.warnings)

  // ── 第 5 步：风格层（给了 styleHome 才读；没有就跳过，行为与没有这层一致） ──
  const style = o.styleHome
    ? loadStyle({ home: o.styleHome, scene: o.styleScene, facts })
    : null

  // ── 第 10 步：槽命中（裁到 2 条） ──
  const habits = toArray(o.habits).slice(0, MAX_HABITS)

  // ── 第 8 步：惦记（裁到 3 条，按新旧——调用方已排好序） ──
  const thoughts = toArray(o.thoughts).slice(0, MAX_THOUGHTS)

  // ── 第 7 步：记忆召回 ──
  const memory = toArray(o.memory).slice(0, MAX_MEMORY_HINTS)

  // ── 第 6 步：语料只在前 3 轮 ──
  const useSamples = round <= COLD_START_ROUNDS ? samples : []

  // ── §4 预算：丢弃顺序固定「语料 → order 最大的条件 → 常驻末段」 ──
  //   ★ **丢整段，不砍字符**（§4 明令）—— 砍字符会让半句话进 prompt，比丢整段更伤行为。
  //   ★ 丢了什么必须报出来（判据 #6：「面板列出丢了哪几条」）⇒ 返回 dropped。
  const B = { ...DEFAULT_BUDGET, ...(o.budget || {}) }
  const dropped = []

  // ① 语料：从**最后一条**丢（文件顺序靠后的先丢）
  let sampleKeep = useSamples
  {
    let total = charLen(sampleKeep)
    while (sampleKeep.length && total > B.sample) {
      const s = sampleKeep[sampleKeep.length - 1]
      sampleKeep = sampleKeep.slice(0, -1)
      total -= String(s.body || '').length
      dropped.push({ tier: '语料', title: s.title })
    }
  }

  // ② 条件：**order 最大的先丢**；丢完仍保持原注入顺序（先按位置标，再 filter）
  let condKeep = sel.picked
  {
    let total = charLen(condKeep)
    if (total > B.condition) {
      const victims = condKeep
        .map((s, i) => ({ i, order: Number(s.order) || 100 }))
        .sort((a, b) => b.order - a.order || b.i - a.i)   // order 降序；同 order 靠后的先丢
      const dropIdx = new Set()
      for (const v of victims) {
        if (total <= B.condition) break
        dropIdx.add(v.i)
        total -= String(condKeep[v.i].body || '').length
        dropped.push({ tier: '条件', title: condKeep[v.i].title, order: v.order })
      }
      condKeep = condKeep.filter((_, i) => !dropIdx.has(i))
    }
  }

  // ③ 常驻末段：从**最后一个节**丢，至少留一个节（全丢了她就没有人设了）
  let resKeep = residents
  {
    let total = charLen(resKeep)
    while (resKeep.length > 1 && total > B.resident) {
      const s = resKeep[resKeep.length - 1]
      resKeep = resKeep.slice(0, -1)
      total -= String(s.body || '').length
      dropped.push({ tier: '常驻', title: s.title })
    }
    if (total > B.resident) {
      warnings.push(`常驻只剩 1 节仍超预算（${total}/${B.resident} 字）——§4 不许砍字符，故不丢`)
    }
  }

  if (dropped.length) {
    warnings.push(`超预算丢弃 ${dropped.length} 段（§4 顺序：语料 → order 最大的条件 → 常驻末段）：`
      + dropped.map((d) => `${d.tier}·${d.title}`).join('、'))
  }

  // ── 11 步按序拼 ──
  const parts = []

  // 1 身份行（一行）
  parts.push(o.role ? `你是${o.name}（角色 ${o.role}）。` : `你是${o.name}。`)

  // 2 场景锚（≤2 行）
  if (o.scene) {
    parts.push(o.who ? `当前在${o.scene}，对象是${o.who}。` : `当前在${o.scene}。`)
  }

  // 2+ §3.1 时间感：距上次对话过去了 <X> —— **超过 15 分钟才写**（快速对话不提醒）
  //   ★ 判据 1「隔三小时再聊，第一句能带出那个间隔」、判据 2「连续快速对话不出现」、
  //     判据 3「面板会话同样生效」都落在这里（面板场景没有 `kind`，但时间感与场景无关）。
  //   只给时长、不给解释（施工单原话）。
  const lastAt = Number(o.lastAt)
  if (Number.isFinite(lastAt) && lastAt > 0) {
    const elapsed = (Number(o.now) || Date.now()) - lastAt
    if (elapsed > GAP_MS) parts.push(`距上次对话过去了${formatDuration(elapsed)}`)
  }

  // 3 标签行 —— **必须有**（规格 §5：第一人称裸拼会被读成用户在自述）
  //   ★ 用预算过滤后的 resKeep/condKeep/sampleKeep（被丢的段不该再出现在「她的话」里）
  const hers = [
    ...resKeep.map((s) => s.body),
    ...(style ? [style.text] : []),
    ...condKeep.map((s) => s.body),
    ...sampleKeep.map((s) => s.body),
    ...habits,
    ...thoughts,
  ].filter((x) => String(x || '').trim() !== '')

  if (hers.length) parts.push('以下是她自己的话：')

  // 4 常驻（按文件顺序）
  for (const s of resKeep) if (s.body) parts.push(s.body)

  // 5 风格层（当前场景那一份）
  if (style && style.text) parts.push(style.text)

  // 6 语料（仅前 3 轮）
  for (const s of sampleKeep) if (s.body) parts.push(s.body)

  // 7 记忆召回
  if (memory.length) parts.push(memory.join('\n'))

  // 8 惦记（≤3 条话头）
  if (thoughts.length) parts.push(thoughts.join('\n'))

  // 9 条件命中（P2 按优先级/order/cooldown 挑好，§4 再按预算裁）
  for (const s of condKeep) if (s.body) parts.push(s.body)

  // 10 槽命中（行为纠正，≤2 条）
  if (habits.length) parts.push(habits.join('\n'))

  // 11 成长反哺（占末尾位，卡里不再放东西）
  if (o.growth) parts.push(String(o.growth))

  return {
    text: parts.filter((x) => String(x || '').trim() !== '').join('\n\n'),
    warnings,
    // §4 判据 #6：「面板列出丢了哪几条」——空数组表示没超预算
    dropped,
    used: {
      conditions: condKeep.length,
      // ★ 这一轮**真正注入**的条件标识 —— 调用方拿它回写 `state.cooldowns`
      //   （选择器不改 state，回写是调用方的活；判据专门钉了这条）。
      //   标识由 fishcard-select.sectionId 生成，两边必须是同一个函数，否则永远对不上。
      conditionIds: condKeep.map((s) => sectionId(s)),
      style: style ? style.scene : null,
      legacy: parsed.legacy,
    },
  }
}

/** 字符串/数组统一成数组；空值给空数组。 */
function toArray(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim() !== '')
  const s = String(v)
  return s.trim() === '' ? [] : [s]
}
