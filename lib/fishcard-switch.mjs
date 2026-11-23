// 条件档开关（酒馆做法三：开关和内容分开）—— 关掉一条，**卡文件一个字节都不动**。
//
// 主人 2026-11-24：
//   「卡里的条件档已经是内容，缺的是『这一条单独关掉』的能力 ——
//     关掉不影响卡本身，也不改动文件。」
//   判据：关掉一条条件档，卡文件逐字节不变；重新打开后行为与关之前一致。
//
// ★ 为什么不写进卡：卡是主人定的字（改它要问），且开关是**运行态**（今天关明天开），
//   混进内容就分不清「她不这么说」是设定还是被关了。
// ★ 键用**标题**不用 sectionId（title::body指纹）：改正文不该让开关失效。
// ★ 落点与来源记录同款：`fish-world-personas/<role>.switches.json`（sidecar，不碰卡）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 被关掉的条件档标题（`disabled` 数组）。 */
export function readSwitches(personaRoot, roleId = 'default') {
  try {
    const file = switchFile(personaRoot, roleId)
    if (!existsSync(file)) return { disabled: [] }
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(j?.disabled) ? j.disabled : []
    return { disabled: list.map((x) => String(x)).filter(Boolean) }
  } catch {
    return { disabled: [] }     // 坏文件当没关（不吞内容）
  }
}

function switchFile(personaRoot, roleId) {
  // ★ 与来源记录同款：`default.md.applied.json` ⇒ 这里 `default.md.switches.json`
  //   （第一版我写成 `default.switches.json` —— 少了卡的 `.md`，与 applied 不同款）
  return join(String(personaRoot), `${String(roleId || 'default')}.md.switches.json`)
}

/**
 * 开/关一条条件档。
 *
 * @param {object} o
 * @param {string} o.personaRoot `fish-world-personas` 目录
 * @param {string} [o.roleId]    角色 id（默认 default）
 * @param {string} o.title       条件档标题（卡里 `### 【条件 …】标题` 的标题）
 * @param {boolean} o.enabled    true=打开 / false=关掉
 * @returns {{ok:boolean, disabled:string[], error?:string}}
 *   ★ 只写 switches.json —— **卡文件一个字节都不动**（判据钉这条）
 */
export function setConditionEnabled({ personaRoot, roleId = 'default', title, enabled } = {}) {
  if (!personaRoot) return { ok: false, disabled: [], error: '要给 personaRoot' }
  const t = String(title || '').trim()
  if (!t) return { ok: false, disabled: [], error: '要给条件档的标题' }

  const cur = readSwitches(personaRoot, roleId)
  const set = new Set(cur.disabled)
  if (enabled === false) set.add(t)
  else set.delete(t)
  const next = [...set]

  try {
    const file = switchFile(personaRoot, roleId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ disabled: next }, null, 2), 'utf8')
    return { ok: true, disabled: next }
  } catch (e) {
    return { ok: false, disabled: cur.disabled, error: `写入失败：${e.message}` }
  }
}

/**
 * 从一批条件节里**滤掉被关掉的**（选择器调用前过一道）。
 *
 * @param {Array} sections `parseCard` 的 sections（或已筛过的条件节）
 * @param {object} switches `readSwitches` 的结果
 * @returns {{kept:Array, off:string[]}} `off` = 这次被关掉的标题（给面板/日志用）
 */
export function applySwitches(sections, switches) {
  const off = Array.isArray(switches?.disabled) ? switches.disabled : []
  if (!off.length) return { kept: Array.isArray(sections) ? sections : [], off: [] }
  const set = new Set(off)
  const kept = (Array.isArray(sections) ? sections : []).filter((s) => !set.has(String(s?.title || '')))
  const hit = (Array.isArray(sections) ? sections : [])
    .filter((s) => set.has(String(s?.title || '')))
    .map((s) => String(s.title))
  return { kept, off: hit }
}

/** 面板/排查用：这个角色现在关了哪几条。 */
export function disabledList(personaRoot, roleId = 'default') {
  return readSwitches(personaRoot, roleId).disabled
}
