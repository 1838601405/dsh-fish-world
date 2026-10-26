// dsh-fish-world 扩展安装：用户自己搜索扩展，粘贴作者原始 https 链接。
// We do not host or mirror downloads: the panel installs from that link after the
// archive passes the same safe-unpack checks as before, and leaves it disabled.
import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { DEFAULT_PLUGIN_DIR, DEFAULT_SKILL_DIR } from './paths.mjs'

const MAX_ZIP_BYTES = 8 * 1024 * 1024
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024
const MAX_FILES = 100
const MAX_FILE_BYTES = 8 * 1024 * 1024
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const EXECUTABLE = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i
const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_END = 0x06054b50

// Search links only. No catalogue is fetched, so an unreachable search site
// can never leave the panel empty or block installation.
const SOURCE_LINKS = {
  plugin: [
    { label: 'GitHub 搜索 dsh 插件', url: 'https://github.com/search?q=dsh+plugin&type=repositories' },
    { label: 'GitHub 搜索 dsh-plugin 主题', url: 'https://github.com/topics/dsh-plugin' },
    { label: 'npm 搜索 dsh 插件', url: 'https://www.npmjs.com/search?q=dsh%20plugin' },
    { label: 'QQ Agent 社区', url: 'https://www.kondius.cn/' },
  ],
  skill: [
    { label: 'GitHub 搜索 QQ Agent 技能', url: 'https://github.com/search?q=qq+agent+skill&type=repositories' },
    { label: 'npm 搜索 qq agent skill', url: 'https://www.npmjs.com/search?q=qq%20agent%20skill' },
    { label: 'QQ Agent 社区', url: 'https://www.kondius.cn/' },
  ],
}

function marketError(message, status = 502) {
  const error = new Error(String(message || '市场请求失败'))
  error.status = status
  return error
}

function safeZipName(input) {
  const name = String(input || '').replaceAll('\\', '/')
  const parts = name.replace(/\/$/, '').split('/')
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || /[\x00-\x1f\x7f:]/.test(name)
    || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw marketError('安装包包含不安全路径')
  }
  return name
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readZipDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ZIP_BYTES) throw marketError('安装包大小无效')
  const min = Math.max(0, buffer.length - 0xffff - 22)
  let eocd = -1
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === ZIP_END) { eocd = i; break }
  }
  if (eocd < 0) throw marketError('安装包不是有效 ZIP')
  const disk = buffer.readUInt16LE(eocd + 4)
  const directoryDisk = buffer.readUInt16LE(eocd + 6)
  const diskEntries = buffer.readUInt16LE(eocd + 8)
  const count = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  const commentLength = buffer.readUInt16LE(eocd + 20)
  if (disk || directoryDisk || diskEntries !== count || count > MAX_FILES || count === 0xffff
    || directoryOffset === 0xffffffff || directorySize === 0xffffffff
    || eocd + 22 + commentLength > buffer.length || directoryOffset + directorySize > eocd) {
    throw marketError('不支持分卷或 ZIP64 安装包')
  }

  const files = []
  const seen = new Set()
  let offset = directoryOffset
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL) throw marketError('ZIP 中央目录损坏')
    const madeBy = buffer.readUInt16LE(offset + 4) >>> 8
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const diskStart = buffer.readUInt16LE(offset + 34)
    const external = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd + extraLength + commentLength > buffer.length) throw marketError('ZIP 文件名或扩展字段损坏')
    const name = safeZipName(buffer.toString('utf8', offset + 46, nameEnd))
    const unixType = (external >>> 16) & 0o170000
    if ((flags & 1) || diskStart !== 0 || ![0, 8].includes(method)) throw marketError(`ZIP 文件类型不支持：${name}`)
    if (madeBy === 3 && unixType === 0o120000) throw marketError(`安装包包含符号链接：${name}`)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw marketError('不支持 ZIP64 安装包')
    if (!name.endsWith('/') && EXECUTABLE.test(name)) throw marketError(`安装包包含可执行文件：${name}`)
    if (size > MAX_FILE_BYTES || compressedSize > MAX_ZIP_BYTES) throw marketError(`安装包文件过大：${name}`)
    if (!name.endsWith('/')) {
      if (seen.has(name)) throw marketError(`安装包包含重名文件：${name}`)
      seen.add(name)
      total += size
      if (total > MAX_UNPACKED_BYTES) throw marketError('安装包解压后超过 32MB 上限')
      files.push({ name, flags, method, crc, compressedSize, size, localOffset })
    }
    offset = nameEnd + extraLength + commentLength
  }
  if (offset > directoryOffset + directorySize) throw marketError('ZIP 中央目录长度不匹配')
  if (!files.length) throw marketError('安装包里没有文件')
  return files
}

function unpackFile(buffer, entry) {
  const at = entry.localOffset
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== ZIP_LOCAL) throw marketError(`ZIP 本地头损坏：${entry.name}`)
  const flags = buffer.readUInt16LE(at + 6)
  const method = buffer.readUInt16LE(at + 8)
  const localCompressedSize = buffer.readUInt32LE(at + 18)
  const localSize = buffer.readUInt32LE(at + 22)
  const nameLength = buffer.readUInt16LE(at + 26)
  const extraLength = buffer.readUInt16LE(at + 28)
  const nameAt = at + 30
  const localName = buffer.toString('utf8', nameAt, nameAt + nameLength).replaceAll('\\', '/')
  if (localName !== entry.name || method !== entry.method || Boolean(flags & 1) !== Boolean(entry.flags & 1)) throw marketError(`ZIP 本地头与目录不一致：${entry.name}`)
  if (!(flags & 8) && (localCompressedSize !== entry.compressedSize || localSize !== entry.size)) throw marketError(`ZIP 文件大小声明不一致：${entry.name}`)
  const dataAt = nameAt + nameLength + extraLength
  const end = dataAt + entry.compressedSize
  if (dataAt > buffer.length || end > buffer.length) throw marketError(`ZIP 数据越界：${entry.name}`)
  let data
  try {
    const compressed = buffer.subarray(dataAt, end)
    data = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: entry.size })
  } catch { throw marketError(`ZIP 解压失败：${entry.name}`) }
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw marketError(`ZIP 校验失败：${entry.name}`)
  return data
}

function commonRoot(files) {
  const paths = files.map((file) => file.name.split('/'))
  const prefix = []
  while (paths.every((parts) => parts.length > prefix.length + 1 && parts[prefix.length] === paths[0][prefix.length])) {
    prefix.push(paths[0][prefix.length])
  }
  return prefix.length ? prefix.join('/') + '/' : ''
}

function extractZip(buffer, destination) {
  const entries = readZipDirectory(buffer)
  const prefix = commonRoot(entries)
  for (const entry of entries) {
    const relativeName = prefix && entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name
    const cleanName = safeZipName(relativeName)
    const output = resolve(destination, ...cleanName.split('/'))
    const rel = relative(destination, output)
    if (rel === '..' || rel.startsWith('..' + sep) || resolve(output) === resolve(destination)) throw marketError('ZIP 路径越界')
    mkdirSync(join(output, '..'), { recursive: true })
    writeFileSync(output, unpackFile(buffer, entry), { flag: 'wx' })
  }
}

function readPackageManifest(directory, kind, expectedId) {
  const file = join(directory, kind === 'plugin' ? 'plugin.json' : 'skill.json')
  let manifest
  try { manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
  catch { throw marketError(`安装包缺少有效的 ${kind}.json`, 502) }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw marketError('扩展清单格式无效', 502)
  if (manifest.kind && manifest.kind !== kind) throw marketError('扩展清单类型与选择不一致', 409)
  if (!SAFE_ID.test(String(manifest.id || ''))) throw marketError('扩展清单缺少合法的 id', 409)
  if (expectedId !== undefined && String(manifest.id || '') !== expectedId) throw marketError('扩展清单 ID 与下载目标不一致', 409)
  if (manifest.apiVersion !== undefined && ![0, 1].includes(Number(manifest.apiVersion))) throw marketError('该扩展 API 版本暂不支持', 409)
  manifest.kind = kind
  if (!manifest.entry) manifest.entry = 'index.js'
  if (typeof manifest.entry !== 'string') throw marketError('扩展入口格式无效', 502)
  const entry = resolve(directory, manifest.entry)
  const rel = relative(directory, entry)
  let entryIsFile = false
  try { entryIsFile = statSync(entry).isFile() } catch {}
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || !entryIsFile) throw marketError('扩展入口无效或缺失', 502)
  return manifest
}

function ipIsPrivate(host) {
  const family = isIP(host)
  if (family === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (family === 6) {
    const value = host.toLowerCase()
    return value === '::1' || value === '::' || /^f[cd]/.test(value) || /^fe80/.test(value)
      || value.startsWith('::ffff:127.')
  }
  return false
}

function normalizeSource(raw) {
  const text = String(raw || '').trim()
  if (!text) throw marketError('请先粘贴扩展的下载链接', 400)
  if (text.length > 2048) throw marketError('链接过长', 400)
  let url
  try { url = new URL(text) } catch { throw marketError('请粘贴完整的 https 链接', 400) }
  if (url.protocol !== 'https:') throw marketError('只接受 https 下载链接', 400)
  if (url.username || url.password) throw marketError('链接不能包含账号信息', 400)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal') || ipIsPrivate(hostname)) {
    throw marketError('链接指向本机或内网地址，已拒绝', 403)
  }
  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length === 2) {
      // A repo home page cannot be downloaded directly; its archive can.
      return {
        url: `https://codeload.github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/zip/HEAD`,
        label: `${parts[0]}/${parts[1]}`,
        source: url.href,
      }
    }
    throw marketError('GitHub 链接请填仓库主页，例如 https://github.com/owner/repo', 400)
  }
  if (hostname === 'npmjs.com' || hostname === 'www.npmjs.com' || hostname === 'registry.npmjs.org') {
    throw marketError('npm 包请改用作者的 GitHub 仓库主页或 ZIP 下载链接', 400)
  }
  return { url: url.href, label: hostname, source: url.href }
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel() } catch {}
    throw marketError('下载超过大小限制', 502)
  }
  const chunks = []
  let size = 0
  if (response.body) {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw marketError('下载超过大小限制', 502)
      }
      chunks.push(Buffer.from(value))
    }
  }
  return Buffer.concat(chunks)
}

async function downloadArchive(source, { maxBytes = MAX_ZIP_BYTES, timeoutMs = 120000, fetchImpl = fetch, lookupImpl = dnsLookup } = {}) {
  let url = new URL(source.url)
  for (let redirect = 0; redirect <= 3; redirect++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (url.protocol !== 'https:' || hostname === 'localhost' || hostname.endsWith('.local') || ipIsPrivate(hostname)) {
      throw marketError('下载跳转到了不受信任的地址', 403)
    }
    if (isIP(hostname) === 0) {
      let addresses = []
      try { addresses = await lookupImpl(hostname, { all: true, verbatim: true }) } catch { throw marketError('下载地址解析失败', 502) }
      if (!Array.isArray(addresses) || !addresses.length) throw marketError('下载地址解析失败', 502)
      if (addresses.some((item) => ipIsPrivate(String(item?.address || '')))) throw marketError('下载地址解析到内网，已拒绝', 403)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/zip, application/octet-stream, */*' },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        try { await response.body?.cancel() } catch {}
        if (!location) throw marketError('下载重定向无效', 502)
        if (redirect === 3) throw marketError('下载重定向过多', 502)
        url = new URL(location, url)
        continue
      }
      if (!response.ok) {
        try { await response.body?.cancel() } catch {}
        throw marketError(`下载扩展失败（HTTP ${response.status}）`, 502)
      }
      return await readBoundedBody(response, maxBytes)
    } catch (error) {
      if (error?.status) throw error
      throw marketError(controller.signal.aborted ? '下载扩展超时' : `下载扩展失败：${error?.message || error}`, 502)
    } finally {
      clearTimeout(timer)
    }
  }
  throw marketError('下载重定向过多', 502)
}

export function createMarket({ configStore, loader, pluginDir = DEFAULT_PLUGIN_DIR, skillDir = DEFAULT_SKILL_DIR, fetchImpl = fetch, lookupImpl = dnsLookup }) {
  function links(kind) {
    if (!['skill', 'plugin'].includes(kind)) throw marketError('类型必须是 skill 或 plugin', 400)
    return {
      ok: true,
      kind,
      links: SOURCE_LINKS[kind],
      notice: '不托管下载：请自行搜索扩展，粘贴作者原始 https 链接。支持 GitHub 仓库主页或 ZIP 直链；安装后默认禁用。',
    }
  }

  async function install({ kind, url }) {
    if (!['skill', 'plugin'].includes(kind)) throw marketError('扩展类型无效', 400)
    const source = normalizeSource(url)
    const targetRoot = kind === 'plugin' ? pluginDir : skillDir
    const archive = await downloadArchive(source, { fetchImpl, lookupImpl })

    mkdirSync(targetRoot, { recursive: true })
    const stagingParent = mkdtempSync(join(targetRoot, '.market-stage-'))
    let extracted = ''
    let target = ''
    try {
      extracted = join(stagingParent, 'package')
      mkdirSync(extracted, { recursive: false })
      extractZip(archive, extracted)
      const manifest = readPackageManifest(extracted, kind)
      const id = String(manifest.id)
      target = join(targetRoot, id)
      if (existsSync(target)) throw marketError('本地已有同 ID 扩展，不覆盖现有文件', 409)
      // Never let a downloaded declaration auto-run native code.
      const cfg = configStore.getConfig()
      const requiredDir = resolve(targetRoot)
      if (!cfg.extensionDirs.some((dir) => resolve(dir) === requiredDir)) {
        configStore.saveConfig({ extensionDirs: [...cfg.extensionDirs, requiredDir] })
      }
      configStore.setEnabled(id, false)
      renameSync(extracted, target)
      const refreshed = loader.refreshInstalled()
      return {
        ok: true,
        id,
        kind,
        name: String(manifest.name || id),
        version: String(manifest.version || '0.0.0'),
        status: 'disabled',
        enabled: false,
        source: source.source,
        added: refreshed.added.includes(id),
      }
    } catch (error) {
      if (extracted && existsSync(extracted) && !(target && existsSync(target))) rmSync(extracted, { recursive: true, force: true })
      throw error
    } finally {
      try { rmSync(stagingParent, { recursive: true, force: true }) } catch {}
    }
  }

  return { links, install }
}

export const __test = { readZipDirectory, unpackFile, extractZip, safeZipName, normalizeSource, ipIsPrivate }
