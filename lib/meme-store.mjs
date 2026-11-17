// 把候选梗写进现有 知识库.json：去重、只追加 alias、或新建 pending 条目。
import { existsSync, copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { findDuplicate, buildPendingItem } from './meme-capture.mjs'

export function addCandidate({ file, candidate, source, now = Date.now() }) {
  if (!file || !existsSync(file)) return { ok: false, error: '知识库文件不在了' }
  if (!candidate || !candidate.name) return { ok: false, error: '候选没有名字' }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, error: '知识库读不动：' + String(error?.message || error) }
  }
  const items = Array.isArray(raw.items) ? raw.items : []
  const hit = findDuplicate(items, candidate.name)
  if (hit) {
    // 命中已有：只追加一条 alias，不新建（同一条目也补一次 source 里的原句线索）。
    const aliases = Array.isArray(hit.aliases) ? hit.aliases : []
    if (!aliases.includes(candidate.name) && hit.name !== candidate.name) aliases.push(candidate.name)
    hit.aliases = aliases
    raw.exportedAt = new Date(now).toISOString()
    writeAtomic(file, raw)
    return { ok: true, action: 'alias', id: hit.id, name: hit.name }
  }
  const item = buildPendingItem({
    name: candidate.name,
    kind: candidate.kind,
    why: candidate.why,
    sentence: candidate.sentence,
    meaning: candidate.meaning,
    source,
    now,
  })
  items.push(item)
  raw.items = items
  raw.exportedAt = new Date(now).toISOString()
  writeAtomic(file, raw)
  return { ok: true, action: 'new', id: item.id, name: item.name }
}

function writeAtomic(file, raw) {
  copyFileSync(file, file + '.bak-meme')
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
  renameSync(tmp, file)
}

// 主人确认 / 拒绝：pending → confirmed / rejected。
export function setStatus({ file, id, status }) {
  if (!file || !existsSync(file)) return { ok: false, error: '知识库文件不在了' }
  if (!['confirmed', 'rejected', 'pending'].includes(status)) return { ok: false, error: '状态不对' }
  const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const items = Array.isArray(raw.items) ? raw.items : []
  const item = items.find((it) => String(it.id || '') === String(id))
  if (!item) return { ok: false, error: '知识库里没有这一条' }
  item.status = status
  item.checkedAt = Date.now()
  raw.exportedAt = new Date().toISOString()
  writeAtomic(file, raw)
  return { ok: true, id, status }
}

// 面板列表：按 status 筛。
export function listByStatus(file, status) {
  if (!file || !existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const items = Array.isArray(raw.items) ? raw.items : []
    if (!status) return items
    return items.filter((it) => String(it.status || 'confirmed') === status)
  } catch {
    return []
  }
}
