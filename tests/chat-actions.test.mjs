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
  createChatActions
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

test('6 改群名片：只改她自己（用登录号，不硬编码）', async () => {
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