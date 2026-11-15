import test from 'node:test'
import assert from 'node:assert/strict'
import { createQQInbox, eventAllowed } from '../lib/qq-inbox.mjs'

test('非白名单群：不轮询、不落库、不进上下文、不回复', async () => {
  let reads = 0
  let activityWrites = 0
  let delivers = 0
  const activity = { append: () => { activityWrites += 1 } }
  const world = {
    chatTargets: () => [],
    listRelations: () => ({ owner: { qqId: '10001' } }),
    markChatSeen: () => {},
  }
  const qq = {
    bridgeConfig: () => ({ 事件端口: 1 }),
    recent: async () => { reads += 1; return { ok: true, messages: [] } },
    loginInfo: async () => ({ ok: true, userId: '10001' }),
    isMuted: () => false,
  }
  const platforms = { platform: () => ({ enabled: true, readHistory: true, pollSeconds: 1, historyLimit: 20 }) }
  const inbox = createQQInbox({ qq, platforms, world, activity, deliver: async () => { delivers += 1; return { ok: true } }, logger: { info() {}, warn() {}, error() {} } })
  // 模拟协议端队列里已有 3 条未开启群的消息：没有白名单目标，tick 不应去读。
  qq.recent = async () => { reads += 1; return { ok: true, messages: [{ id: 'm1', at: 1, text: '1' }, { id: 'm2', at: 2, text: '2' }, { id: 'm3', at: 3, text: '3' }] } }
  const out = await inbox.tick()
  assert.equal(out.skipped, 'no-targets')
  assert.equal(reads, 0)
  assert.equal(activityWrites, 0)
  assert.equal(delivers, 0)
  assert.equal(inbox.status().targets.length, 0)
  assert.equal(eventAllowed('group:999', new Set(['group:1'])), false)
  assert.equal(eventAllowed('group:1', new Set(['group:1'])), true)
})
