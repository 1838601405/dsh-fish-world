// 聊天动作补齐判据（2026-11-20 主人列了七项）。
//
// 已具备不重复造：发文字 / 发图片 / 发表情包 / 发说说 / 评论说说。
// 本文件验七项：回复引用 / @ 某人 / 撤回 / 拍一拍 / 点赞 / 改名片头衔 / 贴表情。
//
// 三条统一要求：
//   · 全部走同一条出站闸（时段 / 额度 / 群闸 / 敏感）；
//   · 每个动作记 activity（kind=poke/like/recall/emoji/card）；
//   · 失败必须回一句人话，不许静默。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  LIKE_WINDOW_MS,
  POKE_WINDOW_MS,
  RECALL_WINDOW_MS,
  createChatActions,
  msgIdsOf
} from '../lib/chat-actions.mjs'

/** 可控环境：记录 qq.call 拿到了什么、activity 写了什么、闸放不放行。 */
function mk(opts = {}) {
  const calls = []
  const acts = []
  const state = {
    now: opts.startAt || 1_700_000_000_000,
    gateOk: opts.gateOk !== false,
    gateReason: opts.gateReason || '安静时段',
    pokeOk: opts.pokeOk !== false,
    callFails: opts.callFails === true,
    selfId: opts.selfId === undefined ? '457310173' : opts.selfId
  }
  const qq = {
    async call(action, body) {
      calls.push({ action, body })
      if (state.callFails) return { ok: false, error: 'OneBot 报错' }
      // 回读要如实反映「设进去什么」（setCard 现在会回读确认）
      if (action === 'get_group_member_info') return { ok: true, data: { card: state.cardSet || '' } }
      if (action === 'set_group_card') state.cardSet = String(body?.card ?? '')
      return { ok: true, data: { message_id: 999 } }
    },
    async poke(chatKey, arg) {
      calls.push({ action: 'poke', chatKey, body: arg })
      if (!state.pokeOk) return { ok: false, reason: 'peer-disabled' }
      return { ok: true }
    },
    async loginInfo() {
      return state.selfId ? { ok: true, userId: state.selfId } : { ok: false }
    }
  }
  const gate = {
    checkAction({ chatKey, kind, label }) {
      acts.push({ what: 'gate', chatKey, kind, label })
      if (!state.gateOk) return { ok: false, gate: 'quiet-hours', reason: state.gateReason }
      return { ok: true, gate: 'pass' }
    }
  }
  const activity = {
    append(entry) { acts.push({ what: 'activity', ...entry }) }
  }
  const actions = createChatActions({
    qq,
    gate,
    activity,
    now: () => state.now,
    log: () => {}
  })
  return { actions, calls, acts, state, qq }
}

const GROUP = 'group:1053484753'

// ─────────────── 1. 回复引用 ───────────────

test('1 回复引用：reply 段放在第一个', () => {
  const { actions } = mk()
  const segs = actions.withQuote([{ type: 'text', text: '你说的对' }], '123456')
  assert.equal(segs.length, 2)
  assert.equal(segs[0].type, 'reply', '★ reply 必须在第一个段，否则 OneBot 不认')
  assert.equal(segs[0].id, '123456')
  assert.equal(segs[1].type, 'text')
})

test('1 回复引用：没有 messageId 就不加（普通聊天不该每条都引用）', () => {
  const { actions } = mk()
  const segs = actions.withQuote([{ type: 'text', text: '嗯' }], '')
  assert.equal(segs.length, 1, '★ 不硬加 reply —— 主人明确要求「普通聊天不带」')
  assert.equal(segs[0].type, 'text')
})

// ─────────────── 2. @ 某人 ───────────────

test('2 @ 某人：at 段 + 一个空格 + 正文', () => {
  const { actions } = mk()
  const segs = actions.withAt([{ type: 'text', text: '你在吗' }], '1838601405', { chatKey: GROUP })
  assert.equal(segs[0].type, 'at')
  assert.equal(segs[0].qq, '1838601405')
  assert.equal(segs[1].type, 'text')
  assert.equal(segs[1].text, ' ', '★ at 后面要有空格，否则紧贴正文')
  assert.equal(segs[2].text, '你在吗')
})

test('2 @ 全体被明确拒绝（高危动作不在本单）', () => {
  const { actions } = mk()
  assert.throws(() => actions.withAt([], 'all', { chatKey: GROUP }), /高危/)
  assert.throws(() => actions.withAt([], '0', { chatKey: GROUP }), /高危/)
})

test('2 私聊不能 @ 人', () => {
  const { actions } = mk()
  assert.throws(() => actions.withAt([], '123', { chatKey: 'private:123' }), /群聊/)
})

// ─────────────── 3. 撤回 ───────────────

test('3 撤回：只撤自己发的 —— 不认识的 id 一律拒', async () => {
  const { actions, calls } = mk()
  const r = await actions.recall({ chatKey: GROUP, messageId: '别人的消息' })
  assert.equal(r.ok, false)
  assert.match(r.say, /不是我发的/)
  assert.equal(calls.length, 0, '★ 一条都不能发出去')
})

test('3 撤回：2 分钟内的能撤，撤完说「撤了」', async () => {
  const { actions, calls, acts, state } = mk()
  actions.noteOwn({ chatKey: GROUP, messageId: 'm1', text: '刚才那句' })
  // 1 分钟后
  state.now += 60_000
  const r = await actions.recall({ chatKey: GROUP, messageId: 'm1' })
  assert.equal(r.ok, true)
  assert.equal(r.say, '撤了', '★ 主人要求撤完说一句「撤了」')
  assert.equal(calls[0].action, 'delete_msg')
  assert.equal(calls[0].body.message_id, 'm1')
  const a = acts.find((x) => x.what === 'activity')
  assert.equal(a.kind, 'recall')
})

test('3 撤回：超过 2 分钟就撤不回来', async () => {
  const { actions, calls, state } = mk()
  actions.noteOwn({ chatKey: GROUP, messageId: 'm2', text: '旧的' })
  state.now += RECALL_WINDOW_MS + 1000
  const r = await actions.recall({ chatKey: GROUP, messageId: 'm2' })
  assert.equal(r.ok, false)
  assert.match(r.say, /2 分钟/)
  assert.equal(calls.length, 0, '超时就别发请求了')
})

test('3 撤回失败要说人话，不静默', async () => {
  const { actions, state } = mk({ callFails: true })
  actions.noteOwn({ chatKey: GROUP, messageId: 'm3', text: 'x' })
  state.now += 1000
  const r = await actions.recall({ chatKey: GROUP, messageId: 'm3' })
  assert.equal(r.ok, false)
  assert.ok(r.say.length > 0, '★ 失败必须有一句人话')
  assert.match(r.say, /撤不掉/)
})

// ─────────────── 4. 拍一拍 ───────────────

test('4 拍一拍：真调 qq.poke', async () => {
  const { actions, calls, acts } = mk()
  const r = await actions.poke({ chatKey: GROUP, userId: '1838601405', groupId: '1053484753' })
  assert.equal(r.ok, true)
  assert.equal(calls[0].action, 'poke')
  assert.equal(calls[0].body.userId, '1838601405')
  const a = acts.find((x) => x.what === 'activity')
  assert.equal(a.kind, 'poke')
})

test('4 拍一拍频控：同一人 10 分钟内第二次被拒', async () => {
  const { actions, state } = mk()
  const first = await actions.poke({ chatKey: GROUP, userId: '1838601405' })
  assert.equal(first.ok, true)
  state.now += 60_000  // 1 分钟后
  const second = await actions.poke({ chatKey: GROUP, userId: '1838601405' })
  assert.equal(second.ok, false, '★ 10 分钟内不许再戳同一个人')
  assert.match(second.say, /分钟/)
})

test('4 拍一拍频控：过了 10 分钟可以再戳', async () => {
  const { actions, state } = mk()
  await actions.poke({ chatKey: GROUP, userId: '1838601405' })
  state.now += POKE_WINDOW_MS + 1000
  const again = await actions.poke({ chatKey: GROUP, userId: '1838601405' })
  assert.equal(again.ok, true)
})

test('4 拍一拍：不同人各自计时', async () => {
  const { actions } = mk()
  const a = await actions.poke({ chatKey: GROUP, userId: '111' })
  const b = await actions.poke({ chatKey: GROUP, userId: '222' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true, '★ 频控是按人的，不是全局限一次')
})

test('4 拍一拍失败要有「戳不动」', async () => {
  const { actions } = mk({ pokeOk: false })
  const r = await actions.poke({ chatKey: GROUP, userId: '1838601405' })
  assert.equal(r.ok, false)
  assert.match(r.say, /戳不动/, '★ 主人点名要求这句')
})

// ─────────────── 5. 点赞 ───────────────

test('5 点赞：调 send_like，同一人每天 1 次', async () => {
  const { actions, calls, state } = mk()
  const first = await actions.like({ userId: '1838601405', chatKey: GROUP })
  assert.equal(first.ok, true)
  assert.equal(calls[0].action, 'send_like')
  assert.equal(calls[0].body.times, 1, '★ times 固定 1')
  assert.equal(calls[0].body.user_id, '1838601405')

  state.now += 3600_000  // 1 小时后
  const second = await actions.like({ userId: '1838601405', chatKey: GROUP })
  assert.equal(second.ok, false, '★ 同一个人每天只点一次')
  assert.match(second.say, /小时后/)
})

test('5 点赞：隔天可以再点', async () => {
  const { actions, state } = mk()
  await actions.like({ userId: '1838601405' })
  state.now += LIKE_WINDOW_MS + 1000
  const again = await actions.like({ userId: '1838601405' })
  assert.equal(again.ok, true)
})

// ─────────────── 6. 群名片 / 头衔 ───────────────

test('4 拍一拍：★ group_poke 必须带 group_id（真机踩的 bug）', async () => {
  // 2026-11-20 真机：group_poke 只给 user_id → 协议端 ok=false，群里根本拍不动。
  // 这条判据钉住「群聊时 body 里必须有 group_id」。
  const sent = []
  const adapter = {
    async run(key, makeBody) {
      // 模拟候选探测：把每个候选名对应的 body 都记下来
      const names = key === 'pokeGroup' ? ['group_poke', 'send_poke'] : ['friend_poke', 'send_poke']
      for (const name of names) sent.push({ key, name, body: makeBody(name) })
      return { ok: true, data: null, action: names[0], error: '', say: '', unsupported: false }
    }
  }
  const ca = createChatActions({
    qq: {
      async call() { return { ok: true } },
      async poke() { return { ok: true } },
      async loginInfo() { return { ok: true, userId: '1' } }
    },
    gate: { checkAction: () => ({ ok: true }), noteAction: () => {} },
    activity: { append: () => {} },
    adapter,
    now: () => 1_700_000_000_000,
    log: () => {}
  })

  const r = await ca.poke({ chatKey: GROUP, userId: '1838601405' })
  assert.equal(r.ok, true)
  const gp = sent.find((x) => x.name === 'group_poke')
  assert.ok(gp, '群聊要用 pokeGroup 那套候选')
  // 群号给数字或字符串都行（协议端两种都收），重点是**必须有**
  assert.equal(String(gp.body.group_id), '1053484753', '★ group_poke 必须带 group_id（群号）')
  assert.equal(String(gp.body.user_id), '1838601405', '也要带 user_id')
})

test('4 拍一拍：私聊的 friend_poke 不带 group_id（带了反而错）', async () => {
  const sent = []
  const adapter = {
    async run(key, makeBody) {
      sent.push({ key, body: makeBody('friend_poke') })
      return { ok: true, data: null, action: 'friend_poke', error: '', say: '', unsupported: false }
    }
  }
  const ca = createChatActions({
    qq: { async call() { return { ok: true } }, async poke() { return { ok: true } }, async loginInfo() { return { ok: true, userId: '1' } } },
    gate: { checkAction: () => ({ ok: true }), noteAction: () => {} },
    activity: { append: () => {} },
    adapter,
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  await ca.poke({ chatKey: 'private:1838601405', userId: '1838601405' })
  assert.equal(sent[0].key, 'pokePrivate', '私聊用 pokePrivate 那套')
  assert.equal(sent[0].body.group_id, undefined, '★ 私聊不传 group_id')
})

test('6 改群名片：ok=true 但没生效 → 不许假成功', async () => {
  // 2026-11-20：回读确认。有的协议端 ok=true 但根本没改。
  const calls = []
  const acts = []
  const qq = {
    async call(action) {
      calls.push(action)
      if (action === 'set_group_card') return { ok: true }          // 假称成功
      if (action === 'get_group_member_info') return { ok: true, data: { card: '还是旧的' } }  // 实际没变
      return { ok: true }
    },
    async loginInfo() { return { ok: true, userId: '457310173' } }
  }
  const ca = createChatActions({
    qq,
    gate: { checkAction: () => ({ ok: true }) },
    activity: { append: (e) => acts.push(e) },
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  const r = await ca.setCard({ chatKey: GROUP, groupId: '1053484753', card: '小鲸鱼' })
  assert.equal(r.ok, false, '★ 回读发现没变，不能说成功')
  assert.match(r.say, /没改成/)
  assert.ok(acts.some((x) => x.tone === 'failed'), '要记失败')
  assert.ok(calls.includes('get_group_member_info'), '要回读确认')
})

test('6 改群名片：回读确认真的变了 → 成功', async () => {
  const qq = {
    async call(action) {
      if (action === 'set_group_card') return { ok: true }
      if (action === 'get_group_member_info') return { ok: true, data: { card: '小鲸鱼' } }
      return { ok: true }
    },
    async loginInfo() { return { ok: true, userId: '457310173' } }
  }
  const ca = createChatActions({
    qq,
    gate: { checkAction: () => ({ ok: true }) },
    activity: { append: () => {} },
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  const r = await ca.setCard({ chatKey: GROUP, groupId: '1053484753', card: '小鲸鱼' })
  assert.equal(r.ok, true)
})

test('6 改群名片：改她自己（用登录号，不硬编码）', async () => {
  const { actions, calls } = mk({ selfId: '457310173' })
  const r = await actions.setCard({ chatKey: GROUP, groupId: '1053484753', card: '小鲸鱼' })
  assert.equal(r.ok, true)
  assert.equal(calls[0].action, 'set_group_card')
  assert.equal(calls[0].body.user_id, '457310173', '★ 改的是自己，不是别人')
  assert.equal(calls[0].body.card, '小鲸鱼')
})

test('6 改群名片：不知道自己是哪个号就不改', async () => {
  const { actions, calls } = mk({ selfId: '' })
  const r = await actions.setCard({ chatKey: GROUP, card: '小鲸鱼' })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 0, '★ 不知道改谁就别乱发请求')
})

test('6 改头衔失败要如实说「没权限」', async () => {
  const { actions } = mk({ callFails: true })
  const r = await actions.setTitle({ chatKey: GROUP, groupId: '1053484753', title: '小鲸鱼' })
  assert.equal(r.ok, false)
  assert.match(r.say, /管理员/, '★ 主人点名：失败要如实说没权限，不许含糊')
})

// ─────────────── 7. 贴表情 ───────────────

test('7 贴表情：调 set_msg_emoji_like，每条消息只能贴一次', async () => {
  const { actions, calls } = mk()
  const first = await actions.emoji({ chatKey: GROUP, messageId: 'msg-1', emojiId: '128077' })
  assert.equal(first.ok, true)
  assert.equal(calls[0].action, 'set_msg_emoji_like')
  assert.equal(calls[0].body.message_id, 'msg-1')
  assert.equal(calls[0].body.emoji_id, '128077')

  const second = await actions.emoji({ chatKey: GROUP, messageId: 'msg-1', emojiId: '128077' })
  assert.equal(second.ok, false, '★ 每条消息最多贴一次')
  assert.match(second.say, /已经贴过/)
})

test('7 贴表情：私聊提前说清楚（QQ 明确不支持）', async () => {
  // 2026-11-20 真机实证：SnowLuma 内部拒绝
  //   "emoji reactions are not supported on private messages"
  // 所以要在调接口**之前**就说，别让它白跑一趟再给个没头没脑的失败。
  const { actions, calls } = mk()
  const r = await actions.emoji({ chatKey: 'private:1838601405', messageId: 'm1', emojiId: '128077' })
  assert.equal(r.ok, false)
  assert.match(r.say, /私聊没有表情回应/, '★ 要说清楚是私聊不支持')
  assert.equal(calls.length, 0, '★ 提前拒，不该发请求')
})

test('7 贴表情：不同消息互不影响', async () => {
  const { actions } = mk()
  const a = await actions.emoji({ chatKey: GROUP, messageId: 'm1', emojiId: '1' })
  const b = await actions.emoji({ chatKey: GROUP, messageId: 'm2', emojiId: '1' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
})

// ─────────────── 统一要求：出站闸 ───────────────

test('统一要求：每个动作都过出站闸（一个都不许绕）', async () => {
  const { actions, acts, calls } = mk({ gateOk: false })
  // 全部动作在闸关着时都要被拦，且不能发出任何 qq 调用
  const results = []
  results.push(await actions.poke({ chatKey: GROUP, userId: '1' }))
  results.push(await actions.like({ userId: '1' }))
  results.push(await actions.setCard({ chatKey: GROUP, card: 'x' }))
  results.push(await actions.setTitle({ chatKey: GROUP, title: 'x' }))
  results.push(await actions.emoji({ chatKey: GROUP, messageId: 'm', emojiId: '1' }))
  for (const r of results) {
    assert.equal(r.ok, false, '闸关着时不许有动作成功')
    assert.match(r.say, /不能/, '要说明被拦了')
  }
  assert.equal(calls.length, 0, '★ 被闸拦下的一个请求都不该发出去')
  // 每个动作都问过闸
  const gated = acts.filter((x) => x.what === 'gate')
  assert.equal(gated.length, 5, '5 个动作各问一次闸')
})

test('统一要求：撤回也过闸', async () => {
  const { actions, acts, state } = mk({ gateOk: false })
  actions.noteOwn({ chatKey: GROUP, messageId: 'm1', text: 'x' })
  state.now += 1000
  const r = await actions.recall({ chatKey: GROUP, messageId: 'm1' })
  assert.equal(r.ok, false)
  assert.ok(acts.some((x) => x.what === 'gate' && x.kind === 'recall'))
})

// ─────────────── 统一要求：activity ───────────────

test('统一要求：每个动作都记 activity，kind 对得上', async () => {
  const expect = {
    '4 poke': ['poke', async (a) => a.poke({ chatKey: GROUP, userId: '9' })],
    '5 like': ['like', async (a) => a.like({ userId: '9' })],
    '6 card': ['card', async (a) => a.setCard({ chatKey: GROUP, card: 'x' })],
    '7 emoji': ['emoji', async (a) => a.emoji({ chatKey: GROUP, messageId: 'm', emojiId: '1' })]
  }
  for (const [name, [kind, run]] of Object.entries(expect)) {
    const { actions, acts } = mk()
    await run(actions)
    const a = acts.find((x) => x.what === 'activity')
    assert.ok(a, name + ' 要记 activity')
    assert.equal(a.kind, kind, name + ' 的 kind 要对')
    assert.equal(a.actor, 'fish')
  }
})

test('统一要求：3 撤回、6 改名片也都记 activity', async () => {
  {
    const { actions, acts, state } = mk()
    actions.noteOwn({ chatKey: GROUP, messageId: 'm', text: 'x' })
    state.now += 1000
    await actions.recall({ chatKey: GROUP, messageId: 'm' })
    assert.ok(acts.some((x) => x.what === 'activity' && x.kind === 'recall'))
  }
  {
    const { actions, acts } = mk()
    await actions.setCard({ chatKey: GROUP, card: '小鲸鱼' })
    assert.ok(acts.some((x) => x.what === 'activity' && x.kind === 'card'))
  }
})

test('统一要求：失败也记 activity（tone=failed），便于排查', async () => {
  const { actions, acts } = mk({ callFails: true })
  await actions.like({ userId: '9' })
  const a = acts.find((x) => x.what === 'activity')
  assert.equal(a.tone, 'failed', '★ 失败要标 failed，别和成功混在一起')
})

// ─────────────── 高危动作不在本单 ───────────────

test('高危动作不在本单：源码里不该出现踢人/禁言/退群/加好友', () => {
  const src = readFileSync('lib/chat-actions.mjs', 'utf8')
  for (const danger of ['set_group_kick', 'set_group_ban', 'set_group_leave', 'set_friend_add']) {
    assert.doesNotMatch(src, new RegExp(danger), '★ ' + danger + ' 是高危动作，不在本单')
  }
})

test('常量值符合主人要求', () => {
  assert.equal(POKE_WINDOW_MS, 10 * 60 * 1000, '拍一拍 10 分钟')
  assert.equal(LIKE_WINDOW_MS, 24 * 60 * 60 * 1000, '点赞每天 1 次')
  assert.equal(RECALL_WINDOW_MS, 2 * 60 * 1000, '撤回限 2 分钟')
})

// ─────────────── 撤回的前置：noteOwn 必须接在发送链上 ───────────────
// 这是主人第 3 项能不能用的关键：不记 msgId，撤回会永远回「那条不是我发的」。

// ★★ 真机踩的坑（2026-11-20）：qq.send 的 msgId **不在顶层**，在 sent[0].msgId。
//    第一版判据只查了「源码里有 r.msgId 这行字」→ 全绿，但功能是坏的。
//    下面这条用**真实返回形状**钉住，改坏必红。
const REAL_SEND_RESULT = {
  ok: true,
  dryRun: false,
  reason: '',
  sent: [
    { kind: 'private', id: 1838601405, action: 'send_private_msg', ok: true, msgId: '-1035064930', error: '' }
  ],
  failed: [],
  targets: []
}

test('msgIdsOf：从真实返回形状里取到 msgId（sent[0].msgId）', () => {
  const ids = msgIdsOf(REAL_SEND_RESULT)
  assert.deepEqual(ids, ['-1035064930'], '★ 必须从 sent[].msgId 取')
})

test('msgIdsOf：顶层 r.msgId 是 undefined —— 这就是第一版的 bug', () => {
  // 留着这条当"反例对照"：证明只写 r.msgId 一定取不到。
  assert.equal(REAL_SEND_RESULT.msgId, undefined, '顶层没有 msgId')
  // 只有顶层 msgId、没有 sent 数组 ⇒ 取不到（形状不对就是没拿到）
  assert.deepEqual(msgIdsOf({ ok: true, msgId: '-1' }), [], '形状不对就返回空，不要瞎猜')
})

test('msgIdsOf：一次发多条时全都取到', () => {
  const ids = msgIdsOf({
    ok: true,
    sent: [{ msgId: 'a' }, { msgId: 'b' }, { msgId: '' }]
  })
  assert.deepEqual(ids, ['a', 'b'], '空 msgId 要跳过')
})

test('msgIdsOf：脏输入不抛（返回空数组）', () => {
  for (const bad of [null, undefined, {}, { sent: null }, { sent: 'x' }, 0]) {
    assert.deepEqual(msgIdsOf(bad), [], JSON.stringify(bad) + ' 应返回空')
  }
})

test('noteOwn 真的接在发送链上（源码级）', () => {
  const src = readFileSync('lib/index.js', 'utf8')
  // 必须用 msgIdsOf 抽（而不是写 r.msgId 那种取不到的写法）
  assert.match(src, /msgIdsOf\(r\)/, '★ 要用 msgIdsOf 从 sent[] 里抽')
  assert.match(src, /noteOwn\?\.\(\{ chatKey, messageId: id/, '要把抽到的 id 记进撤回名单')
  // 必须包在出站闸**外面**：被闸拦下的不算发过
  const wrapIdx = src.indexOf('outboundGate.wrap(qq.send.bind(qq))')
  const noteIdx = src.indexOf('noteOwn?.(')
  assert.ok(wrapIdx > 0 && noteIdx > wrapIdx, 'noteOwn 要在出站闸包装之后（拦下的不进名单）')
  // 不许退回写 r.msgId（真机上永远 undefined）
  assert.doesNotMatch(src, /r\.msgId\)/, '★ 不许写 r.msgId —— 顶层没有这个字段')
})

test('撤回链路：noteOwn 之后能撤（端到端）', async () => {
  const { actions, calls, state } = mk()
  // 模拟发送成功后 noteOwn 被调用
  actions.noteOwn({ chatKey: GROUP, messageId: 'sent-1', text: '我说的话' })
  state.now += 30_000   // 30 秒后想撤
  const r = await actions.recall({ chatKey: GROUP, messageId: 'sent-1' })
  assert.equal(r.ok, true, '★ 记过自己的消息就能撤')
  assert.equal(calls[0].action, 'delete_msg')
})

test('撤回链路：走完 msgIdsOf → noteOwn → recall 全链', async () => {
  const { actions, calls } = mk()
  // 1. 真实返回形状 → 抽 id
  const ids = msgIdsOf(REAL_SEND_RESULT)
  assert.equal(ids.length, 1)
  // 2. 记进名单（index.js 的包装做的事）
  for (const id of ids) actions.noteOwn({ chatKey: GROUP, messageId: id, text: '测试' })
  // 3. 撤回
  const r = await actions.recall({ chatKey: GROUP, messageId: ids[0] })
  assert.equal(r.ok, true, '★ 全链通：真机 msgId 形状能一路走到撤回')
  assert.equal(calls[0].body.message_id, '-1035064930', '撤的是那个 id')
})

test('撤回链路：没记过的 id 撤不掉（安全边界）', async () => {
  const { actions, calls } = mk()
  const r = await actions.recall({ chatKey: GROUP, messageId: 'never-sent' })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 0)
})
