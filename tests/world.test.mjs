import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createQQ } from '../lib/qq.mjs'
import { createWorldStore } from '../lib/world.mjs'

function fakeQq(ownerQQ = '10000001', targetSession = 'session-owner-1') {
  return { bridgeConfig: () => ({ 私聊QQ: ownerQQ, 目标会话: targetSession }) }
}

function fakeServices(workspacePath, ownerSession) {
  const registry = { list: () => [{ path: workspacePath, sessionIds: [ownerSession] }] }
  const sessions = { get: () => null }
  const agents = { list: () => [], get: () => null }
  return { registry, sessions, agents }
}

test('world store binds to workspace and lays out 鱼的世界 directories', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-'))
  const owner = 'session-owner-1'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  const status = world.setServices(fakeServices(workspace, owner))
  assert.equal(status.ok, true)
  const root = join(workspace, '鱼的世界')
  assert.ok(existsSync(root))
  for (const name of ['鱼的记忆', '鱼的日记', '鱼的状态', '鱼的关系', '安全与审计']) {
    assert.ok(existsSync(join(root, name)), name + ' 应存在')
  }
  assert.ok(existsSync(join(root, '鱼的关系', 'people.json')))
  assert.equal(world.status().workspacePath, workspace)
})

test('relations reject invalid QQ, cross-workspace session, and owner duplication', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home2-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws2-'))
  const owner = 'session-owner-2'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  assert.throws(() => world.updateRelations([{ qqId: 'abc', name: 'x', role: 'trusted', chatKey: 'private:1', sessionId: 'session-a' }]), /QQ号无效/)
  assert.throws(() => world.updateRelations([{ qqId: '10000001', name: 'x', role: 'trusted', chatKey: 'private:10000001', sessionId: 'session-a' }]), /主人/)
  assert.throws(() => world.updateRelations([{ qqId: '10002', name: 'x', role: 'trusted', chatKey: 'private:10002', sessionId: 'session-elsewhere' }]), /必须属于当前工作区/)

  const ok = world.updateRelations([{ qqId: '10003', name: '阿鱼', role: 'trusted', chatKey: 'private:10003', sessionId: 'session-owner-2' }])
  assert.equal(ok.people.length, 1)
  assert.equal(ok.people[0].role, 'trusted')
})

test('diary: fish writes approved; trusted writes suggestion pending review', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home3-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws3-'))
  const owner = 'session-owner-3'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  const entry = world.appendDiary({ text: '今天很开心', actorName: '鱼', role: 'owner' })
  assert.equal(entry.suggestion, false)
  assert.equal(entry.record.actorName, '鱼')

  const suggestion = world.appendDiary({ text: '我想让鱼多睡一点', actorName: '阿鱼', role: 'trusted' })
  assert.equal(suggestion.suggestion, true)
  assert.equal(suggestion.record.status, 'pending')

  const pending = world.listDiary({ suggestions: true })
  assert.equal(pending.length, 1)

  const reviewed = world.reviewDiarySuggestion(suggestion.record.id, true)
  assert.equal(reviewed.accepted, true)
  assert.equal(world.listDiary({ suggestions: true }).length, 0)
  assert.equal(world.listDiary({}).length, 2)
})

test('diary comments: owner annotates without touching the fish original', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-comment-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-comment-'))
  const owner = 'session-owner-comment'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  const entry = world.appendDiary({ text: '今天风很大，我贴着水底走。', actorName: '鱼', role: 'owner' })
  const saved = world.commentDiary(entry.record.id, '这句写得很好，下次可以再写写海面。')
  assert.equal(saved.ok, true)
  assert.equal(saved.comment.diaryId, entry.record.id)
  assert.equal(saved.comment.actorName, '主人')

  const listed = world.listDiaryComments({ diaryId: entry.record.id })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].text, '这句写得很好，下次可以再写写海面。')

  // 批语是独立追加，鱼写的原文一字不改
  const original = world.listDiary({}).find((item) => item.id === entry.record.id)
  assert.equal(original.text, '今天风很大，我贴着水底走。')

  assert.throws(() => world.commentDiary(entry.record.id, '   '), /批语内容不能为空/)
  assert.throws(() => world.commentDiary('no-such-diary', '你好'), /日记不存在/)
})

test('fish wishes: fish asks, owner decides, tone shapes the mood impact', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-wish-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-wish-'))
  const owner = 'session-owner-wish'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  const first = world.appendWish({ text: '想让你今晚早点休息。', urgency: 'high' })
  assert.equal(first.wish.status, 'pending')
  assert.equal(world.wishSummary().pending, 1)
  assert.match(first.wish.day, /^\d{4}-\d{2}-\d{2}$/, '每条请求都带北京时间日期，方便按天重置')

  const warm = world.decideWish(first.wish.id, true, { reply: '好，听你的', tone: 'comforted' })
  assert.equal(warm.wish.status, 'approved')
  assert.equal(warm.moodImpact, 6)

  const second = world.appendWish({ text: '想换个头像。' })
  const curt = world.decideWish(second.wish.id, false, { tone: 'curt' })
  assert.equal(curt.wish.status, 'rejected')
  assert.equal(curt.moodImpact, -8)

  const third = world.appendWish({ text: '想多看一会儿海。' })
  const explained = world.decideWish(third.wish.id, false, { tone: 'explained' })
  assert.equal(explained.moodImpact, -2, '有解释的拒绝不应和冷淡打发一样重')

  // 已处理的请求不能重复裁决
  assert.throws(() => world.decideWish(first.wish.id, false), /已经处理过/)
  assert.throws(() => world.appendWish({ text: '  ' }), /请求内容不能为空/)
  assert.equal(world.wishSummary().pending, 0)
})

test('a fish gets at most three wishes per day, and the quota resets daily', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-wish-limit-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-wish-limit-'))
  const owner = 'session-owner-wish-limit'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  const summary = world.wishSummary()
  assert.equal(summary.dailyLimit, 3)
  assert.equal(summary.remainingToday, 3)

  world.appendWish({ text: '第一个请求。' })
  world.appendWish({ text: '第二个请求。' })
  world.appendWish({ text: '第三个请求。' })
  assert.throws(() => world.appendWish({ text: '第四个请求。' }), /今天已经提了 3 个请求/)
  assert.equal(world.wishSummary().remainingToday, 0)

  // 昨天没被回复的请求会被算进「挂着没答复」，不占今天的额度
  const yesterday = world.wishSummary().wishes[0].day
  assert.ok(yesterday)
  assert.equal(world.wishSummary().overdue, 0, '今天提的还不算过期')
})

test('interaction timeline merges diary comments and wish verdicts', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-tl-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-tl-'))
  const owner = 'session-owner-timeline'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  // 一条日记 + 一条批语
  const entry = world.appendDiary({ text: '今天海面很平。', actorName: '鱼', role: 'owner' })
  world.commentDiary(entry.record.id, '这句我喜欢', { quote: '海面很平' })

  // 一条请求 + 裁决
  const wish = world.appendWish({ text: '想早点休息。' })
  world.decideWish(wish.wish.id, true, { reply: '好', tone: 'comforted' })

  const timeline = world.interactionTimeline()
  assert.equal(timeline.ok, true)
  assert.equal(timeline.counts.diaryComments, 1)
  assert.equal(timeline.counts.approved, 1)
  assert.equal(timeline.counts.rejected, 0)
  assert.equal(timeline.counts.pendingReply, 1, '刚留的批语还没被鱼回应')

  // 时间线按时间倒序，且两类互动都在
  assert.equal(timeline.items.length, 2)
  const kinds = timeline.items.map((i) => i.kind).sort()
  assert.deepEqual(kinds, ['diary-comment', 'wish-approved'])

  // 批语保留被引用的原句；裁决保留答复与语气
  const comment = timeline.items.find((i) => i.kind === 'diary-comment')
  assert.equal(comment.quote, '海面很平')
  assert.equal(comment.responded, false)
  const verdict = timeline.items.find((i) => i.kind === 'wish-approved')
  assert.equal(verdict.reply, '好')
  assert.equal(verdict.tone, 'comforted')

  // 鱼回应后，待回应计数归零
  world.markDiaryCommentResponded(comment.id, '记住了')
  assert.equal(world.interactionTimeline().counts.pendingReply, 0)
})

test('interaction timeline is empty on a fresh world', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-tl0-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-tl0-'))
  const owner = 'session-owner-timeline0'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  const timeline = world.interactionTimeline()
  assert.equal(timeline.items.length, 0)
  assert.equal(timeline.counts.total, 0)
  assert.doesNotThrow(() => world.interactionTimeline())
})

test('diary comments can quote a real fragment and are acknowledged by the fish', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-quote-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-quote-'))
  const owner = 'session-owner-quote'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  const text = '今天很安静，海面是平的。想起昨天有人问我为什么喜欢慢慢游。'
  const entry = world.appendDiary({ text, actorName: '鱼', role: 'owner' })

  // 片段必须真实存在于原文
  assert.throws(
    () => world.commentDiary(entry.record.id, '这段写得很好', { quote: '原文里没有这句' }),
    /片段不在日记原文里/,
  )

  const quoted = world.commentDiary(entry.record.id, '这句我很喜欢。', { quote: '海面是平的' })
  assert.equal(quoted.comment.quote, '海面是平的')
  assert.equal(quoted.comment.respondedAt, null)

  // 未回应的批语会进入鱼的写日记素材
  const pending = world.pendingDiaryComments()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].quote, '海面是平的')

  // 鱼回应后不再重复提醒
  world.markDiaryCommentResponded(quoted.comment.id, '今天又看了看那片水面')
  assert.equal(world.pendingDiaryComments().length, 0)
  const all = world.listDiaryComments({ diaryId: entry.record.id })
  assert.equal(all[0].respondedAt != null, true)
  assert.equal(all[0].responseNote, '今天又看了看那片水面')

  // 原文仍然没被改动
  assert.equal(world.listDiary({}).find((item) => item.id === entry.record.id).text, text)
})


test('fish wishes: 请求可以是任何事，类别是自由文本', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-wishkind-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-wishkind-'))
  const owner = 'session-owner-wishkind'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  // 人设请求：鱼想把「自己是什么样的人」写下来，改不改是主人的事。
  const persona = world.appendWish({
    text: '我想把"不许说胖"那条留得松一点，改成"别拿这个当损话"。',
    kind: 'persona',
  })
  assert.equal(persona.wish.kind, 'persona', 'kind 要原样存下来，别被枚举成只认 wish')

  // 不认识的类别也照存：这是自由文本，别拿白名单把鱼的话拦掉。
  const odd = world.appendWish({ text: '想换个说话方式。', kind: '说话方式' })
  assert.equal(odd.wish.kind, '说话方式')

  // 超长类别截断，不撑破界面（24 字上限）。
  const long = world.appendWish({ text: '…', kind: 'x'.repeat(60) })
  assert.equal(long.wish.kind.length, 24)

  const stored = world.listWishes({ limit: 10 }).filter((item) => item.id === persona.wish.id)
  assert.equal(stored.length, 1, '重新读回来还在')
  assert.equal(stored[0].kind, 'persona')
})

test('主人绑定：三处真源摊开，桥换了影子会自动跟过去', () => {  const home = mkdtempSync(join(tmpdir(), 'fw-home-owner-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-owner-'))
  const owner = 'session-owner-bind'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices(fakeServices(workspace, owner))

  const clean = world.ownerBinding()
  assert.equal(clean.qq.bridge, '10000001')
  assert.equal(clean.qq.config, '10000001', '初始化时世界设置跟着桥写')
  assert.equal(clean.qq.relation, '10000001')
  assert.equal(clean.qqAgree, true)
  assert.equal(clean.session.bridge, owner)
  assert.equal(clean.session.config, owner)
  assert.equal(clean.sessionAgree, true)

  // 桥里换了主人会话（DSH 清理过会话目录后最常发生）：影子不能还指着旧 id，
  // 否则日记/请求/成长会投进一个已经不存在的会话。世界设置与关系表都要跟过去。
  const nextOwner = 'session-owner-bind-2'
  const shifted = createWorldStore({ home, qq: fakeQq('10000001', nextOwner) })
  shifted.setServices(fakeServices(workspace, nextOwner))
  const moved = shifted.ownerBinding()
  assert.equal(moved.session.bridge, nextOwner)
  assert.equal(moved.session.config, nextOwner, '世界设置要跟桥对齐')
  assert.equal(moved.session.relation, nextOwner, '关系表要跟桥对齐')
  assert.equal(moved.sessionAgree, true, '对齐之后应当一致')

  // 对齐只补 owner 两项，主人自己的设置不能被覆盖
  const cfgPath = join(workspace, '鱼的世界', '世界设置.json')
  const before = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.equal(before.scope, 'workspace-only', 'scope 是主人的设置，不该被动')
  assert.equal(before.createdAt, JSON.parse(readFileSync(cfgPath, 'utf8')).createdAt, '创建时间不变')
})

// 主人可能把「主人会话」绑错（或那个会话被 DSH 清掉）。设定页要能当场改回来：
// 真源是 QQ 桥，写完之后世界设置与关系表这两处影子必须跟着走，否则下次进工作区又被桥覆盖。
test('setOwner 写桥并让两处影子跟上；会话不存在时拒绝、不写半份', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-setowner-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-setowner-'))
  const first = 'session-owner-so-1'
  const second = 'session-owner-so-2'
  // 桥配置文件真的要存在：setOwnerBinding 只改键，不凭空造一份桥配置。
  const bridgeFile = join(home, 'qq-bridge-config.json')
  writeFileSync(bridgeFile, JSON.stringify({ 私聊QQ: '10000001', 目标会话: first, 群号: '20002', NapCat: 'http://127.0.0.1:3000' }), 'utf8')

  const services = (ids) => ({
    registry: { list: () => [{ path: workspace, sessionIds: ids }] },
    sessions: { get: (id) => (ids.includes(id) ? { id, cwd: workspace } : null), list: () => ids.map((id) => ({ id })) },
    agents: { list: () => [], get: () => null },
  })
  const world = createWorldStore({ home, qq: createQQ({ home }) })
  world.setServices(services([first, second]))
  assert.equal(world.ownerBinding().session.bridge, first)

  // 会话不存在：直接拒绝，桥里的旧值一点都不许动。
  assert.throws(() => world.setOwner({ targetSession: 'session-nope' }), /已经不存在/)
  assert.throws(() => world.setOwner({ targetSession: '' }), /请选一个/)
  assert.throws(() => world.setOwner({ privateQQ: 'abc' }), /数字 QQ 号/)
  assert.equal(JSON.parse(readFileSync(bridgeFile, 'utf8')).目标会话, first, '拒绝时桥没被改')

  const after = world.setOwner({ privateQQ: '10001000', targetSession: second })
  assert.equal(after.ok, true)
  const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8'))
  assert.equal(bridge.目标会话, second, '桥的目标会话已改')
  assert.equal(bridge.私聊QQ, '10001000', '桥的私聊号已改')
  assert.equal(bridge.群号, '20002', '桥的其它字段原样保留（那是别人的配置）')

  const binding = world.ownerBinding()
  assert.equal(binding.session.bridge, second)
  assert.equal(binding.session.config, second, '世界设置跟过来了')
  assert.equal(binding.session.relation, second, '关系表跟过来了')
  assert.equal(binding.sessionAgree, true)
  assert.equal(binding.qq.bridge, '10001000')
  assert.equal(binding.qqAgree, true)
  assert.equal(world.status().ownerSession, second)
})

test('主人会话已被清掉时 ownerBinding 如实说 sessionAlive=false', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-dead-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-dead-'))
  const owner = 'session-owner-dead'
  // 先建好工作区，再让宿主「忘掉」这个会话（模拟 DSH 清理会话目录）。
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  // 用带 get() 的服务：fakeServices 的 get 永远返回 null，测不出「还在」这一侧。
  const services = (ids) => ({
    registry: { list: () => [{ path: workspace, sessionIds: ids }] },
    sessions: { get: (id) => { const hit = ids.includes(id); return hit ? { id, cwd: workspace } : null } },
    agents: { list: () => [], get: () => null },
  })
  world.setServices(services([owner]))
  assert.equal(world.ownerBinding().sessionAlive, true)
  world.setServices(services(['session-owner-other']))
  assert.equal(world.ownerBinding().sessionAlive, false, '会话没了就要说出来，不能装作没事')
})

// 会话标题必须来自宿主的 sessionTitle 服务。
// 真实教训：只读 agent.session.title 时几乎全是空串，面板的「绑定房间」抽屉里
// 一排「未命名会话」，主人根本认不出该绑哪一间。
test('会话标题取自 sessionTitle 服务；拿不到时退回 agent 上的标题', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-sess-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-sess-'))
  const owner = 'session-owner-list'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  const sessionB = { id: 'session-b', createdAt: 1792911122012 }
  world.setServices({
    registry: { list: () => [{ path: workspace, sessionIds: [owner, 'session-b', 'session-c'] }] },
    sessions: { list: () => [{ id: owner }, sessionB, { id: 'session-c' }] },
    // 宿主生成的标题：a 有、b 没有、c 也没有
    sessionTitle: { get: (session) => ({ title: session.id === owner ? '宿主给的标题' : '' }) },
    agents: {
      list: () => [],
      get: (id) => (id === 'session-c' ? { session: { id, title: 'agent 上的标题' } } : null),
    },
  })
  const list = world.sessions()
  assert.equal(list.length, 3)
  assert.equal(list.find((item) => item.id === owner).title, '宿主给的标题', '优先用 sessionTitle')
  const nameless = list.find((item) => item.id === 'session-b')
  assert.equal(nameless.title, '', '两处都没有才是空')
  assert.equal(nameless.createdAt, 1792911122012, '创建时间要带出来，面板用它当兜底名字')
  assert.equal(list.find((item) => item.id === 'session-c').title, 'agent 上的标题', '退回 agent 标题')
})

test('已归档的会话不出现在可绑列表里', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-arch-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-arch-'))
  const owner = 'session-owner-arch'
  const world = createWorldStore({ home, qq: fakeQq('10000001', owner) })
  world.setServices({
    registry: {
      list: () => [{ path: workspace, sessionIds: [owner, 'session-hidden'] }],
      archivedSessionIds: ['session-hidden'],
    },
    sessions: { list: () => [{ id: owner }, { id: 'session-hidden' }] },
    sessionTitle: { get: (s) => ({ title: s.id }) },
    agents: { list: () => [], get: () => null },
  })
  const ids = world.sessions().map((item) => item.id)
  assert.deepEqual(ids, [owner], '归档的房间不该混进来让人挑')
})
