// 会话健康：失败时先别投，上下文超限直接 blocked。
// 背景：群会话 4.3M token 超过模型窗口，每一轮都失败；如果失败后照旧投下一批，
// 队列就会一条条堆起来（截图里的「4 条排队消息」）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { failureHealth, isOversizeError, shouldHold } from '../lib/session-health.mjs'

const NOW = Date.parse('2026-11-02T12:00:00+08:00')

test('上下文超限的错误文本能认出来', () => {
  assert.equal(isOversizeError('exceeds the model context window (1,048,576)'), true)
  assert.equal(isOversizeError('bili_gate_oversize_refusal_fallback: billion-context refused this request'), true)
  assert.equal(isOversizeError('超出模型的上下文窗口'), true)
  assert.equal(isOversizeError('ordinary tool error: file not found'), false)
  assert.equal(isOversizeError(''), false)
})

test('failureHealth：普通失败只冷却，超限才 blocked', () => {
  const normal = failureHealth({ kind: 'error', message: 'network down' }, { at: NOW })
  assert.equal(normal.ok, false)
  assert.equal(normal.blocked, false)
  assert.match(normal.error, /network down/)

  const over = failureHealth({
    kind: 'error',
    message: 'core text alone ~4,348,073 tok exceeds the model context window (1,048,576)',
  }, { at: NOW })
  assert.equal(over.blocked, true)

  // reason 是字符串也认
  assert.equal(failureHealth('context window exceeded', { at: NOW }).blocked, true)
})

test('shouldHold：超限一直停，普通失败冷却后放行', () => {
  const normal = failureHealth({ message: 'boom' }, { at: NOW, cooldownMs: 60_000 })
  assert.equal(shouldHold(normal, { now: NOW + 1_000 }), true, '冷却期内先攒着')
  assert.equal(shouldHold(normal, { now: NOW + 61_000 }), false, '冷却过后可以再试')

  const over = failureHealth({ message: 'exceeds the model context window' }, { at: NOW })
  assert.equal(shouldHold(over, { now: NOW + 24 * 3600_000 }), true, '超限不会自己好，必须换会话')

  assert.equal(shouldHold(null), false)
  assert.equal(shouldHold({ ok: true }), false)
})

test('failureHealth 不吃异常输入', () => {
  assert.equal(failureHealth(null, { at: NOW }).blocked, false)
  assert.equal(failureHealth(undefined, { at: NOW }).ok, false)
  const circular = {}
  circular.self = circular
  assert.equal(failureHealth(circular, { at: NOW }).ok, false, '循环引用也不能炸')
})
