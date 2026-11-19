// 鲸鲸任务移植版的判据。
// 覆盖：闸门顺序、时间轴、两次调用、注入文案、日志/摘要/汇报、重启补记、取消不留痕。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PASSWORD_WORD,
  buildPromptText,
  buildRecentInjection,
  buildTaskInjection,
  computeTimeline,
  createWhaleTask,
  createWhaleTaskStore,
  gateCheck,
  parsePlan,
  parseRange,
  parseResult,
  seasonLabel,
  taskPhase
} from '../lib/whale-task.mjs'

function mkStore() {
  const root = mkdtempSync(join(tmpdir(), 'wt-'))
  return { root, store: createWhaleTaskStore({ worldRoot: root }) }
}

function mkTask(opts = {}) {
  const { root, store } = mkStore()
  const sent = []
  let clock = opts.startAt || 1_700_000_000_000
  const task = createWhaleTask({
    store,
    config: () => ({ enabled: true, requirePassword: false, ...(opts.config || {}) }),
    plan: opts.plan || (async () => ({ ok: true, text: '翻翻书架上有什么\n时长：20' })),
    write: opts.write || (async () => ({
      ok: true,
      text: '天气：起风\n心情：有点困\n\n风把窗帘吹起来了。\n摘要：去书房翻了本书\n汇报：翻到一本讲潮汐的册子\n汇报：还有张旧海图'
    })),
    send: async (text) => { sent.push(text); return { ok: true } },
    ownerQQ: () => '10001000',
    log: () => {},
    now: () => clock
  })
  return {
    root,
    store,
    task,
    sent,
    advance: (ms) => { clock += ms },
    setClock: (v) => { clock = v },
    getClock: () => clock
  }
}

// ─────────────────── 闸门顺序 ───────────────────

test('闸门：只认主人（非主人一律拦）', () => {
  const st = { activeTask: null, lastTaskStartedAt: 0 }
  assert.match(gateCheck({ isOwner: false, enabled: true, state: st }), /只有主人/)
  // 非主人 + 总开关也关着：仍然先报「只认主人」（顺序要对）
  assert.match(gateCheck({ isOwner: false, enabled: false, state: st }), /只有主人/)
})

test('闸门：总开关关着就拦', () => {
  const st = { activeTask: null, lastTaskStartedAt: 0 }
  assert.match(gateCheck({ isOwner: true, enabled: false, state: st }), /总开关/)
})

test('闸门：口令模式必须说「去吧」', () => {
  const st = { activeTask: null, lastTaskStartedAt: 0 }
  assert.match(
    gateCheck({ isOwner: true, enabled: true, requirePassword: true, userText: '你出去玩会儿', state: st }),
    /还没说「去吧」/
  )
  assert.equal(
    gateCheck({ isOwner: true, enabled: true, requirePassword: true, userText: '去吧，出去玩会儿', state: st }),
    null
  )
})

test('闸门：已有任务时不许再出发，且提示里带任务名', () => {
  const st = { activeTask: { what: '做饭' }, lastTaskStartedAt: 0 }
  const r = gateCheck({ isOwner: true, enabled: true, state: st })
  assert.match(r, /已经在执行任务/)
  assert.match(r, /做饭/)
})

test('闸门：2 分钟防抖', () => {
  const now = 1_700_000_000_000
  const st = { activeTask: null, lastTaskStartedAt: now - 30_000 }
  assert.match(gateCheck({ isOwner: true, enabled: true, state: st, now }), /刚出发过/)
  // 过了 2 分钟就放行
  const st2 = { activeTask: null, lastTaskStartedAt: now - 130_000 }
  assert.equal(gateCheck({ isOwner: true, enabled: true, state: st2, now }), null)
})

test('闸门顺序：口令拦在「已有任务」之前', () => {
  const st = { activeTask: { what: '做饭' }, lastTaskStartedAt: 0 }
  const r = gateCheck({ isOwner: true, enabled: true, requirePassword: true, userText: '没有口令', state: st })
  assert.match(r, /还没说/, '口令应先报，不是先说已有任务')
})

// ─────────────────── 时间轴 ───────────────────

test('时间轴：createdAt → +60s leaveAt → +duration dueAt', () => {
  const t = computeTimeline({ now: 1000, durationMin: 30, leaveDelaySec: 60 })
  assert.equal(t.createdAt, 1000)
  assert.equal(t.leaveAt, 1000 + 60_000)
  assert.equal(t.dueAt, 1000 + 60_000 + 30 * 60_000)
})

test('时间轴：时长夹在 5..600', () => {
  assert.equal(computeTimeline({ now: 0, durationMin: 1, leaveDelaySec: 0 }).durationMin, 5)
  assert.equal(computeTimeline({ now: 0, durationMin: 5000, leaveDelaySec: 0 }).durationMin, 600)
})

test('时间轴：没给时长就用区间随机', () => {
  const t = computeTimeline({ now: 0, durationMin: 0, leaveDelaySec: 0, range: { min: 20, max: 60 } })
  assert.ok(t.durationMin >= 20 && t.durationMin <= 60)
})

test('阶段：leaveAt 之前是 prep，之后是 running', () => {
  const task = { leaveAt: 5000, dueAt: 10000 }
  assert.equal(taskPhase(task, 4000), 'prep')
  assert.equal(taskPhase(task, 6000), 'running')
  assert.equal(taskPhase(null, 6000), null)
})

// ─────────────────── 注入文案 ───────────────────

test('注入：不出现剩余分钟数（会毁前缀缓存）', () => {
  const task = { what: '做饭', plan: '煮个面', leaveAt: 0, dueAt: Date.now() + 10 * 60000 }
  const text = buildTaskInjection(task)
  assert.doesNotMatch(text, /还剩|剩余|还有\s*\d+\s*分钟/)
})

test('注入：执行中必须有恒定句「还没到结束时间」', () => {
  const task = { what: '做饭', plan: '', leaveAt: 0, dueAt: Date.now() + 60000 }
  assert.match(buildTaskInjection(task), /任务还没到结束时间/)
})

test('注入：说「执行任务」不说「在外面」', () => {
  const task = { what: '做饭', leaveAt: 0, dueAt: Date.now() + 60000 }
  const text = buildTaskInjection(task)
  assert.match(text, /【你正在执行任务】/)
  assert.doesNotMatch(text, /在外面/)
})

test('注入：出门前给准备阶段文案', () => {
  const task = { what: '做饭', plan: '煮面', leaveAt: Date.now() + 30000, dueAt: Date.now() + 90000 }
  assert.match(buildTaskInjection(task), /【你正准备开始】/)
})

test('注入：任务期间带环境，结束后撤掉并给「最近出去过」', () => {
  const now = Date.now()
  const st = { activeTask: { what: '做饭', leaveAt: 0, dueAt: now + 60000 } }
  const during = buildPromptText({ state: st, events: [], worldbook: '## 住所\n海边三居室', now })
  assert.match(during, /【你所在的环境】/)
  assert.match(during, /海边三居室/)

  const after = buildPromptText({
    state: { activeTask: null },
    events: [{ what: '做饭', summary: '煮了面', dueAt: now - 3600_000 }],
    worldbook: '## 住所\n海边三居室',
    now
  })
  assert.doesNotMatch(after, /【你所在的环境】/, '结束后环境要撤掉')
  assert.match(after, /【你最近出去过】/)
})

test('最近出去过：只取 24h 内、最多 3 条、新的在前', () => {
  const now = Date.now()
  const events = [
    { what: 'A', summary: 'a', dueAt: now - 1 * 3600_000 },
    { what: 'B', summary: 'b', dueAt: now - 2 * 3600_000 },
    { what: 'C', summary: 'c', dueAt: now - 3 * 3600_000 },
    { what: 'D', summary: 'd', dueAt: now - 4 * 3600_000 },
    { what: 'OLD', summary: 'x', dueAt: now - 30 * 3600_000 }
  ]
  const text = buildRecentInjection(events, { now })
  assert.match(text, /A/)
  assert.match(text, /B/)
  assert.match(text, /C/)
  assert.doesNotMatch(text, /OLD/)
  const order = ['A', 'B', 'C'].map((k) => text.indexOf(k))
  assert.ok(order[0] < order[1] && order[1] < order[2], '新的要在前面')
})

// ─────────────────── 四季（防「11 月写桂花」） ───────────────────

test('季节必须带月份，不能只给「秋天」', () => {
  const nov = new Date('2026-11-18T10:00:00+08:00').getTime()
  const label = seasonLabel(nov)
  assert.match(label, /11月/)
  assert.match(label, /秋天/)
})

// ─────────────────── 完整生命周期 ───────────────────

test('出发 → 期间知道打算 → 到点回来写日志并汇报 2-3 句', async () => {
  const h = mkTask()
  const started = await h.task.startTask({ what: '去书房转转', isOwner: true })
  assert.equal(started.ok, true)

  // 期间：注入里能看到打算
  const during = h.task.promptText()
  assert.match(during, /去书房转转/)
  assert.match(during, /翻翻书架/)

  // 到点结算
  h.advance(60_000 + 20 * 60_000 + 1000)
  const fin = await h.task.finishTask()
  assert.equal(fin.ok, true)
  assert.ok(h.sent.length >= 2 && h.sent.length <= 3, '汇报要 2-3 条，实际 ' + h.sent.length)
  assert.match(h.sent[0], /潮汐|海图|书/)

  // 落盘：events.jsonl 有一条，日志.md 有内容
  assert.ok(existsSync(join(h.root, '鱼的任务', 'events.jsonl')))
  const ev = h.store.readEvents()
  assert.equal(ev.length, 1)
  assert.equal(ev[0].what, '去书房转转')
  assert.ok(ev[0].journal.length > 0)
  assert.ok(ev[0].summary.length > 0)
  assert.ok(existsSync(join(h.root, '鱼的任务', '日志.md')))
  assert.match(readFileSync(join(h.root, '鱼的任务', '日志.md'), 'utf8'), /去书房转转/)
})

test('召回：3 分钟内回来，只生效一次', async () => {
  const h = mkTask()
  await h.task.startTask({ what: '洗澡', isOwner: true })
  const r1 = h.task.comeBack({ isOwner: true })
  assert.equal(r1.ok, true)
  const task = h.store.readState().activeTask
  assert.ok(task.dueAt - h.getClock() === 3 * 60000, '召回后应是 3 分钟')
  // 第二次不许再改
  const r2 = h.task.comeBack({ isOwner: true })
  assert.equal(r2.ok, false)
})

test('取消：不汇报、不留记录', async () => {
  const h = mkTask()
  await h.task.startTask({ what: '收拾房间', isOwner: true })
  const r = h.task.cancelTask({ isOwner: true })
  assert.equal(r.ok, true)
  // 没有 activeTask、没有事件、没发消息
  assert.equal(h.store.readState().activeTask, null)
  assert.equal(h.store.readEvents().length, 0)
  assert.equal(h.sent.length, 0)
})

test('非主人不能召回/取消', async () => {
  const h = mkTask()
  await h.task.startTask({ what: '洗衣服', isOwner: true })
  assert.equal(h.task.comeBack({ isOwner: false }).ok, false)
  assert.equal(h.task.cancelTask({ isOwner: false }).ok, false)
  assert.ok(h.store.readState().activeTask, '拦下后任务要还在')
})

test('重启补记：过期在阈值内 → 汇报；超过阈值 → 只记日志不汇报', async () => {
  // 阈值内（过期 1 分钟）
  const a = mkTask()
  await a.task.startTask({ what: '买菜', isOwner: true })
  a.advance(60_000 + 20 * 60000 + 60_000)
  const r1 = await a.task.resumeOnBoot()
  assert.equal(r1.finished, true)
  assert.equal(r1.reported, true)
  assert.ok(a.sent.length > 0)

  // 超阈值（过期 5 小时）
  const b = mkTask()
  await b.task.startTask({ what: '买菜', isOwner: true })
  b.advance(60_000 + 20 * 60000 + 5 * 3600_000)
  const r2 = await b.task.resumeOnBoot()
  assert.equal(r2.finished, true)
  assert.equal(r2.reported, false, '半夜关机第二天开机不该收到「我买菜回来了」')
  assert.equal(b.store.readEvents().length, 1, '但日志要补记')
})

test('没填主人 QQ → 闸门拦下（原版坑 1）', async () => {
  const h = mkTask()
  const t = createWhaleTask({
    store: h.store,
    config: () => ({ enabled: true }),
    plan: async () => ({ ok: true, text: '' }),
    write: async () => ({ ok: true, text: '' }),
    send: async () => ({ ok: true }),
    ownerQQ: () => '',
    log: () => {}
  })
  assert.equal(t.ownerChatKey(), '')
})

// ─────────────────── 解析 ───────────────────

test('parsePlan：拆出时长与打算', () => {
  const r = parsePlan('翻翻书架上的书\n时长：25')
  assert.equal(r.durationMin, 25)
  assert.match(r.plan, /翻翻书架/)
})

test('parseResult：拆出正文/摘要/汇报（2-3 条）', () => {
  const r = parseResult('天气：起风\n心情：困\n\n正文第一句。\n摘要：去了书房\n汇报：翻到册子\n汇报：还有海图')
  assert.match(r.journal, /正文第一句/)
  assert.equal(r.summary, '去了书房')
  assert.deepEqual(r.report, ['翻到册子', '还有海图'])
})

test('parseRange：坏值落回默认', () => {
  assert.deepEqual(parseRange('20-60', 10, 20), { min: 20, max: 60 })
  assert.deepEqual(parseRange('abc', 10, 20), { min: 10, max: 20 })
  assert.deepEqual(parseRange('60-20', 10, 20), { min: 20, max: 60 }, '倒着的区间要能纠正')
})

// ─────────────────── 外部数据可缺省 ───────────────────

test('世界设定缺失不报错，只当没有环境', async () => {
  const h = mkTask()
  // 不建 世界设定.md，直接跑
  const r = await h.task.startTask({ what: '散步', isOwner: true })
  assert.equal(r.ok, true, '没有世界书也要能出发')
  // 2026-11-19 真机抓到：只读不建 → 模板永远不会落地。
  // 现在 parseWorldbook 会先 ensure（幂等）。
  assert.ok(existsSync(join(h.root, '鱼的任务', '世界设定.md')),
    '读世界设定会自动把模板建出来（首测真机漏过这条）')
  assert.equal(h.store.parseWorldbook(), '')
})

test('世界设定里的 HTML 注释示例不会被当成真实环境', async () => {
  const h = mkTask()
  h.store.ensureWorldbook()
  const text = h.store.parseWorldbook()
  // 模板里「三居室」「海边」都在注释里，解析后不该出现
  assert.doesNotMatch(text, /三居室/)
  assert.doesNotMatch(text, /海边/)
})

// ─── 真机首测抓到的缺陷（2026-11-19）：静默吞 ───

test('模型调用失败必须留痕，不许静默（源码级）', () => {
  const src = readFileSync('lib/whale-task.mjs', 'utf8')
  assert.match(src, /规划调用没拿到内容：/, 'plan 返回 ok:false/空文本时要 log')
  assert.match(src, /写日志调用没拿到内容：/, 'write 同理')
  // 反面：不许只在 catch 里记（真机那次是 r.ok=false，没走 catch）
  const planIdx = src.indexOf('规划调用没拿到内容')
  const catchIdx = src.indexOf('规划调用失败（继续用默认时长）')
  assert.ok(planIdx > 0 && catchIdx > 0,
    '两种失败都要有日志：静默失败正是真机查不出「计划为空」的原因')
})

test('鲸鲸任务的模型通道不看 chatApi.enabled（源码级）', () => {
  // 真实部署里 platforms.chatApi.enabled=false（群聊故意走 DSH 会话），
  // 但原版 whale-task 自带模型调用、不看这个开关。用群聊开关挡任务是移植引入的错。
  const src = readFileSync('lib/index.js', 'utf8')
  assert.match(src, /createChatApi\(\{\s*\n\s*home,\s*\n\s*getConfig: \(\) => \(\{ \.\.\.\(configStore\.getConfig\(\)\.chatApi \|\| \{\}\), enabled: true \}\)/,
    '鲸鲸任务要开自己的通道实例，enabled 强制 true')
})
