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

test('dependencyCheck lists the four platform prerequisites (QQ / B 站 / 抖音 / 微信)', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-doctor-platforms-'))
  const dep = dependencyCheck({ home, profile: 'desktop' })

  assert.equal(dep.platforms.length, 4)
  assert.deepEqual(dep.platforms.map((item) => item.id), ['qq', 'bili', 'douyin', 'wechat'])
  assert.equal(dep.platforms.find((item) => item.id === 'qq').plugin, 'dsh-qq-bridge')
  // B 站真源是 bili-whale（主插件名）；bili-subagent 仍是清单里的一条可选通道。
  assert.equal(dep.platforms.find((item) => item.id === 'bili').plugin, 'dsh-bili-whale')
  assert.equal(dep.platforms.find((item) => item.id === 'bili').optional, false, 'bili-whale 是必需前置，缺了要报缺失')
  assert.ok(dep.packages.some((item) => item.name === 'dsh-bili-subagent' && item.optional === true), 'bili-subagent 已降为可选')
  assert.ok(dep.packages.some((item) => item.name === 'dsh-bili-whale' && item.platform === 'bili'))
  assert.equal(dep.platforms.find((item) => item.id === 'douyin').plugin, 'dsh-douyin-browser-local')
  // 微信只认 dsh-wechat-plugin（可选：没装只是微信不可用）
  assert.equal(dep.platforms.find((item) => item.id === 'wechat').plugin, 'dsh-wechat-plugin')
  assert.ok(dep.packages.some((item) => item.name === 'dsh-wechat-plugin' && item.optional === true))
  assert.equal(dep.counts.platforms.total, 4)
  // 平台前置也出现在依赖清单里，UI 才能按平台分组
  assert.ok(dep.packages.filter((item) => item.platform).length >= 4)
})
