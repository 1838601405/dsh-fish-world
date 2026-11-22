// 视觉管线的缓存层（2026-11-22，主人要求「一次算过到处可用」）。
//
// ── 为什么单独一层 ──
// 现在同一张图从四个入口来（QQ 收图 / 表情入库 / B站封面 / 空间配图），
// 每处都自己调一次视觉模型。一张图被算 3～4 次，花的钱和上下文额度都是重复的。
//
// 缓存键 = sha256 + focus + 模型版本。
//   · sha256：同一份文件内容 → 同一个键（跨平台共享，改名换目录都不影响）
//   · focus：同一张图问不同问题时答案不同，不能互相顶掉
//   · 模型版本：换了模型旧答案就不能用（不同模型认出来的东西不一样）
//
// 落盘：<世界根>/视觉缓存/<sha256前2位>/<sha256>-<focusHash>-<modelHash>.json
//   分两级目录是因为单目录放几万个文件时 NTFS 列目录会变慢。
//
// ── 为什么不用内存缓存 ──
// 插件会重启，进程一退内存就没了。而"这张图上周看过"正是最该命中的场景。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 缓存目录名（在世界根下面）。 */
export const CACHE_FOLDER = '视觉缓存'

/** 缓存格式版本。改了输出结构就 +1，旧缓存自动失效。 */
export const CACHE_VERSION = 1

/** 单个缓存文件超过这个大小就不写（防一条异常长的描述把磁盘撑满）。 */
const MAX_ENTRY_BYTES = 256 * 1024

/** 缓存目录超过这个条数就清最旧的（留 80%）。 */
const MAX_ENTRIES = 5000

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** 文件内容的 sha256（分块读，别把 40MB 视频整个读进内存）。 */
export function hashFile(path) {
  const buf = readFileSync(path)
  return sha256Hex(buf)
}

/** 一段字节的 sha256。 */
export function hashBytes(bytes) {
  return sha256Hex(bytes)
}

/** focus 归一：空/纯空白都算默认，避免 '' 和 ' ' 各存一份。 */
function normFocus(focus) {
  return String(focus == null ? '' : focus).trim().replace(/\s+/g, ' ')
}

/**
 * 算缓存键。三段各自的 hash 都取前 16 位 —— 足够避碰，路径也不会太长。
 */
export function cacheKey({ sha256, focus = '', model = '' }) {
  const id = String(sha256 || '').toLowerCase()
  if (!/^[0-9a-f]{16,64}$/.test(id)) throw new Error('缓存键需要 sha256（16 位以上十六进制）')
  const f = sha256Hex('focus:' + normFocus(focus)).slice(0, 16)
  const m = sha256Hex('model:' + String(model || '')).slice(0, 16)
  return `${id.slice(0, 16)}-${f}-${m}`
}

/**
 * 建一个缓存器。
 *
 * @param {object} opts
 * @param {string} opts.root 世界根（缓存落 <root>/视觉缓存/）
 * @param {() => number} [opts.now]
 * @param {object} [opts.logger]
 */
export function createVisionCache({ root, now = () => Date.now(), logger } = {}) {
  if (!root) throw new Error('视觉缓存需要世界根目录')

  const dir = join(root, CACHE_FOLDER)

  function ensureDir() {
    try { mkdirSync(dir, { recursive: true }) } catch {}
  }

  function entryPath(key) {
    return join(dir, key.slice(0, 2), key + '.json')
  }

  /**
   * 读缓存。
   *
   * ★ 命中要求三件事同时满足：
   *   ① 文件在
   *   ② version 一致（格式没变）
   *   ③ 没有超过 TTL（0 = 永不过期）
   * 任何一条不满足都算未命中 —— 宁可多算一次，也不要用错答案。
   *
   * @returns {object|null} 缓存内容，未命中返回 null
   */
  function get(key, { ttlMs = 0 } = {}) {
    const file = entryPath(key)
    if (!existsSync(file)) return null
    let raw
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
    if (!raw || raw.version !== CACHE_VERSION) return null
    if (ttlMs > 0 && Number(raw.at || 0) > 0) {
      const age = now() - Number(raw.at)
      if (age > ttlMs) return null
    }
    return raw.data ?? null
  }

  /**
   * 写缓存。
   *
   * ★ 写失败不能影响调用方 —— 缓存是优化，不是正确性的前提。
   *   磁盘满 / 权限不足时如实返回 false，但别抛。
   */
  function set(key, data) {
    try {
      const payload = JSON.stringify({ version: CACHE_VERSION, at: now(), data })
      if (Buffer.byteLength(payload, 'utf8') > MAX_ENTRY_BYTES) {
        try { logger?.warn?.('fish-world: 视觉缓存条目过大，不写（' + Buffer.byteLength(payload) + ' 字节）') } catch {}
        return false
      }
      const file = entryPath(key)
      mkdirSync(join(dir, key.slice(0, 2)), { recursive: true })
      writeFileSync(file, payload, 'utf8')
      return true
    } catch (error) {
      try { logger?.warn?.('fish-world: 视觉缓存写入失败 ' + String(error?.message || error)) } catch {}
      return false
    }
  }

  /** 删一条（标记不可用时用）。 */
  function drop(key) {
    try { unlinkSync(entryPath(key)); return true } catch { return false }
  }

  function count() {
    let n = 0
    try {
      for (const sub of readdirSync(dir)) {
        try { n += readdirSync(join(dir, sub)).length } catch {}
      }
    } catch { return 0 }
    return n
  }

  /**
   * 清最旧的，留 80%。
   *
   * ★ 为什么按 at 不按 mtime：缓存的"用得上"看的是算出来的时间，
   *   不是文件被碰过的时间。软链接/备份工具会改 mtime，那不是我们要的语义。
   */
  function prune({ keep = Math.floor(MAX_ENTRIES * 0.8) } = {}) {
    const all = []
    try {
      for (const sub of readdirSync(dir)) {
        let names = []
        try { names = readdirSync(join(dir, sub)) } catch { continue }
        for (const name of names) {
          if (!name.endsWith('.json')) continue
          const file = join(dir, sub, name)
          let at = 0
          try {
            const raw = JSON.parse(readFileSync(file, 'utf8'))
            at = Number(raw?.at || 0)
          } catch { at = 0 }
          if (!at) { try { at = statSync(file).mtimeMs } catch { at = 0 } }
          all.push({ file, at })
        }
      }
    } catch { return { removed: 0 } }

    if (all.length <= keep) return { removed: 0 }
    all.sort((a, b) => a.at - b.at)
    const drop_ = all.slice(0, all.length - keep)
    let removed = 0
    for (const x of drop_) {
      try { unlinkSync(x.file); removed += 1 } catch {}
    }
    return { removed }
  }

  return {
    dir: () => dir,
    entryPath,
    get,
    set,
    drop,
    count,
    prune,
    /** 只在超上限时清（调用方不用自己判）。 */
    maybePrune: () => (count() > MAX_ENTRIES ? prune() : { removed: 0 })
  }
}
