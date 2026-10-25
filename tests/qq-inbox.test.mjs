// QQ 聊天窗口：授权目标（chats.json）、按目标收信、攒批再回、回话发回原会话。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWorldStore } from '../lib/world.mjs'
import { createQQInbox, looksUnfinished } from '../lib/qq-inbox.mjs'

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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-1')
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

test('聊天目标校验：非法 chatKey、缺房间、重复、给主人自己再授权都拒绝', () => {
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-1')
  assert.throws(() => world.updateChats([{ chatKey: 'weibo:123456', sessionId: 'session-x1' }]), /无效/)
  assert.throws(() => world.updateChats([{ chatKey: 'group:20002', sessionId: '' }]), /DSH 会话/)
  assert.throws(() => world.updateChats([
    { chatKey: 'group:20002', sessionId: 'session-a1' },
    { chatKey: 'group:20002', sessionId: 'session-b2' },
  ]), /重复/)
  assert.throws(() => world.updateChats([{ chatKey: 'private:1838601405', sessionId: 'session-c3' }]), /主人私聊/)
})

test('停用的目标不参与收信，也不在授权名单里', () => {
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-1')
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

function inboxFixture({ rows = {}, bridge, platforms, world, clock, batch } = {}) {
  const qq = {
    calls: [],
    bridgeConfig: () => bridge || { 私聊QQ: '1838601405', 目标会话: 'session-owner-1' },
    loginInfo: async () => ({ ok: true, userId: '777', nickname: '鱼' }),
    recent: async (chatKey) => ({ ok: true, messages: rows[chatKey] || [] }),
    isMuted: (userId) => String(userId) === '999',
    send: async (chatKey, segments) => {
      qq.calls.push({ chatKey, text: segments[0].text })
      return { ok: true, dryRun: false, sent: [{ kind: chatKey.split(':')[0], id: chatKey.split(':')[1] }] }
    },
  }
  const base = { enabled: true, readHistory: true, sendMessage: true, groupReplyMode: 'mention', historyLimit: 20 }
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
  })
  return { qq, inbox, delivered, activity }
}

const GROUP_ROWS = [
  { id: '11', userId: '222', nickname: '甲', text: '今天天气不错', at: 1000, parts: [{ kind: 'text', text: '今天天气不错' }] },
  { id: '12', userId: '333', nickname: '乙', text: '鱼在吗', at: 2000, parts: [{ kind: 'at', id: '777' }, { kind: 'text', text: '鱼在吗' }] },
]

test('群里只有 @ 到鱼才回话；没点到的进本地留存当旁听', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-1')
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

test('开口档位：never 一条都不回；always 只回跟她有关的那句', async () => {
  const base = { enabled: true, readHistory: true, historyLimit: 20 }
  // 「always」不等于「每句都插嘴」：群里聊别人的事不该回，@ 她或叫到名字才回。
  for (const [mode, expect] of [['never', 0], ['always', 1]]) {
    const clock = fakeClock()
    const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-2')
    world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom2' }])
    // 先把游标推到 0 之前，保证这两条都算「新」
    world.markChatSeen('group:20002', { at: 500 })
    const fx = inboxFixture({
      world,
      clock,
      rows: { 'group:20002': GROUP_ROWS },
      platforms: { platform: () => ({ ...base, groupReplyMode: mode }) },
    })
    await fx.inbox.tick()
    clock.advance(20_000)
    const result = await fx.inbox.tick()
    assert.equal(result.delivered, expect, `${mode} 应投递 ${expect} 次`)
    if (expect) {
      assert.equal(fx.delivered[0].count, 1, '只有 @ 她的那条进这一批')
      assert.match(fx.delivered[0].text, /鱼在吗/)
    }
  }
})

test('always 档位：叫到名字也算找她，闲聊不算', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-2b')
  world.updateChats([{ chatKey: 'group:20002', sessionId: 'session-grouproom2b' }])
  world.markChatSeen('group:20002', { at: 500 })
  const fx = inboxFixture({
    world,
    clock,
    rows: { 'group:20002': [
      { id: '21', userId: '222', nickname: '甲', text: '今天吃什么', at: 900, parts: [] },
      { id: '22', userId: '333', nickname: '乙', text: '大肥鱼你觉得呢', at: 950, parts: [] },
    ] },
    platforms: { platform: () => ({ enabled: true, readHistory: true, historyLimit: 20, groupReplyMode: 'always' }) },
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-3')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-4')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-5')
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

test('关掉「读取历史」或平台总开关后不再轮询', async () => {
  const clock = fakeClock()
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-6')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-7')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-8')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-9')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-10')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-11')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-12')
  world.updateChats([{ chatKey: 'private:222333', sessionId: 'session-friend012' }])
  world.markChatSeen('private:222333', { at: 500 })
  const delivered = []
  let fail = true
  const qq = {
    bridgeConfig: () => ({ 私聊QQ: '1838601405', 目标会话: 'session-owner-12' }),
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-13')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-14')
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
  const world = worldWith(bindWorkspace(), '1838601405', 'session-owner-15')
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
