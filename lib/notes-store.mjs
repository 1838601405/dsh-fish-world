import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DSH_HOME } from './paths.mjs'

const DIR_NAME = '鱼的笔记'
const FILE_NAME = 'notes.json'
const MAX_TITLE = 120
const MAX_BODY = 20000
const MAX_FOLDER = 40

const nowIso = () => new Date().toISOString()

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').slice(0, max)
}

export function createNotesStore({ storage, home = DSH_HOME, logger, seedPath } = {}) {
  const dir = (() => {
    try {
      const root = storage?.layout?.().root
      if (root) return join(root, DIR_NAME)
    } catch {}
    return join(home, DIR_NAME)
  })()
  const file = join(dir, FILE_NAME)
  const bak = file + '.bak'
  const seed = seedPath || fileURLToPath(new URL('../data/notes-seed.json', import.meta.url))

  function ensureDir() {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function readRaw() {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }

  function migrate() {
    if (existsSync(file)) return
    ensureDir()
    let items = []
    try {
      const raw = JSON.parse(readFileSync(seed, 'utf8'))
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : [])
      const at = nowIso()
      items = list.map((x) => ({
        id: String(x.id || randomUUID()),
        title: clean(x.title, MAX_TITLE),
        body: clean(x.body, MAX_BODY),
        folder: clean(x.folder || '未分组', MAX_FOLDER) || '未分组',
        parent: String(x.parent || ''),
        links: Array.isArray(x.links) ? x.links.map(String) : [],
        x: Number(x.x) || 0,
        y: Number(x.y) || 0,
        src: String(x.src || ''),
        createdAt: x.createdAt || x.mtime || at,
        updatedAt: x.updatedAt || x.mtime || at,
      }))
    } catch (error) {
      try { logger?.warn?.('fish-world: 笔记种子导入失败：' + (error?.message || error)) } catch {}
    }
    writeFileSync(file, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
    try { logger?.info?.('fish-world: 笔记存储已建（导入 ' + items.length + ' 条）') } catch {}
  }

  function load() {
    migrate()
    const raw = readRaw()
    const items = Array.isArray(raw?.items) ? raw.items : []
    return { version: 1, items }
  }

  function backup() {
    try { if (existsSync(file)) copyFileSync(file, bak) } catch {}
  }

  function persist(next) {
    ensureDir()
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
    const back = readRaw()
    if (!back || !Array.isArray(back.items)) throw new Error('写入后回读失败')
    return back
  }

  function list() {
    return { ok: true, dir, items: load().items }
  }

  function save({ id, title, body, folder, parent, links, x, y, src } = {}) {
    const t = clean(title, MAX_TITLE).trim()
    if (!t) throw Object.assign(new Error('标题不能为空'), { status: 400 })
    const f = clean(folder, MAX_FOLDER).trim()
    if (!f) throw Object.assign(new Error('分组不能为空'), { status: 400 })
    const b = clean(body, MAX_BODY)
    const data = load()
    const at = nowIso()
    const idx = id ? data.items.findIndex((x) => x.id === id) : -1
    let item
    if (idx >= 0) {
      item = { ...data.items[idx], title: t, body: b, folder: f, updatedAt: at }
      data.items[idx] = item
      if (parent != null) item.parent = String(parent || '')
      if (Array.isArray(links)) item.links = links.map(String)
      if (x != null) item.x = Number(x) || 0
      if (y != null) item.y = Number(y) || 0
      if (src != null) item.src = String(src || '')
    } else {
      item = { id: String(id || randomUUID()), title: t, body: b, folder: f, parent: String(parent || ''), links: Array.isArray(links) ? links.map(String) : [], x: Number(x) || 0, y: Number(y) || 0, src: String(src || ''), createdAt: at, updatedAt: at }
      data.items.push(item)
    }
    backup()
    const back = persist(data)
    const saved = back.items.find((x) => x.id === item.id)
    if (!saved || saved.title !== t) {
      try { if (existsSync(bak)) copyFileSync(bak, file) } catch {}
      throw new Error('保存后回读不一致，已回滚')
    }
    return { ok: true, item: saved, items: back.items }
  }

  function remove({ id } = {}) {
    if (!id) throw Object.assign(new Error('缺少 id'), { status: 400 })
    const data = load()
    const before = data.items.length
    data.items = data.items.filter((x) => x.id !== id)
    if (data.items.length === before) return { ok: false, error: '没有这条笔记' }
    backup()
    const back = persist(data)
    if (back.items.some((x) => x.id === id)) throw new Error('删除后回读不一致')
    return { ok: true, items: back.items }
  }

  function move({ id, folder } = {}) {
    if (!id) throw Object.assign(new Error('缺少 id'), { status: 400 })
    const f = clean(folder, MAX_FOLDER).trim()
    if (!f) throw Object.assign(new Error('分组不能为空'), { status: 400 })
    const data = load()
    const item = data.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '没有这条笔记' }
    item.folder = f
    item.updatedAt = nowIso()
    backup()
    const back = persist(data)
    return { ok: true, items: back.items }
  }

  return { dir, list, save, remove, move }
}
