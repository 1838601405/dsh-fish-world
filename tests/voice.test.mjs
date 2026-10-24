import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createVoice, maskKey, normalizeVoice, validateBaseUrl } from '../lib/voice.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-voice-'))
  const saved = []
  const configStore = {
    getConfig: () => ({ voice: {} }),
    saveConfig: (patch) => { saved.push(patch); return patch },
  }
  return { home, store: createVoice({ home, configStore }), saved }
}

test('base url must be https except on loopback', () => {
  assert.equal(validateBaseUrl('https://api.example.com/v1').ok, true)
  assert.equal(validateBaseUrl('http://127.0.0.1:8080/v1').ok, true)
  assert.equal(validateBaseUrl('http://localhost:8080').ok, true)

  const plain = validateBaseUrl('http://api.example.com/v1')
  assert.equal(plain.ok, false)
  assert.match(plain.error, /必须用 https/)

  assert.equal(validateBaseUrl('ftp://x').ok, false)
  assert.equal(validateBaseUrl('not-a-url').ok, false)

  // 地址里夹带账号密码必须拒绝，避免密钥被写进 URL 日志
  const withCreds = validateBaseUrl('https://user:pw@api.example.com/v1')
  assert.equal(withCreds.ok, false)
  assert.match(withCreds.error, /不要.*账号密码|API Key/)
})

test('keys are masked and never returned in the view', () => {
  const { store } = fresh()
  store.save({ enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-super-secret-1234' })

  const view = store.view()
  assert.equal(view.hasKey, true)
  assert.equal(view.keyPreview, '••••1234')
  assert.equal(view.active, true, '地址/模型/密钥齐全且启用时应为 active')

  // 视图对象里绝不能出现明文密钥
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('sk-super-secret-1234'), false, '密钥明文绝不能出现在视图里')
  assert.equal(serialized.includes('super-secret'), false)

  // 但内部 config 仍能拿到（用于调用）
  assert.equal(store.config().baseUrl, 'https://api.example.com/v1')
})

test('empty apiKey keeps the existing key; null clears it', () => {
  const { store } = fresh()
  store.save({ enabled: true, baseUrl: 'https://a.example.com/v1', model: 'm', apiKey: 'key-one-aaaa' })
  assert.equal(store.view().keyPreview, '••••aaaa')

  // 传空字符串：不修改
  store.save({ model: 'm2', apiKey: '' })
  assert.equal(store.view().hasKey, true)
  assert.equal(store.view().keyPreview, '••••aaaa')
  assert.equal(store.view().model, 'm2')

  // 传 null：清除
  store.save({ apiKey: null })
  assert.equal(store.view().hasKey, false)
  assert.equal(store.view().active, false)
})

test('voice config only accepts whitelisted fields and clamps numbers', () => {
  const cfg = normalizeVoice({
    maxTokens: 99999,
    temperature: 5,
    timeoutMs: 1,
    baseUrl: 'https://a.example.com/v1',
    model: '  x  ',
    apiKey: 'should-not-leak-into-config',
    password: 'nope',
    scenarios: { chat: true, comment: true, bogus: true },
  })
  assert.equal(cfg.maxTokens, 4096)
  assert.equal(cfg.temperature, 2)
  assert.equal(cfg.timeoutMs, 3000)
  assert.equal(cfg.model, 'x')
  assert.equal('apiKey' in cfg, false, '归一化结果不接受密钥字段')
  assert.equal('password' in cfg, false)
  assert.equal(cfg.scenarios.chat, true)
  assert.equal(cfg.scenarios.comment, true)
  assert.equal('bogus' in cfg.scenarios, false)
})

test('non-sensitive fields go to config store, key stays in its own file', () => {
  const { home, store, saved } = fresh()
  store.save({ enabled: true, baseUrl: 'https://a.example.com/v1', model: 'lang-model', apiKey: 'sk-zzzz9999' })

  // 主配置只拿到非敏感字段
  const patch = saved.at(-1)
  assert.equal(patch.voice.model, 'lang-model')
  assert.equal(JSON.stringify(patch).includes('sk-zzzz9999'), false, '主配置不能包含密钥')

  // 密钥在自己的文件里
  const voiceFile = join(home, 'fish-world-voice.json')
  const raw = JSON.parse(readFileSync(voiceFile, 'utf8'))
  assert.equal(raw.apiKey, 'sk-zzzz9999')
  assert.ok(raw.apiKeyUpdatedAt)
})

test('speak refuses when not configured or scenario disabled', async () => {
  const { store } = fresh()
  await assert.rejects(() => store.speak({ messages: [{ role: 'user', content: 'hi' }] }), /未启用/)

  store.save({ enabled: true, baseUrl: 'https://a.example.com/v1', model: 'm', apiKey: null })
  await assert.rejects(() => store.speak({ messages: [{ role: 'user', content: 'hi' }] }), /还没有填写密钥/)

  store.save({ apiKey: 'k-1234' })
  // greeting 默认关闭
  await assert.rejects(
    () => store.speak({ messages: [{ role: 'user', content: 'hi' }], scenario: 'greeting' }),
    /没有开启使用发言 API/,
  )
})

test('speak posts an OpenAI-compatible request and returns the text', async () => {
  const { store } = fresh()
  store.save({
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    model: 'lang-model',
    apiKey: 'test-key',
    stylePrompt: '用一句话回答',
  })

  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: '  在  ' } }], model: 'lang-model', usage: { total_tokens: 7 } }
      },
    }
  }
  try {
    const result = await store.speak({ messages: [{ role: 'user', content: '在吗' }], scenario: 'chat' })
    assert.equal(result.ok, true)
    assert.equal(result.text, '在')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/chat\/completions$/)
    assert.equal(calls[0].init.method, 'POST')
    // 密钥通过 Authorization 头发送
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-key')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.model, 'lang-model')
    assert.equal(body.messages[0].role, 'system', 'stylePrompt 应作为 system 消息前置')
    assert.equal(body.messages[1].content, '在吗')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('speak never echoes the response body on http errors', async () => {
  const { store } = fresh()
  store.save({ enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'secret-key-xyz' })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async json() { return { error: 'invalid key secret-key-xyz' } },
    async text() { return 'your key secret-key-xyz is invalid' },
  })
  try {
    await assert.rejects(
      () => store.speak({ messages: [{ role: 'user', content: 'hi' }], scenario: 'chat' }),
      (error) => {
        assert.match(error.message, /HTTP 401/)
        assert.equal(error.message.includes('secret-key-xyz'), false, '错误信息不能回显密钥')
        return true
      },
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('maskKey handles short and empty values', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('ab'), '••••')
  assert.equal(maskKey('abcd'), '••••')
  assert.equal(maskKey('sk-1234567890'), '••••7890')
})
