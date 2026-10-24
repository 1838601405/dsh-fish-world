import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEPENDENCIES,
  checkEnvironment,
  createEnvironment,
  detectProfile,
  environmentView,
  resolveDependency,
} from '../lib/env.mjs'

const ALL = DEPENDENCIES.map((item) => item.name)

function fixture({ deps = [], wiring = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fish-world-env-'))
  const profileDir = join(home, 'profiles', 'desktop')
  const modules = join(profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const sourceDir = join(home, 'source')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
    name: 'dsh-fish-world',
    main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  if (wiring) {
    symlinkSync(sourceDir, join(modules, 'dsh-fish-world'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: wiring ? { 'dsh-fish-world': 'link:../source' } : {},
    dsh: { profile: { bundles: wiring ? ['@deepseek-ai/dsh-base', 'dsh-fish-world'] : ['@deepseek-ai/dsh-base'] } },
  }, null, 2), 'utf8')
  installDeps(modules, deps)
  return { home, profileDir, modules, sourceDir }
}

function installDeps(modules, names) {
  for (const name of names) {
    const dir = join(modules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3' }), 'utf8')
  }
}

test('缺少前置插件时逐项提醒，并给出可执行的安装命令', () => {
  const { home, sourceDir } = fixture()
  const env = checkEnvironment({ home, profile: 'desktop', sourceDir })

  assert.equal(env.ok, false)
  // 可选依赖（tts / douyin）与内置依赖（sharp）不计入缺失
  assert.deepEqual(env.missing, ALL.filter((name) => {
    const dep = DEPENDENCIES.find((item) => item.name === name)
    return !dep.optional && !dep.core
  }))
  assert.ok(env.warnings.some((line) => line.includes('未安装依赖') && line.includes('dsh-qq-bridge')))
  for (const name of ALL) {
    const dep = DEPENDENCIES.find((item) => item.name === name)
    if (dep.optional || dep.core) continue
    assert.ok(
      env.hints.some((hint) => hint.command === `dsh plugin --profile desktop add ${dep.spec}`),
      `应给出 ${name} 的安装命令`,
    )
  }
  assert.equal(env.fixCommand, 'dsh plugin --profile desktop add github:Yuuyuko-uu/dsh-qq-bridge')
  assert.match(env.summary, /环境检查发现 1 类问题/)
})

test('前置插件装齐后不再提醒', () => {
  const { home, modules, sourceDir } = fixture({ deps: ALL })
  const env = checkEnvironment({ home, profile: 'desktop', sourceDir })

  assert.deepEqual(env.missing, [])
  assert.equal(env.ok, true, env.warnings.join('\n'))
  assert.deepEqual(env.warnings, [])
  assert.deepEqual(env.hints, [])
  assert.match(env.summary, /运行环境正常/)
  assert.ok(env.packages.every((item) => item.found && item.version === '1.2.3'))
  assert.equal(env.fixCommand, '')
  // 已安装的包能被 resolveDependency 找到（面板与工具共用同一份判断）。
  assert.equal(resolveDependency('dsh-fish-memory', { home, profile: 'desktop' }).found, true)
})

test('接线异常会提醒，但不再把已安装的依赖当成缺失', () => {
  const { home, sourceDir } = fixture({ deps: ALL, wiring: false })
  const env = checkEnvironment({ home, profile: 'desktop', sourceDir })

  assert.equal(env.ok, false)
  assert.deepEqual(env.missing, [])
  assert.ok(env.warnings.some((line) => line.includes('插件接线异常')))
  assert.ok(env.hints.some((hint) => hint.command === 'npm run doctor --fix'))
  assert.equal(env.fixCommand, 'npm run doctor --fix')
})

test('脱敏视图不含本机路径，但保留可执行的修复命令', () => {
  const { home, sourceDir } = fixture({ deps: ['dsh-fish-memory'], wiring: false })
  const env = checkEnvironment({ home, profile: 'desktop', sourceDir })
  const view = environmentView(env)
  const text = JSON.stringify(view)

  assert.equal(view.ok, false)
  assert.equal(text.includes(home.replace(/\\/g, '\\\\')), false, '不应包含 DSH_HOME 绝对路径')
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/, '不应包含本机盘符路径')
  assert.ok(view.missing.includes('dsh-qq-bridge'))
  assert.ok(view.hints.some((hint) => hint.command === 'npm run doctor --fix'))
  assert.equal(environmentView(null), null)
})

test('缓存 60 秒；装好依赖后重新检查才更新，并且警告集合变化才写日志', () => {
  const { home, modules, sourceDir } = fixture()
  const logs = { warn: [], info: [] }
  const environment = createEnvironment({
    home,
    profile: 'desktop',
    sourceDir,
    logger: { warn: (line) => logs.warn.push(line), info: (line) => logs.info.push(line) },
  })

  const first = environment.status()
  assert.equal(first.ok, false)
  const warnCount = logs.warn.length
  assert.ok(warnCount > 0, '首次检查应写警告')
  environment.status()
  assert.equal(logs.warn.length, warnCount, '缓存期内不重复写日志')

  installDeps(modules, ALL)
  assert.equal(environment.status().ok, false, '缓存期内仍返回旧结果')
  const refreshed = environment.status({ refresh: true })
  assert.equal(refreshed.ok, true, refreshed.warnings.join('\n'))
  assert.ok(logs.info.some((line) => line.includes('运行环境正常')), '修好后应写一次正常日志')

  const after = environment.status()
  assert.equal(after.ok, true)
  assert.equal(logs.info.filter((line) => line.includes('运行环境正常')).length, 1, '状态没变就不再写日志')
})

test('detectProfile 优先选择真正声明了本插件的 profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-world-profile-'))
  for (const [name, bundles] of [['desktop', ['@deepseek-ai/dsh-base']], ['web', ['@deepseek-ai/dsh-base', 'dsh-fish-world']]]) {
    const dir = join(home, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }), 'utf8')
  }
  assert.equal(detectProfile(home), 'web')
  assert.equal(detectProfile(home, 'headless'), 'headless')
})
