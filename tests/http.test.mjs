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

// 主人绑定（QQ 号 / 会话）走同一条 profile 路由：设定页一个「保存主人」，
// 既改「怎么称呼你」，也改「谁是你的主人、数据放进哪一间会话」。
// 真源是 QQ 桥，所以必须经 world.setOwner 写，不能只改面板状态。
test('fish profile route saves the owner binding through the bridge, and refuses dead sessions', async () => {
  const setOwnerCalls = []
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {},
    whale: { persona: () => ({ role: { id: 'default' } }), summary: () => ({ roles: [] }) },
    configStore: {
      getConfig: () => ({ fish: { name: '泡泡' } }),
      saveConfig: (patch) => ({ fish: { ...patch.fish } }),
    },
    world: {
      status: () => ({ ok: true }),
      ownerBinding: () => ({ qq: { bridge: '10001000' }, session: { bridge: 'session-yes' }, qqAgree: true, sessionAgree: true, sessionAlive: true }),
      sessions: ({ all } = {}) => (all ? [{ id: 'session-yes', title: '房间', inWorkspace: true }, { id: 'session-else', inWorkspace: false }] : [{ id: 'session-yes', title: '房间' }]),
      setOwner: (patch) => {
        setOwnerCalls.push(patch)
        if (patch.targetSession === 'session-dead') throw new Error('这个会话已经不存在了，换一个（DSH 会清理旧会话）')
        if (patch.privateQQ === 'abc') throw new Error('主人私聊号要填数字 QQ 号')
        return { ok: true }
      },
    },
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/fish/profile')

  // 读取时一并给主人绑定与「所有会话」：换绑时旧会话可能已经不在本工作区。
  const read = response()
  await route.handler(request({ url: '/dsh-fish-world/fish/profile' }), read)
  assert.equal(read.json().owner.session.bridge, 'session-yes')
  assert.equal(read.json().sessions.length, 2, '列全部会话，不只本工作区的')

  const saved = response()
  await route.handler(request({
    method: 'POST', url: '/dsh-fish-world/fish/profile',
    body: { ownerQQ: '10001000', ownerSession: 'session-yes' },
  }), saved)
  assert.equal(saved.json().ok, true)
  assert.deepEqual(setOwnerCalls[0], { privateQQ: '10001000', targetSession: 'session-yes' })

  for (const [body, pattern] of [
    [{ ownerSession: 'session-dead' }, /已经不存在/],
    [{ ownerQQ: 'abc' }, /数字 QQ 号/],
  ]) {
    const bad = response()
    await route.handler(request({ method: 'POST', url: '/dsh-fish-world/fish/profile', body }), bad)
    assert.equal(bad.statusCode, 400)
    assert.match(bad.json().error, pattern)
  }
  const attempted = setOwnerCalls.length
  assert.equal(attempted, 3, '成功一次 + 两次被拒，都该真的走到桥那一步（拒绝来自桥/世界，不是面板自己吞掉）')

  // 没传 owner 字段时不该碰主人绑定（改名不能顺手把会话改掉）。
  const rename = response()
  await route.handler(request({ method: 'POST', url: '/dsh-fish-world/fish/profile', body: { name: '阿鱼' } }), rename)
  assert.equal(rename.json().ok, true)
  assert.equal(setOwnerCalls.length, attempted, '改名那次没有动主人绑定')
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

test('storage route reports folders and only accepts absolute roots', async () => {
  const saved = []
  let root = 'C:\\Users\\x\\Desktop\\鱼的世界'
  const storage = {
    describe: () => ({ ok: true, root, configured: false, folders: { gallery: root + '\\鱼的收藏\\1 图库' } }),
  }
  const configStore = { saveConfig: (patch) => { saved.push(patch); return patch } }
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world: { status: () => ({ ok: true }) }, configStore, storage,
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/storage')

  const read = response()
  await route.handler(request({ url: '/dsh-fish-world/storage' }), read)
  assert.equal(read.json().folders.gallery, root + '\\鱼的收藏\\1 图库')

  // 相对路径一律拒绝：路径会随 cwd 漂移
  const relative = response()
  await route.handler(request({ method: 'POST', url: '/dsh-fish-world/storage', body: { root: 'fish-world' } }), relative)
  assert.equal(relative.statusCode, 400)
  assert.equal(saved.length, 0)

  root = 'D:\\鱼的世界'
  const wrote = response()
  await route.handler(request({ method: 'POST', url: '/dsh-fish-world/storage', body: { gallery: 'D:\\gallery' } }), wrote)
  assert.equal(wrote.statusCode, 200)
  assert.deepEqual(saved[0], { storage: { gallery: 'D:\\gallery' } })
})

test('activity route records platform activity and lists it', async () => {
  const rows = []
  const activity = {
    status: () => ({ ok: true, platforms: { qq: { total: rows.length } }, kinds: [] }),
    list: () => rows,
    append: (input) => { rows.push(input); return { ok: true, ...input } },
  }
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world: { status: () => ({ ok: true }) }, configStore: {}, activity,
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/world/activity')

  const wrote = response()
  await route.handler(request({
    method: 'POST', url: '/dsh-fish-world/world/activity', body: { platform: 'bili', kind: 'watch', text: '看视频' },
  }), wrote)
  assert.equal(wrote.statusCode, 200)
  assert.equal(rows.length, 1)

  const read = response()
  await route.handler(request({ url: '/dsh-fish-world/world/activity' }), read)
  assert.equal(read.json().ok, true)
  assert.equal(read.json().items.length, 1)
})

test('records route adds, edits, deletes and walks the notebook', async () => {
  const memos = [{ id: 'm1', text: '旧内容' }]
  const records = {
    summary: () => ({ ok: true, memos: memos.length, grudges: { open: 0, explained: 0, accepted: 0 } }),
    listMemos: () => memos,
    listGrudges: () => [{ id: 'g1', status: 'open', text: '想要陪着' }],
    sweepPendingWishes: () => [],
    addMemo: ({ text }) => { memos.push({ id: 'm2', text }); return { ok: true } },
    updateMemo: (id, { text }) => { memos[0].text = text; return { ok: true } },
    removeMemo: (id) => { const i = memos.findIndex((m) => m.id === id); if (i < 0) return { ok: false }; memos.splice(i, 1); return { ok: true } },
    explainGrudge: () => ({ ok: true, item: { id: 'g1', status: 'explained' } }),
    acceptGrudge: () => ({ ok: true, item: { id: 'g1', status: 'accepted' } }),
  }
  const world = { status: () => ({ ok: true }), listWishes: () => [] }
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world, configStore: {}, records,
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/world/records')

  const read = response()
  await route.handler(request({ url: '/dsh-fish-world/world/records' }), read)
  assert.equal(read.json().items[0].text, '旧内容')
  assert.equal(read.json().grudges[0].id, 'g1')

  const added = response()
  await route.handler(request({ method: 'POST', body: { action: 'add', text: '记一下' } }), added)
  assert.equal(added.json().ok, true)
  assert.equal(memos.length, 2)

  const updated = response()
  await route.handler(request({ method: 'POST', body: { action: 'update', id: 'm1', text: '新内容' } }), updated)
  assert.equal(memos[0].text, '新内容')

  const removed = response()
  await route.handler(request({ method: 'POST', body: { action: 'remove', id: 'm1' } }), removed)
  assert.equal(memos.length, 1)

  const explained = response()
  await route.handler(request({ method: 'POST', body: { action: 'explain', id: 'g1', text: '那天在赶工' } }), explained)
  assert.equal(explained.json().item.status, 'explained')

  const accepted = response()
  await route.handler(request({ method: 'POST', body: { action: 'accept', id: 'g1' } }), accepted)
  assert.equal(accepted.json().item.status, 'accepted')

  const unknown = response()
  await route.handler(request({ method: 'POST', body: { action: 'nope' } }), unknown)
  assert.equal(unknown.statusCode, 400)
})

// 聊天目标只有一处真相：world 的 chats.json（群不是「人」，不复用 people.json）。
// /qq/chat 只读写这份表、跑一轮收信、改「群里怎么开口」，不接受往平台配置里另塞白名单。
test('qq chat route reads the whitelist from the chats table and owns only save/reset actions', async () => {
  const targets = [
    { chatKey: 'private:22222', kind: 'private', id: '22222', name: '某人', sessionId: 'session-friend-room', enabled: true },
    // 已允许但还没选房间的：不在 chatTargets 里（不收信），但面板要能看到。
    { chatKey: 'group:20002', kind: 'group', id: '20002', name: '读书会', sessionId: '', enabled: true },
  ]
  const updated = []
  const saved = []
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: { call: async () => ({ ok: true, data: [{ group_id: '123', group_name: '某群' }] }) },
    whale: {}, configStore: {},
    platforms: { platform: () => ({ enabled: true, readHistory: true, groupReplyMode: 'mention', pollSeconds: 4 }), update: (id, patch) => { updated.push([id, patch]); return { ok: true } } },
    world: {
      status: () => ({ ok: true }),
      chatTargets: () => targets.filter((t) => t.sessionId),
      // 面板要显示「已允许 · 待选房间」，所以路由回传的是**白名单全量**，
      // 不是「能收信的」（后者会把还没选房间的藏起来）。见 AGENTS.md §6.1 语义变更。
      chatWhitelist: () => targets,
      updateChats: (list) => { saved.push(list); return { items: list } },
      sessions: () => [{ id: 'session-friend-room', title: '房间' }],
      ownerSession: () => 'session-owner-1',
    },
    qqInbox: { status: () => ({ ok: true, targets: targets.map((t) => ({ chatKey: t.chatKey, sessionId: t.sessionId })) }), tick: async () => ({ ok: true, read: 0, delivered: 0 }) },
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/qq/chat')

  const view = response()
  await route.handler(request({ url: '/dsh-fish-world/qq/chat' }), view)
  const body = view.json()
  assert.equal(body.ok, true)
  assert.equal(body.chat.targets[0].chatKey, 'private:22222', '状态里的目标来自聊天表')
  assert.equal(body.targets[0].sessionId, 'session-friend-room', '回传聊天表，面板不用再自己拼')
  assert.equal(body.targets.length, 2, '白名单全量都要回传，包括还没选房间的')
  assert.equal(body.targets[1].sessionId, '', '还没选房间的也在名单里，面板标「待选房间」')
  assert.equal(body.sessions[0].id, 'session-friend-room')

  // 整表保存：加群、去群、换房间都走这一次写入
  const next = [{ chatKey: 'group:20002', sessionId: 'session-group-room', name: '游戏群' }]
  const savedResp = response()
  await route.handler(request({ method: 'POST', body: { action: 'save', targets: next } }), savedResp)
  assert.equal(savedResp.statusCode, 200)
  assert.deepEqual(saved[0], next)
  assert.deepEqual(updated, [], '保存目标不该改动平台配置')

  // 重置：出错卡住时的退路，清空白名单回到初始状态。
  const reset = response()
  await route.handler(request({ method: 'POST', body: { action: 'reset' } }), reset)
  assert.equal(reset.statusCode, 200)
  assert.deepEqual(saved[1], [], '重置就是把白名单清空')

  const mode = response()
  await route.handler(request({ method: 'POST', body: { action: 'mode', groupReplyMode: 'always' } }), mode)
  assert.equal(mode.statusCode, 200, '群里怎么开口仍归平台配置')
  assert.deepEqual(updated[0], ['qq', { groupReplyMode: 'always' }])

  const ticked = response()
  await route.handler(request({ method: 'POST', body: { action: 'tick' } }), ticked)
  assert.equal(ticked.json().tick.ok, true)

  const offHost = response()
  await route.handler(request({ url: '/dsh-fish-world/qq/chat', remoteAddress: '10.1.2.3' }), offHost)
  assert.equal(offHost.statusCode, 403)
})

test('fs picker routes only list directories over loopback', async () => {
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, items: [] }), install: async () => ({ ok: true }) },
    qq: {}, whale: {}, world: { status: () => ({ ok: true }) }, configStore: {},
  })
  const list = routes.find((item) => item.path === '/dsh-fish-world/fs/list')
  const denied = response()
  await list.handler(request({ url: '/dsh-fish-world/fs/list', remoteAddress: '10.1.2.3' }), denied)
  assert.equal(denied.statusCode, 403)

  const roots = response()
  await routes.find((item) => item.path === '/dsh-fish-world/fs/roots').handler(request(), roots)
  assert.equal(roots.json().ok, true)

  const missing = response()
  await list.handler(request({ url: '/dsh-fish-world/fs/list?path=' + encodeURIComponent('Z:\\nope-' + Date.now()) }), missing)
  assert.equal(missing.statusCode, 400)
  assert.match(missing.json().error, /不存在/)
})

test('知识库路由：看状态、开关向量档、重建索引，都只认本机', async () => {
  const saved = []
  const knowledge = {
    status: () => ({ ok: true, items: 6, enabled: true, mode: 'local', index: { model: 'local:x', dim: 512 }, indexFresh: true }),
    rebuild: async () => ({ ok: true, rebuilt: true, model: { id: 'local:x', dim: 512 }, items: 6 }),
  }
  const configStore = {
    getConfig: () => ({ knowledge: { enabled: false, mode: 'off', localModel: 'Xenova/bge-small-zh-v1.5' } }),
    saveConfig: (patch) => { saved.push(patch); return { ...configStore.getConfig(), ...patch } },
  }
  const routes = buildRoutes({ loader: {}, market: {}, qq: {}, whale: {}, world: {}, configStore, knowledge })
  const route = routes.find((item) => item.path === '/dsh-fish-world/world/knowledge')
  assert.ok(route, '路由要注册上')

  // 外机来的一律 403
  const blocked = response()
  await route.handler(request({ method: 'POST', remoteAddress: '192.0.2.9', body: { enabled: true } }), blocked)
  assert.equal(blocked.statusCode, 403)
  assert.equal(saved.length, 0)

  // GET：状态 + 当前配置（不含密钥）
  const got = response()
  await route.handler(request({ method: 'GET' }), got)
  assert.equal(got.statusCode, 200)
  assert.equal(got.json().items, 6)
  assert.equal(got.json().config.enabled, false)

  // POST enabled：只写 knowledge 这一段，其它字段不动
  const toggled = response()
  await route.handler(request({ method: 'POST', body: { enabled: true } }), toggled)
  assert.equal(toggled.statusCode, 200)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].knowledge.enabled, true)
  assert.equal(saved[0].knowledge.localModel, 'Xenova/bge-small-zh-v1.5', '没点名改的字段要留着')
  assert.deepEqual(Object.keys(saved[0]), ['knowledge'], '不许顺手改别的配置段')

  // POST rebuild：走重建，不碰配置
  const rebuilt = response()
  await route.handler(request({ method: 'POST', body: { rebuild: true } }), rebuilt)
  assert.equal(rebuilt.statusCode, 200)
  assert.equal(rebuilt.json().rebuilt, true)
  assert.equal(saved.length, 1, '重建不该顺手再存一次配置')
})
