// 把“鱼的世界”这个唯一主 bundle 挂到桌面 profile。其它插件只是本包依赖，
// 由 cordis.patch.yml 作为内部能力装配，不要求用户逐个添加。
//   1. node_modules 里建 junction；
//   2. package.json 的 dependencies 加 link:；
//   3. dsh.profile.bundles 里加包名。
// 任何一步失败都不会继续写 package.json。
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-fish-world'
const COMPANIONS = {
  'dsh-qq-bridge': 'github:Yuuyuko-uu/dsh-qq-bridge',
  'dsh-fish-memory': 'github:Yuuyuko-uu/dsh-fish-memory',
  'dsh-feiyu-mood': 'github:Yuuyuko-uu/dsh-feiyu-mood',
  'dsh-bili-subagent': 'github:Yuuyuko-uu/dsh-bili-subagent',
  'dsh-tts-bridge': 'github:Yuuyuko-uu/dsh-tts-bridge',
  'sharp': '^0.35.5',
}
// dsh-fish-world 合并了早期两个独立包；下列名称只用于升级时清理旧安装，
// 不是当前功能的一部分，也不会作为可选能力对外暴露。
const LEGACY_PACKAGES = ['dsh-qq-ecosystem-adapter', 'dsh-companion-panel']
// These are composed by cordis.patch.yml and must not also be top-level bundles.
const COMPOSED_BUNDLES = [
  ...LEGACY_PACKAGES,
  'dsh-qq-bridge',
  'dsh-feiyu-mood',
  'dsh-fish-memory',
  'dsh-bili-subagent',
  'dsh-tts-bridge',
]
const SUPERSEDED_PACKAGES = LEGACY_PACKAGES
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const uninstall = args.has('--uninstall')
const repairAuth = !args.has('--no-auth-repair')
const profileArg = [...args].find((arg) => arg.startsWith('--profile='))
const profileName = profileArg ? profileArg.slice('--profile='.length) : 'desktop'
const homeArg = [...args].find((arg) => arg.startsWith('--home='))
const home = resolve(homeArg ? homeArg.slice('--home='.length) : (process.env.DSH_HOME || join(homedir(), '.dsh')))
const profileDir = join(home, 'profiles', profileName)
const packageJsonPath = join(profileDir, 'package.json')
const target = join(profileDir, 'node_modules', PACKAGE)
const statePath = join(profileDir, `.${PACKAGE}.install-state.json`)

function fail(message) {
  console.error('✖ ' + message)
  process.exit(1)
}

if (!existsSync(packageJsonPath)) fail(`找不到 profile：${packageJsonPath}`)

const raw = readFileSync(packageJsonPath, 'utf8')
let pkg
try { pkg = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch (error) { fail(`profile package.json 解析失败：${error.message}`) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${packageJsonPath}.bak-before-dsh-fish-world-${stamp}`
const localPackage = 'link:' + source.replace(/\\/g, '/')
const comparablePath = (value) => {
  const result = resolve(value)
  return process.platform === 'win32' ? result.toLowerCase() : result
}

function readState() {
  if (!existsSync(statePath)) return { addedBundles: [], addedDependencies: {}, removedBundles: [], removedDependencies: {} }
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    return {
      addedBundles: Array.isArray(state.addedBundles) ? state.addedBundles : [],
      addedDependencies: state.addedDependencies && typeof state.addedDependencies === 'object'
        ? state.addedDependencies
        : {},
      removedBundles: Array.isArray(state.removedBundles) ? state.removedBundles : [],
      removedDependencies: state.removedDependencies && typeof state.removedDependencies === 'object'
        ? state.removedDependencies
        : {},
    }
  } catch (error) {
    fail(`安装状态文件解析失败：${error.message}`)
  }
}

function save() {
  writeFileSync(backup, raw, 'utf8')
  // Match DSH's own writer (2-space JSON + trailing newline) so the manifest
  // does not churn formatting when the host rewrites it after package operations.
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

function removeLink() {
  if (!existsSync(target)) return
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) {
    if (comparablePath(realpathSync(target)) !== comparablePath(source)) {
      console.warn(`! ${target} 指向另一个目录，没有移除。`)
      return
    }
    rmSync(target, { recursive: true, force: true })
    console.log('· 已移除 node_modules 联接')
  } else if (comparablePath(realpathSync(target)) === comparablePath(source)) {
    console.log('· 插件是直接安装在 profile 中，保留包文件')
  } else {
    console.warn(`! ${target} 不是联接（可能是真实目录），没有删除。需要手工处理。`)
  }
}

function removeSupersededLink(name, spec) {
  const target = join(profileDir, 'node_modules', name)
  if (!existsSync(target) || !String(spec || '').startsWith('link:')) return
  try {
    if (!lstatSync(target).isSymbolicLink()) return
    const expected = resolve(profileDir, String(spec).slice('link:'.length))
    if (comparablePath(realpathSync(target)) !== comparablePath(expected)) return
    rmSync(target, { recursive: true, force: true })
    console.log(`· 已移除旧包目录联接 ${name}`)
  } catch (error) {
    console.warn(`! 未移除旧包联接 ${name}：${error.message}`)
  }
}

if (uninstall) {
  const state = readState()
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object') pkg.dependencies = {}
  if (pkg.dependencies?.[PACKAGE] === localPackage || state.addedDependencies[PACKAGE] === pkg.dependencies?.[PACKAGE]) {
    delete pkg.dependencies[PACKAGE]
  }
  for (const [name, spec] of Object.entries(state.addedDependencies)) {
    if (name !== PACKAGE && pkg.dependencies?.[name] === spec) delete pkg.dependencies[name]
  }
  for (const [name, spec] of Object.entries(state.removedDependencies)) {
    if (Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, name)) continue
    if (String(spec).startsWith('link:')) {
      const linkedPath = String(spec).slice('link:'.length)
      const absolutePath = resolve(profileDir, linkedPath)
      if (!existsSync(absolutePath)) {
        console.warn(`! 未恢复 ${name}：原 link 目标不存在（${absolutePath}）`)
        continue
      }
    }
    pkg.dependencies[name] = spec
  }
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
    const owned = new Set([...state.addedBundles, PACKAGE])
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => !owned.has(name))
    for (const entry of [...state.removedBundles].sort((a, b) => Number(a.index) - Number(b.index))) {
      if (!entry || typeof entry.name !== 'string' || pkg.dsh.profile.bundles.includes(entry.name)) continue
      if (state.removedDependencies[entry.name] && !Object.hasOwn(pkg.dependencies, entry.name)) {
        console.warn(`! 未恢复 ${entry.name} bundle：原插件依赖未恢复。`)
        continue
      }
      const index = Number.isInteger(entry.index) ? Math.max(0, Math.min(entry.index, pkg.dsh.profile.bundles.length)) : pkg.dsh.profile.bundles.length
      pkg.dsh.profile.bundles.splice(index, 0, entry.name)
    }
  }
  removeLink()
  save()
  if (existsSync(statePath)) rmSync(statePath, { force: true })
  console.log(`✔ 已从 ${profileName} profile 移除 ${PACKAGE}`)
  console.log('  仅移除本安装器新增的依赖与 bundle；原先已有的功能会保留。重启 DSH 后生效。备份：' + backup)
  process.exit(0)
}

// 1) junction
mkdirSync(dirname(target), { recursive: true })
if (existsSync(target)) {
  if (comparablePath(realpathSync(target)) !== comparablePath(source)) {
    fail(`${target} 已存在，但不是当前插件目录；为避免覆盖，已停止安装。`)
  }
  console.log(`✔ 使用已安装的插件目录：${target}`)
} else {
  try {
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`✔ node_modules 联接：${target} → ${source}`)
  } catch (error) {
    fail(`创建目录联接失败：${error.message}`)
  }
}

// 2) dependencies. Keep any dependency the user already configured.
if (!pkg.dependencies || typeof pkg.dependencies !== 'object') pkg.dependencies = {}
const state = readState()
const ownedDependencies = { ...state.addedDependencies }
const removedDependencies = { ...state.removedDependencies }
if (!Object.prototype.hasOwnProperty.call(pkg.dependencies, PACKAGE)) {
  pkg.dependencies[PACKAGE] = localPackage
  ownedDependencies[PACKAGE] = localPackage
} else if (pkg.dependencies[PACKAGE] !== localPackage) {
  console.warn(`! 已有 ${PACKAGE} 依赖配置，保留现有值：${pkg.dependencies[PACKAGE]}`)
}
for (const [name, spec] of Object.entries(COMPANIONS)) {
  if (!Object.prototype.hasOwnProperty.call(pkg.dependencies, name)) {
    pkg.dependencies[name] = spec
    ownedDependencies[name] = spec
  } else if (ownedDependencies[name] && ownedDependencies[name] !== pkg.dependencies[name]) {
    delete ownedDependencies[name]
  }
}
for (const name of SUPERSEDED_PACKAGES) {
  const isConfigured = Object.prototype.hasOwnProperty.call(pkg.dependencies, name)
  const spec = isConfigured ? pkg.dependencies[name] : removedDependencies[name]
  if (isConfigured) {
    if (!Object.prototype.hasOwnProperty.call(removedDependencies, name)) removedDependencies[name] = spec
    delete pkg.dependencies[name]
    delete ownedDependencies[name]
    console.log(`· 已移除旧包依赖 ${name}：功能已由 dsh-fish-world 合并`)
  }
  if (spec) removeSupersededLink(name, spec)
}

// 3) Activate only the user-facing bundle. Its patch composes all internal modules.
if (!pkg.dsh || typeof pkg.dsh !== 'object') pkg.dsh = {}
if (!pkg.dsh.profile || typeof pkg.dsh.profile !== 'object') pkg.dsh.profile = {}
if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
const addedBundles = new Set(state.addedBundles)
const removedBundles = [...state.removedBundles]
const composedEntries = COMPOSED_BUNDLES
  .map((name) => ({ name, index: pkg.dsh.profile.bundles.indexOf(name) }))
  .filter((entry) => entry.index >= 0)
  .sort((a, b) => b.index - a.index)
for (const { name, index } of composedEntries) {
  if (!removedBundles.some((entry) => entry && entry.name === name)) removedBundles.push({ name, index })
  pkg.dsh.profile.bundles.splice(index, 1)
  console.log(`· 已从顶层 bundle 移除 ${name}：由鱼的世界内部装配`)
}
// Older releases incorrectly disabled the whale as if it were always bundled.
// Restore a previously active optional whale now that fish-world detects it at
// runtime instead of installing/composing it unconditionally.
const previousWhale = removedBundles.find((entry) => entry && entry.name === 'dsh-whale-widget')
const whaleInstalled = Object.hasOwn(pkg.dependencies, 'dsh-whale-widget')
  || existsSync(join(profileDir, 'node_modules', 'dsh-whale-widget', 'package.json'))
if (previousWhale && whaleInstalled) {
  if (!pkg.dsh.profile.bundles.includes('dsh-whale-widget')) {
    const index = Number.isInteger(previousWhale.index)
      ? Math.max(0, Math.min(previousWhale.index, pkg.dsh.profile.bundles.length))
      : pkg.dsh.profile.bundles.length
    pkg.dsh.profile.bundles.splice(index, 0, 'dsh-whale-widget')
  }
  for (let i = removedBundles.length - 1; i >= 0; i--) {
    if (removedBundles[i]?.name === 'dsh-whale-widget') removedBundles.splice(i, 1)
  }
  console.log('· 已恢复可选鲸鱼 bundle：鱼世界会检测并与它联动')
}
if (!pkg.dsh.profile.bundles.includes(PACKAGE)) {
  pkg.dsh.profile.bundles.push(PACKAGE)
  addedBundles.add(PACKAGE)
}

writeFileSync(statePath, JSON.stringify({
  version: 1,
  addedBundles: [...addedBundles],
  addedDependencies: ownedDependencies,
  removedBundles,
  removedDependencies,
}, null, 2) + '\n', 'utf8')
save()
console.log(`✔ 已写入 ${packageJsonPath}`)
console.log('✔ 已添加唯一 bundle：鱼的世界（QQ、记忆、状态、B站、朗读等由内部 patch 装配）')
console.log('  备份：' + backup)
// DSH desktop accumulates one loopback auth cookie per launch; enough stale
// entries make the next launch abort with "Web authentication failed". This
// only clears 127.0.0.1/localhost cookies, never account data.
try {
  if (repairAuth) {
    const { repairDesktopAuth } = await import('./repair-desktop-auth.mjs')
    const repaired = await repairDesktopAuth()
    if (repaired.skipped === 'cookies-db-locked') console.log('· 未能清理启动残留 Cookie（DSH 似乎仍在运行）；下次启动前可运行 npm run repair:auth')
    else if (repaired.ok && repaired.removed > 0) console.log('✔ 已清理旧启动残留 Cookie，避免下次启动认证失败')
  }
} catch (error) {
  console.log(`· 跳过启动残留 Cookie 清理：${error?.message || error}`)
}
console.log('')
console.log('接下来：完整退出 DSH 桌面端，再重新打开。')
console.log('验证：设置 → 鱼的世界，或主界面右侧鱼世界面板；对话里可调用 qq_ecosystem（action=status）。')
