// 体检：依赖检查（本地）与更新检查（联网查版本）。
//
// 两者刻意分开：
//  - 依赖检查只看本机：依赖是否装上、版本多少、接线是否正常，不联网；
//  - 更新检查才联网，只查 registry / GitHub 上有没有更新的版本，
//    超时或网络不可用时明确报告"查不到"，绝不编造版本号。
//
// 更新检查不自动安装任何东西：它只告诉主人有新版，装不装由主人决定。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEPENDENCIES, PACKAGE_NAME, checkEnvironment, detectProfile, resolveDependency } from './env.mjs'
import { PLATFORMS } from './platforms.mjs'

const SOURCE_DIR = join(import.meta.dirname, '..')
const CACHE_TTL = 10 * 60 * 1000
const NETWORK_TIMEOUT = 8000

let updateCache = null

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 语义化版本比较：返回 a>b ? 1 : a<b ? -1 : 0。只处理 x.y.z 前缀。 */
export function compareVersions(a, b) {
  const parse = (v) => String(v || '').replace(/^[^\d]*/, '').split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

/** 从 github:owner/repo 或包名里推断可查询的源。 */
export function registryTarget(spec, name) {
  const raw = String(spec || '').trim()
  const gh = /^github:([^/\s]+)\/([^#\s]+)/i.exec(raw)
  if (gh) return { kind: 'github', owner: gh[1], repo: gh[2].replace(/\.git$/, ''), url: `https://raw.githubusercontent.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}/HEAD/package.json` }
  if (/^https:\/\/github\.com\//i.test(raw)) {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?\s]+)/i.exec(raw)
    if (m) return { kind: 'github', owner: m[1], repo: m[2].replace(/\.git$/, ''), url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/package.json` }
  }
  return { kind: 'npm', name: String(name || raw).trim(), url: `https://registry.npmjs.org/${encodeURIComponent(String(name || raw))}/latest` }
}

async function fetchJson(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), NETWORK_TIMEOUT) : null
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, data: await response.json() }
  } catch (error) {
    return { ok: false, error: String(error?.name === 'AbortError' ? '请求超时' : (error?.message || error)) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 依赖检查：完全离线，只看本机装了什么。 */
export function dependencyCheck({ home, profile, configStore } = {}) {
  const env = checkEnvironment({ home, profile, configStore, sourceDir: SOURCE_DIR })
  const installed = env.packages.filter((item) => item.found)
  const missing = env.packages.filter((item) => !item.found && item.optional !== true)
  const optionalMissing = env.packages.filter((item) => !item.found && item.optional === true)

  // 本插件自身版本
  const self = readJson(join(SOURCE_DIR, 'package.json')) || {}
  const selfInstalled = resolveDependency(PACKAGE_NAME, { home: env.home, profile: env.profile })

  // 平台前置：鱼与世界里的 QQ / B 站 / 抖音 / 微信各自靠独立插件运作，
  // 依赖检查把这层前置单独列出来，避免“基础依赖都在、平台却起不来”的误判。
  //
  // 微信只有一条来源：dsh-wechat-plugin（与 platformAvailability 的口径一致）。
  const platforms = Object.entries(PLATFORMS).map(([id, def]) => {
    const candidates = Array.isArray(def.plugins) && def.plugins.length ? def.plugins : [def.plugin]
    const matched = candidates
      .map((name) => env.packages.find((item) => item.name === name))
      .filter(Boolean)
    const found = matched.find((item) => item.found) || null
    // 标签/用途优先取主插件那条；主插件没装时退而取已装的那条，别显示成空。
    const lead = env.packages.find((item) => item.name === def.plugin) || matched[0] || {}
    return {
      id,
      name: def.name,
      plugin: def.plugin,
      label: lead.label || def.plugin,
      feature: lead.feature || def.description,
      installed: found !== null,
      version: found?.version || '',
      // 任一即可用 ⇒ 全都不是必需；qq/bili/douyin 只有一个候选，行为不变。
      optional: matched.every((item) => item.optional === true),
      note: lead.note || '',
    }
  })
  const platformReady = platforms.filter((item) => item.installed)
  const platformMissing = platforms.filter((item) => !item.installed)

  return {
    ok: env.ok,
    checkedAt: new Date().toISOString(),
    kind: 'dependency',
    online: false,
    profile: env.profile,
    node: env.node,
    self: {
      name: PACKAGE_NAME,
      version: String(self.version || ''),
      declared: String(selfInstalled.version || ''),
      linked: selfInstalled.found,
    },
    packages: env.packages.map((item) => ({
      name: item.name,
      label: item.label,
      feature: item.feature,
      spec: item.spec,
      version: item.version || '',
      found: item.found,
      optional: item.optional === true,
      core: item.core === true,
      platform: item.platform || '',
    })),
    platforms,
    counts: {
      total: env.packages.length,
      installed: installed.length,
      missing: missing.length,
      optionalMissing: optionalMissing.length,
      platforms: {
        total: platforms.length,
        installed: platformReady.length,
        missing: platformMissing.length,
      },
    },
    missing: missing.map((item) => item.name),
    optionalMissing: optionalMissing.map((item) => item.name),
    wiring: {
      checked: env.wiring.checked,
      ok: env.wiring.ok,
      issues: env.wiring.issues.map((issue) => ({ code: issue.code, message: issue.message })),
    },
    warnings: env.warnings,
    hints: env.hints,
    fixCommand: env.fixCommand,
    summary: env.ok
      ? `体检通过：${installed.length} 个依赖已就位，平台前置 ${platformReady.length}/${platforms.length}。`
      : `体检发现 ${missing.length + optionalMissing.length} 项待处理，平台前置 ${platformReady.length}/${platforms.length}。`,
  }
}

/**
 * 更新检查：联网查每个依赖与插件自身的可用版本。
 * 网络不通时逐项标记 unavailable，整体仍返回结果，不抛错。
 */
export async function updateCheck({ home, profile, configStore, force = false } = {}) {
  if (!force && updateCache && Date.now() - updateCache.at < CACHE_TTL) {
    return { ...updateCache.value, cached: true }
  }

  const resolvedHome = home || process.env.DSH_HOME || ''
  const resolvedProfile = profile || detectProfile(resolvedHome || '', '')
  const local = dependencyCheck({ home: resolvedHome || undefined, profile: resolvedProfile, configStore })
  const items = []

  // 插件自身
  // 仓库地址是唯一事实来源：改这里，前端"检查更新"才知道去哪查。
  const selfSpec = 'github:1838601405/dsh-fish-world'
  const selfPkg = readJson(join(SOURCE_DIR, 'package.json')) || {}
  items.push({
    name: PACKAGE_NAME,
    label: '鱼世界（本插件）',
    current: String(selfPkg.version || ''),
    target: registryTarget(selfSpec, PACKAGE_NAME),
    self: true,
  })

  for (const dep of DEPENDENCIES) {
    const found = local.packages.find((item) => item.name === dep.name)
    items.push({
      name: dep.name,
      label: dep.label,
      current: found?.version || '',
      target: registryTarget(dep.spec, dep.name),
      optional: dep.optional === true,
    })
  }

  const results = await Promise.all(items.map(async (item) => {
    const got = await fetchJson(item.target.url)
    if (!got.ok) {
      return {
        name: item.name,
        label: item.label,
        current: item.current,
        latest: '',
        status: 'unavailable',
        error: got.error,
        optional: item.optional === true,
      }
    }
    const latest = String(got.data?.version || got.data?.dist_tags?.latest || '').trim()
    if (!latest) {
      return { name: item.name, label: item.label, current: item.current, latest: '', status: 'unavailable', error: '没有读到版本号', optional: item.optional === true }
    }
    const cmp = item.current ? compareVersions(latest, item.current) : 1
    return {
      name: item.name,
      label: item.label,
      current: item.current,
      latest,
      status: !item.current ? 'not-installed' : cmp > 0 ? 'outdated' : 'current',
      optional: item.optional === true,
    }
  }))

  const outdated = results.filter((item) => item.status === 'outdated')
  const unavailable = results.filter((item) => item.status === 'unavailable')
  const value = {
    ok: true,
    kind: 'update',
    online: true,
    checkedAt: new Date().toISOString(),
    cached: false,
    items: results,
    counts: {
      total: results.length,
      outdated: outdated.length,
      current: results.filter((item) => item.status === 'current').length,
      unavailable: unavailable.length,
      notInstalled: results.filter((item) => item.status === 'not-installed').length,
    },
    // 只给命令，不代替主人执行安装
    hints: outdated.map((item) => ({
      label: `更新 ${item.label}`,
      command: item.name === PACKAGE_NAME
        ? `npm run install:desktop`
        : `dsh plugin --profile ${resolvedProfile} add ${(DEPENDENCIES.find((d) => d.name === item.name)?.spec) || item.name}`,
    })),
    summary: unavailable.length === results.length
      ? '更新检查：当前网络查不到版本信息，请检查网络后重试。'
      : outdated.length
        ? `更新检查：${outdated.length} 个依赖有新版可用。`
        : '更新检查：全部已是最新版本。',
  }

  updateCache = { at: Date.now(), value }
  return value
}

/** 清掉更新缓存，方便用户点「重新体检」时强制联网。 */
export function clearUpdateCache() {
  updateCache = null
}

export const __test = { compareVersions, registryTarget }
