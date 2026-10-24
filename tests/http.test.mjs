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

function request({ method = 'GET', url = '/', remoteAddress = '127.0.0.1', body = null } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(JSON.stringify(body)) },
  }
}

test('settings routes are loopback-only and save through schema-aware loader', async () => {
  const calls = []
  const loader = {
    list: () => [],
    detail: (id) => ({ id, settings: { label: 'x' } }),
    saveExtensionSettings: (id, settings, clear) => calls.push(['save', id, settings, clear]),
    reloadOne: async (id) => calls.push(['reload', id]),
    status: async () => ({}),
  }
  const market = { list: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) }
  const world = {
    status: () => ({ ok: true, ready: true }),
    listRelations: () => ({ owner: {}, people: [] }),
    updateRelations: (p) => p,
    appendDiary: (r) => ({ ok: true, suggestion: false, record: r }),
    listDiary: () => [],
    listDiaryComments: () => [],
    interactionTimeline: () => ({ ok: true, counts: {}, items: [] }),
    reviewDiarySuggestion: () => ({ ok: true, accepted: true }),
  }
  const routes = buildRoutes({ loader, market, qq: {}, whale: {}, world, configStore: {} })
  const byPath = Object.fromEntries(routes.map((route) => [route.path, route]))

  const blocked = response()
  await byPath['/dsh-fish-world/extension/settings'].handler(request({
    method: 'POST', remoteAddress: '192.0.2.4', body: { id: 'sample', settings: { label: 'z' } },
  }), blocked)
  assert.equal(blocked.statusCode, 403)
  assert.equal(calls.length, 0)

  const saved = response()
  await byPath['/dsh-fish-world/extension/settings'].handler(request({
    method: 'POST', body: { id: 'sample', settings: { label: 'z' }, clearSecrets: ['token'], reload: true },
  }), saved)
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().ok, true)
  assert.deepEqual(calls.map((call) => call[0]), ['save', 'reload'])
})

test('capability catalog is bundled, readable without network, and hides infrastructure', async () => {
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, links: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world: { status: () => ({ ok: true }) }, configStore: {},
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/capabilities')
  assert.ok(route)
  const res = response()
  await route.handler(request(), res)
  const value = res.json()
  assert.equal(value.ok, true)
  assert.ok(value.built_in.some((item) => item.name === '动图解码器' && item.is_hidden && item.execution_mode === 'local'))
  assert.ok(value.plugins.some((item) => item.id === 'animation-frames' && item.execution_mode === 'local'))
  assert.ok(value.skills.some((item) => item.id === 'animation-understanding' && item.execution_mode === 'cloud'))
})

test('diary route is read-only: the owner reviews, the fish writes', async () => {
  let appends = 0
  const comments = []
  const world = {
    status: () => ({ ok: true }),
    listDiary: ({ suggestions = false } = {}) => (suggestions
      ? [{ id: 's1', text: '信任者投稿', actorName: '阿鱼', status: 'pending' }]
      : [{ id: 'e1', text: '今天很安静', actorName: '鱼', status: 'approved' }]),
    listDiaryComments: () => comments,
    interactionTimeline: () => ({ ok: true, counts: { total: 0 }, items: [] }),
    commentDiary: (id, text) => { comments.push({ diaryId: id, text }); return { ok: true } },
    appendDiary: () => { appends += 1; return { ok: true } },
    reviewDiarySuggestion: () => ({ ok: true, accepted: true }),
  }
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world, configStore: {},
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/world/diary')

  const listed = response()
  await route.handler(request({ url: '/dsh-fish-world/world/diary' }), listed)
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json().entries[0].actorName, '鱼')
  assert.equal(listed.json().suggestions[0].status, 'pending')

  const rejected = response()
  await route.handler(request({ method: 'POST', url: '/dsh-fish-world/world/diary', body: { text: '主人代写' } }), rejected)
  assert.equal(rejected.statusCode, 405)
  assert.equal(appends, 0, '管理页不得替鱼写日记')

  // 但主人可以留批语，且批语不走 appendDiary
  const commentRoute = routes.find((item) => item.path === '/dsh-fish-world/world/diary/comment')
  const commented = response()
  await commentRoute.handler(request({
    method: 'POST', url: '/dsh-fish-world/world/diary/comment', body: { id: 'e1', text: '写得很好' },
  }), commented)
  assert.equal(commented.statusCode, 200)
  assert.equal(commented.json().ok, true)
  assert.deepEqual(comments, [{ diaryId: 'e1', text: '写得很好' }])
  assert.equal(appends, 0, '批语不能变成改写日记正文')
})

test('persona route stores the card for the current role', async () => {
  const cards = []
  const personaStore = {
    get: (roleId) => (cards.find((c) => c.roleId === roleId) || null),
    set: (roleId, text) => { cards.push({ roleId, text, bytes: text.length }); return { ok: true, roleId, bytes: text.length } },
    list: () => cards.map((c) => ({ roleId: c.roleId, bytes: c.bytes })),
  }
  const whale = {
    persona: () => ({ role: { id: 'default', name: '鱼' } }),
    summary: () => ({ roles: [] }),
  }
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale, world: { status: () => ({ ok: true }) }, configStore: {}, personaStore,
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/fish/persona')

  const empty = response()
  await route.handler(request({ url: '/dsh-fish-world/fish/persona' }), empty)
  assert.equal(empty.json().roleId, 'default')
  assert.equal(empty.json().text, '')

  const wrote = response()
  await route.handler(request({
    method: 'POST', url: '/dsh-fish-world/fish/persona', body: { text: '# Role: 蓝鲸娘' },
  }), wrote)
  assert.equal(wrote.json().ok, true)

  const read = response()
  await route.handler(request({ url: '/dsh-fish-world/fish/persona' }), read)
  assert.match(read.json().text, /蓝鲸娘/)
  assert.equal(read.json().cards.length, 1)
})

test('fish profile route renames the fish, and the whale display name follows', async () => {  const saved = []
  const configStore = {
    getConfig: () => ({ fish: { name: '泡泡', ownerTitle: '主人', persona: 'auto' } }),
    saveConfig: (patch) => { saved.push(patch); return { fish: { ...patch.fish } } },
  }
  const whale = {
    persona: () => ({ role: { id: 'default', name: '小鲸鱼', displayName: '泡泡' } }),
    summary: () => ({ roles: [{ id: 'default', name: '小鲸鱼' }] }),
  }
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale, world: { status: () => ({ ok: true }) }, configStore,
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/fish/profile')

  const read = response()
  await route.handler(request({ url: '/dsh-fish-world/fish/profile' }), read)
  assert.equal(read.json().fish.name, '泡泡')
  assert.equal(read.json().current.displayName, '泡泡')

  const wrote = response()
  await route.handler(request({
    method: 'POST', url: '/dsh-fish-world/fish/profile', body: { name: '阿鱼', ownerTitle: '老板', persona: 'blue' },
  }), wrote)
  assert.equal(wrote.json().ok, true)
  assert.deepEqual(saved[0].fish, { name: '阿鱼', ownerTitle: '老板', persona: 'blue' })
})

test('environment route is loopback-only, GET reads the cache and POST re-checks', async () => {
  let checks = 0
  let refreshes = 0
  const environment = {
    status: () => { checks += 1; return { ok: false, warnings: ['未安装依赖：dsh-qq-bridge（QQ 桥）'], hints: [], missing: ['dsh-qq-bridge'], packages: [] } },
    check: () => { refreshes += 1; return { ok: true, warnings: [], hints: [], missing: [], packages: [] } },
  }
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, links: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world: { status: () => ({ ok: true }) }, configStore: {}, environment,
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/env')

  const denied = response()
  await route.handler(request({ url: '/dsh-fish-world/env', remoteAddress: '203.0.113.9' }), denied)
  assert.equal(denied.statusCode, 403)
  assert.equal(checks, 0)

  const cached = response()
  await route.handler(request({ url: '/dsh-fish-world/env' }), cached)
  assert.equal(cached.statusCode, 200)
  assert.equal(cached.json().environment.missing[0], 'dsh-qq-bridge')
  assert.equal(checks, 1)

  const refreshed = response()
  await route.handler(request({ url: '/dsh-fish-world/env', method: 'POST' }), refreshed)
  assert.equal(refreshed.statusCode, 200)
  assert.equal(refreshed.json().environment.ok, true)
  assert.equal(refreshes, 1)
})

test('market links only serve loopback clients', async () => {
  let called = 0
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => { called += 1; return { ok: true, items: [] } }, install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world: { status: () => ({ ok: true }) }, configStore: {},
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/market')
  const denied = response()
  await route.handler(request({ url: '/dsh-fish-world/market?kind=plugin', remoteAddress: '198.51.100.8' }), denied)
  assert.equal(denied.statusCode, 403)
  assert.equal(called, 0)

  const ok = response()
  await route.handler(request({ url: '/dsh-fish-world/market?kind=plugin' }), ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(called, 1)
})
