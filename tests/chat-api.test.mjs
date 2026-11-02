import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createChatApi, normalizeChatApi, normalizeChatBaseUrl, shouldUseChatApi } from '../lib/chat-api.mjs'

test('baseUrl：本机 http 可以，非本机 http 退回默认，https 可以', () => {
  assert.equal(normalizeChatBaseUrl('http://127.0.0.1:3425/v1'), 'http://127.0.0.1:3425/v1')
  assert.equal(normalizeChatBaseUrl('http://example.com/v1'), 'http://127.0.0.1:3425/v1')
  assert.equal(normalizeChatBaseUrl('https://example.com/v1'), 'https://example.com/v1')
  assert.equal(normalizeChatBaseUrl('https://user:pass@example.com/v1'), 'http://127.0.0.1:3425/v1')
})

test('normalizeChatApi：默认值与夹取', () => {
  const c = normalizeChatApi({})
  assert.equal(c.enabled, true)
  assert.equal(c.maxTokens, 800)
  assert.equal(normalizeChatApi({ maxTokens: 999999 }).maxTokens, 8192)
  assert.equal(normalizeChatApi({ temperature: 9 }).temperature, 2)
  assert.equal(normalizeChatApi({ historyLimit: -1 }).historyLimit, 0)
})

test('路由：主人私聊走 DSH，群聊 / 好友走 API', () => {
  assert.equal(shouldUseChatApi({ kind: 'private', userId: '10000001', ownerQQ: '10000001', enabled: true }), false)
  assert.equal(shouldUseChatApi({ kind: 'private', userId: '10000002', ownerQQ: '10000001', enabled: true }), true)
  assert.equal(shouldUseChatApi({ kind: 'group', userId: '10000001', ownerQQ: '10000001', enabled: true }), true)
  assert.equal(shouldUseChatApi({ kind: 'group', userId: '1', ownerQQ: '1', enabled: false }), false)
})

test('reply：带密钥、打到 /chat/completions、返回文本', async () => {
  process.env.FW_CHAT_TEST_KEY = 'sk-test'
  let seen = null
  const api = createChatApi({
    home: mkdtempSync(join(tmpdir(), 'fw-chat-api-')),
    getConfig: () => normalizeChatApi({ apiKeyEnv: 'FW_CHAT_TEST_KEY' }),
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '收到' } }], usage: { total_tokens: 3 } }),
      }
    },
  })
  assert.equal(api.enabled(), true)
  const r = await api.reply({ messages: [{ role: 'user', content: '在吗' }] })
  assert.equal(r.ok, true)
  assert.equal(r.text, '收到')
  assert.match(seen.url, /\/chat\/completions$/)
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test')
  const body = JSON.parse(seen.init.body)
  assert.equal(body.stream, false)
  assert.equal(body.model, 'group/cheap-first')
  delete process.env.FW_CHAT_TEST_KEY
})

test('没有密钥：enabled=false，reply 如实失败', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-nokey-'))
  const api = createChatApi({
    home,
    getConfig: () => normalizeChatApi({ apiKeyEnv: 'FW_CHAT_MISSING_KEY' }),
    fetchImpl: async () => { throw new Error('不该被调用') },
  })
  assert.equal(api.enabled(), false)
  const r = await api.reply({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-key')
})

test('HTTP 错误 / 空回复 / 超时都如实返回', async () => {
  process.env.FW_CHAT_TEST_KEY = 'sk-test'
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-err-'))
  const mk = (fetchImpl) => createChatApi({
    home,
    getConfig: () => normalizeChatApi({ apiKeyEnv: 'FW_CHAT_TEST_KEY' }),
    fetchImpl,
  })
  const bad = await mk(async () => ({ ok: false, status: 500, text: async () => 'boom' })).reply({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(bad.reason, 'http-500')
  const empty = await mk(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }) })).reply({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(empty.reason, 'empty-reply')
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  const timeout = await mk(async () => { throw abort }).reply({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(timeout.reason, 'timeout')
  delete process.env.FW_CHAT_TEST_KEY
})
