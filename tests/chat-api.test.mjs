import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createChatApi, normalizeChatApi, normalizeChatBaseUrl, ownerReplyMode, shouldUseChatApi } from '../lib/chat-api.mjs'

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

test('路由：主人私聊按「有没有会话」分派，群聊 / 好友固定走 API', () => {
  // ★ 规则 2026-11-19 主人改：不再要求主人必须先绑会话。
  //   有会话 → 投会话；没会话 → API 直回。所以「没会话」时主人私聊走 API。

  // 主人私聊 + 没绑会话 → 走 API（这是本次改动的核心）
  assert.equal(shouldUseChatApi({ kind: 'private', userId: '10000001', ownerQQ: '10000001', ownerSession: '', enabled: true }), true)

  // 主人私聊 + 绑了会话 → 投会话（行为不变）
  assert.equal(shouldUseChatApi({ kind: 'private', userId: '10000001', ownerQQ: '10000001', ownerSession: 'session-abc', enabled: true }), false)

  // 非主人的私聊：一直走 API
  assert.equal(shouldUseChatApi({ kind: 'private', userId: '10000002', ownerQQ: '10000001', ownerSession: 'session-abc', enabled: true }), true)

  // 群聊：一直走 API（哪怕说话的是主人号）
  assert.equal(shouldUseChatApi({ kind: 'group', userId: '10000001', ownerQQ: '10000001', ownerSession: 'session-abc', enabled: true }), true)

  // 总开关关着一律不走 API
  assert.equal(shouldUseChatApi({ kind: 'group', userId: '1', ownerQQ: '1', ownerSession: '', enabled: false }), false)
})

test('ownerReplyMode：有会话 session，没会话 api', () => {
  assert.equal(ownerReplyMode(''), 'api')
  assert.equal(ownerReplyMode('   '), 'api')
  assert.equal(ownerReplyMode(null), 'api')
  assert.equal(ownerReplyMode(undefined), 'api')
  assert.equal(ownerReplyMode('session-abc'), 'session')
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

// ══════════ 生成设置分两处挂（主人 2026-11-24 二） ══════════
// 跟预设走：provider+model / temperature / maxTokens（换预设时模型跟着换）
// 跟全局走：historyLimit / 备份 / 局域网 / constant 开关（**不做成按预设一份**）

test('★★ 预设的 model 绑进请求（front-matter 带了就用它的，没带才回落全局）', async () => {
  process.env.FW_CHAT_TEST_KEY = 'sk-test'
  let seen = null
  const api = createChatApi({
    home: mkdtempSync(join(tmpdir(), 'fw-chat-gen-')),
    getConfig: () => normalizeChatApi({ apiKeyEnv: 'FW_CHAT_TEST_KEY', model: 'global/default' }),
    fetchImpl: async (url, init) => {
      seen = JSON.parse(init.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'resp/id' }) }
    },
  })

  // ① 传预设的生成设置 → 请求体用它（不是全局 config）
  const r1 = await api.reply({
    messages: [{ role: 'user', content: 'x' }],
    model: 'preset/special', temperature: 0.3, maxTokens: 123,
  })
  assert.equal(r1.ok, true)
  assert.equal(seen.model, 'preset/special', '★★ model 来自预设，不是全局 global/default')
  assert.equal(seen.temperature, 0.3, '★ temperature 跟预设走')
  assert.equal(seen.max_tokens, 123, '★ maxTokens 跟预设走')

  // ② 不传 → 回落全局（历史条数/备份那些本来就归全局，这里验回落没坏）
  await api.reply({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(seen.model, 'global/default', '★ 没带就回落全局')
  delete process.env.FW_CHAT_TEST_KEY
})

test('★★ 判据2：返回的 model id **从响应读**，不从配置读', async () => {
  process.env.FW_CHAT_TEST_KEY = 'sk-test'
  const api = createChatApi({
    home: mkdtempSync(join(tmpdir(), 'fw-chat-id-')),
    getConfig: () => normalizeChatApi({ apiKeyEnv: 'FW_CHAT_TEST_KEY', model: 'config/said-this' }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      // ★ 响应说自己是另一个 id（网关常常重定向到别的模型）
      text: async () => JSON.stringify({ choices: [{ message: { content: 'hi' } }], model: 'actual/real-id' }),
    }),
  })
  const r = await api.reply({ messages: [{ role: 'user', content: 'x' }], model: 'config/said-this' })
  assert.equal(r.ok, true)
  assert.equal(r.model, 'actual/real-id', '★★ id 从**响应**读（不是 config.model）')
  delete process.env.FW_CHAT_TEST_KEY
})
