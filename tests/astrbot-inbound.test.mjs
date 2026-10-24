// AstrBot 入站路由的安全测试：token 必须正确，消息要被归一化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRoutes } from '../lib/http.mjs'
import { createAstrbot } from '../lib/astrbot.mjs'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'fw-inbound-'))
}

// 最小可用的依赖桩：只关心 astrbot 两条路由。
function buildTestRoutes({ astrbot, deliverInbound, bus }) {
  const noop = () => {}
  const stubs = {
    loader: { status: noop, list: () => [], reload: noop, setEnabled: noop, isReady: () => true },
    qq: { snapshot: () => ({}), loginInfo: async () => ({ ok: false }), setSafetySwitch: noop, send: noop, sendImage: noop, sendSticker: noop, recent: noop, forward: noop },
    whale: { persona: () => ({ role: null }), summary: () => ({ roles: [] }) },
    world: { status: () => ({}), relations: () => ({}), diary: () => ({}), wishes: () => ({}), growth: () => ({}), state: () => ({}), interactionTimeline: () => ({}) },
    configStore: { getConfig: () => ({}), saveConfig: noop },
    market: {}, stickers: {}, links: {}, environment: null, personaStore: {}, growth: {},
    sandbox: null, platforms: { status: () => ({}), update: () => ({}) }, voice: {}, portrait: {},
    astrbot, bus, deliverInbound, home: '', profile: 'desktop',
  }
  return buildRoutes(stubs)
}

function findRoute(routes, suffix) {
  const route = routes.find((r) => r.path.endsWith(suffix))
  assert.ok(route, `应该注册路由 ${suffix}`)
  return route
}

// 造一个最小的 req/res 对。
function makeReq({ method = 'POST', headers = {}, body = null }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const iterable = {
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
    socket: { remoteAddress: '127.0.0.1' },
    method,
    headers,
    url: '/',
  }
  return iterable
}

function makeRes() {
  const out = { status: 0, body: null }
  const res = {
    writeHead(status) { out.status = status },
    end(text) { out.body = text ? JSON.parse(text) : null },
  }
  return { res, out }
}

async function call(route, { method = 'POST', headers = {}, body = null } = {}) {
  const { res, out } = makeRes()
  await route.handler(makeReq({ method, headers, body }), res)
  return out
}

test('入站路由在 token 不符时拒绝', async () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ token: 'fw_correct_token' })
  const route = findRoute(buildTestRoutes({ astrbot, deliverInbound: async () => ({ ok: true }), bus: { emit: () => 0 } }), '/astrbot/inbound')

  const bad = await call(route, {
    headers: { authorization: 'Bearer fw_wrong_token' },
    body: { chatKey: 'private:1', message: { message_id: '1', message: [{ type: 'text', data: { text: 'hi' } }] } },
  })
  assert.equal(bad.status, 403)
  assert.equal(bad.body.ok, false)
})

test('入站路由在没配 token 时拒绝一切请求', async () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  const route = findRoute(buildTestRoutes({ astrbot, deliverInbound: async () => ({ ok: true }), bus: { emit: () => 0 } }), '/astrbot/inbound')

  const result = await call(route, {
    headers: { authorization: 'Bearer anything' },
    body: { chatKey: 'private:1', message: { message_id: '1', message: [{ type: 'text', data: { text: 'hi' } }] } },
  })
  assert.equal(result.status, 403)
})

test('token 正确时消息被归一化并投递', async () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ token: 'fw_correct_token' })

  const delivered = []
  const emitted = []
  const route = findRoute(buildTestRoutes({
    astrbot,
    deliverInbound: async (event) => { delivered.push(event); return { ok: true } },
    bus: { emit: (name, payload) => { emitted.push({ name, payload }); return 1 } },
  }), '/astrbot/inbound')

  const result = await call(route, {
    headers: { authorization: 'Bearer fw_correct_token' },
    body: {
      chatKey: 'group:123456',
      message: {
        message_id: '9001',
        user_id: '42',
        sender: { nickname: '小明' },
        time: 1700000000,
        message: [
          { type: 'text', data: { text: '在不' } },
          { type: 'image', data: { url: 'https://example.com/a.png', file: 'a.png' } },
        ],
      },
    },
  })

  assert.equal(result.status, 200)
  assert.equal(result.body.delivered, true)
  assert.equal(delivered.length, 1)

  const event = delivered[0]
  assert.equal(event.id, '9001')
  assert.equal(event.text, '在不')
  assert.equal(event.source, 'qq')
  assert.equal(event.via, 'astrbot', '要能和 QQ 桥来的消息区分开')
  assert.equal(event.userId, '42')
  assert.equal(event.nickname, '小明')
  assert.equal(event.images.length, 1)
  assert.equal(event.images[0].url, 'https://example.com/a.png')

  // 总线也要收到通知，扩展才看得到。
  assert.ok(emitted.some((e) => e.name === 'message.in'))
})

test('投递失败时返回 202 并说明原因，而不是假装成功', async () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ token: 'fw_correct_token' })
  const route = findRoute(buildTestRoutes({
    astrbot,
    deliverInbound: async () => ({ ok: false, error: '还没有绑定主人会话' }),
    bus: { emit: () => 0 },
  }), '/astrbot/inbound')

  const result = await call(route, {
    headers: { authorization: 'Bearer fw_correct_token' },
    body: { chatKey: 'private:1', message: { message_id: '1', message: [{ type: 'text', data: { text: 'hi' } }] } },
  })
  assert.equal(result.status, 202)
  assert.equal(result.body.delivered, false)
  assert.equal(result.body.deliveryError, '还没有绑定主人会话')
})

test('缺少 message 时返回 400', async () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ token: 'fw_correct_token' })
  const route = findRoute(buildTestRoutes({ astrbot, deliverInbound: async () => ({ ok: true }), bus: { emit: () => 0 } }), '/astrbot/inbound')

  const result = await call(route, {
    headers: { authorization: 'Bearer fw_correct_token' },
    body: { chatKey: 'private:1' },
  })
  assert.equal(result.status, 400)
})

test('GET 请求被拒绝', async () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ token: 'fw_correct_token' })
  const route = findRoute(buildTestRoutes({ astrbot, deliverInbound: async () => ({ ok: true }), bus: { emit: () => 0 } }), '/astrbot/inbound')

  const result = await call(route, { method: 'GET', headers: { authorization: 'Bearer fw_correct_token' } })
  assert.equal(result.status, 405)
})

test('/astrbot 配置接口 GET 不泄露 token', async () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ enabled: true, token: 'fw_super_secret' })
  const route = findRoute(buildTestRoutes({ astrbot, deliverInbound: async () => ({ ok: true }), bus: { emit: () => 0 } }), '/astrbot')

  const result = await call(route, { method: 'GET' })
  assert.equal(result.status, 200)
  assert.equal(result.body.hasToken, true)
  assert.equal(JSON.stringify(result.body).includes('fw_super_secret'), false)
})
