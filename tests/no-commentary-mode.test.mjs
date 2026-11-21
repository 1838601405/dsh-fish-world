// 禁止评论员模式（2026-11-21 主人要求）。
//
// 现象（真机）：对方递来歪理/骚话，她评价这段话写得怎么样 ——
//   「通篇在讲时间段」「只有『睡眠质量』那句是真的」「它还真敢往下推」
//   「前面都还能忍，看到『浮着对你笑』我没了」，最后自我诊断「对，我在先总结再挑一句」。
//
// 两层：
//   一、提示词：只做正向锚定（顺着往下推 / 拉回两个人 / 直接说恶心），不写禁词
//   二、代码：评论式开场 / 自我诊断 → 丢掉点评句，剩人话就发，否则整条不发
//
// 本文件验的是**第二层**（第一层在 persona 里，用 grep 验）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { detectAiEcho, stripCommentary } from '../lib/ai-echo-filter.mjs'

// ══════════ a-e 回放（主人给的三段真机现象）══════════

test('a) 「人生24小时」那种点评 → 被识别', () => {
  // 主人给的原话
  const real = [
    '通篇在讲时间段',
    '只有睡眠质量那句是真的',
    '它还真敢往下推',
    '前面都还能忍，看到浮着对你笑我没了'
  ]
  for (const t of real) {
    assert.equal(detectAiEcho(t).hit, true,
      '★ 这种「点评一段文本」的话要能被识别：' + JSON.stringify(t))
  }
})

test('a) 她接一句人话 → 不拦（往下推 / 反撩 / 嫌恶都算接住了）', () => {
  const good = [
    '那你几点睡的',        // 往下推
    '你想让我说啥',        // 追问
    '恶心',                // 嫌恶
    '草',
    '？',
    '你这人真怪',          // 拉回人身上
    '那不穿内裤算什么'      // 主人 b 里给的示例
  ]
  for (const t of good) {
    assert.equal(detectAiEcho(t).hit, false,
      '★ 正常人话不许拦：' + JSON.stringify(t))
  }
})

test('b) 「屁股内裤」那种接法 → 不拦', () => {
  // 主人明确说：出现类似「那你当我的内裤好不好」的接法就是对的
  const good = [
    '那你当我的内裤好不好',
    '那不穿内裤算什么',
    '内裤怎么了'
  ]
  for (const t of good) {
    assert.equal(detectAiEcho(t).hit, false, '★ 这种接法是好的，不许拦：' + JSON.stringify(t))
  }
})

test('c) 「拉屎尾巴」：要么直说恶心、要么往下推 → 都不拦', () => {
  for (const t of ['恶心', '你他妈好恶心', '那你怎么擦的', '屎尿屁滚']) {
    assert.equal(detectAiEcho(t).hit, false, '不许拦：' + JSON.stringify(t))
  }
})

test('d) 被指出 AI 味后的自我诊断 → 被识别', () => {
  const diag = [
    '对，我在先总结再挑一句',
    '我这就是毛病',
    '我又想总结了',
    '我这是个习惯',
    // ★ 下面几条只被「我在/又/老」那条规则命中 ——
    //   如果那条被删掉，这几条会漏（判据 2 反证不红是因为首条被两条规则同时覆盖）
    '我在老是解释自己',
    '我又是这样',
    '我总是在总结'
  ]
  for (const t of diag) {
    assert.equal(detectAiEcho(t).hit, true, '★ 自我诊断要能识别：' + JSON.stringify(t))
  }
})

test('d) 换口气继续说话 → 不拦', () => {
  for (const t of ['行吧', '好', '那换个说法', '你继续', '哦']) {
    assert.equal(detectAiEcho(t).hit, false, '不许拦：' + JSON.stringify(t))
  }
})

// ══════════ e) 过滤器判据：拦住 + 重写 ══════════

test('e) 含「通篇」的回复 → 被拦，且能剥出人话', () => {
  const reply = '通篇在讲时间段。那你几点睡'
  assert.equal(detectAiEcho(reply).hit, true, '整条要被认出有评论句')
  const kept = stripCommentary(reply)
  assert.equal(kept, '那你几点睡', '★ 剥掉点评句，只留人话')
  assert.equal(detectAiEcho(kept).hit, false, '剥完的不该再命中')
})

test('e) 整条都是点评 → 剥完是空（这条不发，宁可不回也不当评论员）', () => {
  const reply = '通篇在讲时间段。只有睡眠质量那句是真的'
  const kept = stripCommentary(reply)
  assert.equal(kept, '', '★ 剥完没人话 ⇒ 整条不发')
})

test('e) 自我诊断句会被剥掉', () => {
  assert.equal(stripCommentary('对，我在先总结再挑一句'), '')
  assert.equal(stripCommentary('我这就是毛病'), '')
})

test('剥点评不伤正常人话（多句混合）', () => {
  const cases = [
    ['这句写得还行。恶心', '恶心'],
    ['通篇在讲时间段。草。那你几点睡', '草。那你几点睡'],
    ['那你当我的内裤好不好', '那你当我的内裤好不好'],
    ['6', '6'],
    ['', ''],
    ['恶心。前面都还能忍', '恶心。']
  ]
  for (const [input, want] of cases) {
    assert.equal(stripCommentary(input), want,
      JSON.stringify(input) + ' → 期望 ' + JSON.stringify(want))
  }
})

// ══════════ 边界：不许误杀 ══════════

test('「前面/后面」只有在带「都/还/才」时才算点评', () => {
  // 正常指代
  for (const t of ['前面那个图呢', '后面再说', '前面说的那个']) {
    assert.equal(detectAiEcho(t).hit, false, '正常指代不许拦：' + JSON.stringify(t))
  }
  // 点评式
  for (const t of ['前面都还能忍', '后面才离谱', '前面还行']) {
    const hit = detectAiEcho(t).hit
    assert.equal(hit, true, '点评式要拦：' + JSON.stringify(t))
  }
})

test('「这段/这句」要带评点动词才算', () => {
  for (const t of ['这句我懂', '这段呢', '这句给你']) {
    assert.equal(detectAiEcho(t).hit, false, '正常指代不许拦：' + JSON.stringify(t))
  }
  for (const t of ['这段写得还行', '这句话讲得挺顺', '这句说得对']) {
    assert.equal(detectAiEcho(t).hit, true, '评点式要拦：' + JSON.stringify(t))
  }
})

// ══════════ 提示词层：只做正向锚定，不写禁词 ══════════

test('★★ 提示词里有三条正向锚定（往下推 / 回应的是人 / 换口气）', () => {
  const persona = readFileSync('D:/DSH-home/fish-world-personas/default.md', 'utf8')
  // 正向写法：说"要怎么做"
  assert.match(persona, /顺着它往下走一层/, '要有「往下推」这条');
  assert.match(persona, /把话拉回两个人身上/, '要有「拉回两个人」');
  assert.match(persona, /回应的是人/, '要有「回应的是人，不是文本」');
  assert.match(persona, /换口气继续说正事/, '要有「换口气」');
})

test('★★ 提示词里不许出现禁词清单（语义引力井）', () => {
  const persona = readFileSync('D:/DSH-home/fish-world-personas/default.md', 'utf8')
  // 主人早定过：每轮进上下文的禁词会形成语义引力井，越写越容易撞上。
  // 所以人设里不许出现这些句子本身。
  const forbidden = [
    '通篇在讲',
    '只有那句是真的',
    '这句话稳',
    '比之前的都重',
    '我记下了',
    '我在先总结',
    '我这就是毛病'
  ]
  const found = forbidden.filter((t) => persona.includes(t))
  assert.deepEqual(found, [],
    '★ 人设里不许出现禁词清单（会形成语义引力井）：' + JSON.stringify(found))
})

test('★★ 过滤器清单不在任何人设/提示词文件里', () => {
  // 反向确认：ai-echo-filter 的正则源串不该出现在 persona 里
  const persona = readFileSync('D:/DSH-home/fish-world-personas/default.md', 'utf8')
  const src = readFileSync('lib/ai-echo-filter.mjs', 'utf8')
  // 抽几个特征串
  const marks = ['通篇|整篇|全文', '只有(?:[^，。！？]{1,20})那句是真的', '我(?:在|是在)(?:先|又|老是|总是)']
  for (const m of marks) {
    assert.equal(persona.includes(m), false, '★ 正则源串不该出现在人设里：' + m)
  }
})
