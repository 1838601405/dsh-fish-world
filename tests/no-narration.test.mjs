// 去掉解说体判据（2026-11-21 主人要求）。
//
// 现象（真机）：她不评价了，改成解说 ——
//   · 注释别人发的东西（「把 MyGO 写成克苏鲁了」「沙耶之歌那个设定是…」）
//   · 查出处/发链接（[这里有一版](…)）
//   · 认错后补自我复盘 + 承诺（「懂了，以后不评了」）
//   · 技术报告腔（「返回 200」「star 都 5969 了」）
//   · 金句体（「思念能穿越时间，但见到的只是…」）
//
// 根因：她把「我理解了」输出成了「我来讲讲这是什么」。
//       理解是自己的，解说是在给观众讲 —— 而群里没有观众。
//
// 三层：人设（正向锚定）/ 上下文（只放现场）/ 执行层（兜底）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  GATE_KIND,
  buildRewriteInstruction,
  judgeReply,
  runExecutionGate
} from '../lib/execution-gate.mjs'

const PERSONA = 'D:/DSH-home/fish-world-personas/default.md'

// ══════════ 一、人设：正向锚定（不列禁词）══════════

test('★ 人设里有「认出对方在玩什么就反手接一句」的正向锚定', () => {
  const t = readFileSync(PERSONA, 'utf8')
  assert.match(t, /认出对方在玩什么/, '要有「认出在玩什么」')
  assert.match(t, /反手接一句/, '要有「反手接一句」')
})

test('★ 人设里说清「一句话够了」和「不确定出处就问」', () => {
  const t = readFileSync(PERSONA, 'utf8')
  // ★ 2026-11-24 换卡 ⇒ **语义等价任一命中**（方案 A）：
  //   新卡写的是「一个字能说完的，我不写两句」（= 一句话够了）、
  //   「不确定出处我就问『这是哪的』」（多一个「就」字）—— 同一件事、措辞不同，不该算缺。
  assert.match(t, /一句话够了|一句话就行|一个字能说完/, '要说明一句话够了（不补设定）')
  assert.match(t, /不确定出处就问|不确定出处我就问|不确定[^，。；\n]{0,8}问/, '要说明不确定就问')
})

test('★★ 人设里不列解说体的禁词（语义引力井）', () => {
  const t = readFileSync(PERSONA, 'utf8')
  // 这些是"不该做什么"的说法，一个都不该出现在她每轮读的文本里
  const banned = [
    '不要解说',
    '别解释',
    '不要补设定',
    '不许发链接',
    '不要说「这不就是」'
  ]
  const found = banned.filter((b) => t.includes(b))
  assert.deepEqual(found, [],
    '★ 人设里不许列禁词清单（会形成引力井）：' + JSON.stringify(found))
})

// ══════════ 二、上下文：只放现场，不放方法论 ══════════

test('★★ 上下文里没有「合起来回应」「说句话回应一下」这类指令', () => {
  const src = readFileSync('lib/qq-inbox.mjs', 'utf8')
  // 这些会让她把「完成回应任务」当成目标 → 于是做解说
  const banned = [
    '合起来回应',
    '别逐条回',
    '说句话回应一下',
    '别回应这些人'
  ]
  const found = banned.filter((b) => src.includes(b))
  assert.deepEqual(found, [],
    '★ 这些是"完成任务"的指令，会催生解说：' + JSON.stringify(found))
})

test('上下文改成只陈述事实（谁在说 / 还有别人在聊）', () => {
  const src = readFileSync('lib/qq-inbox.mjs', 'utf8')
  assert.match(src, /在说话/, '要说明谁在说话')
  assert.match(src, /还有别人在聊/, '要说明旁边还有别人')
})

// ══════════ 三、执行层：四类新闸 ══════════

test('闸 4 解说体：「把 X 写成 Y 了」', () => {
  const r = judgeReply('把 MyGO 写成克苏鲁了')
  assert.equal(r.ok, false)
  assert.ok(r.kinds.includes(GATE_KIND.NARRATION), '要标 narration')
})

test('闸 4 解说体：「X 那个设定是…」', () => {
  for (const t of ['沙耶之歌那个设定是虚渊玄写的', '这个设定其实是致敬']) {
    const r = judgeReply(t)
    assert.equal(r.ok, false, '要拦：' + t)
    assert.ok(r.kinds.includes(GATE_KIND.NARRATION))
  }
})

test('闸 4 解说体：markdown 链接 / 裸链接（考据）', () => {
  for (const t of ['[这里有一版](https://example.com/a)', '看这里 https://github.com/x/y']) {
    const r = judgeReply(t)
    assert.equal(r.ok, false, '要拦链接：' + t)
    assert.ok(r.kinds.includes(GATE_KIND.NARRATION))
  }
})

test('★ 闸 4 不误杀「这不就是沙耶之歌」（点破出处是允许的）', () => {
  // 主人明确要求：认出出处就直接点破 —— 那是好的
  const r = judgeReply('这不就是沙耶之歌')
  assert.equal(r.ok, true, '★ 点破出处不许拦：' + JSON.stringify(r.kinds))
})

test('★ 闸 4 的「这不就是…吗」只拦带「吗」的解释句', () => {
  // 带「吗」= 在给别人解释；不带 = 直接点破
  const bad = judgeReply('这不就是那种把梗写歪了的吗')
  assert.equal(bad.ok, false, '带「吗」的解释句要拦')
})

test('闸 5 承诺：认错后补「以后不…」', () => {
  for (const t of ['懂了，以后不评了', '行吧，以后不说这些', '明白了，下次不会']) {
    const r = judgeReply(t)
    assert.equal(r.ok, false, '★ 承诺要拦：' + t)
    assert.ok(r.kinds.includes(GATE_KIND.COMMITMENT))
  }
})

test('★ 闸 5 不误杀正常的「懂了」「行吧」', () => {
  for (const t of ['懂了', '行吧', '知道了', '好']) {
    assert.equal(judgeReply(t).ok, true, '★ 单独认错不许拦：' + t)
  }
})

test('闸 6 技术报告腔', () => {
  for (const t of ['返回 200', 'star 都 5969 了', '耗时 300ms']) {
    const r = judgeReply(t)
    assert.equal(r.ok, false, '要拦：' + t)
    assert.ok(r.kinds.includes(GATE_KIND.TECH_REPORT))
  }
})

test('★ 闸 6 不误杀「能，我试了」（主人的正解）', () => {
  assert.equal(judgeReply('能，我试了').ok, true, '★ 这是正解，不许拦')
})

test('闸 7 金句体：转折 + 抽象词的单句', () => {
  const r = judgeReply('思念能穿越时间，但见到的只是影子')
  assert.equal(r.ok, false, '金句要拦')
  assert.ok(r.kinds.includes(GATE_KIND.GOLDEN_LINE))
})

test('★ 闸 7 不误杀普通短句', () => {
  for (const t of ['好', '睡吧', '白饭', '6', '草', '我不知道', '这样啊', '那你怎么擦的']) {
    assert.equal(judgeReply(t).ok, true, '不许拦：' + t)
  }
})

test('★ 闸 7 不误杀「有转折但不抽象」的正常话', () => {
  // 有「但」但没抽象词 → 不是金句
  assert.equal(judgeReply('我想睡但还没洗澡').ok, true, '普通陈述不许拦')
})

// ══════════ 重写指令：三选一（接梗 / 点破 / 问一句）══════════

test('★★ 重写指令给的是「接梗 / 点破出处 / 问一句」', () => {
  const ins = buildRewriteInstruction()
  assert.match(ins, /接住他那个梗/, '要有「接梗」')
  assert.match(ins, /点破/, '要有「点破出处」')
  assert.match(ins, /这是哪的/, '要有「问一句」')
})

test('★★ 重写指令不列禁词、不引用原句', () => {
  const original = '把 MyGO 写成克苏鲁了，沙耶之歌那个设定是…'
  const ins = buildRewriteInstruction({ original })
  // 不许出现禁词
  for (const b of ['不要说', '别解释', '禁止', '不许']) {
    assert.equal(ins.includes(b), false, '★ 指令里不许有禁词：' + b)
  }
  // 不许引用原句片段
  for (const frag of ['MyGO', '克苏鲁', '沙耶']) {
    assert.equal(ins.includes(frag), false, '★ 不许把原句念一遍：' + frag)
  }
})

// ══════════ 流程：命中→重写→兜底 ══════════

test('解说体命中 → 要求重写（不是直接丢）', () => {
  const r = runExecutionGate({ text: '把 MyGO 写成克苏鲁了', attempt: 0 })
  assert.equal(r.action, 'rewrite')
  assert.ok(r.instruction)
})

test('重写后合格 → 正常发', () => {
  const r = runExecutionGate({ text: '这不就是沙耶之歌', attempt: 1 })
  assert.equal(r.action, 'send')
})

test('★ 重写仍不合格 → 最短反应兜底', () => {
  const r = runExecutionGate({ text: '把 MyGO 写成克苏鲁了', attempt: 1, seed: 0 })
  assert.equal(r.action, 'fallback')
  assert.equal(r.fellBack, true)
})

// ══════════ 验收 a-e 对应 ══════════

test('a) 「沙耶之歌公式宇宙」：解释沙耶之歌是什么 → 拦', () => {
  assert.equal(judgeReply('沙耶之歌那个设定是虚渊玄写的').ok, false)
  // 但接一句同格式的 → 放
  assert.equal(judgeReply('那你就是沙耶了').ok, true, '★ 接同格式的不许拦')
})

test('b) 主人发 MyGO 整活 → 「这不就是沙耶之歌」放行，不补设定', () => {
  assert.equal(judgeReply('这不就是沙耶之歌').ok, true, '★ 点破出处是正解')
  // 补设定就拦
  assert.equal(judgeReply('这不就是沙耶之歌吗，那个设定是虚渊玄写的').ok, false)
})

test('c) 被指出太爱评价 → 换口气接梗（不说「我改」）', () => {
  assert.equal(judgeReply('懂了，以后不评了').ok, false, '★ 承诺要拦')
  assert.equal(judgeReply('草，那我就是克苏鲁').ok, true, '★ 换口气接梗要放行')
})

test('d) 群聊回复里不出现 markdown 链接', () => {
  assert.equal(judgeReply('[这里有一版](https://example.com)').ok, false)
})

test('e) 技术类提问 → 「能，我试了」放行；「返回 200」拦', () => {
  assert.equal(judgeReply('能，我试了').ok, true)
  assert.equal(judgeReply('返回 200').ok, false)
})
