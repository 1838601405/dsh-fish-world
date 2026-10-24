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
