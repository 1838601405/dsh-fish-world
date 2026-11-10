import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRoutes } from '../lib/http.mjs'

function response() {
  return { statusCode: 0, headers: {}, body: '', writeHead(code, headers) { this.statusCode = code; this.headers = headers }, end(value) { this.body = String(value || '') }, json() { return JSON.parse(this.body) } }
}
function request({ url, body = null } = {}) {
  return { method: body == null ? 'GET' : 'POST', url, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(JSON.stringify(body)) } }
}
function routes() {
  const world = {
    listDiary({ date = '', suggestions = false, limit = 80 } = {}) {
      const rows = [
        { id: 'e1', at: '2026-10-28T09:00:00Z', date: '2026-10-28', text: '今天写日记', status: 'approved' },
        { id: 'e2', at: '2026-10-26T09:00:00Z', date: '2026-10-26', text: '前一天', status: 'approved' },
      ]
      const filtered = date ? rows.filter((r) => r.at.startsWith(date)) : rows
      return suggestions ? filtered.filter((r) => r.status === 'pending') : filtered
    },
    listDiaryComments({ date = '' } = {}) {
      return date === '2026-10-28' ? [{ id: 'c1', diaryId: 'e1', who: '主人', text: '记得', at: '2026-10-28T10:00:00Z' }] : []
    },
  }
  return buildRoutes({ loader: {}, qq: {}, roles: {}, world, configStore: {}, market: {}, stickers: {}, links: {}, environment: {}, personaStore: {}, growth: {}, sandbox: {}, platforms: {}, portrait: {}, astrbot: {}, bus: {}, deliverInbound: {}, home: '', profile: '', storage: {}, activity: {}, records: {}, knowledge: {}, qqagent: {}, qqInbox: {}, stickerWishes: {}, protocolSupervisor: {}, qzone: {}, stickerVision: {}, costMeter: {}, fishTone: {}, wechatPlugin: {}, biliPersonaSync: {}, memoryDigest: {}, chatApi: {} })
}

test('diary dates returns month index without loading the full snapshot', async () => {
  const route = routes().find((r) => r.path === '/dsh-fish-world/diary/dates')
  const res = response()
  await route.handler(request({ url: '/dsh-fish-world/fishworld/diary/dates?month=2026-10' }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().dates, ['2026-10-28', '2026-10-26'])
  assert.deepEqual(res.json().counts, { '2026-10-28': 1, '2026-10-26': 1 })
})

test('diary day returns entries with comments', async () => {
  const route = routes().find((r) => r.path === '/dsh-fish-world/diary/day')
  const res = response()
  await route.handler(request({ url: '/dsh-fish-world/fishworld/diary/day?date=2026-10-28' }), res)
  const json = res.json()
  assert.equal(res.statusCode, 200)
  assert.equal(json.entries.length, 1)
  assert.equal(json.entries[0].comments.length, 1)
  assert.equal(json.comments.length, 1)
})
