import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfigStore } from '../lib/config.mjs'
import { createQQ, parseChatKey, toOneBotSegment } from '../lib/qq.mjs'

function tempHome(bridge) {
  const home = mkdtempSync(join(tmpdir(), 'qce-qq-'))
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify(bridge, null, 2), 'utf8')
  return home
}

function baseBridge(patch = {}) {
  return {
    总开关: true,
    试运行: false,
    转私聊: true,
    私聊QQ: '10001',
    转群: false,
    群号: '',
    NapCat: 'http://127.0.0.1:3000',
    ...patch,
  }
}

test('parseChatKey 支持私聊 / 群 / 默认', () => {
  assert.deepEqual(parseChatKey('private:123'), { kind: 'private', id: '123' })
  assert.deepEqual(parseChatKey('p:123'), { kind: 'private', id: '123' })
  assert.deepEqual(parseChatKey('group:456'), { kind: 'group', id: '456' })
  assert.deepEqual(parseChatKey('g:456'), { kind: 'group', id: '456' })
  assert.deepEqual(parseChatKey('789'), { kind: 'private', id: '789' })
  assert.equal(parseChatKey('').kind, 'default')
  assert.equal(parseChatKey('*').kind, 'all')
  assert.equal(parseChatKey('随便').kind, 'invalid')
})

test('toOneBotSegment 转换常见段', () => {
  assert.deepEqual(toOneBotSegment('hi'), { type: 'text', data: { text: 'hi' } })
  assert.deepEqual(toOneBotSegment({ type: 'at', id: '1' }), { type: 'at', data: { qq: '1' } })
  assert.deepEqual(toOneBotSegment({ type: 'reply', id: '9' }), { type: 'reply', data: { id: '9' } })
  assert.deepEqual(toOneBotSegment({ type: 'image', url: 'https://x/y.png' }), {
    type: 'image',
    data: { file: 'https://x/y.png', url: 'https://x/y.png' },
  })
  assert.throws(() => toOneBotSegment({ type: 'unknown' }), /不支持的段类型/)
})

test('总开关关着时一条都不发', async () => {
  const home = tempHome(baseBridge({ 总开关: false }))
  let called = 0
  const qq = createQQ({ home, config: () => createConfigStore({ home }).getConfig(), logger: console })
  const original = globalThis.fetch
  globalThis.fetch = async () => { called += 1; return new Response('{}') }
  try {
    const receipt = await qq.send('', [{ type: 'text', text: 'hi' }])
    assert.equal(receipt.ok, false)
    assert.equal(receipt.reason, 'bridge-switch-off')
    assert.equal(called, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('试运行只返回 dryRun，不碰 OneBot', async () => {
  const home = tempHome(baseBridge({ 试运行: true }))
  const store = createConfigStore({ home })
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console })
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('不应该请求 OneBot') }
  try {
    const receipt = await qq.send('', [{ type: 'text', text: 'hi' }])
    assert.equal(receipt.ok, true)
    assert.equal(receipt.dryRun, true)
    assert.equal(receipt.reason, 'bridge-trial-mode')
    assert.equal(receipt.sent.length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('真发时按私聊目标调用 send_private_msg', async () => {
  const home = tempHome(baseBridge())
  const store = createConfigStore({ home })
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console })
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }), { status: 200 })
  }
  try {
    const receipt = await qq.send('', [{ type: 'text', text: '你好' }])
    assert.equal(receipt.ok, true)
    assert.equal(receipt.sent.length, 1)
    assert.equal(receipt.sent[0].id, 10001)
    assert.equal(receipt.sent[0].msgId, '42')
    assert.match(calls[0].url, /send_private_msg$/)
    assert.deepEqual(calls[0].body.message, [{ type: 'text', data: { text: '你好' } }])
  } finally {
    globalThis.fetch = original
  }
})

test('OneBot environment access token is sent only as a bearer header', async () => {
  const home = tempHome(baseBridge())
  const store = createConfigStore({ home })
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console })
  const original = globalThis.fetch
  const oldToken = process.env.DSH_ONEBOT_ACCESS_TOKEN
  process.env.DSH_ONEBOT_ACCESS_TOKEN = 'test-token'
  let authorization = ''
  globalThis.fetch = async (_url, init) => {
    authorization = init.headers.authorization || ''
    return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { cookies: 'p_skey=fake' } }))
  }
  try {
    const result = await qq.call('get_cookies', { domain: 'qzone.qq.com' })
    assert.equal(result.ok, true)
    assert.equal(authorization, 'Bearer test-token')
    assert.equal(JSON.stringify(result).includes('test-token'), false)
  } finally {
    globalThis.fetch = original
    if (oldToken == null) delete process.env.DSH_ONEBOT_ACCESS_TOKEN
    else process.env.DSH_ONEBOT_ACCESS_TOKEN = oldToken
  }
})

test('默认禁止发到 bridge 之外的群', async () => {
  const home = tempHome(baseBridge({ 转群: true, 群号: '20002' }))
  const store = createConfigStore({ home })
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console })
  const receipt = await qq.send('group:99999', [{ type: 'text', text: 'hi' }])
  assert.equal(receipt.ok, false)
  assert.equal(receipt.failed[0].reason, 'foreign-target')
})

// 桥只盯一个群号，鱼要在别的群里说话，靠主人把那个群授权成聊天目标。
// 一律替换 globalThis.fetch：本机 3000 端口可能真挂着一个 QQ 后端，测试不能碰它。
function mockFetch(t) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ action: String(url).split('/').pop(), body: JSON.parse(init.body || '{}') })
    return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }), { status: 200 })
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

test('授权过的群可以发言，即使桥的转群没开', async (t) => {
  const home = tempHome(baseBridge({ 转群: false, 群号: '' }))
  const store = createConfigStore({ home })
  const chatSource = () => [{ chatKey: 'group:20002', kind: 'group', id: '20002', sessionId: 'session-room1' }]
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console, chatSource })
  const calls = mockFetch(t)
  const receipt = await qq.send('group:20002', [{ type: 'text', text: '群里说一声' }])
  assert.equal(receipt.ok, true, JSON.stringify(receipt.failed))
  assert.equal(receipt.sent[0].kind, 'group')
  assert.equal(receipt.sent[0].id, 20002)
  assert.equal(calls[0].action, 'send_group_msg')
  assert.equal(calls[0].body.group_id, 20002)
})

test('授权只放开目标这一层：桥的总开关与试运行仍然优先', async () => {
  const chatSource = () => [{ chatKey: 'group:20002', kind: 'group', id: '20002', sessionId: 'session-room1' }]

  const off = tempHome(baseBridge({ 总开关: false, 转群: false, 群号: '' }))
  const offQq = createQQ({ home: off, config: () => createConfigStore({ home: off }).getConfig(), logger: console, chatSource })
  const blocked = await offQq.send('group:20002', [{ type: 'text', text: 'hi' }])
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'bridge-switch-off', '总开关关着，授权也不该发出去')

  const trial = tempHome(baseBridge({ 试运行: true, 转群: false, 群号: '' }))
  const trialQq = createQQ({ home: trial, config: () => createConfigStore({ home: trial }).getConfig(), logger: console, chatSource })
  const dry = await trialQq.send('group:20002', [{ type: 'text', text: 'hi' }])
  assert.equal(dry.dryRun, true, '试运行仍然只记账，不真发')
})

// 发送侧的节奏与额度由鱼世界执行（桥只管总开关 / 试运行 / 转私聊 / 转群）。
// 记账只有一处：qq.send 成功后写一条 send，收件箱不再重复写。
function qqWithSettings(chatConfig, journalState) {
  const home = tempHome(baseBridge({ 转群: false, 群号: '' }))
  const store = createConfigStore({ home })
  const chatSource = () => [{ chatKey: 'group:20002', kind: 'group', id: '20002', sessionId: 'session-room1' }]
  const qq = createQQ({
    home,
    config: () => store.getConfig(),
    logger: { info() {} },
    chatSource,
    platforms: { platform: () => chatConfig },
    journal: journalState,
  })
  return qq
}

test('成功的发送记一条本地留存；到量后拒发并说明', async (t) => {
  mockFetch(t)
  const booked = []
  const counter = { count: 0, append(row) { booked.push(row); this.count += 1 }, countToday() { return this.count } }
  const qq = qqWithSettings({ dailyMessages: 2, minSendIntervalSec: 0, maxCharsPerMessage: 0 }, counter)

  const first = await qq.send('group:20002', [{ type: 'text', text: '群里说一声' }])
  assert.equal(first.ok, true)
  assert.equal(booked.length, 1, '发成功一条记一条')
  assert.equal(booked[0].platform, 'qq')
  assert.equal(booked[0].kind, 'send')
  assert.match(booked[0].text, /发到 group:20002：群里说一声/)

  counter.count = 2
  const capped = await qq.send('group:20002', [{ type: 'text', text: '再来一条' }])
  assert.equal(capped.ok, false)
  assert.match(capped.reason, /daily-limit/, '到量就拒发，并说明是额度')
  assert.match(capped.reason, /2\/2/)
  assert.equal(booked.length, 1, '被额度挡下的不记账')
})

test('发送间隔没到就拒发', async (t) => {
  mockFetch(t)
  const silent = { append() {}, countToday: () => 0 }
  const gap = qqWithSettings({ dailyMessages: 0, minSendIntervalSec: 60, maxCharsPerMessage: 0 }, silent)
  const ok = await gap.send('group:20002', [{ type: 'text', text: '第一句' }])
  assert.equal(ok.ok, true)
  const tooSoon = await gap.send('group:20002', [{ type: 'text', text: '第二句' }])
  assert.equal(tooSoon.ok, false)
  assert.match(tooSoon.reason, /send-interval/, '上一条才刚发，这条要等')
})

test('裁断只动文字段，图片段原样保留', async (t) => {
  const calls = mockFetch(t)
  const silent = { append() {}, countToday: () => 0 }
  const qq = qqWithSettings({ dailyMessages: 0, minSendIntervalSec: 0, maxCharsPerMessage: 6 }, silent)
  // 图片段要走 sendImage 认的形状（url / localPath / base64 之一），不要手填 data.url
  await qq.send('group:20002', [
    { type: 'text', text: '一二三四五六七八九十' },
    { type: 'image', url: 'http://example.com/a.png' },
  ])
  const message = calls[0].body.message
  const text = message.find((seg) => seg.type === 'text')
  const image = message.find((seg) => seg.type === 'image')
  assert.equal(text.data.text, '一二三四五…', '按字数裁并加省略号')
  assert.ok(text.data.text.length <= 6, '裁完不能超过上限（省略号也算字数）')
  assert.equal(image.data.url, 'http://example.com/a.png', '图片段不能被动到')
})

test('多段文字按顺序保前面那段，不被后面的字挤掉', async (t) => {
  const calls = mockFetch(t)
  const silent = { append() {}, countToday: () => 0 }
  const qq = qqWithSettings({ dailyMessages: 0, minSendIntervalSec: 0, maxCharsPerMessage: 8 }, silent)
  await qq.send('group:20002', [
    { type: 'text', text: '先说的这句很重要' },
    { type: 'text', text: '后面补的话' },
  ])
  const texts = calls[0].body.message.filter((seg) => seg.type === 'text')
  // 8 个字的上限配 8 个字的正文：正好放得下，整句原样保留，不该画蛇添足加省略号。
  assert.equal(texts[0].data.text, '先说的这句很重要', '放得下就整句保留')
  assert.equal(texts.length, 1, '额度用完后面的段要清掉，不能发出空消息段')
})

test('第一段放不下时裁第一段，而不是留着尾巴换内容', async (t) => {
  const calls = mockFetch(t)
  const silent = { append() {}, countToday: () => 0 }
  const qq = qqWithSettings({ dailyMessages: 0, minSendIntervalSec: 0, maxCharsPerMessage: 8 }, silent)
  await qq.send('group:20002', [
    { type: 'text', text: '先说的这句很长会被裁' },
    { type: 'text', text: '后面补的话' },
  ])
  const texts = calls[0].body.message.filter((seg) => seg.type === 'text')
  assert.equal(texts[0].data.text, '先说的这句很长…', '保开头、加省略号，总长正好等于上限')
  assert.equal(texts.length, 1)
})

test('授权过的好友私聊同样能发；未授权仍被拒', async (t) => {
  const home = tempHome(baseBridge({ 私聊QQ: '10001', 转私聊: true }))
  const store = createConfigStore({ home })
  const chatSource = () => [{ chatKey: 'private:222333', kind: 'private', id: '222333', sessionId: 'session-room2' }]
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console, chatSource })
  const calls = mockFetch(t)

  const ok = await qq.send('private:222333', [{ type: 'text', text: '在吗' }])
  assert.equal(ok.ok, true, JSON.stringify(ok.failed))
  assert.equal(calls[0].action, 'send_private_msg')
  assert.equal(calls[0].body.user_id, 222333)

  const denied = await qq.send('private:999888', [{ type: 'text', text: 'hi' }])
  assert.equal(denied.ok, false)
  assert.equal(denied.failed[0].reason, 'foreign-target')
})

test('发表情默认带 sub_type=1，客户端按小表情渲染', async (t) => {
  const calls = mockFetch(t)
  const silent = { append() {}, countToday: () => 0 }
  const qq = qqWithSettings({ dailyMessages: 0, minSendIntervalSec: 0, maxCharsPerMessage: 0, stickerSubType: 1 }, silent)
  await qq.sendSticker('group:20002', { url: 'http://example.com/sticker.png' })
  const image = calls[0].body.message.find((seg) => seg.type === 'image')
  // 不带这个字段协议端会按普通图片处理，收藏库那种 1080×1080 的图会撑满气泡。
  assert.equal(image.data.sub_type, 1)
})

test('stickerSubType=0 时按普通图片发（主人可以改回去）', async (t) => {
  const calls = mockFetch(t)
  const silent = { append() {}, countToday: () => 0 }
  const qq = qqWithSettings({ dailyMessages: 0, minSendIntervalSec: 0, maxCharsPerMessage: 0, stickerSubType: 0 }, silent)
  await qq.sendSticker('group:20002', { url: 'http://example.com/sticker.png' })
  const image = calls[0].body.message.find((seg) => seg.type === 'image')
  assert.equal(image.data.sub_type, 0)
})

test('普通图片不带 sub_type，别把照片当表情发', async (t) => {
  const calls = mockFetch(t)
  const silent = { append() {}, countToday: () => 0 }
  const qq = qqWithSettings({ dailyMessages: 0, minSendIntervalSec: 0, maxCharsPerMessage: 0 }, silent)
  await qq.sendImage('group:20002', { url: 'http://example.com/photo.png' })
  const image = calls[0].body.message.find((seg) => seg.type === 'image')
  assert.equal('sub_type' in image.data, false)
})
