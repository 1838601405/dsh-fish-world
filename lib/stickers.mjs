// 鱼之宝库图库：鱼世界自己的表情库。
//
// 落盘：<工作区>/鱼之宝库/图库/（由 lib/storage.mjs 决定，见那里）。
//   · stickers.json —— 索引（标签、来源、时间、使用计数）
//   · <id>.<png|gif|webp|jpg> —— 图片文件
//
// 没有接入存储层时（旧接线 / 测试）退回 $DSH_HOME/fish-world/stickers/，
// 只在这里维护一份清单，不依赖任何第三方插件的图库。
//
// 额度：每小时最多收藏 hourlyLimit 张（默认 5），只有主人能改上限。
// 打标签由模型在收藏时给出，主人随后可在管理面板里编辑修正。
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'
import { fileExists, readJson, writeJson } from './util.mjs'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const TAG_MAX = 12
const TAG_LENGTH_MAX = 24
const NAME_LENGTH_MAX = 80
const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 15000
const addQueues = new Map()

export const DEFAULT_STICKER_LIMIT = 5

function hourKey(at = Date.now()) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`
}

function sanitizeTag(tag) {
  return String(tag == null ? '' : tag).trim().replace(/\s+/g, ' ').slice(0, TAG_LENGTH_MAX)
}

function detectFormat(bytes, hint) {
  if (bytes && bytes.length >= 6) {
    const head = bytes.subarray(0, 6)
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'gif'
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png'
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) return 'webp'
  }
  const h = String(hint || '').toLowerCase()
  if (h === 'gif' || h.endsWith('.gif')) return 'gif'
  if (h === 'jpg' || h === 'jpeg' || h.endsWith('.jpg') || h.endsWith('.jpeg')) return 'jpg'
  if (h === 'webp' || h.endsWith('.webp')) return 'webp'
  return ''
}

function ipv4Number(address) {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return parts.reduce((value, part) => (value * 256) + part, 0)
}

function inIPv4Range(address, base, bits) {
  const value = ipv4Number(address)
  const start = ipv4Number(base)
  if (value == null || start == null) return true
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (start & mask)
}

function ipv6Number(address) {
  let input = String(address).toLowerCase().split('%')[0]
  const ipv4Tail = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (ipv4Tail) {
    const value = ipv4Number(ipv4Tail[1])
    if (value == null) return null
    input = input.slice(0, -ipv4Tail[1].length) + `${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const halves = input.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n)
}

function isPublicAddress(address) {
  const family = isIP(String(address).split('%')[0])
  if (family === 4) {
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ]
    return !blocked.some(([base, bits]) => inIPv4Range(address, base, bits))
  }
  if (family !== 6) return false
  const value = ipv6Number(address)
  if (value == null) return false
  const top = (bits) => value >> BigInt(128 - bits)
  // Only globally-routable 2000::/3 addresses are accepted. Exclude special
  // transition/documentation ranges and IPv4-mapped addresses explicitly.
  if (top(3) !== 1n) return false
  if (top(32) === 0x20010db8n || top(32) === 0x20010000n || top(16) === 0x2002n) return false
  return true
}

async function resolvePublicAddress(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '')
  const family = isIP(host)
  const addresses = family
    ? [{ address: host, family }]
    : await dnsLookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new Error('为保护本机网络，拒绝访问非公网地址')
  }
  return addresses[0]
}

function validateRemoteUrl(value, previous) {
  const url = value instanceof URL ? value : new URL(String(value))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 HTTP(S) 图片地址')
  if (url.username || url.password) throw new Error('图片地址不能包含用户名或密码')
  if ((url.protocol === 'http:' && url.port && url.port !== '80') || (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new Error('只允许 HTTP 80 或 HTTPS 443 端口')
  }
  if (previous?.protocol === 'https:' && url.protocol !== 'https:') throw new Error('不允许 HTTPS 重定向降级到 HTTP')
  return url
}

function downloadOnce(url, pinnedAddress) {
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const request = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname || '/'}${url.search}`,
      method: 'GET',
      headers: { accept: 'image/*', 'user-agent': 'dsh-fish-world/0.1' },
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [pinnedAddress])
        else callback(null, pinnedAddress.address, pinnedAddress.family)
      },
      ...(url.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {}),
    }, (response) => {
      const status = Number(response.statusCode || 0)
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location
        response.resume()
        response.once('end', () => finish(null, { redirect: location || '' }))
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        finish(new Error(`下载失败：HTTP ${status}`))
        return
      }
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        response.resume()
        finish(new Error(`表情图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB`))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_IMAGE_BYTES) {
          response.destroy(new Error(`表情图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB`))
          return
        }
        chunks.push(chunk)
      })
      response.once('error', (error) => finish(error))
      response.once('end', () => finish(null, {
        bytes: Buffer.concat(chunks, size),
        hint: String(response.headers['content-type'] || ''),
      }))
    })
    request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy(new Error('图片下载超时')))
    request.once('error', (error) => finish(error))
    request.end()
  })
}

async function downloadPublicImage(sourceUrl) {
  let current = validateRemoteUrl(sourceUrl)
  const visited = new Set()
  for (let redirects = 0; ; redirects++) {
    const key = current.href
    if (visited.has(key)) throw new Error('图片下载重定向循环')
    visited.add(key)
    const address = await resolvePublicAddress(current.hostname)
    const result = await downloadOnce(current, address)
    if (!Object.hasOwn(result, 'redirect')) return result
    if (redirects >= MAX_REDIRECTS) throw new Error('图片下载重定向次数过多')
    if (!result.redirect) throw new Error('图片服务器返回了无效重定向')
    current = validateRemoteUrl(new URL(result.redirect, current), current)
  }
}

function base64Bytes(dataUrlOrBase64) {
  const text = String(dataUrlOrBase64 || '')
  const comma = text.indexOf(',')
  const b64 = text.startsWith('data:') && comma >= 0 ? text.slice(comma + 1) : text.replace(/^base64:\/\//, '')
  return Buffer.from(b64, 'base64')
}

export function createStickers({ home = DSH_HOME, config, logger, sandbox, storage } = {}) {
  // 目录由存储层决定：工作区里的「鱼之宝库/图库」，没绑定工作区时落到默认根目录。
  // 传入 storage 之前的老调用（测试、旧接线）仍然退回 $DSH_HOME/fish-world/stickers。
  const legacyDirPath = join(home, 'fish-world', 'stickers')
  // 更早的版本把收藏放在 whale-stickers 下，迁移时要从那里读。
  const ancientDirPath = join(home, 'whale-stickers')
  const dirFor = () => {
    try {
      const gallery = storage?.layout?.().gallery
      if (gallery) return gallery
    } catch {}
    return legacyDirPath
  }
  let cachedDir = ''
  function ensureDir() {
    const next = dirFor()
    if (next !== cachedDir) {
      mkdirSync(next, { recursive: true })
      cachedDir = next
    }
    return next
  }
  let legacyChecked = false

  function migrateLegacyIndex() {
    if (legacyChecked) return
    legacyChecked = true
    const dir = ensureDir()
    const indexFile = join(dir, 'stickers.json')
    if (fileExists(indexFile)) return
    // 迁移源按新→旧依次尝试：先 fish-world/stickers，再 whale-stickers。
    const source = [legacyDirPath, ancientDirPath]
      .map((base) => ({ base, index: join(base, 'stickers.json') }))
      .find((entry) => fileExists(entry.index))
    if (!source) return
    const legacy = readJson(source.index, null)
    if (!legacy || !Array.isArray(legacy.stickers)) return
    const stickers = legacy.stickers.filter((item) => (
      item && /^stk_[a-z0-9_-]+$/i.test(String(item.id || ''))
      && ['png', 'jpg', 'gif', 'webp'].includes(String(item.format || ''))
    ))
    for (const item of stickers) {
      const from = join(source.base, `${item.id}.${item.format}`)
      const to = join(dir, `${item.id}.${item.format}`)
      if (fileExists(from) && !fileExists(to)) {
        try { copyFileSync(from, to) } catch {}
      }
    }
    writeJson(indexFile, {
      version: 1,
      stickers: stickers.filter((item) => fileExists(join(dir, `${item.id}.${item.format}`))),
      hourly: legacy.hourly && typeof legacy.hourly === 'object' ? legacy.hourly : { key: '', count: 0 },
    })
  }

  function limit() {
    const n = Number(config()?.stickers?.hourlyLimit)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STICKER_LIMIT
  }

  function indexPath() {
    return join(ensureDir(), 'stickers.json')
  }

  function loadIndex() {
    migrateLegacyIndex()
    const raw = readJson(indexPath(), null)
    if (!raw || typeof raw !== 'object') return { version: 1, stickers: [], hourly: { key: '', count: 0 } }
    return {
      version: 1,
      stickers: Array.isArray(raw.stickers) ? raw.stickers.filter((s) => (
        s && /^stk_[a-z0-9_-]+$/i.test(String(s.id || ''))
        && ['png', 'jpg', 'gif', 'webp'].includes(String(s.format || ''))
      )) : [],
      hourly: raw.hourly && typeof raw.hourly === 'object' ? raw.hourly : { key: '', count: 0 },
    }
  }

  /** 人类可看的索引：清单每次变动自动重建，不靠手写维护。
      gif / webp 标成「动图」，一眼知道发出去会不会动。 */
  function writeGalleryIndex(stickers) {
    try {
      const lines = [
        '# 图库索引',
        '',
        '共 ' + stickers.length + ' 张 · 由 stickers.json 自动生成，别手改。',
        '一张图可以挂多个方向（如摸头 / 被摸头 / 听话 / 乖），都写在标签里，名字只留主词。',
        '',
        '| # | 名字 | 类型 | 画面 | 用在 | id |',
        '|---|---|---|---|---|---|',
      ]
      stickers.forEach((item, i) => {
        const note = String(item.note || '')
        const pic = note.split('；用在：')[0].replace('画面：', '')
        const when = note.includes('；用在：') ? note.split('；用在：')[1] : ''
        const kind = ['gif', 'webp'].includes(String(item.format)) ? '动图' : '静图'
        lines.push('| ' + (i + 1) + ' | ' + item.name + ' | ' + kind + ' | ' + pic + ' | ' + when + ' | ' + item.id + ' |')
      })
      writeFileSync(join(ensureDir(), '图库索引.md'), lines.join('\n') + '\n', 'utf8')
    } catch {}
  }

  function saveIndex(index) {
    writeJson(indexPath(), index)
    writeGalleryIndex(index.stickers || [])
    return index
  }

  function remainingThisHour(index = loadIndex()) {
    const key = hourKey()
    const used = index.hourly && index.hourly.key === key ? Number(index.hourly.count) || 0 : 0
    return Math.max(0, limit() - used)
  }

  function fileFor(item) {
    return join(ensureDir(), `${item.id}.${item.format}`)
  }

  async function readSourceBytes(source) {
    const url = String(source.url || '').trim()
    if (/^https?:\/\//i.test(url)) {
      return downloadPublicImage(url)
    }
    const localPath = String(source.localPath || source.file || '').trim()
    if (localPath) {
      // 安全边界：本机路径只允许落在鱼箱内，防止借收藏表情读取工作区外的文件。
      if (!sandbox) throw new Error('鱼箱未初始化，拒绝读取本机文件')
      const safe = sandbox.resolveInside(localPath, { mustExist: true })
      return { bytes: readFileSync(safe), hint: safe }
    }
    const b64 = base64Bytes(source.base64 || source.dataUrl || '')
    if (b64 && b64.length) return { bytes: b64, hint: source.hint || '' }
    throw new Error('表情来源需要 url / localPath / base64 / dataUrl 之一')
  }

  async function addUnsafe(source, { tags = [], name = '', note = '' } = {}) {
    const enabled = config()?.stickers?.enabled !== false
    if (!enabled) throw new Error('表情收藏功能已停用')
    const index = loadIndex()
    if (remainingThisHour(index) <= 0) throw new Error(`本小时收藏额度已用完（每小时 ${limit()} 张）`)

    const { bytes, hint } = await readSourceBytes(source)
    if (!bytes || bytes.length === 0) throw new Error('表情图片为空')
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`表情图片超过 ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB`)

    const format = detectFormat(bytes, hint || source.localPath || source.file || '')
    if (!format) throw new Error('不支持的图片格式（仅 PNG、JPEG、GIF、WebP）')
    const id = 'stk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    const cleanTags = [...new Set((Array.isArray(tags) ? tags : []).map(sanitizeTag).filter(Boolean))].slice(0, TAG_MAX)
    const cleanName = String(name || '').trim().slice(0, NAME_LENGTH_MAX)

    mkdirSync(ensureDir(), { recursive: true })
    writeFileSync(join(ensureDir(), `${id}.${format}`), bytes)

    const item = {
      id,
      name: cleanName || id,
      format,
      tags: cleanTags,
      source: String(source.url || source.localPath || source.file || ''),
      note: String(note || '').slice(0, 200),
      addedAt: Date.now(),
      lastUsedAt: null,
      useCount: 0,
      bytes: bytes.length,
    }
    index.stickers.unshift(item)
    const key = hourKey()
    index.hourly = { key, count: (index.hourly && index.hourly.key === key ? Number(index.hourly.count) || 0 : 0) + 1 }
    saveIndex(index)
    try { logger?.info?.(`[stickers] 收藏 ${id}（标签：${cleanTags.join('、') || '无'}）`) } catch {}
    return item
  }

  function add(source, options = {}) {
    const key = indexPath()
    const previous = addQueues.get(key) || Promise.resolve()
    const current = previous.then(() => addUnsafe(source, options))
    const tail = current.then(() => undefined, () => undefined)
    addQueues.set(key, tail)
    return current.finally(() => {
      if (addQueues.get(key) === tail) addQueues.delete(key)
    })
  }

  function list() {
    return loadIndex().stickers.slice()
  }

  function get(idOrName) {
    const key = String(idOrName || '').trim()
    if (!key) return null
    const listAll = list()
    return listAll.find((item) => item.id === key || item.name === key) || null
  }

  function byTag(tag) {
    const key = sanitizeTag(tag).toLowerCase()
    if (!key) return []
    return list().filter((item) => item.tags.some((t) => t.toLowerCase() === key))
  }

  function search(query) {
    const key = String(query || '').trim().toLowerCase()
    if (!key) return list()
    return list().filter((item) => (
      item.id.toLowerCase().includes(key)
      || item.name.toLowerCase().includes(key)
      || item.tags.some((t) => t.toLowerCase().includes(key))
    ))
  }

  function toView(item) {
    return {
      ...item,
      path: item ? fileFor(item) : '',
      url: `/dsh-fish-world/sticker-image?id=${encodeURIComponent(String(item.id))}`,
    }
  }

  function updateTags(id, tags) {
    const index = loadIndex()
    const item = index.stickers.find((s) => s.id === id)
    if (!item) throw new Error(`没有找到表情：${id}`)
    item.tags = [...new Set((Array.isArray(tags) ? tags : []).map(sanitizeTag).filter(Boolean))].slice(0, TAG_MAX)
    saveIndex(index)
    return item
  }

  function updateName(id, name) {
    const index = loadIndex()
    const item = index.stickers.find((s) => s.id === id)
    if (!item) throw new Error(`没有找到表情：${id}`)
    item.name = String(name || '').trim().slice(0, NAME_LENGTH_MAX) || item.id
    saveIndex(index)
    return item
  }

  function markUsed(id) {
    const index = loadIndex()
    const item = index.stickers.find((s) => s.id === id)
    if (!item) return null
    item.useCount = Number(item.useCount) + 1
    item.lastUsedAt = Date.now()
    saveIndex(index)
    return item
  }

  function remove(id) {
    const index = loadIndex()
    const item = index.stickers.find((s) => s.id === id)
    if (!item) return false
    const file = fileFor(item)
    if (fileExists(file)) { try { rmSync(file, { force: true }) } catch {} }
    index.stickers = index.stickers.filter((s) => s.id !== id)
    saveIndex(index)
    return true
  }

  /** 主人批准后收进图库：不走每小时额度，格式与 id 规则和普通收藏一致。 */
  function adopt({ filePath, name = '', tags = [], note = '', source = '' }) {
    const bytes = readFileSync(filePath)
    const format = detectFormat(bytes, filePath)
    if (!format) throw new Error('不支持的图片格式（仅 PNG、JPEG、GIF、WebP）')
    const id = 'stk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    mkdirSync(ensureDir(), { recursive: true })
    writeFileSync(join(ensureDir(), `${id}.${format}`), bytes)
    const index = loadIndex()
    const item = {
      id,
      name: String(name || '').trim().slice(0, NAME_LENGTH_MAX) || id,
      format,
      tags: [...new Set((Array.isArray(tags) ? tags : []).map(sanitizeTag).filter(Boolean))].slice(0, TAG_MAX),
      source: String(source || ''),
      note: String(note || '').slice(0, 200),
      addedAt: Date.now(),
      lastUsedAt: null,
      useCount: 0,
      bytes: bytes.length,
    }
    index.stickers.unshift(item)
    saveIndex(index)
    return item
  }

  function setLimit(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error('额度必须是 0-1000 的整数')
    return Math.floor(n)
  }

  function imageBytes(id) {
    const item = get(id)
    if (!item) return null
    const file = fileFor(item)
    if (!fileExists(file)) return null
    return { bytes: readFileSync(file), format: item.format }
  }

  async function send(qq, chatKey, idOrName, options = {}) {
    const item = get(idOrName)
    if (!item) return { ok: false, reason: 'sticker-not-found' }
    const receipt = await qq.sendSticker(chatKey || '', { localPath: fileFor(item), url: '' }, options)
    if (receipt.ok) markUsed(item.id)
    return receipt
  }

  function summary() {
    const index = loadIndex()
    return {
      dir: ensureDir(),
      limit: limit(),
      remainingThisHour: remainingThisHour(index),
      total: index.stickers.length,
      tags: [...new Set(index.stickers.flatMap((item) => item.tags))].sort(),
    }
  }

  /**
   * 给界面用的目录信息：用户想知道"把我的图片放哪儿"，就要给出真实路径。
   * 只返回目录路径与支持格式，不接受任何输入参数。
   */
  function directoryInfo() {
    const index = loadIndex()
    const dir = ensureDir()
    const indexFile = join(dir, 'stickers.json')
    const formats = ['png', 'jpg', 'gif', 'webp']
    return {
      ok: true,
      dir,
      indexFile,
      formats,
      total: index.stickers.length,
      hint: `把 ${formats.join(' / ')} 图片放进这个目录，鱼就能在聊天里自己挑用；也可以在面板里逐个收藏并打标签。`,
      note: '这个目录就在鱼自己的工作区里。',
    }
  }

  return {
    adopt,
    dir: () => ensureDir(),
    indexFile: () => join(ensureDir(), 'stickers.json'),
    limit,
    remainingThisHour,
    add,
    list,
    get,
    byTag,
    search,
    toView,
    updateTags,
    updateName,
    markUsed,
    remove,
    setLimit,
    imageBytes,
    directoryInfo,
    summary,
    fileFor,
    send,
  }
}

export function sanitizeStickerTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).map(sanitizeTag).filter(Boolean))].slice(0, TAG_MAX)
}
