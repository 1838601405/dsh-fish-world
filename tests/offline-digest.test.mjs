// 离线摘要判据（2026-11-22 主人要求「上线先看一遍：离线摘要 + 简短回复」）。
//
// 四步对应：
//   ① 判定离线窗口（>15 分钟）  → ensure 的基线与阈值
//   ② 只读拉取（白名单 / ≤30 每会话 / ≤200 总 / ≤6h 窗 / 溢出只记一条）
//   ③ 摘要 ≤120 字 + 写 activity（kind=offline-digest）
//   ④ 回复策略（直接找才回 / ≤2 条 / 同人一次 / 补投队列只用于摘要）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COUNT_READ_LIMIT,
  DIGEST_TEXT_MAX,
  GENERAL_MIN_GROUP,
  OFFLINE_THRESHOLD_MS,
  PER_CHAT_CAP,
  PULL_PER_CHAT,
  REPLY_BUDGET,
  TOTAL_CAP,
  buildDigestText,
  createOfflineDigest,
  planBacklog,
  summarizePulls
} from '../lib/offline-digest.mjs'

const MIN = 60_000
const HOUR = 3_600_000

function mkState(lastOnlineAt) {
  const dir = mkdtempSync(join(tmpdir(), 'od-state-'))
  const file = join(dir, '上线状态.json')
  if (lastOnlineAt != null) writeFileSync(file, JSON.stringify({ lastOnlineAt }), 'utf8')
  return file
}

const keyOf = (m) => '#' + String(m.id ?? '')
const isDirectPrivate = (m, t) => t.kind === 'private' || /@鱼|小鲸鱼/.test(String(m.text || ''))
const isEligibleAll = () => true

// ══════════ ① 判定离线窗口 ══════════

test('阈值是 15 分钟（主人定的）', () => {
  assert.equal(OFFLINE_THRESHOLD_MS, 15 * MIN)
})

test('没有基线（首次运行）→ 不猜离线多久，返回 null 并写下基线', async () => {
  const file = mkState(null)
  const d = createOfflineDigest({
    stateFile: file, recent: async () => ({ ok: true, messages: [] }),
    whitelist: () => [], now: () => 5_000_000, keyOf
  })
  const r = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.equal(r, null, '首次没有基线不触发摘要')
  const st = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(st.lastOnlineAt, 5_000_000, '★ 基线要写下来')
})

test('★ 离线 5 分钟 → 不生成摘要（验收 d）', async () => {
  const now0 = 8 * HOUR
  const file = mkState(now0 - 5 * MIN)
  const d = createOfflineDigest({
    stateFile: file, recent: async () => ({ ok: true, messages: [] }),
    whitelist: () => [{ chatKey: 'private:500' }], now: () => now0, keyOf
  })
  const r = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.equal(r, null, '5 分钟不该触发')
})

test('★ 恰好 15 分钟也不触发（「超过 15 分钟才算」）', async () => {
  const now0 = 8 * HOUR
  const file = mkState(now0 - 15 * MIN)
  const d = createOfflineDigest({
    stateFile: file, recent: async () => ({ ok: true, messages: [] }),
    whitelist: () => [], now: () => now0, keyOf
  })
  const r = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.equal(r, null, '恰好 15 分钟不算「超过」')
})

test('★ 离线 30 分钟 → 触发，返回 text + keys（验收 a 模块侧）', async () => {
  const now0 = 8 * HOUR
  const file = mkState(now0 - 30 * MIN)
  const rows = [
    { id: 'm1', userId: '500', nickname: '甲', text: '在吗', at: now0 - 20 * MIN },
    { id: 'm2', userId: '500', nickname: '甲', text: '？', at: now0 - 19 * MIN }
  ]
  const d = createOfflineDigest({
    stateFile: file, recent: async () => ({ ok: true, messages: rows }),
    whitelist: () => [{ chatKey: 'private:500' }], now: () => now0, keyOf
  })
  const r = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.ok(r, '30 分钟要触发')
  assert.match(r.text, /你不在的这段/)
  assert.match(r.text, /甲 找了你 2 次/, '同一个人两条要报次数')
  assert.equal(r.keys.size, 1, '★ 同一个人只回一次（只排最早那条）')
  assert.ok(r.attachKeys.has('#m1'), '★ 摘要挂第一条')
  assert.equal(r.gapMinutes, 30)
})

test('★ markOnline 刷新基线后，同实例再 ensure 不重复触发', async () => {
  const now0 = 8 * HOUR
  const file = mkState(now0 - 30 * MIN)
  const d = createOfflineDigest({
    stateFile: file, recent: async () => ({ ok: true, messages: [] }),
    whitelist: () => [{ chatKey: 'private:500' }], now: () => now0, keyOf
  })
  const first = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.ok(first, '第一次触发')
  d.markOnline()   // tick 结束时刷新
  const second = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.equal(second, null, '★ 基线刷新后 gap 归零，不再触发')
})

// ══════════ ② 只读拉取的上限 ══════════

test('★ 时间窗最多 6 小时：窗外的消息不进摘要', async () => {
  const now0 = 8 * HOUR
  const file = mkState(now0 - 30 * MIN)
  const rows = [
    { id: 'old', userId: '500', nickname: '甲', text: '两小时前说的', at: now0 - 7 * HOUR },  // 窗外
    { id: 'new', userId: '500', nickname: '甲', text: '刚说的', at: now0 - 20 * MIN }         // 窗内
  ]
  const d = createOfflineDigest({
    stateFile: file, recent: async () => ({ ok: true, messages: rows }),
    whitelist: () => [{ chatKey: 'private:500' }], now: () => now0, keyOf
  })
  const r = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.match(r.text, /甲 找过你/, '★ 只算窗内那条（窗外的不计数；count=1 的格式是「找过你」）')
  assert.ok(!r.text.includes('两小时前'), '窗外的不进摘要')
})

test('★ 每会话最多 30 条进材料；拉 31 条探测溢出', async () => {
  assert.equal(PER_CHAT_CAP, 30)
  assert.equal(PULL_PER_CHAT, 31)
  const now0 = 8 * HOUR
  const file = mkState(now0 - 30 * MIN)
  // 31 条全在窗内 → 溢出 → 触发一次计数读（recent 被调 2 次）
  const rows = []
  for (let i = 0; i < 31; i++) {
    rows.push({ id: 'm' + i, userId: '500', nickname: '甲', text: '第' + i + '条', at: now0 - 30 * MIN + i * 1000 })
  }
  const calls = []
  const d = createOfflineDigest({
    stateFile: file,
    recent: async (chatKey, limit) => { calls.push(limit); return { ok: true, messages: rows } },
    whitelist: () => [{ chatKey: 'private:500' }], now: () => now0, keyOf
  })
  const r = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  assert.deepEqual(calls, [PULL_PER_CHAT, COUNT_READ_LIMIT], '★ 先拉 31 探测，溢出再计数读 100')
  // 计数读返回 31 条全在窗 → N = 31 - 30 = 1
  assert.match(r.text, /还有 1 条更早的没看/, '★ 溢出只记一条')
})

test('★ 总上限 200：超出的会话不拉，记「另有 N 个会话没看到」', async () => {
  const now0 = 8 * HOUR
  const file = mkState(now0 - 30 * MIN)
  const chats = []
  for (let i = 0; i < 8; i++) chats.push({ chatKey: 'group:' + (100 + i) })
  const rows = []
  for (let i = 0; i < 30; i++) {
    rows.push({ id: 'g' + i, userId: '900', nickname: '乙', text: '聊' + i, at: now0 - 25 * MIN + i * 1000 })
  }
  const pulled = []
  const d = createOfflineDigest({
    stateFile: file,
    recent: async (chatKey) => { pulled.push(chatKey); return { ok: true, messages: rows } },
    whitelist: () => chats, now: () => now0, keyOf
  })
  const r = await d.ensure({ selfId: '', isDirect: isDirectPrivate, isEligible: isEligibleAll })
  // 7 个会话 × 30 = 210 ≥ 200 → 第 8 个不拉
  assert.ok(pulled.length <= 7, '★ 到 200 就停，不再拉（实拉 ' + pulled.length + ' 个）')
  assert.equal(TOTAL_CAP, 200)
  assert.match(r.text, /另有 \d+ 个会话没看到/, '★ 没轮到的会话要记一笔')
})

// ══════════ ③ 摘要正文 ══════════

test('全部读不到 → 说「这段没看到」，不编（验收边界）', () => {
  const t = buildDigestText({ okPulls: 0, failedChats: 2 })
  assert.match(t, /这段没看到/)
})

test('没人找 → 「没人找你」', () => {
  assert.match(buildDigestText({ okPulls: 1 }), /没人找你/)
})

test('群点名的人进摘要', () => {
  const t = buildDigestText({
    okPulls: 1, groupCount: 5, groupDirect: ['乙'], newestGroupText: '周末去不去爬山啊'
  })
  assert.match(t, /乙 点名你/)
  assert.match(t, /5 条群里消息/)
  assert.match(t, /最新在聊「周末去不去爬山啊」/, '引子 ≤14 字原样带（8 字不截）')
})

test('群里最新是纯图 → 「发了张图」', () => {
  const t = buildDigestText({ okPulls: 1, groupCount: 3, newestGroupText: '   ' })
  assert.match(t, /发了张图/)
})

test('部分会话读不到 → 记一笔但不冒充全部看到', () => {
  const t = buildDigestText({ okPulls: 1, failedChats: 2 })
  assert.match(t, /有 2 个会话没读到/)
})

test('★ 摘要 ≤120 字，超了截断', () => {
  const names = Array.from({ length: 30 }, (_, i) => '人' + i)
  const t = buildDigestText({ okPulls: 1, privateSenders: names.map((n) => ({ name: n, count: 9, firstAt: 1 })) })
  assert.ok(t.length <= DIGEST_TEXT_MAX, '★ 超过 ' + DIGEST_TEXT_MAX + ' 字：' + t.length)
  assert.ok(t.endsWith('…'), '截断要带省略号')
})

test('summarizePulls：不合格消息（自己/禁言）不算「谁找过她」', () => {
  const pulls = new Map([['private:500', {
    kind: 'private', target: { kind: 'private' },
    material: [
      { id: 'a', userId: '777', nickname: '鱼', text: '我发的', at: 1 },      // 自己 → isEligible false
      { id: 'b', userId: '500', nickname: '甲', text: '找你', at: 2 },
      { id: 'b2', userId: '500', nickname: '甲', text: '又找', at: 3 }
    ]
  }]])
  const eligible = (m) => m.userId !== '777'
  const s = summarizePulls(pulls, isDirectPrivate, eligible)
  assert.equal(s.privateSenders.length, 1, '★ 自己发的不算')
  assert.equal(s.privateSenders[0].count, 2)
})

test('summarizePulls：群点名去重 + 最新那条做引子', () => {
  const pulls = new Map([['group:1', {
    kind: 'group', target: { kind: 'group' },
    material: [
      { id: 'x', userId: '500', nickname: '甲', text: '小鲸鱼在吗', at: 1 },
      { id: 'y', userId: '500', nickname: '甲', text: '叫你呢', at: 2 },
      { id: 'z', userId: '600', nickname: '乙', text: '来啦来啦', at: 3 }
    ]
  }]])
  const s = summarizePulls(pulls, () => true, isEligibleAll)
  // isDirect 全 true：甲（两条）和乙都算点名，甲去重成一个
  assert.deepEqual(s.groupDirect, ['甲', '乙'], '★ 同一人去重（甲两条只算一个）')
  assert.equal(s.groupCount, 3)
  assert.equal(s.newestGroupText, '来啦来啦', '★ 引子取最新')
})

// ══════════ ④ 回复策略 ══════════

function pullOf(kind, msgs) {
  return { kind, target: { kind }, material: msgs }
}

test('★ 只排直接找她的（群里没叫的不排）', () => {
  const pulls = new Map([
    ['group:1', pullOf('group', [
      { id: 'g1', userId: '600', nickname: '乙', text: '随便聊聊', at: 10 },
      { id: 'g2', userId: '600', nickname: '乙', text: '再聊聊', at: 11 }
    ])]
  ])
  const plan = planBacklog({ pulls, keyOf, isDirect: () => false, isEligible: isEligibleAll })
  assert.equal(plan.deliveries.length, 0, '★ 没人直接找就不排回复')
})

test('★ 同一个人只回一次，取他最早那条', () => {
  const pulls = new Map([['private:500', pullOf('private', [
    { id: 'p1', userId: '500', nickname: '甲', text: '在吗', at: 10 },
    { id: 'p2', userId: '500', nickname: '甲', text: '？', at: 11 },
    { id: 'p3', userId: '500', nickname: '甲', text: '人呢', at: 12 }
  ])]])
  const plan = planBacklog({ pulls, keyOf, isDirect: () => true, isEligible: isEligibleAll })
  assert.equal(plan.deliveries.length, 1, '★ 三条只回一条')
  assert.equal(plan.deliveries[0].key, '#p1', '取最早那条')
})

test('★ 一次上线最多 2 条（三个人只排前两个）', () => {
  const pulls = new Map([['group:1', pullOf('group', [
    { id: 'a', userId: '1', nickname: 'A', text: '@鱼', at: 10 },
    { id: 'b', userId: '2', nickname: 'B', text: '@鱼', at: 11 },
    { id: 'c', userId: '3', nickname: 'C', text: '@鱼', at: 12 }
  ])]])
  const plan = planBacklog({
    pulls, keyOf, isDirect: () => true, isEligible: isEligibleAll, budget: REPLY_BUDGET
  })
  assert.equal(plan.deliveries.length, 2, '★ 预算封顶 2')
  assert.equal(REPLY_BUDGET, 2)
  assert.equal(plan.deliveries[0].key, '#a')
  assert.equal(plan.deliveries[1].key, '#b')
})

test('★ 补投队列里的消息只用于摘要，不排回复（验收 f 模块侧）', () => {
  const pulls = new Map([['private:500', pullOf('private', [
    { id: 'q1', userId: '500', nickname: '甲', text: '在吗', at: 10 }
  ])]])
  const plan = planBacklog({
    pulls, keyOf, isDirect: () => true, isEligible: isEligibleAll,
    isPending: (chatKey, m) => chatKey === 'private:500' && m.id === 'q1'
  })
  assert.equal(plan.deliveries.length, 0, '★ 队列里的不重复回')
  assert.equal(plan.general, null, '没有直接回复也不硬凑总括')
})

test('★ 群热闹（≥3 条）且没人直接找 → 一句总括（排最新那条）', () => {
  const msgs = Array.from({ length: GENERAL_MIN_GROUP }, (_, i) => ({
    id: 'g' + i, userId: '600', nickname: '乙', text: '聊' + i, at: 10 + i
  }))
  const pulls = new Map([['group:1', pullOf('group', msgs)]])
  const plan = planBacklog({ pulls, keyOf, isDirect: () => false, isEligible: isEligibleAll })
  assert.ok(plan.general, '热闹要给一句总括')
  assert.equal(plan.general.key, '#g' + (GENERAL_MIN_GROUP - 1), '★ 排群里最新那条')
  assert.equal(plan.deliveries.length, 0)
})

test('★ 群不热闹（<3 条）→ 不回（「也可以不回」）', () => {
  const pulls = new Map([['group:1', pullOf('group', [
    { id: 'g1', userId: '600', nickname: '乙', text: '一句', at: 10 },
    { id: 'g2', userId: '600', nickname: '乙', text: '两句', at: 11 }
  ])]])
  const plan = planBacklog({ pulls, keyOf, isDirect: () => false, isEligible: isEligibleAll })
  assert.equal(plan.general, null, '★ 不热闹不硬凑总括')
})

test('★ 有人直接找 → 只回直接的，不再加总括', () => {
  const pulls = new Map([
    ['private:500', pullOf('private', [{ id: 'p1', userId: '500', nickname: '甲', text: '在吗', at: 5 }])],
    ['group:1', pullOf('group', Array.from({ length: 5 }, (_, i) => ({
      id: 'g' + i, userId: '600', nickname: '乙', text: '聊' + i, at: 10 + i
    })))]
  ])
  const plan = planBacklog({ pulls, keyOf, isDirect: (m, t) => t.kind === 'private', isEligible: isEligibleAll })
  assert.equal(plan.deliveries.length, 1)
  assert.ok(!plan.general, '★ 有直接回复就不加总括（不刷屏）')
})

test('★ 摘要只挂第一条（attach），其余不重复整段', () => {
  const pulls = new Map([['group:1', pullOf('group', [
    { id: 'a', userId: '1', nickname: 'A', text: '@鱼', at: 10 },
    { id: 'b', userId: '2', nickname: 'B', text: '@鱼', at: 11 }
  ])]])
  const plan = planBacklog({ pulls, keyOf, isDirect: () => true, isEligible: isEligibleAll })
  assert.equal(plan.deliveries[0].attach, true, '★ 第一条挂摘要')
  assert.equal(plan.deliveries[1].attach, false, '★ 后面的不重复挂')
})

// ══════════ activity 标签（面板可查的前提）══════════

test('★ ACTIVITY_KINDS 有 offline-digest（否则会被降级成 other）', () => {
  const src = readFileSync('lib/activity.mjs', 'utf8')
  assert.match(src, /'offline-digest': '离线摘要'/, '★ kind 要进白名单才有中文标签')
})

test('源码级：inbox 接了 ensure（离线窗口接管 verdicts）', () => {
  const src = readFileSync('lib/qq-inbox.mjs', 'utf8')
  assert.match(src, /digestPlan = await d\.ensure/, 'tick 里要跑 ensure')
  assert.match(src, /offlineDeliver/, '★ 离线排的要绕过攒批直接投')
  assert.match(src, /digestPlan\.attachKeys\.has\(key\)/, '★ 摘要挂第一条投递')
  assert.match(src, /markOnline\(\)/, '★ tick 结束刷新上次处理时间')
})

test('源码级：没注入 digestStateFile 时摘要层不激活（既有测试零影响）', () => {
  const src = readFileSync('lib/qq-inbox.mjs', 'utf8')
  const seg = src.slice(src.indexOf('function getDigest'), src.indexOf('function getDigest') + 500)
  assert.match(seg, /if \(!stateFile\) return null/, '★ 没注入就不创建，不碰真实状态文件')
})
