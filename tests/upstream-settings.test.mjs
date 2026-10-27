import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDouyinSettings, douyinSnapshot, splitList } from '../lib/douyin-settings.mjs'
import { createPlatforms, normalizeAllPlatforms } from '../lib/platforms.mjs'

const TOKEN = 'a'.repeat(64)

// 模拟抖音插件的本机设置接口：GET /state 给 token 与当前值，POST 必须带对 token，并记下每次调用。
function fakeDouyin({ state, failPaths = {} } = {}) {
  const calls = []
  const current = state || {
    token: TOKEN,
    video: { policy: { windows: ['09:00-22:00'], sessionMinutes: null, weekendWindows: ['00:00-24:00'] } },
    schedule: { policy: { enabled: false, maxRequests: 30 } },
    watchOptions: { policy: { mode: 'recommend', topics: [], exclude: [] } },
    mode: { silent: false },
    spark: { policy: { enabled: false, windows: ['09:00-22:00'], dailyLimit: 2 } },
    comments: { policy: { enabled: false, dailyLimit: 3, perSessionLimit: 1 } },
    share: { enabled: false, dailyLimit: 3 },
    chat: { policy: { allowlist: [{ id: 'u1' }], dailyReplyLimit: 40 } },
  }
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname.replace('/api/douyin-browser', '')
    const respond = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })
    if (opts.method !== 'POST') return respond(200, current)
    if (failPaths[path]) return respond(failPaths[path], { error: '插件拒绝了这次设置' })
    if (opts.headers['x-douyin-settings-token'] !== current.token) return respond(403, { error: '请刷新原生设置页后重试。' })
    const body = JSON.parse(opts.body)
    calls.push({ path, body })
    // 上游收到设置后会把它记下来，之后的读取要能看到新值。
    const apply = {
      '/watch/schedule': () => { current.schedule = { policy: body } },
      '/mode/configure': () => { current.mode = { silent: body.silent } },
      '/video/configure': () => { current.video = { policy: body } },
      '/spark/configure': () => { current.spark = { policy: body } },
      '/comments/configure': () => { current.comments = { policy: body } },
      '/share/configure': () => { current.share = body },
      '/watch/options': () => { current.watchOptions = { policy: body } },
      '/chat/configure': () => { current.chat = { policy: { ...current.chat.policy, dailyReplyLimit: body.dailyReplyLimit } } },
      '/interactions/configure': () => { current.interactions = { friend: { policy: { enabled: body.enabled } } } },
    }
    apply[path]?.()
    return respond(200, {})
  }
  return { fetchImpl, calls, state: current }
}

const origin = () => 'http://127.0.0.1:5000'

test('抖音快照：上游的当前值压成面板字段，单轮不限时显示 0', () => {
  const snap = douyinSnapshot({
    video: { policy: { windows: ['09:00-12:00', '18:00-22:00'], sessionMinutes: null } },
    schedule: { policy: { enabled: true, maxRequests: 80 } },
    watchOptions: { policy: { mode: 'topic', topics: ['美食', '旅行'], exclude: ['广告'] } },
    mode: { silent: true },
    spark: { policy: { enabled: true, windows: ['10:00-11:00'], dailyLimit: 1 } },
    comments: { policy: { enabled: true, dailyLimit: 5, perSessionLimit: 2 } },
    share: { enabled: true, dailyLimit: 4 },
    chat: { policy: { dailyReplyLimit: 60 } },
  })
  assert.equal(snap.sessionMinutes, 0)
  assert.equal(snap.videoWindows, '09:00-12:00\n18:00-22:00')
  assert.equal(snap.watchTopics, '美食\n旅行')
  assert.equal(snap.autoStart, true)
  assert.equal(snap.autoStartMaxRequests, 80)
  assert.equal(snap.silentWatch, true)
  assert.equal(snap.commentPerSessionLimit, 2)
  assert.equal(snap.shareDailyLimit, 4)
  assert.equal(snap.dailyReplyLimit, 60)
})

test('面板的多行文本按上游的口径切分（换行、逗号、分号都算）', () => {
  assert.deepEqual(splitList('美食\n旅行，露营; 猫'), ['美食', '旅行', '露营', '猫'])
  assert.deepEqual(splitList('  \n  '), [])
})

test('抖音写入：只动改到的那一组入口，并带上当前 token', async () => {
  const dy = fakeDouyin()
  const client = createDouyinSettings({ getOrigin: origin, fetchImpl: dy.fetchImpl })
  const after = await client.write({ autoStart: true, autoStartMaxRequests: 50 })
  assert.deepEqual(dy.calls, [{ path: '/watch/schedule', body: { enabled: true, maxRequests: 50 } }])
  assert.equal(after.autoStart, true, '写完要重新读回上游的真实值')
})

test('抖音写入：单轮时长 0 = 不限（上游的 null），周末时段原样带回不被清掉', async () => {
  const dy = fakeDouyin()
  const client = createDouyinSettings({ getOrigin: origin, fetchImpl: dy.fetchImpl })
  await client.write({ videoWindows: '09:00-12:00\n18:00-22:00', sessionMinutes: 0 })
  assert.deepEqual(dy.calls, [{
    path: '/video/configure',
    body: { windows: ['09:00-12:00', '18:00-22:00'], sessionMinutes: null, weekendWindows: ['00:00-24:00'] },
  }])
})

test('抖音写入：私信每日上限只改额度，许可名单原样带回', async () => {
  const dy = fakeDouyin()
  const client = createDouyinSettings({ getOrigin: origin, fetchImpl: dy.fetchImpl })
  await client.write({ dailyReplyLimit: 60 })
  assert.deepEqual(dy.calls, [{ path: '/chat/configure', body: { recipientIds: ['u1'], dailyReplyLimit: 60 } }])
})

test('抖音 1.4.5：好友互动总开关走 /interactions/configure，只传 enabled', async () => {
  const dy = fakeDouyin()
  const client = createDouyinSettings({ getOrigin: origin, fetchImpl: dy.fetchImpl })
  const after = await client.write({ interactionsOn: true })
  assert.deepEqual(dy.calls, [{ path: '/interactions/configure', body: { enabled: true } }])
  assert.equal(after.interactionsOn, true)
})

test('抖音写入：同一组里未改的字段从上游当前值补齐（上游是整组覆盖）', async () => {
  const dy = fakeDouyin()
  const client = createDouyinSettings({ getOrigin: origin, fetchImpl: dy.fetchImpl })
  await client.write({ commentDailyLimit: 7 })
  assert.deepEqual(dy.calls, [{ path: '/comments/configure', body: { enabled: false, dailyLimit: 7, perSessionLimit: 1 } }])
})

test('抖音写入被拒：错误原样抛出，不假装成功', async () => {
  const dy = fakeDouyin({ failPaths: { '/share/configure': 409 } })
  const client = createDouyinSettings({ getOrigin: origin, fetchImpl: dy.fetchImpl })
  await assert.rejects(client.write({ allowShare: true }), /插件拒绝了这次设置/)
})

test('拿不到 DSH 地址时明说，不猜端口', async () => {
  const client = createDouyinSettings({ getOrigin: () => '', fetchImpl: async () => { throw new Error('不该被调用') } })
  await assert.rejects(client.read(), /读不到 DSH 的本机地址/)
})

// 主人 2026-10-27 贴的截图：「读不到插件的当前设置：抖音设置接口返回 401」。
// 抖音 1.4.5 起设置接口的真实入口是宿主的认证通道（connection.rpc），
// 裸 fetch 打到 webServer 会被 DSH 拒成 401。
test('有 RPC 时优先走宿主认证通道，不打裸 HTTP', async () => {
  let fetched = 0
  const calls = []
  const rpc = {
    async call(channel, method, payload) {
      calls.push({ channel, method, payload })
      if (payload.path === '/state') return { ok: true, value: { status: 200, body: { token: TOKEN, video: { policy: {} } } } }
      return { ok: true, value: { status: 200, body: {} } }
    },
  }
  const client = createDouyinSettings({
    getOrigin: () => 'http://127.0.0.1:5000',
    getRpc: () => rpc,
    fetchImpl: async () => { fetched += 1; throw new Error('不该走裸 HTTP') },
  })
  const snap = await client.read()
  assert.equal(fetched, 0, '有 RPC 就不该再发 HTTP（那条会被 401）')
  assert.equal(calls[0].channel, '/douyin-settings')
  assert.equal(calls[0].method, 'request')
  assert.equal(calls[0].payload.path, '/state')
  assert.equal(typeof snap, 'object')
})

test('RPC 通道把上游的 4xx 原样报出来，不静默退回 HTTP', async () => {
  let fetched = 0
  const client = createDouyinSettings({
    getOrigin: () => 'http://127.0.0.1:5000',
    getRpc: () => ({ call: async () => ({ ok: true, value: { status: 409, body: { error: '请先停止自主观看' } } }) }),
    fetchImpl: async () => { fetched += 1; return { ok: true, status: 200, text: async () => '{}' } },
  })
  await assert.rejects(client.read(), /请先停止自主观看/)
  assert.equal(fetched, 0, 'RPC 已经给了明确答复，不该再用 HTTP 猜一次')
})

test('没有 RPC 时才退回 webServer 的地址（老插件 / 非宿主环境）', async () => {
  const dy = fakeDouyin()
  const client = createDouyinSettings({ getOrigin: origin, getRpc: () => null, fetchImpl: dy.fetchImpl })
  const snap = await client.read()
  assert.ok(snap, '退回 HTTP 也要能读')
  assert.equal(dy.calls.length, 0, '读状态不该写')
})

test('上游没给设置令牌时拒绝写入', async () => {
  const dy = fakeDouyin({ state: { video: { policy: {} } } })
  const client = createDouyinSettings({ getOrigin: origin, fetchImpl: dy.fetchImpl })
  await assert.rejects(client.write({ allowShare: true }), /没给出设置令牌/)
  assert.equal(dy.calls.length, 0)
})

test('B 站扩展字段：写进插件 config.json，读回一致；范围按上游钳，提示词留空 = 删键回默认', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bili-ext-'))
  mkdirSync(join(home, 'bili-duty'), { recursive: true })
  const file = join(home, 'bili-duty', 'config.json')
  writeFileSync(file, JSON.stringify({ perDay: 2, autoMode: 'manual', autoComment: false, scanPrompt: '旧的提示词', keep: 'me' }))

  let current = normalizeAllPlatforms({})
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = patch.platforms; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  platforms.update('bili', {
    keywords: '美食\n旅行',
    commentPerRound: 99,
    tripleMode: 'triple',
    ownerName: '阿黄',
    scanPrompt: '',
  })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(raw.keywords, ['美食', '旅行'])
  assert.equal(raw.commentPerRound, 20, '每轮评论上限 20，与上游一致')
  assert.equal(raw.tripleMode, 'triple')
  assert.equal(raw.ownerName, '阿黄')
  assert.equal('scanPrompt' in raw, false, '提示词留空要删掉这一键，让插件用内置默认')
  assert.equal(raw.keep, 'me', '插件文件里不归我们管的键必须原样保留')

  const read = platforms.platform('bili')
  assert.equal(read.keywords, '美食\n旅行')
  assert.equal(read.commentPerRound, 20)
  assert.equal(read.scanPrompt, '')
})

// B 站插件 0.8.x 新增两组能力（随叫随到 / 公开动态），面板要能改，且都默认关。
test('B 站 0.8.x：随叫随到与公开动态能写进插件 config.json，默认关', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bili-new-'))
  mkdirSync(join(home, 'bili-duty'), { recursive: true })
  const file = join(home, 'bili-duty', 'config.json')
  writeFileSync(file, JSON.stringify({ perDay: 2, autoMode: 'manual' }))

  let current = normalizeAllPlatforms({})
  const configStore = {
    getConfig: () => ({ platforms: current }),
    saveConfig: (patch) => { current = patch.platforms; return { platforms: current } },
  }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })

  // 默认全关
  const fresh = platforms.platform('bili')
  assert.equal(fresh.watchOn, false, '随叫随到默认关')
  assert.equal(fresh.dynamicOn, false, '公开动态默认关')
  assert.equal(fresh.dynamicAutoOn, false, '到点自动发默认关')

  platforms.update('bili', {
    watchOn: true, watchInterval: 9999, watchScope: 'always',
    dynamicOn: true, dynamicPerDay: 99, dynamicGapMin: 0, dynamicTime: '25:00', dynamicPrompt: '今天想说点什么',
  })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.watchOn, true)
  assert.equal(raw.watchInterval, 1800, '问的间隔上限 1800，与上游一致')
  assert.equal(raw.watchScope, 'always')
  assert.equal(raw.dynamicOn, true)
  assert.equal(raw.dynamicPerDay, 10, '每天上限 10，与上游一致')
  assert.equal(raw.dynamicGapMin, 1, '间隔下限 1，与上游一致')
  assert.equal(raw.dynamicTime, '22:00', '非法时间退回上游默认')
  assert.equal(raw.dynamicPrompt, '今天想说点什么')
})

test('B 站：插件文件里删了提示词，面板不能残留旧文本', () => {  const home = mkdtempSync(join(tmpdir(), 'fw-bili-stale-'))
  mkdirSync(join(home, 'bili-duty'), { recursive: true })
  writeFileSync(join(home, 'bili-duty', 'config.json'), JSON.stringify({ perDay: 1 }))
  const stale = normalizeAllPlatforms({ bili: { scanPrompt: '旧文本' } })
  const configStore = { getConfig: () => ({ platforms: stale }), saveConfig: () => ({ platforms: stale }) }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop' })
  assert.equal(platforms.platform('bili').scanPrompt, '')
})

test('抖音：读不到上游时状态里说明原因；未安装插件时不去碰接口', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-dy-noinstall-'))
  let calls = 0
  const douyin = { read: async () => { calls += 1; return {} }, write: async () => ({}) }
  const configStore = { getConfig: () => ({ platforms: normalizeAllPlatforms({}) }), saveConfig: () => ({ platforms: {} }) }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop', douyin })
  await platforms.refresh()
  assert.equal(calls, 0, '插件没装就不该请求它的接口')
  const status = platforms.status()
  assert.match(status.platforms.find((p) => p.id === 'douyin').syncError, /还没安装/)
  assert.equal(status.platforms.find((p) => p.id === 'bili').syncError, '')
})

test('抖音：推送只带上游相关的键；本地闸门键不推上游', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-dy-push-'))
  const pushed = []
  const douyin = {
    read: async () => ({}),
    write: async (subset) => { pushed.push(subset); return {} },
  }
  const configStore = { getConfig: () => ({ platforms: normalizeAllPlatforms({}) }), saveConfig: () => ({ platforms: {} }) }
  const platforms = createPlatforms({ configStore, home, profile: 'desktop', douyin })
  await platforms.pushUpstream('douyin', { enabled: true })
  assert.equal(pushed.length, 0, '总开关只在本地闸门生效，不该推给上游')
  await platforms.pushUpstream('douyin', { allowShare: true, enabled: true })
  assert.deepEqual(pushed, [{ allowShare: true }])
})
