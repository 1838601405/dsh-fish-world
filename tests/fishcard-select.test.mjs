// 鱼卡 v3 条件触发判据 —— 直接对准规格 §11 的 #2/#3/#4/#5。
//
// 选择器是纯函数（facts/state 注入），所以这些验收能脱离 QQ/文件系统单测：
//   #2 keys 未命中 → 不进（等价于「prompt 里 grep 该条 key = 0」）
//   #3 when=owner  → 群聊 0 次、私聊 1 次
//   #4 when=attachment → 发图 1 次
//   #5 连发 20 轮同话题 → 同一条注入 ≤ 2 次（cooldown）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectConditions } from '../lib/fishcard-select.mjs'

/** 造一张卡的条件节（省掉 parseCard 的样板，直接给结构）。 */
function cond(title, { keys = [], when = '', order = 100, cooldown = 0, body = '' } = {}) {
  return { tier: '条件', title, keys, when, order, cooldown, body }
}

const FRESH = () => ({ cooldowns: {} })

test('★★ 验收#2：keys 没说到就不进（等价 grep = 0）', () => {
  const sections = [cond('白饭', { keys: ['饭', '饿', '白饭'] })]
  const r = selectConditions({ sections, facts: { text: '今天好累啊' }, state: FRESH(), round: 1 })
  assert.equal(r.picked.length, 0, '★ 没提到 key 就不该进')
  assert.deepEqual(r.warnings, [])

  const hit = selectConditions({ sections, facts: { text: '我想吃白饭' }, state: FRESH(), round: 1 })
  assert.equal(hit.picked.length, 1, '★ 提到任一 key 就进')
  assert.equal(hit.picked[0].title, '白饭')
})

test('★★ 关键词扫描窗口（§3）：keys 扫最近 3–5 条，跨轮也能触发', () => {
  const sections = [cond('白饭', { keys: ['饭'] })]

  // ① 上一条提到、当前这条没说 —— 跨轮触发（这是扫描窗口存在的理由）
  const r1 = selectConditions({
    sections, state: FRESH(), round: 5,
    facts: { text: '今天想干点别的', recentTexts: ['昨天吃白饭了吗', '先聊别的', '嗯嗯', '好', '行'] },
  })
  assert.equal(r1.picked.length, 1, '★★ 当前轮没提、上一条提了 ⇒ 仍要进（跨轮触发）')

  // ② 窗口外（最近 5 条都没有）—— 不进
  const r2 = selectConditions({
    sections, state: FRESH(), round: 5,
    facts: { text: '今天想干点别的', recentTexts: ['聊游戏', '聊音乐', '聊电影', '聊天气', '聊书'] },
  })
  assert.equal(r2.picked.length, 0, '★ 窗口内没有 ⇒ 不进（窗口就是边界）')

  // ③ 当前轮有 → 进（与扫描窗口并存，不冲突）
  const r3 = selectConditions({ sections, state: FRESH(), round: 5, facts: { text: '来份白饭', recentTexts: [] } })
  assert.equal(r3.picked.length, 1, '★ 当前轮命中照样进')
})

test('★ 扫描窗口只影响 keys 命中，不改变 when 的判定', () => {
  const sections = [
    cond('对主人', { when: 'owner' }),
    cond('白饭', { keys: ['饭'], when: 'group' }),
  ]
  // keys 扫到窗口内的"饭"，但 when=group 不满足（群聊场景）⇒ 不进
  const r = selectConditions({
    sections, state: FRESH(), round: 3,
    facts: { text: '聊别的', kind: 'private', recentTexts: ['我们去吃饭吧', '好'] },
  })
  assert.equal(r.picked.length, 0, '★ keys 命中也要过 when（when 是硬条件）')
})

test('★★ 验收#3：when=owner —— 群聊 0 次、私聊 1 次', () => {
  const sections = [cond('对主人', { when: 'owner' })]
  const inGroup = selectConditions({ sections, facts: { kind: 'group', owner: false }, state: FRESH(), round: 1 })
  assert.equal(inGroup.picked.length, 0, '★ 群聊不该进 owner 档')

  const inPrivate = selectConditions({ sections, facts: { kind: 'private', owner: true }, state: FRESH(), round: 1 })
  assert.equal(inPrivate.picked.length, 1, '★ 私聊对主人要进')
})

test('★★ 验收#4：when=attachment —— 发图注入 1 次', () => {
  const sections = [cond('看到图', { when: 'attachment' })]
  const noImg = selectConditions({ sections, facts: { kind: 'private', attachment: false }, state: FRESH(), round: 1 })
  assert.equal(noImg.picked.length, 0)
  const withImg = selectConditions({ sections, facts: { kind: 'private', attachment: true }, state: FRESH(), round: 1 })
  assert.equal(withImg.picked.length, 1, '★ 带图那轮进 1 次')
})

test('★★ 验收#5：cooldown —— 20 轮同话题，同一条注入 ≤ 2 次', () => {
  const sections = [cond('白饭', { keys: ['白饭'], cooldown: 10 })]
  const state = FRESH()
  let injected = 0
  for (let round = 1; round <= 20; round++) {
    const r = selectConditions({ sections, facts: { text: '白饭白饭' }, state, round })
    if (r.picked.length) {
      injected += 1
      // 调用方回写（选择器不改入参 —— 由调用方存）
      state.cooldowns['白饭::'] = round
    }
  }
  // 第 1 轮进，之后 10 轮冷却 → 第 11 轮进 → 共 2 次
  assert.ok(injected <= 2, `★ 20 轮只该进 ≤2 次，实进 ${injected}`)
  assert.ok(injected >= 1, '至少进过一次')
})

test('★ cooldown=0（没写）→ 每轮都能进', () => {
  const sections = [cond('白饭', { keys: ['白饭'] })]
  const state = FRESH()
  let n = 0
  for (let round = 1; round <= 5; round++) {
    const r = selectConditions({ sections, facts: { text: '白饭' }, state, round })
    if (r.picked.length) { n += 1; state.cooldowns['白饭::'] = round }
  }
  assert.equal(n, 5, '★ 没写 cooldown 就不受限')
})

test('★★ 优先级：at-me > attachment > group/private > owner（规格 §3 字面）', () => {
  const sections = [
    cond('对主人', { when: 'owner' }),
    cond('在群里', { when: 'group' }),
    cond('看到图', { when: 'attachment' }),
    cond('被@了', { when: 'at-me' }),
  ]
  const facts = { kind: 'group', owner: true, atMe: true, attachment: true }
  const r = selectConditions({ sections, facts, state: FRESH(), round: 1 })
  const titles = r.picked.map((s) => s.title)
  assert.deepEqual(titles, ['被@了', '看到图', '在群里'], '★ 具体的排前面；owner 被 group 挤掉（字面顺序）')
})

test('★ 同轮最多 3 条（规格 §3）', () => {
  const sections = [
    cond('a', { when: 'at-me', order: 1 }),
    cond('b', { when: 'attachment', order: 2 }),
    cond('c', { when: 'group', order: 3 }),
    cond('d', { when: 'owner', order: 4 }),
    cond('e', { when: 'named', order: 5 }),
  ]
  const r = selectConditions({ sections, facts: { kind: 'group', owner: true, atMe: true, attachment: true, named: true }, state: FRESH(), round: 1 })
  assert.equal(r.picked.length, 3, '★ 最多 3 条')
  assert.equal(r.warnings.some((w) => /只进前 3 条/.test(w)), true, '★ 丢了要报')
})

test('★ 场景档 ≤5，超出时只留前 5（规格 §3）', () => {
  // ★ 全用 group：facts.kind='group' 时 8 条**都命中**，才真的超出上限
  //   （第一版按奇偶分 group/private，只有 4 条命中、压根没触发上限）。
  //   链路是 8 命中 → 场景裁到 5 → 再截到 3，所以看得到的是**两条警告都发了**。
  const sections = Array.from({ length: 8 }, (_, i) => cond(`场景${i}`, { when: 'group', order: i }))
  const r = selectConditions({ sections, facts: { kind: 'group' }, state: FRESH(), round: 1 })
  assert.ok(r.warnings.some((w) => /超过上限 5/.test(w)), '★ 场景档超 5 要报：' + r.warnings.join(' | '))
  assert.ok(r.warnings.some((w) => /只进前 3 条/.test(w)), '★ 截到 3 条也要报')
  assert.ok(r.picked.length <= 3, `★ 最终 ≤3，实为 ${r.picked.length}`)
  assert.ok(r.picked.every((s) => s.when), '★ 留下的都是场景档')
})

test('★ 未识别的 when → 不选且报（不静默丢）', () => {
  const sections = [cond('怪档', { when: 'weather' })]
  const r = selectConditions({ sections, facts: { kind: 'group', text: 'x' }, state: FRESH(), round: 1 })
  assert.equal(r.picked.length, 0, '★ 未识别不注入')
  // matched 对未识别返回 ''（不命中）；这里断言「没进」即可，警告由解析层负责报
})

test('★ 空入参不炸', () => {
  for (const input of [{}, { sections: [] }, { sections: null, facts: null }]) {
    const r = selectConditions(input)
    assert.equal(r.picked.length, 0)
    assert.ok(Array.isArray(r.warnings))
  }
})

test('★ 选择器不改入参 state（回写由调用方负责）', () => {
  const sections = [cond('白饭', { keys: ['白饭'], cooldown: 10 })]
  const state = FRESH()
  selectConditions({ sections, facts: { text: '白饭' }, state, round: 1 })
  assert.deepEqual(state, { cooldowns: {} }, '★ state 必须原样（不然调用方没法自己管）')
})
