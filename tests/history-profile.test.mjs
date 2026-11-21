// 主动翻记录 + 改自己资料 判据（2026-11-20 主人要求二、三）。
//
// 二、翻记录：只翻当前会话 / 24 小时窗 / 每轮 1 次 / 合并转发最多 2 层 / 同条不重复展开 /
//            查不到就说查不到 / activity 记 history-recall
// 三、改资料：头像 / 昵称签名 / 在线状态；只有 self|owner 能改；频控（头像每天、昵称每周）；
//            失败如实说；activity 记 profile-change
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_LIMIT,
  HISTORY_WINDOW_MS,
  MAX_FORWARD_DEPTH,
  MAX_LIMIT,
  createHistoryRecall
} from '../lib/history-recall.mjs'
import {
  AVATAR_MAX_BYTES,
  AVATAR_WINDOW_MS,
  PROFILE_WINDOW_MS,
  createProfileEdit
} from '../lib/profile-edit.mjs'

const GROUP = 'group:1053484753'

// ═══════════════════════ 二、主动翻记录 ═══════════════════════

function mkRecall(opts = {}) {
  const acts = []
  const calls = []
  const state = {
    now: opts.startAt || 1_700_000_000_000,
    ok: opts.ok !== false,
    messages: opts.messages || [
      { userId: '111', nickname: '甲', text: '我们明天去爬山', at: 1_700_000_000_000 - 3600_000 },
      { userId: '222', nickname: '乙', text: '好啊几点集合', at: 1_700_000_000_000 - 3500_000 }
    ],
    entries: opts.entries || [
      { nickname: '丙', userId: '333', text: '转发里的一句', at: 1_700_000_000_000 - 7200_000 }
    ]
  }
  const qq = {
    async recent(chatKey, limit) {
      calls.push({ fn: 'recent', chatKey, limit })
      if (!state.ok) return { ok: false, reason: 'onebot-error', messages: [] }
      return { ok: true, messages: state.messages }
    },
    async forward(id) {
      calls.push({ fn: 'forward', id })
      if (!state.ok) return { ok: false, reason: 'onebot-error', entries: [] }
      return { ok: true, entries: state.entries }
    }
  }
  const activity = { append: (e) => { acts.push(e) } }
  const hr = createHistoryRecall({ qq, activity, now: () => state.now, log: () => {} })
  return { hr, acts, calls, state }
}

test('翻记录：默认 50 条，上限 100', async () => {
  const { hr, calls } = mkRecall()
  await hr.recall({ chatKey: GROUP })
  assert.equal(calls[0].limit, DEFAULT_LIMIT, '默认 50')
  assert.equal(DEFAULT_LIMIT, 50)

  const { hr: hr2, calls: c2 } = mkRecall()
  await hr2.recall({ chatKey: GROUP, limit: 999 })
  assert.equal(c2[0].limit, MAX_LIMIT, '★ 上限 100，不许无限翻')
})

test('翻记录：每轮最多 1 次', async () => {
  const { hr, calls } = mkRecall()
  const first = await hr.recall({ chatKey: GROUP })
  assert.equal(first.ok, true)
  const second = await hr.recall({ chatKey: GROUP })
  assert.equal(second.ok, false, '★ 同一轮不许翻第二次')
  assert.match(second.say, /已经翻过/)
  assert.equal(calls.length, 1, '第二次不该再打请求')

  // 新一轮可以再翻
  hr.beginTurn()
  const third = await hr.recall({ chatKey: GROUP })
  assert.equal(third.ok, true, 'beginTurn 之后能再翻')
})

test('翻记录：没显式 beginTurn 时，隔久了也算新的一轮', async () => {
  // ★ 双保险：光靠 beginTurn 挂死在一个钩子上，容易出现
  //   「这一轮永远不重置」或「同一轮重置两次」。所以有时间窗兜底。
  const { hr, state } = mkRecall()
  const first = await hr.recall({ chatKey: GROUP })
  assert.equal(first.ok, true)

  state.now += 31_000   // 31 秒后（> 30 秒的 TURN_GAP_MS）
  const second = await hr.recall({ chatKey: GROUP })
  assert.equal(second.ok, true, '★ 隔久了不用 beginTurn 也能再翻')

  // 但紧接着再翻就要拒
  const third = await hr.recall({ chatKey: GROUP })
  assert.equal(third.ok, false, '同一轮仍然只许翻一次')
})

test('翻记录：canRecall 如实反映能不能翻', async () => {
  const { hr, state } = mkRecall()
  assert.equal(hr.canRecall(), true, '一开始能翻')
  await hr.recall({ chatKey: GROUP })
  assert.equal(hr.canRecall(), false, '翻过之后不能')
  state.now += 31_000
  assert.equal(hr.canRecall(), true, '隔久了又能')
  hr.beginTurn()
  assert.equal(hr.canRecall(), true, 'beginTurn 立即重置')
})

test('翻记录：只留 24 小时内的', async () => {
  const base = 1_700_000_000_000
  const { hr, state } = mkRecall({
    startAt: base,
    messages: [
      { userId: '1', text: '一小时前', at: base - 3600_000 },
      { userId: '2', text: '23 小时前', at: base - 23 * 3600_000 },
      { userId: '3', text: '25 小时前(超窗)', at: base - 25 * 3600_000 },
      { userId: '4', text: '三天前(超窗)', at: base - 3 * 24 * 3600_000 }
    ]
  })
  const r = await hr.recall({ chatKey: GROUP })
  assert.equal(r.messages.length, 2, '★ 时间窗 24 小时，更旧的不翻')
  assert.ok(r.messages.every((m) => !m.text.includes('超窗')))
  assert.equal(HISTORY_WINDOW_MS, 24 * 3600_000)
})

test('翻记录：结果按时间正序（旧的在前）', async () => {
  const base = 1_700_000_000_000
  const { hr } = mkRecall({
    startAt: base,
    messages: [
      { userId: '1', text: '后来的', at: base - 1000 },
      { userId: '2', text: '早的', at: base - 9000 }
    ]
  })
  const r = await hr.recall({ chatKey: GROUP })
  assert.equal(r.messages[0].text, '早的', '★ 顺着读才像聊天记录')
})

test('翻记录：带 query 时判命中，没命中如实说', async () => {
  const { hr, acts } = mkRecall()
  const hit = await hr.recall({ chatKey: GROUP, query: '爬山' })
  assert.equal(hit.hit, true)

  const { hr: hr2, acts: a2 } = mkRecall()
  const miss = await hr2.recall({ chatKey: GROUP, query: '潜水艇' })
  assert.equal(miss.hit, false, '★ 没命中要如实说 hit=false')
  assert.match(miss.say, /没看到那句/)

  const act = a2.find((x) => x.kind === 'history-recall')
  assert.ok(act, '要记 activity')
  assert.equal(act.tone, 'miss', '没命中标 miss')
})

test('翻记录：activity 记 kind=history-recall（含查询词、条数、命中）', async () => {
  const { hr, acts } = mkRecall()
  await hr.recall({ chatKey: GROUP, query: '爬山' })
  const a = acts.find((x) => x.kind === 'history-recall')
  assert.ok(a, '★ 主人要求 activity 记 history-recall')
  assert.match(a.text, /爬山/, '要带查询词')
  assert.match(a.text, /2 条/, '要带条数')
  assert.match(a.text, /找到了/, '要带命中')
})

test('翻记录：查不到（协议端报错）就说查不到，不编', async () => {
  const { hr } = mkRecall({ ok: false })
  const r = await hr.recall({ chatKey: GROUP })
  assert.equal(r.ok, false)
  assert.equal(r.hit, false)
  assert.equal(r.messages.length, 0, '★ 查不到就空着，不许编内容')
  assert.match(r.say, /翻不到/)
})

test('翻记录：没有 chatKey 就不翻', async () => {
  const { hr, calls } = mkRecall()
  const r = await hr.recall({ chatKey: '' })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 0)
})

test('合并转发：最多展开 2 层', async () => {
  const { hr } = mkRecall()
  const l1 = await hr.expand({ forwardId: 'f1', depth: 1 })
  assert.equal(l1.ok, true)
  const l2 = await hr.expand({ forwardId: 'f2', depth: 2 })
  assert.equal(l2.ok, true)
  const l3 = await hr.expand({ forwardId: 'f3', depth: 3 })
  assert.equal(l3.ok, false, '★ 第 3 层不许展开')
  assert.match(l3.say, /太深/)
  assert.equal(MAX_FORWARD_DEPTH, 2)
})

test('合并转发：同一条不重复展开', async () => {
  const { hr, calls } = mkRecall()
  await hr.expand({ forwardId: 'f9' })
  const again = await hr.expand({ forwardId: 'f9' })
  assert.equal(again.ok, false)
  assert.equal(again.alreadyExpanded, true, '★ 同一条不重复展开')
  assert.equal(calls.length, 1, '第二次不该再打请求')
})

// ═══════════════════════ 三、改自己资料 ═══════════════════════

function mkProfile(opts = {}) {
  const acts = []
  const calls = []
  const dir = mkdtempSync(join(tmpdir(), 'prof-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, Buffer.alloc(opts.imgSize || 1024))
  const state = {
    now: opts.startAt || 1_700_000_000_000,
    ok: opts.ok !== false,
    gateOk: opts.gateOk !== false,
    // ★ 默认「没有已批准的请求」—— 鱼自己想换头像必须先有这个（主人 2026-11-20 加的硬线）
    approvedWish: opts.approvedWish === true
  }
  const qq = {
    async call(action, body) {
      calls.push({ action, body })
      if (!state.ok) return { ok: false, error: '被审核拦了' }
      return { ok: true }
    }
  }
  const gate = {
    checkAction: () => (state.gateOk ? { ok: true } : { ok: false, reason: '安静时段' })
  }
  const activity = { append: (e) => { acts.push(e) } }
  const pe = createProfileEdit({
    qq,
    activity,
    gate,
    approvedWish: () => state.approvedWish,
    stateFile: join(dir, 'state.json'),
    now: () => state.now,
    log: () => {}
  })
  return { pe, calls, acts, state, img, dir }
}

test('改资料：头像每天 1 次', async () => {
  const { pe, calls, acts, state, img } = mkProfile()
  const first = await pe.setAvatar({ path: img, source: 'owner' })
  assert.equal(first.ok, true)
  assert.equal(calls[0].action, 'set_qq_avatar')
  assert.equal(calls[0].body.file, img)

  state.now += 3600_000  // 1 小时后
  const second = await pe.setAvatar({ path: img, source: 'owner' })
  assert.equal(second.ok, false, '★ 头像每天只能换一次')
  assert.match(second.say, /小时后/)

  const a = acts.filter((x) => x.kind === 'profile-change')
  assert.ok(a.length >= 1, '要记 activity')
  assert.match(a[0].text, /换了头像/)
})

test('改资料：头像隔天能再换', async () => {
  const { pe, state, img } = mkProfile()
  await pe.setAvatar({ path: img, source: 'owner' })
  state.now += AVATAR_WINDOW_MS + 1000
  const again = await pe.setAvatar({ path: img, source: 'owner' })
  assert.equal(again.ok, true)
})

test('改资料：只收 png/jpg，超过 2MB 拒', async () => {
  const { pe, img, dir } = mkProfile()
  const txt = join(dir, 'a.gif')
  writeFileSync(txt, Buffer.alloc(100))
  const r1 = await pe.setAvatar({ path: txt, source: 'owner' })
  assert.equal(r1.ok, false)
  assert.match(r1.say, /png/)

  const big = join(dir, 'big.png')
  writeFileSync(big, Buffer.alloc(AVATAR_MAX_BYTES + 1))
  const r2 = await pe.setAvatar({ path: big, source: 'owner' })
  assert.equal(r2.ok, false)
  assert.match(r2.say, /2MB/)
})

test('改资料：只有 self / owner 能改（别人让改不给口子）', async () => {
  const { pe, calls, img } = mkProfile()
  for (const bad of ['', 'friend', '群友', 'stranger', undefined]) {
    const r = await pe.setAvatar({ path: img, source: bad })
    assert.equal(r.ok, false, '★ 来源不是 self/owner 一律拒')
    assert.match(r.say, /不是我|不是主人/)
  }
  assert.equal(calls.length, 0, '★ 一条请求都不该发')
})

test('改资料：头像失败如实说，不假装成功', async () => {
  const { pe, img } = mkProfile({ ok: false })
  const r = await pe.setAvatar({ path: img, source: 'owner' })
  assert.equal(r.ok, false)
  assert.match(r.say, /没传上去/, '★ 主人要求如实说')
  assert.doesNotMatch(r.say, /^头像换了$/)
})

test('改资料：昵称签名每周 1 次', async () => {
  const { pe, calls, state } = mkProfile()
  const first = await pe.setProfile({ nickname: '小鲸鱼', source: 'owner' })
  assert.equal(first.ok, true)
  const setName = calls.find((c) => c.action === 'set_qq_profile')
  assert.ok(setName, '要真的调 set_qq_profile')
  assert.equal(setName.body.nickname, '小鲸鱼')

  state.now += 86400_000  // 一天后
  const second = await pe.setProfile({ signature: '今天摸鱼', source: 'self' })
  assert.equal(second.ok, false, '★ 昵称/签名每周只能改一次')
  assert.match(second.say, /一周/)

  state.now += PROFILE_WINDOW_MS
  const third = await pe.setProfile({ signature: '今天摸鱼', source: 'self' })
  assert.equal(third.ok, true)
  assert.equal(PROFILE_WINDOW_MS, 7 * 24 * 3600_000)
})

test('改资料：activity 记旧值→新值', async () => {
  const { pe, acts } = mkProfile()
  await pe.setProfile({ nickname: '小鲸鱼', source: 'self' })
  const a = acts.find((x) => x.kind === 'profile-change')
  assert.match(a.text, /昵称.*→.*小鲸鱼/, '★ 主人要求记旧值→新值')
})

test('改资料：频控状态落盘（重启也记得）', async () => {
  const { pe, img, dir } = mkProfile()
  await pe.setAvatar({ path: img, source: 'owner' })
  const f = join(dir, 'state.json')
  assert.ok(existsSync(f), '★ 不落盘的话重启就能再改一次，频控等于没有')
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  assert.ok(raw.avatarAt > 0, '要记住上次换头像的时间')
})

test('改资料：过闸（安静时段不改）', async () => {
  const { pe, calls, img } = mkProfile({ gateOk: false })
  const r = await pe.setAvatar({ path: img, source: 'owner' })
  assert.equal(r.ok, false)
  assert.match(r.say, /不能/)
  assert.equal(calls.length, 0)
})

test('改资料：在线状态也能改', async () => {
  const { pe, calls, acts } = mkProfile()
  const r = await pe.setOnline({ status: 30, source: 'self' })
  assert.equal(r.ok, true)
  assert.equal(calls[0].action, 'set_online_status')
  assert.equal(calls[0].body.status, 30)
  assert.ok(acts.some((x) => x.kind === 'profile-change'))
})

// ── ★ 主人 2026-11-20 加的硬线：头像必须经「鱼的请求」批准才能换 ──

test('头像审批：鱼自己想换 + 没批准 → 拒（这就是新的硬线）', async () => {
  const { pe, calls, img } = mkProfile({ approvedWish: false })
  const r = await pe.setAvatar({ path: img, source: 'self' })
  assert.equal(r.ok, false, '★ 没经批准不许自己换头像')
  assert.match(r.say, /先提请求|主人同意/, '要告诉她该怎么办')
  assert.equal(calls.length, 0, '★ 一条请求都不该发')
})

test('头像审批：鱼自己想换 + 已批准 → 允许', async () => {
  const { pe, calls, img } = mkProfile({ approvedWish: true })
  const r = await pe.setAvatar({ path: img, source: 'self' })
  assert.equal(r.ok, true, '批准了就能换')
  assert.equal(calls[0].action, 'set_qq_avatar')
})

test('头像审批：主人当场要求 → 不用再批准', async () => {
  const { pe, calls, img } = mkProfile({ approvedWish: false })
  const r = await pe.setAvatar({ path: img, source: 'owner' })
  assert.equal(r.ok, true, '★ 主人自己要求的不需要再走请求')
  assert.equal(calls[0].action, 'set_qq_avatar')
})

test('头像审批：approvedWish 回调抛错 → 当作没批准（安全侧）', async () => {
  // 读不到请求状态时绝不能默认放行
  const dir = mkdtempSync(join(tmpdir(), 'prof-x-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, Buffer.alloc(512))
  const calls = []
  const pe = createProfileEdit({
    qq: { async call(a, b) { calls.push(a); return { ok: true } } },
    approvedWish: () => { throw new Error('读不到') },
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  const r = await pe.setAvatar({ path: img, source: 'self' })
  assert.equal(r.ok, false, '★ 读不到就按没批准处理，不放行')
  assert.equal(calls.length, 0)
})

test('头像审批：昵称签名不受这条限制（只有头像要批准）', async () => {
  // 主人只点名了头像；昵称/签名仍然是 self/owner 即可（但仍受每周频控）
  const { pe, calls } = mkProfile({ approvedWish: false })
  const r = await pe.setProfile({ nickname: '小鲸鱼', source: 'self' })
  assert.equal(r.ok, true, '昵称不需要走请求')
  assert.ok(calls.some((c) => c.action === 'set_qq_profile'), '要真的调 set_qq_profile')
})

test('头像审批：profile-edit 源码里必须有这道检查', () => {
  const src = readFileSync('lib/profile-edit.mjs', 'utf8')
  assert.match(src, /function checkAvatarAllowed/, '要有专门的审批函数')
  assert.match(src, /approvedWish/, '要接已批准请求的回调')
  assert.match(src, /先提请求/, '拒绝时要告诉她怎么办')
  // 必须在调接口之前
  const checkIdx = src.indexOf('checkAvatarAllowed(src.source)')
  const callIdx = src.indexOf("'set_qq_avatar'")
  assert.ok(checkIdx > 0 && callIdx > checkIdx, '★ 先审批再发请求')
})

// ── ★ 2026-11-21 主人要求：改过真实账号必须能还原，且不许留测试数据 ──
// 背景：2026-11-20 我为验 set_qq_profile 把昵称改成 "x" 之后没还原，留了一周脏数据。

function mkProfileWithServer(opts = {}) {
  const acts = []
  const calls = []
  const dir = mkdtempSync(join(tmpdir(), 'prof-restore-'))
  // 假服务器：真的记账 nickname，能回读
  const server = { nickname: opts.nickname ?? '哦鲸鲸不是欧金金', signature: '' }
  const state = { now: opts.startAt || 1_700_000_000_000, gateOk: true, approvedWish: true }
  const qq = {
    async call(action, body) {
      calls.push({ action, body })
      if (action === 'set_qq_profile') {
        if (body?.nickname) server.nickname = body.nickname
        if (body?.personal_note != null) server.signature = body.personal_note
        return { ok: true }
      }
      if (action === 'get_login_info') return { ok: true, data: { user_id: 1, nickname: server.nickname } }
      if (action === 'get_stranger_info') return { ok: true, data: { nickname: server.nickname } }
      return { ok: true }
    }
  }
  const pe = createProfileEdit({
    qq,
    activity: { append: (e) => acts.push(e) },
    gate: { checkAction: () => (state.gateOk ? { ok: true } : { ok: false, reason: '安静时段' }) },
    approvedWish: () => state.approvedWish,
    stateFile: join(dir, 'state.json'),
    now: () => state.now,
    log: () => {}
  })
  return { pe, calls, acts, state, server, dir }
}

test('还原：记住「最初的值」，后续改动不覆盖它', async () => {
  const { pe, state, server } = mkProfileWithServer({ nickname: '哦鲸鲸不是欧金金' })
  await pe.setProfile({ nickname: 'x', source: 'owner' })
  assert.equal(server.nickname, 'x', '第一次改成功')
  state.now += PROFILE_WINDOW_MS + 1000
  await pe.setProfile({ nickname: 'y', source: 'owner' })
  assert.equal(server.nickname, 'y', '第二次改成功')
  // ★ 最初的值应该还是「哦鲸鲸不是欧金金」，不能被 y 覆盖
  const snap = pe.snapshot()
  assert.equal(snap.originalNickname, '哦鲸鲸不是欧金金', '★ original 只记第一次')
})

test('还原：restoreProfile 能把昵称改回最初的值', async () => {
  const { pe } = mkProfileWithServer({ nickname: '哦鲸鲸不是欧金金' })
  await pe.setProfile({ nickname: 'x', source: 'owner' })
  const r = await pe.restoreProfile({ source: 'owner' })
  assert.equal(r.ok, true, `say="${r.say}"`)
  assert.equal(r.say, '还原了')
})

test('还原：不受每周频控限制（收拾现场不该被业务规则挡）', async () => {
  const { pe } = mkProfileWithServer()
  await pe.setProfile({ nickname: 'x', source: 'owner' })
  // 立刻还原 —— 按 setProfile 的频控这一周都不该再改，但还原必须能过
  const r = await pe.restoreProfile({ source: 'owner' })
  assert.equal(r.ok, true, '★ 还原不该被频控挡住')
})

test('还原：只改过昵称时，还原只动昵称', async () => {
  const { pe, calls } = mkProfileWithServer()
  await pe.setProfile({ nickname: 'x', source: 'owner' })
  calls.length = 0
  await pe.restoreProfile({ source: 'owner' })
  const setCall = calls.find((c) => c.action === 'set_qq_profile')
  assert.equal(setCall.body.nickname, '哦鲸鲸不是欧金金')
  assert.equal(setCall.body.personal_note, undefined, '没改过签名就别动签名')
})

test('还原：没记过原值 → 明说不知道还原成什么', async () => {
  const { pe } = mkProfileWithServer()
  const r = await pe.restoreProfile({ source: 'owner' })
  assert.equal(r.ok, false)
  assert.match(r.say, /没有记下|不知道/)
})

test('还原：仍要求 self/owner 来源', async () => {
  const { pe } = mkProfileWithServer()
  await pe.setProfile({ nickname: 'x', source: 'owner' })
  const r = await pe.restoreProfile({ source: 'friend' })
  assert.equal(r.ok, false)
  assert.match(r.say, /不是我|不是主人/)
})

test('还原：回读不一致要如实说没还原成功', async () => {
  // 造一个"接受请求但没真的改回去"的服务器：
  // 第一次读给原值，之后一直给另一个值 —— 这样"还原后回读"必然对不上。
  const dir = mkdtempSync(join(tmpdir(), 'prof-bad-'))
  const acts = []
  let reads = 0
  const pe = createProfileEdit({
    qq: {
      async call(action) {
        if (action === 'get_login_info' || action === 'get_stranger_info') {
          reads++
          return { ok: true, data: { nickname: reads <= 1 ? '原值A' : '坏掉了B' } }
        }
        return { ok: true }          // set 永远"成功"
      }
    },
    activity: { append: (e) => acts.push(e) },
    gate: { checkAction: () => ({ ok: true }) },
    approvedWish: () => true,
    stateFile: join(dir, 'state.json'),
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  await pe.setProfile({ nickname: 'x', source: 'owner' })
  const r = await pe.restoreProfile({ source: 'owner' })
  assert.equal(r.ok, false, '★ 回读对不上就不许说还原成功')
  assert.match(r.say, /没成功|不一致|坏掉了/)
  assert.ok(acts.some((x) => x.tone === 'failed'), '要记失败')
})

test('还原：activity 标 tone=restore，和「鱼主动改资料」区分开', async () => {
  const { pe, acts } = mkProfileWithServer()
  await pe.setProfile({ nickname: 'x', source: 'owner' })
  acts.length = 0
  await pe.restoreProfile({ source: 'owner' })
  const a = acts.find((x) => x.kind === 'profile-change' && x.tone === 'restore')
  assert.ok(a, '★ 还原要单独标记（留存里分得清是鱼改的还是收拾现场）')
  assert.match(a.text, /还原/)
})

test('还原：验收脚本存在且四步齐全（源码级）', () => {
  const src = readFileSync('E:/WhaleGirl/tools/verify-profile-edit.mjs', 'utf8')
  // ① 记录原值 ② 改 ③ 校验 ④ 还原 + 校验还原
  assert.match(src, /原名 = await 读昵称\(\)/, '要先记录原值')
  assert.match(src, /setProfile\(/, '要真的改一次')
  assert.match(src, /真的改成测试值/, '要回读校验改成功')
  assert.match(src, /finally \{/, '★ 不管成败都要走还原')
  assert.match(src, /真的还原了/, '★ 要回读校验还原成功')
  // 还原必须用最初记下的那个值，不能是别的
  assert.match(src, /set_qq_profile.*nickname: 原名/s, '还原要用原名')
})

test('统一要求：源码里不该出现高危动作', () => {
  for (const f of ['lib/history-recall.mjs', 'lib/profile-edit.mjs']) {
    const src = readFileSync(f, 'utf8')
    for (const danger of ['set_group_kick', 'set_group_ban', 'set_friend_add']) {
      assert.doesNotMatch(src, new RegExp(danger), f + ' 不该有 ' + danger)
    }
  }
})