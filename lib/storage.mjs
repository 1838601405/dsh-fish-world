// 鱼的世界的存储位置：一个独立工作区，就是鱼自己的家。
//
// 目录约定（全部在同一个根目录下，名字带序号，方便在资源管理器里按顺序看）：
//
//   <根>/鱼的收藏/1 图库/        图片收藏（表情、图片，含 stickers.json）
//   <根>/鱼的收藏/2 网站链接/    网站收藏（links.json + 可读的网站清单.md）
//   <根>/鱼与世界/QQ|B站|抖音/   各平台的浏览与互动记录（按天追加的 jsonl）
//   <根>/鱼的日记、鱼的记忆、鱼的状态、鱼的关系、安全与审计、世界设置.json
//
// 根目录按这个顺序取：
//   1. 主人显式选过的 `storage.root`（面板里「选择目录」写入）；
//   2. 已绑定的 DSH 工作区（world.root()）；
//   3. 桌面上的「鱼的世界」，没有桌面就退回 DSH_HOME 下。
//
// 中文目录名在 Windows / macOS / Linux 上都没有问题（Node 用 UTF-8 处理路径），
// 所以这里直接用中文，只有 ID 之类的内部标识保持 ASCII。
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const ROOT_FOLDER = '鱼的世界'
/** 鱼之宝库（原「鱼的收藏」）。新目录用新名字；旧目录仍会被识别与继续使用。 */
export const COLLECTION_FOLDER = '鱼之宝库'
export const LEGACY_COLLECTION_FOLDER = '鱼的收藏'
/** 宝库下的两个子目录：图库、网站链接（名字直接对应分区）。 */
export const GALLERY_FOLDER = '图库'
export const SITES_FOLDER = '网站链接'
// 早期版本加了序号前缀（1 图库 / 2 网站链接），落盘时顺手改成现在的名字。
const LEGACY_GALLERY_FOLDERS = ['1 图库']
const LEGACY_SITES_FOLDERS = ['2 网站链接']
export const PLATFORM_FOLDER = '鱼与世界'
export const GROWTH_FOLDER = '鱼的成长'

/** 平台 id → 本地留存目录名。与面板上的三个分区一一对应。 */
export const PLATFORM_DIRS = Object.freeze({
  qq: 'QQ',
  bili: 'B站',
  douyin: '抖音',
})

/** 默认根目录：桌面上的「鱼的世界」；注入 home 时（测试）放在 home 下。 */
export function defaultStorageRoot({ home = DSH_HOME } = {}) {
  if (home !== DSH_HOME) return join(home, ROOT_FOLDER)
  const desktop = join(homedir(), 'Desktop')
  return join(existsSync(desktop) ? desktop : home, ROOT_FOLDER)
}

/** 由根目录推导出全部子目录路径。纯函数，不碰磁盘。 */
export function storageLayout(root, collectionName = COLLECTION_FOLDER) {
  const base = resolve(String(root || ''))
  const collection = join(base, collectionName || COLLECTION_FOLDER)
  return {
    root: base,
    collection,
    gallery: join(collection, GALLERY_FOLDER),
    sites: join(collection, SITES_FOLDER),
    platforms: join(base, PLATFORM_FOLDER),
    growth: join(base, GROWTH_FOLDER),
    platform: (id) => join(base, PLATFORM_FOLDER, PLATFORM_DIRS[id] || String(id || '其它')),
  }
}

/**
 * 宝库目录改名后，老工作区里的「鱼的收藏」要变成「鱼之宝库」。
 *  - 目标不存在、旧目录存在：直接改名（同盘很快），失败就复制后保留旧目录；
 *  - 两个都在：不合并、不覆盖，继续用新目录，旧目录留给主人自己处理。
 * 返回真正在用的目录名。
 */
export function migrateCollectionName(base, logger) {
  const next = join(base, COLLECTION_FOLDER)
  const prev = join(base, LEGACY_COLLECTION_FOLDER)
  if (!existsSync(prev) || existsSync(next)) return COLLECTION_FOLDER
  try {
    renameSync(prev, next)
    try { logger?.info?.(`fish-world: 宝库目录已改名 ${prev} → ${next}`) } catch {}
    return COLLECTION_FOLDER
  } catch {
    try {
      copyTree(prev, next)
      try { logger?.info?.(`fish-world: 宝库目录已复制到新名字（旧目录保留）${prev} → ${next}`) } catch {}
      return COLLECTION_FOLDER
    } catch {
      // 改名与复制都失败（权限 / 占用）：先继续用旧目录，不能丢数据。
      return LEGACY_COLLECTION_FOLDER
    }
  }
}

/** 允许主人单独指定图库 / 网站链接目录；给了就用，没给就用默认推导值。 */
export function layoutWithOverrides(root, overrides = {}, collectionName = COLLECTION_FOLDER) {
  const layout = storageLayout(root, collectionName)
  const gallery = String(overrides.gallery || '').trim()
  const sites = String(overrides.sites || '').trim()
  if (gallery && isAbsolute(gallery)) layout.gallery = resolve(gallery)
  if (sites && isAbsolute(sites)) layout.sites = resolve(sites)
  // 主人单独指定了图库 / 网站目录时，它们可能不在宝库目录下面；
  // 子目录关系只在这两个目录仍位于 collection 内时才算数。
  layout.galleryInsideCollection = isInside(layout.gallery, layout.collection)
  layout.sitesInsideCollection = isInside(layout.sites, layout.collection)
  return layout
}

/** 判断 child 是否就在 parent 里面（Windows 下不区分大小写）。 */
function isInside(child, parent) {
  if (!child || !parent) return false
  const a = resolve(child).toLowerCase()
  const b = resolve(parent).toLowerCase()
  return a !== b && a.startsWith(b.endsWith('\\') || b.endsWith('/') ? b : b + sep)
}

function copyTree(source, target) {
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    const stat = statSync(from)
    if (stat.isDirectory()) copyTree(from, to)
    else if (stat.isFile() && !existsSync(to)) copyFileSync(from, to)
  }
}

/**
 * 把旧位置的数据搬进新工作区。目标已存在就什么都不做，绝不覆盖。
 * 优先整体 rename（同一分区很快）；跨分区时逐文件复制，旧目录保留一份不删。
 */
export function adoptLegacyDir(source, target, { logger } = {}) {
  if (!source || !target || resolve(source) === resolve(target)) return false
  if (existsSync(target) && readdirSync(target).length) return false
  if (!existsSync(source)) return false
  try {
    mkdirSync(dirname(target), { recursive: true })
    try {
      renameSync(source, target)
    } catch {
      copyTree(source, target)
    }
    try { logger?.info?.(`fish-world: 已把旧数据迁入工作区 ${source} → ${target}`) } catch {}
    return true
  } catch {
    return false
  }
}

export function createStorage({ home = DSH_HOME, config, world, logger } = {}) {
  // 宝库目录名：第一次真正落盘时把旧的「鱼的收藏」改成「鱼之宝库」。
  // 改名失败就继续用旧目录，不丢数据；外面随时能通过 layout() 看到真实路径。
  let collectionName = COLLECTION_FOLDER
  let collectionChecked = false

  function resolveCollectionName() {
    if (collectionChecked) return collectionName
    collectionChecked = true
    try { collectionName = migrateCollectionName(root(), logger) } catch {}
    return collectionName
  }

  function configuredRoot() {
    const raw = String(config?.()?.storage?.root || '').trim()
    if (!raw || !isAbsolute(raw)) return ''
    return resolve(raw)
  }

  function root() {
    return configuredRoot() || world?.root?.() || defaultStorageRoot({ home })
  }

  function layout() {
    return layoutWithOverrides(root(), config?.()?.storage || {}, collectionName)
  }

  /** 建好全部目录，并顺手把旧位置的收藏搬进来（只在目标为空时）。 */
  function ensure({ adopt = true } = {}) {
    resolveCollectionName()
    const paths = layout()
    for (const dir of [paths.root, paths.collection, paths.gallery, paths.sites, paths.platforms]) {
      mkdirSync(dir, { recursive: true })
    }
    if (adopt) {
      // 名称变了：把老工作区里的「鱼的收藏」也改成「鱼之宝库」，数据一条不少。
      resolveCollectionName()
      adoptLegacyDir(join(home, 'fish-world', 'stickers'), paths.gallery, { logger })
      adoptLegacyDir(join(home, 'fish-world-links'), paths.sites, { logger })
      adoptLegacyDir(join(home, 'fish-world-growth'), paths.growth, { logger })
    }
    return paths
  }

  /**
   * 报告路径。默认不落盘：面板只是"看"，不该因为打开面板就在桌面上建目录；
   * 真正写入时（ensure）才创建。
   */
  function describe({ create = false } = {}) {
    if (create) resolveCollectionName()
    const paths = create ? ensure() : layout()
    return {
      ok: true,
      root: paths.root,
      exists: existsSync(paths.root),
      configured: Boolean(configuredRoot()),
      defaultRoot: defaultStorageRoot({ home }),
      // 工作区已绑定时 root 就是工作区里的「鱼的世界」，否则用桌面默认位置。
      bound: Boolean(world?.root?.()),
      folders: {
        collection: paths.collection,
        gallery: paths.gallery,
        sites: paths.sites,
        platforms: paths.platforms,
        growth: paths.growth,
        byPlatform: Object.fromEntries(Object.keys(PLATFORM_DIRS).map((id) => [id, paths.platform(id)])),
      },
      layoutNote: '鱼之宝库 → 1 图库 / 2 网站链接；鱼与世界 → QQ / B站 / 抖音。',
    }
  }

  function hasRoot() {
    try { return existsSync(root()) } catch { return false }
  }

  return {
    root,
    layout,
    ensure,
    describe,
    hasRoot,
    /** 根目录名字就是「鱼的世界」时，直接用它，避免出现 鱼的世界/鱼的世界。 */
    isWorldFolder: (dir) => basename(resolve(dir)) === ROOT_FOLDER,
  }
}

export const __test = { defaultStorageRoot, storageLayout, layoutWithOverrides, migrateCollectionName, adoptLegacyDir, PLATFORM_DIRS }
