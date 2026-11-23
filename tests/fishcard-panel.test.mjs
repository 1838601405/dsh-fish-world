// 设置面判据（酒馆做法一 + 二，主人 2026-11-24）：
//   一、任一设置项，能在界面上看出**它的作用范围**，不用读文档。
//   二、改完一个设置，**不离开页面就能确认生效**（当前是否启用 / 本轮有没有命中 / 上次触发）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conditionPanel, noteHits, groupByTier, LAYER_HINT } from '../lib/fishcard-panel.mjs'

const SECTIONS = [
  { tier: '常驻', title: '你是谁', body: '我是小鲸鱼。', keys: [], when: '', order: 100, cooldown: 0 },
  { tier: '条件', title: '白饭档', body: '主食白饭。', keys: ['白饭'], when: '', order: 10, cooldown: 4 },
  { tier: '条件', title: '群里', body: '群里的样子。', keys: [], when: 'group', order: 20, cooldown: 0 },
  { tier: '语料', title: '冷启动', body: '你猜～', keys: [], when: '', order: 100, cooldown: 0 },
]

test('★★ 判据一：每项标得出「作用范围」——layer + fields 逐字段给层', () => {
  const p = conditionPanel({ sections: SECTIONS, facts: { kind: 'group' } })
  for (const it of p.items) {
    assert.ok(it.layer, `★ ${it.title} 要有 layer`)
    assert.ok(LAYER_HINT[it.layer], `★ ${it.layer} 要有说明（读法推不出时才用）`)
    assert.ok(it.fields && typeof it.fields === 'object', `★ ${it.title} 要有 fields（逐字段层）`)
    assert.equal(it.fields.正文, '预设', '★ 正文改了要动人设预设/*.md')
  }
  const cond = p.items.find((i) => i.title === '白饭档')
  assert.equal(cond.fields.开关, '角色', '★ 开关是 sidecar，只影响这个角色')
  assert.equal(cond.fields.冷却, '会话', '★ cooldown 是跨轮状态，只影响这一场')
  const plain = p.items.find((i) => i.title === '你是谁')
  assert.equal(plain.fields.冷却, undefined, '★ 常驻没有 cooldown（不硬造字段）')
})

test('★★ 判据二：启用 / 本轮命中 / 上次触发 三个状态都看得见', () => {
  const p = conditionPanel({
    sections: SECTIONS,
    facts: { kind: 'group', text: '来份白饭' },
    state: { cooldowns: {}, lastHits: { 白饭档: 1700000000000 } },
    round: 3,
  })

  const white = p.items.find((i) => i.title === '白饭档')
  assert.equal(white.enabled, true, '★ 当前是否启用')
  assert.equal(white.hitNow, true, '★ 本轮有没有命中（keys=白饭 命中 text）')
  assert.equal(white.lastHitAt, 1700000000000, '★ 上次触发是什么时候')

  const plain = p.items.find((i) => i.title === '你是谁')
  assert.equal(plain.hitNow, false, '★ 常驻不算「命中」（它每轮都在，谈不上命中）')
  assert.equal(plain.lastHitAt, null, '★ 没触发过给 null（不编时间）')

  // summary 给面板一行用
  assert.equal(p.summary.total, 4)
  assert.equal(p.summary.conditions, 2)
  assert.equal(p.summary.hitNow, 2, '★ 白饭档 + 群里 都命中')
  assert.equal(p.summary.round, 3)
})

test('★★ 关掉一条 → enabled=false 且 hitNow=false（即使 keys 命中）', () => {
  const p = conditionPanel({
    sections: SECTIONS,
    facts: { kind: 'group', text: '来份白饭' },
    switches: { disabled: ['白饭档'] },
    round: 1,
  })
  const white = p.items.find((i) => i.title === '白饭档')
  assert.equal(white.enabled, false, '★ 关了')
  assert.equal(white.hitNow, false, '★★ 关了就不算命中（否则「启用」和「命中」自相矛盾）')
  const group = p.items.find((i) => i.title === '群里')
  assert.equal(group.hitNow, true, '★ 别的没关、照常命中')
  assert.equal(p.summary.off, 1, '★ summary 要报关了几条')
})

test('★ noteHits 记录命中 → 下次 lastHitAt 有值（判据二的「上次触发」）', () => {
  const prev = { 旧的: 1 }
  const next = noteHits({ titles: ['白饭档', '群里', ''], now: 1700000000000, prev })
  assert.deepEqual(Object.keys(next).sort(), ['白饭档', '群里', '旧的'].sort(), '★ 合并进旧的，空标题不记')
  assert.equal(next['白饭档'], 1700000000000)

  const p = conditionPanel({ sections: SECTIONS, state: { lastHits: next } })
  assert.equal(p.items.find((i) => i.title === '白饭档').lastHitAt, 1700000000000)
  assert.equal(p.items.find((i) => i.title === '你是谁').lastHitAt, null)
})

test('★ 分组（面板按档渲染）+ 边界', () => {
  const p = conditionPanel({ sections: SECTIONS })
  const g = groupByTier(p.items)
  assert.equal(g.常驻.length, 1)
  assert.equal(g.条件.length, 2)
  assert.equal(g.语料.length, 1)

  // 空入参不炸
  const empty = conditionPanel({})
  assert.equal(empty.items.length, 0)
  assert.equal(empty.summary.total, 0)

  // 选择器出错时 hitNow 全 false（面板不崩）
  const bad = conditionPanel({ sections: [{ tier: '条件', title: 'x', when: '不存在的when', body: 'y' }] })
  assert.equal(bad.items[0].hitNow, false)
})
