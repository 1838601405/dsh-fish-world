// 梗百科闸门：查梗只回「能用」的条目，禁用表在磁盘上、不进上下文。
//
// 为什么要这一层：dsh-memewiki 自带 6792 条，里面有涉政 / 低俗 / 擦边的梗。
// 这些词一旦进了上下文，模型就可能在群里念出来（还会被当成「知识」记住）。
// 所以：禁用表落盘（鱼的记忆/梗百科-禁用条目.json），由代码在查询与出站两处过滤，
// 提示词里一个字都不提这些条目。
//
// 数据源：dsh-memewiki 的 data/memes.db（只读）。Node 24 自带 node:sqlite，
// 没有就如实报「查不了」，不假装成功。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BLOCKED_FILE = '梗百科-禁用条目.json'

/** 找 dsh-memewiki 的词库：<home>/profiles/<profile>/node_modules/dsh-memewiki/data/memes.db，取第一个存在的。 */
export function findDb({ home } = {}) {
  const base = String(home || '')
  if (!base) return ''
  const profiles = join(base, 'profiles')
  try {
    for (const name of readdirSync(profiles)) {
      const file = join(profiles, name, 'node_modules', 'dsh-memewiki', 'data', 'memes.db')
      if (existsSync(file)) return file
    }
  } catch {}
  return ''
}

/** 禁用表默认位置：<世界根>/鱼的记忆/梗百科-禁用条目.json */
export function defaultBlockedFile(root) {
  return join(String(root || ''), '鱼的记忆', BLOCKED_FILE)
}

export function loadBlocked(file) {
  const fallback = { entries: [], blockedTags: [] }
  try {
    if (!file || !existsSync(file)) return fallback
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const entries = Array.isArray(raw?.entries)
      ? raw.entries.filter((row) => row && String(row.title || '').trim())
        .map((row) => ({ title: String(row.title).trim(), why: String(row.why || '').slice(0, 60) }))
      : []
    const blockedTags = Array.isArray(raw?.blockedTags)
      ? raw.blockedTags.map((tag) => String(tag || '').trim()).filter(Boolean)
      : []
    return { entries, blockedTags }
  } catch {
    return fallback
  }
}

/** 标题是否在禁用表里（精确匹配，忽略大小写与首尾空白）。 */
export function blockedByTitle(list, title) {
  const key = String(title || '').trim().toLowerCase()
  if (!key) return null
  return (list?.entries || []).find((row) => row.title.toLowerCase() === key) || null
}

function blockedByTagOf(list, tags) {
  const wanted = new Set((list?.blockedTags || []).map((tag) => tag.toLowerCase()))
  if (!wanted.size) return null
  const parts = String(tags || '').split(/[、,，|]/).map((x) => x.trim()).filter(Boolean)
  for (const tag of parts) {
    if (wanted.has(tag.toLowerCase())) return tag
  }
  // 「软色情营销」这类复合标签：包含即算，避免漏。
  for (const tag of parts) {
    for (const block of wanted) {
      if (block.length >= 2 && tag.toLowerCase().includes(block)) return block
    }
  }
  return null
}

/** 出站检查：这段要发出去的话里，有没有出现禁用条目的标题（≥2 字才算，避免误伤单字）。
 * 名单在磁盘、不在提示词里 —— 命中了就整条不发，让主人看得见。
 */
export function checkOutboundText(list, text) {
  const s = String(text || '')
  if (!s.trim()) return ''
  for (const row of list?.entries || []) {
    const title = row.title
    if (title.length < 2) continue
    if (s.includes(title)) return title
  }
  return ''
}

let dbCache = null
let dbMissing = false

async function openDb(dbPath) {
  if (dbCache || dbMissing) return dbCache
  try {
    const { DatabaseSync } = await import('node:sqlite')
    dbCache = new DatabaseSync(String(dbPath), { readOnly: true })
    return dbCache
  } catch {
    dbMissing = true
    return null
  }
}

/**
 * 查梗（带闸）：先按标题/别名精确查，再按标题包含查。
 * 命中禁用表或禁用标签 ⇒ 只回 { blocked:true, title, why }，不回 summary/usage。
 */
export async function lookup({ dbPath, blockedFile, query, limit = 3 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: '要给个词' }
  const list = loadBlocked(blockedFile)
  const db = await openDb(dbPath)
  if (!db) return { ok: false, error: '这台 Node 没有 node:sqlite，或词库文件不在了：' + String(dbPath || '') }

  const rows = []
  try {
    const exact = db.prepare('SELECT * FROM memes WHERE title = ?').get(q)
    if (exact) rows.push(exact)
    // 大小写不敏感再试一次：词库里是「V我50」，群里可能打成「v我50」。
    if (!rows.length) {
      const ci = db.prepare('SELECT * FROM memes WHERE lower(title) = lower(?) LIMIT 1').get(q)
      if (ci) rows.push(ci)
    }
    // 别名命中（词库里的 aliases 是逗号分隔的小写串，口径与 dsh-memewiki 自己的查法一致）。
    const byAlias = db.prepare(
      "SELECT * FROM memes WHERE aliases IS NOT NULL AND instr(',' || lower(aliases) || ',', ',' || lower(?) || ',') > 0 LIMIT 1",
    ).get(q)
    if (byAlias && !rows.some((it) => it.title === byAlias.title)) rows.push(byAlias)
    const fuzzy = db.prepare('SELECT * FROM memes WHERE instr(title, ?) > 0 ORDER BY length(title) ASC LIMIT ?').all(q, limit)
    for (const row of fuzzy) if (!rows.some((it) => it.title === row.title)) rows.push(row)
  } catch (error) {
    return { ok: false, error: '词库查不动：' + String(error?.message || error) }
  }
  if (!rows.length) return { ok: true, items: [], blocked: 0, note: '词库里没这条' }

  const items = []
  let blocked = 0
  for (const row of rows.slice(0, limit)) {
    const byTitle = blockedByTitle(list, row.title)
    const byTag = blockedByTagOf(list, row.tags)
    if (byTitle || byTag) {
      blocked += 1
      items.push({ title: row.title, blocked: true, why: byTitle ? byTitle.why : ('标签命中：' + byTag) })
      continue
    }
    items.push({
      title: row.title,
      blocked: false,
      summary: String(row.summary || '').slice(0, 200),
      usage: String(row.usage || '').slice(0, 120),
      tags: String(row.tags || '').slice(0, 120),
    })
  }
  return { ok: true, items, blocked }
}

export function status({ dbPath, blockedFile } = {}) {
  const list = loadBlocked(blockedFile)
  return {
    ok: true,
    dbPath: String(dbPath || ''),
    dbExists: Boolean(dbPath && existsSync(dbPath)),
    blockedFile: String(blockedFile || ''),
    blockedFileExists: Boolean(blockedFile && existsSync(blockedFile)),
    blockedEntries: list.entries.length,
    blockedTags: list.blockedTags.length,
  }
}
