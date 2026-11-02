// 鱼的请求：提示词里的「该不该推她一句」。
// 请求必须是她真想说的；这里只负责在「额度还有 + 确实很久没提」时给一个开口。
import assert from 'node:assert/strict'
import test from 'node:test'

import { wishNudge } from '../lib/wish-nudge.mjs'

const NOW = Date.parse('2026-11-02T12:00:00+08:00')
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString()

test('额度用完就不推', () => {
  assert.equal(wishNudge({ remainingToday: 0, wishes: [] }, { now: NOW }), '')
  assert.equal(wishNudge({ remainingToday: -1, wishes: [] }, { now: NOW }), '')
  assert.equal(wishNudge({}, { now: NOW }), '')
})

test('从没提过：给一句开口', () => {
  const text = wishNudge({ remainingToday: 3, wishes: [] }, { now: NOW })
  assert.match(text, /还没提过请求/)
  assert.match(text, /没有就不必提/)
})

test('刚提过（1 天内）不推，免得催', () => {
  assert.equal(wishNudge({ remainingToday: 2, wishes: [{ at: daysAgo(0.5) }] }, { now: NOW }), '')
})

test('超过 2 天没提：按天数给一句，并明确别凑数', () => {
  const text = wishNudge({ remainingToday: 3, wishes: [{ at: daysAgo(3) }] }, { now: NOW })
  assert.match(text, /已经 3 天没提过请求/)
  assert.match(text, /没有就不提|别为了凑数编/)
})

test('at 坏了当作没提过，不炸', () => {
  const text = wishNudge({ remainingToday: 3, wishes: [{ at: 'not-a-date' }] }, { now: NOW })
  assert.match(text, /还没提过请求/)
})

test('多条取最近的一条算天数', () => {
  const text = wishNudge({
    remainingToday: 3,
    wishes: [{ at: daysAgo(30) }, { at: daysAgo(4) }, { at: daysAgo(1) }],
  }, { now: NOW })
  assert.equal(text, '', '最近一条是 1 天前，不该推')
})
