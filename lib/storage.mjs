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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const ROOT_FOLDER = '鱼的世界'
export const COLLECTION_FOLDER = '鱼的收藏'
export const GALLERY_FOLDER = '1 图库'
export const SITES_FOLDER = '2 网站链接'
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
export function storageLayout(root) {
  const base = resolve(String(root || ''))
  return {
    root: base,
    collection: join(base, COLLECTION_FOLDER),
    gallery: join(base, COLLECTION_FOLDER, GALLERY_FOLDER),
    sites: join(base, COLLECTION_FOLDER, SITES_FOLDER),
    platforms: join(base, PLATFORM_FOLDER),
    growth: join(base, GROWTH_FOLDER),
    platform: (id) => join(base, PLATFORM_FOLDER, PLATFORM_DIRS[id] || String(id || '其它')),
  }
}

/** 允许主人单独指定图库 / 网站链接目录；给了就用，没给就用默认推导值。 */
export function layoutWithOverrides(root, overrides = {}) {
  const layout = storageLayout(root)
  const gallery = String(overrides.gallery || '').trim()
  const sites = String(overrides.sites || '').trim()
  if (gallery && isAbsolute(gallery)) layout.gallery = resolve(gallery)
  if (sites && isAbsolute(sites)) layout.sites = resolve(sites)
  return layout
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
  function configuredRoot() {
    const raw = String(config?.()?.storage?.root || '').trim()
    if (!raw || !isAbsolute(raw)) return ''
    return resolve(raw)
  }

  function root() {
    return configuredRoot() || world?.root?.() || defaultStorageRoot({ home })
  }

  function layout() {
    return layoutWithOverrides(root(), config?.()?.storage || {})
  }

  /** 建好全部目录，并顺手把旧位置的收藏搬进来（只在目标为空时）。 */
  function ensure({ adopt = true } = {}) {
    const paths = layout()
    for (const dir of [paths.root, paths.collection, paths.gallery, paths.sites, paths.platforms]) {
      mkdirSync(dir, { recursive: true })
    }
    if (adopt) {
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
      layoutNote: '鱼的收藏 → 1 图库 / 2 网站链接；鱼与世界 → QQ / B站 / 抖音。',
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

export const __test = { defaultStorageRoot, storageLayout, adoptLegacyDir, PLATFORM_DIRS }
