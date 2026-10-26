// 鱼之宝库：图片收藏（表情）+ 网站收藏（资源站点）。
//
// 两类共用同一个"收藏"心智，但落盘与校验规则不同：
//  - 图片收藏已有独立实现（lib/stickers.mjs），这里只做统一入口；
//  - 网站收藏是本文件：只存 URL + 标题 + 标签 + 来源，不抓正文、不镜像内容。
//
// 落盘：<工作区>/鱼之宝库/网站链接/（由 lib/storage.mjs 决定）
//   · links.json      —— 唯一事实来源（编号、分类、标签、时间）
//   · 网站清单.md      —— 给人看的清单，每次保存后重写
//
// 默认来源是 StyleKit（网页设计风格库）。鱼自己判断一条链接属于什么类型、
// 打什么标签——程序只做格式校验与额度控制，不替它决定分类。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

const LINKS_DIR_NAME = 'fish-world-links'
const INDEX_NAME = 'links.json'
const MANIFEST_NAME = '网站清单.md'
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

/** 分类的中文名与编号前缀：面板上「A-01」这样编号，方便鱼和主人互相指。 */
export const LINK_KIND_META = Object.freeze({
  design: { label: '设计', code: 'A' },
  reference: { label: '参考', code: 'B' },
  tool: { label: '工具', code: 'C' },
  article: { label: '文章', code: 'D' },
  inspiration: { label: '灵感', code: 'E' },
  other: { label: '其它', code: 'Z' },
})

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

export function createLinkLibrary({ home = DSH_HOME, config, logger, storage } = {}) {
  const legacyDir = home === DSH_HOME ? join(DSH_HOME, LINKS_DIR_NAME) : join(home, LINKS_DIR_NAME)

  function dirFor() {
    try {
      const sites = storage?.layout?.().sites
      if (sites) return sites
    } catch {}
    return legacyDir
  }

  function indexPath() {
    return join(dirFor(), INDEX_NAME)
  }

  function manifestPath() {
    return join(dirFor(), MANIFEST_NAME)
  }

  function ensureDir() {
    const dir = dirFor()
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function load() {
    try {
      const data = JSON.parse(readFileSync(indexPath(), 'utf8').replace(/^\uFEFF/, ''))
      return {
        version: 1,
        links: Array.isArray(data.links) ? data.links : [],
        hourly: data.hourly && typeof data.hourly === 'object' ? data.hourly : { key: '', count: 0 },
        nextNo: Number(data.nextNo) || 0,
      }
    } catch {
      return { version: 1, links: [], hourly: { key: '', count: 0 }, nextNo: 0 }
    }
  }

  function save(data) {
    ensureDir()
    const file = indexPath()
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
    writeManifest(data)
  }

  /**
   * 可读清单：分类分节、按编号排序，主人用记事本打开也能看懂。
   * 这不是事实来源，只是 links.json 的投影，随手删掉下次保存会重建。
   */
  function writeManifest(data) {
    const groups = new Map()
    for (const item of data.links) {
      const kind = Object.hasOwn(LINK_KIND_META, item.kind) ? item.kind : 'other'
      if (!groups.has(kind)) groups.set(kind, [])
      groups.get(kind).push(item)
    }
    const lines = [
      '# 鱼的网站收藏',
      '',
      `共 ${data.links.length} 条 · 由鱼世界自动生成，删掉也会重建。`,
      '',
    ]
    for (const kind of LINK_KINDS) {
      const items = (groups.get(kind) || []).slice().sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0))
      if (!items.length) continue
      lines.push(`## ${LINK_KIND_META[kind].label}`)
      lines.push('')
      for (const item of items) {
        const tags = (item.tags || []).length ? ' `' + item.tags.join('` `') + '`' : ''
        lines.push(`- **${item.no || '—'}** [${item.title || item.url}](${item.url})${tags}`)
        if (item.note) lines.push(`  ${item.note}`)
      }
      lines.push('')
    }
    try { writeFileSync(manifestPath(), lines.join('\n'), 'utf8') } catch {}
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

  /** 每个分类各自从 1 开始编号：设计 A-01、工具 C-01…… 分类变了就换到新分类的队尾。 */
  function nextSeq(data, kind) {
    let max = 0
    for (const item of data.links) {
      if (item.kind !== kind) continue
      max = Math.max(max, Number(item.seq) || 0)
    }
    return max + 1
  }

  function codeOf(kind) {
    return (Object.hasOwn(LINK_KIND_META, kind) ? LINK_KIND_META[kind] : LINK_KIND_META.other).code
  }

  function noOf(kind, seq) {
    return codeOf(kind) + '-' + String(Number(seq) || 0).padStart(2, '0')
  }

  /** 老数据没有编号时补一个，保证清单里每条都能被叫得出来。 */
  function withNumbers(data) {
    let changed = false
    const counters = {}
    for (const item of data.links.slice().reverse()) {
      const kind = Object.hasOwn(LINK_KIND_META, item.kind) ? item.kind : 'other'
      if (!Number(item.seq)) {
        counters[kind] = (counters[kind] || 0) + 1
        item.seq = counters[kind]
        changed = true
      } else {
        counters[kind] = Math.max(counters[kind] || 0, Number(item.seq))
      }
      const no = noOf(kind, item.seq)
      if (item.no !== no) {
        item.no = no
        changed = true
      }
    }
    return changed
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
        || String(item.no || '').toLowerCase().includes(q)
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

    const seq = nextSeq(data, cleanKind)
    const item = {
      id: 'lnk_' + randomUUID().slice(0, 8),
      no: noOf(cleanKind, seq),
      seq,
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
    if (kind != null && LINK_KINDS.includes(kind) && kind !== item.kind) {
      // 换分类就换编号：同一条网站在新分类里排到队尾，旧编号不留给别人。
      item.kind = kind
      item.seq = nextSeq(data, kind)
      item.no = noOf(kind, item.seq)
    }
    if (Array.isArray(tags)) {
      item.tags = [...new Set(tags.map((tag) => safeText(tag, TAG_MAX)).filter(Boolean))]
        .slice(0, MAX_TAGS)
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
      dir: dirFor(),
      indexFile: indexPath(),
      manifestFile: manifestPath(),
      total: data.links.length,
      limit: limit(),
      remainingThisHour: remainingThisHour(data),
      byKind,
      kinds: LINK_KINDS.map((id) => ({ id, ...LINK_KIND_META[id], count: byKind[id] || 0 })),
      tags: [...new Set(data.links.flatMap((item) => item.tags))].sort().slice(0, 60),
      sources: DEFAULT_SOURCES,
    }
  }

  return {
    dir: () => dirFor(),
    indexFile: () => indexPath(),
    manifestFile: () => manifestPath(),
    /** 读时补齐编号并写回，老数据也能在面板上显示 A-01。 */
    list: (options) => {
      const data = load()
      if (withNumbers(data)) save(data)
      return list(options)
    },
    rawList: list,
    add,
    remove,
    update,
    summary,
    limit,
    remainingThisHour,
  }
}
