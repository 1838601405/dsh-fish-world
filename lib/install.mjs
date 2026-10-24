// 一键安装依赖：从面板里触发，不需要用户开终端。
//
// 做的事和 scripts/install-desktop.mjs 一样，但以"可被 HTTP 调用、有进度、
// 有结果回执"的形式封装：
//  1. 把插件本身挂到 profile（junction + dependencies + bundles）；
//  2. 把缺失的运行依赖加进 profile 的 dependencies；
//  3. 调 DSH 自带的包管理器装依赖（桌面端用 pnpm，web 端可用 dsh plugin add）。
//
// 安全边界：
//  - 只接受 loopback；
//  - 只操作当前 home 下的 profile 目录；
//  - 不执行用户传入的任意命令，命令由代码固定；
//  - 写入前备份 package.json；
//  - 全程可 --uninstall 回滚。
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PACKAGE = 'dsh-fish-world'

// 依赖清单与 env.mjs 的 DEPENDENCIES 保持同源，避免两处漂移。
const COMPANIONS = [
  { name: 'dsh-qq-bridge', spec: 'github:Yuuyuko-uu/dsh-qq-bridge', optional: false },
  { name: 'dsh-feiyu-mood', spec: 'github:Yuuyuko-uu/dsh-feiyu-mood', optional: false },
  { name: 'dsh-fish-memory', spec: 'github:Yuuyuko-uu/dsh-fish-memory', optional: false },
  { name: 'dsh-mnemon', spec: '^0.5.28', optional: false },
  { name: 'dsh-bili-subagent', spec: 'github:Yuuyuko-uu/dsh-bili-subagent', optional: false },
  { name: 'dsh-tts-bridge', spec: 'github:Yuuyuko-uu/dsh-tts-bridge', optional: true },
  { name: 'dsh-douyin-browser-local', spec: 'dsh-douyin-browser-local@1.4.4', optional: true },
  { name: 'sharp', spec: '^0.35.5', optional: false },
]

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 找出当前 profile 里还缺哪些依赖（只看声明，不看是否已装实体）。 */
export function declaredStatus({ home, profile = 'desktop' } = {}) {
  const profileDir = join(home, 'profiles', profile)
  const pkg = readJson(join(profileDir, 'package.json'))
  if (!pkg) return { ok: false, error: `找不到 profile：${profileDir}/package.json` }
  const deps = pkg.dependencies || {}
  const planned = COMPANIONS.map((item) => ({
    ...item,
    declared: Object.hasOwn(deps, item.name),
    installed: existsSync(join(profileDir, 'node_modules', item.name, 'package.json')),
  }))
  return {
    ok: true,
    profile,
    profileDir,
    missing: planned.filter((item) => !item.declared && !item.optional).map((item) => item.name),
    packages: planned,
  }
}

/**
 * 把依赖声明补进 profile 的 package.json。
 * 只补"没声明过"的，不动用户已有的版本选择。
 */
export function declareDependencies({ home, profile = 'desktop', includeOptional = false } = {}) {
  const profileDir = join(home, 'profiles', profile)
  const file = join(profileDir, 'package.json')
  const pkg = readJson(file)
  if (!pkg) throw new Error(`找不到 profile：${file}`)
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object') pkg.dependencies = {}

  const added = []
  for (const item of COMPANIONS) {
    if (item.optional && !includeOptional) continue
    if (Object.hasOwn(pkg.dependencies, item.name)) continue
    pkg.dependencies[item.name] = item.spec
    added.push(item.name)
  }

  // 本插件自己的 bundle 必须存在，否则宿主不加载服务端部分
  if (!pkg.dsh || typeof pkg.dsh !== 'object') pkg.dsh = {}
  if (!pkg.dsh.profile || typeof pkg.dsh.profile !== 'object') pkg.dsh.profile = {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  let bundleAdded = false
  if (!pkg.dsh.profile.bundles.includes(PACKAGE)) {
    pkg.dsh.profile.bundles.push(PACKAGE)
    bundleAdded = true
  }

  if (!added.length && !bundleAdded) {
    return { ok: true, changed: false, added, bundleAdded, profileDir }
  }

  // 写入前备份，任何一步失败都能找回原文件
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-before-fish-deps-${stamp}`
  writeFileSync(backup, readFileSync(file, 'utf8'), 'utf8')
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  return { ok: true, changed: true, added, bundleAdded, profileDir, backup }
}

/**
 * 真正安装：优先用 profile 自带的 pnpm（桌面端常见），否则退回 dsh CLI。
 * 命令固定拼接，不接受外部输入。
 */
/**
 * 找 pnpm：优先用 DSH 自带的那份（桌面端不要求用户全局装 pnpm）。
 * 顺序：环境变量 → DSH 运行时目录（从进程路径推导）→ DSH_HOME 下的 npm bin。
 */
export function resolvePnpm({ home } = {}) {
  const fromEnv = String(process.env.DSH_PNPM || '').trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  // 从当前进程推导 DSH 安装目录：插件运行在 DSH 宿主内，
  // 所以 process.execPath 通常就是 DSH 的 exe。这样不依赖额外环境变量。
  const roots = []
  const appRoot = String(process.env.DSH_APP_ROOT || '').trim()
  if (appRoot) roots.push(appRoot)
  try {
    const exeDir = dirname(process.execPath)
    roots.push(exeDir)
    roots.push(dirname(exeDir))
  } catch {}

  const candidates = []
  for (const root of roots) {
    candidates.push(join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'))
    candidates.push(join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnp', 'npm', 'bin', 'pnpm.mjs'))
  }
  // Windows 桌面端的常见安装位置（用户可能装在任意盘符，这里只覆盖默认几处）
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:']) {
      candidates.push(join(drive + '\\', 'DeepSeek', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'))
    }
  }
  if (home) {
    candidates.push(process.platform === 'win32' ? join(home, 'node_modules', '.bin', 'pnpm.cmd') : join(home, 'node_modules', '.bin', 'pnpm'))
  }

  for (const file of candidates) {
    if (file && existsSync(file)) return file
  }
  return 'pnpm'
}

function pnpmInvocation({ home } = {}) {
  const found = resolvePnpm({ home })
  // .mjs / .cjs 需要显式用 node 启动，不能当可执行文件调用
  if (/\.(mjs|cjs|js)$/i.test(found)) {
    return { cmd: process.execPath, prefix: [found], label: 'node pnpm' }
  }
  return { cmd: found, prefix: [], label: 'pnpm' }
}

export function installCommandFor({ home, profile = 'desktop' } = {}) {
  const profileDir = join(home, 'profiles', profile)
  const pnpm = pnpmInvocation({ home })
  // 桌面端：profile 目录里有 package.json，用 pnpm install。
  // 不要加 --prod=false（pnpm 不接受这种写法，会直接报参数错误）；
  // 默认行为就是装 dependencies + devDependencies，正是我们要的。
  if (existsSync(join(profileDir, 'package.json'))) {
    return { cmd: pnpm.cmd, args: [...pnpm.prefix, 'install'], cwd: profileDir, label: 'pnpm install' }
  }
  return { cmd: 'dsh', args: ['plugin', '--profile', profile, 'add', PACKAGE], cwd: home, label: 'dsh plugin add' }
}

export function fullInstallCommandFor({ home, profile = 'desktop' } = {}) {
  const profileDir = join(home, 'profiles', profile)
  if (existsSync(join(profileDir, 'package.json'))) {
    return { cmd: 'pnpm', args: ['install'], cwd: profileDir, label: 'pnpm install' }
  }
  return { cmd: 'dsh', args: ['plugin', '--profile', profile, 'add', PACKAGE], cwd: home, label: 'dsh plugin add' }
}

/**
 * 把一条依赖声明转成 `pnpm add` 能接受的参数。
 *
 * pnpm add 的规矩：
 *  - `npm:foo@1.2` 这类协议写法自带包名，原样传；
 *  - `github:owner/repo` / `git+...` / `file:` / `link:` 也自带来源，原样传；
 *  - 纯版本号（`^0.5.28`、`1.2.3`）**必须**拼成 `包名@版本`，
 *    否则 pnpm 会把版本号当包名，报 ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER。
 */
export function toAddSpecifier({ name, spec } = {}) {
  const pkg = String(name || '').trim()
  const raw = String(spec || '').trim()
  if (!pkg) return raw
  if (!raw) return pkg
  // 已经带包名或带协议来源的，直接用。
  if (/^(npm|github|gitlab|bitbucket|git\+|https?|file|link|portal|workspace):/i.test(raw)) return raw
  // 剩下的都是版本号 / 版本范围（^0.5.28、~1.2.3、>=1.0.0、1.2.3） → 拼包名。
  // 宁可拼包名，也不要把版本号当包名交给 pnpm。
  return `${pkg}@${raw}`
}

/** 跑安装命令并流式收集输出；超时可中止。 */
export function runInstall({ home, profile = 'desktop', timeoutMs = 240000, includeOptional = false } = {}) {
  return new Promise((resolvePromise) => {
    const lines = []
    let settled = false
    let current = null
    let planned = []

    const finish = (result) => {
      if (settled) return
      settled = true
      resolvePromise({
        ...result,
        output: lines.slice(-80).join('\n'),
        command: planned.map((p) => `${p.cmd} ${p.args.join(' ')}`).join(' && '),
      })
    }

    // 分两步：先按名字逐个 add 缺失依赖（pnpm 的 install 只装 package.json 里声明的），
    // 再跑一次完整 install 补齐 link 与依赖树。
    const missing = declaredStatus({ home, profile }).packages
      .filter((item) => !item.installed && (includeOptional || !item.optional))
    const pnpm = pnpmInvocation({ home })
    planned = missing.map((item) => ({
      cmd: pnpm.cmd,
      // pnpm add 的参数必须是「包名@版本」或「包名」。
      // 只传 spec（如 ^0.5.28）会被当成包名，直接报
      // ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER。
      // github:xxx 这类带协议的本身就含包名，不能再拼。
      args: [...pnpm.prefix, 'add', toAddSpecifier(item)],
      cwd: join(home, 'profiles', profile),
      label: 'pnpm add ' + item.name,
    }))
    const finalPlan = installCommandFor({ home, profile })
    planned.push(finalPlan)

    const runOne = (index, onDone) => {
      if (index >= planned.length) return onDone({ ok: true })
      const plan = planned[index]
      current = plan
      lines.push('$ ' + plan.cmd + ' ' + plan.args.join(' '))
      let child
      try {
        child = spawn(plan.cmd, plan.args, {
          cwd: plan.cwd,
          // 不用 shell：参数由代码固定，避免拼接带来的注入面
          shell: false,
          env: { ...process.env, DSH_HOME: home },
        })
      } catch (error) {
        return onDone({ ok: false, error: `无法启动 ${plan.cmd}：${error.message}` })
      }

      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        onDone({ ok: false, error: '安装超时，已中止' })
      }, timeoutMs)

      const collect = (chunk) => {
        for (const line of String(chunk || '').split(/\r?\n/)) if (line.trim()) lines.push(line.trim())
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)

      child.on('error', (error) => {
        clearTimeout(timer)
        onDone({ ok: false, error: `${plan.cmd} 启动失败：${error.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) return onDone({ ok: false, code, error: `${plan.label} 退出码 ${code}` })
        runOne(index + 1, onDone)
      })
    }

    runOne(0, finish)
  })
}

/**
 * 解除安装：把插件从 profile 的 bundles 与 dependencies 里移除，并删掉联接。
 * 只移除"本安装器加过的东西"，用户原有的依赖不动。
 */
export function uninstall({ home, profile = 'desktop' } = {}) {
  const profileDir = join(home, 'profiles', profile)
  const file = join(profileDir, 'package.json')
  const pkg = readJson(file)
  if (!pkg) throw new Error(`找不到 profile：${file}`)

  const removed = []
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
    const before = pkg.dsh.profile.bundles.length
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== PACKAGE)
    if (pkg.dsh.profile.bundles.length < before) removed.push('bundle:' + PACKAGE)
  }
  if (pkg.dependencies && Object.hasOwn(pkg.dependencies, PACKAGE)) {
    delete pkg.dependencies[PACKAGE]
    removed.push('dependency:' + PACKAGE)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-before-fish-uninstall-${stamp}`
  writeFileSync(backup, readFileSync(file, 'utf8'), 'utf8')
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  // 删掉 node_modules 里的联接（只删指向本插件的）
  const linkPath = join(profileDir, 'node_modules', PACKAGE)
  let linkRemoved = false
  try {
    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath, { recursive: true, force: true })
      linkRemoved = true
    }
  } catch {}

  return { ok: true, removed, linkRemoved, backup, profileDir }
}

export { COMPANIONS, PACKAGE }
