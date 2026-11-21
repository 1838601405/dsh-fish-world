// 纠正记录存储（2026-11-21 新建）。
//
// ── 为什么新建 ──
// 主人给的公式是「纠正记录：slots（kind=speech）+ activity（kind=correction）计数」，
// 但实测这两处**都不存在**：
//   · slots.mjs 的 KIND 只有「事实 / 表情 / 梗」三类，没有 speech；
//   · 全仓 grep 不到 kind=correction。
// 所以「改口记录」那块此前没有任何数据可读 —— 面板只能显示"没有"。
//
// ── 这里的记录是什么 ──
// 一次纠正 = 她说了句不该这么说的，主人指出「应该这么说」。
// 字段按主人给的四项要求设计：
//   scene      场景（如「被夸的时候」）—— ④ 区第一行
//   sayInstead 该怎么说 —— ④ 区第二行（引用样式）
//   count      第几次（1 灰 / 2 橙 / 3 橙 + 已升级为检查）
//   promoted   是否已升级为检查（第 3 次自动置 true）
//
// ── 和成长条目的关联 ──
// 主人给的公式：`slotId ↔ growth.source`。
// 所以每条纠正有自己的 id，成长条目的 source 形如
//   { type: 'correction', id: '<纠正 id>' }
// 关联方向：成长 → 纠正（一条想通对应哪次纠正）。
// 反过来查"这条纠正有没有对应成长"用 index。
//
// ── 三要素 ──
// 主人要求「写成长必须有『原来 → 现在 → 因为哪件事』，quote 必须指到真实一句，
// 缺一不入库」。这里的 quote 就是**真实那一句**：纠正记录原话。
// 所以校验放在 growth.record 之外这一层：调用方必须传真实纠正 id。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 升级为检查的门槛：同一场景被纠正到这个次数就自动升级。 */
export const PROMOTE_AT = 3

/** 一天最多记几条纠正（防止刷）。 */
const DAILY_LIMIT = 20

function clean(v, max = 200) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max)
}

/** 上海时区的日期键（和 growth.mjs 同一口径，别各算各的）。 */
function dayKeyShanghai(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600_000)
  const y = t.getUTCFullYear()
  const m = String(t.getUTCMonth() + 1).padStart(2, '0')
  const d = String(t.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * @param {object} deps
 * @param {string} [deps.home]  DSH_HOME
 * @param {string} [deps.root]  鱼的世界根（给了就用它，优先级更高）
 * @param {object} [deps.storage] 审计
 * @param {() => number} [deps.now]
 */
export function createCorrectionStore({ home = process.env.DSH_HOME || 'D:/DSH-home', root, storage, now = () => Date.now() } = {}) {
  const baseRoot = root || home
  const dir = join(baseRoot, '鱼的成长', '纠正记录')
  const file = join(dir, 'corrections.jsonl')

  function ensure() {
    try { mkdirSync(dir, { recursive: true }) } catch {}
  }

  function readAll() {
    if (!existsSync(file)) return []
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return [] }
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
    return out
  }

  function append(obj) {
    ensure()
    try {
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
      writeFileSync(file, prev + JSON.stringify(obj) + '\n', 'utf8')
      return true
    } catch { return false }
  }

  /** 当前有效集合：后来的覆盖同 id 的早期版本（用于 promote / retract）。 */
  function current() {
    const byId = new Map()
    for (const row of readAll()) {
      if (!row || !row.id) continue
      if (row.type === 'retract') { byId.delete(row.id); continue }
      if (row.type === 'promote') {
        const cur = byId.get(row.id)
        if (cur) byId.set(row.id, { ...cur, promoted: true, promotedAt: row.at })
        continue
      }
      byId.set(row.id, row)
    }
    return [...byId.values()]
  }

  /**
   * 记一次纠正。
   *
   * @param {object} opts
   * @param {string} opts.scene        场景（必填，如「被夸的时候」）
   * @param {string} opts.sayInstead   该怎么说（必填，要在正文里能引用）
   * @param {string} [opts.saidWrong]  她当时说的（可选，便于对照）
   * @param {string} [opts.sourceQuote] 真实的那一句（必填会更好，但允许先空）
   */
  function record({ scene = '', sayInstead = '', saidWrong = '', sourceQuote = '' } = {}) {
    const 场景 = clean(scene, 60)
    const 该说 = clean(sayInstead, 200)
    if (!场景) throw new Error('要记个场景（比如「被夸的时候」），不然以后对不上')
    if (!该说) throw new Error('要记下「该怎么说」，只有场景没法学会')

    const day = dayKeyShanghai(new Date(now()))
    const all = current()
    const todayCount = all.filter((x) => x.day === day).length
    if (todayCount >= DAILY_LIMIT) throw new Error(`今天已经记了 ${DAILY_LIMIT} 条，够多了`)

    // 同一场景 + 同一说法 ⇒ 算「第 N 次」，不新增一条
    const same = all.find((x) => x.scene === 场景 && x.sayInstead === 该说)
    if (same) {
      const count = Number(same.count || 1) + 1
      const next = {
        ...same,
        type: 'entry',
        count,
        lastAt: new Date(now()).toISOString(),
        // ★ 第 3 次自动升级为检查（主人定的）
        promoted: count >= PROMOTE_AT ? true : Boolean(same.promoted),
        promotedAt: count >= PROMOTE_AT && !same.promoted ? new Date(now()).toISOString() : same.promotedAt
      }
      append(next)
      return { ok: true, entry: next, repeated: true, count }
    }

    const entry = {
      type: 'entry',
      id: randomUUID(),
      at: new Date(now()).toISOString(),
      day,
      scene: 场景,
      sayInstead: 该说,
      saidWrong: clean(saidWrong, 200),
      sourceQuote: clean(sourceQuote, 200),
      count: 1,
      promoted: false,
      promotedAt: '',
      status: 'active'
    }
    append(entry)
    try {
      storage?.appendSecurity?.({ role: 'fish', action: 'correction-record', recordId: entry.id })
    } catch {}
    return { ok: true, entry, repeated: false, count: 1 }
  }

  /** 手动升级为检查（主人可以直接点）。 */
  function promote(id) {
    const key = clean(id, 64)
    const target = current().find((x) => x.id === key)
    if (!target) throw new Error('没有这条纠正记录')
    if (target.promoted) return { ok: true, already: true, entry: target }
    const at = new Date(now()).toISOString()
    append({ type: 'promote', id: key, at })
    return { ok: true, already: false, entry: { ...target, promoted: true, promotedAt: at } }
  }

  /** 废弃（记错了 / 不再适用）。 */
  function retract(id) {
    const key = clean(id, 64)
    const target = current().find((x) => x.id === key)
    if (!target) throw new Error('没有这条纠正记录')
    append({ type: 'retract', id: key, at: new Date(now()).toISOString() })
    return { ok: true }
  }

  /**
   * 列表，供面板 ④ 区用。
   *
   * @param {object} [opts]
   * @param {string} [opts.tab]  'promoted'（想通了）/ 'corrected'（被纠正）/ ''（全部）
   */
  function list({ tab = '', limit = 60 } = {}) {
    let rows = current()
    if (tab === 'promoted') rows = rows.filter((x) => x.promoted)
    else if (tab === 'corrected') rows = rows.filter((x) => !x.promoted)
    rows.sort((a, b) => String(b.lastAt || b.at).localeCompare(String(a.lastAt || a.at)))
    return rows.slice(0, Math.max(1, Math.min(Number(limit) || 60, 200)))
  }

  /**
   * 统计，供 ② 区「改口」那张卡用。
   *
   * @param {object[]} growthEntries 成长条目（用来算「已升级 N 条 = 有对应成长的）
   */
  function stats(growthEntries = []) {
    const rows = current()
    const promoted = rows.filter((x) => x.promoted).length
    // 「已升级 N 条」—— 按主人公式是「有对应成长的」：
    //   成长条目的 source.type === 'correction' 且 id 命中某条纠正
    const linkedIds = new Set()
    for (const g of growthEntries) {
      const src = g && g.source
      if (src && src.type === 'correction' && src.id) linkedIds.add(String(src.id))
    }
    const linked = rows.filter((x) => linkedIds.has(String(x.id))).length
    const total = rows.reduce((n, x) => n + Math.max(1, Number(x.count) || 1), 0)
    return {
      records: rows.length,        // 记录条数（去重后的场景×说法）
      total,                       // 含重复次数的总数
      promoted,
      upgraded: linked,            // 有对应成长的（主人要的「已升级 N 条」）
      byTab: {
        promoted: promoted,
        corrected: rows.length - promoted
      }
    }
  }

  /** 查某条纠正（检查器用）。 */
  function get(id) {
    return current().find((x) => x.id === clean(id, 64)) || null
  }

  return {
    dir: () => dir,
    file: () => file,
    record,
    promote,
    retract,
    list,
    stats,
    get,
    current,
    PROMOTE_AT
  }
}
