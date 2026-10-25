import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorldStore } from '../lib/world.mjs'

function fakeQq(ownerQQ = '1838601405', targetSession = 'session-owner-1') {
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
  world.setServices(fakeServices(workspace, owner))

  assert.throws(() => world.updateRelations([{ qqId: 'abc', name: 'x', role: 'trusted', chatKey: 'private:1', sessionId: 'session-a' }]), /QQ号无效/)
  assert.throws(() => world.updateRelations([{ qqId: '1838601405', name: 'x', role: 'trusted', chatKey: 'private:1838601405', sessionId: 'session-a' }]), /主人/)
  assert.throws(() => world.updateRelations([{ qqId: '10002', name: 'x', role: 'trusted', chatKey: 'private:10002', sessionId: 'session-elsewhere' }]), /必须属于当前工作区/)

  const ok = world.updateRelations([{ qqId: '10003', name: '阿鱼', role: 'trusted', chatKey: 'private:10003', sessionId: 'session-owner-2' }])
  assert.equal(ok.people.length, 1)
  assert.equal(ok.people[0].role, 'trusted')
})

test('diary: fish writes approved; trusted writes suggestion pending review', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home3-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws3-'))
  const owner = 'session-owner-3'
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
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

