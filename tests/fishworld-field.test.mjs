import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRoutes } from '../lib/http.mjs'

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(value) { this.body = String(value || '') },
    json() { return JSON.parse(this.body) },
  }
}

function request(body) {
  return {
    method: 'POST',
    url: '/dsh-fish-world/fishworld/qq/field',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

test('fishworld qq field writes allowChats through the chats table', async () => {
  const saved = []
  const updates = []
  const routes = buildRoutes({
    loader: {}, qq: {}, roles: {}, world: { updateChats(list) { saved.push(list); return { items: list } } }, configStore: {}, market: {}, stickers: {}, links: {}, environment: {}, personaStore: {}, growth: {}, sandbox: {}, platforms: { update(id, patch) { updates.push([id, patch]) }, refresh: async () => {} }, portrait: {}, astrbot: {}, bus: {}, deliverInbound: {}, home: '', profile: '', storage: {}, activity: {}, records: {}, knowledge: {}, qqagent: {}, qqInbox: {}, stickerWishes: {}, protocolSupervisor: {}, qzone: {}, stickerVision: {}, costMeter: {}, fishTone: {}, wechatPlugin: {}, biliPersonaSync: {}, memoryDigest: {}, chatApi: {},
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/fishworld/qq/field')
  const list = [{ chatKey: 'group:123456789', name: '测试群', sessionId: '', enabled: true }]
  const res = response()
  await route.handler(request({ key: 'allowChats', value: list }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.deepEqual(saved, [list])
})

test('fishworld qq field writes groupReplyMode through platform config', async () => {
  const updates = []
  const routes = buildRoutes({
    loader: {}, qq: {}, roles: {}, world: { status: () => ({}) }, configStore: {}, market: {}, stickers: {}, links: {}, environment: {}, personaStore: {}, growth: {}, sandbox: {}, platforms: { update(id, patch) { updates.push([id, patch]) }, refresh: async () => {} }, portrait: {}, astrbot: {}, bus: {}, deliverInbound: {}, home: '', profile: '', storage: {}, activity: {}, records: {}, knowledge: {}, qqagent: {}, qqInbox: {}, stickerWishes: {}, protocolSupervisor: {}, qzone: {}, stickerVision: {}, costMeter: {}, fishTone: {}, wechatPlugin: {}, biliPersonaSync: {}, memoryDigest: {}, chatApi: {},
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/fishworld/qq/field')
  const res = response()
  await route.handler(request({ key: 'groupReplyMode', value: 'quiet' }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(updates, [['qq', { groupReplyMode: 'quiet' }]])
})
