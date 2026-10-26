import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PLATFORMS, createPlatforms, normalizeAllPlatforms, normalizePlatform, platformAvailability } from '../lib/platforms.mjs'

// 面板控件与后端白名单必须同步（AGENTS.md 第 6.2 节）。
// 真实教训：面板上放了一个「空间每日上限」写 dailyQzonePosts，但 defaults 里没有这一项，
// 归一化会直接丢掉它 —— 控件能点、能保存、刷新后回到默认值，等于一个假的设置。
// ui/panel.js 是浏览器文件不能在 Node 里 import，所以按文本解析它的 PLATFORM_FIELDS。
test('面板上每个平台控件的字段，后端 defaults 都必须认得', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  const block = source.slice(source.indexOf('var PLATFORM_FIELDS'))
  assert.ok(block.length > 100, '没找到 PLATFORM_FIELDS，解析规则该跟着改了')
  let checked = 0
  for (const id of Object.keys(PLATFORMS)) {
    const fields = block.match(new RegExp(`\\n\\s*${id}: \\[([\\s\\S]*?)\\],`))
    if (!fields) continue
    const keys = [...fields[1].matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])
    assert.ok(keys.length > 0, `${id} 一个控件都没解析到，解析规则该跟着改了`)
    for (const key of keys) {
      assert.ok(
        Object.hasOwn(PLATFORMS[id].defaults, key),
        `面板上「${id}」的控件写的是 ${key}，但 PLATFORMS.${id}.defaults 没有这一项：`
        + '归一化会丢掉它，这个控件改了也不生效（假设置）。要么补进 defaults + 范围表，要么把控件删掉。',
      )
      checked += 1
    }
  }
  assert.ok(checked >= 20, `只校验到 ${checked} 个字段，解析可能失效了`)
})

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

// 「群里怎么开口」从三档改成五档（2026-10-26）：旧值必须被迁移，不能静默打回默认，
// 否则升级一次就把主人原来选的「跟她有关才回」改成别的档。
test('群里怎么开口：五档都收，旧三档迁移，乱填才回默认', () => {
  for (const mode of ['shy', 'quiet', 'normal', 'active', 'frenzy']) {
    assert.equal(normalizePlatform('qq', { groupReplyMode: mode }).groupReplyMode, mode)
  }
  assert.equal(normalizePlatform('qq', { groupReplyMode: 'mention' }).groupReplyMode, 'shy')
  assert.equal(normalizePlatform('qq', { groupReplyMode: 'always' }).groupReplyMode, 'normal')
  assert.equal(normalizePlatform('qq', { groupReplyMode: 'never' }).groupReplyMode, 'shy')
  assert.equal(normalizePlatform('qq', { groupReplyMode: '乱填' }).groupReplyMode, 'active', '默认活跃')
  assert.equal(normalizePlatform('qq', null).groupReplyMode, 'active')
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

// 主人 2026-10-26 要的三选一：每天自己去看 / 主人叫了才去 / 自己想起就去。
test('B 站观看模式三选一：合法值保留，别的退回默认', () => {
  assert.equal(normalizePlatform('bili', { watchMode: 'daily' }).watchMode, 'daily')
  assert.equal(normalizePlatform('bili', { watchMode: 'on-request' }).watchMode, 'on-request')
  assert.equal(normalizePlatform('bili', { watchMode: 'self' }).watchMode, 'self')
  assert.equal(normalizePlatform('bili', { watchMode: '随时' }).watchMode, 'daily', '不认识的值退回默认')
  assert.equal(normalizePlatform('bili', {}).watchMode, 'daily')
})

// 主人 2026-10-26：「统一一下呗，毕竟 world 插件内置了这个插件」——
// B 站能力的真源是 bili-subagent 自己的 config.json，面板读写它就对了。
test('B 站配置统一：读插件的 config.json，改面板也写回它', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bili-home-'))
  mkdirSync(join(home, 'bili-duty'), { recursive: true })
  const file = join(home, 'bili-duty', 'config.json')
  writeFileSync(file, JSON.stringify({ perDay: 2, autoMode: 'manual', autoComment: false }))

  let current = normalizeAllPlatforms({})
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = patch.platforms; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  assert.equal(platforms.platform('bili').dailyWatchLimit, 2, '读的是插件的 perDay')
  assert.equal(platforms.platform('bili').allowComment, false)

  platforms.update('bili', { watchMode: 'daily', dailyWatchLimit: 4, allowComment: true })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.autoMode, 'valley', '「每天自己去看」= 插件的谷时自动')
  assert.equal(raw.perDay, 4)
  assert.equal(raw.autoComment, true)

  platforms.update('bili', { watchMode: 'on-request' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).autoMode, 'manual', '叫了才去 = 插件不自动')
})
