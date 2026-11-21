// 纠正记录 + 成长三要素判据（2026-11-21 主人要求五·「完整重做」的数据层）。
//
// 背景：主人给的公式是「纠正记录 = slots(kind=speech) + activity(kind=correction)」，
// 实测两处都不存在 ⇒ 新建 lib/corrections.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROMOTE_AT, createCorrectionStore } from '../lib/corrections.mjs'
import { createGrowthStore } from '../lib/growth.mjs'

function mkStore() {
  const root = mkdtempSync(join(tmpdir(), 'corr-'))
  let t = Date.parse('2026-11-21T10:00:00+08:00')
  const store = createCorrectionStore({ root, now: () => t })
  return { store, root, tick: (ms) => { t += ms } }
}

// ══════════════ 纠正记录 ══════════════

test('纠正：记一次要场景 + 该怎么说，缺一不给入库', () => {
  const { store } = mkStore()
  assert.throws(() => store.record({ sayInstead: '直接说谢谢' }), /场景/, '缺场景要拒')
  assert.throws(() => store.record({ scene: '被夸的时候' }), /该怎么说/, '缺说法要拒')
  assert.equal(store.list().length, 0, '❌ 不该留下半条记录')
})

test('纠正：第一次 count=1，未升级', () => {
  const { store } = mkStore()
  const r = store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(r.entry.promoted, false)
  assert.equal(r.repeated, false)
})

test('★ 同一场景 + 同一说法 ⇒ 第 N 次递增，不新增一条', () => {
  const { store } = mkStore()
  store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  const r2 = store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  assert.equal(r2.count, 2, '第二次要改成 2')
  assert.equal(r2.repeated, true)
  assert.equal(store.list().length, 1, '★ 还是 1 条记录（不是堆两条）')
})

test('★★ 第 3 次自动升级为检查（主人定的门槛）', () => {
  const { store } = mkStore()
  store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  const r3 = store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  assert.equal(PROMOTE_AT, 3)
  assert.equal(r3.count, 3)
  assert.equal(r3.entry.promoted, true, '★ 第 3 次要自动置 promoted')
  assert.ok(r3.entry.promotedAt, '要记升级时间')
})

test('不同场景各自计数（不串）', () => {
  const { store } = mkStore()
  store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  store.record({ scene: '被夸的时候', sayInstead: '直接说谢谢' })
  const other = store.record({ scene: '被安慰的时候', sayInstead: '说一句就好' })
  assert.equal(other.count, 1, '★ 另一个场景从 1 开始')
  assert.equal(store.list().length, 2)
})

test('手动升级 / 废弃', () => {
  const { store } = mkStore()
  const r = store.record({ scene: 'A', sayInstead: 'B' })
  const p = store.promote(r.entry.id)
  assert.equal(p.entry.promoted, true)
  assert.equal(store.list({ tab: 'promoted' }).length, 1)
  assert.equal(store.list({ tab: 'corrected' }).length, 0)

  store.retract(r.entry.id)
  assert.equal(store.list().length, 0, '★ 废弃后不再出现在列表')
})

test('★ 面板要的两个 tab：想通了（promoted）/ 被纠正（未 promoted）', () => {
  const { store } = mkStore()
  const a = store.record({ scene: 'A', sayInstead: 'B' })
  store.record({ scene: 'C', sayInstead: 'D' })
  store.promote(a.entry.id)
  assert.equal(store.list({ tab: 'promoted' })[0].scene, 'A')
  assert.equal(store.list({ tab: 'corrected' })[0].scene, 'C')
})

test('stats：记录数 / 总数 / 已升级 / 有对应成长的', () => {
  const { store } = mkStore()
  const a = store.record({ scene: 'A', sayInstead: 'B' })
  store.record({ scene: 'A', sayInstead: 'B' })   // 第2次
  store.record({ scene: 'C', sayInstead: 'D' })
  store.promote(a.entry.id)

  // 造一条成长，source 指向纠正 a ⇒ 算「已升级 1 条」
  const growthEntries = [{ id: 'g1', source: { type: 'correction', id: a.entry.id } }]
  const s = store.stats(growthEntries)
  assert.equal(s.records, 2, '两条去重后的记录')
  assert.equal(s.total, 3, '含重复次数共 3 次')
  assert.equal(s.promoted, 1)
  assert.equal(s.upgraded, 1, '★ 有对应成长的是 1 条')
})

test('stats：没有对应成长时 upgraded=0（面板据此不显示那行）', () => {
  const { store } = mkStore()
  store.record({ scene: 'A', sayInstead: 'B' })
  assert.equal(store.stats([]).upgraded, 0)
})

test('★ promoted 和 upgraded 是两个概念，不能混', () => {
  // promoted = 次数到了自动升级；upgraded = 有对应成长条目。
  // 混起来会让面板显示「已升级 2 条」而其实一条成长都没写。
  const { store } = mkStore()
  // 造两条都 promoted、但**只有一条**有对应成长
  const a = store.record({ scene: 'A', sayInstead: 'B' })
  const c = store.record({ scene: 'C', sayInstead: 'D' })
  store.promote(a.entry.id)
  store.promote(c.entry.id)

  const s = store.stats([
    { id: 'g1', source: { type: 'correction', id: a.entry.id } }
  ])
  assert.equal(s.promoted, 2, '两条都升级为检查')
  assert.equal(s.upgraded, 1, '★ 但只有一条有对应成长 —— 混用就会报成 2')
  assert.notEqual(s.promoted, s.upgraded, '这两个数值必须能不同')
})

test('落盘：同一条纠正的多次记录是同 id 的多行（可追溯）', () => {
  const { store, root } = mkStore()
  store.record({ scene: 'A', sayInstead: 'B' })
  store.record({ scene: 'A', sayInstead: 'B' })
  const f = join(root, '鱼的成长', '纠正记录', 'corrections.jsonl')
  assert.ok(existsSync(f), '要有落盘文件')
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2, '两次记录 = 两行（追加而非覆盖）')
  const ids = lines.map((l) => JSON.parse(l).id)
  assert.equal(new Set(ids).size, 1, '★ 同一条纠正保持同一个 id')
})

// ══════════════ 成长三要素 ══════════════

function mkGrowth() {
  const home = mkdtempSync(join(tmpdir(), 'grow-'))
  return { store: createGrowthStore({ home }), home }
}

test('★★ strict 模式：缺「原来」不入库', () => {
  const { store } = mkGrowth()
  assert.throws(
    () => store.record({ text: '现在想通了', quote: '一句原话', strict: true }),
    /原来/, '缺 before 要拒')
})

test('★★ strict 模式：缺「因为哪件事」不入库', () => {
  const { store } = mkGrowth()
  assert.throws(
    () => store.record({ text: '现在想通了', before: '原来那样', strict: true }),
    /因为哪件事|原句/, '缺 quote 要拒')
})

test('★★ strict 模式：原来 == 现在 不算变化', () => {
  const { store } = mkGrowth()
  assert.throws(
    () => store.record({ text: '同一句', before: '同一句', quote: '原话', strict: true }),
    /同一句|不算变化/)
})

test('strict 模式：三要素齐了才入库，且 before 落盘', () => {
  const { store } = mkGrowth()
  const r = store.record({
    text: '被夸的时候直接说谢谢就行',
    before: '被夸就想解释自己没那么好',
    quote: '你谦虚什么，夸你就是夸你',
    kind: 'insight',
    strict: true
  })
  assert.equal(r.ok, true)
  assert.equal(r.entry.before, '被夸就想解释自己没那么好', '★ 面板 ③ 区要显示「原来」')
  assert.equal(r.entry.quote, '你谦虚什么，夸你就是夸你')
})

test('非 strict 模式保持宽松（老调用点不被打断）', () => {
  const { store } = mkGrowth()
  const r = store.record({ text: '只有现在也能记' })
  assert.equal(r.ok, true, '★ 老路径不该突然报错')
  assert.equal(r.entry.before, '')
})

test('成长 source 能挂纠正 id（关联方向的约定）', () => {
  const { store } = mkGrowth()
  const r = store.record({
    text: '现在这样说',
    before: '原来那样说',
    quote: '原话',
    strict: true,
    source: { type: 'correction', id: 'corr-123' }
  })
  assert.deepEqual(r.entry.source, { type: 'correction', id: 'corr-123' })
})
