import { createQQInbox } from '../lib/qq-inbox.mjs'

let reads = 0, activityWrites = 0, delivers = 0
const world = { chatTargets: () => [], listRelations: () => ({ owner: { qqId: '10001' } }), markChatSeen: () => {} }
const qq = {
  bridgeConfig: () => ({ 事件端口: 1 }),
  recent: async () => { reads += 1; return { ok: true, messages: [{ id: 'm1', at: 1, text: 'a' }, { id: 'm2', at: 2, text: 'b' }, { id: 'm3', at: 3, text: 'c' }] } },
  loginInfo: async () => ({ ok: true, userId: '10001' }),
  isMuted: () => false,
}
const platforms = { platform: () => ({ enabled: true, readHistory: true, pollSeconds: 1, historyLimit: 20 }) }
const inbox = createQQInbox({ qq, platforms, world, activity: { append: () => { activityWrites += 1 } }, deliver: async () => { delivers += 1; return { ok: true } }, logger: { info() {}, warn() {}, error() {} } })
const out = await inbox.tick()
console.log(JSON.stringify({ out, reads, activityWrites, delivers, targets: inbox.status().targets.length }))
if (reads !== 0 || activityWrites !== 0 || delivers !== 0 || out.skipped !== 'no-targets') { console.error('FAIL: 非白名单群发生了读取/落库/发送'); process.exit(1) }
console.log('PASS: 3 条未开启群消息未读取、未落库、未发送')
