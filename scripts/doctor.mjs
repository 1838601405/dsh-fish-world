// Diagnose (and with --fix, repair) the desktop wiring for dsh-fish-world.
//
// The plugin can look installed in the UI while the host never loads its server
// half. Two failures have actually happened:
//   1. `dsh.profile.bundles` lost the entry (DSH rewrites package.json after a
//      package operation), so client.js loaded but no routes/tools existed.
//   2. apply(ctx) threw before registering routes (a missing `home`), which
//      looked identical from the browser.
// This doctor checks the wiring the host actually reads, and optionally probes
// the running host. `--fix` re-runs the installer, which is idempotent.
//
// The implementation lives in lib/env.mjs so the running plugin, the panel's
// environment banner and this CLI all report the same thing.
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { diagnoseDesktop, checkEnvironment } from '../lib/env.mjs'

export { diagnoseDesktop }

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function probeHost(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const first = await fetch(url, { redirect: 'manual', signal: controller.signal })
    const cookie = (first.headers.get('set-cookie') || '').split(';')[0]
    const headers = cookie ? { cookie } : {}
    const root = await fetch(new URL('/', url), { redirect: 'manual', signal: controller.signal, headers })
    const html = await root.text()
    const settings = await fetch(new URL('/dsh-fish-world/settings', url), { redirect: 'manual', signal: controller.signal, headers })
    const settingsHtml = await settings.text()
    const market = await fetch(new URL('/dsh-fish-world/market?kind=plugin', url), { redirect: 'manual', signal: controller.signal, headers })
    let marketJson = {}
    try { marketJson = await market.json() } catch {}
    return {
      rootStatus: root.status,
      injected: html.includes('dsh-fish-world-panel-inline-v1') || html.includes('dsh-fish-world-mood-badge-inline-v1'),
      settingsStatus: settings.status,
      settingsReady: settingsHtml.includes('QQ Agent 扩展与设置'),
      marketStatus: market.status,
      marketLinks: Array.isArray(marketJson.links) ? marketJson.links.length : 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const args = new Set(process.argv.slice(2))
  const homeArg = [...args].find((arg) => arg.startsWith('--home='))
  const profileArg = [...args].find((arg) => arg.startsWith('--profile='))
  const probeArg = [...args].find((arg) => arg.startsWith('--probe='))
  const home = resolve(homeArg ? homeArg.slice('--home='.length) : (process.env.DSH_HOME || join(homedir(), '.dsh')))
  const profile = profileArg ? profileArg.slice('--profile='.length) : 'desktop'

  const result = diagnoseDesktop({ home, profile })
  const env = checkEnvironment({ home, profile })
  if (result.ok) {
    console.log(`✔ ${profile} profile 接线正常：${result.packageJsonPath}`)
  } else {
    for (const issue of result.issues) console.log(`✖ [${issue.code}] ${issue.message}`)
    if (args.has('--fix') && result.issues.some((issue) => issue.fixable)) {
      console.log('· 正在重新应用安装器…')
      execFileSync(process.execPath, [join(source, 'scripts', 'install-desktop.mjs'), `--home=${home}`, `--profile=${profile}`, '--no-auth-repair'], { stdio: 'inherit' })
      const after = diagnoseDesktop({ home, profile })
      console.log(after.ok ? '✔ 修复完成' : '✖ 仍有问题，请查看上面的输出')
      process.exitCode = after.ok ? 0 : 1
    } else {
      console.log('提示：加 --fix 可自动重新接线；完整退出 DSH 后再试。')
      process.exitCode = 1
    }
  }

  // 前置插件（QQ 桥、心情、鱼的记忆、B 站、朗读桥）只在缺失时列出。
  if (env.ok) {
    console.log(`✔ 依赖环境就绪：${env.packageList}`)
  } else {
    for (const warning of env.warnings) console.log(`✖ ${warning}`)
    for (const hint of env.hints) console.log(`· ${hint.label}${hint.command ? `：${hint.command}` : ''}`)
    process.exitCode = 1
  }

  if (probeArg) {
    const url = probeArg.slice('--probe='.length)
    try {
      const probe = await probeHost(url)
      console.log(`· host: root=${probe.rootStatus} injected=${probe.injected} settings=${probe.settingsStatus} ready=${probe.settingsReady} market=${probe.marketStatus} links=${probe.marketLinks}`)
      if (!probe.injected || probe.settingsStatus !== 200 || !probe.settingsReady) process.exitCode = 1
    } catch (error) {
      console.log(`✖ 探测 host 失败：${error?.message || error}`)
      process.exitCode = 1
    }
  }
}
