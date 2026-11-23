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
import { selectConditions } from './fishcard-select.mjs'
import { loadStyle } from './fishcard-style.mjs'

/** 语料只在会话前 3 轮出现（规格 §5 第 6 步）。 */
const COLD_START_ROUNDS = 3

/** 记忆召回上限（规格 §5 第 7 步：≤6 条）——调用方给多少这里不裁，只在注释里记口径。 */
const MAX_MEMORY_HINTS = 6

/** 槽命中上限（规格 §5 第 10 步：最多 2 条）。 */
const MAX_HABITS = 2

/** 惦记上限（规格 §5 第 8 步：≤3 条话头）。 */
const MAX_THOUGHTS = 3

/**
 * 按规格 §5 的 11 步拼出 system prompt。
 *
 * @param {object} o
 * @param {string} o.name         角色显示名（第 1 步）
 * @param {string} [o.role]       角色 id（第 1 步；没有就只给名字）
 * @param {string} [o.scene]      场景锚的场景（第 2 步，如 `QQ 群` / `私聊` / `面板`）
 * @param {string} [o.who]        场景锚的对象（第 2 步，如 `某人` / `主人`）
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
 * @returns {{ text: string, warnings: string[], used: { conditions: number, style: string|null, legacy: boolean } }}
 */
export function assemblePrompt(o = {}) {
  const warnings = []
  const round = Number(o.round) || 1
  const facts = o.facts || {}

  // ── 第 4/6/9 步的来源：先把卡摊开 ──
  const parsed = parseCard(o.card || '')
  warnings.push(...parsed.warnings)

  const residents = parsed.sections.filter((s) => s.tier === '常驻')
  const samples = parsed.sections.filter((s) => s.tier === '语料')

  // ── 第 9 步：条件命中（P2 的选择器；它自己管 ≤3 条、优先级、cooldown） ──
  const sel = selectConditions({
    sections: parsed.sections,
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

  // ── 11 步按序拼 ──
  const parts = []

  // 1 身份行（一行）
  parts.push(o.role ? `你是${o.name}（角色 ${o.role}）。` : `你是${o.name}。`)

  // 2 场景锚（≤2 行）
  if (o.scene) {
    parts.push(o.who ? `当前在${o.scene}，对象是${o.who}。` : `当前在${o.scene}。`)
  }

  // 3 标签行 —— **必须有**（规格 §5：第一人称裸拼会被读成用户在自述）
  const hers = [
    ...residents.map((s) => s.body),
    ...(style ? [style.text] : []),
    ...sel.picked.map((s) => s.body),
    ...useSamples.map((s) => s.body),
    ...habits,
    ...thoughts,
  ].filter((x) => String(x || '').trim() !== '')

  if (hers.length) parts.push('以下是她自己的话：')

  // 4 常驻（按文件顺序）
  for (const s of residents) if (s.body) parts.push(s.body)

  // 5 风格层（当前场景那一份）
  if (style && style.text) parts.push(style.text)

  // 6 语料（仅前 3 轮）
  for (const s of useSamples) if (s.body) parts.push(s.body)

  // 7 记忆召回
  if (memory.length) parts.push(memory.join('\n'))

  // 8 惦记（≤3 条话头）
  if (thoughts.length) parts.push(thoughts.join('\n'))

  // 9 条件命中（P2 已按优先级/order/cooldown 挑好）
  for (const s of sel.picked) if (s.body) parts.push(s.body)

  // 10 槽命中（行为纠正，≤2 条）
  if (habits.length) parts.push(habits.join('\n'))

  // 11 成长反哺（占末尾位，卡里不再放东西）
  if (o.growth) parts.push(String(o.growth))

  return {
    text: parts.filter((x) => String(x || '').trim() !== '').join('\n\n'),
    warnings,
    used: {
      conditions: sel.picked.length,
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
