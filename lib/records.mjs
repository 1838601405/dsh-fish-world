// 鱼的记录：主人让它记下的东西，一条一条存在本地，主人可以随时改或删。
//
// 落盘：<根>/鱼的记录/记录.jsonl
//   · 一行一条，追加写入；修改与删除也各追加一行（修订链保留，便于回溯）。
//
// 另外还有「小本本」：鱼的请求超时没被回复时，鱼自己记上一笔；
// 只有主人给出解释、并且鱼认可之后才划掉。落盘同上目录的 小本本.jsonl。
//
// 这两样都只属于鱼世界：不上传、不镜像，也不影响平台权限。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_FOLDER } from './storage.mjs'

const RECORDS_FOLDER = '鱼的记录'
const MEMO_FILE = '记录.jsonl'
const GRUDGE_FILE = '小本本.jsonl'
const MAX_TEXT = 500
const MAX_MEMOS = 2000

function safeText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function dayKey(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function createRecordStore({ storage, home, logger } = {}) {
  function dirFor() {
    try {
      const paths = storage?.layout?.()
      if (paths?.root) return join(paths.root, RECORDS_FOLDER)
    } catch {}
    // 没有存储层时退回旧习惯：与运行目录并列的「鱼的记录」。
    return join(home || '.', ROOT_FOLDER, RECORDS_FOLDER)
  }

  function fileOf(name) {
    return join(dirFor(), name)
  }

  function readLines(file) {
    try {
      return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
    } catch { return [] }
  }

  function append(file, row) {
    const dir = dirFor()
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(row) + '\n', { encoding: 'utf8', flag: 'a' })
  }

  /** 账本按 id 折叠：后写的覆盖先写的，删除写成 deleted 墓碑。 */
  function collapse(rows) {
    const byId = new Map()
    for (const row of rows) if (row && row.id) byId.set(row.id, { ...(byId.get(row.id) || {}), ...row })
    return [...byId.values()]
  }

  // ---- 记录（主人让它记的东西）----
  function listMemos({ limit = 200 } = {}) {
    const items = collapse(readLines(fileOf(MEMO_FILE)))
      .filter((row) => row.status !== 'deleted')
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return items.slice(0, Math.max(1, Math.min(Number(limit) || 200, MAX_MEMOS)))
  }

  function addMemo({ text, source = 'owner', day = '' } = {}) {
    const clean = safeText(text, MAX_TEXT)
    if (!clean) throw new Error('要记的内容不能为空')
    const row = {
      id: 'mem_' + randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      day: day || dayKey(),
      text: clean,
      source: source === 'fish' ? 'fish' : 'owner',
      revision: 1,
      status: 'active',
    }
    append(fileOf(MEMO_FILE), row)
    try { logger?.info?.(`[records] 记下：${clean.slice(0, 40)}`) } catch {}
    return { ok: true, item: row }
  }

  function updateMemo(id, { text } = {}) {
    const target = String(id || '').trim()
    const clean = safeText(text, MAX_TEXT)
    if (!target) throw new Error('缺少记录 id')
    if (!clean) throw new Error('内容不能为空')
    const current = listMemos({ limit: MAX_MEMOS }).find((item) => item.id === target)
    if (!current) throw new Error('没有找到这条记录')
    if (current.text === clean) throw new Error('内容和原来一样')
    const row = {
      ...current,
      text: clean,
      revision: Number(current.revision || 1) + 1,
      updatedAt: new Date().toISOString(),
    }
    append(fileOf(MEMO_FILE), row)
    return { ok: true, item: row, previous: current }
  }

  function removeMemo(id) {
    const target = String(id || '').trim()
    const current = listMemos({ limit: MAX_MEMOS }).find((item) => item.id === target)
    if (!current) return { ok: false, error: '没有找到这条记录' }
    append(fileOf(MEMO_FILE), { id: target, status: 'deleted', deletedAt: new Date().toISOString() })
    return { ok: true, removed: 1 }
  }

  // ---- 小本本（没被回复的请求）----
  // open → explained（主人写了说明）→ accepted（鱼认可，划掉）
  function listGrudges({ status = '', limit = 100 } = {}) {
    let items = collapse(readLines(fileOf(GRUDGE_FILE)))
    if (status) items = items.filter((row) => row.status === status)
    items = items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return items.slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)))
  }

  /** 同一个请求只记一笔；已经划掉的不会再重开。 */
  function openGrudge({ wishId, text, day = '', why = '', askedAt = '' } = {}) {
    const key = String(wishId || '').trim()
    const clean = safeText(text, MAX_TEXT)
    if (!key) throw new Error('缺少请求 id')
    if (!clean) throw new Error('请求内容不能为空')
    if (listGrudges({ limit: 500 }).some((row) => row.wishId === key)) return { ok: true, existed: true }
    const row = {
      id: 'grg_' + randomUUID().slice(0, 8),
      wishId: key,
      at: new Date().toISOString(),
      day: day || dayKey(),
      text: clean,
      // 为什么记在这里：主人要能一眼看到触发原因，而不是只看到一句请求。
      why: safeText(why, 200) || `因为这个请求（${day || dayKey()} 提的）当天没等到你的答复，鱼就自己记下了。`,
      askedAt: safeText(askedAt, 40),
      status: 'open',
      explanation: '',
      explainedAt: null,
      acceptedAt: null,
    }
    append(fileOf(GRUDGE_FILE), row)
    return { ok: true, item: row }
  }

  function explainGrudge(id, explanation) {
    const target = String(id || '').trim()
    const clean = safeText(explanation, MAX_TEXT)
    if (!target) throw new Error('缺少小本本 id')
    if (!clean) throw new Error('解释不能为空')
    const current = listGrudges({ limit: 500 }).find((row) => row.id === target)
    if (!current) throw new Error('没有找到这一条')
    if (current.status === 'accepted') throw new Error('这条已经划掉了')
    const row = { ...current, status: 'explained', explanation: clean, explainedAt: new Date().toISOString() }
    append(fileOf(GRUDGE_FILE), row)
    return { ok: true, item: row }
  }

  /** 只有鱼认可才划掉：主人解释完，等它在对话里点头（或它自己判断可以接受）。 */
  function acceptGrudge(id, { note = '' } = {}) {
    const target = String(id || '').trim()
    const current = listGrudges({ limit: 500 }).find((row) => row.id === target)
    if (!current) throw new Error('没有找到这一条')
    if (current.status === 'open') throw new Error('主人还没给解释，先等他说')
    const row = {
      ...current,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
      acceptNote: safeText(note, 200),
    }
    append(fileOf(GRUDGE_FILE), row)
    return { ok: true, item: row }
  }

  /**
   * 把过了日期还没被回复的请求记进小本本。
   * 当天的不算：主人还有一整天时间回。
   */
  function sweepPendingWishes(listWishes = () => []) {
    const today = dayKey()
    const opened = []
    for (const wish of listWishes() || []) {
      if (!wish || wish.status !== 'pending') continue
      const day = String(wish.day || String(wish.at || '').slice(0, 10))
      if (!day || day >= today) continue
      const askedAt = String(wish.at || '')
      const why = `这个请求（${day} ${askedAt.slice(11, 16)} 提的）到 ${today} 零点还没得到你的答复，鱼就把它记进了小本本。`
      const result = openGrudge({ wishId: wish.id, text: wish.text, day, why, askedAt })
      if (result.ok && !result.existed) opened.push(result.item)
    }
    return opened
  }

  function summary() {
    const memos = listMemos({ limit: MAX_MEMOS })
    const grudges = listGrudges({ limit: 500 })
    return {
      ok: true,
      dir: dirFor(),
      memos: memos.length,
      grudges: {
        open: grudges.filter((row) => row.status === 'open').length,
        explained: grudges.filter((row) => row.status === 'explained').length,
        accepted: grudges.filter((row) => row.status === 'accepted').length,
      },
      note: '记录由主人要求，一条一条存在本地；主人可以随时改或删。',
    }
  }

  return {
    dir: dirFor,
    listMemos,
    addMemo,
    updateMemo,
    removeMemo,
    listGrudges,
    openGrudge,
    explainGrudge,
    acceptGrudge,
    sweepPendingWishes,
    summary,
    __files: { memo: () => fileOf(MEMO_FILE), grudge: () => fileOf(GRUDGE_FILE) },
  }
}

export const __test = { dayKey, RECORDS_FOLDER }
