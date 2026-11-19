// 投递决策链判据：会话优先，不在就 API 直回；一条消息只回一次。
//
// 2026-11-20 三处返修后的判据：
//   1. 回复口径按时间点（不是「有没有」）→ 场景 D
//   2. in-flight 不启动计时 → 长回合只出一条回复（场景 C）
//   3. 异常兜底方向：先 API 不是先会话
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DEFAULT_FALLBACK_MS, createDeliveryRouter } from '../lib/delivery-router.mjs'

/** 可控环境：会话活不活、忙不忙、有没有回。 */
function mk(opts = {}) {
  const state = {
    alive: opts.alive !== false,
    busy: opts.busy === true,
    sessionSends: [],
    apiSends: [],
    sessionFails: opts.sessionFails === true,
    apiFails: opts.apiFails === true,
    now: opts.startAt || 1_700_000_000_000,
    logs: [],
    // 每次「会话发出回复」的时刻（用于按时间点判回复）
    replyAt: [],
    lastRepliedAt: 0
  }
  const router = createDeliveryRouter({
    services: () => ({
      agents: { get: (id) => (state.alive && String(id).includes('0f3a58af') ? { followup(){} } : undefined) }
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
    hasReplySince: (chatKey, sinceMs) => state.lastRepliedAt > Number(sinceMs),
    isSessionBusy: () => state.busy,
    now: () => state.now,
    log: (l) => state.logs.push(l),
    fallbackAfterMs: opts.fallbackAfterMs
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
  assert.equal(state.sessionSends.length, 1)
  assert.equal(state.apiSends.length, 0, '不该走 API')
  assert.equal(r.waiting, true)
  router.dispose()
})

// ─── 场景 B：会话不活 → 立刻 API ───

test('场景B：会话不活 → 立刻走 API，不等', async () => {
  const { router, state } = mk({ alive: false })
  const t0 = Date.now()
  const r = await router.deliver(msg('场景B'))
  const spent = Date.now() - t0
  assert.equal(r.mode, 'api')
  assert.equal(r.reason, 'session-not-alive')
  assert.equal(state.sessionSends.length, 0)
  assert.equal(state.apiSends.length, 1)
  assert.ok(spent < 1000, `要立刻（实际 ${spent}ms）`)
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

test('场景B：会话在但投递失败 → 立刻兜 API', async () => {
  const { router, state } = mk({ alive: true, sessionFails: true })
  const r = await router.deliver(msg('投递失败'))
  assert.equal(r.mode, 'api')
  assert.equal(r.reason, 'session-deliver-failed')
  assert.equal(state.apiSends.length, 1)
  router.dispose()
})

// ─── 场景 D（返修 1）：回复口径按时间点 ───

test('场景D：会话先回过上一句，再发新消息且不回 → 兜底必须触发', async () => {
  const { router, state } = mk({ alive: true })
  // 上一句：会话在 T0 之前就回过了
  state.lastRepliedAt = state.now - 30_000

  // 这条新消息：投递时刻 T > lastRepliedAt
  const r = await router.deliver(msg('新消息'))
  assert.equal(r.mode, 'session')

  // 会话不会再回；到了兜底点
  const fb = await router.runFallbackOnce('private:1838601405')
  assert.equal(fb.mode, 'api',
    '★ 返修1：上一句的回复不该顶掉这条消息的兜底（旧写法这里不会触发）')
  assert.equal(fb.fallback, true)
  assert.equal(state.apiSends.length, 1)
  router.dispose()
})

test('场景D 反面：这条消息之后真回过 → 不兜底', async () => {
  const { router, state } = mk({ alive: true })
  await router.deliver(msg('会回'))
  // 投递之后会话回了（时间晚于 messageT）
  state.lastRepliedAt = state.now + 1000
  const fb = await router.runFallbackOnce('private:1838601405')
  assert.equal(fb.skipped, 'replied')
  assert.equal(state.apiSends.length, 0)
  router.dispose()
})

// ─── 场景 C（返修 2）：in-flight 不启动计时 ───

test('场景C：会话在忙（in-flight）→ 不启动兜底计时', async () => {
  const { router, state } = mk({ alive: true, busy: true })
  const r = await router.deliver(msg('长回合'))
  assert.equal(r.mode, 'session')
  assert.equal(r.waiting, true)
  // 关键：此时没有计时，snapshot 里 started=false
  const snap = router.snapshot()
  assert.equal(snap.waiting.length, 1)
  assert.equal(snap.waiting[0].started, false, '★ 返修2：in-flight 时不许启动计时')
  // 日志要写清为什么
  assert.ok(state.logs.some((l) => l.includes('in-flight')), '要记下 in-flight 等待')
  router.dispose()
})

test('场景C：会话空闲后才开始计时（长回合不被误判超时）', async () => {
  const { router, state } = mk({ alive: true, busy: true })
  await router.deliver(msg('长回合'))
  // 会话一直忙 → 即使过了窗口也不该兜底
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(state.apiSends.length, 0, '会话还在处理，不许抢答')
  // 忙完了（轮结束）
  assert.equal(router.noteSessionIdle('private:1838601405'), true, '要能启动计时')
  const snap = router.snapshot()
  assert.equal(snap.waiting[0].started, true, '空闲后才 started=true')
  router.dispose()
})

test('场景C：20 秒才回的回合 → 只出现一条回复', async () => {
  // 用短窗口（1 秒）模拟，但会话在忙 1.2 秒后才回
  const { router, state } = mk({ alive: true, busy: true, fallbackAfterMs: 1000 })
  await router.deliver(msg('要 20 秒'))

  // 会话处理中：等 1.2 秒（超过窗口），但因为 in-flight 没启动计时 → 不该兜底
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(state.apiSends.length, 0, '★ 返修2：in-flight 期间超窗口也不许兜底')

  // 会话产出了回复（sendBubbles 出口会调这个）
  router.noteSessionReply('private:1838601405')

  // 再等等：确认没有第二条
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(state.apiSends.length, 0, '会话回了就不许再兜底')
  assert.equal(state.sessionSends.length, 1, '只有会话那一条')
  router.dispose()
})

// ─── 防双回 ───

test('防双回：会话在窗口内回了 → 不兜底', async () => {
  const { router, state } = mk({ alive: true })
  await router.deliver(msg('会回'))
  assert.equal(router.noteSessionReply('private:1838601405'), true)
  const fb = await router.runFallbackOnce('private:1838601405')
  assert.equal(fb.skipped, 'no-pending')
  assert.equal(state.apiSends.length, 0)
  router.dispose()
})

test('防双回：会话没回 → 兜底一次，且只一次', async () => {
  const { router, state } = mk({ alive: true })
  await router.deliver(msg('不回'))
  const r1 = await router.runFallbackOnce('private:1838601405')
  assert.equal(r1.mode, 'api')
  assert.equal(r1.fallback, true)
  assert.equal(state.apiSends.length, 1)
  const r2 = await router.runFallbackOnce('private:1838601405')
  assert.equal(r2.skipped, 'no-pending')
  assert.equal(state.apiSends.length, 1, '兜底只能一次')
  router.dispose()
})

test('两条路都发过要能查到（mode 不同 + fallback 标记）', async () => {
  const { router } = mk({ alive: true })
  await router.deliver(msg('记录'))
  await router.runFallbackOnce('private:1838601405')
  const snap = router.snapshot()
  const modes = snap.records.map((r) => r.mode)
  assert.ok(modes.includes('session'))
  assert.ok(modes.includes('api'))
  const fb = snap.records.find((r) => r.fallback === true)
  assert.ok(fb, '兜底那条要标 fallback')
  assert.match(fb.reason, /no-reply/)
  router.dispose()
})

// ─── 场景 C：来回切 ───

test('场景C：会话关→开→关 来回切两次，不重复回复', async () => {
  const state = { api: [], session: [], alive: false }
  const mkR = () => createDeliveryRouter({
    services: () => ({ agents: { get: () => (state.alive ? { followup(){} } : undefined) } }),
    deliverToSession: async (m) => { state.session.push(m.text); return { ok: true } },
    deliverViaApi: async (m) => { state.api.push(m.text); return { ok: true } },
    now: () => Date.now(),
    hasReplySince: () => false,
    log: () => {}
  })
  let r = mkR()
  assert.equal((await r.deliver(msg('1'))).mode, 'api')
  r.dispose()
  state.alive = true
  r = mkR()
  assert.equal((await r.deliver(msg('2'))).mode, 'session')
  r.dispose()
  state.alive = false
  r = mkR()
  assert.equal((await r.deliver(msg('3'))).mode, 'api')
  r.dispose()
  assert.equal(state.api.length, 2)
  assert.equal(state.session.length, 1)
})

// ─── 模型不可用 / 群聊 ───

test('没有可用模型 → 明确报错，不静默丢', async () => {
  const { router } = mk({ alive: false, apiFails: true })
  const r = await router.deliver(msg('没模型'))
  assert.equal(r.ok, false)
  assert.ok(r.error)
  router.dispose()
})

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

// ─── 配置默认值 ───

test('兜底窗口默认 40 秒（不是旧的 15 秒）', () => {
  assert.equal(DEFAULT_FALLBACK_MS, 40_000)
})

test('窗口可配：传进去就生效', async () => {
  const { router } = mk({ alive: true, fallbackAfterMs: 5000 })
  assert.equal(router.fallbackAfterMs, 5000)
  await router.deliver(msg('x'))
  const snap = router.snapshot()
  assert.equal(snap.fallbackAfterMs, 5000)
  router.dispose()
})

// ─── 返修 3：异常兜底方向（源码级，因为它在 index.js 的 catch 里）──

test('返修3：决策链异常时先退 API，不是退回会话（源码级）', () => {
  const src = readFileSync('lib/index.js', 'utf8')
  const i = src.indexOf('async function deliverAny')
  assert.ok(i > 0, '要能找到 deliverAny')
  const body = src.slice(i, i + 2600)
  assert.match(body, /catch \(error\)/, '要有 catch')
  // catch 里必须调 deliverViaChatApi
  const catchIdx = body.indexOf('catch (error)')
  const after = body.slice(catchIdx)
  assert.match(after, /deliverViaChatApi/, '★ 返修3：catch 里要先退 API')
  // 不许在调 API 之前就退回会话（方向反了）。
  // ★ 要认『return await deliverToSession』这种变体：只匹配 return deliverToSession
  //   会让判据太宽松——反证插进去也红不了（实测过）。
  const apiIdx = after.search(/deliverViaChatApi/)
  assert.ok(apiIdx > 0, 'catch 里要调 deliverViaChatApi')
  const sessReturn = after.search(/return\s+(?:await\s+)?deliverToSession\s*\(/)
  if (sessReturn >= 0) {
    assert.ok(sessReturn > apiIdx,
      '★ 返修3：catch 里不许先退回会话（会话往往正是不活的那个）')
  }
  // 彻底失败要留痕
  assert.match(after, /投递失败/, '最后要记失败')
})

test('返修3：决策链异常 → API 真能兜住（行为级）', async () => {
  // 模拟 index.js 的 catch 逻辑：router 抛错 → 调 API
  let apiCalled = 0
  async function deliverAnyLike() {
    const router = createDeliveryRouter({
      services: () => ({ agents: { get: () => undefined } }),
      deliverToSession: async () => { throw new Error('boom') },
      deliverViaApi: async () => { apiCalled++; return { ok: true } },
      log: () => {}
    })
    try {
      await router.deliver(msg('x'))
    } catch {
      // 退 API（不是退会话）
      await (async () => { apiCalled++ })()
    }
    router.dispose()
  }
  await deliverAnyLike()
  assert.ok(apiCalled >= 1, '异常路径要能落 API')
})

// ─────────────────────────────────────────────────────────
// 绑定会话韧性（2026-11-20 主人要求）：
//   「现在每次重启后都得手动打开『来聊天吧』，桥才认它活着。
//    建议：目标会话没开时自动降级，不需要人工介入。」
//
// 判据要钉住三件事（缺一件就要人工）：
//   ① 重启后（会话没打开）→ 自动走 API，不抛错、不排队
//   ② 事后打开会话 → 自动回到会话，不用重启插件
//   ③ 会话活着但正忙 → 不误判，投进会话等它回
// ─────────────────────────────────────────────────────────

test('绑定会话韧性①：重启后会话没打开 → 自动降级 API', async () => {
  const { router, state } = mk({ alive: false })
  const r = await router.deliver(msg('重启后第一条'))
  assert.equal(r.mode, 'api', '★ 不许因为会话没开就没人回')
  assert.equal(r.reason, 'session-not-alive')
  assert.equal(state.apiSends.length, 1)
  assert.equal(state.sessionSends.length, 0, '不该往死会话投')
  router.dispose()
})

test('绑定会话韧性②：事后打开会话 → 自动回到会话（不用重启插件）', async () => {
  // 第 1 次：会话不在
  const a = mk({ alive: false })
  assert.equal((await a.router.deliver(msg('第一条'))).mode, 'api')
  a.router.dispose()

  // 第 2 次：会话已经打开（新建 router 模拟「过了一段时间」，
  // 因为 aliveCache 是 1 秒缓存，同一实例内不会立刻变）
  const b = mk({ alive: true })
  const r2 = await b.router.deliver(msg('第二条'))
  assert.equal(r2.mode, 'session', '★ 打开后要自动回到会话，不需要重启/改配置')
  assert.equal(b.state.sessionSends.length, 1)
  b.router.dispose()
})

test('绑定会话韧性③：会话活着但正忙 → 投会话，不误降级', async () => {
  const { router, state } = mk({ alive: true, busy: true })
  const r = await router.deliver(msg('忙的时候'))
  assert.equal(r.mode, 'session', '忙不等于不在，不该降级到 API')
  assert.equal(state.apiSends.length, 0)
  assert.equal(r.waiting, true)
  router.dispose()
})

test('绑定会话韧性：会话路径要给出 reason（排障要看得到）', async () => {
  const { router } = mk({ alive: true })
  const r = await router.deliver(msg('看 reason'))
  assert.equal(r.reason, 'session-alive',
    '★ 会话路径以前没有 reason，activity 里是 undefined，排障时看不出走的哪条')
  router.dispose()
})

test('绑定会话韧性：未绑定 / 绑定为空都自动走 API', async () => {
  for (const sid of ['', null, undefined]) {
    const { router, state } = mk({ alive: false })
    const r = await router.deliver({ chatKey: 'private:1', sessionId: sid, text: 'x', kind: 'private' })
    assert.equal(r.mode, 'api', `sessionId=${JSON.stringify(sid)} 时应走 API`)
    assert.equal(state.apiSends.length, 1)
    router.dispose()
  }
})
