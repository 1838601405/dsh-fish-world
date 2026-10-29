// 打包元数据的回归测试。
//
// 背景：DSH 用 pnpm 安装插件时开着 blockExoticSubdeps，
// 一旦本包的 dependencies 里出现 github: / git+ / file: 这类"异源"依赖，
// 安装者会直接收到 ERR_PNPM_EXOTIC_SUBDEP，插件根本装不上。
// 配套插件因此放在 peerDependencies（且标记 optional），由安装器装到 profile 顶层。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const EXOTIC = /^(github|gitlab|bitbucket|git\+|https?|file|link|portal|workspace):/i

test('dependencies 里不能有异源依赖（会让 pnpm 装不上）', () => {
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    assert.equal(EXOTIC.test(String(spec)), false,
      `${name} = ${spec} 是异源依赖，DSH 的 blockExoticSubdeps 会拒绝安装`)
  }
})

test('所有依赖都是合法的 semver 范围', () => {
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    assert.match(String(spec), /^[\^~]?\d+\.\d+\.\d+/, `${name} = ${spec} 不是 semver 范围`)
  }
})

test('配套插件声明在 optional peerDependencies 里', () => {
  const companions = ['dsh-qq-bridge', 'dsh-feiyu-mood', 'dsh-fish-memory', 'dsh-bili-subagent', 'dsh-tts-bridge', 'dsh-wechat-plugin']
  for (const name of companions) {
    assert.ok(pkg.peerDependencies?.[name], `${name} 应该在 peerDependencies 里声明`)
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true,
      `${name} 必须标记 optional，否则 pnpm 会尝试自动安装并再次触发异源错误`)
    assert.equal(pkg.dependencies?.[name], undefined,
      `${name} 不能同时出现在 dependencies 里`)
  }
})

test('运行时真正要装的包仍留在 dependencies', () => {
  assert.ok(pkg.dependencies?.sharp, 'sharp 是 npm 包，应该留在 dependencies 由包管理器直接装')
})

test('files 清单覆盖对外发布的目录', () => {
  for (const dir of ['lib', 'ui']) {
    assert.ok(pkg.files.includes(dir), `files 缺少 ${dir}`)
  }
  assert.ok(pkg.files.includes('LICENSE'))
})

test('不把 whale-widget 变成强依赖', () => {
  assert.equal(pkg.dependencies?.['dsh-whale-widget'], undefined,
    'dsh-whale-widget 应该是可选集成，不能加入 dependencies')
})
