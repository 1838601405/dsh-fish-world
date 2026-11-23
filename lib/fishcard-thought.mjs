// 鱼卡 v3 惦记档（2026-11-23 施工单 §5 · 落点由主人 2026-11-23 拍板：`鱼的状态/惦记.json`）。
//
// > 一句没答完或没问出口的话，不是待办清单。
// > 蔡加尼克是「没做完的爱冒出来」，不是「记得更多」——**不能当完成率指标**。
//
// ── 落点 ──
// `<世界根>/鱼的状态/惦记.json`（**数组**）。施工单原写「挂在已有的 world json 数组里，
// 不新建存储」，但四个候选（people/chats/世界设置/上线状态）语义都不合适 ⇒ 触发红线停下来说，
// 主人选了 C：**新建这一个文件**（`发给AI.md` 的红线由主人本人豁免）。
//
// ── 结构（施工单原样）──
//   { who, topic, hookedAt, expiryAt, picked }
//   · `picked` 用**次数**（0=没注入过 / 1=注入过 / ≥2=不再捡）——
//     §5「没接上 → 最多再捡一次」要计数，boolean 表达不了「再一次」。
//
// ── 三条规则（§5）──
//   · 上限 3 条，超了按**时间**淘汰（最旧的先走）
//   · 闭合：接上 → **下一轮消失**；没接上 → 最多再捡一次；24h 没动 → 过期并记 activity
//   · 只能从真实对话里抽、只能来自**她参与过**的对话（照「只记录聊过的人」那条边界）
//
// ── 「接上」怎么判 ──
// `listThoughts({ text })` 会拿**这一轮的文本**去比对 `topic`：命中 = 话题接上了 ⇒
// 当轮就不注入（grep 为 0）并落盘移除（判据 #7「接上后下一轮 grep 为 0」）。
// 另有 `closeThought()` 给调用方**主动关**（她答上了但字面没撞词的情况）。
//
// ── 抽取 ──
// 「没答完/没问出口」的现成判据是 `qq-inbox.looksUnfinished`（`…`/`——`/语气词结尾/短于 12 字），
// 这里**不重复造**：`hookThought()` 接受由调用方判定过的句子（复用优先）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 落点：`<世界根>/鱼的状态/惦记.json`（主人拍板）。 */
export const THOUGHT_FILE = '鱼的状态/惦记.json'

/** 上限 3 条（§5）。 */
export const MAX_THOUGHTS = 3

/** 24 小时没动就过期（§5）。 */
export const EXPIRE_MS = 24 * 60 * 60 * 1000

/** 「最多再捡一次」—— 注入过 1 次后还有第 2 次机会，第 3 次起不再捡。 */
export const MAX_PICKS = 2

function fileOf(worldRoot) {
  return join(String(worldRoot), THOUGHT_FILE)
}

function readAll(worldRoot) {
  try {
    const p = fileOf(worldRoot)
    if (!existsSync(p)) return []
    const data = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(data) ? data.filter((x) => x && typeof x === 'object') : []
  } catch {
    return []
  }
}

function writeAll(worldRoot, list) {
  const p = fileOf(worldRoot)
  try {
    mkdirSync(join(String(worldRoot), '鱼的状态'), { recursive: true })
    writeFileSync(p, JSON.stringify(list, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 按 `hookedAt` 升序（最旧在前，淘汰时先走）。 */
function byAge(list) {
  return [...list].sort((a, b) => (Number(a.hookedAt) || 0) - (Number(b.hookedAt) || 0))
}

/**
 * 挂一条惦记。
 *
 * @param {object} o
 * @param {string} o.worldRoot 世界根
 * @param {string} o.who        谁（照「只记录聊过的人」：只能是她参与过的对话里的人）
 * @param {string} o.topic      那句没答完/没问出口的话（或它的关键词）
 * @param {number} [o.now]      当前时间戳（ms）
 * @returns {{ok:boolean, list:Array, evicted?:string, error?:string}}
 */
export function hookThought({ worldRoot, who, topic, now = Date.now() } = {}) {
  if (!worldRoot) return { ok: false, list: readAll(worldRoot), error: '要给 worldRoot' }
  const t = String(topic || '').trim()
  if (!t) return { ok: false, list: readAll(worldRoot), error: 'topic 不能为空（得是那句没说完的话）' }

  const list = readAll(worldRoot)
  // 同一个人同一个话题不重复挂（惦记不是清单，重复挂就成了待办）
  if (list.some((x) => String(x.who) === String(who || '') && String(x.topic) === t)) {
    return { ok: true, list, error: '' }
  }

  const item = {
    who: String(who || ''),
    topic: t,
    hookedAt: Number(now) || Date.now(),
    expiryAt: (Number(now) || Date.now()) + EXPIRE_MS,
    picked: 0,
  }
  list.push(item)

  // 上限 3 条，超了按时间淘汰（最旧的先走）
  let evicted
  const sorted = byAge(list)
  while (sorted.length > MAX_THOUGHTS) {
    const gone = sorted.shift()
    if (gone) evicted = String(gone.topic)
  }
  writeAll(worldRoot, sorted)
  return { ok: true, list: sorted, ...(evicted ? { evicted } : {}) }
}

/**
 * 取这一轮**该注入**的惦记（≤3 条，按新旧 —— 新的在前）。
 *
 * 三件事在这里一起做（判据 #7 的三条）：
 *   ① **接上就消失**：给了 `text` 且命中 `topic` ⇒ 当轮不注入 + 落盘移除（grep 为 0）
 *   ② **24h 过期**：`now > expiryAt` ⇒ 移除，并调 `onExpire`（调用方拿去记 activity）
 *   ③ **最多再捡一次**：`picked >= MAX_PICKS` ⇒ 不再注入（但仍留在文件里直到过期）
 *
 * @param {object} o
 * @param {string} o.worldRoot
 * @param {number} [o.now]
 * @param {string} [o.text] 这一轮的文本（用来判「接上没有」）
 * @param {(item:object) => void} [o.onExpire] 过期回调（§5「过期并记 activity」）
 * @returns {{thoughts:Array, expired:Array, closed:Array, changed:boolean}}
 */
export function listThoughts({ worldRoot, now = Date.now(), text = '', onExpire } = {}) {
  if (!worldRoot) return { thoughts: [], expired: [], closed: [], changed: false }
  const all = readAll(worldRoot)
  const t = String(text || '')
  const kept = []
  const expired = []
  const closed = []

  for (const item of all) {
    // ② 过期
    if ((Number(item.expiryAt) || 0) <= Number(now)) {
      expired.push(item)
      try { if (typeof onExpire === 'function') onExpire(item) } catch { /* 记账失败不影响主流程 */ }
      continue
    }
    // ① 接上：这一轮的文本撞到话题 ⇒ 当轮消失
    if (t && item.topic && t.includes(String(item.topic))) {
      closed.push(item)
      continue
    }
    // ③ 捡够了的不再注入（但留着等过期，别丢信息）
    if (Number(item.picked) >= MAX_PICKS) continue
    kept.push(item)
  }

  const changed = expired.length > 0 || closed.length > 0
  if (changed) writeAll(worldRoot, kept.concat(all.filter((x) => !kept.includes(x) && !expired.includes(x) && !closed.includes(x))))

  // 新的在前（§5「≤3 条话头，按新旧」），再裁到上限
  const sorted = kept.sort((a, b) => (Number(b.hookedAt) || 0) - (Number(a.hookedAt) || 0)).slice(0, MAX_THOUGHTS)
  return { thoughts: sorted, expired, closed, changed }
}

/** 标记「这一轮注入过了」（`picked` +1 —— 「最多再捡一次」靠它计数）。 */
export function markPicked({ worldRoot, topic, now = Date.now() } = {}) {
  if (!worldRoot) return { ok: false, list: [] }
  const list = readAll(worldRoot)
  const hit = list.find((x) => String(x.topic) === String(topic))
  if (!hit) return { ok: false, list }
  hit.picked = Number(hit.picked || 0) + 1
  hit.lastPickedAt = Number(now) || Date.now()
  writeAll(worldRoot, list)
  return { ok: true, list }
}

/** 主动闭合（她答上了但字面没撞词时，调用方调这个）。 */
export function closeThought({ worldRoot, topic } = {}) {
  if (!worldRoot) return { ok: false, list: [] }
  const list = readAll(worldRoot)
  const next = list.filter((x) => String(x.topic) !== String(topic))
  const ok = next.length !== list.length
  if (ok) writeAll(worldRoot, next)
  return { ok, list: next }
}

/** 排查/面板用：现在挂着几条。 */
export function countThoughts(worldRoot) {
  return readAll(worldRoot).length
}
