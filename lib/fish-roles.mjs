// 鱼世界自己的角色数据：名字 + 图片 + 置顶顺序。
//
// 为什么要这一层（不是补丁，是设计上的必要）：
//   以前「鱼长什么样、叫什么」全靠 dsh-whale-widget 的 roles.json。那意味着：
//   · 挂件没装 / 挂了 / 格式变了，鱼就没了脸和名字（日记署名、提示词、头像全空）；
//   · 我们还得去读别人插件的落盘格式，它一升级我们就可能读错；
//   · 更糟的是为了「合并成一个挂件」去改写它注入的脚本行 —— 那是跨插件改动，
//     出问题会直接伤到挂件运行。
//   所以角色信息改成鱼世界自己的**一等数据**：落盘在 fish-world-roles/ 下，
//   与 whale 完全无关。挂件在不在，鱼都还是同一张脸、同一个名字。
//
// 落盘（$DSH_HOME/fish-world-roles/）：
//   roles.json          { version: 1, current: '<id>', roles: [{ id, name, pinnedAt, createdAt }] }
//   <id>.png|gif|webp   角色图（缺图时面板显示空态，不伪造）
//
// 与 persona（人设卡）分工：
//   这里只管「名字 + 图 + 置顶」，人设文本仍在 fish-world-personas/<id>.md。
//   换角色 = 换 id，两边一起切。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/
const IMAGE_EXT = ['png', 'gif', 'webp', 'jpg', 'jpeg']
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ROLES = 50

export const DEFAULT_ROLE = Object.freeze({ id: 'default', name: '鱼', pinnedAt: 0, createdAt: 0 })

function safeId(value) {
  const id = String(value || '').trim()
  return SAFE_ID.test(id) ? id : ''
}

/** 按文件头认格式，不信扩展名（主人可能把 png 存成 .jpg）。 */
function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  return ''
}

export function createFishRoles({ home = DSH_HOME, logger } = {}) {
  const dir = home === DSH_HOME ? join(DSH_HOME, 'fish-world-roles') : join(home, 'fish-world-roles')
  const indexFile = () => join(dir, 'roles.json')

  function ensureDir() {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 读索引；坏文件当空处理并如实记一条，不静默吞掉。 */
  function readIndex() {
    try {
      const text = readFileSync(indexFile(), 'utf8')
      const parsed = JSON.parse(text)
      const roles = Array.isArray(parsed?.roles)
        ? parsed.roles
          .filter((r) => r && typeof r === 'object' && safeId(r.id))
          .map((r) => ({
            id: String(r.id),
            name: String(r.name || r.id).slice(0, 48),
            pinnedAt: Number(r.pinnedAt) || 0,
            createdAt: Number(r.createdAt) || 0,
          }))
          .slice(0, MAX_ROLES)
        : []
      return { version: 1, current: String(parsed?.current || ''), roles }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try { logger?.warn?.(`fish-world: 角色索引读不出来（${error?.message || error}），按空处理`) } catch {}
      }
      return { version: 1, current: '', roles: [] }
    }
  }

  function saveIndex(index) {
    ensureDir()
    writeFileSync(indexFile(), JSON.stringify({
      version: 1,
      current: index.current || '',
      roles: (index.roles || []).slice(0, MAX_ROLES),
    }, null, 2), 'utf8')
  }

  /** 内置的默认角色：没有图片，但名字与 id 稳定，别的地方不用判断「有没有 whale」。 */
  function withDefault(index) {
    const roles = index.roles.slice()
    if (!roles.some((r) => r.id === 'default')) roles.unshift({ ...DEFAULT_ROLE })
    return { ...index, roles }
  }

  function list() {
    const index = withDefault(readIndex())
    return index.roles.slice().sort((a, b) => {
      // 置顶优先，其次新的在前 —— 和主人心里的「我常用哪个」一致。
      if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt
      if (a.pinnedAt) return -1
      if (b.pinnedAt) return 1
      return (b.createdAt || 0) - (a.createdAt || 0)
    })
  }

  function imageFor(id) {
    const key = safeId(id) || 'default'
    const base = join(ensureDir(), key)
    for (const ext of IMAGE_EXT) {
      const file = `${base}.${ext}`
      if (existsSync(file)) return { path: file, ext }
    }
    return { path: '', ext: '' }
  }

  /** 当前角色（含 displayName / imageUrl），给头像卡、日记署名、提示词共用。 */
  function current() {
    const index = withDefault(readIndex())
    const wanted = String(index.current || '')
    const found = (wanted && index.roles.find((r) => r.id === wanted))
      || list()[0]
      || { ...DEFAULT_ROLE }
    return decorate(found)
  }

  function decorate(role) {
    const id = safeId(role?.id) || 'default'
    const image = imageFor(id)
    return {
      id,
      name: String(role?.name || DEFAULT_ROLE.name),
      pinned: Number(role?.pinnedAt) > 0,
      createdAt: Number(role?.createdAt) || null,
      hasImage: Boolean(image.path),
      // 走鱼世界自己的路由，不依赖挂件的 /dsh-whale/* 端点。
      avatar: image.path ? `/dsh-fish-world/role-image?id=${encodeURIComponent(id)}` : '',
    }
  }

  function setCurrent(id) {
    const key = safeId(id)
    if (!key) throw new Error('角色 id 无效')
    const index = withDefault(readIndex())
    if (!index.roles.some((r) => r.id === key)) throw new Error(`没有这个角色：${key}`)
    saveIndex({ ...index, current: key })
    return current()
  }

  function pin(id, pinned = true) {
    const key = safeId(id)
    if (!key) throw new Error('角色 id 无效')
    const index = withDefault(readIndex())
    const role = index.roles.find((r) => r.id === key)
    if (!role) throw new Error(`没有这个角色：${key}`)
    role.pinnedAt = pinned ? Date.now() : 0
    saveIndex(index)
    return decorate(role)
  }

  /**
   * 保存角色图。格式按文件头判定，不信扩展名；同一角色换格式时清掉旧文件，
   * 避免磁盘上并存两份、下次随机读到旧的那张。
   */
  function saveImage(id, sourcePath) {
    const key = safeId(id)
    if (!key) throw new Error('角色 id 无效')
    const bytes = readFileSync(sourcePath)
    if (bytes.length > MAX_BYTES) throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1048576)}MB`)
    const format = sniffImage(bytes)
    if (!format) throw new Error('只能是 PNG / JPEG / GIF / WebP')
    const target = join(ensureDir(), `${key}.${format}`)
    for (const ext of IMAGE_EXT) {
      const old = join(dir, `${key}.${ext}`)
      if (ext !== format && existsSync(old)) {
        try { unlinkSync(old) } catch {}
      }
    }
    copyFileSync(sourcePath, target)
    return { ok: true, id: key, format, bytes: bytes.length }
  }

  function removeImage(id) {
    const key = safeId(id)
    if (!key) throw new Error('角色 id 无效')
    const image = imageFor(key)
    if (image.path) {
      try { unlinkSync(image.path) } catch (error) { return { ok: false, error: String(error?.message || error) } }
    }
    return { ok: true }
  }

  /**
   * 面板上传角色图：收 dataUrl（与头像上传同一种写法）。
   * 先落到临时文件再交给 saveImage，格式判定、清旧文件那些逻辑只留一份。
   */
  function saveImageData(id, { dataUrl = '', base64 = '' } = {}) {
    const key = safeId(id)
    if (!key) throw new Error('角色 id 无效')
    if (!list().some((role) => role.id === key)) throw new Error(`没有这个角色：${key}`)
    const raw = String(dataUrl || '').trim() || (base64 ? 'data:image/png;base64,' + String(base64) : '')
    const match = raw.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/)
    if (!match) throw new Error('图片格式不对（需要 data:image/...;base64,）')
    const bytes = Buffer.from(match[2], 'base64')
    if (!bytes.length) throw new Error('图片是空的')
    if (bytes.length > MAX_BYTES) throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1048576)}MB`)
    const format = sniffImage(bytes)
    if (!format) throw new Error('只能是 PNG / JPEG / GIF / WebP')
    const tmp = join(ensureDir(), `.upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    writeFileSync(tmp, bytes)
    try {
      return saveImage(key, tmp)
    } finally {
      try { unlinkSync(tmp) } catch {}
    }
  }

  /** 新建角色（只有名字；图片随后上传）。 */
  function create(name) {
    const clean = String(name || '').trim().slice(0, 48)
    if (!clean) throw new Error('角色名不能为空')
    const index = withDefault(readIndex())
    if (index.roles.length >= MAX_ROLES) throw new Error(`最多 ${MAX_ROLES} 个角色`)
    // id 从名字派生，保证可读；重名时加后缀。
    let base = clean.replace(/[^a-zA-Z0-9_-]/g, '') || 'role'
    let id = base
    let n = 2
    while (index.roles.some((r) => r.id === id)) {
      id = `${base}-${n}`
      n += 1
    }
    index.roles.push({ id, name: clean, pinnedAt: 0, createdAt: Date.now() })
    saveIndex(index)
    return decorate(index.roles[index.roles.length - 1])
  }

  function remove(id) {
    const key = safeId(id)
    if (!key) throw new Error('角色 id 无效')
    if (key === 'default') throw new Error('默认角色不能删')
    const index = withDefault(readIndex())
    const next = index.roles.filter((r) => r.id !== key)
    if (next.length === index.roles.length) throw new Error(`没有这个角色：${key}`)
    removeImage(key)
    saveIndex({ ...index, roles: next, current: index.current === key ? 'default' : index.current })
    return { ok: true }
  }

  /** 给面板用的一份快照。 */
  function summary() {
    const index = withDefault(readIndex())
    return {
      dir,
      current: current(),
      roles: list().map(decorate),
      count: index.roles.length,
    }
  }

  return {
    dir: () => dir,
    list,
    current,
    summary,
    setCurrent,
    pin,
    create,
    remove,
    saveImage,
    saveImageData,
    removeImage,
    imageFor,
  }
}
