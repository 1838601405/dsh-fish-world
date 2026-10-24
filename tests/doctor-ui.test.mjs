import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compareVersions, dependencyCheck, registryTarget } from '../lib/doctor.mjs'

test('compareVersions handles prefixes and patch bumps', () => {
  assert.equal(compareVersions('1.7.1', '1.6.0'), 1)
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.4.3', '0.4.6'), -1)
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
  assert.equal(compareVersions('', '1.0.0'), -1)
})

test('registryTarget picks GitHub for github: specs and npm otherwise', () => {
  const gh = registryTarget('github:Yuuyuko-uu/dsh-qq-bridge', 'dsh-qq-bridge')
  assert.equal(gh.kind, 'github')
  assert.equal(gh.owner, 'Yuuyuko-uu')
  assert.equal(gh.repo, 'dsh-qq-bridge')
  assert.match(gh.url, /raw\.githubusercontent\.com\/Yuuyuko-uu\/dsh-qq-bridge\/HEAD\/package\.json$/)

  const npm = registryTarget('sharp@^0.35.5', 'sharp')
  assert.equal(npm.kind, 'npm')
  assert.match(npm.url, /registry\.npmjs\.org\/sharp\/latest$/)

  // 裸包名走 npm
  assert.equal(registryTarget('some-npm-package', 'some-npm-package').kind, 'npm')
  // https 形式的 GitHub 地址
  assert.equal(registryTarget('https://github.com/a/b.git', 'x').repo, 'b')
})

test('dependencyCheck is offline and reports counts without network', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-doctor-'))
  const dep = dependencyCheck({ home, profile: 'desktop' })

  assert.equal(dep.kind, 'dependency')
  assert.equal(dep.online, false, '依赖体检不联网')
  assert.equal(typeof dep.counts.total, 'number')
  assert.ok(Array.isArray(dep.packages))
  assert.ok(dep.packages.some((item) => item.name === 'sharp' && item.core === true))
  // 空 home 下依赖都没装，但不应抛错
  assert.ok(dep.counts.missing > 0)
  assert.ok(dep.warnings.length > 0)
  assert.ok(dep.hints.some((hint) => typeof hint.command === 'string'))
})

test('dependencyCheck reports the plugin own version and wiring state', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-doctor-self-'))
  const dep = dependencyCheck({ home, profile: 'desktop' })
  assert.match(dep.self.version, /^\d+\.\d+\.\d+$/, '应读到本插件版本')
  assert.equal(dep.wiring.checked, false, '没有 profiles 目录时接线检查标记为跳过')
})

test('dependencyCheck lists the three platform prerequisites (QQ / B 站 / 抖音)', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-doctor-platforms-'))
  const dep = dependencyCheck({ home, profile: 'desktop' })

  assert.equal(dep.platforms.length, 3)
  assert.deepEqual(dep.platforms.map((item) => item.id), ['qq', 'bili', 'douyin'])
  assert.equal(dep.platforms.find((item) => item.id === 'qq').plugin, 'dsh-qq-bridge')
  assert.equal(dep.platforms.find((item) => item.id === 'bili').plugin, 'dsh-bili-subagent')
  assert.equal(dep.platforms.find((item) => item.id === 'douyin').plugin, 'dsh-douyin-browser-local')
  assert.equal(dep.counts.platforms.total, 3)
  // 平台前置也出现在依赖清单里，UI 才能按平台分组
  assert.ok(dep.packages.filter((item) => item.platform).length >= 3)
})
