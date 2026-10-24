import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PLATFORMS, createPlatforms, normalizePlatform, platformAvailability } from '../lib/platforms.mjs'

test('all outbound actions default to off on every platform', () => {
  for (const id of ['bili', 'douyin']) {
    const cfg = normalizePlatform(id, null)
    for (const key of ['allowComment', 'allowFavorite', 'allowLike', 'allowShare', 'allowGreeting', 'allowReply']) {
      if (key in cfg) assert.equal(cfg[key], false, `${id}.${key} 必须默认关闭`)
    }
  }
  // 抖音整体默认关闭
  assert.equal(normalizePlatform('douyin', null).enabled, false)
  assert.equal(normalizePlatform('douyin', null).autoStart, false)
})

test('platform config only accepts whitelisted fields and clamps numbers', () => {
  const cfg = normalizePlatform('douyin', {
    minutesPerRound: 9999,
    dailyRounds: -5,
    dailyShareLimit: 1000,
    allowShare: true,
    // 不在白名单里，必须被丢弃
    password: 'secret',
    cookie: 'x',
  })
  assert.equal(cfg.minutesPerRound, 120, '单轮时长上限 120 分钟')
  assert.equal(cfg.dailyRounds, 0, '轮次下限 0')
  assert.equal(cfg.dailyShareLimit, 50, '分享上限 50')
  assert.equal(cfg.allowShare, true, '显式开启应保留')
  assert.equal('password' in cfg, false, '非白名单字段不得保存')
  assert.equal('cookie' in cfg, false)
})

test('disabling douyin clears autoStart so it cannot look enabled', () => {
  const cfg = normalizePlatform('douyin', { enabled: false, autoStart: true })
  assert.equal(cfg.autoStart, false)
})

test('unknown platform ids are rejected', () => {
  assert.throws(() => normalizePlatform('weibo', {}), /未知平台/)
})

test('availability reports missing plugins without claiming they work', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-plat-'))
  const availability = platformAvailability({ home, profile: 'desktop' })
  for (const id of Object.keys(PLATFORMS)) {
    assert.equal(availability[id].installed, false, `空 home 下 ${id} 插件应为未安装`)
  }
  assert.equal(availability.douyin.plugin, 'dsh-douyin-browser-local')
})

test('gate blocks writes when plugin missing or switch off', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-plat-gate-'))
  let current = {
    qq: { enabled: true, readHistory: true, sendMessage: true, qzoneEnabled: true },
    bili: { enabled: true, watchEnabled: true, allowComment: false },
    douyin: { enabled: false, watchEnabled: true, allowShare: false },
  }
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = { ...current, ...patch.platforms }; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  // 插件都没装：任何动作都应被拒绝，而不是静默失败
  const missing = platforms.gate('qq', 'send')
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /还没安装/)

  const douyin = platforms.gate('douyin', 'share')
  assert.equal(douyin.ok, false)
})

test('gate allows only the switches the owner explicitly enabled', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-plat-gate2-'))
  let current = {
    bili: { enabled: true, watchEnabled: true, allowComment: true, allowLike: false },
  }
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = { ...current, ...patch.platforms }; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  // 插件未安装时仍应拒绝（这是真实的"不可用"而不是配置问题）
  assert.equal(platforms.gate('bili', 'comment').ok, false)

  // update 只写白名单字段
  const saved = platforms.update('bili', { allowLike: true })
  assert.equal(saved.platform.allowLike, true)
  assert.equal(saved.platform.allowComment, true, '未提及的开关保持原值')
})
