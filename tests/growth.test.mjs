import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGrowthStore, dayKeyShanghai } from '../lib/growth.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-growth-'))
  return { home, store: createGrowthStore({ home }) }
}

test('growth records are capped per day and reject duplicates', () => {
  const { store } = fresh()

  const first = store.record({ text: '被拒绝但被解释了，其实没那么难过。', kind: 'insight' })
  assert.equal(first.ok, true)
  assert.equal(first.entry.day, dayKeyShanghai())

  assert.throws(
    () => store.record({ text: '被拒绝但被解释了，其实没那么难过。' }),
    /已经记过了/,
  )

  store.record({ text: '下次想先问清楚再答应。', kind: 'next' })
  assert.throws(() => store.record({ text: '第三条应该被拦下。' }), /允许没有新认识/)

  assert.equal(store.status().total, 2)
  assert.equal(store.status().todayCount, 2)
  assert.equal(store.status().byKind.insight, 1)
  assert.equal(store.status().byKind.next, 1)
})

test('revision keeps the old record so it can be traced back', () => {
  const { store } = makeEarlyStore()

  const original = store.record({ text: '原以为被拒绝就是不喜欢我。' })
  const revised = store.revise(original.entry.id, { text: '被拒绝不一定是不喜欢，也可能只是做不到。' })

  assert.equal(revised.entry.revision, 2)
  assert.equal(revised.entry.supersedes, original.entry.id)

  // 当前只显示修订后的版本
  const current = store.list()
  assert.equal(current.total, 1)
  assert.match(current.entries[0].text, /不一定是不喜欢/)

  // 但历史链能追到原话
  const history = store.history(revised.entry.id)
  assert.equal(history.revisions.length, 2)
  assert.match(history.revisions[0].text, /原以为被拒绝/)

  assert.throws(() => store.revise(original.entry.id, { text: '换个说法' }), /不存在或已撤回/)
})

function makeEarlyStore() {
  const home = mkdtempSync(join(tmpdir(), 'fw-growth-early-'))
  const store = createGrowthStore({ home })
  // 让今日额度不挡住修订测试：只记一条
  return { home, store }
}

test('retracted days stay out until explicitly restored', () => {
  const { store } = fresh()
  const entry = store.record({ text: '今天发现自己其实很怕被忽略。' })
  const day = entry.entry.day

  const retracted = store.retract(day)
  assert.equal(retracted.retracted, 1)
  assert.equal(store.list().total, 0, '撤回后不应再出现在列表里')

  // 撤回是墓碑：同一天不能靠新写入悄悄恢复
  assert.equal(store.list().total, 0)

  const restored = store.restore(day)
  assert.equal(restored.ok, true)
  assert.equal(store.list().total, 1, '明确恢复后记录回来')

  assert.throws(() => store.retract('not-a-date'), /YYYY-MM-DD/)
  assert.throws(() => store.restore('2000-01-01'), /没有被撤回/)
})

test('growth stages advance with the number of kept records', () => {
  const { store } = fresh()
  const home = store.dir()
  mkdirSync(home, { recursive: true })

  // 直接构造账本更快，也能验证 stage 计算
  const lines = []
  for (let i = 0; i < 8; i += 1) {
    lines.push(JSON.stringify({
      type: 'entry', id: `e${i}`, at: new Date(Date.now() - i * 1000).toISOString(),
      day: '2026-01-0' + ((i % 8) + 1), kind: 'insight', text: `第 ${i} 条`, revision: 1, status: 'active',
    }))
  }
  writeFileSync(join(home, 'ledger.jsonl'), lines.join('\n') + '\n')

  const status = store.status()
  assert.equal(status.total, 8)
  assert.equal(status.stage.id, 'growing')
  assert.equal(status.stage.next.name, '深水的鱼')
  assert.ok(status.stage.progress >= 0 && status.stage.progress <= 1)
})

test('index verify catches a tampered ledger', () => {
  const { store } = fresh()
  store.record({ text: '第一次认真记下自己的变化。' })
  assert.equal(store.verify().ok, true)

  // 手工塞进一条索引里没有的记录
  const file = join(store.dir(), 'ledger.jsonl')
  const extra = JSON.stringify({
    type: 'entry', id: 'tampered', at: new Date().toISOString(),
    day: '2020-01-01', kind: 'insight', text: '外部写入', revision: 1, status: 'active',
  })
  writeFileSync(file, readFileSync(file, 'utf8') + extra + '\n')

  const check = store.verify()
  assert.equal(check.ok, false)
  assert.match(check.problems.join(' '), /不一致/)
})

test('materials only gather from the fish own records', () => {
  const { store } = fresh()
  const world = {
    listDiary: () => [{ id: 'd1', at: '2026-10-24T10:00:00Z', text: '今天很安静', actorName: '鱼' }],
    listDiaryComments: () => [{ id: 'c1', at: '2026-10-24T11:00:00Z', text: '这句很好', quote: '很安静', actorName: '主人' }],
    listWishes: () => [{ id: 'w1', at: '2026-10-24T12:00:00Z', text: '想早点休息', status: 'approved', tone: 'comforted' }],
  }
  const items = store.materials({ world })
  assert.equal(items.length, 3)
  assert.equal(items[0].type, 'wish', '按时间倒序')
  assert.ok(items.some((i) => i.type === 'comment' && i.quote === '很安静'))
})
