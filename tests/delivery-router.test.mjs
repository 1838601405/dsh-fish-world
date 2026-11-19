// 投递决策链判据：会话优先，不在就 API 直回；一条消息只回一次。
// 三场景：A 会话活 → 走会话；B 会话不活 → API；C 来回切不重复。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDeliveryRouter, FALLBACK_AFTER_MS } from '../lib/delivery-router.mjs'

/** 造一个可控环境：会话活不活、投递成不成、API 回不回。 */
function mk(opts = {}) {
  const state = {
    alive: opts.alive !== false,
    sessionSends: [],
    apiSends: [],
    sessionFails: opts.sessionFails === false ? false : Boolean(opts.sessionFails),
    apiFails: Boolean(opts.apiFails),
    now: opts.startAt || 1_700_000_000_000,
    logs: []
  }
  const router = createDeliveryRouter({
    services: () => ({
      agents: {
        get: (id) => (state.alive && String(id).includes('0f3a58af') ? { followup(){} } : undefined)
      }
    }),
    deliverToSession: async (msg) => {
      state.sessionSends.push(msg.text)
      if (state.sessionFails) return { ok: false, error: '会话没活着' }
      return { ok: true }
    },
    deliverViaApi: async (msg) => {
      state.apiSends.push(msg.text)
      if (state.apiFails) return { ok: false, error: '没有可用模型' }
      return { ok: true, text: 'API 回的' }
    },
    hasRecentReply: () => opts.hasRecentReply === true,
    now: () => state.now,
    log: (l) => state.logs.push(l)
  })
  return { router, state }
}

const msg = (text = '你好') => ({
  chatKey: 'private:1838601405',
  sessionId: 'session-0f3a58af-230f-4981-9a1d-148057e77068',
  text,
  userId: '1838601405',
  kind: 'private'
})

// ─── 场景 A：会话活着 → 走会话，不发第二遍 ───

test('场景A：会话活着 → 投会话，且不走 API', async () => {
  const { router, state } = mk({ alive: true })
  const r = await router.deliver(msg('场景A'))
  assert.equal(r.mode, 'session')
  assert.equal(state.sessionSends.length, 1, '会话收到 1 条')
  assert.equal(state.apiSends.length, 0, '不该走 API')
  assert.equal(r.waiting, true, '应在等会话回复')
  router.dispose()
})

// ─── 场景 B：会话不活 → 立刻 API，不排队 ───

test('场景B：会话不活 → 立刻走 API，不等', async () => {
  const { router, state } = mk({ alive: false })
  const t0 = Date.now()
  const r = await router.deliver(msg('场景B'))
  const spent = Date.now() - t0
  assert.equal(r.mode, 'api')
  assert.equal(r.reason, 'session-not-alive')
  assert.equal(state.sessionSends.length, 0, '不该往死会话投')
  assert.equal(state.apiSends.length, 1, 'API 应回 1 条')
  assert.ok(spent < 1000, `要立刻（实际 ${spent}ms），不许排队等会话`)
  router.dispose()
})

test('场景B：未绑定会话 → 也走 API', async () => {
  const { router, state } = mk({ alive: false })
  const r = await router.deliver({ chatKey: 'private:1838601405', sessionId: '', text: '没绑' })
  assert.equal(r.mode, 'api')
  assert.equal(r.reason, 'no-session')
  assert.equal(state.apiSends.length, 1)
  router.dispose()
})

test('场景B：会话在但投递失败 → 立刻兜 API（不排队）', async () => {
  const { router, state } = mk({ alive: true, sessionFails: true })
  const r = await router.deliver(msg('投递失败'))
  assert.equal(r.mode, 'api')
  assert.equal(r.reason, 'session-deliver-failed')
  assert.equal(state.apiSends.length, 1)
  router.dispose()
})

// ─── 防双回 ───

test('防双回：会话在窗口内回了 → 不兜底', async () => {
  const { router, state } = mk({ alive: true })
  await router.deliver(msg('会回'))
  // 模拟会话产出回复
  assert.equal(router.noteSessionReply('private:1838601405'), true)
  // 时间过了兜底窗口，也不该再发
  state.now += FALLBACK_AFTER_MS + 1000
  const r = await router.runFallbackOnce('private:1838601405')
  assert.equal(r.skipped, 'no-pending', '已回过的没有待兜底任务')
  assert.equal(state.apiSends.length, 0, '不许再发一遍')
  router.dispose()
})

test('防双回：会话没回 → 兜底一次，且只一次', async () => {
  const { router, state } = mk({ alive: true })
  await router.deliver(msg('不回'))
  // 不调 noteSessionReply，直接触发兜底
  const r1 = await router.runFallbackOnce('private:1838601405')
  assert.equal(r1.mode, 'api')
  assert.equal(r1.fallback, true, '要标成兜底')
  assert.equal(state.apiSends.length, 1)
  // 再触发一次：没有 pending 了，不该再发
  const r2 = await router.runFallbackOnce('private:1838601405')
  assert.equal(r2.skipped, 'no-pending')
  assert.equal(state.apiSends.length, 1, '兜底只能一次')
  router.dispose()
})

test('防双回：hasRecentReply 说已回 → 兜底前拦下', async () => {
  const { router, state } = mk({ alive: true, hasRecentReply: true })
  await router.deliver(msg('其实回了'))
  const r = await router.runFallbackOnce('private:1838601405')
  assert.equal(r.skipped, 'replied')
  assert.equal(state.apiSends.length, 0)
  router.dispose()
})

test('两条路都发过要能查到（记录里 mode 不同且有 fallback 标记）', async () => {
  const { router, state } = mk({ alive: true })
  await router.deliver(msg('记录'))
  await router.runFallbackOnce('private:1838601405')
  const snap = router.snapshot()
  const modes = snap.records.map((r) => r.mode)
  assert.ok(modes.includes('session'), '要记下走过会话')
  assert.ok(modes.includes('api'), '要记下走过 API')
  const fb = snap.records.find((r) => r.fallback === true)
  assert.ok(fb, '兜底那条要标 fallback')
  assert.match(fb.reason, /no-reply/, '原因要写清是没回复才兜底')
  router.dispose()
})

// ─── 场景 C：来回切 ───

test('场景C：会话关→开→关 来回切两次，不重复回复', async () => {
  const { router, state } = mk({ alive: false })
  // 关：走 API
  let r1 = await router.deliver(msg('第一句'))
  assert.equal(r1.mode, 'api')
  assert.equal(state.apiSends.length, 1)
  // 开：走会话（清缓存，让 alive 生效）
  state.alive = true
  router.dispose()  // 清 aliveCache
  const router2 = createDeliveryRouter({
    services: () => ({ agents: { get: (id) => (state.alive ? { followup(){} } : undefined) } }),
    deliverToSession: async (m) => { state.sessionSends.push(m.text); return { ok: true } },
    deliverViaApi: async (m) => { state.apiSends.push(m.text); return { ok: true } },
    now: () => state.now,
    log: () => {}
  })
  let r2 = await router2.deliver(msg('第二句'))
  assert.equal(r2.mode, 'session')
  assert.equal(state.apiSends.length, 1, '开会话后不该再走 API')
  // 再关：又走 API，但只加一条
  state.alive = false
  router2.dispose()
  const router3 = createDeliveryRouter({
    services: () => ({ agents: { get: () => undefined } }),
    deliverToSession: async (m) => { state.sessionSends.push(m.text); return { ok: true } },
    deliverViaApi: async (m) => { state.apiSends.push(m.text); return { ok: true } },
    now: () => state.now,
    log: () => {}
  })
  let r3 = await router3.deliver(msg('第三句'))
  assert.equal(r3.mode, 'api')
  assert.equal(state.apiSends.length, 2, '关两次就该有两条 API，不能多发')
  assert.equal(state.sessionSends.length, 1, '只有「开」的那一次走会话')
  router3.dispose()
})

// ─── 模型不可用要明确报错 ───

test('没有可用模型 → 明确报错，不静默丢', async () => {
  const { router } = mk({ alive: false, apiFails: true })
  const r = await router.deliver(msg('没模型'))
  assert.equal(r.ok, false)
  assert.ok(r.error, '要带错误原因')
  assert.equal(r.mode, 'api')
  router.dispose()
})

// ─── 群聊固定 API ───

test('群聊 forceApi → 不走会话，也不兜底', async () => {
  const { router, state } = mk({ alive: true })
  const r = await router.deliver(
    { chatKey: 'group:123', sessionId: 'session-0f3a58af-x', text: '群里', kind: 'group' },
    { forceApi: true, allowFallback: false }
  )
  assert.equal(r.mode, 'api')
  assert.equal(r.reason, 'forced')
  assert.equal(state.sessionSends.length, 0)
  assert.equal(r.waiting, false)
  router.dispose()
})

// ─── 兜底窗口配置 ───

test('兜底窗口是 15 秒', () => {
  assert.equal(FALLBACK_AFTER_MS, 15_000)
})

test('snapshot 能报出「正在等回复」', async () => {
  const { router } = mk({ alive: true })
  await router.deliver(msg('等'))
  const snap = router.snapshot()
  assert.equal(snap.waiting.length, 1)
  assert.ok(snap.waiting[0].willFallbackAtMs > 0)
  router.dispose()
})
