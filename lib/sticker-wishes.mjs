// 鱼想收藏：鱼自己挑中的图先排队，主人在「鱼的请求」页点头之后才进图库。
//
// 落盘：<鱼的世界>/鱼的请求/想收藏/
//   · <id>.<png|jpg|gif|webp> —— 候选图
//   · pending.json —— 候选清单（名字、理由、提交时间）
//
// 审批通过才调用 stickers.adopt 写进图库；「不要」直接删图，不留痕。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createStickerWishes({ storage, stickers, home, logger } = {}) {
  const dir = () => {
    let root = ''
    try { root = storage?.layout?.().root || '' } catch {}
    const d = join(root || join(home || '.', 'fish-world'), '鱼的请求', '想收藏')
    mkdirSync(d, { recursive: true })
    return d
  }

  const indexFile = () => join(dir(), 'pending.json')

  function load() {
    try {
      const raw = JSON.parse(readFileSync(indexFile(), 'utf8'))
      return Array.isArray(raw?.items) ? raw : { version: 1, items: [] }
    } catch {
      return { version: 1, items: [] }
    }
  }

  function save(data) {
    writeFileSync(indexFile(), JSON.stringify(data, null, 2), 'utf8')
  }

  function list() {
    const data = load()
    const items = data.items.filter((item) => item && existsSync(join(dir(), String(item.file || ''))))
    return { ok: true, dir: dir(), items }
  }

  function drop(item) {
    try { rmSync(join(dir(), String(item.file || '')), { force: true }) } catch {}
    const data = load()
    data.items = data.items.filter((x) => x.id !== item.id)
    save(data)
  }

  /** 主人点头：写进图库，名字/标签/备注都沿用鱼提交的那份。 */
  function approve(id) {
    const data = load()
    const item = data.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '没有这条' }
    const file = join(dir(), String(item.file || ''))
    if (!existsSync(file)) { drop(item); return { ok: false, error: '图片已经不在了，这条已经撤掉' } }
    const saved = stickers.adopt({
      filePath: file,
      name: item.name,
      tags: item.tags || [],
      note: item.note || '',
      source: item.source || '鱼想收藏',
    })
    drop(item)
    return { ok: true, id: saved.id, name: saved.name }
  }

  function reject(id) {
    const data = load()
    const item = data.items.find((x) => x.id === id)
    if (!item) return { ok: false, error: '没有这条' }
    drop(item)
    return { ok: true }
  }

  /** 鱼提交候选：图已经落在目录里，这里只写清单条目。 */
  function propose(input = {}) {
    const data = load()
    const id = String(input.id || 'sw-' + Date.now().toString(36))
    const item = {
      id,
      file: String(input.file || ''),
      name: String(input.name || '').slice(0, 80),
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 12) : [],
      note: String(input.note || '').slice(0, 200),
      reason: String(input.reason || '').slice(0, 200),
      at: Date.now(),
    }
    data.items = [item, ...data.items.filter((x) => x.id !== id)]
    save(data)
    return item
  }

  function imageBytes(id) {
    const data = load()
    const item = data.items.find((x) => x.id === id)
    if (!item) return null
    const file = join(dir(), String(item.file || ''))
    if (!existsSync(file)) return null
    return { bytes: readFileSync(file), file: String(item.file || '') }
  }

  return { dir, list, approve, reject, propose, imageBytes }
}
