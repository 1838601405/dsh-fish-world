// 锚点派生：生 → 判（三问）→ 留/弃。只吃「原意」文本，不读图。
import assert from 'node:assert/strict'
import test from 'node:test'
import { ROLES, USES } from '../lib/sticker-vocab.mjs'
import { actOf, deriveAnchors, explainDerive, roleSlotsOf, vocabSanity } from '../lib/sticker-annotate.mjs'

const origin = (画面, 情绪 = 'unknown', 梗 = 'unknown') => ({ 画面, 情绪, 梗 })

test('词表自检：线索表不许写出词表外的用法/立场', () => {
  const r = vocabSanity()
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('掏刀 + 朝对方 → 对你说 的 怼回去，w≥0.6，act 认得出', () => {
  const { anchors } = deriveAnchors({ origin: origin('蓝鲸娘眯眼掏出一把菜刀，朝对方杀气腾腾', '生气') })
  const uses = anchors.map((a) => a.use)
  assert.ok(uses.includes('怼回去'), JSON.stringify(anchors))
  for (const a of anchors) {
    assert.equal(a.role, '对你说')
    assert.ok(a.w >= 0.6)
    assert.equal(a.act, '掏出')
  }
})

test('抱 / 摸头 → 哄一句', () => {
  const { anchors } = deriveAnchors({ origin: origin('伸手摸头，抱了一下', '温柔') })
  assert.ok(anchors.some((a) => a.use === '哄一句'), JSON.stringify(anchors))
})

test('躺 / 趴 / 瘫 → 摆烂给他看', () => {
  const { anchors } = deriveAnchors({ origin: origin('平躺在沙发上闭眼', '累') })
  assert.ok(anchors.some((a) => a.use === '摆烂给他看'), JSON.stringify(anchors))
})

test('纯文字图：act 为 null，但仍有用法', () => {
  const { anchors } = deriveAnchors({ origin: origin('那我问你（白底黑字）', 'unknown', '聊天截图'), words: ['截图', '文字'] })
  assert.equal(actOf(origin('那我问你（白底黑字）')), null)
  assert.ok(anchors.length > 0, '纯文字图也要能出用法')
  for (const a of anchors) assert.equal(a.act, null)
})

test('原意全是 unknown → 一条都不留，并写清缺什么', () => {
  const { anchors, discarded } = deriveAnchors({ origin: origin('unknown', 'unknown', 'unknown') })
  assert.equal(anchors.length, 0)
  assert.ok(discarded.length > 0)
  assert.match(discarded[0].why, /unknown/)
})

test('词表外说法归并不了的不进库', () => {
  const { anchors, discarded } = deriveAnchors({ origin: origin('很礼貌地站着', '礼貌') })
  for (const a of anchors) assert.ok(USES.includes(a.use))
  for (const d of discarded) assert.ok(typeof d.why === 'string' && d.why.length > 0)
})

test('每条锚点的 use / role 都在封闭词表里', () => {
  const cases = [
    origin('掏刀瞪人朝对方', '生气'),
    origin('躺平摆烂', '无语'),
    origin('双手合十求饶', '慌'),
    origin('鞠躬比心道谢', '开心'),
    origin('举起彩球转圈庆祝', '兴奋'),
    origin('抱住枕头晚安睡觉', '困'),
    origin('指着屏幕催促', '得意'),
  ]
  for (const o of cases) {
    const { anchors } = deriveAnchors({ origin: o })
    for (const a of anchors) {
      assert.ok(USES.includes(a.use), 'use 不在词表：' + a.use)
      assert.ok(ROLES.includes(a.role), 'role 不在词表：' + a.role)
    }
  }
})

test('立场：没有角色位线索时只出「通用」', () => {
  const { anchors } = deriveAnchors({ origin: origin('一把菜刀放在桌上', '凶') })
  assert.ok(anchors.length > 0)
  for (const a of anchors) assert.equal(a.role, '通用')
  assert.deepEqual(roleSlotsOf(origin('一把菜刀放在桌上', '凶')), [])
})

test('同一立场冲突时只留一个，弃的写清原因', () => {
  // 画面里同时有「朝对方」和「自嘲」两种线索：立场冲突，应只保留一条并记 discarded。
  const { anchors, discarded } = deriveAnchors({ origin: origin('自嘲地躺平，朝对方比了个手势', '无奈') })
  const byUse = new Map()
  for (const a of anchors) byUse.set(a.use, (byUse.get(a.use) || 0) + 1)
  for (const [, n] of byUse) assert.equal(n, 1, '同一用法不许重复留两条')
  if (discarded.length) assert.ok(discarded.every((d) => d.why))
})

test('explainDerive 给人话', () => {
  const r = deriveAnchors({ origin: origin('掏刀朝对方', '生气') })
  const lines = explainDerive(r)
  assert.ok(lines.length > 0)
  assert.ok(lines.every((line) => line.startsWith('留：') || line.startsWith('弃：')))
})