import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { COMPANIONS, PACKAGE, declareDependencies, declaredStatus, installCommandFor } from '../lib/install.mjs'

function profile(pkg = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-install-'))
  const dir = join(home, 'profiles', 'desktop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
    ...pkg,
  }, null, 2), 'utf8')
  return { home, dir }
}

test('declaredStatus lists what is missing without touching disk', () => {
  const { home } = profile()
  const status = declaredStatus({ home, profile: 'desktop' })
  assert.equal(status.ok, true)
  // 必装依赖都应被列为缺失
  const required = COMPANIONS.filter((item) => !item.optional).map((item) => item.name)
  assert.deepEqual(status.missing, required)
  // 可选依赖不进入 missing
  assert.equal(status.missing.includes('dsh-tts-bridge'), false)
  assert.equal(status.missing.includes('dsh-douyin-browser-local'), false)
})

test('declareDependencies adds required deps and the bundle, with a backup', () => {
  const { home, dir } = profile()
  const result = declareDependencies({ home, profile: 'desktop' })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.ok(result.backup, '写入前应留备份')

  const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  for (const item of COMPANIONS.filter((x) => !x.optional)) {
    assert.ok(Object.hasOwn(after.dependencies, item.name), `应声明 ${item.name}`)
  }
  assert.ok(after.dsh.profile.bundles.includes(PACKAGE), '应把插件加进 bundles')

  // 备份内容应是改动前的样子
  const backup = JSON.parse(readFileSync(result.backup, 'utf8'))
  assert.deepEqual(backup.dependencies, {})
  assert.deepEqual(backup.dsh.profile.bundles, [])
})

test('declareDependencies never overwrites a version the user already chose', () => {
  const { home, dir } = profile({
    dependencies: { 'dsh-mnemon': '^9.9.9', sharp: '^0.34.0' },
  })
  declareDependencies({ home, profile: 'desktop' })
  const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(after.dependencies['dsh-mnemon'], '^9.9.9', '用户已有的版本必须保留')
  assert.equal(after.dependencies.sharp, '^0.34.0')
})

test('optional deps are only declared when explicitly requested', () => {
  const { home, dir } = profile()
  declareDependencies({ home, profile: 'desktop' })
  let after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(after.dependencies, 'dsh-tts-bridge'), false, '默认不装可选依赖')

  const { home: home2, dir: dir2 } = profile()
  declareDependencies({ home: home2, profile: 'desktop', includeOptional: true })
  after = JSON.parse(readFileSync(join(dir2, 'package.json'), 'utf8'))
  assert.ok(Object.hasOwn(after.dependencies, 'dsh-tts-bridge'), '显式要求时装可选依赖')
})

test('declareDependencies is idempotent', () => {
  const { home, dir } = profile()
  declareDependencies({ home, profile: 'desktop' })
  const first = readFileSync(join(dir, 'package.json'), 'utf8')

  const second = declareDependencies({ home, profile: 'desktop' })
  assert.equal(second.changed, false, '第二次不应再改文件')
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), first)
})

test('installCommandFor prefers pnpm inside a profile directory', () => {
  const { home } = profile()
  const plan = installCommandFor({ home, profile: 'desktop' })
  // pnpm 可能解析成 node + pnpm.cjs 的形式，所以只校验参数尾部
  assert.ok(/pnpm/.test(plan.cmd) || plan.args.some((a) => /pnpm/.test(a)), '应调用 pnpm')
  assert.equal(plan.args[plan.args.length - 1], 'install')
  // pnpm 不接受 --prod=false，这个错误曾经真实发生过
  assert.equal(plan.args.includes('--prod=false'), false)
  assert.match(plan.cwd, /profiles[\\/]desktop$/)
})

test('declaredStatus reports a readable error for a missing profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-install-missing-'))
  const status = declaredStatus({ home, profile: 'nope' })
  assert.equal(status.ok, false)
  assert.match(status.error, /找不到 profile/)
})
