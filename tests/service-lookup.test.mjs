// 取宿主服务：没 inject 过的 ctx 直接读属性会抛，不能让它把投递整条带走。
import assert from 'node:assert/strict'
import test from 'node:test'

import { serviceOf } from '../lib/util.mjs'

test('ctx.get 拿得到就用 ctx.get', () => {
  const service = { name: 'attachments' }
  const ctx = { get: (key) => (key === 'attachments' ? service : undefined), attachments: { name: '别的' } }
  assert.equal(serviceOf(ctx, 'attachments'), service)
})

test('直接读属性会抛「without inject」时返回 null，不抛出去', () => {
  const ctx = {
    get: () => { throw new Error('cannot get property "attachments" without inject') },
    get attachments() { throw new Error('cannot get property "attachments" without inject') },
  }
  assert.equal(serviceOf(ctx, 'attachments'), null)
})

test('ctx.get 没有、属性上有就用属性', () => {
  const service = { name: 'attachments' }
  const ctx = { attachments: service }
  assert.equal(serviceOf(ctx, 'attachments'), service)
})

test('没有 ctx、没有名字都安全返回 null', () => {
  assert.equal(serviceOf(null, 'attachments'), null)
  assert.equal(serviceOf({}, ''), null)
  assert.equal(serviceOf({}, 'attachments'), null)
})
