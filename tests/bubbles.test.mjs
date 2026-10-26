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
  assert.deepEqual(splitBubbles('甲\r\n\r\n乙\r\n\r\n\r\n丙'), ['甲', '乙', '丙'])
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
