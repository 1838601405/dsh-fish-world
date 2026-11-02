// 取宿主服务：没 inject 过的 ctx 直接读属性会抛，不能让它把投递整条带走。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// 2026-11-02 实测：costMeter / connection 没在 inject 里，index.js 里
// `ctx.costMeter || ctx.get('costMeter')` 的写法会在第一步抛异常，被 catch 吞掉后
// 再也不问 ctx.get —— 结果「养鱼花费」一直误报「未安装」、抖音拿不到 RPC。
// 这两处必须走 serviceOf；这条扫描防止回退。
test('index.js 取可选服务必须走 serviceOf（不能直读没 inject 的属性）', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  assert.doesNotMatch(src, /ctx\.costMeter\b/, 'costMeter 没 inject，直读会抛')
  assert.doesNotMatch(src, /ctx\.connection\b/, 'connection 没 inject，直读会抛')
  assert.match(src, /serviceOf\(ctx, 'costMeter'\)/)
  assert.match(src, /serviceOf\(ctx, 'connection'\)/)
})
