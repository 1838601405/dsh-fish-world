// 「所有具体操作都可视化」的后端保证：每一个会留下痕迹的动作都要进审计。
//
// 面板的时间线只读 <根>/安全与审计/<日期>.jsonl。所以这里正面验三件事：
//   1. 世界层能往外补审计行（appendSecurity），没绑工作区时安静跳过；
//   2. 成长记录写成功之后，审计里一定多一行 growth-record；
//   3. 动作翻译表覆盖了本机真实出现过的动作名——新动作加进代码却忘了加翻译，这里会红。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ACTION_LABELS, dayKeyShanghai, describeHome, readActions } from '../lib/actions.mjs'
import { createGrowthStore } from '../lib/growth.mjs'
import { createQQ } from '../lib/qq.mjs'
import { createWorldStore } from '../lib/world.mjs'

function fakeQq(ownerQQ = '10000001', targetSession = 'session-owner-1') {
  return { bridgeConfig: () => ({ 私聊QQ: ownerQQ, 目标会话: targetSession }) }
}

function fakeServices(workspacePath, ownerSession) {
  const registry = { list: () => [{ path: workspacePath, sessionIds: [ownerSession] }] }
  return { registry, sessions: { get: () => null }, agents: { list: () => [], get: () => null } }
}

function auditLines(root) {
  const dir = join(root, '安全与审计')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
}

test('审计补行：没绑工作区时安静跳过，不抛', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-audit-off-'))
  const world = createWorldStore({ home, qq: fakeQq() })
  const result = world.appendSecurity({ action: 'growth-record', recordId: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /还没绑定工作区/)
})

test('审计补行：绑好工作区后真写进当天的 jsonl', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-audit-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-audit-ws-'))
  const world = createWorldStore({ home, qq: fakeQq() })
  world.setServices(fakeServices(workspace, 'session-owner-1'))
  const result = world.appendSecurity({ role: 'owner', action: 'hub-toggle', recordId: 'dsh-pet', tone: 'disabled' })
  assert.equal(result.ok, true)
  const lines = auditLines(world.root())
  const last = lines[lines.length - 1]
  assert.equal(last.action, 'hub-toggle')
  assert.equal(last.role, 'owner')
  assert.equal(last.recordId, 'dsh-pet')
  assert.equal(last.tone, 'disabled')
  assert.ok(last.at, '每条审计都要带时间')
})

test('成长记录：写成功之后审计里一定多一行 growth-record（时间线才看得见）', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-growth-audit-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-growth-ws-'))
  const world = createWorldStore({ home, qq: fakeQq() })
  world.setServices(fakeServices(workspace, 'session-owner-1'))
  // 成长有自己的目录解析；这里给它一个只带 appendSecurity 的存储层，验的是接线本身。
  const growth = createGrowthStore({ home, storage: { appendSecurity: world.appendSecurity } })
  const before = auditLines(world.root()).length
  const entry = growth.record({ text: '发现审计漏了成长这一行', kind: 'insight' })
  assert.equal(entry.ok, true)
  const after = auditLines(world.root())
  assert.equal(after.length, before + 1)
  const last = after[after.length - 1]
  assert.equal(last.action, 'growth-record')
  assert.equal(last.recordId, entry.entry.id)
  assert.equal(last.role, 'fish')
})

test('动作翻译表：代码里会写的动作名都有中文，不漏', () => {
  // 这些是 fish-world 自己会用 appendSecurity / appendJsonLine 写下的动作。
  for (const action of [
    'growth-record', 'hub-toggle', 'wardrobe-merge', 'diary-write', 'diary-suggestion', 'wish-open',
    'wish-approved', 'wish-rejected', 'sticker-collect', 'sticker-remove', 'sticker-update',
    'sticker-organize', 'sticker-organize-all',
    'link-collect', 'link-remove', 'link-update',
    'portrait-set', 'portrait-clear',
    'extension-setting', 'market-install', 'deps-install', 'role-change', 'relation-change',
    'qqagent-setting', 'astrbot-setting', 'knowledge-reindex',
    'record-add', 'record-update', 'record-remove', 'record-explain', 'record-accept',
    'growth-revise', 'growth-retract', 'growth-restore', 'persona-set', 'protocol-launch',
    'sticker-wish-approve', 'sticker-wish-reject', 'memory-digest-toggle',  ]) {
    assert.ok(ACTION_LABELS[action], `审计动作 ${action} 没有中文翻译，面板上会显示原始英文`)
  }
  // 上面那份清单是手抄的，会漂。再从代码里把字面量 action: 'xxx' 全扫出来核一遍：
  // 往 http.mjs 新增一处留痕却忘了翻译，这里会红，不用等面板上看见英文才想起来。
  // 范围是整个 lib/（stickers / links / growth 都有 audit 调用），不只 http.mjs。
  const libDir = join(import.meta.dirname, '..', 'lib')
  const literals = new Set()
  for (const file of readdirSync(libDir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(libDir, file), 'utf8')
    for (const m of src.matchAll(/action: '([a-z][a-z0-9-]*)'/g)) literals.add(m[1])
    for (const m of src.matchAll(/audit\('([a-z][a-z0-9-]*)'/g)) literals.add(m[1])
  }
  assert.ok(literals.size >= 20, `扫描没抓到 action 字面量，正则可能坏了（抓到 ${literals.size} 个）`)
  for (const action of literals) {
    assert.ok(ACTION_LABELS[action], `${action} 没有中文翻译`)
  }
})

test('接线：收藏、网站、成长、开关四条路都把 storage.appendSecurity 接上了', () => {
  const root = join(import.meta.dirname, '..', 'lib')
  const stickers = readFileSync(join(root, 'stickers.mjs'), 'utf8')
  const links = readFileSync(join(root, 'links.mjs'), 'utf8')
  const growth = readFileSync(join(root, 'growth.mjs'), 'utf8')
  const http = readFileSync(join(root, 'http.mjs'), 'utf8')
  assert.match(stickers, /audit\('sticker-collect', id\)/)
  assert.match(stickers, /audit\('sticker-remove', String\(id\)\)/)
  assert.match(links, /audit\('link-collect', item\.id\)/)
  assert.match(links, /audit\('link-remove', String\(id\)\)/)
  assert.match(growth, /storage\?\.appendSecurity\?\.\(\{ role: 'fish', action: 'growth-record'/)
  assert.match(http, /world\.appendSecurity\?\.\(\{/)

  // 面板上那几条改记录的路（改表情名/标签、改网站、换/删情绪图、视觉整理）也要上时间线。
  for (const action of ['sticker-update', 'link-update', 'portrait-set', 'portrait-clear', 'sticker-organize', 'sticker-organize-all']) {
    assert.ok(
      new RegExp(`action: '${action}'`).test(http),
      `${action} 没接 appendSecurity：面板上动过、时间线里看不见`,
    )
  }

  // 改设置/装东西的路也一样：谁在面板上动了扩展、角色卡、关系表、借手通道、依赖，得查得到。
  // 值一律不抄（常有 token），只记 id / 键名 / 数量。
  for (const action of ['extension-setting', 'market-install', 'deps-install', 'role-change', 'relation-change', 'qqagent-setting', 'astrbot-setting', 'knowledge-reindex']) {
    assert.ok(
      new RegExp(`action: '${action}'`).test(http),
      `${action} 没接 appendSecurity：面板上动过、时间线里看不见`,
    )
  }
  // 时间线认得出小本本那句话：记录.jsonl 是固定文件名（不按天分），单独走一遍。
  {
    const root = mkdtempSync(join(tmpdir(), 'fw-actions-'))
    const day = new Date().toISOString().slice(0, 10)
    const sec = join(root, '安全与审计')
    const rec = join(root, '鱼的记录')
    mkdirSync(sec, { recursive: true })
    mkdirSync(rec, { recursive: true })
    writeFileSync(join(sec, `${day}.jsonl`), [
      JSON.stringify({ at: `${day}T09:00:00.000Z`, role: 'owner', action: 'record-add', recordId: 'm1' }),
      JSON.stringify({ at: `${day}T09:01:00.000Z`, role: 'owner', action: 'record-explain', recordId: 'g1' }),
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(rec, '记录.jsonl'), JSON.stringify({ id: 'm1', text: '出门带伞' }) + '\n', 'utf8')
    writeFileSync(join(rec, '小本本.jsonl'), JSON.stringify({ id: 'g1', text: '记仇：谁抢了罐头' }) + '\n', 'utf8')
    const items = readActions({ rootDir: root }).items
    // 按时间倒序：09:01 的解释在前，09:00 的记录在后。
    assert.equal(items[0].label, '解释了一件记着的事')
    assert.equal(items[0].text, '记仇：谁抢了罐头')
    assert.equal(items[1].label, '往小本本记了一条')
    assert.equal(items[1].text, '出门带伞')
    rmSync(root, { recursive: true, force: true })
  }
  // 两条防泄密：视觉整理的 key 和借手通道的地址/token 都不许进 recordId。
  assert.match(http, /recordId: `stickerVision:\$\{Object\.keys\(merged\)\.join\(','\)\}`/)
  assert.ok(!/recordId: (String\()?body\.apiKey/.test(http), 'apiKey 不许进时间线')
  // 小本本那条用的是模板串（record-<action>），单测按这个形状认。
  assert.match(http, /action: `record-\$\{action\}`/)
  // 成长的改/收回/恢复与人设卡保存也要留痕。
  assert.match(http, /action: `growth-\$\{action\}`/)
  assert.match(http, /action: 'persona-set'/)
  // 批/驳表情包愿望（同一行三元）。
  assert.match(http, /action: body\.accept === true \? 'sticker-wish-approve' : 'sticker-wish-reject'/)
})
test('今天的小结：只算今天那天的文件，日期按北京时间', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-today-'))
  const root = join(home, '鱼的世界')
  const dir = join(root, '安全与审计')
  mkdirSync(dir, { recursive: true })
  const today = dayKeyShanghai()
  const yesterday = dayKeyShanghai(new Date(Date.now() - 24 * 60 * 60 * 1000))
  writeFileSync(join(dir, `${today}.jsonl`), [
    JSON.stringify({ at: new Date().toISOString(), role: 'fish', action: 'diary-write', recordId: 'a' }),
    JSON.stringify({ at: new Date().toISOString(), role: 'owner', action: 'hub-toggle', recordId: 'dsh-pet' }),
  ].join('\n'))
  writeFileSync(join(dir, `${yesterday}.jsonl`), JSON.stringify({ at: '2026-10-01T00:00:00.000Z', role: 'fish', action: 'wish-open' }))

  const flow = readActions({ rootDir: root, days: 7 })
  assert.equal(flow.today.day, today)
  assert.equal(flow.today.total, 2, '昨天那条不该算进今天')
  assert.equal(flow.today.byAction['diary-write'], 1)
  assert.equal(flow.today.byAction['wish-open'], undefined)
  const labels = flow.today.labels.map((row) => row.label)
  assert.ok(labels.includes('写了日记'), '要带中文名，面板直接画')
  assert.ok(labels.includes('改了整合包开关'))
})

test('时间线认得出那句话：id 换成正文，找不到就如实空着', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-text-'))
  const root = join(home, '鱼的世界')
  const today = dayKeyShanghai()
  mkdirSync(join(root, '安全与审计'), { recursive: true })
  mkdirSync(join(root, '鱼的日记'), { recursive: true })
  mkdirSync(join(root, '鱼的请求'), { recursive: true })
  mkdirSync(join(root, '鱼的成长'), { recursive: true })
  const audit = []
  // 日记
  writeFileSync(join(root, '鱼的日记', `${today}.jsonl`), JSON.stringify({ id: 'd-1', text: '今天把审计的时间线接上了' }) + '\n')
  audit.push(JSON.stringify({ at: '2026-10-29T00:00:00.000Z', role: 'fish', action: 'diary-write', recordId: 'd-1' }))
  // 请求（正文带换行要压成一行）
  writeFileSync(join(root, '鱼的请求', `${today}.jsonl`), JSON.stringify({ id: 'w-1', text: '想换个\n更大的鱼缸' }) + '\n')
  audit.push(JSON.stringify({ at: '2026-10-29T00:01:00.000Z', role: 'fish', action: 'wish-open', recordId: 'w-1' }))
  // 成长在账本里
  writeFileSync(join(root, '鱼的成长', 'ledger.jsonl'), JSON.stringify({ type: 'entry', id: 'g-1', text: '发现留痕要留话不要留 id' }) + '\n')
  audit.push(JSON.stringify({ at: '2026-10-29T00:02:00.000Z', role: 'fish', action: 'growth-record', recordId: 'g-1' }))
  // 找不到正文的：开关类本来就没正文
  audit.push(JSON.stringify({ at: '2026-10-29T00:03:00.000Z', role: 'owner', action: 'hub-toggle', recordId: 'dsh-pet' }))
  writeFileSync(join(root, '安全与审计', `${today}.jsonl`), audit.join('\n') + '\n')

  const flow = readActions({ rootDir: root, days: 7, limit: 40 })
  const byId = Object.fromEntries(flow.items.map((item) => [item.action, item]))
  assert.equal(byId['diary-write'].text, '今天把审计的时间线接上了')
  assert.equal(byId['wish-open'].text, '想换个 更大的鱼缸', '换行要压成一行，不然面板会断行')
  assert.equal(byId['growth-record'].text, '发现留痕要留话不要留 id')
  assert.equal(byId['hub-toggle'].text, '', '没正文就空着，面板退回显示 id，不猜')
})

test('今天日期与 growth 的 dayKeyShanghai 同一套口径（凌晨那几个小时不会掉到昨天）', async () => {
  const { dayKeyShanghai: growthDay } = await import('../lib/growth.mjs')
  const sample = new Date('2026-10-27T16:30:00.000Z') // 北京时间 10-28 00:30
  assert.equal(dayKeyShanghai(sample), '2026-10-28')
  assert.equal(dayKeyShanghai(sample), growthDay(sample))
})
test('面板：整合包页有「今天概览」卡，读的是 today 与 platformsToday', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /key: 'hub-today'/)
  assert.match(panel, /var t = acts\.today \|\| \{\}/)
  assert.match(panel, /var plat = acts\.platformsToday \|\| \{\}/)
  // 只报今天：总量已经在「总览」里有了，这里再报一遍就是多余读数。
  assert.ok(!/今日累计/.test(panel))
})
test('改设置也要留痕：三条写入路径都上时间线，且不抄敏感值', () => {
  const http = readFileSync(join(import.meta.dirname, '..', 'lib', 'http.mjs'), 'utf8')
  // 配置中心：只记改了哪几个键，值不抄（值里可能有 token）。
  assert.match(http, /action: 'config-change', recordId: keys\.join\(','\)/)
  assert.match(http, /Object\.keys\(body\)\.slice\(0, 12\)/)
  // 平台设置与 QQ 桥：只记 id / 键名，不记值（值里可能是主人 QQ 号或会话 id）。
  assert.match(http, /action: 'platform-change'/)
  assert.match(http, /action: 'bridge-change'/)
  assert.ok(!/action: 'bridge-change'[^)]*value/.test(http), '审计不许抄桥设置的值')
  // 三个新动作都要有中文名，时间线上才不会出现裸英文。
  for (const action of ['config-change', 'platform-change', 'bridge-change']) {
    assert.ok(ACTION_LABELS[action], `${action} 缺中文名`)
  }
})
test('时间线能按身份筛：只看鱼 / 只看主人，条数跟着变', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-role-'))
  const root = join(home, '鱼的世界')
  const dir = join(root, '安全与审计')
  mkdirSync(dir, { recursive: true })
  const today = dayKeyShanghai()
  writeFileSync(join(dir, `${today}.jsonl`), [
    JSON.stringify({ at: new Date().toISOString(), role: 'fish', action: 'diary-write' }),
    JSON.stringify({ at: new Date().toISOString(), role: 'owner', action: 'hub-toggle' }),
    JSON.stringify({ at: new Date().toISOString(), role: 'owner', action: 'config-change' }),
  ].join('\n'))

  const all = readActions({ rootDir: root, days: 7 })
  assert.equal(all.total, 3)
  const fish = readActions({ rootDir: root, days: 7, role: 'fish' })
  assert.equal(fish.total, 1)
  assert.equal(fish.items[0].roleLabel, '鱼')
  const owner = readActions({ rootDir: root, days: 7, role: 'owner' })
  assert.equal(owner.total, 2)
  // 「今天」那一栏是全局的，不跟着筛变——滤成只看主人会让数字变小，像今天没干活。
  assert.equal(fish.today.total, all.today.total)
  assert.equal(owner.today.total, all.today.total)
})

test('面板：时间线有身份筛选，切一下重新读', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /id: 'fish', label: '鱼自己'/)
  assert.match(panel, /state\.actionsRole = item\.id/)
  assert.match(panel, /actionsRole: '',/)
  const http = readFileSync(join(import.meta.dirname, '..', 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /searchParams\.get\('role'\)/)
  assert.match(http, /readActions\(\{ rootDir, days, role \}\)/)
})
test('三处关键写入也上时间线：审核日记、改白名单、改主人绑定', () => {
  const http = readFileSync(join(import.meta.dirname, '..', 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /action: 'diary-review'/)
  assert.match(http, /action: 'chat-whitelist'/)
  assert.match(http, /action: 'profile-change'/)
  // 只记「改了什么」，不抄具体号：审计是本地文件，也不该当通讯录。
  assert.match(http, /touched\.push\('主人QQ'\)/)
  assert.ok(!/profile-change[\s\S]{0,200}String\(body\.ownerQQ\)/.test(http), '审计不许抄主人 QQ 号')
  for (const action of ['diary-review', 'chat-whitelist', 'profile-change']) {
    assert.ok(ACTION_LABELS[action], `${action} 缺中文名`)
  }
})
test('时间线能改阅读范围：7 / 30 / 90 天，天数透传给后端', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /var DAY_FILTERS = \[7, 30, 90\]/)
  assert.match(panel, /actionsDays: 7,/)
  assert.match(panel, /var days = Number\(state\.actionsDays\) > 0 \? Number\(state\.actionsDays\) : 7/)
  const home = mkdtempSync(join(tmpdir(), 'fw-days-'))
  const root = join(home, '鱼的世界')
  const dir = join(root, '安全与审计')
  mkdirSync(dir, { recursive: true })
  // 造三天文件：只读最近 7 天时全都能看到，只读最近 1 天时只剩最新那一天。
  for (const day of ['2026-10-26', '2026-10-27', '2026-10-28']) {
    writeFileSync(join(dir, `${day}.jsonl`), JSON.stringify({ at: `${day}T00:00:00.000Z`, role: 'fish', action: 'diary-write' }) + '\n')
  }
  assert.equal(readActions({ rootDir: root, days: 30 }).total, 3)
  assert.equal(readActions({ rootDir: root, days: 1 }).total, 1, '读最近 1 天就只算最新那份')
})

test('面板：并库草稿要列出「知识库已有、不并」的那几条', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /item\.state === 'dup'/)
  assert.match(panel, /知识库已有（不并）/)
})
test('鱼的家不只报「在不在」：项数、文件数、大小、最近改动都要有', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-'))
  const root = join(home, '鱼的世界')
  mkdirSync(join(root, '鱼的日记'), { recursive: true })
  writeFileSync(join(root, '鱼的日记', '2026-10-26.jsonl'), '{"a":1}\n')
  writeFileSync(join(root, '鱼的日记', '2026-10-27.jsonl'), '{"b":2}\n')
  const rows = describeHome({ rootDir: root, folders: ['鱼的日记', '鱼的成长'] })
  const diary = rows.find((row) => row.name === '鱼的日记')
  assert.equal(diary.exists, true)
  assert.equal(diary.entries, 2)
  assert.equal(diary.files, 2)
  assert.ok(diary.bytes > 0, '要有大小，才能看出目录是不是空的')
  assert.ok(diary.latestAt, '要有最近改动时间')
  const empty = rows.find((row) => row.name === '鱼的成长')
  assert.equal(empty.exists, false)
  assert.equal(empty.entries, 0)
  // 面板要把这几个数画出来，而不是只说「在」。
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /bits\.push\(folder\.entries \+ ' 项'\)/)
  assert.match(panel, /formatBytes\(folder\.bytes\)/)
})
test('留存要分「她说的」和「旁听的」：只报总数会看着像她一天到晚在说话', async () => {
  const { tallyDayFile } = await import('../lib/activity.mjs')
  const home = mkdtempSync(join(tmpdir(), 'fw-tally-'))
  const file = join(home, '2026-10-28.jsonl')
  writeFileSync(file, [
    JSON.stringify({ at: 'x', kind: 'send', actor: 'fish' }),
    JSON.stringify({ at: 'x', kind: 'send', actor: 'fish' }),
    JSON.stringify({ at: 'x', kind: 'receive', actor: 'other' }),
    JSON.stringify({ at: 'x', kind: 'receive', actor: 'other' }),
    JSON.stringify({ at: 'x', kind: 'send', actor: 'owner' }),
    'not json',
  ].join('\n'))
  const t = tallyDayFile(file)
  assert.equal(t.total, 5, '坏行要跳过，不算进总数')
  assert.deepEqual(t.byActor, { fish: 2, owner: 1, other: 2 })
  assert.equal(t.byKind.send, 3)
  // 文件不在就是全零，不抛。
  const empty = tallyDayFile(join(home, 'missing.jsonl'))
  assert.equal(empty.total, 0)

  const http = readFileSync(join(import.meta.dirname, '..', 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /said = tally\.byActor\.fish/)
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /'说了 ' \+ info\.said \+ ' · 听 ' \+ \(info\.heard \|\| 0\)/)
})
test('总览开头一句话：只用读到的数，且日记要按「今天」算', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  // 总览要拉 /actions，否则那句话里的「今天说了几句」永远出不来。
  assert.match(panel, /loadActions\(\),[\s\S]{0,20}\]\)/)
  assert.match(panel, /var summaryBits = \[\]/)
  assert.match(panel, /summaryBits\.push\('今天说了 ' \+ said \+ ' 句'\)/)
  // 日记必须是「今天写了几篇」（审计的 diary-write），不能用日记页当前那一天的条数冒充。
  assert.match(panel, /acts\.today\.byAction\['diary-write'\]/)
  assert.match(panel, /今天还没写日记/)
  assert.ok(!/summaryBits\.push\('日记 ' \+ diaryCount/.test(panel), '不许拿别的日期的日记数冒充今天')
  // 没读到的部分整段跳过，不往这句里塞「读取中」。
  assert.ok(!/读取中/.test(panel.slice(panel.indexOf('var summaryBits'), panel.indexOf('var modeBar'))))
})
test('自检闸：被跟踪文件里不许出现本机绝对路径（铁律 ⑤）', () => {
  const check = readFileSync(join(import.meta.dirname, '..', 'scripts', 'check.mjs'), 'utf8')
  // 语义变了：原来这里断言「检查器里写着本机名」——那本身就是违规样本（铁律 ⑤）。
  // 现在检查器运行时用 os.homedir() / USERNAME 动态取可疑串，所以测试只钉两件事：
  // 守卫在（动态取串的函数在），且它真的会报「本机绝对路径（铁律 ⑤）」这一条。
  assert.match(check, /function localPathNeedles\(\)/)
  assert.match(check, /os\.homedir|homedir\(\)/, '可疑串要从本机动态取，不能写死名字')
  assert.match(check, /里出现本机绝对路径（铁律 ⑤）/)
  // 拦的是「本机那一串」，不是所有盘符：C:/Users/x、D:/fake 这类占位是测试要用的。
  assert.ok(!/Users\[\^/.test(check), '别把中性占位也拦了，检查器自己就成了噪音源')
})
test('鱼的家要能「看看里面」：最近改动的几条，按时间倒序、最多 8 条', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-recent-'))
  const root = join(home, '鱼的世界')
  const dir = join(root, '鱼的日记')
  mkdirSync(dir, { recursive: true })
  // 造 10 个文件，mtime 依次递增；只有最近 8 个该出现
  for (let i = 0; i < 10; i += 1) {
    const file = join(dir, `f${i}.jsonl`)
    writeFileSync(file, 'x'.repeat(i + 1))
    const at = new Date(Date.now() - (10 - i) * 60000)
    utimesSync(file, at, at)
  }
  mkdirSync(join(dir, '子目录'), { recursive: true })
  // 目录也要给它一个旧 mtime，否则它会因为「刚建」排到最前面，干扰「最新排最前」的断言。
  const oldAt = new Date(Date.now() - 3 * 3600 * 1000)
  utimesSync(join(dir, '子目录'), oldAt, oldAt)
  const row = describeHome({ rootDir: root, folders: ['鱼的日记'] })[0]
  assert.equal(row.recent.length, 8, '只回最近 8 条')
  assert.equal(row.recent[0].name, 'f9.jsonl', '最新的排最前')
  assert.ok(row.recent[0].bytes > 0, '文件要带大小')
  assert.equal(row.recent.some((x) => x.name === 'f0.jsonl'), false, '太旧的挤不进来')
  assert.ok(row.recent.every((x) => typeof x.dir === 'boolean'), '目录/文件要分开标出来')

  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /看看里面/)
  assert.match(panel, /state\.homeOpen\[folder\.name\] = !opened/)
})
