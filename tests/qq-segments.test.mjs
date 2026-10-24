import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfigStore } from '../lib/config.mjs'
import { classifySegment, createQQ, describeSegments } from '../lib/qq.mjs'
import { buildEcosystemTool } from '../lib/tool.mjs'

function tempHome(bridge) {
  const home = mkdtempSync(join(tmpdir(), 'qce-seg-'))
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true,
    试运行: false,
    转私聊: true,
    私聊QQ: '10001',
    转群: false,
    群号: '',
    NapCat: 'http://127.0.0.1:3000',
    ...bridge,
  }, null, 2), 'utf8')
  return home
}

function withFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original })
}

test('classifySegment 认得动图、表情、聊天记录和其它非文字段', () => {
  assert.deepEqual(classifySegment({ type: 'text', data: { text: '在吗' } }), { kind: 'text', text: '在吗' })
  assert.equal(classifySegment({ type: 'text', data: { text: '' } }), null)

  const gif = classifySegment({ type: 'image', data: { url: 'https://x/a.GIF?x=1', file: 'a.gif' } })
  assert.equal(gif.kind, 'image')
  assert.equal(gif.gif, true)
  assert.equal(gif.label, '动图')

  const animated = classifySegment({ type: 'image', data: { summary: '[动画表情]', url: 'https://x/abc' } })
  assert.equal(animated.gif, true)
  assert.equal(animated.label, '动图')

  const sticker = classifySegment({ type: 'image', data: { sub_type: 1, summary: '[表情包]', url: 'https://x/abc' } })
  assert.equal(sticker.gif, false)
  assert.equal(sticker.label, '表情包')

  const png = classifySegment({ type: 'image', data: { url: 'https://x/a.png' } })
  assert.equal(png.gif, false)
  assert.equal(png.label, '图片')

  assert.equal(classifySegment({ type: 'mface', data: { summary: '[表情]' } }).label, '表情包')
  assert.equal(classifySegment({ type: 'forward', data: { id: '7431' } }).id, '7431')
  assert.equal(classifySegment({ type: 'node', data: { id: '88' } }).label, '聊天记录')
  assert.equal(classifySegment({ type: 'record', data: { file: 'a.amr' } }).label, '语音')
  assert.equal(classifySegment({ type: 'video', data: {} }).label, '视频')
  assert.equal(classifySegment({ type: 'face', data: { id: '178' } }).label, '表情')
  assert.equal(classifySegment({ type: 'json', data: {} }).label, '卡片')
  assert.equal(classifySegment({ type: 'reply', data: { id: '9' } }).label, '回复')
  assert.equal(classifySegment({ type: 'at', data: { qq: '10002' } }).label, '@10002')
  assert.equal(classifySegment({ type: 'weird', data: {} }).label, '未知段:weird')
  assert.equal(classifySegment(null), null)
})

test('describeSegments 只输出非文字段，聊天记录带 id', () => {
  const parts = [
    { kind: 'text', text: '看这个' },
    { kind: 'image', label: '动图', gif: true },
    { kind: 'forward', label: '聊天记录', id: '7431' },
    { kind: 'record', label: '语音' },
  ]
  assert.equal(describeSegments(parts), '[动图] [聊天记录:7431] [语音]')
  assert.equal(describeSegments(undefined), '')
})

test('recent 保留非文字段，不再把聊天记录和语音丢掉', async () => {
  const home = tempHome()
  const store = createConfigStore({ home })
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console })
  const payload = {
    status: 'ok',
    retcode: 0,
    data: {
      messages: [
        {
          message_id: 11,
          user_id: 10001,
          time: 1700000000,
          sender: { nickname: '主人' },
          message: [
            { type: 'text', data: { text: '看这个' } },
            { type: 'image', data: { url: 'https://x/cat.gif', summary: '[动画表情]' } },
            { type: 'forward', data: { id: '7431' } },
            { type: 'record', data: { file: 'a.amr' } },
          ],
        },
      ],
    },
  }
  await withFetch(async () => new Response(JSON.stringify(payload), { status: 200 }), async () => {
    const result = await qq.recent('', 10)
    assert.equal(result.ok, true)
    const [msg] = result.messages
    assert.equal(msg.text, '看这个')
    assert.equal(msg.parts.length, 4)
    assert.equal(msg.parts[1].label, '动图')
    assert.deepEqual(msg.forwards, ['7431'])
    assert.equal(describeSegments(msg.parts), '[动图] [聊天记录:7431] [语音]')
  })
})

test('forward 展开合并转发的聊天记录，并在 id 不被识别时回退 message_id', async () => {
  const home = tempHome()
  const store = createConfigStore({ home })
  const qq = createQQ({ home, config: () => store.getConfig(), logger: console })
  const calls = []
  const reply = (body) => new Response(JSON.stringify(body), { status: 200 })
  await withFetch(async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), body })
    if (body.id && !body.message_id) return reply({ status: 'failed', retcode: 1404, data: null })
    return reply({
      status: 'ok',
      retcode: 0,
      data: {
        messages: [
          { type: 'node', data: { time: 1700000001, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '第一句' } }] } },
          { time: 1700000002, sender: { user_id: 10002 }, message: [{ type: 'text', data: { text: '第二句' } }, { type: 'image', data: { url: 'https://x/b.gif' } }] },
        ],
      },
    })
  }, async () => {
    const record = await qq.forward('7431')
    assert.equal(record.ok, true)
    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /get_forward_msg$/)
    assert.deepEqual(calls[0].body, { id: '7431' })
    assert.deepEqual(calls[1].body, { message_id: '7431' })
    assert.equal(record.entries.length, 2)
    assert.equal(record.entries[0].nickname, '甲')
    assert.equal(record.entries[0].text, '第一句')
    assert.equal(record.entries[1].text, '第二句')
    assert.equal(record.entries[1].parts[1].label, '动图')
  })
})

test('history 标出动图和聊天记录并展开记录内容，forward 可单独读一条', async () => {
  const messages = [
    {
      id: '11',
      chatKey: 'private:10001',
      userId: '10001',
      nickname: '主人',
      text: '看这个',
      parts: [
        { kind: 'text', text: '看这个' },
        { kind: 'image', label: '动图', gif: true },
        { kind: 'forward', label: '聊天记录', id: '7431' },
      ],
      forwards: ['7431'],
      at: 1700000000000,
    },
  ]
  const tool = buildEcosystemTool({
    loader: { status: async () => ({ version: 'test', extensions: [], tools: [], bridge: {}, whale: {} }) },
    qq: {
      recent: async () => ({ ok: true, messages }),
      forward: async (id) => ({
        ok: true,
        id,
        entries: [
          { nickname: '甲', userId: '1', text: '第一句', parts: [{ kind: 'text', text: '第一句' }] },
          { nickname: '乙', userId: '2', text: '', parts: [{ kind: 'image', label: '动图', gif: true }] },
        ],
      }),
    },
    whale: {},
    stickers: {},
    world: { isOwnerSession: () => true },
    qzone: {},
    environment: { status: () => ({ ok: true, packages: [], hints: [] }) },
  })

  const history = await tool.execute({ action: 'history', limit: 5 })
  assert.equal(history.ok, true)
  assert.match(history.content, /主人：看这个 \[动图\] \[聊天记录:7431\]/)
  assert.match(history.content, /↳ 聊天记录 7431（2 条）/)
  assert.match(history.content, /甲：第一句/)
  assert.match(history.content, /乙：\[动图\]/)

  const single = await tool.execute({ action: 'forward', forwardId: '7431' })
  assert.equal(single.ok, true)
  assert.match(single.content, /聊天记录 7431（2 条）/)
  assert.match(single.content, /1\. 甲：第一句/)
})
