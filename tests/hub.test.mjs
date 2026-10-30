// 整合包账本 + 记忆账本：只读，但每一句判断都要能被推翻。
//
// 这几条测的都是「账本会不会说谎」：认不出来的包不能静默吞掉、
// 重复项不能把宿主基础设施算进去、淡忘公式不能和 dsh-fish-memory 各算各的。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MODPACK, ROLES, SCOPE, TOOL_GROUPS, readModpack, readScope, retireAdvice, retireImpact, setModEnabled, toolInventory, unknownMods } from '../lib/hub.mjs'
import { describeHome, readActions } from '../lib/actions.mjs'
import { activationOf, lexicalOf, planWardrobeImport, readMemoryLedger, recall, unifiedEntries } from '../lib/memory-hub.mjs'

const ROOT = join(import.meta.dirname, '..')

/** 造一个假 profile：声明了哪些包、装了哪些包。 */
function fakeProfile({ dependencies = {}, bundles = [], installed = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-hub-'))
  const dir = join(home, 'profiles', 'desktop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fake-profile',
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2))
  for (const [name, version] of Object.entries(installed)) {
    const target = join(dir, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version }))
  }
  return home
}

test('账本清单：每条都写了角色和用途，角色名必须是 ROLES 里那几个', () => {
  for (const entry of MODPACK) {
    assert.ok(Object.hasOwn(ROLES, entry.role), `${entry.name} 的角色 ${entry.role} 不在 ROLES 里`)
    assert.ok(entry.purpose && entry.purpose.length >= 4, `${entry.name} 没写它在养鱼里干什么`)
    assert.ok(Array.isArray(entry.capabilities) && entry.capabilities.length > 0, `${entry.name} 没写能力位`)
  }
  // 同一个包名不能出现两次：真源重复会让「留谁」变成随机。
  const names = MODPACK.map((item) => item.name)
  assert.equal(new Set(names).size, names.length, '整合包清单里有重复的包名')
})

test('账本：认不出来的包标成未归类并单独列出来，不许静默吞掉', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'some-new-plugin': '^1.0.0' },
    bundles: ['dsh-fish-world', 'some-new-plugin'],
    installed: { 'dsh-fish-world': '0.2.0', 'some-new-plugin': '1.0.0' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  const unknown = report.mods.find((mod) => mod.name === 'some-new-plugin')
  assert.ok(unknown, '新装的包必须出现在账本里')
  assert.equal(unknown.role, 'other')
  assert.deepEqual(unknownMods(report), ['some-new-plugin'])
})

test('账本：同一件事上站着两个 mod 才算重复；absorbed 是接管结果，不算冲突', () => {
  const home = fakeProfile({
    dependencies: {
      'dsh-fish-world': 'link:x',
      'dsh-fish-memory': '^1.0.0',
      'billion-context': '^0.1.0',
      'dsh-context': '^0.77.0',
    },
    bundles: ['dsh-fish-world', 'dsh-fish-memory', 'billion-context', 'dsh-context'],
    installed: {
      'dsh-fish-world': '0.2.0',
      'dsh-fish-memory': '1.3.7',
      'billion-context': '0.1.208',
      'dsh-context': '0.77.0',
    },
  })
  const report = readModpack({ home, profile: 'desktop' })
  const caps = report.duplicates.map((dup) => dup.capability)
  // 2026-10-29 主人指出误报：dsh-fish-memory 的 role 是 absorbed（能力已并进鱼世界、
  // 包本身是必需依赖），它和 core 同站「记忆」能力位是接管的结果，不是要主人裁决的冲突——
  // 旧版会在这张卡上建议「停用 dsh-fish-memory」，而那会让 memory-recall / memory-merge 哑掉。
  assert.ok(!caps.includes('memory'), 'absorbed 依赖不许被当成重复项')
  assert.ok(!caps.includes('context'), '上下文那两个是宿主基础设施，不该算重复')
})

test('账本：装了但没写进 bundles 的包，不能被说成「在加载列表里」', () => {
  // 实测过：dsh-fish-memory 不在 bundles 里，但它确实在跑。
  // 所以 installed 与 listed 是两件事，账本不能混着说。
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-fish-memory': '^1.3.7' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-fish-memory': '1.3.7' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  const memory = report.mods.find((mod) => mod.name === 'dsh-fish-memory')
  assert.equal(memory.installed, true)
  assert.equal(memory.listed, false)
  assert.equal(report.counts.installed, 2)
  assert.equal(report.counts.listed, 1)
})

test('账本：profile 的 package.json 读不到时给空账本，不抛异常', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-hub-empty-'))
  const report = readModpack({ home, profile: 'desktop' })
  assert.equal(report.manifestFound, false)
  assert.deepEqual(report.mods, [])
  assert.equal(report.counts.total, 0)
})

test('淡忘：长期事实不淡，普通的事按半衰期衰减，没写时间的按常数算', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  assert.equal(activationOf({ category: 'stable_profile' }, now), 1)
  const fresh = activationOf({ category: 'event', at: '2026-10-27T00:00:00Z', importance: 0 }, now)
  const old = activationOf({ category: 'event', at: '2026-06-01T00:00:00Z', importance: 0 }, now)
  assert.ok(fresh > old, '越近越鲜活')
  assert.ok(fresh < 1 && fresh > 0.9, '一天前大约是 0.98')
  assert.equal(activationOf({ category: 'event' }, now), 0.5, '没写时间的按 unknownActivation 算')
  // 重要度会把半衰期拉长：同一天的事，重要的淡得慢。
  const plain = activationOf({ category: 'event', at: '2026-08-01T00:00:00Z', importance: 0 }, now)
  const important = activationOf({ category: 'event', at: '2026-08-01T00:00:00Z', importance: 1 }, now)
  assert.ok(important > plain, '重要的事淡得慢')
})

test('字面相关度：一个二元词都没命中就是 0，命中越多越接近 1', () => {
  assert.equal(lexicalOf('今天吃了白饭', '天气'), 0)
  assert.ok(lexicalOf('今天吃了白饭', '白饭') > 0.9)
  assert.equal(lexicalOf('', '白饭'), 0)
})

/** 造一份三处都有的记忆目录。 */
function fakeMemory({ sessions = {}, persons = [], knowledge = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-mem-'))
  const root = mkdtempSync(join(tmpdir(), 'fw-root-'))
  const storeDir = join(home, 'fish-memory')
  mkdirSync(storeDir, { recursive: true })
  for (const [id, memories] of Object.entries(sessions)) {
    writeFileSync(join(storeDir, `session-${id}.json`), JSON.stringify({ version: 2, memories }))
  }
  const personsDir = join(root, '鱼的记忆', '群友')
  mkdirSync(personsDir, { recursive: true })
  for (const person of persons) {
    writeFileSync(join(personsDir, `${person.qq}.json`), JSON.stringify(person))
  }
  writeFileSync(join(root, '鱼的记忆', '知识库.json'), JSON.stringify({ version: 1, items: knowledge }))
  return { home, root }
}

test('记忆账本：三处分别计数，多会话要明确说「互不相认」', () => {
  const { home, root } = fakeMemory({
    sessions: {
      aaa: [{ id: 'm1', text: '她喜欢白饭', at: '2026-10-27T00:00:00Z' }],
      bbb: [{ id: 'm2', text: '她说周末要睡到中午', at: '2026-10-26T00:00:00Z' }],
    },
    persons: [{ qq: '10001', total: 120, summary: { text: '爱提条件', at: 1 } }],
    knowledge: [{ id: 'k1', title: '白饭', content: '鱼最爱' }],
  })
  const ledger = readMemoryLedger({ rootDir: root, home })
  assert.equal(ledger.totals.sessions, 2)
  assert.equal(ledger.totals.sessionMemories, 2)
  assert.equal(ledger.totals.persons, 1)
  assert.equal(ledger.totals.knowledge, 1)
  assert.equal(ledger.warnings.length, 1, '两个会话必须报「换个会话就记不得」')
  assert.match(ledger.warnings[0], /2 份/)
})

test('记忆账本：一处都没有时给 0，不报错', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-mem-empty-'))
  const root = mkdtempSync(join(tmpdir(), 'fw-root-empty-'))
  const ledger = readMemoryLedger({ rootDir: root, home })
  assert.equal(ledger.totals.sessionMemories, 0)
  assert.equal(ledger.totals.persons, 0)
  assert.equal(ledger.totals.knowledge, 0)
  assert.deepEqual(ledger.warnings, [])
})

test('召回：按人优先、作废的排到最后、知识库不因为「不是这个人」被漏掉', () => {
  const { home, root } = fakeMemory({
    sessions: {
      aaa: [
        { id: 'm1', text: '她喜欢白饭', at: '2026-10-27T00:00:00Z' },
        { id: 'm2', text: '她说白饭要少盛', at: '2026-10-27T00:00:00Z', '已被取代': { 被谁: 'm3' } },
      ],
    },
    persons: [{ qq: '10001', total: 120, summary: { text: '爱提条件，白饭要多盛', at: Date.parse('2026-10-27T00:00:00Z') } }],
    knowledge: [{ id: 'k1', title: '白饭', content: '鱼最爱，别问为什么' }],
  })
  const entries = unifiedEntries({ rootDir: root, home })
  assert.ok(entries.some((entry) => entry.source === 'knowledge'), '知识库要进统一表')
  assert.ok(entries.some((entry) => entry.source === 'persons'), '群友印象要进统一表')
  const result = recall({ rootDir: root, home, query: '白饭', person: '10001', limit: 5 })
  assert.ok(result.picked.length > 0)
  // 作废的那条不能排第一：它前面还有本人印象和知识库。
  assert.notEqual(result.picked[0].id, 'm2')
  const own = result.picked.find((entry) => entry.person === '10001')
  assert.ok(own, '问「白饭」时这个人的印象要在结果里')
})

test('面板接线：导航里有「鱼的整合包」，视图与两条路由都在', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /\{ id: 'hub', label: '鱼的整合包' \}/)
  assert.match(panel, /function viewHub\(\)/)
  assert.match(panel, /if \(state\.view === 'hub'\) return viewHub\(\)/)
  assert.match(panel, /if \(view === 'hub'\) return Promise\.all\(\[loadHub\(\), loadMemoryHub\(\), loadActions\(\), loadHubTools\(\)\]\)/)
  assert.match(panel, /getJSON\('\/dsh-fish-world\/hub'\)/)
  assert.match(panel, /getJSON\('\/dsh-fish-world\/memory'\)/)
  // 时间线读的是 /actions，带上「按身份筛」的 role 参数（空串时不带）。
  assert.match(panel, /getJSON\('\/dsh-fish-world\/actions\?days=' \+ days \+ \(role \? '&role=' \+ encodeURIComponent\(role\) : ''\)\)/)
})

test('可视化：一次开关的每一步都画出来，不是只给一句结论', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  // 后端回的 steps 原样进 state，重绘后仍然在（不做二次推断、也不会一闪就没）。
  assert.match(panel, /state\.hubRun = \{ name: name, at: new Date\(\)\.toISOString\(\), steps: r\.steps \}/)
  assert.match(panel, /run\.steps\.forEach\(function \(s\) \{ runBody\.push\(stepRow\(s\)\) \}\)/)
  const css = readFileSync(join(ROOT, 'ui', 'panel.css'), 'utf8')
  assert.match(css, /\.fw-flow-row\s*\{/)
  assert.match(css, /\.fw-flow-dot\[data-tone="ok"\]/)
})

test('可视化：操作时间线读审计真源，翻译不了的动作用原文显示', () => {
  assert.equal(typeof readActions, 'function')
  const home = mkdtempSync(join(tmpdir(), 'fw-act-'))
  const root = join(home, '鱼的世界')
  const dir = join(root, '安全与审计')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '2026-10-28.jsonl'), [
    JSON.stringify({ at: '2026-10-28T01:00:00.000Z', role: 'fish', action: 'diary-write', recordId: 'r1' }),
    JSON.stringify({ at: '2026-10-28T02:00:00.000Z', role: 'owner', action: 'wish-approved', recordId: 'r2', tone: 'explained' }),
    JSON.stringify({ at: '2026-10-28T03:00:00.000Z', role: 'fish', action: 'something-new', recordId: 'r3' }),
  ].join('\n'))
  const flow = readActions({ rootDir: root, days: 7 })
  assert.equal(flow.total, 3)
  assert.equal(flow.items[0].at, '2026-10-28T03:00:00.000Z', '最新的排最前')
  assert.equal(flow.items[1].label, '主人同意了请求')
  assert.equal(flow.items[1].roleLabel, '主人')
  assert.equal(flow.items[1].tone, 'explained')
  // 没登记的动作不许硬翻译成「未知」，原文照出——看得见比好看重要。
  assert.equal(flow.items[0].label, 'something-new')
})

test('动作清单：每个动作名都真的在 fish_world 的 ACTIONS 里（清单不许自己编动作）', () => {
  const tool = readFileSync(join(ROOT, 'lib', 'tool.mjs'), 'utf8')
  const enumBlock = tool.slice(tool.indexOf('const ACTIONS = ['))
  const listed = new Set([...enumBlock.slice(0, enumBlock.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1]))
  assert.ok(listed.size > 30, 'ACTIONS 没解析出来，规则该跟着改了')
  for (const group of TOOL_GROUPS) {
    for (const action of group.actions) {
      assert.ok(listed.has(action.name), `动作清单里的 ${action.name} 在 fish_world 的 ACTIONS 里不存在`)
    }
  }
})

test('动作清单：标了 require 的动作，缺插件就报「缺」，不缺就报能用', () => {
  // 只装了 QQ 桥与视频用的 ffmpeg、没装抖音/朗读：QQ 相关的动作必须能用。
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-qq-bridge': '^1.0.8', 'dsh-ffmpeg': '^0.4.5' },
    bundles: ['dsh-fish-world', 'dsh-qq-bridge'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-qq-bridge': '1.0.8', 'dsh-ffmpeg': '0.4.5' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  const inventory = toolInventory({ report })
  const send = inventory.groups.flatMap((g) => g.actions).find((a) => a.name === 'send')
  assert.equal(send.available, true)
  assert.deepEqual(send.missing, [])
  assert.equal(inventory.counts.blocked, 0)

  // 换成没装 QQ 桥的账本：QQ 动作全部变成「缺」。
  const bare = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0' },
  })
  const blocked = toolInventory({ report: readModpack({ home: bare, profile: 'desktop' }) })
  const sendBlocked = blocked.groups.flatMap((g) => g.actions).find((a) => a.name === 'send')
  assert.equal(sendBlocked.available, false)
  assert.deepEqual(sendBlocked.missing, ['dsh-qq-bridge'])
  assert.ok(blocked.counts.blocked > 0)
})

test('动作清单：接线——路由、面板读取都在', () => {
  const http = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /path: `\$\{prefix\}\/hub\/tools`/)
  assert.match(http, /toolInventory\(\{ report: readModpack\(\{ home, profile \}\), gates: runtimeGates\(\) \}\)/)
  // 闸门必须是现算的：不能把「装了插件」当成「能用」。
  assert.match(http, /gateOf\('qq', 'send'\)/)
  assert.match(http, /gateOf\('qq', 'read'\)/)
  assert.match(http, /gateOf\('qq', 'qzone'\)/)
  assert.match(http, /canBorrowTools === true/)
  const routesLine = http.slice(http.indexOf('const routes = ['))
  assert.match(routesLine, /hubToggle, hubTools, hubRelink, hubDeclare, memoryMerge, actions,/)
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /getJSON\('\/dsh-fish-world\/hub\/tools'\)/)
  assert.match(panel, /key: 'hub-tools'/)
})

test('并库草稿：分清新说 / 已有 / 撞车，并且一个文件都不改', () => {
  const { home, root } = fakeMemory({
    sessions: {
      aaa: [
        { id: 'm1', text: '她喜欢吃白饭', at: '2026-10-27T00:00:00.000Z' },
        { id: 'm2', text: '约定：回话默认只一句', at: '2026-10-27T00:00:00.000Z' },
        { id: 'm3', text: '她不喜欢被叫行', at: '2026-10-27T00:00:00.000Z' },
      ],
    },
    persons: [],
    // 知识库里已经有一条同义的说法（真字段是 name / meaning）。
    knowledge: [{ id: 'rule-short', name: '短着说', meaning: '约定：回话默认只一句', usage: '所有会话' }],
  })
  const before = readFileSync(join(root, '鱼的记忆', '知识库.json'), 'utf8')
  const plan = planWardrobeImport({ rootDir: root, home })
  assert.equal(plan.counts.total, 3)
  assert.equal(plan.counts.dup, 1, '同一句话要认成已有')
  assert.equal(plan.counts.new, 2)
  assert.equal(plan.counts.near, 0)
  // 说「约定」的归 rule，其余归 fact：只看当初存的 category 会把规矩收成流水。
  const 约定 = plan.candidates.find((item) => /默认只一句/.test(item.text))
  assert.equal(约定.kind, 'rule')
  const 白饭 = plan.candidates.find((item) => /白饭/.test(item.text))
  assert.equal(白饭.kind, 'fact')
  // 只读：草稿不改知识库。
  assert.equal(readFileSync(join(root, '鱼的记忆', '知识库.json'), 'utf8'), before)
})

test('并库草稿：说法不同但讲同一件事的要标 near，不自动覆盖', () => {
  const { home, root } = fakeMemory({
    sessions: { aaa: [{ id: 'm1', text: 'ta 不要我说行，改用成和好', at: '2026-10-27T00:00:00.000Z' }] },
    knowledge: [{ id: 'rule-speech', name: '别说行', meaning: 'ta 不要我说行，改用成和好嗯', usage: '回话时' }],
  })
  const plan = planWardrobeImport({ rootDir: root, home })
  assert.equal(plan.counts.near, 1)
  assert.equal(plan.counts.new, 0)
  assert.equal(plan.candidates[0].matched, 'rule-speech')
})

test('知识库进统一表要带上 meaning：只读 name 等于召回时对不上内容', () => {
  const { home, root } = fakeMemory({
    knowledge: [{ id: 'k1', name: '白饭', meaning: '鱼最爱吃的大白饭', usage: '聊天里可以提' }],
  })
  const entries = unifiedEntries({ rootDir: root, home })
  const kb = entries.find((item) => item.source === 'knowledge')
  assert.ok(kb, '知识库要进统一表')
  assert.match(kb.text, /鱼最爱吃的大白饭/, 'meaning 必须带进来，不然只有标题')
})

test('面板：记忆账本要把并库草稿摊开，撞车的单独列出来', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /numRow\('衣柜里可并进知识库'/)
  assert.match(panel, /infoRow\('说法撞车', item\.matched/)
  // 「还没改文件」这句是后端 note 说的，面板原样显示——两处各写一遍迟早对不上。
  assert.match(panel, /text: merge\.note \|\| ''/)
})

test('开关之后要重算动作清单：插件都停了还说「能用」就是骗人', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  const block = panel.slice(panel.indexOf('function toggleMod'), panel.indexOf('// ---- 卡一：概览 ----'))
  assert.match(block, /loadActions\(\)/)
  assert.match(block, /loadHubTools\(\)/, '开关改完必须重读 /hub/tools，否则「能用/缺」是旧账')
})

test('动作清单：装了插件但闸门没过，要报「闸门没过」而不是「能用」', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-qq-bridge': '^1.0.8', 'dsh-ffmpeg': '^0.4.5' },
    bundles: ['dsh-fish-world', 'dsh-qq-bridge'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-qq-bridge': '1.0.8', 'dsh-ffmpeg': '0.4.5' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  const flat = (inventory) => inventory.groups.flatMap((g) => g.actions)

  // 没给 gates：这一层不替调用方瞎猜，只按 require 判；但「有闸门却没取到」要单独标出来，
  // 报成「能用」就是假读数。
  const bare = toolInventory({ report })
  const bareSend = flat(bare).find((a) => a.name === 'send')
  assert.equal(bareSend.available, true)
  assert.equal(bareSend.gateUnknown, true, '有 gate 声明但这次没取到闸门 → 标未核')
  assert.equal(flat(bare).find((a) => a.name === 'know').gateUnknown, false, '鱼自己的动作没有闸门，不该标未核')
  assert.ok(bare.counts.unverified > 0)

  // 给了「QQ 关着」：send / history / 空间那 8 条都要变灰，并带上原因。
  const gated = toolInventory({
    report,
    gates: {
      qqSend: { ok: false, reason: 'QQ 当前处于关闭状态' },
      qqRead: { ok: false, reason: 'QQ 当前处于关闭状态' },
      qqQzone: { ok: false, reason: '空间的「允许对外发帖」没开启' },
      astrbotBorrow: { ok: false, reason: '还没打开「借用 AstrBot 的插件工具」' },
    },
  })
  const send = flat(gated).find((a) => a.name === 'send')
  assert.equal(send.available, false)
  assert.equal(send.blocked, 'gate')
  assert.match(send.reason, /QQ 当前处于关闭状态/, '原因照抄闸门给的话，不在这里重写')
  assert.equal(flat(gated).find((a) => a.name === 'qzone-post').available, false)
  assert.equal(flat(gated).find((a) => a.name === 'astrbot-tool').available, false)
  // 鱼自己的动作（读知识库）不该被平台闸门牵连。
  assert.equal(flat(gated).find((a) => a.name === 'know').available, true)
  assert.ok(gated.counts.noGate > 0)
  assert.equal(gated.counts.noPlugin, 0)
})

test('动作清单：先判缺插件，再判闸门（两个都卡时不许报成「闸门没过」）', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0' },
  })
  const gated = toolInventory({
    report: readModpack({ home, profile: 'desktop' }),
    gates: { qqSend: { ok: false, reason: 'QQ 当前处于关闭状态' } },
  })
  const send = gated.groups.flatMap((g) => g.actions).find((a) => a.name === 'send')
  assert.equal(send.available, false)
  assert.equal(send.blocked, 'plugin', '桥都没装，该说的是「缺插件」')
  assert.deepEqual(send.missing, ['dsh-qq-bridge'])
  assert.equal(send.reason, '', '缺插件时不再叠一句闸门原因，避免两张皮')
})

test('可视化：鱼的家按真目录报存在与否', () => {  const home = mkdtempSync(join(tmpdir(), 'fw-home-'))
  const root = join(home, '鱼的世界')
  mkdirSync(join(root, '鱼的日记'), { recursive: true })
  const shown = describeHome({ rootDir: root, folders: [join(root, '鱼的日记'), join(root, '鱼的记忆')] })
  assert.equal(shown[0].exists, true)
  assert.equal(shown[1].exists, false)
})

test('路由接线：/hub、/memory、/hub/toggle 都在 http 面里，且只给 loopback', () => {
  const http = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /path: `\$\{prefix\}\/hub`/)
  assert.match(http, /path: `\$\{prefix\}\/memory`/)
  assert.match(http, /path: `\$\{prefix\}\/hub\/toggle`/)
  assert.match(http, /readModpack\(\{ home, profile \}\)/)
  assert.match(http, /readMemoryLedger\(\{ rootDir, home \}\)/)
  assert.match(http, /setModEnabled\(\{ home, profile, name: body\.name, enabled: body\.enabled !== false \}\)/)
  const routesLine = http.slice(http.indexOf('const routes = ['))
  assert.match(routesLine, /extensions, hub, memoryHub, memoryDigestRoute, hubToggle,/)
})

test('开关：真的写进 profile 的 bundles，写前留备份、写后回读一致', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-fish-memory': '^1.3.7' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-fish-memory': '1.3.7' },
  })
  const on = setModEnabled({ home, profile: 'desktop', name: 'dsh-fish-memory', enabled: true })
  assert.equal(on.ok, true)
  assert.equal(on.changed, true)
  assert.equal(on.listed, true)
  // 宿主读的就是这一份：直接读文件确认，不信返回值。
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-fish-memory'))
  assert.ok(on.backup && existsSync(on.backup), '写之前必须留一份能回退的备份')
  assert.match(on.note, /重启/)

  const off = setModEnabled({ home, profile: 'desktop', name: 'dsh-fish-memory', enabled: false })
  assert.equal(off.changed, true)
  assert.equal(off.listed, false)
  const after = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.ok(!after.dsh.profile.bundles.includes('dsh-fish-memory'), '停用要真的从加载列表里消失')
  // 停的是鱼的世界自己要用的依赖：必须把代价说出来。
  assert.match(off.warning, /不可用/)
})

test('开关：状态本来就对时不写文件（少一次写就少一次坏的机会）', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0' },
  })
  const file = join(home, 'profiles', 'desktop', 'package.json')
  const before = readFileSync(file, 'utf8')
  const result = setModEnabled({ home, profile: 'desktop', name: 'dsh-fish-world', enabled: true })
  assert.equal(result.changed, false)
  assert.equal(readFileSync(file, 'utf8'), before, '没变化就不该重写文件')
  const backups = readdirSync(join(home, 'profiles', 'desktop')).filter((name) => name.includes('.bak-hub-'))
  assert.deepEqual(backups, [], '没写文件就不该留备份')
})

test('开关：三条守卫——不许停自己、不许开没装的、不许开账本里没有的', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'ghost-plugin': '^1.0.0' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0' },
  })
  assert.throws(
    () => setModEnabled({ home, profile: 'desktop', name: 'dsh-fish-world', enabled: false }),
    /不能停用鱼的世界自己/,
  )
  assert.throws(
    () => setModEnabled({ home, profile: 'desktop', name: 'ghost-plugin', enabled: true }),
    /没装/,
  )
  assert.throws(
    () => setModEnabled({ home, profile: 'desktop', name: 'not-in-ledger', enabled: true }),
    /账本里没有这个包/,
  )
})

test('开关：备份只留最近几份，不会堆一屏', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-pet': '^0.3.8' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-pet': '0.3.8' },
  })
  for (let i = 0; i < 9; i += 1) {
    setModEnabled({ home, profile: 'desktop', name: 'dsh-pet', enabled: i % 2 === 0 })
  }
  const backups = readdirSync(join(home, 'profiles', 'desktop')).filter((name) => name.includes('.bak-hub-'))
  assert.ok(backups.length <= 5, `备份留了 ${backups.length} 份，太多了`)
  assert.ok(backups.length > 0)
})

test('面板：清单里的开关走 /hub/toggle，不是本地假状态', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /postJSON\('\/dsh-fish-world\/hub\/toggle', \{ name: name, enabled: next \}\)/)
  // 开关用现成的 switchRow，别为这一页另造一个控件。
  assert.match(panel, /body\.push\(switchRow\(\{/)
  // 结果要记进 state：整页重绘后还得看得见（和保存主人同一个坑）。
  assert.match(panel, /state\.hubAction = text \? \{ text: text, tone: tone \|\| '' \} : null/)
})
test('退役预演：把包装成没装，算清会失去哪些动作', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-qq-bridge': '^1.0.8', 'dsh-bili-subagent': '^0.8.7' },
    bundles: ['dsh-fish-world', 'dsh-qq-bridge'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-qq-bridge': '1.0.8', 'dsh-bili-subagent': '0.8.7' },
  })
  const report = readModpack({ home, profile: 'desktop' })

  // 停掉 QQ 桥：发消息、读历史、发空间这些动作都会哑。
  const bridge = retireImpact({ report, name: 'dsh-qq-bridge' })
  assert.equal(bridge.ok, true)
  assert.ok(bridge.lostCount > 0, '没了 QQ 桥，一堆动作该变灰')
  assert.ok(bridge.lost.some((item) => item.name === 'send'))
  assert.equal(bridge.reach, 'in-inventory', '它在动作清单里确实被依赖着')

  // 停掉 B 站那个：动作清单里没有动作依赖它 → 失去 0，但必须标成「它的本事在别处」，
  // 不能让人读成「停了一点事没有」。
  const bili = retireImpact({ report, name: 'dsh-bili-subagent' })
  assert.equal(bili.lostCount, 0)
  assert.equal(bili.reach, 'elsewhere')
  assert.deepEqual(bili.usedBy, [])

  // 账本里没有的包：不静默返回空，直接说清楚。
  const ghost = retireImpact({ report, name: 'not-installed-anywhere' })
  assert.equal(ghost.ok, false)
  assert.match(ghost.error, /账本里没有这个包/)
})

test('退役建议：absorbed 依赖不是重复项，不许建议停用必需依赖', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-qq-bridge': '^1.0.8', 'dsh-fish-memory': '^1.3.7' },
    bundles: ['dsh-fish-world', 'dsh-qq-bridge'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-qq-bridge': '1.0.8', 'dsh-fish-memory': '1.3.7' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  const advice = retireAdvice({ report })
  assert.equal(advice.ok, true)
  // 2026-10-29 主人指出误报：dsh-fish-memory 的角色是 absorbed（能力已并进鱼世界、
  // 包本身是必需依赖），它和 core 同站「记忆」能力位是接管的结果，不是要主人裁决的冲突。
  // 旧版会建议「停用 dsh-fish-memory」，而那会让 memory-recall / memory-merge 哑掉。
  const memory = advice.groups.find((group) => group.capability === 'memory')
  assert.equal(memory, undefined, '记忆不再是重复组')
  assert.ok(!JSON.stringify(advice).includes('dsh-fish-memory'), '退役建议里不许出现必需依赖的名字')
})
test('账本要把「还不认识的包」列出来，不是只给一个数', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'totally-new-plugin': '^1.0.0' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0', 'totally-new-plugin': '1.0.0' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  assert.equal(report.counts.other, 1)
  assert.deepEqual(report.unknown.map((m) => m.name), ['totally-new-plugin'], '新装的包要能看见名字')
  assert.equal(report.unknown[0].version, '1.0.0', '带上版本，才知道装的是哪一版')
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /var unknown = hub\.unknown \|\| \[\]/)
  assert.match(panel, /账本还不认识的包/)
})
test('动作清单按组折叠：默认收起，点开才列出这一组的动作', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /var openGroups = state\.hubToolsOpen \|\| \(state\.hubToolsOpen = \{\}\)/)
  assert.match(panel, /quietButton\(isOpen \? '收起' : '展开'/)
  // 收起时直接跳过这一组的动作行——不然「折叠」只是视觉上的假动作。
  assert.match(panel, /if \(!isOpen\) return/)
  assert.match(panel, /hubToolsOpen: \{\},/)
})
test('主题要记得住：选择落盘、启动接回来、当前项有标记', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  // 原来只 setAttribute 不落盘，刷新一下选择就没了（真实 bug）。
  assert.match(panel, /localStorage\.setItem\('dshcp\.theme', value\)/)
  assert.match(panel, /localStorage\.removeItem\('dshcp\.theme'\)/)
  assert.match(panel, /function restoreTheme\(\)/)
  assert.match(panel, /restoreTheme\(\)\n    render\(\)|restoreTheme\(\)[\s\S]{0,40}render\(\)/)
  // 点完看不出现在是哪个，等于让人靠记忆：当前项前面加「·」。
  assert.match(panel, /currentTheme\(\) === 'dark' \? '· ' : ''/)
})
test('面板显示开关要有回执：这个开关只写本地、不重绘，所以点完必须自己回一句', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /var feedback = statusLine\(''\)/)
  assert.match(panel, /feedback\.hidden = false/)
  // 挂件不在场时要说清「已保存，等它出现时按这个设定显示」，不能假装现在就变了。
  assert.match(panel, /已保存为「显示」；这个窗口现在没有该挂件/)
  assert.match(panel, /已关闭：挂件已隐藏/)
})
test('记忆账本按会话摊开：只报总数看不出「为什么换个窗口就想不起来」', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /source\.kind === 'sessions'/)
  assert.match(panel, /'会话 ' \+ String\(row\.id \|\| ''\)\.slice\(0, 8\)/)
  assert.match(panel, /最后写入 ' \+ shortTime/)
  // 只列前 8 个，多的说一句——不然开久了会话一多，这张卡会无限长。
  assert.match(panel, /还有 ' \+ \(source\.detail\.length - 8\) \+ ' 个会话没列出/)
})
test('操作手册要跟上新页面：整合包与并库都得有说明', () => {
  const manual = readFileSync(join(ROOT, 'OPERATION-MANUAL.md'), 'utf8')
  assert.match(manual, /## 鱼的整合包/, '手册里要有整合包那一节')
  assert.match(manual, /## 鱼的记忆：三处、一个衣柜、一次并库/, '手册里要有记忆那一节')
  // 最容易被人误解的两点，必须写在手册里。
  assert.match(manual, /改完要重启 DSH 才生效/)
  assert.match(manual, /并库不会改那些会话文件/)
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /## 鱼的整合包/, 'README 也要有这一节（对外说明与手册两处都在）')
})
test('动作清单要划清边界：这 44 条只是 fish_world 的动作，别的工具不在这一页', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /这张清单只覆盖 fish_world 这一个工具的动作/)
  // read_animation 是鱼世界自己注册的；read_image 是宿主内置的 —— 两者来源不同，不能并成一句。
  assert.match(panel, /read_animation 是鱼世界自己另外注册的独立工具/)
  assert.match(panel, /不受这里的闸门判定/)
})
test('鱼世界自己的独立工具也要进清单：read_animation 不在 action 枚举里，但确实是她的手', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0' },
  })
  const inv = toolInventory({ report: readModpack({ home, profile: 'desktop' }) })
  assert.ok(Array.isArray(inv.ownTools))
  assert.deepEqual(inv.ownTools.map((tool) => tool.name), ['read_animation'])
  // read_image 是宿主内置的，不能算在鱼世界名下（第一版就写错过）。
  assert.ok(!inv.ownTools.some((tool) => tool.name === 'read_image'))
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /另外注册的独立工具/)
  assert.match(panel, /tools\.ownTools\.forEach/)
})
test('每条动作都要真有处理分支，且只归在一组里、note 不能空', () => {
  const tool = readFileSync(join(ROOT, 'lib', 'tool.mjs'), 'utf8')
  const start = tool.indexOf('const ACTIONS = [')
  const enumText = tool.slice(start, tool.indexOf(']', start))
  const actions = [...enumText.matchAll(/'([^']+)'/g)].map((m) => m[1])
  // 分支可能写成 `if (action === 'enable' || action === 'disable')`，所以按出现次数收，
  // 不按 `if` 开头收——否则组合写法的那个动作会被误判成「没有实现」。
  const handled = new Set([...tool.matchAll(/action === '([^']+)'/g)].map((m) => m[1]))
  const orphans = actions.filter((name) => !handled.has(name))
  assert.deepEqual(orphans, [], `这些动作没有处理分支，调了只会报未知 action：${orphans.join('、')}`)

  const seen = new Map()
  for (const group of TOOL_GROUPS) {
    for (const action of group.actions) {
      assert.ok(action.note && String(action.note).trim(), `${action.name} 的说明是空的`)
      assert.ok(String(action.note).length <= 40, `${action.name} 的说明超过 40 字，卡片上会挤成两行：${action.note}`)
      assert.ok(!seen.has(action.name), `${action.name} 同时出现在「${seen.get(action.name)}」和「${group.label}」两组里`)
      seen.set(action.name, group.label)
    }
  }
  // 反向：ACTIONS 里每条都必须被归过组，不能有「实现了但没人看得见」的动作。
  const ungrouped = actions.filter((name) => !seen.has(name))
  assert.deepEqual(ungrouped, [], `这些动作没进任何分组：${ungrouped.join('、')}`)
})
test('stickers 不再是死分支：它和 sticker-list 走同一条路', () => {
  const tool = readFileSync(join(ROOT, 'lib', 'tool.mjs'), 'utf8')
  // 原来 `const list = [].filter(...)` 对空数组过滤，永远回「没有匹配的表情图」。
  // 只认「整行就是那行代码」：注释里写着这段代码的说明文字不算 —— 按文本扫描时注释也会被算成输入。
  assert.ok(!/^\s*const list = \[\]\.filter/m.test(tool), '那段死分支不许回来')
  assert.match(tool, /if \(action === 'sticker-list' \|\| action === 'stickers'\)/)
})

test('动作说明要对得上实现（抽查这几条曾经写漏的）', () => {
  const byName = new Map(TOOL_GROUPS.flatMap((g) => g.actions).map((a) => [a.name, a.note]))
  assert.match(byName.get('record'), /带 text 就记一条/, 'record 不只是读，还能写')
  assert.match(byName.get('know'), /rebuild/, 'know 还能重建索引')
  assert.match(byName.get('stickers'), /sticker-list/, 'stickers 与 sticker-list 是同一件事')
})
test('账本要看得出「profile 里装的是不是正在跑的这一份」', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:X:/somewhere/else' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  assert.ok(report.selfLink, '账本要带 selfLink')
  // fakeProfile 造的是普通目录、不是指向本仓库的联接，所以这里必然对不上——
  // 正好用来钉住「错位要被说出来」这件事。
  assert.equal(report.selfLink.ok, false)
  assert.ok(report.selfLink.expected, '要给出「正在跑的是哪一份」')
  assert.ok(report.selfLink.target, '要给出「profile 里装的是哪一份」')
  // 每个包也带上 realpath，面板想深挖时不必再算一遍。
  const self = report.mods.find((mod) => mod.name === 'dsh-fish-world')
  assert.equal(typeof self.realpath, 'string')

  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /本插件装的是另一份副本/)
  assert.match(panel, /改错地方的话，重启也不会生效/)
})
test('退役预演：必需依赖要标出来，非必需的不标', () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': 'link:x', 'dsh-fish-memory': '^1.3.7', 'dsh-bili-whale': '^0.4.6', 'dsh-bili-subagent': '^0.8.7', 'dsh-token-diet': '^0.1.0' },
    bundles: ['dsh-fish-world'],
    installed: { 'dsh-fish-world': '0.2.0', 'dsh-fish-memory': '1.3.7', 'dsh-bili-whale': '0.4.6', 'dsh-bili-subagent': '0.8.7', 'dsh-token-diet': '0.1.0' },
  })
  const report = readModpack({ home, profile: 'desktop' })
  // fish-memory 在 env.DEPENDENCIES 里且非 optional → 必需
  assert.ok(retireImpact({ report, name: 'dsh-fish-memory' }).requiredBy)
  // B 站真源已切到 bili-whale（2026-10-29 决策，见 env.mjs 的 DEPENDENCIES）：
  // 它是非 optional 的前置 → 必需；bili-subagent 降为 optional → 不是必需。
  assert.ok(retireImpact({ report, name: 'dsh-bili-whale' }).requiredBy)
  assert.equal(retireImpact({ report, name: 'dsh-bili-subagent' }).requiredBy, null)
  assert.equal(retireImpact({ report, name: 'dsh-token-diet' }).requiredBy, null)
  // 面板要把这条画成 error 级，并说清「退了会缺什么」
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /'鱼世界的必需依赖'/)
  assert.match(panel, /退了会缺「' \+ item\.requiredBy\.feature/)
})
test('整合范围：点名要的十四件事都有位置，微信单独标缺且说清为什么', async () => {
  const { SCOPE, MODPACK, readScope } = await import('../lib/hub.mjs')
  const groups = SCOPE.map((group) => group.id)
  assert.deepEqual(groups, ['fish', 'memory', 'platform'])
  const flat = SCOPE.flatMap((group) => group.items)
  assert.deepEqual(flat.map((item) => item.id), [
    'diary', 'wishes', 'growth', 'status', 'voice',
    'knowledge', 'vector', 'stickers', 'links', 'digest',
    'qq', 'wechat', 'douyin', 'bili',
  ])
  // 每日记忆摘要：由鱼的世界聚合 dsh-fish-memory 的会话库，两条都得点名。
  const digest = flat.find((item) => item.id === 'digest')
  assert.deepEqual(digest.by, ['dsh-fish-memory', 'dsh-fish-world'])
  // 每项都得说清「谁给的」，不能只写个名字。
  for (const item of flat) {
    assert.ok(Array.isArray(item.by) && item.by.length, `${item.id} 没说由哪个插件提供`)
    assert.ok(String(item.detail || '').length >= 2, `${item.id} 没写清干什么`)
  }
  const wechat = flat.find((item) => item.id === 'wechat')
  assert.match(wechat.missingNote, /dsh-wechat-plugin/)
  assert.match(wechat.missingNote, /dsh plugin --profile/)
  assert.deepEqual(wechat.by, ['dsh-wechat-plugin'], '微信只认 dsh-wechat-plugin')
  // 界面类插件只登记、不算鱼的能力：进了积分表也不能被当成「鱼会干的事」。
  for (const name of ['dsh-better-sidebar', 'dsh-at-file']) {
    const mod = MODPACK.find((item) => item.name === name)
    assert.ok(mod, `${name} 应当出现在整合包清单里`)
    assert.equal(mod.role, 'infra')
  }
  assert.match(MODPACK.find((item) => item.name === 'dsh-better-sidebar').purpose, /界面类/)
})

test('整合范围：就位与否按「真的装了」算，缺一个就算没就位', async () => {
  const { readScope } = await import('../lib/hub.mjs')
  const report = {
    mods: [
      { name: 'dsh-fish-world', installed: true },
      { name: 'dsh-feiyu-mood', installed: true },
      { name: 'dsh-qq-bridge', installed: true },
      { name: 'dsh-bili-subagent', installed: true },
      // 抖音没装
      { name: 'dsh-douyin-browser-local', installed: false },
      // 鱼的风格靠 dsh-fish-tone（装了就就位，不另抄规则）
      { name: 'dsh-fish-tone', installed: true },
    ],
  }
  const got = readScope({ report })
  assert.equal(got.counts.total, 14)
  assert.equal(got.counts.missing, 3, '抖音、微信与记忆摘要的 dsh-fish-memory 都缺')
  const douyin = got.groups.find((group) => group.id === 'platform').items.find((item) => item.id === 'douyin')
  assert.equal(douyin.ready, false)
  assert.deepEqual(douyin.missing, ['dsh-douyin-browser-local'])
  assert.match(douyin.note, /缺：dsh-douyin-browser-local/)

  // 「鱼的状态」现在实话说靠 dsh-feiyu-mood 的 /state 撑着——它没装就该报缺，别装没事。
  const noMood = readScope({ report: { mods: [{ name: 'dsh-fish-world', installed: true }] } })
  const status = noMood.groups.find((group) => group.id === 'fish').items.find((item) => item.id === 'status')
  assert.equal(status.ready, false)
  assert.deepEqual(status.missing, ['dsh-feiyu-mood'])
  assert.match(status.note, /dsh-feiyu-mood/)
  // 整组都缺的时候 fish 那五件照样是就位（它们由鱼自己与 dsh-fish-tone 提供）。
  const fish = got.groups.find((group) => group.id === 'fish')
  assert.ok(fish.items.every((item) => item.ready))
  // 没有报告也不许炸，面板首屏就是这时候画的。
  assert.equal(readScope({}).counts.total, 14)
})

test('接线：范围表送到面板，卡片在整合包页第一张', async () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /key: 'hub-scope'/)
  assert.match(panel, /title: '整合范围'/)
  assert.ok(panel.indexOf("key: 'hub-scope'") < panel.indexOf("key: 'hub-overview'"), '范围卡要排在整合包概览前面')
  const http = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /scope: readScope\(\{ report, gates: runtimeGates\(\), usage: usageOf\(\), knowledge: kbStatus\(\), facts: factsOf\(\) \}\)/)
  assert.match(http, /action=readActions|activity\?\.status\?\.\(\)/)
})
test('整合范围：装了但闸关着要算「待开闸」，不能跟着动作清单唱反调', async () => {
  const { readScope } = await import('../lib/hub.mjs')
  const report = { mods: [{ name: 'dsh-fish-world', installed: true }, { name: 'dsh-qq-bridge', installed: true }] }
  const got = readScope({ report, gates: { qqSend: { ok: false, reason: 'QQ 桥总开关没开' }, qqRead: { ok: true } } })
  const qq = got.groups.find((group) => group.id === 'platform').items.find((item) => item.id === 'qq')
  assert.equal(qq.state, 'blocked', 'QQ 桥在、但发送闸关着 → 待开闸')
  assert.equal(qq.ready, false)
  assert.equal(qq.blocked.length, 1)
  assert.equal(qq.blocked[0].action, 'send')
  assert.match(qq.note, /装了，但「send」现在用不了/)
  assert.equal(got.counts.blocked, 1)
  // 没给闸门时不许假装通过：如实说「只核了装没装」。
  const bare = readScope({ report })
  assert.equal(bare.gatesChecked, false)
  const qqBare = bare.groups.find((group) => group.id === 'platform').items.find((item) => item.id === 'qq')
  assert.equal(qqBare.state, 'ready')
  // 三个数相加必须等于总数，账要平。
  for (const got2 of [got, bare]) {
    assert.equal(got2.counts.ready + got2.counts.blocked + got2.counts.missing, got2.counts.total)
  }
})
test('整合范围：就位不等于在用，使用情况要单列', async () => {
  const { readScope } = await import('../lib/hub.mjs')
  const report = { mods: [{ name: 'dsh-fish-world', installed: true }, { name: 'dsh-qq-bridge', installed: true }, { name: 'dsh-bili-subagent', installed: true }] }
  const got = readScope({
    report,
    usage: { qq: { total: 42, days: 6, lastAt: '2026-10-28T12:00:00.000Z' }, bili: { total: 0, days: 0, lastAt: '' } },
  })
  const pick = (id) => got.groups.find((group) => group.id === 'platform').items.find((item) => item.id === id)
  assert.deepEqual(pick('qq').usage, { total: 42, days: 6, lastAt: '2026-10-28T12:00:00.000Z' })
  assert.equal(pick('bili').usage.total, 0)
  assert.equal(pick('douyin').usage, null, '没给 usage 的平台不能编一个 0 出来')
  // 日记这类自己的事没有平台留存，usage 必须是 null，不能假装用过。
  assert.equal(got.groups.find((group) => group.id === 'fish').items[0].usage, null)
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /用过了：共 ' \+ used\.total \+ ' 条 \/ ' \+ used\.days \+ ' 天有记录/)
  assert.match(panel, /还没有记录/)
})
test('重复的能力位：停用的包也标出来——它还占着位子，但主人已经移出加载列表', async () => {
  const home = fakeProfile({
    dependencies: { 'dsh-fish-world': '1.0.0', 'dsh-bili-whale': '1.0.0' },
    bundles: ['dsh-fish-world'], // bili-whale 装了但停用
    installed: { 'dsh-fish-world': '1.0.0', 'dsh-bili-whale': '1.0.0' },
  })
  const report = readModpack({ home })
  const dup = report.duplicates.find((d) => d.capability === 'bili')
  assert.ok(dup, 'bili 组还在：包没卸载就仍占着能力位（照旧算冲突）')
  assert.equal(dup.listed['dsh-fish-world'], true)
  assert.equal(dup.listed['dsh-bili-whale'], false)
  // 面板靠这个标「（已停用）」——不改判定，只把状态说出来。
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /dup\.listed && dup\.listed\[name\] === false/)
  assert.match(panel, /name \+ \(off \? '（已停用）' : ''\)/)
  rmSync(home, { recursive: true, force: true })
})

test('整合范围：知识库/向量按真实状态判，不看插件装没装', async () => {
  const { readScope } = await import('../lib/hub.mjs')
  const report = { mods: [{ name: 'dsh-fish-world', installed: true }] }
  const pick = (scope, id) => scope.groups.find((group) => group.id === 'memory').items.find((item) => item.id === id)

  // 装了插件、但向量关着：不能说「已就位」。
  const off = readScope({ report, knowledge: { ok: true, items: 14, enabled: false, mode: 'off', problems: [], index: null } })
  assert.equal(pick(off, 'vector').state, 'blocked')
  assert.match(pick(off, 'vector').note, /向量检索关着/)
  assert.equal(pick(off, 'knowledge').state, 'ready')
  assert.match(pick(off, 'knowledge').note, /知识库 14 条/)

  // 开着但索引过期 / 缺 key：也要说出来，不能绿。
  const stale = readScope({ report, knowledge: { ok: true, items: 3, enabled: true, mode: 'local', problems: [], index: { model: 'm', dim: 8 }, indexFresh: false, indexWhy: '库改了' } })
  assert.equal(pick(stale, 'vector').state, 'blocked')
  assert.match(pick(stale, 'vector').note, /索引过期：库改了/)
  const noKey = readScope({ report, knowledge: { ok: true, items: 3, enabled: true, mode: 'remote', problems: ['远程向量缺 key'], index: { model: 'm', dim: 8 }, indexFresh: true } })
  assert.match(pick(noKey, 'vector').note, /向量后端有问题：远程向量缺 key/)

  // 知识库本身读不出来，也不能说「已就位」。
  const broken = readScope({ report, knowledge: { ok: false, items: 0, error: '知识库解析失败' } })
  assert.equal(pick(broken, 'knowledge').state, 'blocked')
  assert.match(pick(broken, 'knowledge').note, /知识库读不出来/)

  // 拿不到 knowledge.status() 时退回只看装没装，且不编注脚。
  const none = readScope({ report })
  assert.equal(pick(none, 'vector').state, 'ready')
  assert.equal(pick(none, 'vector').note, '')
})
test('整合范围：收藏/链接把「里面有几样」说出来，空库不能和有内容同形', async () => {
  const { readScope } = await import('../lib/hub.mjs')
  const report = { mods: [{ name: 'dsh-fish-world', installed: true }] }
  const pick = (scope, id) => scope.groups.find((group) => group.id === 'memory').items.find((item) => item.id === id)

  const some = readScope({ report, facts: { stickers: 87, links: 12 } })
  assert.equal(pick(some, 'stickers').state, 'ready')
  assert.equal(pick(some, 'stickers').note, '收藏 87 张')
  assert.equal(pick(some, 'links').note, '存过 12 个站')

  const empty = readScope({ report, facts: { stickers: 0, links: 0 } })
  assert.equal(pick(empty, 'stickers').state, 'ready')
  assert.equal(pick(empty, 'stickers').note, '一张都还没有')
  assert.equal(pick(empty, 'links').note, '一个都还没存')

  // 数不出来就别写注脚，别编 0。
  const unknown = readScope({ report })
  assert.equal(pick(unknown, 'stickers').note, '')
  assert.equal(pick(unknown, 'links').note, '')
})
test('退役预演：撑着点名要的东西要单独说——动作清单上看不见那种', async () => {
  const { readScope, retireAdvice, retireImpact } = await import('../lib/hub.mjs')
  const report = {
    mods: [
      { name: 'dsh-fish-world', installed: true },
      { name: 'dsh-feiyu-mood', installed: true },
      { name: 'dsh-bili-subagent', installed: true },
      { name: 'dsh-douyin-browser-local', installed: true },
    ],
    duplicates: [{ capability: 'mood', label: '心情', keep: 'dsh-fish-world', members: ['dsh-fish-world', 'dsh-feiyu-mood'] }],
  }
  const got = retireAdvice({ report, gates: {} })
  const mood = got.groups[0].retiring[0]
  assert.deepEqual(mood.scopeLost, [{ id: 'status', label: '鱼的状态' }])
  assert.match(got.note, /撑着点名要的东西/)

  // 动作清单确实看不见（status 没有 action），但这不代表「停了没事」。
  const impact = retireImpact({ report, gates: {}, name: 'dsh-feiyu-mood' })
  assert.equal(impact.ok, true)
  assert.ok((impact.scopeLost || []).length >= 1)

  // 一件纯界面/纯重复、不撑 scope 的，就不该有 scopeLost。
  const report2 = { ...report, duplicates: [{ capability: 'desktop', label: '挂饰', keep: 'dsh-pet', members: ['dsh-pet', 'dsh-whale-widget'] }, { ...report.duplicates[0] }] }
  const got2 = retireAdvice({ report: report2, gates: {} })
  const desktop = got2.groups.find((g) => g.capability === 'desktop')
  assert.deepEqual(desktop.retiring[0].scopeLost, [])
})
test('收藏对账：索引说有、磁盘没有 = 在丢；磁盘有、索引没记 = 没登记', async () => {
  const { factNote } = await import('../lib/hub.mjs').then((m) => ({ factNote: m.__test.factNote }))
  assert.match(factNote('stickers', { stickers: 87, stickersAudit: { missing: 3, orphan: 0 } }), /磁盘上已经没了/)
  assert.match(factNote('stickers', { stickers: 87, stickersAudit: { missing: 0, orphan: 5 } }), /没进索引/)
  // 索引 file 和磁盘对不上不是「丢了」：读的时候会自愈，只报出来，别把人吓去恢复备份。
  assert.match(factNote('stickers', { stickers: 87, stickersAudit: { missing: 0, mismatched: 4, orphan: 0 } }), /文件名对不上磁盘/)
  assert.equal(factNote('stickers', { stickers: 87, stickersAudit: { missing: 0, orphan: 0 } }), '收藏 87 张')
  assert.equal(factNote('stickers', { stickers: 0, stickersAudit: { missing: 0, orphan: 0 } }), '一张都还没有')
  // 没做对账就不提这茬，别把「没核过」说成「对得上」。
  assert.equal(factNote('stickers', { stickers: 87 }), '收藏 87 张')
  const hub = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
  assert.match(hub, /stickersAudit/)
  // 对账必须走图库自己的读路径（file → name → 其它扩展名），
  // 拿索引拼的路径判存在会把「图还在、索引偏移」误报成「图丢了」（线上踩过 117/125）。
  assert.match(hub, /stickers\.fileAudit\(/)
  assert.doesNotMatch(hub, /existsSync\(stickers\.fileFor\(item\)\)/)
})
