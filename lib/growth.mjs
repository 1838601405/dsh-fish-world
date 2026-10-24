// 鱼的成长：可修正的理解，而不是摘要累积。
//
// 设计参考 dsh-bili-humanism 的人格成长路线（MIT，见 THIRD-PARTY-NOTICES.md）：
//  - 账本（ledger.jsonl）是唯一事实来源，索引与导出都是派生文件，可重建；
//  - 每条记录保留来源（日记 / 批语 / 请求），能追问「这句是从哪来的」；
//  - 修订保留旧记录，不覆盖；撤回只留日期墓碑，模型不能把同一天悄悄放回；
//  - 允许「没有新认识」，不逼着每天凑一句；
//  - 每天有额度，同一句话不重复堆积。
//
// 与它不同的地方：这里的来源是鱼自己的日记、主人的批语和鱼的请求，
// 不是 B 站内容；成长影响的是鱼的性格与回应倾向，不涉及任何外部写入。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const GROWTH_DIR_NAME = 'fish-world-growth'
const LEDGER_NAME = 'ledger.jsonl'
const INDEX_NAME = 'index.json'
const MAX_TEXT = 240
const DAILY_LIMIT = 2
const MAX_ENTRIES = 5000

// 成长阶段：按已生效记录数推进，名字保持「鱼」的意象。
const STAGES = [
  { id: 'fry', name: '幼鱼', min: 0, note: '刚开始记事，什么都很新鲜。' },
  { id: 'young', name: '小鱼', min: 3, note: '开始有自己的判断，但还容易改。' },
  { id: 'growing', name: '长身体的鱼', min: 8, note: '会拿旧事对照新事，知道自己在变。' },
  { id: 'deep', name: '深水的鱼', min: 18, note: '有稳定的看法，也知道哪里还不确定。' },
  { id: 'elder', name: '老鲸', min: 36, note: '记得很久以前的事，不急着下结论。' },
]

const KINDS = new Set(['insight', 'next', 'milestone'])

// 北京时间日期：与人类作息对齐，避免跨零点把一天的记录劈成两半。
export function dayKeyShanghai(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return t.toISOString().slice(0, 10)
}

function cleanText(value, max = MAX_TEXT) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

export function createGrowthStore({ home = DSH_HOME, storage } = {}) {
  // 成长账本放在工作区里（<根>/鱼的成长）；没有接入存储层时退回旧位置。
  const fallbackDir = home === DSH_HOME ? join(DSH_HOME, GROWTH_DIR_NAME) : join(home, GROWTH_DIR_NAME)
  const dir = (() => {
    try {
      const growthDir = storage?.layout?.().growth
      if (growthDir) return growthDir
    } catch {}
    return fallbackDir
  })()
  const ledgerPath = join(dir, LEDGER_NAME)
  const indexPath = join(dir, INDEX_NAME)

  function ensureDir() {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function append(record) {
    ensureDir()
    // 超过上限就先滚动归档，避免账本无限增长。
    if (existsSync(ledgerPath)) {
      try {
        const size = readFileSync(ledgerPath).length
        if (size > 4 * 1024 * 1024) {
          renameSync(ledgerPath, join(dir, `ledger-${Date.now()}.jsonl`))
        }
      } catch {}
    }
    writeFileSync(ledgerPath, JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' })
  }

  function ledger() {
    return readLines(ledgerPath)
  }

  // 账本里同一 id 的多条是修订历史；取最后一条为当前值。
  function collapse(rows) {
    const byId = new Map()
    for (const row of rows) {
      if (!row || !row.id) continue
      byId.set(row.id, row)
    }
    return [...byId.values()]
  }

  function retractedDays(rows) {
    // retract 之后同一日期不可用；restore 之后重新生效。
    const blocked = new Set()
    for (const row of rows) {
      if (!row || !row.day) continue
      if (row.type === 'retract') blocked.add(row.day)
      if (row.type === 'restore') blocked.delete(row.day)
    }
    return blocked
  }

  // 当前生效的记录：排除被撤回的日期、被修订取代的旧版本，按时间倒序。
  function activeEntries(rows = ledger()) {
    const blocked = retractedDays(rows)
    const superseded = new Set(rows.filter((r) => r && r.type === 'revise').map((r) => r.id))
    return collapse(rows.filter((r) => r && r.type === 'entry'))
      .filter((r) => r.status === 'active' && !blocked.has(r.day) && !superseded.has(r.id))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }

  function stageFor(count) {
    let current = STAGES[0]
    for (const stage of STAGES) if (count >= stage.min) current = stage
    const next = STAGES.find((s) => s.min > count) || null
    return {
      ...current,
      next: next ? { id: next.id, name: next.name, min: next.min } : null,
      toNext: next ? next.min - count : 0,
      progress: next ? Math.min(1, (count - current.min) / Math.max(1, next.min - current.min)) : 1,
    }
  }

  function status() {
    const rows = ledger()
    const entries = activeEntries(rows)
    const stage = stageFor(entries.length)
    const days = [...new Set(entries.map((e) => e.day))].sort()
    return {
      ok: true,
      ready: true,
      total: entries.length,
      days: days.length,
      firstDay: days[0] || '',
      lastDay: days[days.length - 1] || '',
      stage,
      stages: STAGES,
      dailyLimit: DAILY_LIMIT,
      todayCount: entries.filter((e) => e.day === dayKeyShanghai()).length,
      byKind: {
        insight: entries.filter((e) => e.kind === 'insight').length,
        next: entries.filter((e) => e.kind === 'next').length,
        milestone: entries.filter((e) => e.kind === 'milestone').length,
      },
    }
  }

  // 写入一条成长记录。text 应当来自真实发生的事，不允许编造。
  function record({ text, kind = 'insight', source = null, quote = '' } = {}) {
    const clean = cleanText(text)
    if (!clean) throw new Error('成长记录不能为空')
    const effectiveKind = KINDS.has(kind) ? kind : 'insight'
    const day = dayKeyShanghai()
    const rows = ledger()
    const entries = activeEntries(rows)

    const todayCount = entries.filter((e) => e.day === day).length
    if (todayCount >= DAILY_LIMIT) throw new Error(`今天已经记了 ${DAILY_LIMIT} 条，允许没有新认识，不用凑数`)

    // 同一句话不重复堆积
    if (entries.some((e) => e.text === clean)) throw new Error('这句话已经记过了')

    const entry = {
      type: 'entry',
      id: randomUUID(),
      at: new Date().toISOString(),
      day,
      kind: effectiveKind,
      text: clean,
      quote: cleanText(quote, 120),
      source: source && typeof source === 'object'
        ? { type: cleanText(source.type, 24), id: cleanText(source.id, 64) }
        : null,
      revision: 1,
      supersedes: null,
      status: 'active',
    }
    append(entry)
    rebuildIndex()
    return { ok: true, entry }
  }

  // 修订：保留旧记录（supersedes 指向旧的），新旧都能查。
  function revise(id, { text } = {}) {
    const clean = cleanText(text)
    if (!clean) throw new Error('修订内容不能为空')
    const rows = ledger()
    const entries = activeEntries(rows)
    const previous = entries.find((e) => e.id === String(id))
    if (!previous) throw new Error('要修订的记录不存在或已撤回')
    if (previous.text === clean) throw new Error('修订内容与原来相同')

    const next = {
      ...previous,
      id: randomUUID(),
      at: new Date().toISOString(),
      text: clean,
      revision: Number(previous.revision || 1) + 1,
      supersedes: previous.id,
      status: 'active',
    }
    append({ ...next })
    // 旧记录标记为被取代，但保留在账本里可追溯
    append({ type: 'revise', id: previous.id, supersededBy: next.id, at: next.at })
    rebuildIndex()
    return { ok: true, entry: next, previous }
  }

  // 撤回某一天：写墓碑。模型不能把同一天的记录悄悄放回，只能由主人明确恢复。
  function retract(day) {
    const key = cleanText(day, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('撤回需要指定日期（YYYY-MM-DD）')
    const rows = ledger()
    const entries = activeEntries(rows).filter((e) => e.day === key)
    if (!entries.length) throw new Error('这一天没有可撤回的记录')
    append({ type: 'retract', day: key, at: new Date().toISOString(), count: entries.length })
    rebuildIndex()
    return { ok: true, day: key, retracted: entries.length }
  }

  function restore(day) {
    const key = cleanText(day, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('恢复需要指定日期（YYYY-MM-DD）')
    const rows = ledger()
    const tombstone = rows.filter((r) => r && r.type === 'retract' && r.day === key)
    if (!tombstone.length) throw new Error('这一天没有被撤回')
    append({ type: 'restore', day: key, at: new Date().toISOString() })
    rebuildIndex()
    return { ok: true, day: key }
  }

  function list({ limit = 30, offset = 0 } = {}) {
    const entries = activeEntries(ledger())
    const start = Math.max(0, Number(offset) || 0)
    const size = Math.max(1, Math.min(Number(limit) || 30, 200))
    return {
      ok: true,
      total: entries.length,
      offset: start,
      entries: entries.slice(start, start + size),
      next: start + size < entries.length ? start + size : null,
    }
  }

  function history(id) {
    const rows = ledger()
    const target = String(id || '')
    const chain = []
    let cursor = target
    for (let guard = 0; guard < 50 && cursor; guard += 1) {
      const found = rows.filter((r) => r && r.type === 'entry' && r.id === cursor).pop()
      if (!found) break
      chain.push(found)
      cursor = found.supersedes || ''
    }
    return { ok: true, id: target, revisions: chain.reverse() }
  }

  // 派生索引：记录数、各卷、每日额度使用情况；可与账本交叉校验。
  function rebuildIndex() {
    ensureDir()
    const rows = ledger()
    const entries = activeEntries(rows)
    const byDay = {}
    for (const entry of entries) byDay[entry.day] = (byDay[entry.day] || 0) + 1
    const index = {
      version: 1,
      rebuiltAt: new Date().toISOString(),
      ledger: LEDGER_NAME,
      entries: entries.length,
      ledgerLines: rows.length,
      byDay,
      ids: entries.map((e) => e.id),
      retracted: [...retractedDays(rows)],
    }
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
    return index
  }

  // 校验：索引与账本必须一致，不一致就明确报错，不返回"最近一段"冒充全量。
  // 全新安装时账本和索引都还不存在，这是空状态，不是不一致——
  // 只有账本里已经有记录却缺索引，才需要主人重建。
  function verify() {
    const rows = ledger()
    const entries = activeEntries(rows)
    const problems = []
    let index = null
    try { index = JSON.parse(readFileSync(indexPath, 'utf8')) } catch {}

    if (!index) {
      if (entries.length) problems.push('缺少索引文件，请重建索引')
    } else {
      if (index.entries !== entries.length) problems.push(`索引记录数 ${index.entries} 与账本 ${entries.length} 不一致`)
      const ids = new Set(entries.map((e) => e.id))
      const missing = (index.ids || []).filter((id) => !ids.has(id))
      if (missing.length) problems.push(`索引里有 ${missing.length} 条记录在账本中找不到`)
      if (entries.length > MAX_ENTRIES) problems.push(`账本超过 ${MAX_ENTRIES} 条，请先归档`)
    }
    return { ok: problems.length === 0, problems, entries: entries.length, ledgerLines: rows.length }
  }

  // 成长素材：从鱼自己的日记、主人的批语、鱼的请求里挑出可提炼的原料。
  // 只提供线索，不代替鱼判断，也不自动写成成长记录。
  function materials({ world, limit = 10 } = {}) {
    const out = []
    try {
      for (const item of world.listDiary({ limit: 20 }) || []) {
        out.push({ type: 'diary', id: item.id, at: item.at, text: cleanText(item.text, 200), actor: item.actorName })
      }
    } catch {}
    try {
      for (const item of world.listDiaryComments({}) || []) {
        out.push({
          type: 'comment',
          id: item.id,
          at: item.at,
          text: cleanText(item.text, 200),
          quote: item.quote || '',
          actor: item.actorName,
        })
      }
    } catch {}
    try {
      for (const item of world.listWishes({ limit: 30 }) || []) {
        out.push({
          type: 'wish',
          id: item.id,
          at: item.at,
          text: cleanText(item.text, 200),
          status: item.status,
          tone: item.tone || '',
        })
      }
    } catch {}
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return out.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)))
  }

  return {
    dir: () => dir,
    status,
    record,
    revise,
    retract,
    restore,
    list,
    history,
    verify,
    rebuildIndex,
    materials,
    __test: { cleanText, dayKeyShanghai, stageFor, STAGES, DAILY_LIMIT },
  }
}
