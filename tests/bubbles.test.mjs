// 分气泡：空行 = 两条消息，单换行 = 同一句的折行（别把一句长话切两半）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { splitBubbles } from '../lib/util.mjs'

test('空行拆成两条，前后空白都去掉', () => {
  assert.deepEqual(
    splitBubbles(' 谁肥了 说清楚 \n\n 三代目就三代目 少一个字不行？ '),
    ['谁肥了 说清楚', '三代目就三代目 少一个字不行？'],
  )
})

test('单换行是同一句的折行，不拆', () => {
  assert.deepEqual(splitBubbles('第一行\n第二行'), ['第一行\n第二行'])
})

test('CRLF 与多余空行都归一，空段丢掉', () => {
  assert.deepEqual(splitBubbles('甲\r\n\r\n乙\r\n\r\n\r\n丙'), ['甲', '乙', '丙'])
})

test('空文本 / 只有空白 → 空数组（这一轮没话说）', () => {
  assert.deepEqual(splitBubbles(''), [])
  assert.deepEqual(splitBubbles('  \n\n  '), [])
  assert.deepEqual(splitBubbles(null), [])
})
