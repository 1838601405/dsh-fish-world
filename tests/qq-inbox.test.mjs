// QQ 聊天窗口：授权目标（chats.json）、按目标收信、攒批再回、回话发回原会话。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorldStore } from '../lib/world.mjs'
import { createQQInbox, eventAllowed, looksUnfinished } from '../lib/qq-inbox.mjs'
import { noteExchange } from '../lib/person-memory.mjs'

function fakeServices(workspace, sessionId) {
  const registry = { list: () => [{ path: workspace, sessionIds: [sessionId] }] }
  return { registry, sessions: { get: () => ({ cwd: workspace }) }, agents: { list: () => [{ session: { id: sessionId, cwd: workspace } }] } }
}

function worldWith(workspace, ownerQQ, ownerSession) {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-home-'))
  const qq = { bridgeConfig: () => ({ 私聊QQ: ownerQQ, 目标会话: ownerSession }) }
  const world = createWorldStore({ home, qq })
  world.setServices(fakeServices(workspace, ownerSession))
  return world
}

function bindWorkspace() {
  return mkdtempSync(join(tmpdir(), 'fw-chat-ws-'))
}

test('群可以作为聊天目标存在，且不会被当成「人」写进关系表', () => {
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-1')
  const saved = world.updateChats([
    { chatKey: 'group:20002', name: '游戏群', sessionId: 'session-grouproom1' },
    { chatKey: 'private:222333', name: '阿明', sessionId: 'session-friend001' },
  ])
  assert.equal(saved.items.length, 2)
  assert.equal(saved.items[0].kind, 'group')
  assert.equal(saved.items[1].kind, 'private')
  // 关系表仍然只有「人」，没有因为授权群而被污染
  assert.deepEqual(world.listRelations().people, [])
})

// 语义变更（2026-10-26）：这里是**白名单**，不是「逐条设定关系」。
// 先允许（可以还没选房间），再给目标选房间 —— 两件事分开。
// 所以「缺房间」不再是错误，只有格式问题才拒绝。
test('白名单校验：非法 chatKey / 重复 / 主人自己都拒绝，但允许先不选房间', () => {
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-1')
  assert.throws(() => world.updateChats([{ chatKey: 'weibo:123456', sessionId: 'session-x1' }]), /无效/)
  assert.throws(() => world.updateChats([
    { chatKey: 'group:20002', sessionId: 'session-a1' },
    { chatKey: 'group:20002', sessionId: 'session-b2' },
  ]), /重复/)
  assert.throws(() => world.updateChats([{ chatKey: 'private:10000001', sessionId: 'session-c3' }]), /主人自己的私聊/)

  // 不选房间也能存：它在白名单里，但不参与收信。
  const saved = world.updateChats([{ chatKey: 'group:20002', sessionId: '' }])
  assert.equal(saved.items.length, 1, '没选房间也要能加进白名单')
  assert.equal(saved.items[0].sessionId, '')
  assert.deepEqual(world.chatWhitelist().map((x) => x.chatKey), ['group:20002'], '白名单里看得到')
  assert.deepEqual(world.chatTargets(), [], '但没房间就不收信')
})

test('停用的目标不参与收信，也不在授权名单里', () => {
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-1')
  world.updateChats([
    { chatKey: 'group:20002', sessionId: 'session-grouproom1' },
    { chatKey: 'group:30003', sessionId: 'session-other001', enabled: false },
  ])
  const keys = world.chatTargets().map((item) => item.chatKey)
  assert.deepEqual(keys, ['group:20002'])
  assert.equal(world.chatTargetForSession('session-other001'), null)
})

// —— 收件箱 ——

/**
 * 假时钟：攒批是按「安静了多久」判断的，测试必须能自己拨时间，
 * 否则要么真等 5 秒、要么永远看不到投递。
 */
function fakeClock(start = 1_000_000) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms }
  return now
}

function inboxFixture({ rows = {}, bridge, platforms, world, clock, batch, videoFrames } = {}) {
  const qq = {
    calls: [],
    bridgeConfig: () => bridge || { 私聊QQ: '10000001', 目标会话: 'session-owner-1' },
    loginInfo: async () => ({ ok: true, userId: '777', nickname: '鱼' }),
    recent: async (chatKey) => ({ ok: true, messages: rows[chatKey] || [] }),
    noticeCalls: [],
    notices: [],
    forwards: {},
    forward: async (id) => qq.forwards[String(id)] || { ok: true, entries: [] },
    groupNotices: async (groupId) => {
      qq.noticeCalls.push(String(groupId))
      return { ok: true, notices: qq.notices }
    },
    isMuted: (userId) => String(userId) === '999',
    send: async (chatKey, segments) => {
      qq.calls.push({ chatKey, text: segments[0].text })
      return { ok: true, dryRun: false, sent: [{ kind: chatKey.split(':')[0], id: chatKey.split(':')[1] }] }
    },
    // 真实 qq.sendTextBatch 会逐条 send（带间隔与额度）；替身只记调用顺序，别在这里等时间。
    sendTextBatch: async (chatKey, texts) => {
      const list = Array.isArray(texts) ? texts : [texts]
      for (const text of list) qq.calls.push({ chatKey, text })
      return { ok: true, dryRun: false, sent: list.map(() => ({ kind: chatKey.split(':')[0], id: chatKey.split(':')[1] })) }
    },
  }
  const base = { enabled: true, readHistory: true, sendMessage: true, groupReplyMode: 'shy', historyLimit: 20 }
  const config = platforms || { platform: () => ({ ...base, ...(batch === undefined ? {} : batch) }) }
  const delivered = []
  const activity = []
  const inbox = createQQInbox({
    qq,
    platforms: config,
    world,
    logger: { warn() {} },
    deliver: async (message) => { delivered.push(message); return { ok: true } },
    activity: { append: (row) => activity.push(row) },
    now: clock || (() => Date.now()),
    videoFrames,
  })
  return { qq, inbox, delivered, activity }
}

const GROUP_ROWS = [
  { id: '11', userId: '222', nickname: '甲', text: '今天天气不错', at: 1000, parts: [{ kind: 'text', text: '今天天气不错' }] },
  { id: '12', userId: '333', nickname: '乙', text: '鱼在吗', at: 2000, parts: [{ kind: 'at', id: '777' }, { kind: 'text', text: '鱼在吗' }] },
]

test('群里只有 @ 到鱼才回话；没点到的进本地留存当旁听', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-1')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom1' }])
  const fx = inboxFixture({ world, clock, rows: { 'group:20002': GROUP_ROWS } })

  // 第一次碰到这个群：只把游标推到最新，一条都不回
  // （否则一开功能就把历史消息全回一遍，等于对着旧账刷屏）。
  const first = await fx.inbox.tick()
  assert.equal(first.delivered, 0)
  assert.equal(world.chatTargets()[0].cursorAt, 2000)

  // 之后来的新消息才会被处理：一条 @ 的、一条没 @ 的
  const fresh = [
    ...GROUP_ROWS,
    { id: '13', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 3000, parts: [{ kind: 'at', id: '777' }] },
    { id: '14', userId: '444', nickname: '丙', text: '没人理我', at: 3001, parts: [] },
  ]
  const second = inboxFixture({ world, clock, rows: { 'group:20002': fresh } })
  const result = await second.inbox.tick()
  // 攒批：这一轮只把被 @ 的那条收进桶，投递要等他安静下来
  assert.equal(result.delivered, 0, '刚收到先攒着，不抢话')
  assert.equal(result.pending, 1)
  assert.equal(result.read, 2, '两条新消息都算读过')
  clock.advance(20_000)
  const flushed = await second.inbox.tick()
  assert.equal(flushed.delivered, 1, '安静之后整批投一次')
  assert.equal(second.delivered.length, 1)
  assert.match(second.delivered[0].text, /在吗/)
  assert.equal(second.delivered[0].chatKey, 'group:20002')
  assert.equal(second.delivered[0].sessionId, 'session-grouproom1')
  assert.equal(second.delivered[0].kind, 'group')
  assert.ok(second.activity.some((row) => row.kind === 'read' && /没人理我/.test(row.text)), '没点到的进旁听留存')
})

test('开口档位：社恐只回被 @ 的那句，闲聊只旁听', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-2')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom2' }])
  // 先把游标推到 0 之前，保证这两条都算「新」
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': GROUP_ROWS },
    platforms: { platform: () => ({ enabled: true, readHistory: true, historyLimit: 20, groupReplyMode: 'shy' }) },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  const result = await fx.inbox.tick()
  assert.equal(result.delivered, 1)
  assert.equal(fx.delivered[0].count, 1, '只有 @ 她的那条进这一批')
  assert.match(fx.delivered[0].text, /鱼在吗/)
})

/**
 * 五档的频率：每条消息单独来一轮，等攒批的安静窗口过去再收，
 * 这样「投了几批」就等于「她开口了几次」。
 */
async function streamPlainMessages(mode, count) {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-tier')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-tier' }])
  world.markChatSeen('group:20002', { at: 500 })
  const rows = { 'group:20002': [] }
  const fx = inboxFixture({
    world,
    clock,
    rows,
    platforms: { platform: () => ({ enabled: true, readHistory: true, historyLimit: 20, groupReplyMode: mode }) },
  })
  for (let i = 1; i <= count; i++) {
    rows['group:20002'].push({ id: String(500 + i), userId: '222', nickname: '甲', text: '今天第' + i + '句闲聊', at: 1000 + i, parts: [] })
    await fx.inbox.tick()
    clock.advance(20_000)
    await fx.inbox.tick()
  }
  return fx
}

test('五档频率：社恐一句不接，狂热每句都接，中间三档按间隔接', async () => {
  // 没叫她的闲聊：quiet 每 6 句接 1 次；frenzy 每句；shy 完全不接。
  assert.equal((await streamPlainMessages('shy', 12)).delivered.length, 0, '社恐不该接闲聊')
  assert.equal((await streamPlainMessages('quiet', 12)).delivered.length, 2, '安静每 6 句接一次')
  assert.equal((await streamPlainMessages('frenzy', 12)).delivered.length, 12, '狂热的每句都接')
  assert.equal((await streamPlainMessages('normal', 6)).delivered.length, 2, '正常每 3 句接一次')
  assert.equal((await streamPlainMessages('active', 4)).delivered.length, 2, '活跃每 2 句接一次')
})

test('旧三档的配置值不算非法：mention/never 当月社恐，always 当正常', async () => {
  assert.equal((await streamPlainMessages('mention', 12)).delivered.length, 0)
  assert.equal((await streamPlainMessages('never', 12)).delivered.length, 0)
  assert.equal((await streamPlainMessages('always', 6)).delivered.length, 2)
})

test('正常档位：叫到名字也算找她，闲聊不算', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-2b')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom2b' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      { id: '21', userId: '222', nickname: '甲', text: '今天吃什么', at: 900, parts: [] },
      { id: '22', userId: '333', nickname: '乙', text: '大肥鱼你觉得呢', at: 950, parts: [] },
    ] },
    platforms: { platform: () => ({ enabled: true, readHistory: true, historyLimit: 20, groupReplyMode: 'normal' }) },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1, '叫到名字的那条会回')
  assert.match(fx.delivered[0].text, /大肥鱼/)
  assert.equal(fx.activity.filter((row) => row.kind === 'read').length, 1, '纯闲聊那条只旁听')
})

test('私聊消息一律算找她，不用 @', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-3')
  world.updateChats([{ chatKey: 'private:222333', sessionId: 'session-friend003' }])
  world.markChatSeen('private:222333', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'private:222333': [{ id: '21', userId: '222333', nickname: '阿明', text: '在忙吗', at: 900, parts: [] }] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  const result = await fx.inbox.tick()
  assert.equal(result.delivered, 1)
})

test('被拉黑的人与鱼自己的消息都不投递', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-4')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom4' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      { id: '31', userId: '999', nickname: '路人', text: '骂人', at: 900, parts: [{ kind: 'at', id: '777' }] },
      { id: '32', userId: '777', nickname: '鱼', text: '我自己说的', at: 901, parts: [{ kind: 'at', id: '777' }] },
    ] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  const result = await fx.inbox.tick()
  assert.equal(result.delivered, 0)
  assert.equal(fx.delivered.length, 0)
})

test('回复发回原群会话；没授权的房间不发', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-5')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom5' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [{ id: '41', userId: '222', nickname: '甲', text: '@鱼 早', at: 900, parts: [{ kind: 'at', id: '777' }] }] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  const receipt = await fx.inbox.onTurnEnd({ sessionId: 'session-grouproom5', text: '早啊' })
  assert.equal(receipt.ok, true)
  assert.deepEqual(fx.qq.calls[0], { chatKey: 'group:20002', text: '早啊' })

  const other = await fx.inbox.onTurnEnd({ sessionId: 'session-nobody00', text: '不该发' })
  assert.equal(other.ok, false, '不在授权表里的房间不回话')

  const empty = await fx.inbox.onTurnEnd({ sessionId: 'session-grouproom5', text: '   ' })
  assert.equal(empty.skipped, 'empty', '空回复不发')
})

// 主人 2026-10-26 在群里看到的：「谁肥了 说清楚 / 三代目就三代目 少一个字不行？」挤在同一个气泡里。
// 模型用空行写的就是两条消息，发送侧必须拆开逐条发（桥发主人私聊时本来就是按段拆的）。
test('空行是分条信号：一轮里的两条回复分两个气泡发', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-bubble')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-bubble' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [{ id: '71', userId: '222', nickname: '甲', text: '@鱼 大肥鱼三代目', at: 900, parts: [{ kind: 'at', id: '777' }] }] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  const receipt = await fx.inbox.onTurnEnd({
    sessionId: 'session-grouproom-bubble',
    text: '谁肥了 说清楚\n\n三代目就三代目 少一个字不行？',
  })
  assert.equal(receipt.ok, true)
  assert.deepEqual(fx.qq.calls, [
    { chatKey: 'group:20002', text: '谁肥了 说清楚' },
    { chatKey: 'group:20002', text: '三代目就三代目 少一个字不行？' },
  ], '空行隔开的两句要分两个气泡，别压成一句')
})

// 语义变了（2026-10-26）：单换行也拆。模型分两条时用的就是一个换行，
// 不拆就又是「存不了 图在桥的临时目录 / 你丢进 大肥鱼 目录 我再收」那种合并。
test('单换行也拆成两个气泡', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-wrap')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-wrap' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [{ id: '72', userId: '222', nickname: '甲', text: '@鱼 说吧', at: 900, parts: [{ kind: 'at', id: '777' }] }] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  await fx.inbox.onTurnEnd({ sessionId: 'session-grouproom-wrap', text: '这行\n那行' })
  assert.deepEqual(fx.qq.calls.map((c) => c.text), ['这行', '那行'])
})

test('关掉「读取历史」或平台总开关后不再轮询', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-6')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom6' }])
  for (const patch of [
    { enabled: false, readHistory: true },
    { enabled: true, readHistory: false },
  ]) {
    const fx = inboxFixture({
      world,
      clock,
      rows: { 'group:20002': [{ id: '51', userId: '222', text: 'hi', at: 9e12, parts: [{ kind: 'at', id: '777' }] }] },
      platforms: { platform: () => ({ groupReplyMode: 'mention', historyLimit: 20, ...patch }) },
    })
    const result = await fx.inbox.tick()
    assert.equal(result.skipped, 'disabled', `${JSON.stringify(patch)} 应该跳过`)
    assert.equal(fx.qq.calls.length, 0)
    assert.equal(fx.delivered.length, 0)
  }
})

test('收信写本地留存；回复本身不在这里记账，避免同一条发出去两笔', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-7')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom7' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      { id: '61', userId: '222', nickname: '甲', text: '@鱼 说一句', at: 900, parts: [{ kind: 'at', id: '777' }] },
      { id: '62', userId: '333', nickname: '乙', text: '闲聊', at: 901, parts: [] },
    ] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  await fx.inbox.onTurnEnd({ sessionId: 'session-grouproom7', text: '好的' })
  const kinds = fx.activity.map((row) => row.kind)
  assert.ok(kinds.includes('receive'), '收到的消息要留档')
  assert.ok(kinds.includes('read'), '旁听的消息也要留档')
  // 发送那笔由 qq.send 统一记（见 qq.test.mjs 的额度用例）。
  // 这里再记一次的话，同一条回复会占掉两个每日额度。
  assert.equal(kinds.includes('send'), false, '回复的留档不在收件箱里重复写')
  assert.equal(fx.qq.calls.length, 1, '但确实发出去了一次')
})

// —— 攒批（回话节奏）——

test('攒批：同一个人连发三条只回一次，并标成「一件事的几段」', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-8')
  world.updateChats([{ chatKey: 'private:222333', sessionId: 'session-friend008' }])
  world.markChatSeen('private:222333', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'private:222333': [
      { id: '71', userId: '222333', nickname: '阿明', text: '在吗', at: 900, parts: [] },
      { id: '72', userId: '222333', nickname: '阿明', text: '今天那个事我想了想', at: 950, parts: [] },
      { id: '73', userId: '222333', nickname: '阿明', text: '还是算了吧', at: 990, parts: [] },
    ] },
  })

  // 第一条进来就投 = 打断人；这里应该先攒着
  const first = await fx.inbox.tick()
  assert.equal(first.delivered, 0)
  assert.equal(first.pending, 1, '三条在同一个桶里')
  assert.equal(first.pendingMessages, 3)

  // 安静窗口（默认 5 秒）没到，仍然不回
  clock.advance(2_000)
  assert.equal((await fx.inbox.tick()).delivered, 0)

  // 安静够了：整批投一次
  clock.advance(4_000)
  const flushed = await fx.inbox.tick()
  assert.equal(flushed.delivered, 1, '三次发言合成一次投递')
  assert.equal(fx.delivered.length, 1)
  const batch = fx.delivered[0]
  assert.equal(batch.count, 3)
  assert.match(batch.text, /一件事的几段/)
  assert.match(batch.text, /在吗/)
  assert.match(batch.text, /还是算了吧/)
  assert.equal(batch.nickname, '阿明', '回的是最后说话的人')
})

test('攒批：换人说话不让两个人互相等，只回最后说话的那个人', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-9')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom9' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      { id: '81', userId: '222', nickname: '甲', text: '@鱼 甲说的话', at: 900, parts: [{ kind: 'at', id: '777' }] },
      { id: '82', userId: '333', nickname: '乙', text: '@鱼 乙说的话', at: 950, parts: [{ kind: 'at', id: '777' }] },
    ] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  const flushed = await fx.inbox.tick()
  assert.equal(flushed.delivered, 1, '同一会话只投一次，不是每人一轮')
  const batch = fx.delivered[0]
  assert.equal(batch.nickname, '乙', '只回最后说话的人')
  assert.match(batch.text, /只回一个人/)
  assert.match(batch.text, /甲说的话/, '别人的话留在背景里，不丢')
})

test('攒批：关掉开关就回到逐条投递的旧语义', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-10')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom10' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      { id: '91', userId: '222', nickname: '甲', text: '@鱼 一', at: 900, parts: [{ kind: 'at', id: '777' }] },
      { id: '92', userId: '222', nickname: '甲', text: '@鱼 二', at: 950, parts: [{ kind: 'at', id: '777' }] },
    ] },
    batch: { batchEnabled: false },
  })
  const result = await fx.inbox.tick()
  assert.equal(result.delivered, 2, '逐条投，立刻回')
  assert.equal(fx.delivered.length, 2)
  assert.equal(fx.delivered[0].text, '@鱼 一')
})

test('攒批：等太久就先回，不被刷屏拖到永远不开口', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-11')
  world.updateChats([{ chatKey: 'private:222333', sessionId: 'session-friend011' }])
  world.markChatSeen('private:222333', { at: 500 })
  const rows = [{ id: 'a1', userId: '222333', nickname: '阿明', text: '第一条', at: 900, parts: [] }]
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'private:222333': rows },
    // 安静 5 秒、没说完多等 3 秒、最久 10 秒先回
    batch: { batchQuietSec: 5, batchUnfinishedExtraSec: 3, batchMaxWaitSec: 10 },
  })
  await fx.inbox.tick()
  // 对方每 3 秒又来一条：安静窗口永远到不了（短句都算「没说完」），但最长等待会兜底
  for (let i = 2; i <= 8; i += 1) {
    clock.advance(3_000)
    rows.push({ id: 'a' + i, userId: '222333', nickname: '阿明', text: '第' + i + '条', at: 900 + i, parts: [] })
    const r = await fx.inbox.tick()
    if (r.delivered) {
      assert.ok(fx.delivered.length >= 1, '刷屏时也要开口')
      assert.ok(fx.delivered[0].count >= 2, '攒到的几条一起回')
      return
    }
  }
  assert.fail('刷屏 24 秒后仍未投递，最长等待没有兜底')
})

test('攒批：投递失败不丢消息，游标也不越过它', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-12')
  world.updateChats([{ chatKey: 'private:222333', sessionId: 'session-friend012' }])
  world.markChatSeen('private:222333', { at: 500 })
  const delivered = []
  let fail = true
  const qq = {
    bridgeConfig: () => ({ 私聊QQ: '10000001', 目标会话: 'session-owner-12' }),
    loginInfo: async () => ({ ok: true, userId: '777' }),
    recent: async () => ({ ok: true, messages: [{ id: 'b1', userId: '222333', nickname: '阿明', text: '在吗', at: 900, parts: [] }] }),
    isMuted: () => false,
    send: async () => ({ ok: true }),
  }
  const inbox = createQQInbox({
    qq,
    platforms: { platform: () => ({ enabled: true, readHistory: true, sendMessage: true, historyLimit: 20 }) },
    world,
    logger: { warn() {} },
    deliver: async (message) => {
      delivered.push(message)
      return fail ? { ok: false, error: '会话不可用' } : { ok: true }
    },
    now: clock,
    activity: { append() {} },
  })

  await inbox.tick()
  clock.advance(20_000)
  await inbox.tick()
  assert.equal(delivered.length, 1, '试过一次')
  assert.equal(world.chatTargets()[0].cursorAt, 500, '投不成就别推进游标，否则重启就丢了')

  fail = false
  clock.advance(20_000)
  const ok = await inbox.tick()
  assert.equal(ok.delivered, 1, '下一轮重试成功')
  assert.equal(delivered.length, 2)
  assert.equal(world.chatTargets()[0].cursorAt, 900, '成功后才推进到这条')
})

test('攒批：重读同一条不会重复留档、也不会重复回话', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-13')
  world.updateChats([{ chatKey: 'private:222333', sessionId: 'session-friend013' }])
  world.markChatSeen('private:222333', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'private:222333': [{ id: 'c1', userId: '222333', nickname: '阿明', text: '在吗', at: 900, parts: [] }] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  // 再跑三轮：读到的还是同一条（游标已过，且 id 已记住）
  for (let i = 0; i < 3; i += 1) {
    clock.advance(20_000)
    await fx.inbox.tick()
  }
  assert.equal(fx.delivered.length, 1, '只投过一次')
  assert.equal(fx.activity.filter((row) => row.kind === 'receive').length, 1, '本地留存也只写一笔')
})

// —— QQ 通知事件（撤回 / 入退群 / 戳一戳…）——

/** 假的事件接收器：替掉 global.fetch 里指向本机端口那一支。 */
function fakeEvents(t, queue, nowValue = () => Date.now()) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (!text.includes('/events')) {
      // 其它路径不该被事件逻辑碰到；碰到就说明我们多请求了东西。
      calls.push(text)
      return new Response(JSON.stringify({ ok: true, events: [] }), { status: 200 })
    }
    const since = Number(new URL(text).searchParams.get('since') || 0)
    calls.push(text)
    return new Response(JSON.stringify({
      ok: true,
      now: nowValue(),
      events: queue.filter((item) => item.at > since),
    }), { status: 200 })
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

function noticeFixture({ world, queue, clock, bridge, chat, t }) {
  const delivered = []
  const activity = []
  const pokes = []
  const sends = []
  const now = clock || fakeClock()
  const qq = {
    bridgeConfig: () => bridge || { 私聊QQ: '10000001', 目标会话: 'session-owner', 事件端口: 3099 },
    loginInfo: async () => ({ ok: true, userId: '777', nickname: '鱼' }),
    recent: async () => ({ ok: true, messages: [] }),
    isMuted: () => false,
    send: async (chatKey, segments) => { sends.push({ chatKey, text: segments[0].text }); return { ok: true } },
    poke: async (chatKey, target) => { pokes.push({ chatKey, ...target }); return { ok: true } },
  }
  const inbox = createQQInbox({
    qq,
    platforms: { platform: () => ({ enabled: true, readHistory: true, sendMessage: true, autoPokeBack: true, historyLimit: 20, ...(chat || {}) }) },
    world,
    logger: { warn() {}, info() {} },
    deliver: async (message) => { delivered.push(message); return { ok: true } },
    activity: { append: (row) => activity.push(row) },
    now,
  })
  fakeEvents(t, queue, now)
  return { qq, inbox, delivered, activity, pokes, sends, now }
}

const NOTICE_WORLD = () => {
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom' }])
  world.markChatSeen('group:20002', { at: 500 })
  return world
}

test('第一次拉事件只对齐时间，不把重启前攒着的历史当成刚发生', async (t) => {
  const world = NOTICE_WORLD()
  // 桥的队列里躺着 5 条「重启前」的事件：直接处理等于把入退群投进会话五遍
  const queue = [1, 2, 3, 4, 5].map((n) => ({
    at: 900_000 + n, noticeType: 'group_increase', groupId: '20002', userId: '90' + n, nickname: '老事件' + n,
  }))
  const fx = noticeFixture({ t, world, queue })

  const first = await fx.inbox.tick()
  assert.equal(first.notices, 0, '首轮一条都不处理')
  assert.equal(fx.delivered.length, 0, '历史事件不能投进会话')
  assert.equal(fx.activity.length, 0, '历史事件不能写留存')

  // 之后新发生的事件才处理
  queue.push({ at: 1_200_000, noticeType: 'group_decrease', groupId: '20002', userId: '91', nickname: '阿明' })
  fx.now.advance(1_200_000)
  const second = await fx.inbox.tick()
  assert.equal(second.notices, 1)
  assert.equal(fx.delivered.length, 1, '新事件才投')
  assert.match(fx.delivered[0].text, /阿明 退群了/)
})

test('要紧的通知投进会话并标注不用回；不要紧的只写留存', async (t) => {
  const world = NOTICE_WORLD()
  const queue = []
  const fx = noticeFixture({ t, world, queue })
  await fx.inbox.tick() // 对齐

  queue.push(
    { at: 1_100_001, noticeType: 'group_recall', groupId: '20002', userId: '91', nickname: '甲', operatorId: '92' },
    { at: 1_100_002, noticeType: 'group_card', groupId: '20002', userId: '93', nickname: '乙' },
    { at: 1_100_003, noticeType: 'group_upload', groupId: '20002', userId: '94', nickname: '丙', fileName: '攻略.pdf' },
  )
  await fx.inbox.tick()

  assert.equal(fx.activity.length, 3, '三类通知都写留存')
  assert.ok(fx.activity.every((row) => row.kind === 'notice'), '通知单独一类，不归成「其它」')
  assert.equal(fx.delivered.length, 1, '只有要紧的投进会话')
  assert.match(fx.delivered[0].text, /系统事件/)
  assert.match(fx.delivered[0].text, /管理员 92 撤的/, '管理员撤的要写清是谁撤的')
  assert.match(fx.activity[2].text, /攻略.pdf/)
})

test('戳一戳：主人不装死直接回戳，3 秒内不连发', async (t) => {
  const world = NOTICE_WORLD()
  const queue = []
  const fx = noticeFixture({ t, world, queue })
  await fx.inbox.tick()

  queue.push({ at: 1_200_001, noticeType: 'poke', groupId: '20002', userId: '10000001', targetId: '777' })
  fx.now.advance(1_200_001)
  await fx.inbox.tick()
  assert.equal(fx.pokes.length, 1, '主人戳了就戳回去')
  assert.equal(fx.pokes[0].chatKey, 'group:20002')

  // 同一人 3 秒内再戳：不连发
  queue.push({ at: 1_200_002, noticeType: 'poke', groupId: '20002', userId: '10000001', targetId: '777' })
  fx.now.advance(1_000)
  await fx.inbox.tick()
  assert.equal(fx.pokes.length, 1, '3 秒内不重复回戳')

  fx.now.advance(5_000)
  queue.push({ at: 1_210_000, noticeType: 'poke', groupId: '20002', userId: '10000001', targetId: '777' })
  await fx.inbox.tick()
  assert.equal(fx.pokes.length, 2, '过了防刷屏窗口就戳回去')
})

test('别复读：投递群消息时带上她最近说过的话，让她换个说法', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-repeat')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-repeat' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [{ id: '81', userId: '222', nickname: '甲', text: '@鱼 又戳', at: 900, parts: [{ kind: 'at', id: '777' }] }] },
  })
  fx.qq.recentSent = () => ['今天第几个了', '额度解了 又戳 今天第几个了']
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1)
  assert.match(fx.delivered[0].text, /你最近在这个群里说过/)
  assert.match(fx.delivered[0].text, /今天第几个了/)
})

test('戳一戳：前四下回戳、第五下警告、第六下说明装死、再往后不刷', async (t) => {
  const world = NOTICE_WORLD()
  const queue = []
  const fx = noticeFixture({ t, world, queue })
  await fx.inbox.tick()

  const pokeAt = (at) => ({ at, noticeType: 'poke', groupId: '20002', userId: '500', targetId: '777' })
  for (const at of [1_300_001, 1_300_002, 1_300_003, 1_300_004, 1_300_005, 1_300_006, 1_300_007]) {
    queue.push(pokeAt(at))
    fx.now.advance(2_000)
    await fx.inbox.tick()
  }
  assert.equal(fx.pokes.length, 4, '前四下各回戳一次')
  // 语义变了（2026-10-26 主人：戳五下再装死，装死也要说明）：第五下警告，第六下说明，第七下起不刷。
  assert.equal(fx.sends.length, 2, '第五下发「别戳了」，第六下说明「不理了」')
  assert.match(fx.sends[0].text, /别戳了/)
  assert.match(fx.sends[1].text, /不理了/)
})

test('别人戳的不是鱼自己时不回戳；关掉发送后完全不回', async (t) => {
  const world = NOTICE_WORLD()
  const queue = []
  const fx = noticeFixture({ t, world, queue, chat: { sendMessage: false } })
  await fx.inbox.tick()

  queue.push({ at: 1_400_001, noticeType: 'poke', groupId: '20002', userId: '10000001', targetId: '888' })
  await fx.inbox.tick()
  assert.equal(fx.pokes.length, 0, '发送关着就不回')
})

test('自动回戳默认关：没逐项打开就不擅自戳回去', async (t) => {
  const world = NOTICE_WORLD()
  const queue = []
  // autoPokeBack 缺省（等同 false），这是会被真人看见的社交动作
  const fx = noticeFixture({ t, world, queue, chat: { autoPokeBack: undefined } })
  await fx.inbox.tick()
  queue.push({ at: 1_500_001, noticeType: 'poke', groupId: '20002', userId: '10000001', targetId: '777' })
  await fx.inbox.tick()
  assert.equal(fx.pokes.length, 0)
  assert.equal(fx.sends.length, 0)
})

test('被戳时说一句话：投进群会话让她自己回，而不是只回戳', async (t) => {
  const world = NOTICE_WORLD()
  const queue = []
  // 只开「说话」、关掉「回戳」
  const fx = noticeFixture({ t, world, queue, chat: { pokeTalk: true, autoPokeBack: false } })
  await fx.inbox.tick()
  queue.push({ at: 1_600_001, noticeType: 'poke', groupId: '20002', userId: '500', nickname: '阿明', targetId: '777' })
  fx.now.advance(2_000)
  await fx.inbox.tick()
  assert.equal(fx.pokes.length, 0, '只说话，不回戳')
  assert.equal(fx.delivered.length, 1, '「有人戳你」要投进这个群的会话')
  assert.match(fx.delivered[0].text, /戳一戳/)
  assert.equal(fx.delivered[0].sessionId, 'session-grouproom')
})

test('两个开关都开：先说一句，再戳回去', async (t) => {
  const world = NOTICE_WORLD()
  const queue = []
  const fx = noticeFixture({ t, world, queue, chat: { pokeTalk: true, autoPokeBack: true } })
  await fx.inbox.tick()
  queue.push({ at: 1_650_001, noticeType: 'poke', groupId: '20002', userId: '10000001', targetId: '777' })
  fx.now.advance(2_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1, '先说一句')
  assert.equal(fx.pokes.length, 1, '再戳回去')
})

test('白名单是整群：群友（不只是主人）说话都能进她的会话', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-all')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-all' }])
  world.markChatSeen('group:20002', { at: 500 })
  const rows = { 'group:20002': [] }
  const fx = inboxFixture({
    world,
    clock,
    rows,
    platforms: { platform: () => ({ enabled: true, readHistory: true, historyLimit: 20, groupReplyMode: 'frenzy' }) },
  })
  const speakers = ['601', '602', '603']
  for (let i = 0; i < speakers.length; i++) {
    rows['group:20002'].push({ id: String(700 + i), userId: speakers[i], nickname: '群友' + speakers[i], text: '大家好', at: 1000 + i, parts: [] })
    await fx.inbox.tick()
    clock.advance(20_000)
    await fx.inbox.tick()
  }
  assert.equal(fx.delivered.length, 3, '三个群友各投一次：白名单按整群算，不按关系表挑人')
  assert.deepEqual(fx.delivered.map((m) => String(m.userId)), speakers)
})

test('「没说完」判定：收在逗号/省略号/语气词或很短都算没说完', () => {
  for (const text of ['我想想，', '那个……', '然后——', '在吗', '嗯', '好吧呀']) {
    assert.equal(looksUnfinished(text), true, `${text} 应该算没说完`)
  }
  for (const text of ['今天下午三点开会，记得带材料。', '我已经把报告写完了，你看一下有没有问题。']) {
    assert.equal(looksUnfinished(text), false, `${text} 应该算说完了`)
  }
})

test('开口前摆出「此刻的现场」：别人的发言当背景，但不算这一批', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-14')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom14' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      // 前面几句是别人在聊别的事：她没被 @，但需要看懂现场
      { id: 'd1', userId: '222', nickname: '甲', text: '今晚那个副本还去吗', at: 900, parts: [] },
      { id: 'd2', userId: '333', nickname: '乙', text: '去啊，八点集合', at: 920, parts: [] },
      // 真正叫到她的那句
      { id: 'd3', userId: '444', nickname: '丙', text: '@鱼 你来不来', at: 950, parts: [{ kind: 'at', id: '777' }] },
      // 鱼自己说的不能算现场
      { id: 'd4', userId: '777', nickname: '鱼', text: '我看情况', at: 960, parts: [] },
    ] },
    batch: { liveContextCount: 5 },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1)
  const text = fx.delivered[0].text
  assert.match(text, /此刻群里的现场/, '要摆出背景')
  assert.match(text, /今晚那个副本还去吗/, '别人刚才聊的内容要能看到')
  assert.match(text, /八点集合/)
  assert.match(text, /只是背景/, '明确说明这些不是要回的对象')
  assert.equal(text.includes('我看情况'), false, '鱼自己说的话不算现场')
  assert.equal(fx.delivered[0].count, 1, '背景不算进这一批')
})

test('liveContextCount=0 时不摆现场（主人可以关掉）', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-15')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom15' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      { id: 'e1', userId: '222', nickname: '甲', text: '闲聊一句', at: 900, parts: [] },
      { id: 'e2', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 950, parts: [{ kind: 'at', id: '777' }] },
    ] },
    batch: { liveContextCount: 0 },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1)
  assert.equal(fx.delivered[0].text.includes('此刻群里的现场'), false)
})

test('群公告：首轮只对齐，之后新发的才投一次，重复的不再投', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-9')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom9' }])
  const base = { enabled: true, readHistory: true, groupNotice: true, historyLimit: 20 }
  const fx = inboxFixture({ world, clock, rows: {}, platforms: { platform: () => ({ ...base }) } })

  fx.qq.notices = [{ id: 'n1', senderId: '188320593', at: 1_000_000, text: '老的公告', pinned: true }]
  const first = await fx.inbox.tick()
  assert.equal(first.delivered, 0, '第一次碰到这个群只记时间，不投陈年公告')
  assert.equal(fx.delivered.length, 0)

  fx.qq.notices = [
    { id: 'n1', senderId: '188320593', at: 1_000_000, text: '老的公告', pinned: true },
    { id: 'n2', senderId: '188320593', at: 1_000_000 + 5000, text: '周五停服维护', pinned: false },
  ]
  const second = await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1, '新公告投一次')
  assert.match(fx.delivered[0].text, /系统事件/)
  assert.match(fx.delivered[0].text, /周五停服维护/)
  assert.equal(fx.delivered[0].chatKey, 'group:20002')
  assert.equal(fx.delivered[0].sessionId, 'session-grouproom9')

  const third = await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1, '同一条公告不重复投')
  assert.ok(third.notices >= 0)
  assert.deepEqual(fx.qq.noticeCalls, ['20002', '20002', '20002'])
})

test('群公告：开关关着就一次都不问协议端', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-10')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom10' }])
  const base = { enabled: true, readHistory: true, groupNotice: false, historyLimit: 20 }
  const fx = inboxFixture({ world, clock, rows: {}, platforms: { platform: () => ({ ...base }) } })
  await fx.inbox.tick()
  assert.deepEqual(fx.qq.noticeCalls, [])
})

test('视频：抽帧开着就把胶片条当图片一起投，关着就说明看不到画面', async () => {
  const videoRow = {
    id: '21', userId: '444', nickname: '丙', text: '@鱼 看这个', at: 5000,
    parts: [{ kind: 'at', id: '777' }, { kind: 'text', text: '看这个' }],
    videos: [{ url: 'http://x/v.mp4', name: '群里的视频' }],
  }
  const seed = () => ({
    'group:20002': [
      { id: '20', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 1000, parts: [{ kind: 'at', id: '777' }, { kind: 'text', text: '在吗' }] },
    ],
  })

  // 开着：会去要一张胶片条，塞进 images
  const made = []
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-11')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom11' }])
  const rows = seed()
  const on = inboxFixture({
    world, clock: fakeClock(), rows,
    batch: { batchEnabled: false, videoFrames: true },
    videoFrames: {
      async fromUrl(video) { made.push(video.url); return { ok: true, path: 'D:/大肥鱼/鱼的世界/.fish-world/视频帧/视频帧-abc.png', durationSec: 3, frames: 6 } },
    },
  })
  await on.inbox.tick()                       // 首轮只对齐游标
  rows['group:20002'].push(videoRow)          // 对齐之后才来的视频
  await on.inbox.tick()
  const sent = on.delivered[0]
  assert.ok(sent, '应该投出一条')
  assert.deepEqual(made, ['http://x/v.mp4'])
  assert.ok(Array.isArray(sent.images) && sent.images.some((image) => String(image.file || '').includes('视频帧-abc.png')), '胶片条要进 images')
  assert.match(sent.text, /〔视频 3\.0s，抽了 6 帧〕/)

  // 关着：不抽，但要说明看不到画面，不许当成看过了
  const world2 = worldWith(bindWorkspace(), '10000001', 'session-owner-12')
  world2.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom12' }])
  const rows2 = seed()
  const off = inboxFixture({
    world: world2, clock: fakeClock(), rows: rows2,
    batch: { batchEnabled: false, videoFrames: false },
    videoFrames: { async fromUrl() { throw new Error('不该被调用') } },
  })
  await off.inbox.tick()
  rows2['group:20002'].push(videoRow)
  await off.inbox.tick()
  const offSent = off.delivered[0]
  assert.ok(offSent)
  assert.match(offSent.text, /抽帧没开/)
  assert.ok(!(offSent.images || []).some((image) => String(image.file || '').includes('视频帧')))
})

test('合并转发：展开开着就摊开原文，关着就说明看不到内容', async () => {
  const forwardRow = {
    id: '31', userId: '444', nickname: '丙', text: '@鱼 看这个记录', at: 5000,
    parts: [{ kind: 'at', id: '777' }, { kind: 'text', text: '看这个记录' }, { kind: 'forward', label: '聊天记录', id: 'f1' }],
  }
  const seed = () => ({
    'group:20002': [{ id: '30', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 1000, parts: [{ kind: 'at', id: '777' }] }],
  })
  const entries = [
    { nickname: '甲', text: '第一句' },
    { nickname: '乙', text: '', parts: [{ kind: 'image' }] },
    { nickname: '甲', text: '第三句' },
  ]

  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-13')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom13' }])
  const rows = seed()
  const on = inboxFixture({ world, clock: fakeClock(), rows, batch: { batchEnabled: false, forwardExpand: true } })
  on.qq.forwards.f1 = { ok: true, entries }
  await on.inbox.tick()
  rows['group:20002'].push(forwardRow)
  await on.inbox.tick()
  const sent = on.delivered[0]
  assert.ok(sent)
  assert.match(sent.text, /〔以下是合并转发的聊天记录，一共 3 条/)
  assert.match(sent.text, /甲：第一句/)
  assert.match(sent.text, /乙：\[图片\]/)
  assert.match(sent.text, /别逐条复述/)

  // 关着：不展开，但要说明看不到
  const world2 = worldWith(bindWorkspace(), '10000001', 'session-owner-14')
  world2.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom14' }])
  const rows2 = seed()
  const off = inboxFixture({ world: world2, clock: fakeClock(), rows: rows2, batch: { batchEnabled: false, forwardExpand: false } })
  await off.inbox.tick()
  rows2['group:20002'].push(forwardRow)
  await off.inbox.tick()
  assert.match(off.delivered[0].text, /展开没开/)

  // 展开失败：如实说失败，别装作没有
  const world3 = worldWith(bindWorkspace(), '10000001', 'session-owner-15')
  world3.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom15' }])
  const rows3 = seed()
  const bad = inboxFixture({ world: world3, clock: fakeClock(), rows: rows3, batch: { batchEnabled: false, forwardExpand: true } })
  bad.qq.forwards.f1 = { ok: false, reason: 'get_forward_msg 失败' }
  await bad.inbox.tick()
  rows3['group:20002'].push(forwardRow)
  await bad.inbox.tick()
  assert.match(bad.delivered[0].text, /聊天记录展开失败：get_forward_msg 失败/)
})

// 语义变更（2026-10-27）：卡片不再只摊前 20 条 / 1200 字，主人要的是「卡片内全部内容」。
test('合并转发：卡片里有多少条就摊多少条，不再卡 20 条 / 1200 字', async () => {
  const forwardRow = {
    id: '33', userId: '444', nickname: '丙', text: '@鱼 看记录', at: 5000,
    parts: [{ kind: 'at', id: '777' }, { kind: 'forward', label: '聊天记录', id: 'f3' }],
  }
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-17')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom17' }])
  const rows = { 'group:20002': [{ id: '30', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 1000, parts: [{ kind: 'at', id: '777' }] }] }
  const fx = inboxFixture({ world, clock: fakeClock(), rows, batch: { batchEnabled: false, forwardExpand: true } })
  // 30 条、合计远超原来的 1200 字上限
  fx.qq.forwards.f3 = {
    ok: true,
    entries: Array.from({ length: 30 }, (_, i) => ({ nickname: '甲', text: `第 ${i + 1} 句` + '字'.repeat(60) })),
  }
  await fx.inbox.tick()
  rows['group:20002'].push(forwardRow)
  await fx.inbox.tick()
  const sent = fx.delivered[0]
  assert.ok(sent)
  assert.match(sent.text, /一共 30 条/)
  assert.match(sent.text, /第 30 句/, '最后一条也要摊开，不能卡在 20 条')
  assert.doesNotMatch(sent.text, /还有 \d+ 条没展开/)
})

// 攒批是默认路径：以前这里会把正文裁到 400 字 / 3000 字，展开等于白展开。
test('合并转发：攒批投递不把整张卡片按 3000 字截断', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-18')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom18' }])
  const rows = { 'group:20002': [{ id: '30', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 1000, parts: [{ kind: 'at', id: '777' }] }] }
  const fx = inboxFixture({ world, clock, rows, batch: { batchEnabled: true, forwardExpand: true } })
  fx.qq.forwards.f4 = {
    ok: true,
    entries: Array.from({ length: 80 }, (_, i) => ({ nickname: '乙', text: `第 ${i + 1} 行` + '内容'.repeat(30) })),
  }
  await fx.inbox.tick()
  rows['group:20002'].push({
    id: '34', userId: '444', nickname: '丙', text: '@鱼 看记录', at: 5000,
    parts: [{ kind: 'at', id: '777' }, { kind: 'forward', label: '聊天记录', id: 'f4' }],
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  const sent = fx.delivered[0]
  assert.ok(sent)
  assert.ok(sent.text.length > 3000, '整张卡片不该被 3000 字的聊天上限截掉')
  assert.match(sent.text, /第 80 行/, '卡片最后一行也要在')
})

test('合并转发里的图跟着一起投递，不只是摊开文字', async () => {
  const forwardRow = {
    id: '32', userId: '444', nickname: '丙', text: '@鱼 看图', at: 5000,
    parts: [{ kind: 'at', id: '777' }, { kind: 'forward', label: '聊天记录', id: 'f2' }],
  }
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-16')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom16' }])
  const rows = { 'group:20002': [{ id: '30', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 1000, parts: [{ kind: 'at', id: '777' }] }] }
  const left = inboxFixture({ world, clock: fakeClock(), rows, batch: { batchEnabled: false, forwardExpand: true } })
  left.qq.forwards.f2 = {
    ok: true,
    entries: [
      { nickname: '甲', text: '这张', parts: [{ kind: 'text', text: '这张' }], images: [{ url: 'https://x/rec.png' }] },
    ],
  }
  await left.inbox.tick()
  rows['group:20002'].push(forwardRow)
  await left.inbox.tick()
  const sent = left.delivered[0]
  assert.ok(sent)
  assert.ok(Array.isArray(sent.images) && sent.images.some((image) => image.url === 'https://x/rec.png'), '记录里的图要进 images')
  assert.match(sent.text, /张图一并给你了/)
})

test('别人回复/引用的原文会摆在她面前；关了引用开关就不取', async () => {
  const seed = { 'group:20002': [{ id: '30', userId: '444', nickname: '丙', text: '@鱼 在吗', at: 1000, parts: [{ kind: 'at', id: '777' }] }] }
  const row = {
    id: '33', userId: '444', nickname: '丙', text: '@鱼 你说的这个', at: 5000,
    parts: [{ kind: 'at', id: '777' }, { kind: 'text', text: '你说的这个' }, { kind: 'reply', label: '回复', id: '88' }],
  }

  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-17')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom17' }])
  const rows = JSON.parse(JSON.stringify(seed))
  const on = inboxFixture({ world, clock: fakeClock(), rows, batch: { batchEnabled: false } })
  on.qq.quote = async (id) => ({ ok: true, id, nickname: '甲', userId: '1', text: '我昨天说的那句', parts: [{ kind: 'text', text: '我昨天说的那句' }], images: [] })
  await on.inbox.tick()
  rows['group:20002'].push(row)
  await on.inbox.tick()
  assert.match(on.delivered[0].text, /〔甲 之前说的是：「我昨天说的那句」〕/)

  const world2 = worldWith(bindWorkspace(), '10000001', 'session-owner-18')
  world2.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom18' }])
  const rows2 = JSON.parse(JSON.stringify(seed))
  const base = { enabled: true, readHistory: true, sendMessage: true, groupReplyMode: 'shy', historyLimit: 20, quoteExpand: false, batchEnabled: false }
  const off = inboxFixture({ world: world2, clock: fakeClock(), rows: rows2, batch: { batchEnabled: false }, platforms: { platform: () => base } })
  off.qq.quote = async () => { throw new Error('关着就不该问协议端') }
  await off.inbox.tick()
  rows2['group:20002'].push(row)
  await off.inbox.tick()
  assert.doesNotMatch(off.delivered[0].text, /之前说的是/)
})

test('白名单：外群的群公告、撤回、戳一概不算「收到」', () => {
  const 允许 = new Set(['group:20002', 'private:10000001'])
  assert.equal(eventAllowed('group:20002', 允许), true)
  assert.equal(eventAllowed('private:10000001', 允许), true)
  // 账号在别的群里也能收到事件推送，但那不是我们的会话
  assert.equal(eventAllowed('group:1127271724', 允许), false)
  assert.equal(eventAllowed('private:999999', 允许), false)
  assert.equal(eventAllowed('', 允许), false)
  assert.equal(eventAllowed('group:20002', []), false)
})

test('外群的事件真的不会进流水：戳不回、撤回不投、不记账', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-16')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom16' }])
  const fx = inboxFixture({ world, clock, rows: {}, batch: { batchEnabled: false } })

  // 手动喂一份事件队列：一条外群的戳、一条外群的撤回、一条白名单群里的撤回
  const savedFetch = globalThis.fetch
  let now = Date.now()
  const events = []
  globalThis.fetch = async () => ({ json: async () => ({ now, events }) })
  try {
    await fx.inbox.tick()                       // 首轮只对齐
    now += 1000
    events.push(
      { at: now, noticeType: 'notify', subType: 'poke', groupId: '1127271724', userId: '3794235976', targetId: '457310173', nickname: '外群的人' },
      { at: now, noticeType: 'group_recall', groupId: '1127271724', userId: '3794235976', operatorId: '3794235976', nickname: '外群的人' },
      { at: now, noticeType: 'group_recall', groupId: '20002', userId: '444', operatorId: '444', nickname: '白名单群的人' },
    )
    await fx.inbox.tick()
  } finally {
    globalThis.fetch = savedFetch
  }

  assert.deepEqual(fx.qq.calls || [], [], '外群的戳不许回戳')
  const texts = fx.delivered.map((m) => m.text).join(' | ')
  assert.match(texts, /白名单群的人/, '白名单群的撤回要投')
  assert.ok(!/外群的人/.test(texts), '外群的撤回不许投进会话')
  assert.ok(!fx.activity.some((row) => /外群的人/.test(row.text || '')), '外群的事件不许记账')
})

test('群聊可以调只读工具，有副作用的动作仍然拦着', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-chatonly')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-chatonly' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [{ id: '801', userId: '500', nickname: '甲', text: '@鱼 在吗', at: 900, parts: [{ kind: 'at', id: '777' }] }] },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1)
  // 语义变了（2026-10-26）：从「一律别调工具」改成「只读的可以、有副作用的别做」。
  assert.match(fx.delivered[0].text, /群聊：优先聊天/, '群里要说明可以调只读工具')
  assert.match(fx.delivered[0].text, /写日记\/记忆\/愿望\/成长、发空间这类有副作用的动作别在群里做/)

  const clock2 = fakeClock()
  const world2 = worldWith(bindWorkspace(), '10000001', 'session-owner-chatonly2')
  world2.updateChats([{ chatKey: 'private:222333', sessionId: 'session-friend-chatonly' }])
  world2.markChatSeen('private:222333', { at: 500 })
  const fx2 = inboxFixture({
    world: world2,
    clock: clock2,
    rows: { 'private:222333': [{ id: '802', userId: '222333', nickname: '阿明', text: '在吗', at: 900, parts: [] }] },
  })
  await fx2.inbox.tick()
  clock2.advance(20_000)
  await fx2.inbox.tick()
  assert.equal(fx2.delivered.length, 1)
  assert.doesNotMatch(fx2.delivered[0].text, /群聊只聊天/, '私聊不该被这条约束住')
})

test('群友记忆按 QQ 号落盘：只记她真回过的，旁听不写', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-pm')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-pm' }])
  world.markChatSeen('group:20002', { at: 500 })
  const rows = { 'group:20002': [
    { id: '901', userId: '500', nickname: '阿明', text: '@鱼 你会对战吗', at: 900, parts: [{ kind: 'at', id: '777' }] },
    { id: '902', userId: '600', nickname: '路人', text: '今天吃什么', at: 901, parts: [] },
  ] }
  const fx = inboxFixture({
    world,
    clock,
    rows,
    platforms: { platform: () => ({ enabled: true, readHistory: true, sendMessage: true, groupReplyMode: 'shy', historyLimit: 20 }) },
  })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1, '只有被 @ 的那句投进来')
  await fx.inbox.onTurnEnd({ sessionId: 'session-grouproom-pm', text: '我只会嘴上打' })

  const root = world.status().worldPath
  const saved = JSON.parse(readFileSync(join(root, '鱼的记忆', '群友', '500.json'), 'utf8'))
  assert.equal(saved.exchanges.length, 1)
  assert.match(saved.exchanges[0].he, /你会对战吗/)
  assert.equal(saved.exchanges[0].she, '我只会嘴上打')
  assert.equal(existsSync(join(root, '鱼的记忆', '群友', '600.json')), false, '旁听的那位不该有记忆')

  // 她没回话时也不写（只投递不算聊过）
  const clock2 = fakeClock()
  const world2 = worldWith(bindWorkspace(), '10000001', 'session-owner-pm2')
  world2.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-pm2' }])
  world2.markChatSeen('group:20002', { at: 500 })
  const fx2 = inboxFixture({
    world: world2,
    clock: clock2,
    rows: { 'group:20002': [{ id: '903', userId: '501', nickname: '甲', text: '@鱼 在吗', at: 900, parts: [{ kind: 'at', id: '777' }] }] },
  })
  await fx2.inbox.tick()
  clock2.advance(20_000)
  await fx2.inbox.tick()
  assert.equal(existsSync(join(world2.status().worldPath, '鱼的记忆', '群友', '501.json')), false)
})

test('再遇见时把上次聊过的内容带上；第一次见面什么都不带', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-pm3')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-pm3' }])
  world.markChatSeen('group:20002', { at: 500 })
  const rows = { 'group:20002': [{ id: '911', userId: '502', nickname: '阿明', text: '@鱼 你会对战吗', at: 900, parts: [{ kind: 'at', id: '777' }] }] }
  const fx = inboxFixture({ world, clock, rows })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.doesNotMatch(fx.delivered[0].text, /以前聊过/, '第一次见面不该有任何记忆')
  await fx.inbox.onTurnEnd({ sessionId: 'session-grouproom-pm3', text: '我只会嘴上打' })

  rows['group:20002'].push({ id: '912', userId: '502', nickname: '阿明', text: '@鱼 那还打不打', at: 1200, parts: [{ kind: 'at', id: '777' }] })
  clock.advance(20_000)
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.match(fx.delivered[1].text, /以前聊过/)
  assert.match(fx.delivered[1].text, /你会对战吗/)
})

test('漏出来的盘算不发进 QQ：只有盘算就整轮不发，夹着真回话只发真回话', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-leak')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-leak' }])
  world.markChatSeen('group:20002', { at: 500 })
  const rows = { 'group:20002': [{ id: '921', userId: '500', nickname: '阿明', text: '@鱼 在吗', at: 900, parts: [{ kind: 'at', id: '777' }] }] }
  const fx = inboxFixture({ world, clock, rows })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.equal(fx.delivered.length, 1)

  const onlyPlanner = await fx.inbox.onTurnEnd({
    sessionId: 'session-grouproom-leak',
    text: 'The user is 阿明. Need to respond as the character: short, in character.',
  })
  assert.equal(onlyPlanner.skipped, 'planner-only')
  assert.equal(fx.qq.calls.length, 0, '纯盘算一个字都不该发出去')

  const mixed = await fx.inbox.onTurnEnd({
    sessionId: 'session-grouproom-leak',
    text: 'Group chat, one person to reply: 阿明. Reply short, in persona.\n\n在 我说了算',
  })
  assert.equal(mixed.ok, true)
  assert.equal(fx.qq.calls.length, 1)
  assert.equal(fx.qq.calls[0].text, '在 我说了算')
})

test('聊满 100 个来回：这一轮请她更新印象，印象行只存不发', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '10000001', 'session-owner-imp')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom-imp' }])
  world.markChatSeen('group:20002', { at: 500 })
  const root = world.status().worldPath
  for (let i = 0; i < 100; i++) {
    noteExchange(root, { qq: '500', nickname: '阿明', heSaid: '话' + i, sheSaid: '回' + i, at: 1793000000000 + i * 1000, chatKey: 'group:20002' })
  }
  const rows = { 'group:20002': [{ id: '931', userId: '500', nickname: '阿明', text: '@鱼 还聊不聊', at: 900, parts: [{ kind: 'at', id: '777' }] }] }
  const fx = inboxFixture({ world, clock, rows })
  await fx.inbox.tick()
  clock.advance(20_000)
  await fx.inbox.tick()
  assert.match(fx.delivered[0].text, /该更新印象了/, '满 100 要请她更新一次')

  const res = await fx.inbox.onTurnEnd({
    sessionId: 'session-grouproom-imp',
    text: '聊 接着聊\n印象：嘴硬，爱接梗，聊游戏的时候会突然认真',
  })
  assert.equal(res.ok, true)
  assert.equal(fx.qq.calls.length, 1)
  assert.doesNotMatch(fx.qq.calls[0].text, /印象/, '印象那一行不能发到群里')
  assert.match(fx.qq.calls[0].text, /接着聊/)
  const saved = JSON.parse(readFileSync(join(root, '鱼的记忆', '群友', '500.json'), 'utf8'))
  assert.match(saved.summary.text, /嘴硬/)
  assert.equal(saved.sinceSummary, 1, '更新后重新计数：这一轮算下一百次的第一回')
})
