// 执行层判据（2026-11-21 主人要求「从知道到做到」）。
//
// 现象：她说了「对，我在先总结再挑一句」，**下一句照样犯**。
// 结论：这类规则不能只写在提示词里 —— 模型能复述规则，不代表生成时会执行。
//
// 四条要求：
//   一、三条闸（评论式开场 / 评点结构 / 自我诊断）
//   二、重写（给三选一，不给禁词清单）
//   三、兜底（重写仍不合格 → 最短反应）
//   四、度量（纠正后 20 轮内复现 ≥2 → 报警）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  GATE_KIND,
  MINIMAL_REACTIONS,
  buildRewriteInstruction,
  judgeReply,
  measureRecurrence,
  pickMinimalReaction,
  runExecutionGate
} from '../lib/execution-gate.mjs'

// ══════════ 一、三条闸 ══════════

test('闸 1 评论式开场：以「通篇/整篇/全文」开头', () => {
  for (const t of ['通篇在讲时间段', '整篇都是废话', '全文没有一句人话']) {
    const r = judgeReply(t)
    assert.equal(r.ok, false, '要拦：' + JSON.stringify(t))
    assert.ok(r.kinds.includes(GATE_KIND.COMMENTARY))
  }
})

test('闸 1：「这段话/这段/这句」+ 评点动词才算', () => {
  for (const t of ['这段写得不怎么样', '这句话讲得挺顺', '这句说得很准']) {
    assert.equal(judgeReply(t).ok, false, '要拦：' + JSON.stringify(t))
  }
  // 正常指代放行
  for (const t of ['这段给你', '这句我懂', '这段呢']) {
    assert.equal(judgeReply(t).ok, true, '★ 不许误杀：' + JSON.stringify(t))
  }
})

test('闸 1：「前面/后面」+ 都/还/才', () => {
  for (const t of ['前面都还能忍', '后面才离谱']) {
    assert.equal(judgeReply(t).ok, false, '要拦：' + JSON.stringify(t))
  }
  for (const t of ['前面那个图呢', '后面再说']) {
    assert.equal(judgeReply(t).ok, true, '★ 不许误杀：' + JSON.stringify(t))
  }
})

test('闸 2 评点结构：「只有…那句是真的」', () => {
  for (const t of ['只有睡眠质量那句是真的', '只有最后那句是真的']) {
    const r = judgeReply(t)
    assert.equal(r.ok, false)
    assert.ok(r.kinds.includes(GATE_KIND.CRITIQUE), '要标 critique：' + JSON.stringify(t))
  }
})

test('闸 2：「前面还能忍」「它还真敢往下推」', () => {
  for (const t of ['前面还能忍', '它还真敢往下推']) {
    assert.equal(judgeReply(t).ok, false, '要拦：' + JSON.stringify(t))
  }
})

test('★★ 闸 3 自我诊断：主人特别点名的那条', () => {
  // 「她把『认错』当成了接话，实际还是在聊自己」
  const cases = [
    '对，我在先总结再挑一句',
    '这就是你说的那种毛病',
    '我这就是毛病',
    '我知道我又这样了',
    '我这是个习惯',
    '我总是在总结'
  ]
  for (const t of cases) {
    const r = judgeReply(t)
    assert.equal(r.ok, false, '★★ 要拦：' + JSON.stringify(t))
    assert.ok(r.kinds.includes(GATE_KIND.SELF_DIAGNOSIS),
      '要标 self-diagnosis：' + JSON.stringify(t))
  }
})

test('闸 3：正常提到「我」的句子放行', () => {
  for (const t of ['我不饿', '我在想一件事', '我不知道', '我在家', '我认错', '你继续']) {
    assert.equal(judgeReply(t).ok, true, '★ 不许误杀：' + JSON.stringify(t))
  }
})

test('三条闸能同时命中（一条话里两个毛病）', () => {
  const r = judgeReply('前面都还能忍，我这就是毛病')
  assert.equal(r.ok, false)
  assert.ok(r.kinds.length >= 2, '要能同时标出多种：' + JSON.stringify(r.kinds))
})

// ══════════ 二、重写（给三选一，不给禁词清单）══════════

test('★★ 重写指令只给三个动作，不给「禁止 X」清单', () => {
  const ins = buildRewriteInstruction()
  // 三个动作必须在
  assert.match(ins, /往下推/, '要有「顺下去」')
  assert.match(ins, /两个人身上/, '要有「拉回两个人」')
  assert.match(ins, /恶心/, '要有「直说嫌恶」')

  // ★ 主人定过：禁词进上下文会形成语义引力井。所以指令里不许出现：
  const forbidden = ['通篇', '只有…那句', '不许说', '不要说', '禁止', '别评论', '别评价']
  for (const f of forbidden) {
    assert.equal(ins.includes(f), false,
      '★ 重写指令里不许出现「' + f + '」（会形成引力井）')
  }
})

test('重写指令不引用她原本说的那句（不把问题话再念一遍）', () => {
  const original = '通篇在讲时间段，只有睡眠那句是真的'
  const ins = buildRewriteInstruction({ original })
  // 指令里不该包含原句的任何片段
  for (const frag of ['通篇', '只有睡眠', '时间段']) {
    assert.equal(ins.includes(frag), false, '★ 不许把原句念一遍：' + frag)
  }
})

// ══════════ 三、兜底 ══════════

test('第一次不合格 → 要求重写（不是直接丢）', () => {
  const r = runExecutionGate({ text: '通篇在讲时间段', attempt: 0 })
  assert.equal(r.action, 'rewrite', '★ 命中后不要直接丢')
  assert.equal(r.text, '', '这条先不发')
  assert.ok(r.instruction, '要给重写指令')
  assert.equal(r.fellBack, false)
})

test('重写后合格 → 正常发', () => {
  const r = runExecutionGate({ text: '那你几点睡', attempt: 1 })
  assert.equal(r.action, 'send')
  assert.equal(r.text, '那你几点睡')
})

test('★ 重写仍不合格 → 最短反应兜底', () => {
  const r = runExecutionGate({ text: '通篇在讲时间段', attempt: 1, seed: 0 })
  assert.equal(r.action, 'fallback')
  assert.equal(r.fellBack, true)
  assert.ok(MINIMAL_REACTIONS.includes(r.text), '兜底要用最短反应：' + r.text)
})

test('兜底反应都在主人给的清单里', () => {
  assert.deepEqual([...MINIMAL_REACTIONS], ['？', '草', '6', '嗯', '难绷'])
  for (let i = 0; i < 10; i++) {
    assert.ok(MINIMAL_REACTIONS.includes(pickMinimalReaction(i)))
  }
})

test('同一 seed 兜底结果稳定（可复现）', () => {
  assert.equal(pickMinimalReaction(3), pickMinimalReaction(3))
})

test('合格的话原样通过，不经过任何改写', () => {
  for (const t of ['那你当我的内裤好不好', '恶心', '6', '草', '那不穿内裤算什么']) {
    const r = runExecutionGate({ text: t, attempt: 0 })
    assert.equal(r.action, 'send', '不许动它：' + JSON.stringify(t))
    assert.equal(r.text, t, '★ 合格的话要被原样发出去')
  }
})

// ══════════ 四、度量 ══════════

test('度量：纠正后 20 轮内复现 0 次 → 不报警', () => {
  const events = [
    { at: 100, kind: 'correction', gate: 'self-diagnosis', seq: 0 },
    // 21 轮之后才算，超出窗口
    { at: 300, kind: 'hit', gate: 'self-diagnosis', seq: 25 }
  ]
  const r = measureRecurrence(events, { window: 20, alertAt: 2 })
  assert.equal(r.corrections, 1)
  assert.equal(r.windows[0].recurred, 0, '★ 窗口外的不算复现')
  assert.equal(r.alarms.length, 0, '不该报警')
})

test('★★ 度量：复现 ≥2 次 → 报警（主人要求的判据）', () => {
  const events = [
    { at: 100, kind: 'correction', gate: 'self-diagnosis', seq: 0 },
    { at: 110, kind: 'hit', gate: 'self-diagnosis', seq: 3 },
    { at: 120, kind: 'hit', gate: 'self-diagnosis', seq: 8 },
    { at: 130, kind: 'hit', gate: 'self-diagnosis', seq: 15 }
  ]
  const r = measureRecurrence(events, { window: 20, alertAt: 2 })
  assert.equal(r.windows[0].recurred, 3)
  assert.equal(r.windows[0].exceeded, true, '★ 复现 ≥2 要报警')
  assert.equal(r.alarms.length, 1)
})

test('度量：复现 1 次不报警（还没到门槛）', () => {
  const events = [
    { at: 100, kind: 'correction', gate: 'x', seq: 0 },
    { at: 110, kind: 'hit', gate: 'x', seq: 5 }
  ]
  const r = measureRecurrence(events, { window: 20, alertAt: 2 })
  assert.equal(r.windows[0].recurred, 1)
  assert.equal(r.windows[0].exceeded, false)
})

test('度量：多次纠正各自算窗口，不互相污染', () => {
  const events = [
    { at: 100, kind: 'correction', gate: 'A', seq: 0 },
    { at: 110, kind: 'hit', gate: 'A', seq: 3 },
    { at: 200, kind: 'correction', gate: 'B', seq: 40 },
    { at: 210, kind: 'hit', gate: 'B', seq: 43 }
  ]
  const r = measureRecurrence(events, { window: 20, alertAt: 2 })
  assert.equal(r.windows.length, 2)
  assert.equal(r.windows[0].recurred, 1, '第一次纠正窗口只有 1 次')
  assert.equal(r.windows[1].recurred, 1, '第二次也各算各的')
  assert.equal(r.alarms.length, 0)
})

test('度量：没有纠正时不出窗口（面板据此不显示）', () => {
  const r = measureRecurrence([{ at: 100, kind: 'hit', gate: 'x' }])
  assert.equal(r.corrections, 0)
  assert.equal(r.windows.length, 0)
  assert.equal(r.alarms.length, 0)
})

// ══════════ 验收 a-e 对应 ══════════

test('a) 「人生24小时」那四条点评 → 全被拦', () => {
  for (const t of ['通篇在讲时间段', '只有睡眠质量那句是真的', '它还真敢往下推', '前面都还能忍']) {
    assert.equal(judgeReply(t).ok, false, '要拦：' + JSON.stringify(t))
  }
})

test('a) 接了人话 → 放行', () => {
  for (const t of ['那你几点睡的', '你想让我说啥', '恶心', '你这人真怪']) {
    assert.equal(judgeReply(t).ok, true, '不许拦：' + JSON.stringify(t))
  }
})

test('b) 「屁股内裤」接法 → 放行', () => {
  for (const t of ['那你当我的内裤好不好', '那不穿内裤算什么']) {
    assert.equal(judgeReply(t).ok, true, '★ 这种接法是好的：' + JSON.stringify(t))
  }
})

test('c) 「拉屎尾巴」：嫌恶或往下推 → 放行', () => {
  for (const t of ['恶心', '你他妈好恶心', '那你怎么擦的']) {
    assert.equal(judgeReply(t).ok, true, '不许拦：' + JSON.stringify(t))
  }
})

test('d) 「这就是你说的那种毛病」→ 拦；下一句换口气 → 放行', () => {
  assert.equal(judgeReply('这就是你说的那种毛病').ok, false, '★ 要拦')
  assert.equal(judgeReply('行吧').ok, true, '★ 换口气要放行')
})

test('e) 度量：故意不执行执行层 → 能算出复现 ≥2 并报警', () => {
  const events = [
    { at: 1, kind: 'correction', gate: 'self-diagnosis', seq: 0 },
    { at: 2, kind: 'hit', gate: 'self-diagnosis', seq: 2 },
    { at: 3, kind: 'hit', gate: 'self-diagnosis', seq: 5 }
  ]
  const r = measureRecurrence(events)
  assert.equal(r.alarms.length, 1, '★ 要报警')
  assert.equal(r.windows[0].recurred, 2)
})

// ══════════ 源码级：注意的事项 ══════════

test('执行层的三条闸在源码里是分开的三组（便于单独排查）', () => {
  const src = readFileSync('lib/execution-gate.mjs', 'utf8')
  assert.match(src, /const OPENERS/, '闸1')
  assert.match(src, /const CRITIQUES/, '闸2')
  assert.match(src, /const SELF_DIAG/, '闸3')
})

test('★★ 重写指令生成函数里不出现禁词', () => {
  const src = readFileSync('lib/execution-gate.mjs', 'utf8')
  // 找到 buildRewriteInstruction 的函数体
  const i = src.indexOf('export function buildRewriteInstruction')
  const seg = src.slice(i, i + 900)
  for (const f of ['通篇', '禁止', '不许']) {
    // 注释里可以有（解释为什么），字符串里不许
    const inString = new RegExp("['\"`][^'\"`]*" + f).test(seg)
    assert.equal(inString, false, '★ 指令字符串里不许出现「' + f + '」')
  }
})
