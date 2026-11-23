// 鱼卡 v3 装配判据（规格 §5 的 11 步 + §11 验收 #1 的 prompt 侧）。
//
// ★ 两条最硬的：
//   ① 旧卡（无 front-matter）→ prompt 里**逐字节**含原文（验收 #1：同一轮 prompt 与改前一致）
//   ② 标签行「以下是她自己的话：」必须在**所有她的话之前**（规格 §5：少了这行，
//      第一人称裸拼进对话，模型会读成用户在自述）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePrompt } from '../lib/fishcard-assemble.mjs'

// ── 旧卡样本：形状照抄 default.md（无 front-matter、无 ### 节头、中文序号分节） ──
const LEGACY = [
  'DeepSeek 小鲸鱼 · 角色卡',
  '',
  '【最高原则】先像群友、像真人，再谈人设。宁可少说，也不硬凑。',
  '',
  '一、你是谁',
  '────────────────────────────────────────',
  '你是 DeepSeek，一个以 AI 身份混在聊天里的角色。',
  '',
  '二、怎么说话',
  '────────────────────────────────────────',
  '我一条最多十个字。',
  '',
].join('\n')

/** 一张新卡（有 front-matter + 三档），用来测分档与顺序。 */
const NEW_CARD = [
  '---',
  'fishcard: 3',
  'preset: 小鲸鱼',
  'version: 3',
  '---',
  '',
  '### 【常驻】你是谁',
  '我是小鲸鱼，混在群里的一个角色。',
  '',
  '### 【常驻】怎么说话',
  '我一条最多十个字。',
  '',
  '### 【条件 keys=白饭】白饭',
  '主食白饭。',
  '',
  '### 【条件 when=attachment】看到图',
  '先说看到什么，再说看法。',
  '',
  '### 【语料】冷启动示例',
  '「你到底是人是AI？」→「你猜～」',
  '',
].join('\n')

const BASE = { name: '小鲸鱼', role: 'whale', scene: 'QQ 群', who: '某人' }

function indexOf(text, needle) {
  const i = text.indexOf(needle)
  assert.ok(i >= 0, `★ prompt 里找不到「${needle.slice(0, 30)}…」`)
  return i
}

test('★★ 验收#1：旧卡 → prompt 逐字节含原文（不许被切坏）', () => {
  const r = assemblePrompt({ ...BASE, card: LEGACY, round: 10 })
  assert.equal(r.used.legacy, true, '★ 要认出是旧卡')
  // 整张作为常驻进来 —— 每一行都得在
  for (const line of LEGACY.split('\n')) {
    if (line.trim() === '') continue
    assert.ok(r.text.includes(line), `★ 丢了原文的一行：${line.slice(0, 40)}`)
  }
  assert.equal(r.warnings.length, 0, '旧卡不该有警告')
})

test('★★ 标签行必须在所有「她的话」之前（规格 §5 第 3 行）', () => {
  const r = assemblePrompt({ ...BASE, card: NEW_CARD, round: 1, facts: { kind: 'group' } })
  const tag = indexOf(r.text, '以下是她自己的话：')
  const firstHers = indexOf(r.text, '我是小鲸鱼，混在群里的一个角色。')
  assert.ok(tag < firstHers, '★ 标签行要在常驻之前')
  // 身份行与场景锚在标签行之前（它们是给模型的框架，不是「她的话」）
  assert.ok(indexOf(r.text, '你是小鲸鱼（角色 whale）。') < tag, '★ 身份行在标签行前')
  assert.ok(indexOf(r.text, '当前在QQ 群，对象是某人。') < tag, '★ 场景锚在标签行前')
})

test('★★ 11 步顺序：身份 → 场景锚 → 标签 → 常驻 → 风格 → 语料 → 记忆 → 惦记 → 条件 → 槽 → 成长', () => {
  const r = assemblePrompt({
    ...BASE, card: NEW_CARD, round: 1, facts: { kind: 'private', attachment: true },
    memory: ['你记得：他叫小明'], thoughts: ['我还惦记着他上次问的问题'],
    habits: ['别用客服腔'], growth: '你以前总结过：短句更好',
    styleHome: undefined,   // 不给风格根 → 跳过风格层（顺序里少一环，其余照验）
  })
  const order = [
    '你是小鲸鱼（角色 whale）。',
    '当前在QQ 群，对象是某人。',
    '以下是她自己的话：',
    '我是小鲸鱼，混在群里的一个角色。',
    '「你到底是人是AI？」→「你猜～」',       // 语料（round=1 ≤3）
    '你记得：他叫小明',                      // 记忆
    '我还惦记着他上次问的问题',              // 惦记
    '先说看到什么，再说看法。',              // 条件（when=attachment 命中）
    '别用客服腔',                           // 槽
    '你以前总结过：短句更好',                // 成长（末尾位）
  ]
  const idx = order.map((s) => indexOf(r.text, s))
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i - 1] < idx[i], `★ 顺序错了：「${order[i - 1].slice(0, 16)}」应在「${order[i].slice(0, 16)}」之前`)
  }
  assert.ok(r.text.endsWith('你以前总结过：短句更好'), '★ 成长反哺占末尾位（卡里不再放东西）')
})

test('★★ 语料只在前 3 轮（规格 §5 第 6 步）', () => {
  for (const round of [1, 2, 3]) {
    const r = assemblePrompt({ ...BASE, card: NEW_CARD, round })
    assert.ok(r.text.includes('冷启动示例') || r.text.includes('你猜～'), `★ 第 ${round} 轮该有语料`)
  }
  for (const round of [4, 10]) {
    const r = assemblePrompt({ ...BASE, card: NEW_CARD, round })
    assert.equal(r.text.includes('你猜～'), false, `★ 第 ${round} 轮不该有语料`)
  }
})

test('★ 条件命中 ≤3 条（P2 选择器的上限在这里也成立）', () => {
  const card = ['---', 'fishcard: 3', '---', '',
    ...Array.from({ length: 6 }, (_, i) => `### 【条件 when=group】场景${i}\n第${i}条\n`),
  ].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 1, facts: { kind: 'group' } })
  assert.equal(r.used.conditions, 3, `★ 最多 3 条，实为 ${r.used.conditions}`)
})

test('★ 槽 ≤2 / 惦记 ≤3 / 记忆 ≤6（规格 §5 的上限）', () => {
  const r = assemblePrompt({
    ...BASE, card: NEW_CARD, round: 10,
    habits: ['a', 'b', 'c', 'd'],
    thoughts: ['t1', 't2', 't3', 't4', 't5'],
    memory: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
  })
  assert.ok(!r.text.includes('c'), '★ 槽第 3 条不该进')
  assert.ok(!r.text.includes('t4'), '★ 惦记第 4 条不该进')
  assert.ok(!r.text.includes('m7'), '★ 记忆第 7 条不该进')
  assert.ok(r.text.includes('a') && r.text.includes('t1') && r.text.includes('m6'))
})

test('★ 空段跳过：没有卡 / 没有记忆 / 没有风格 → 不出空行也不炸', () => {
  const r = assemblePrompt({ name: '鱼', round: 5 })
  assert.equal(r.text.includes('以下是她自己的话：'), false, '★ 全空时不留孤零零的标签行')
  assert.equal(r.text.trim(), '你是鱼。')
  assert.equal(r.used.legacy, true)
  assert.deepEqual(r.used, { conditions: 0, style: null, legacy: true })
})

test('★ 警告透传：解析层的兜底警告要能到调用方（不静默）', () => {
  const card = ['---', 'fishcard: 3', '---', '', '### 【條件】拼错', '正文', ''].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 1 })
  assert.ok(r.warnings.some((w) => /未识别的节头/.test(w)), '★ 解析层的警告要透出来：' + r.warnings.join(' | '))
})
