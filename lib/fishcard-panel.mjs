// 设置面数据（酒馆做法一 + 二）：**每一项标明属于哪一层** + **看得见生效没有**。
//
// 主人 2026-11-24：
//   一、「我改了这里，到底动的是全局还是这一张卡」没人说得清 ⇒ 每项带 `layer`，
//      判据：任一设置项，能在界面上看出作用范围，**不用读文档**。
//   二、要轻版「预览最终拼出来的东西」：每项旁显示
//      「**当前是否启用 / 本轮有没有命中 / 上次触发是什么时候**」，
//      判据：改完一个设置，**不离开页面就能确认生效**，不用翻日志。
//
// ── 层级怎么判（改了影响谁）──
//   预设  ← 卡的正文（改它要动 `人设预设/*.md`，影响**所有用这个预设的角色**）
//   角色  ← 应用结果与它的 sidecar（开关、来源记录）—— 影响**这一个角色的所有会话**
//   会话  ← 跨轮状态（cooldown、轮号）—— 只影响**这一场**
//   全局  ← 世界级（惦记、风格层）—— 影响**所有人设**
//
// ★ 这里只**组装数据**（纯函数，可单测）；界面读它渲染 —— 判据只到数据层。

import { readSwitches } from './fishcard-switch.mjs'
import { selectConditions, sectionId } from './fishcard-select.mjs'

/** 层级说明（界面上的短标签；**只在读法推不出时写** —— 主人「别学的地方」第 2 条）。 */
export const LAYER_HINT = Object.freeze({
  预设: '改它要动预设库，影响所有用这个预设的角色',
  角色: '只影响这个角色',
  会话: '只影响这一场对话',
  全局: '影响所有人设',
})

/**
 * 一张卡在**给定 facts** 下的设置面（每项带层级与生效状态）。
 *
 * @param {object} o
 * @param {Array} o.sections  `parseCard` 的 sections
 * @param {object} [o.facts]  当前事实（判「本轮有没有命中」用）
 * @param {object} [o.state]  跨轮状态（cooldowns / lastHits）
 * @param {object} [o.switches] `readSwitches` 的结果（开关）
 * @param {number} [o.round]  当前轮号
 * @returns {{items:Array, summary:object}}
 *   item: { title, tier, layer, layerHint, enabled, hitNow, lastHitAt, cooldown, order }
 */
export function conditionPanel({ sections, facts = {}, state = {}, switches, round = 1 } = {}) {
  const all = Array.isArray(sections) ? sections : []
  const disabled = new Set(Array.isArray(switches?.disabled) ? switches.disabled : [])
  const lastHits = (state && typeof state.lastHits === 'object' && state.lastHits) || {}

  // 本轮谁真的进了（跑一次选择器 —— 与装配同一条路，避免「面板说命中、实际没进」）
  let pickedNow = new Set()
  try {
    const sel = selectConditions({ sections: all, facts: { ...facts, round }, state, round })
    pickedNow = new Set(sel.picked.map((s) => String(s.title)))
  } catch { /* 选择器出错不影响面板（每项 hitNow 给 false） */ }

  const items = all.map((s) => {
    const title = String(s.title || '')
    const enabled = !disabled.has(title)
    const isCondition = s.tier === '条件'
    // ★ 一条条件档的**不同字段分属不同层** —— 只标一个 `layer` 答不了「改了影响谁」
    //   （第一版我写成三个分支全返回 '预设'，等于没标）。
    //   逐字段标：正文在预设库、开关在角色 sidecar、冷却在会话状态。
    return {
      title,
      tier: s.tier,
      layer: '预设',                     // 这条的**正文**在哪层（主标签）
      layerHint: LAYER_HINT['预设'],
      fields: {
        正文: '预设',                    // 改它要动人设预设/*.md
        开关: '角色',                    // sidecar：<role>.md.switches.json
        ...(isCondition ? { 冷却: '会话' } : {}),   // cooldown 是跨轮状态
      },
      enabled,                                        // ★ 二·当前是否启用
      hitNow: enabled && isCondition && pickedNow.has(title),   // ★ 二·本轮有没有命中
      lastHitAt: lastHits[title] || null,              // ★ 二·上次触发（跨轮 state）
      cooldown: Number(s.cooldown) || 0,
      order: Number(s.order) || 100,
      keys: Array.isArray(s.keys) ? s.keys : [],
      when: String(s.when || ''),
    }
  })

  return {
    items,
    summary: {
      total: items.length,
      conditions: items.filter((i) => i.tier === '条件').length,
      off: items.filter((i) => !i.enabled).length,
      hitNow: items.filter((i) => i.hitNow).length,
      round: Number(round) || 1,
    },
  }
}

/**
 * 记一次「哪条命中了」——调用方在装配后调，写进 `state.lastHits`（判据二的「上次触发」）。
 * @returns {object} 要回写进 state 的 patch（调用方自己 patchState，选择器/装配不改 state）
 */
export function noteHits({ titles = [], now = Date.now(), prev = {} } = {}) {
  const next = { ...(prev && typeof prev === 'object' ? prev : {}) }
  for (const t of titles) if (t) next[String(t)] = Number(now) || Date.now()
  return next
}

/** 供面板直接用：按 tier 分组（常驻/条件/语料各一栏）。 */
export function groupByTier(items) {
  const g = { 常驻: [], 条件: [], 语料: [] }
  for (const i of Array.isArray(items) ? items : []) {
    const k = g[i.tier] ? i.tier : '常驻'
    g[k].push(i)
  }
  return g
}
