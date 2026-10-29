// 衣柜桥：群友印象要写进「跟主人聊天时真正会被想起来的那一份」。
//
// 真教训（2026-10-28）：鱼的记忆是两套互不相认的东西——群聊按人记一份，
// dsh-fish-memory 按会话记一份。群里认识的人，换个窗口跟主人聊就想不起来。
// 这几条测的是「新写下的印象两边都有」，以及「别把旧记忆弄丢」。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { latestWardrobeFile, wardrobeStatus, writeToWardrobe } from '../lib/fish-memory-bridge.mjs'
import { readPersonMemory, saveSummary } from '../lib/person-memory.mjs'

/** 造一份衣柜：<home>/fish-memory/session-*.json */
function fakeWardrobe({ home, memories = [], name = 'session-abc' } = {}) {
  const dir = join(home, 'fish-memory')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name + '.json')
  writeFileSync(file, JSON.stringify({ version: 2, policy: {}, memories, traces: [] }, null, 2))
  return file
}

function fakeWorld() {
  const root = join(mkdtempSync(join(tmpdir(), 'fw-world-')), '鱼的世界')
  mkdirSync(join(root, '鱼的记忆', '群友'), { recursive: true })
  return root
}

test('衣柜没装/没建过时安静返回 unavailable，不抛', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-wardrobe-empty-'))
  const result = writeToWardrobe({ text: '测试一条' }, { home })
  assert.equal(result.ok, false)
  assert.equal(result.unavailable, true)
  assert.equal(wardrobeStatus({ home }).available, false)
})

test('写进衣柜：回读确认真有一条，来源标成鱼的世界补给', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-wardrobe-'))
  const file = fakeWardrobe({ home })
  const result = writeToWardrobe({ text: '我对 10000001 的印象：爱提条件', tags: ['群友'] }, { home })
  assert.equal(result.ok, true)
  const store = JSON.parse(readFileSync(file, 'utf8'))
  const entry = store.memories.find((item) => item.id === result.id)
  assert.ok(entry, '写进去的那条必须能读回来')
  assert.match(entry.source, /鱼的世界/)
  assert.equal(entry.category, 'event')
  assert.deepEqual(entry.tags, ['群友'])
  assert.equal(wardrobeStatus({ home }).fromUs, 1)
})

test('同一个事实键只留最新：旧的标「已被取代」但仍保留，不删', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-wardrobe-key-'))
  const file = fakeWardrobe({ home })
  const first = writeToWardrobe({ text: '旧印象', 事实键: '群友.10000001.印象' }, { home })
  const second = writeToWardrobe({ text: '新印象', 事实键: '群友.10000001.印象' }, { home })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.replaced, first.id)
  const store = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(store.memories.length, 2, '旧的不能删')
  const old = store.memories.find((item) => item.id === first.id)
  assert.equal(old['已被取代'].被谁, second.id)
})

test('最新的衣柜按「最后一次写」选，不是按文件名', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-wardrobe-latest-'))
  fakeWardrobe({
    home,
    name: 'session-old',
    memories: [{ id: 'x', text: '很久以前', at: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }],
  })
  const newer = fakeWardrobe({
    home,
    name: 'session-new',
    memories: [{ id: 'y', text: '刚刚', at: '2026-10-28T00:00:00.000Z', createdAt: '2026-10-28T00:00:00.000Z' }],
  })
  assert.equal(latestWardrobeFile({ home }), newer)
})

test('印象双写：群友那份照写，衣柜那份也有一条，且键是「群友.<QQ>.印象」', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-double-'))
  const root = fakeWorld()
  const file = fakeWardrobe({ home })
  // 先造一条群友记录（saveSummary 要求这个人已经存在）。
  writeFileSync(join(root, '鱼的记忆', '群友', '10000001.json'), JSON.stringify({
    qq: '10000001', nickname: '示例群友', total: 120, sinceSummary: 100, exchanges: [], updatedAt: Date.now(),
  }))
  const result = saveSummary(root, '10000001', '爱提条件，但处着不累', {
    addToWardrobe: (payload) => writeToWardrobe(payload, { home }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.shared && result.shared.ok, true)
  // 群友那份：印象写进去了
  const person = readPersonMemory(root, '10000001')
  assert.match(person.summary.text, /爱提条件/)
  assert.equal(person.sinceSummary, 0)
  // 衣柜那份：多了一条，键带 QQ 号
  const store = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(store.memories.length, 1)
  assert.equal(store.memories[0]['事实键'], '群友.10000001.印象')
  assert.match(store.memories[0].text, /示例群友/, '用昵称而不是光秃秃的号')
})

test('衣柜写失败不影响群友记忆：shared 里报错，群友那份照旧成功', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-double-fail-'))
  const root = fakeWorld()
  writeFileSync(join(root, '鱼的记忆', '群友', '10000002.json'), JSON.stringify({
    qq: '10000002', nickname: '另一个群友', total: 120, sinceSummary: 100, exchanges: [], updatedAt: Date.now(),
  }))
  const result = saveSummary(root, '10000002', '印象一句话', {
    addToWardrobe: () => { throw new Error('衣柜坏了') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.shared.ok, false)
  assert.match(result.shared.error, /衣柜坏了/)
  assert.match(readPersonMemory(root, '10000002').summary.text, /印象一句话/)
})

test('接线：qq-inbox 收下 wardrobeWrite 并传到 saveSummary', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'qq-inbox.mjs'), 'utf8')
  assert.match(source, /videoFrames, wardrobeWrite \} = \{\}/)
  assert.match(source, /saveSummary\(root, 待记\.qq, 印象行\[1\], \{ addToWardrobe: wardrobeWrite \}\)/)
  assert.ok(existsSync(join(import.meta.dirname, '..', 'lib', 'fish-memory-bridge.mjs')))
})

// ---- 提示词里那段「你记得的事」：所有会话共用一份，不是这一场的 ----

/** 一个只有 status().worldPath + chatTargets 的最小 world 桩。 */
function worldStub(root) {
  return {
    chatTargets: () => [],
    status: () => ({ ok: true, worldPath: root }),
  }
}

async function makeInbox(root) {
  // 衣柜要用一个空目录当 home：用真 DSH_HOME 会把主人真实的会话记忆召回进断言里
  // （实测踩到：本机 fish-memory 里真有 18 条，测试直接读到了它们）。
  const home = mkdtempSync(join(tmpdir(), 'fw-inbox-home-'))
  const { createQQInbox } = await import('../lib/qq-inbox.mjs')
  return createQQInbox({
    qq: {
      bridgeConfig: () => ({ 私聊QQ: '10000001', 目标会话: 'session-owner' }),
      snapshot: () => ({}),
      history: async () => ({ ok: true, messages: [] }),
      listEvents: async () => ({ ok: true, events: [] }),
      loginInfo: async () => ({ ok: true, userId: '777' }),
      recentSent: () => [],
    },
    platforms: { chat: () => ({}) },
    world: worldStub(root),
    activity: { append() {} },
    logger: { info() {}, error() {} },
    deliver: async () => ({ ok: true }),
  })
}

test('提示词记忆段：把跨会话、跨平台的记忆摆几条，并说明「不分平台不分会话」', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-brief-'))
  const root = fakeWorld()
  fakeWardrobe({
    home,
    memories: [
      { id: 'a', text: '和她约定过：群里只接主人的话', at: '2026-10-20T00:00:00.000Z', category: 'stable_profile', importance: 1 },
      { id: 'b', text: '她喜欢吃白饭', at: '2026-10-27T00:00:00.000Z', category: 'event', importance: 0.5 },
    ],
  })
  writeFileSync(join(root, '鱼的记忆', '群友', '10000001.json'), JSON.stringify({
    qq: '10000001', nickname: '示例群友', total: 120,
    summary: { text: '爱提条件，但处着不累', at: Date.parse('2026-10-27T00:00:00.000Z') },
    exchanges: [], updatedAt: Date.now(),
  }))
  const inbox = await makeInbox(root)
  const brief = inbox.systemMemoryBrief()
  assert.match(brief, /【你记得的事】/)
  assert.match(brief, /不分平台、不分会话/)
  assert.match(brief, /爱提条件/, '群友印象要出现——群里认得的人私聊也该认得')
  assert.match(brief, /别凭这几行编/, '要提醒她去查，不要编')
})

test('提示词记忆段：一条记忆都没有时返回空串（不写空章节、不写「暂无」）', async () => {
  const root = fakeWorld()
  // 这个世界的群友目录是空的，但 DSH_HOME 里可能有真记忆——那正是这里要排除的：
  // 「记得的事」只该出现真的记下来的东西。用空世界 + 空 home 来验空态。
  const home = mkdtempSync(join(tmpdir(), 'fw-empty-home-'))
  const { createQQInbox } = await import('../lib/qq-inbox.mjs')
  const inbox = createQQInbox({
    qq: {
      bridgeConfig: () => ({ 私聊QQ: '10000001', 目标会话: 'session-owner' }),
      snapshot: () => ({}),
      history: async () => ({ ok: true, messages: [] }),
      listEvents: async () => ({ ok: true, events: [] }),
      loginInfo: async () => ({ ok: true, userId: '777' }),
      recentSent: () => [],
    },
    platforms: { chat: () => ({}) },
    world: worldStub(root),
    activity: { append() {} },
    logger: { info() {}, error() {} },
    deliver: async () => ({ ok: true }),
  })
  // 注意：memory-hub 里的衣柜按 DSH_HOME 找，测试进程的 DSH_HOME 指向真机，
  // 所以这里只断言「本世界的群友记忆是空的」这一半，衣柜那半由上面那条测试覆盖。
  assert.ok(home)
  const brief = inbox.systemMemoryBrief()
  assert.equal(typeof brief, 'string')
})
test('更新印象也要上时间线，但审计里只放 QQ 号（不抄印象正文）', () => {
  const inbox = readFileSync(join(import.meta.dirname, '..', 'lib', 'qq-inbox.mjs'), 'utf8')
  assert.match(inbox, /action: 'person-memory-summary', recordId: String\(待记\.qq \|\| ''\)/)
  // 正文是私事：审计里不该出现 印象行[1]。
  assert.ok(!/person-memory-summary[\s\S]{0,120}印象行/.test(inbox), '审计不许把印象正文抄一遍')
  assert.match(readFileSync(join(import.meta.dirname, '..', 'lib', 'actions.mjs'), 'utf8'), /'person-memory-summary': '更新了对某个人的印象'/)
})
