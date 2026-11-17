// 分气泡：每一个换行都算一条（2026-10-26 改成按行拆，空行当然也拆）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { splitBubbles } from '../lib/util.mjs'

test('空行拆成两条，前后空白都去掉', () => {
  assert.deepEqual(
    splitBubbles(' 谁肥了 说清楚 \n\n 三代目就三代目 少一个字不行？ '),
    ['谁肥了 说清楚', '三代目就三代目 少一个字不行？'],
  )
})

// 语义变了（2026-10-26）：单换行也拆。模型写两条消息时用的就是一个换行，
// 不拆的话就是「存不了 图在桥的临时目录 / 你丢进 大肥鱼 目录 我再收」那种合并。
test('单换行也拆成两条', () => {
  assert.deepEqual(splitBubbles('第一行\n第二行'), ['第一行', '第二行'])
  assert.deepEqual(
    splitBubbles('存不了 图在桥的临时目录\n你丢进 大肥鱼 目录 我再收'),
    ['存不了 图在桥的临时目录', '你丢进 大肥鱼 目录 我再收'],
  )
})

test('CRLF 与多余空行都归一，空段丢掉', () => {
  // 三段以上会被「一轮最多两条」并进最后一条（2026-11-18 收紧）。
  assert.deepEqual(splitBubbles('甲\r\n\r\n乙'), ['甲', '乙'])
  assert.deepEqual(splitBubbles('甲\r\n\r\n乙\r\n\r\n\r\n丙'), ['甲', '乙 丙'])
})

// 人设卡示例用「／」分隔两条消息，代码得认，不然她按示例写就成一句。
test('全角 ／ 与两侧带空格的半角 / 也拆开', () => {
  assert.deepEqual(splitBubbles('不许说胖！这叫有福气~ ／ ？你再说一遍试试'), ['不许说胖！这叫有福气~', '？你再说一遍试试'])
  assert.deepEqual(splitBubbles('行吧 这局让你 / 哼'), ['行吧 这局让你', '哼'])
  // 数字里的斜杠不拆
  assert.deepEqual(splitBubbles('5/10 分'), ['5/10 分'])
})

test('空文本 / 只有空白 → 空数组（这一轮没话说）', () => {
  assert.deepEqual(splitBubbles(''), [])
  assert.deepEqual(splitBubbles('  \n\n  '), [])
  assert.deepEqual(splitBubbles(null), [])
})

// 主人 2026-11-18 收紧：「一轮最多两条；想发第三条，等对方回」。
// 超出的不丢字，多出来的并进第 2 条。
test('一轮最多两条：超出的并进最后一条，不丢正文', () => {
  const parts = splitBubbles('一\n二\n三\n四\n五')
  assert.equal(parts.length, 2)
  assert.equal(parts[0], '一')
  assert.equal(parts[1], '二 三 四 五')
  // 正好两条不动
  assert.deepEqual(splitBubbles('一\n二'), ['一', '二'])
})


// 2026-11-01：<invoke …> 被按行拆成了三条气泡发进群。工具块整块丢，
// 不能出现在任何气泡里；前后真话照常分条。
test('工具调用语法不能拆成气泡', () => {
  const leak = [
    '<invoke name="fish_tone">',
    '<parameter name="text">第十枚快凑齐了 你这是拿我练手呢还是真缺那勺白饭</parameter>',
    '<parameter name="strength">light</parameter>',
    '</invoke>',
  ].join('\n')
  assert.deepEqual(splitBubbles(leak), [])
  assert.deepEqual(splitBubbles('真的吗\n' + leak + '\n那我就放心了'), ['真的吗', '那我就放心了'])
  // 行内夹着标签：删标签，真话留下。
  assert.deepEqual(splitBubbles('我先说<invoke name="x"></invoke>完了'), ['我先说 完了'])
})

// 2026-11-15：按分号切；超过 120 字再按句号切
test('分号也要拆', () => {
  assert.deepEqual(splitBubbles('甲；乙'), ['甲', '乙'])
  // 三段并进第二条（一轮最多两条）
  assert.deepEqual(splitBubbles('甲；乙;丙'), ['甲', '乙 丙'])
})

test('超长段按句号再切', () => {
  const s = '这'.repeat(121) + '。' + '那'.repeat(121) + '！'
  const parts = splitBubbles(s)
  assert.ok(parts.length >= 2, '长段要被切开')
  assert.ok(parts.every((p) => p.length <= 130), '每段不应还是一大坨')
})
