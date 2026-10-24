// 运行时环境自检。
//
// 插件依赖几个独立发布的内部包（QQ 桥、心情、记忆、mnemon、B 站、朗读桥）。
// 少装一个，对应功能就会静默不可用，用户只看到「没反应」。这里在启动、打开面板、
// 调用工具时检查它们：只有缺依赖或接线异常时才提醒安装，全部就绪时保持安静。
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-fish-world'
export const MIN_NODE_MAJOR = 20
const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 插件真正会用到的内部依赖。缺一个就提醒安装，装好了就不再提。
 *  spec 是真正能装上的包源：四个只在 GitHub 发布，写成裸包名会让用户 404。
 *  platform 标出「鱼与世界」里对应的平台前置：QQ / B 站 / 抖音靠这三个插件才能运作。 */
export const DEPENDENCIES = [
  { name: 'dsh-qq-bridge', label: 'QQ 桥', feature: 'QQ 消息收发和 QQ 空间', spec: 'github:Yuuyuko-uu/dsh-qq-bridge', platform: 'qq' },
  { name: 'dsh-feiyu-mood', label: '心情面板', feature: '心情与生理状态', spec: 'github:Yuuyuko-uu/dsh-feiyu-mood' },
  { name: 'dsh-fish-memory', label: '鱼的记忆', feature: '鱼的记忆', spec: 'github:Yuuyuko-uu/dsh-fish-memory' },
  { name: 'dsh-mnemon', label: '长期记忆', feature: '长期记忆', spec: 'dsh-mnemon' },
  { name: 'dsh-bili-subagent', label: 'B 站能力', feature: 'B 站浏览', spec: 'github:Yuuyuko-uu/dsh-bili-subagent', platform: 'bili' },
  { name: 'dsh-douyin-browser-local', label: '抖音能力', feature: '鱼自己刷抖音、看真实画面', spec: 'dsh-douyin-browser-local@1.4.4', optional: true, platform: 'douyin' },
  { name: 'dsh-tts-bridge', label: '朗读桥', feature: '语音朗读（可选，默认关闭）', spec: 'github:Yuuyuko-uu/dsh-tts-bridge', optional: true },
  { name: 'sharp', label: '动图解码库', feature: 'GIF / 动态 WebP 多帧视觉理解', spec: 'sharp@^0.35.5', core: true },
]

function defaultHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function comparable(value) {
  const result = resolve(value)
  return process.platform === 'win32' ? result.toLowerCase() : result
}

/**
 * 从环境变量 / 实际存在的 profile 目录推断当前 profile，避免检查错目录。
 * 优先选真正声明了本插件的 profile，其次才是桌面端 / web 的默认值。
 */
export function detectProfile(home, explicit) {
  if (explicit) return String(explicit)
  const fromEnv = String(process.env.DSH_PROFILE || '').trim()
  if (fromEnv) return fromEnv
  const candidates = ['desktop', 'web', 'headless', 'tui', 'acp', 'sdk']
  const existing = candidates.filter((name) => existsSync(join(home, 'profiles', name, 'package.json')))
  for (const name of existing) {
    const pkg = readManifest(join(home, 'profiles', name, 'package.json'))
    if (Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) return name
  }
  return existing[0] || 'desktop'
}

/**
 * 检查 profile 接线：依赖声明、node_modules 联接、bundle 声明。
 * 与 scripts/doctor.mjs 共用同一份实现（doctor 直接 re-export）。
 */
export function diagnoseDesktop({ home = defaultHome(), profile = 'desktop', sourceDir = SOURCE_DIR } = {}) {
  const profileDir = join(home, 'profiles', profile)
  const packageJsonPath = join(profileDir, 'package.json')
  const target = join(profileDir, 'node_modules', PACKAGE_NAME)
  const issues = []
  const add = (code, message, fixable = true) => issues.push({ code, message, fixable })

  if (!existsSync(packageJsonPath)) {
    add('profile-missing', `找不到 profile：${packageJsonPath}`, false)
    return { ok: false, profileDir, packageJsonPath, issues }
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    add('manifest-invalid', `profile package.json 解析失败：${error.message}`, false)
    return { ok: false, profileDir, packageJsonPath, issues }
  }

  const spec = pkg?.dependencies?.[PACKAGE_NAME]
  if (!spec) add('dependency-missing', `dependencies 里没有 ${PACKAGE_NAME}`, true)

  if (!existsSync(target)) {
    add('link-missing', `node_modules 里没有 ${PACKAGE_NAME}（宿主无法解析 bundle）`, true)
  } else {
    try {
      const stat = lstatSync(target)
      if (stat.isSymbolicLink()) {
        if (comparable(realpathSync(target)) !== comparable(sourceDir)) {
          add('link-wrong-target', `node_modules/${PACKAGE_NAME} 指向 ${realpathSync(target)}，不是当前插件目录 ${sourceDir}`, true)
        }
      } else if (comparable(realpathSync(target)) !== comparable(sourceDir)) {
        add('link-wrong-target', `node_modules/${PACKAGE_NAME} 不是指向当前插件目录的联接`, false)
      }
    } catch (error) {
      add('link-unreadable', `无法读取 node_modules/${PACKAGE_NAME}：${error.message}`, true)
    }
  }

  const manifestPath = join(target, 'package.json')
  if (!existsSync(manifestPath)) {
    add('package-manifest-missing', `缺少 ${PACKAGE_NAME}/package.json`, true)
  } else {
    const manifest = readManifest(manifestPath)
    if (!manifest) {
      add('package-manifest-invalid', `${PACKAGE_NAME}/package.json 解析失败`, false)
    } else {
      if (manifest?.dsh?.bundle?.patch === undefined) {
        add('not-a-bundle', `${PACKAGE_NAME} 没有声明 dsh.bundle.patch，DSH 会把它当成普通依赖并从 bundles 删除`, false)
      }
      if (!manifest?.main) add('no-main', `${PACKAGE_NAME} 没有 main 入口`, false)
    }
  }

  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  if (!bundles.includes(PACKAGE_NAME)) {
    add('bundle-missing', `dsh.profile.bundles 里没有 ${PACKAGE_NAME}（host 不会加载服务端插件）`, true)
  }

  return { ok: issues.length === 0, profileDir, packageJsonPath, issues }
}

function candidatePackageFiles(name, home, profile) {
  const profiles = [...new Set([profile, 'desktop', 'web'].filter(Boolean))]
  const files = []
  for (const item of profiles) files.push(join(home, 'profiles', item, 'node_modules', name, 'package.json'))
  files.push(join(home, 'node_modules', name, 'package.json'))
  files.push(join(SOURCE_DIR, 'node_modules', name, 'package.json'))
  return files
}

/** 找依赖包：先看 profile 的 node_modules，再退回 Node 自己的解析（pnpm 提升等）。 */
export function resolveDependency(name, { home = defaultHome(), profile = detectProfile(home) } = {}) {
  for (const file of candidatePackageFiles(name, home, profile)) {
    if (!existsSync(file)) continue
    const pkg = readManifest(file)
    return { found: true, path: dirname(file), version: String(pkg?.version || '') }
  }
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve(name)
    let dir = dirname(entry)
    for (let i = 0; i < 8; i += 1) {
      const pkg = readManifest(join(dir, 'package.json'))
      if (pkg && pkg.name === name) return { found: true, path: dir, version: String(pkg.version || '') }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return { found: true, path: dirname(entry), version: '' }
  } catch (error) {
    return { found: false, path: '', version: '', error: String(error?.code || error?.message || error) }
  }
}

function nearestExisting(dir) {
  let current = resolve(dir)
  for (let i = 0; i < 24; i += 1) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}

function checkWritable(file) {
  try {
    const dir = nearestExisting(dirname(file))
    if (!dir) return { ok: false, error: '找不到可写的上级目录' }
    accessSync(dir, constants.W_OK)
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

function describePackages(packages) {
  return packages.map((item) => `${item.name}${item.found ? '@' + (item.version || '?') : '（未安装）'}`).join('、')
}

/**
 * 一次性检查：Node 版本、内部依赖、profile 接线、配置可写。
 * 返回结构同时给面板（含路径）和工具/提示词（用 environmentView 去掉本机路径）。
 */
export function checkEnvironment({ home = defaultHome(), profile, configStore, configPath, sourceDir = SOURCE_DIR } = {}) {
  const resolvedHome = resolve(home)
  const resolvedProfile = detectProfile(resolvedHome, profile)
  const warnings = []
  const hints = []
  const addHint = (label, command = '') => {
    if (!hints.some((item) => item.label === label && item.command === command)) hints.push({ label, command })
  }

  const nodeMajor = Number(String(process.versions.node || '').split('.')[0]) || 0
  const nodeOk = nodeMajor >= MIN_NODE_MAJOR
  if (!nodeOk) {
    warnings.push(`Node.js ${process.version} 低于最低要求 v${MIN_NODE_MAJOR}，插件可能无法运行；请升级后重启 DSH。`)
    addHint(`升级 Node.js 到 v${MIN_NODE_MAJOR} 或更高`)
  }

  const packages = DEPENDENCIES.map((dep) => {
    const resolved = resolveDependency(dep.name, { home: resolvedHome, profile: resolvedProfile })
    return { ...dep, ...resolved, found: dep.core === true || resolved.found }
  })
  // AstrBot 当 QQ 通道时，dsh-qq-bridge 不再是必需依赖：
  // 否则主人明明已经配好 AstrBot，还会被一直提醒"缺 QQ 桥"。
  const astrbotCfg = (() => {
    try { return configStore?.getConfig?.()?.astrbot || null } catch { return null }
  })()
  const astrbotCarriesQQ = astrbotCfg?.enabled === true && astrbotCfg?.useForQQ === true
  if (astrbotCarriesQQ) {
    const bridge = packages.find((item) => item.name === 'dsh-qq-bridge')
    if (bridge && !bridge.found) {
      bridge.optional = true
      bridge.note = 'QQ 通道已由 AstrBot 承担，QQ 桥可不装'
    }
  }
  const missing = packages.filter((item) => !item.found && item.optional !== true)
  if (missing.length) {
    warnings.push(`未安装依赖：${missing.map((item) => `${item.name}（${item.label}）`).join('、')}；对应功能会不可用。`)
    for (const item of missing) addHint(`安装${item.label}（${item.name}）`, `dsh plugin --profile ${resolvedProfile} add ${item.spec || item.name}`)
  }

  const profilesRoot = join(resolvedHome, 'profiles')
  let wiring = { checked: false, ok: true, profileDir: join(profilesRoot, resolvedProfile), packageJsonPath: join(profilesRoot, resolvedProfile, 'package.json'), issues: [] }
  if (existsSync(profilesRoot)) {
    wiring = { checked: true, ...diagnoseDesktop({ home: resolvedHome, profile: resolvedProfile, sourceDir }) }
    for (const issue of wiring.issues) warnings.push(`插件接线异常：${issue.message}`)
    if (wiring.issues.some((issue) => issue.fixable)) addHint('自动修复插件接线', 'npm run doctor --fix')
    if (!wiring.ok) addHint('重新应用桌面端安装', 'npm run install:desktop')
  }

  const configFile = configPath || configStore?.configPath || join(resolvedHome, 'fish-world-config.json')
  const writable = checkWritable(configFile)
  const config = { path: configFile, ...writable }
  if (!writable.ok) {
    warnings.push(`配置目录不可写：${dirname(configFile)}（${writable.error}）；设置和状态无法保存。`)
    addHint(`检查 ${dirname(configFile)} 的写入权限`)
  }

  const fixCommand = wiring.checked && wiring.issues.some((issue) => issue.fixable)
    ? 'npm run doctor --fix'
    : missing.length ? `dsh plugin --profile ${resolvedProfile} add ${missing[0].spec || missing[0].name}` : ''
  const summary = warnings.length === 0
    ? `运行环境正常：Node ${process.version}，${packages.length} 个依赖已安装。`
    : `环境检查发现 ${warnings.length} 类问题：${warnings[0]}${warnings.length > 1 ? '…' : ''}`

  return {
    ok: warnings.length === 0,
    checkedAt: new Date().toISOString(),
    home: resolvedHome,
    profile: resolvedProfile,
    node: { version: process.version, major: nodeMajor, minimum: MIN_NODE_MAJOR, ok: nodeOk },
    packages,
    missing: missing.map((item) => item.name),
    wiring,
    config,
    warnings,
    hints,
    fixCommand,
    summary,
    packageList: describePackages(packages),
  }
}

/** 去掉本机盘符、用户名与绝对路径，给工具 / 提示词用。 */
function redact(text, home) {
  let out = String(text ?? '')
  if (home) {
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
    for (const variant of variants) {
      if (variant) out = out.split(variant).join('<DSH_HOME>')
    }
  }
  out = out.replace(/[A-Za-z]:[\\/][^\s，。；：、"')）]*/g, '<本地路径>')
  out = out.replace(/\/(?:home|Users)\/[^\s/，。；：、"')）]+(?:\/[^\s，。；：、"')）]*)?/g, '<本地路径>')
  return out
}

/** 给工具 / 系统提示词用的脱敏视图：不含本机盘符、用户名和绝对路径。 */
export function environmentView(env) {
  if (!env) return null
  return {
    ok: env.ok,
    checkedAt: env.checkedAt,
    profile: env.profile,
    node: env.node,
    packages: env.packages.map((item) => ({
      name: item.name,
      label: item.label,
      feature: item.feature,
      found: item.found,
      version: item.version,
    })),
    missing: (env.missing || []).slice(),
    wiring: {
      checked: env.wiring.checked,
      ok: env.wiring.ok,
      issues: env.wiring.issues.map((issue) => ({ code: issue.code, message: redact(issue.message, env.home) })),
    },
    config: { ok: env.config.ok, error: redact(env.config.error, env.home) },
    warnings: env.warnings.map((warning) => redact(warning, env.home)),
    hints: env.hints.map((item) => ({ label: redact(item.label, env.home), command: redact(item.command, env.home) })),
    fixCommand: redact(env.fixCommand, env.home),
    summary: redact(env.summary, env.home),
  }
}

/**
 * 带缓存的检查器：面板轮询 / 每次工具调用都不重复扫盘。
 * `check()` 会刷新；`status()` 命中缓存。警告集合变化时才写日志，避免刷屏。
 */
export function createEnvironment({ home = defaultHome(), profile, configStore, logger, ttlMs = 60_000, sourceDir = SOURCE_DIR } = {}) {
  const resolvedHome = resolve(home)
  const resolvedProfile = detectProfile(resolvedHome, profile)
  let cached = null
  let cachedAt = 0
  let lastWarnings = null

  function logChange(next, force = false) {
    const key = next.warnings.join('\n')
    if (!force && key === lastWarnings) return
    lastWarnings = key
    try {
      if (next.ok) {
        logger?.info?.(`fish-world: ${next.summary}`)
        return
      }
      for (const warning of next.warnings) logger?.warn?.(`fish-world: 环境检查：${warning}`)
      const fix = next.hints.map((item) => item.command || item.label).filter(Boolean).join('；')
      if (fix) logger?.warn?.(`fish-world: 环境修复：${fix}`)
    } catch {}
  }

  function run() {
    cached = checkEnvironment({ home: resolvedHome, profile: resolvedProfile, configStore, sourceDir })
    cachedAt = Date.now()
    logChange(cached)
    return cached
  }

  function status({ refresh = false } = {}) {
    if (refresh || !cached || Date.now() - cachedAt > ttlMs) run()
    return cached
  }

  return {
    home: resolvedHome,
    profile: resolvedProfile,
    check: run,
    status,
    view: () => environmentView(status()),
    summary: () => status().summary,
  }
}
