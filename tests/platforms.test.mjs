import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    // 字段数组的收尾固定是「四个空格 + ]」；select 的 options 也有 ]，不能拿它当收尾。
    const fields = block.match(new RegExp(`\\n\\s*${id}: \\[([\\s\\S]*?)\\n    \\],`))
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

test('defaults 里的每个布尔字段都能真的写进去（漏出白名单就是假设置）', () => {
  // AGENTS §6.4 的第三处同步：defaults 有了、面板控件有了，但没进 BOOLEAN_KEYS，
  // 归一化会把它按数值分支处理、直接退回默认值 —— 存了也不生效，改起来还看不出来。
  for (const id of Object.keys(PLATFORMS)) {
    for (const [key, fallback] of Object.entries(PLATFORMS[id].defaults)) {
      if (typeof fallback !== 'boolean') continue
      const want = !fallback
      const patch = { [key]: want }
      // 抖音整体关闭时 autoStart 会被强制清零，那是有意的联动，不是漏白名单。
      if (id === 'douyin' && key === 'autoStart') patch.enabled = true
      const got = normalizePlatform(id, patch)[key]
      assert.equal(got, want, `${id}.${key} 设成 ${want} 却被归一化回 ${got}：把它加进 BOOLEAN_KEYS`)
    }
  }
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
  // B 站外发只剩「分享」：默认沿用 bili-whale 自己的 share.enabled（开），
  // 但整个平台默认关着、闸门会先拦一道。这是与上游对齐的结果，不是漏配。
  const bili = normalizePlatform('bili', null)
  assert.equal(bili.enabled, false, 'B 站整体默认关闭')
  assert.equal(bili.shareEnabled, true, '分享的默认值与 bili-whale 一致（开）')
})

// 语义变更（2026-10-27）：主人要求「收到聊天记录卡片就把卡片里全部内容摊开」是默认行为；
// 已经显式关掉的配置仍然听主人的（不偷偷打开）。
test('展开合并转发默认开，显式 false 仍然保留', () => {
  assert.equal(normalizePlatform('qq', null).forwardExpand, true)
  assert.equal(normalizePlatform('qq', {}).forwardExpand, true)
  assert.equal(normalizePlatform('qq', { forwardExpand: false }).forwardExpand, false)
})

test('platform config only accepts whitelisted fields and clamps numbers', () => {
  const cfg = normalizePlatform('douyin', {
    sessionMinutes: 9999,
    shareDailyLimit: 1000,
    commentDailyLimit: 0,
    allowShare: true,
    // 不在白名单里，必须被丢弃
    password: 'secret',
    cookie: 'x',
  })
  assert.equal(cfg.sessionMinutes, 1440, '单轮时长上限 1440 分钟（0 = 不限）')
  assert.equal(cfg.shareDailyLimit, 20, '分享上限 20，与上游一致')
  assert.equal(cfg.commentDailyLimit, 1, '评论每日下限 1，与上游一致')
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

// B 站真源切换（主人 2026-10-29）：主插件是 dsh-bili-whale，dsh-bili-subagent 降为可选。
// 复用微信那套「任一装上即就位」的 availability 逻辑：只装了 subagent 也要算就位，
// 但主插件名始终报真源，版本按 plugins 数组的优先级取（whale 在前）。
test('B 站：bili-whale 优先，只装了 bili-subagent 也算就位', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-plat-bili-'))
  const modules = join(home, 'profiles', 'desktop', 'node_modules')
  const write = (name, version) => {
    const dir = join(modules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  }

  write('dsh-bili-subagent', '0.8.1')
  const onlySub = platformAvailability({ home, profile: 'desktop' }).bili
  assert.equal(onlySub.installed, true, 'bili-whale 没装但 bili-subagent 装了，也算就位')
  assert.equal(onlySub.plugin, 'dsh-bili-whale', '主插件名始终报真源，排错时按它找')
  assert.equal(onlySub.version, '0.8.1', '只有 subagent 时版本取它')
  assert.deepEqual(
    (onlySub.channels || []).map((item) => item.name),
    ['dsh-bili-whale', 'dsh-bili-subagent'],
    '两条通道按优先级展开明细',
  )

  write('dsh-bili-whale', '1.2.0')
  const both = platformAvailability({ home, profile: 'desktop' }).bili
  assert.equal(both.installed, true)
  assert.equal(both.version, '1.2.0', '两个都装了，bili-whale 优先，版本取它')
})

// 微信没有自己的协议实现：收发、扫码、绑定、人格与行为都在 dsh-wechat-plugin 那边，
// 鱼世界只读展示状态，并保留自己的读 / 发闸门。
test('微信：认 dsh-wechat-plugin，闸门按 readMessages / sendMessage 分别拦', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-plat-wechat-'))
  const plugin = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-wechat-plugin')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-wechat-plugin', version: '0.47.0' }))

  const availability = platformAvailability({ home, profile: 'desktop' })
  assert.equal(availability.wechat.installed, true, '装了 dsh-wechat-plugin 就算微信可用')
  assert.equal(availability.wechat.version, '0.47.0')
  assert.equal(availability.wechat.plugin, 'dsh-wechat-plugin', '主插件名就是 dsh-wechat-plugin')
  assert.deepEqual(availability.wechat.channels.map((item) => item.name), ['dsh-wechat-plugin'])
  assert.equal(Object.hasOwn(availability.qq, 'channels'), false, '没有 plugins 数组的平台返回形状不变')

  const cfg = normalizePlatform('wechat', null)
  for (const key of ['enabled', 'readMessages', 'sendMessage', 'allowGroup']) {
    assert.equal(cfg[key], false, `wechat.${key} 必须默认关闭`)
  }
  assert.equal(cfg.dailyMessages, 200)
  assert.equal(cfg.pollSeconds, 5)
  assert.equal(Object.hasOwn(cfg, 'agentPort'), false, '通道端口由插件自己管，不再存进鱼世界配置')
  assert.equal(Object.hasOwn(cfg, 'configPath'), false, '不再让主人手填外部配置文件路径')
  assert.equal(normalizePlatform('wechat', { dailyMessages: 99999 }).dailyMessages, 3000, '额度仍夹在 0-3000')

  let current = {}
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = { ...current, ...patch.platforms }; return { platforms: current } },
  }
  const snapshot = {
    ok: true,
    installed: true,
    version: '0.47.0',
    origin: 'http://127.0.0.1:3000',
    route: '/.dsh-wechat-plugin/status',
    reachable: true,
    enabled: true,
    connected: true,
    accounts: [{ name: '预览小号', id: '10000001', connected: true }],
    lastError: '',
    note: 'dsh-wechat-plugin 已就位',
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop', wechatPlugin: { status: async () => snapshot } })
  assert.equal(platforms.gate('wechat', 'send').ok, false, '总开关默认关闭时拒发')
  platforms.update('wechat', { enabled: true, sendMessage: true })
  assert.equal(platforms.gate('wechat', 'send').ok, true)
  assert.equal(platforms.gate('wechat', 'read').ok, false, 'send 开着不等于 read 开着（读的是 readMessages）')

  const before = platforms.status().platforms.find((item) => item.id === 'wechat').account
  assert.equal(before.reachable, null, '还没探过状态接口时如实说「还没检查」，不猜成可达')
  assert.deepEqual(before.accounts, [], '还没探过就不编账号')

  await platforms.refresh()
  const account = platforms.status().platforms.find((item) => item.id === 'wechat').account
  assert.equal(account.installed, true)
  assert.equal(account.reachable, true)
  assert.equal(account.enabled, true)
  assert.equal(account.connected, true)
  assert.equal(account.accounts.length, 1)
  assert.equal(account.accounts[0].name, '预览小号')
  assert.equal(account.route, '/.dsh-wechat-plugin/status')
  assert.equal(account.origin, 'http://127.0.0.1:3000')
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
    bili: { enabled: true, watchEnabled: true, shareEnabled: true },
  }
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = { ...current, ...patch.platforms }; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  // 插件未安装时仍应拒绝（这是真实的"不可用"而不是配置问题）
  assert.equal(platforms.gate('bili', 'comment').ok, false)

  // update 只写白名单字段；没提到的开关保持原值
  const saved = platforms.update('bili', { shareDaily: 5 })
  assert.equal(saved.platform.shareDaily, 5)
  assert.equal(saved.platform.shareEnabled, true, '未提及的开关保持原值')
  // 改动同时落到 bili-whale 的配置里（quota.shareDaily），不是只存本地
  assert.equal(JSON.parse(readFileSync(join(home, 'bili-whale.config.json'), 'utf8')).quota.shareDaily, 5)
})

// 主人 2026-10-29：B 站只保留 bili-whale。面板的「评论 / 分享」外发闸门看它自己的
// share.enabled（字段名 shareEnabled）；以前的 allowComment 属于已停用的 bili-subagent，
// 那个键不存在之后闸门会永远报「没有开启」，看起来像配置问题。
test('B 站外发闸门：comment / share 都看 shareEnabled', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-plat-gate-bili-'))
  const modules = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-bili-whale')
  mkdirSync(modules, { recursive: true })
  writeFileSync(join(modules, 'package.json'), JSON.stringify({ name: 'dsh-bili-whale', version: '0.4.6' }))
  let current = { bili: { enabled: true, shareEnabled: true } }
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = { ...current, ...patch.platforms }; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })
  assert.equal(platforms.gate('bili', 'comment').ok, true)
  assert.equal(platforms.gate('bili', 'share').ok, true)
  platforms.update('bili', { shareEnabled: false })
  assert.equal(platforms.gate('bili', 'comment').ok, false, '关掉分享后评论也不该放行')
})

// B 站字段的枚举口径与 bili-whale 自己的设置页一致。
test('B 站枚举：listenScope 与 shareVia 只收上游认得的值', () => {
  assert.equal(normalizePlatform('bili', { listenScope: 'reply' }).listenScope, 'reply')
  assert.equal(normalizePlatform('bili', { listenScope: 'both' }).listenScope, 'both')
  assert.equal(normalizePlatform('bili', { listenScope: '乱填' }).listenScope, 'both', '不认识的值退回默认')
  assert.equal(normalizePlatform('bili', { shareVia: 'dm' }).shareVia, 'dm')
  assert.equal(normalizePlatform('bili', { shareVia: 'none' }).shareVia, 'comment')
  assert.equal(normalizePlatform('bili', {}).listenScope, 'both')
  assert.equal(normalizePlatform('bili', {}).shareVia, 'comment')
})

// 主人 2026-10-29：面板不再另存一份镜像，读写都走 bili-whale 自己的配置。
test('B 站配置统一到 bili-whale：读它的嵌套配置，缺的键用默认值', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bili-home-'))
  const file = join(home, 'bili-whale.config.json')
  writeFileSync(file, JSON.stringify({
    listen: { comment: true, commentIntervalSec: 120, scope: 'reply', dm: false },
    share: { enabled: false, via: 'dm', minScore: 30 },
    risk: { readDaily: 500 },
    self: { mid: '10000001', name: '测试鱼' },
    preferences: { like: ['猫'] },
  }))

  let current = normalizeAllPlatforms({})
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = patch.platforms; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  const cfg = platforms.platform('bili')
  assert.equal(cfg.listenComment, true, '读 listen.comment')
  assert.equal(cfg.listenCommentIntervalSec, 120, '读 listen.commentIntervalSec')
  assert.equal(cfg.listenScope, 'reply')
  assert.equal(cfg.listenDm, false)
  assert.equal(cfg.shareEnabled, false, '读 share.enabled')
  assert.equal(cfg.shareVia, 'dm')
  assert.equal(cfg.shareMinScore, 30)
  assert.equal(cfg.riskReadDaily, 500, '读 risk.readDaily')
  assert.equal(cfg.listenAllDay, false, '文件里没有的项用默认值，不报错')
  assert.equal(cfg.personaOwnerTitle, '你')
})

test('B 站：面板改动写回嵌套配置，只动 patch 里的键，未知键原样保留', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bili-write-'))
  const file = join(home, 'bili-whale.config.json')
  writeFileSync(file, JSON.stringify({
    listen: { comment: true, scope: 'reply' },
    share: { enabled: true, via: 'comment' },
    risk: { readDaily: 500 },
    persona: { name: '旧名字', diaryTitle: '今日摘要' },
    preferences: { like: ['猫'] },
    keep: { unknown: 'me' },
  }))

  let current = normalizeAllPlatforms({})
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = patch.platforms; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  platforms.update('bili', {
    listenCommentIntervalSec: 99999,
    riskWriteDaily: 999,
    nightSkipChance: 0.45,
    personaName: '鲸',
    ownerMid: '10000002',
    ownerName: '  ',
  })

  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.listen.commentIntervalSec, 3600, '超出上限夹回 3600')
  assert.equal(raw.listen.scope, 'reply', '没改的键原样保留（不是整块覆盖）')
  assert.equal(raw.listen.comment, true, '同层的其它键也保留')
  assert.equal(raw.share.enabled, true, 'patch 里没有的分组不动')
  assert.equal(raw.risk.readDaily, 500, '同分组里没写的键保留')
  assert.equal(raw.risk.writeDaily, 300, '超出上限夹回 300')
  assert.equal(raw.night.skipChance, 0.45, '概率必须保留小数，不能被四舍五入成 0')
  assert.equal(raw.persona.name, '鲸')
  assert.equal(raw.persona.diaryTitle, '今日摘要', '人设里其它键保留')
  assert.deepEqual(raw.preferences, { like: ['猫'] }, '不归我们管的键一字不动')
  assert.deepEqual(raw.keep, { unknown: 'me' })
  assert.equal(raw.owner.mid, '10000002', 'UID 存成字符串，避免大数精度问题')
  assert.equal('name' in raw.owner, false, '文本留空 = 删掉这一键，让 bili-whale 用自己的默认')

  const read = platforms.platform('bili')
  assert.equal(read.listenCommentIntervalSec, 3600)
  assert.equal(read.nightSkipChance, 0.45)
  assert.equal(read.personaName, '鲸')
  assert.equal(read.ownerName, '')
})

// 没有配置文件时：读只报默认值，一个字都不写；真的改了才创建。
test('B 站：没有 bili-whale 配置文件时读不报错也不创建，改了才写最小结构', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bili-missing-'))
  const file = join(home, 'bili-whale.config.json')
  let current = normalizeAllPlatforms({})
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = patch.platforms; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  const cfg = platforms.platform('bili')
  assert.equal(cfg.listenDm, true, '没有文件就显示默认值')
  assert.equal(existsSync(file), false, '只读不该创建文件')

  platforms.update('bili', { listenDm: false })
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')),
    { listen: { dm: false } },
    '第一次写只落这一条路径，不铺一整套默认值',
  )
})

test('B 站：配置解析失败时拒绝写入，不覆盖插件自己的文件', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bili-broken-'))
  const file = join(home, 'bili-whale.config.json')
  writeFileSync(file, '{ 写到一半')
  let current = normalizeAllPlatforms({})
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = patch.platforms; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })
  assert.throws(() => platforms.update('bili', { shareDaily: 5 }), /解析失败/)
  assert.equal(readFileSync(file, 'utf8'), '{ 写到一半', '坏文件原样留着，等人来修')
  assert.equal(current.bili.shareDaily, 3, '插件没写成，本地也不该记成 5')
})

// B 站账号：bili-whale 登录后会把 mid / 昵称写进配置的 self，鱼世界只读显示。
test('B 站账号：读 self 里的昵称与 mid；没有 self 就如实说没登录', () => {
  const withSelf = mkdtempSync(join(tmpdir(), 'fw-bili-acc-'))
  writeFileSync(join(withSelf, 'bili-whale.config.json'), JSON.stringify({
    self: { mid: '10000001', name: '测试鱼' },
  }))
  const configStore = {
    getConfig: () => ({ platforms: normalizeAllPlatforms({}) }),
    saveConfig: () => ({ platforms: {} }),
  }
  const got = createPlatforms({ configStore, home: withSelf, profile: 'desktop' })
    .status().platforms.find((item) => item.id === 'bili').account
  assert.equal(got.loggedIn, true)
  assert.deepEqual(got.account, { nickname: '测试鱼', userId: '10000001' })
  assert.equal(got.managed, false, '凭据在插件那边，鱼世界不代持')
  assert.equal(got.source, 'bili-whale')
  assert.deepEqual(got.self, { mid: '10000001', name: '测试鱼' })
  assert.match(got.note, /只读显示账号/)

  const noFile = mkdtempSync(join(tmpdir(), 'fw-bili-noself-'))
  const none = createPlatforms({ configStore, home: noFile, profile: 'desktop' })
    .status().platforms.find((item) => item.id === 'bili').account
  assert.equal(none.loggedIn, false)
  assert.equal(none.account, null)
  assert.match(none.note, /还没登录或还没生成配置/)
})

