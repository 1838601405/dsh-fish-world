// 协议端适配 + 平台输入 + 对外动作口径（2026-11-20 主人要求点四）。
//
// 1. 动作探测：候选名依次试，不支持报「协议端不支持 XXX」
// 2. @ 取号：按昵称/群名片反查 QQ 号，查不到不 @
// 3. 平台输入适配：桌面版路径 / 插件版 base64，统一走适配器
// 4. 对外动作：独立频控（不占发言额度）、外发标签、失败照抄原因
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACTION_CANDIDATES,
  createActionAdapter,
  createMemberLookup,
  looksLikeUnknownAction
} from '../lib/action-adapter.mjs'
import { AVATAR_MAX_BYTES, createMediaInput, normalizeInput } from '../lib/media-input.mjs'
import { createOutboundGate } from '../lib/outbound-gate.mjs'

// ══════════════ 1. 动作探测 ══════════════

/** 可控的假协议端：按名字决定认不认。 */
function mkProto({ supports = {}, failWith = {} } = {}) {
  const calls = []
  return {
    calls,
    async call(action, body) {
      calls.push({ action, body })
      if (failWith[action]) return { ok: false, error: failWith[action] }
      // supports 里没有的当"不认识"
      if (!supports[action]) return { ok: false, error: 'unknown action: ' + action }
      return { ok: true, data: { by: action } }
    }
  }
}

test('探测：第一个候选不支持、第二个支持 → 用第二个并缓存', async () => {
  // 模拟：这个实现没有 group_poke，只有 send_poke
  const qq = mkProto({ supports: { send_poke: true, friend_poke: true } })
  const ad = createActionAdapter({ qq, log: () => {} })

  const r1 = await ad.run('pokeGroup', (name) => ({ user_id: 1, via: name }))
  assert.equal(r1.ok, true)
  assert.equal(r1.action, 'send_poke', '★ 要用真的能用的那个名字')
  assert.equal(qq.calls.length, 2, '试了两个候选')

  // 第二次直接用缓存的名字，不再从第一个试
  const r2 = await ad.run('pokeGroup', (name) => ({ user_id: 2, via: name }))
  assert.equal(r2.ok, true)
  assert.equal(qq.calls.length, 3, '★ 缓存后只调一次')
  assert.equal(ad.snapshot().resolved.pokeGroup, 'send_poke')
})

test('探测：所有候选都不认识 → 报「协议端不支持 XXX」', async () => {
  const qq = mkProto({ supports: {} })   // 什么都不支持
  const ad = createActionAdapter({ qq, log: () => {} })
  const r = await ad.run('emoji', () => ({ message_id: '1', emoji_id: '1' }))
  assert.equal(r.ok, false)
  assert.equal(r.unsupported, true)
  assert.match(r.say, /协议端不支持贴表情回应/, '★ 主人要求：报「协议端不支持 XXX」')
})

test('探测：换成别的错（没权限）不该继续试下一个候选', async () => {
  // 名字是对的，只是没权限 —— 再试下一个名字是白跑
  const qq = mkProto({ supports: { set_group_card: true }, failWith: { set_group_card: 'permission denied' } })
  const ad = createActionAdapter({ qq, log: () => {} })
  const r = await ad.run('card', () => ({ group_id: 1 }))
  assert.equal(r.ok, false)
  assert.equal(r.unsupported, false, '★ 「没权限」不等于「不支持这个动作」')
  assert.equal(qq.calls.length, 1, '★ 只该调一次，别重复跑')
  assert.match(r.error, /permission/, '原始错误要抄出来（主人要求点四.4）')
})

test('探测：判定不支持之后不再白跑', async () => {
  const qq = mkProto({ supports: {} })
  const ad = createActionAdapter({ qq, log: () => {} })
  await ad.run('online', () => ({}))
  const n1 = qq.calls.length
  const r2 = await ad.run('online', () => ({}))
  assert.equal(r2.ok, false)
  assert.equal(qq.calls.length, n1, '★ 已知不支持就不再打请求')
})

test('探测：候选名表里拍一拍有群/私聊两套', () => {
  assert.deepEqual(ACTION_CANDIDATES.pokeGroup, ['group_poke', 'send_poke'])
  assert.deepEqual(ACTION_CANDIDATES.pokePrivate, ['friend_poke', 'send_poke'])
  assert.deepEqual(ACTION_CANDIDATES.emoji, ['set_msg_emoji_like', 'set_emoji_like'])
})

test('探测：认得出「不认识这个 action」的几种措辞', () => {
  for (const t of ['unknown action: foo', 'Unsupported Action', 'no such action', 'action not found', '不支持的动作']) {
    assert.equal(looksLikeUnknownAction(t), true, '应认作不认识：' + t)
  }
  for (const t of ['permission denied', 'bad param', '', '请求超时']) {
    assert.equal(looksLikeUnknownAction(t), false, '不该认作不认识：' + t)
  }
})

test('探测：protocol() 拿到实现名（只读，无副作用）', async () => {
  const qq = {
    async call(a) {
      if (a === 'get_version_info') return { ok: true, data: { app_name: 'SnowLuma', app_version: '2.2.0', protocol_version: 'v11' } }
      return { ok: false }
    }
  }
  const ad = createActionAdapter({ qq, log: () => {} })
  const p = await ad.protocol()
  assert.equal(p.name, 'SnowLuma')
  assert.equal(p.protocol, 'v11')
})

// ══════════════ 2. @ 取号 ══════════════

function mkMembers(rows) {
  const calls = []
  return {
    calls,
    async call(action, body) {
      calls.push({ action, body })
      if (action === 'get_group_member_list') return { ok: true, data: rows }
      return { ok: false }
    }
  }
}

test('取号：群名片精确匹配 → 返回 QQ 号', async () => {
  const qq = mkMembers([
    { user_id: 111, nickname: '大星', card: '主人' },
    { user_id: 222, nickname: '小鱼', card: '' }
  ])
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '主人')
  assert.equal(r.ok, true)
  assert.equal(r.qq, '111', '★ 群名片优先（群里看到的就是这个）')
})

test('取号：昵称也能查到', async () => {
  const qq = mkMembers([{ user_id: 222, nickname: '小鱼', card: '' }])
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '小鱼')
  assert.equal(r.ok, true)
  assert.equal(r.qq, '222')
})

test('取号：包含匹配能中（「小鲸鱼」→「小鲸鱼🐳」）', async () => {
  const qq = mkMembers([{ user_id: 333, nickname: '小鲸鱼🐳', card: '' }])
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '小鲸鱼')
  assert.equal(r.ok, true)
  assert.equal(r.qq, '333')
  assert.equal(r.exact, false, '要标出是模糊匹配')
})

test('取号：查到多个人 → 不猜，让说号', async () => {
  // ★ 要真的歧义：精确匹配不到，但有两个都"包含"
  // （如果一个精确命中，就该用精确的那个 —— 那是另一条判据）
  const qq = mkMembers([
    { user_id: 1, nickname: '小明一号', card: '' },
    { user_id: 2, nickname: '小明二号', card: '' }
  ])
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '小明')
  assert.equal(r.ok, false, '★ 有歧义不许瞎猜（@ 错人比不 @ 更糟）')
  assert.match(r.say, /说下号/)
  assert.equal(r.candidates.length, 2, '要把候选报出来')
})

test('取号：精确命中优先于包含命中', async () => {
  // 「小明」自己就在群里 ⇒ 用它，不要因为「小明二号」也包含而犹豫
  const qq = mkMembers([
    { user_id: 1, nickname: '小明', card: '' },
    { user_id: 2, nickname: '小明二号', card: '' }
  ])
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '小明')
  assert.equal(r.ok, true, '★ 精确命中就该用它')
  assert.equal(r.qq, '1')
  assert.equal(r.exact, true)
})

test('取号：查不到 → 「不知道是哪个，说下号」', async () => {
  const qq = mkMembers([{ user_id: 1, nickname: '甲', card: '' }])
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '完全不存在的人')
  assert.equal(r.ok, false)
  assert.match(r.say, /没找到.*说下号/, '★ 主人要求：查不到就不 @，并说「不知道是哪个，说下号」')
})

test('取号：读不到群成员 → 不让 @，说读不到', async () => {
  const qq = { async call() { return { ok: false, error: 'onebot-error' } } }
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '谁')
  assert.equal(r.ok, false)
  assert.match(r.say, /读不到|说下号/)
})

test('取号：给的是纯数字 → 直接当 QQ 号，不查', async () => {
  const qq = mkMembers([])
  const lookup = createMemberLookup({ qq, log: () => {} })
  const r = await lookup.resolve('1053484753', '1838601405')
  assert.equal(r.ok, true)
  assert.equal(r.qq, '1838601405')
  assert.equal(qq.calls.length, 0, '★ 已经是号就别去查群成员')
})

// ══════════════ 3. 平台输入适配 ══════════════

test('输入适配：认得出路径 / base64 / dataURL / Buffer 四种形态', () => {
  assert.equal(normalizeInput('C:/a/b.png').kind, 'path')
  assert.equal(normalizeInput('base64://aGVsbG8=').kind, 'base64')
  assert.equal(normalizeInput('base64:aGVsbG8=').kind, 'base64')
  const du = normalizeInput('data:image/png;base64,aGVsbG8=')
  assert.equal(du.kind, 'base64')
  assert.equal(du.ext, '.png', 'dataURL 能看出扩展名')
  assert.equal(normalizeInput(Buffer.from('hello')).kind, 'base64')
})

test('输入适配：桌面版优先路径，同时备好 base64 兜底', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, Buffer.alloc(1024, 1))
  const mi = createMediaInput({ isDesktop: () => true })
  const r = mi.avatar({ input: img })
  assert.equal(r.ok, true)
  assert.equal(r.primary.form, 'path', '★ 主人要求：桌面版走本地文件路径')
  assert.ok(r.fallback, '要备好 base64 兜底（路径被拒时自动换）')
  assert.equal(r.fallback.form, 'base64')
  assert.match(r.fallback.value, /^base64:\/\//)
})

test('输入适配：插件版拿不到路径 → 直接给 base64', () => {
  const mi = createMediaInput({ isDesktop: () => false })
  const r = mi.avatar({ input: 'base64://aGVsbG8=' })
  assert.equal(r.ok, true)
  assert.equal(r.primary.form, 'base64', '★ 主人要求：插件版走 base64')
  assert.equal(r.primary.value, 'base64://aGVsbG8=')
})

test('输入适配：★ 插件版收到路径要拒绝，不许读服务器文件', () => {
  // 场景：web 面板里用户填了个路径 → 照读就等于浏览器能读服务器任意文件
  const dir = mkdtempSync(join(tmpdir(), 'media-safe-'))
  const img = join(dir, 'a.png')
  writeFileSync(img, Buffer.alloc(100))
  const mi = createMediaInput({ isDesktop: () => false })
  const r = mi.avatar({ input: img })
  assert.equal(r.ok, false, '★ 非桌面端不许读本地路径')
  assert.match(r.say, /base64/, '要告诉调用方该传什么')
})

test('输入适配：桌面版但只给了 base64 → 也照收', () => {
  const mi = createMediaInput({ isDesktop: () => true })
  const r = mi.avatar({ input: 'data:image/jpeg;base64,aGVsbG8=' })
  assert.equal(r.ok, true)
  assert.equal(r.primary.form, 'base64')
})

test('输入适配：超过 2MB 拒（两种形态都查）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-big-'))
  const big = join(dir, 'big.png')
  writeFileSync(big, Buffer.alloc(AVATAR_MAX_BYTES + 1))
  const mi = createMediaInput({ isDesktop: () => true })
  const r1 = mi.avatar({ input: big })
  assert.equal(r1.ok, false)
  assert.match(r1.say, /2MB/)

  // base64 形态：长度换算超过上限也要拒
  const hugeB64 = 'A'.repeat(Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 100)
  const r2 = mi.avatar({ input: 'base64://' + hugeB64 })
  assert.equal(r2.ok, false)
  assert.match(r2.say, /2MB/)
})

test('输入适配：非 png/jpg 拒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-gif-'))
  const gif = join(dir, 'a.gif')
  writeFileSync(gif, Buffer.alloc(100))
  const mi = createMediaInput({ isDesktop: () => true })
  const r = mi.avatar({ input: gif })
  assert.equal(r.ok, false)
  assert.match(r.say, /png/)
})

test('输入适配：路径要过鱼箱校验（不让读工作区外面）', () => {
  const mi = createMediaInput({
    isDesktop: () => true,
    resolvePath: () => { throw new Error('跑到鱼箱外面了') }
  })
  const r = mi.avatar({ input: 'C:/Windows/System32/x.png' })
  assert.equal(r.ok, false)
  assert.match(r.say, /鱼箱/)
})

// ══════════════ 4. 对外动作：独立频控 ══════════════

test('独立频控：发言额度用完，动作照样能做（主人明确要求）', () => {
  const gate = createOutboundGate({ config: () => ({ maxPerHour: 1, maxPerDay: 1 }), log: () => {} })
  gate.noteSent({ chatKey: 'private:1', text: '你好' })

  const chat = gate.check({ chatKey: 'private:1', text: '再来一句' })
  assert.equal(chat.ok, false, '发言额度用完了')

  const act = gate.checkAction({ chatKey: 'private:1', kind: 'like', label: '点赞' })
  assert.equal(act.ok, true, '★ 「计入独立频控，不占发言额度」')
})

test('独立频控：动作额度用完，也不反过来卡发言', () => {
  const gate = createOutboundGate({ config: () => ({ actionMaxPerHour: 2 }), log: () => {} })
  gate.noteAction('private:1')
  gate.noteAction('private:1')
  assert.equal(gate.checkAction({ chatKey: 'private:1', kind: 'poke', label: '戳' }).ok, false)
  assert.equal(gate.check({ chatKey: 'private:1', text: '还能说话吗' }).ok, true,
    '★ 动作额度不该把发言也卡住')
})

test('独立频控：动作额度确实生效（默认每小时 30）', () => {
  const gate = createOutboundGate({ config: () => ({ actionMaxPerHour: 2 }), log: () => {} })
  gate.noteAction('g:1')
  gate.noteAction('g:1')
  const r = gate.checkAction({ chatKey: 'g:1', kind: 'emoji', label: '贴' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /动作太频繁/)
})

test('独立频控：安静时段仍然管动作（半夜改名片也怪）', () => {
  const gate = createOutboundGate({ config: () => ({ quietHours: '00:00-23:59' }), log: () => {} })
  const r = gate.checkAction({ chatKey: 'private:1', kind: 'card', label: '改名' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /安静时段/)
})

// ══════════════ 4. 对外动作：外发标签 ══════════════

test('外发标签：activity 记录了 outbound=true', async () => {
  // 通过 chat-actions 做一个动作，看 activity 收到的 entry
  const { createChatActions } = await import('../lib/chat-actions.mjs')
  const acts = []
  const ca = createChatActions({
    qq: { async call() { return { ok: true } }, async loginInfo() { return { ok: true, userId: '1' } } },
    gate: { checkAction: () => ({ ok: true }), noteAction: () => {} },
    activity: { append: (e) => acts.push(e) },
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  await ca.like({ userId: '1838601405', chatKey: 'private:1838601405' })
  const a = acts.find((x) => x.kind === 'like')
  assert.ok(a, '要有 activity')
  assert.equal(a.outbound, true, '★ 主人要求：对外可见动作要标「外发」')
})

test('外发标签：source 断言 activity 真的写了 outbound 字段', () => {
  const src = readFileSync('lib/activity.mjs', 'utf8')
  assert.match(src, /outbound: outbound === true/, 'activity 要把 outbound 落到记录里')
  const ca = readFileSync('lib/chat-actions.mjs', 'utf8')
  assert.match(ca, /outbound: true/, 'chat-actions 的动作都要标外发')
})

// ══════════════ 失败照抄原因 ══════════════

test('失败照抄原因：动作失败时把协议端的原文带出来', async () => {
  const { createChatActions } = await import('../lib/chat-actions.mjs')
  const qq = {
    async call() { return { ok: false, error: 'rate limited by server' } },
    async loginInfo() { return { ok: true, userId: '1' } }
  }
  const ca = createChatActions({
    qq,
    gate: { checkAction: () => ({ ok: true }), noteAction: () => {} },
    activity: { append: () => {} },
    now: () => 1_700_000_000_000,
    log: () => {}
  })
  const r = await ca.like({ userId: '9' })
  assert.equal(r.ok, false)
  assert.match(r.say, /rate limited/, '★ 主人要求：失败照抄原因，不静默')
})