// 并库执行侧：唯一会动主人记忆文件的入口，所以每一步都要能失败得清楚。
//
// 测的是四件事：没东西可并时一个字都不改；真并时条数、类型、备份、回读都对；
// 撞车与重复的绝不自动并；再跑一次不会写出第二遍（幂等）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyWardrobeImport, planWardrobeImport } from '../lib/memory-hub.mjs'

const ROOT = join(import.meta.dirname, '..')

/** 造一份「衣柜 + 知识库」的工作区，返回 { home, root, kb }。 */
function fakeWorld({ sessions = [], kbItems = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-merge-home-'))
  const store = join(home, 'fish-memory')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'session-aaa.json'), JSON.stringify({
    version: 2,
    memories: sessions.map((item, index) => ({
      id: 'w' + index,
      text: item.text,
      at: item.at || '2026-10-27T00:00:00.000Z',
      createdAt: item.at || '2026-10-27T00:00:00.000Z',
      category: item.category || 'event',
      importance: 0.6,
      tags: [],
      related: [],
    })),
  }, null, 2))
  const root = mkdtempSync(join(tmpdir(), 'fw-merge-root-'))
  const dir = join(root, '鱼的记忆')
  mkdirSync(dir, { recursive: true })
  const kb = join(dir, '知识库.json')
  writeFileSync(kb, JSON.stringify({ version: 1, items: kbItems }, null, 2))
  return { home, root, kb }
}

test('没东西可并时：一个字都不改，也不留备份', () => {
  const { home, root, kb } = fakeWorld({ sessions: [], kbItems: [] })
  const before = readFileSync(kb, 'utf8')
  const result = applyWardrobeImport({ home, rootDir: root, confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.added, 0)
  assert.equal(readFileSync(kb, 'utf8'), before)
  const backups = readdirSync(join(root, '鱼的记忆')).filter((name) => name.includes('.bak-merge-'))
  assert.deepEqual(backups, [], '没写就不该留备份')
  assert.ok(result.steps.some((s) => s.label === '跳过写盘'))
})

test('真并：条数增加、规矩归 rule、写前留备份、写后回读对得上', () => {
  const { home, root, kb } = fakeWorld({
    sessions: [
      { text: '约定：改人设文件之前要先讨论，ta 点头才动' },
      { text: 'ta 习惯晚上十一点后不谈工作' },
    ],
    kbItems: [{ id: 'rule-old', name: '旧规矩', meaning: '旧规矩内容' }],
  })
  const result = applyWardrobeImport({ home, rootDir: root, confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.added, 2)
  const store = JSON.parse(readFileSync(kb, 'utf8'))
  assert.equal(store.items.length, 3, '原有那条不能被弄丢')
  const 约定 = store.items.find((item) => item.type === 'rule')
  assert.match(约定.meaning, /点头才动/)
  assert.ok(约定.name.length <= 25, '标题要短，面板与召回才指认得出')
  assert.match(约定.source, /衣柜并入/)
  // 备份真在
  assert.ok(result.backup && existsSync(result.backup))
  const steps = result.steps.map((s) => s.label)
  assert.deepEqual(steps, ['找到知识库', '重算草稿', '写前备份', '逐条写入', '回读校验', '索引', '回滚'])
  assert.ok(result.steps.find((s) => s.label === '回读校验').tone === 'ok')
})

test('撞车与重复的一律不自动并：它们要人自己挑', () => {
  const { home, root, kb } = fakeWorld({
    sessions: [
      { text: '别说行，改用成和好嗯', at: '2026-10-27T00:00:00.000Z' },
      { text: '她喜欢白饭', at: '2026-10-27T00:00:00.000Z' },
    ],
    // 第一条与知识库里的 meaning 整句相同（dup）；第二条说法接近（near）。
    kbItems: [
      { id: 'k1', name: '白饭', meaning: '她喜欢白饭', usage: '聊天里可以提' },
      { id: 'k2', name: '口头语', meaning: '别说行改用成和好', usage: '' },
    ],
  })
  const plan = planWardrobeImport({ home, rootDir: root })
  assert.equal(plan.counts.dup + plan.counts.near, 2, '这两条都该被认出来')
  const result = applyWardrobeImport({ home, rootDir: root, confirm: true })
  assert.equal(result.added, 0)
  assert.equal(result.changed, false)
  assert.equal(JSON.parse(readFileSync(kb, 'utf8')).items.length, 2, '知识库不该多出一条')
})

test('幂等：并过一次的草稿再点一次不会写出第二遍', () => {
  const { home, root, kb } = fakeWorld({ sessions: [{ text: 'ta 的群名片是「咕咕」，别人叫错就不理' }] })
  const first = applyWardrobeImport({ home, rootDir: root, confirm: true })
  assert.equal(first.added, 1)
  const second = applyWardrobeImport({ home, rootDir: root, confirm: true })
  assert.equal(second.changed, false, '第二次不该再改文件')
  assert.equal(second.added, 0)
  assert.equal(JSON.parse(readFileSync(kb, 'utf8')).items.length, 1)
})

test('作废的记忆不并：它已经被取代了', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-merge-sup-'))
  const store = join(home, 'fish-memory')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'session-aaa.json'), JSON.stringify({
    version: 2,
    memories: [
      { id: 'w0', text: '旧说法', at: '2026-10-01T00:00:00.000Z', category: 'event', '已被取代': { 被谁: 'w1' } },
      { id: 'w1', text: '新说法', at: '2026-10-20T00:00:00.000Z', category: 'event' },
    ],
  }, null, 2))
  const root = mkdtempSync(join(tmpdir(), 'fw-merge-sup-root-'))
  const dir = join(root, '鱼的记忆')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '知识库.json'), JSON.stringify({ version: 1, items: [] }))
  const result = applyWardrobeImport({ home, rootDir: root, confirm: true })
  assert.equal(result.added, 1)
  const store2 = JSON.parse(readFileSync(join(dir, '知识库.json'), 'utf8'))
  assert.match(store2.items[0].meaning, /新说法/)
})

test('撞车要给出两边原文：只看衣柜那条，人没法判断是不是同一件事', () => {
  const { home, root } = fakeWorld({
    sessions: [{ text: '别说行，改用成和好嗯' }],
    kbItems: [{ id: 'k2', name: '口头语', meaning: '别说行改用成和好', usage: '回话时' }],
  })
  const plan = planWardrobeImport({ home, rootDir: root })
  const near = plan.candidates.find((item) => item.state === 'near')
  assert.ok(near, '这条该被判成撞车')
  assert.equal(near.matched, 'k2')
  assert.match(near.matchedText, /口头语/, '知识库那侧的原文也要带出来')
  assert.match(near.matchedText, /回话时/, 'meaning / usage 都算那侧的原话')
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /text: '知识库里：' \+ item\.matchedText/)
})

test('草稿要说得清每条来自哪份会话库', () => {
  const { home, root } = fakeWorld({
    sessions: [{ text: '她在群里说过：晚饭我自己解决' }],
  })
  const plan = planWardrobeImport({ home, rootDir: root })
  assert.equal(plan.candidates.length, 1)
  // fakeWorld 把会话库写成 session-aaa.json → 来源就是 aaa；面板拿它标「会话 aaa」。
  assert.equal(plan.candidates[0].from, 'aaa')
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /item\.from \? '（会话 ' \+ item\.from \+ '）' : ''/)
})

test('接线：路由只认 loopback 的 POST，且必须显式 apply:true', () => {
  const http = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /path: `\$\{prefix\}\/memory\/merge`/)
  assert.match(http, /if \(body\.apply !== true\) return reply\(res, 400/)
  assert.match(http, /applyWardrobeImport\(\{ rootDir, home, confirm: true \}\)/)
  assert.match(http, /action: 'wardrobe-merge'/)
  const routesLine = http.slice(http.indexOf('const routes = ['))
  assert.match(routesLine, /hubTools, hubRelink, hubDeclare, memoryMerge,/)
})

test('面板：应用按钮就在草稿下面，并完把每一步画出来', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /postJSON\('\/dsh-fish-world\/memory\/merge', \{ apply: true \}\)/)
  assert.match(panel, /应用草稿（只并新条目）/)
  // 忙标记：连点两下不能写出两遍。
  assert.match(panel, /if \(mergeBusy\) return/)
  assert.match(panel, /mergeStatus\.steps \|\| \[\]\)\.forEach\(function \(s\) \{ memBody\.push\(stepRow\(s\)\) \}\)/)
})
test('并完就能顺手更新索引：按钮只在真并过之后出现', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  // 只在 changed === true 时才给这个按钮：没并成或本来没东西可并，那一步是多余动作。
  assert.match(panel, /if \(mergeStatus && mergeStatus\.changed\) \{/)
  assert.match(panel, /postJSON\('\/dsh-fish-world\/world\/knowledge', \{ action: 'update' \}\)/)
  assert.match(panel, /changed: r\.changed === true/)
})

test('自检闸：记忆目录名必须与 knowledge.mjs 的 KNOWLEDGE_FOLDER 一致', () => {
  const check = readFileSync(join(ROOT, 'scripts', 'check.mjs'), 'utf8')
  assert.match(check, /memoryHub\.MEMORY_FOLDER !== knowledge\.KNOWLEDGE_FOLDER/)
  assert.match(check, /记忆目录名漂了/)
})
test('自检闸是双向的：ACTIONS 里有、清单里没有的动作也要报', () => {
  const check = readFileSync(join(ROOT, 'scripts', 'check.mjs'), 'utf8')
  assert.match(check, /在 ACTIONS 里有，但面板清单里没有/)
})
test('并进去的条目要写清来源会话，以后问「这是哪来的」答得上', () => {
  const { home, root, kb } = fakeWorld({
    sessions: [{ text: 'ta 说周末别打扰' }],
  })
  const result = applyWardrobeImport({ home, rootDir: root, confirm: true })
  assert.equal(result.added, 1)
  const store = JSON.parse(readFileSync(kb, 'utf8'))
  assert.match(store.items[0].source, /衣柜并入/)
  assert.match(store.items[0].source, /会话 aaa/, '来源里要带会话短 id，别只写「衣柜并入」')
})
test('并库草稿要说明自己覆盖了几个会话，并说清不改原文件', () => {
  const { home, root } = fakeWorld({
    sessions: [{ text: 'ta 说周末别打扰' }],
    kbItems: [],
  })
  const plan = planWardrobeImport({ home, rootDir: root })
  assert.ok(Array.isArray(plan.sessions))
  assert.equal(plan.counts.sessions, plan.sessions.length)
  assert.match(plan.note, /来自 \d+ 个会话/, 'note 里要报覆盖几个会话')
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /草稿覆盖 ' \+ merge\.sessions\.length \+ ' 个会话/)
  // 最关键的一句：不动原文件。不写这句，人会以为并库 = 把会话库搬走。
  assert.match(panel, /并进知识库不会改那些会话文件/)
})
test('并库必须显式确认：不带 confirm 的调用一律拒绝，一个字都不写', () => {
  const { home, root, kb } = fakeWorld({ sessions: [{ text: 'ta 说周末别打扰' }] })
  const before = readFileSync(kb, 'utf8')
  const refused = applyWardrobeImport({ home, rootDir: root })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /confirm: true/)
  assert.equal(readFileSync(kb, 'utf8'), before, '拒绝的时候不许碰文件')
  // 真教训：2026-10-28 一次临时探针直接调了这个函数，把 15 条并进了真实知识库。
  // 会改别人数据的函数，默认必须是安全的 —— 这条测试就是那道闸。
})
test('试召回：问一句能真想起东西，且标明来源', async () => {
  const { recallPreview } = await import('../lib/memory-hub.mjs')
  const { home, root } = fakeWorld({
    sessions: [{ text: 'ta 说过死鱼眼那个表情在我卡壳时用' }],
    kbItems: [{ id: 'rule-deadpan', name: '死鱼眼表情', meaning: '没话说的时候用', usage: '卡壳时' }],
  })
  const got = recallPreview({ home, rootDir: root, query: '死鱼眼 表情' })
  assert.equal(got.ok, true)
  assert.ok(got.picked.length >= 1, '该想起至少一条')
  assert.ok(got.picked.some((item) => item.source === 'knowledge'), '知识库那条要出现')
  // 每条都要能说清「哪来的、多相关」——不然人没法判断想起来的是不是对的。
  for (const item of got.picked) {
    assert.ok(item.source, '每条都要带来源')
    assert.equal(typeof item.score, 'number')
  }
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /试一下她会想起什么/)
  assert.match(panel, /getJSON\('\/dsh-fish-world\/memory\?recall=' \+ encodeURIComponent\(q\)\)/)
  const http = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /recallPreview\(\{ rootDir, home, query, person, limit: 6 \}\)/)
})
test('提示词原文：面板看到的那段就是真正注入的那段（同一份排版实现）', async () => {
  const { briefPreview } = await import('../lib/memory-hub.mjs')
  const { formatMemoryBrief } = await import('../lib/memory-brief.mjs')
  const { home, root } = fakeWorld({
    sessions: [{ text: 'ta 说过死鱼眼那个表情在我卡壳时用' }],
    kbItems: [{ id: 'rule-deadpan', name: '死鱼眼表情', meaning: '没话说的时候用' }],
  })
  const got = briefPreview({ home, rootDir: root, query: '死鱼眼 表情' })
  assert.equal(got.ok, true)
  assert.ok(got.count >= 1, '该想起至少一条')
  assert.match(got.text, /【你记得的事】/)
  assert.match(got.text, /不分平台、不分会话/)
  // 分叉的排版会让面板说一套、注入另一套 —— 所以必须字对字相同。
  const { recallPreview } = await import('../lib/memory-hub.mjs')
  const same = recallPreview({ home, rootDir: root, query: '死鱼眼 表情', limit: 8 })
  assert.equal(got.text, formatMemoryBrief(same.picked))
  // 什么都没想起时不能留一个空章节在提示词里。
  assert.equal(formatMemoryBrief([]), '')
  const inbox = readFileSync(join(ROOT, 'lib', 'qq-inbox.mjs'), 'utf8')
  assert.match(inbox, /return formatMemoryBrief\(recalled\)/, '注入侧必须走同一个函数，不许自己拼')
  assert.ok(!/【你记得的事】/.test(inbox), '注入侧不该再留一份文案副本')
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /看看会怎么写进提示词/)
  assert.match(panel, /getJSON\('\/dsh-fish-world\/memory\?brief=1&recall=' \+ encodeURIComponent\(q\)\)/)
  const http = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /briefPreview\(\{ rootDir, home, query, person \}\)/)
  const preview = readFileSync(join(ROOT, 'scripts', 'preview-ui.mjs'), 'utf8')
  assert.match(preview, /briefPreview\(\{ rootDir: process\.env\.FISH_WORLD_PREVIEW_ROOT \|\| '', query: q \}\)/)
})
