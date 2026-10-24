// 鱼的收藏：图片收藏（表情）+ 网站收藏（资源站点）。
//
// 两类共用同一个"收藏"心智，但落盘与校验规则不同：
//  - 图片收藏已有独立实现（lib/stickers.mjs），这里只做统一入口；
//  - 网站收藏是本文件：只存 URL + 标题 + 标签 + 来源，不抓正文、不镜像内容。
//
// 默认来源是 StyleKit（网页设计风格库）。鱼自己判断一条链接属于什么类型、
// 打什么标签——程序只做格式校验与额度控制，不替它决定分类。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const LINKS_DIR_NAME = 'fish-world-links'
const INDEX_NAME = 'links.json'
const MAX_LINKS = 2000
const MAX_TITLE = 160
const MAX_NOTE = 500
const MAX_TAGS = 8
const TAG_MAX = 24
const HOURLY_DEFAULT = 10

/** 默认资源站点：鱼可以在这些站里自己找感兴趣的东西。 */
export const DEFAULT_SOURCES = Object.freeze([
  {
    id: 'stylekit',
    name: 'StyleKit 风格库',
    url: 'https://www.stylekit.top/zh/styles',
    description: '网页设计风格库，适合收集版式、配色与视觉语言',
    kind: 'design',
  },
])

// 网站类型由鱼判断，这里只列允许的取值，避免写进任意字符串。
export const LINK_KINDS = ['design', 'reference', 'tool', 'article', 'inspiration', 'other']

function safeText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, max)
}

/** 只接受 http(s) 公网链接；拒绝本机、内网与其它协议。 */
export function validateLinkUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return { ok: false, error: '网址不能为空' }
  if (text.length > 2048) return { ok: false, error: '网址过长' }
  let url
  try { url = new URL(text) } catch { return { ok: false, error: '网址格式不对' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: '只接受 http(s) 网址' }
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) {
    return { ok: false, error: '不接受本机地址' }
  }
  // 常见内网段
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return { ok: false, error: '不接受内网地址' }
  }
  if (host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: '不接受内网地址' }
  }
  return { ok: true, url: url.toString(), host }
}

function hourKey(at = Date.now()) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}`
}

export function createLinkLibrary({ home = DSH_HOME, config, logger } = {}) {
  const dir = home === DSH_HOME ? join(DSH_HOME, LINKS_DIR_NAME) : join(home, LINKS_DIR_NAME)
  const indexFile = join(dir, INDEX_NAME)

  function ensureDir() {
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function load() {
    try {
      const data = JSON.parse(readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, ''))
      return {
        version: 1,
        links: Array.isArray(data.links) ? data.links : [],
        hourly: data.hourly && typeof data.hourly === 'object' ? data.hourly : { key: '', count: 0 },
      }
    } catch {
      return { version: 1, links: [], hourly: { key: '', count: 0 } }
    }
  }

  function save(data) {
    ensureDir()
    const tmp = indexFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, indexFile)
  }

  function limit() {
    const value = Number(config?.()?.linkLibrary?.hourlyLimit)
    return Number.isFinite(value) && value >= 0 ? Math.min(1000, Math.round(value)) : HOURLY_DEFAULT
  }

  function remainingThisHour(data = load()) {
    const key = hourKey()
    const used = data.hourly?.key === key ? Number(data.hourly.count) || 0 : 0
    return Math.max(0, limit() - used)
  }

  function list({ query = '', kind = '', limit: max = 200 } = {}) {
    const data = load()
    const q = String(query || '').toLowerCase().trim()
    let items = data.links.slice()
    if (kind) items = items.filter((item) => item.kind === kind)
    if (q) {
      items = items.filter((item) =>
        item.title.toLowerCase().includes(q)
        || item.url.toLowerCase().includes(q)
        || (item.tags || []).some((tag) => tag.toLowerCase().includes(q))
        || (item.note || '').toLowerCase().includes(q))
    }
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return items.slice(0, Math.max(1, Math.min(Number(max) || 200, MAX_LINKS)))
  }

  function add({ url, title = '', note = '', tags = [], kind = 'other', source = '' } = {}) {
    const checked = validateLinkUrl(url)
    if (!checked.ok) throw new Error(checked.error)
    const data = load()

    if (remainingThisHour(data) <= 0) throw new Error(`本小时网站收藏额度已用完（每小时 ${limit()} 条）`)
    // 同一 URL 不重复收藏
    if (data.links.some((item) => item.url === checked.url)) throw new Error('这个网站已经收过了')

    const cleanKind = LINK_KINDS.includes(kind) ? kind : 'other'
    const cleanTags = [...new Set((Array.isArray(tags) ? tags : [])
      .map((tag) => safeText(tag, TAG_MAX))
      .filter(Boolean))].slice(0, MAX_TAGS)

    const item = {
      id: 'lnk_' + randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      url: checked.url,
      host: checked.host,
      title: safeText(title, MAX_TITLE) || checked.host,
      note: safeText(note, MAX_NOTE),
      tags: cleanTags,
      kind: cleanKind,
      source: safeText(source, 40),
    }

    const key = hourKey()
    const used = data.hourly?.key === key ? Number(data.hourly.count) || 0 : 0
    data.hourly = { key, count: used + 1 }
    data.links = [item, ...data.links].slice(0, MAX_LINKS)
    save(data)
    return { ok: true, item }
  }

  function remove(id) {
    const data = load()
    const before = data.links.length
    data.links = data.links.filter((item) => item.id !== String(id))
    if (data.links.length === before) return { ok: false, error: '没有找到这条收藏' }
    save(data)
    return { ok: true, removed: before - data.links.length }
  }

  function update(id, { title, tags, note, kind } = {}) {
    const data = load()
    const item = data.links.find((row) => row.id === String(id))
    if (!item) throw new Error('没有找到这条收藏')
    if (title != null) item.title = safeText(title, MAX_TITLE) || item.title
    if (note != null) item.note = safeText(note, MAX_NOTE)
    if (kind != null && LINK_KINDS.includes(kind)) item.kind = kind
    if (Array.isArray(tags)) {
      item.tags = [...new Set(tags.map((tag) => safeText(tag, TAG_MAX)).filter(Boolean))].slice(0, MAX_TAGS)
    }
    item.updatedAt = new Date().toISOString()
    save(data)
    return { ok: true, item }
  }

  function summary() {
    const data = load()
    const byKind = {}
    for (const item of data.links) byKind[item.kind] = (byKind[item.kind] || 0) + 1
    return {
      dir,
      indexFile,
      total: data.links.length,
      limit: limit(),
      remainingThisHour: remainingThisHour(data),
      byKind,
      tags: [...new Set(data.links.flatMap((item) => item.tags))].sort().slice(0, 60),
      sources: DEFAULT_SOURCES,
    }
  }

  return {
    dir: () => dir,
    list,
    add,
    remove,
    update,
    summary,
    limit,
    remainingThisHour,
  }
}
