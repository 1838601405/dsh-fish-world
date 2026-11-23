import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEcosystemTool } from '../lib/tool.mjs'

test('Qzone reads and writes are fail-closed outside the configured owner session', async () => {
  const calls = []
  const tool = buildEcosystemTool({
    loader: { status: async () => ({ version: 'test', extensions: [], tools: [], bridge: {}, whale: {} }) },
    qq: {},
    whale: {},
    stickers: {},
    world: { isOwnerSession: (id) => id === 'owner-session' },
    qzone: {
      status: () => ({ ok: true }),
      async post(value) { calls.push(['post', value]); return { ok: true, content: 'posted' } },
      async listFeeds() { calls.push(['feeds']); return { items: [] } },
    },
  })

  const guest = await tool.execute({ action: 'qzone-post', text: 'hello' }, { agent: { session: { id: 'guest-session' } } })
  const missing = await tool.execute({ action: 'qzone-feeds' })
  assert.equal(guest.ok, false)
  assert.equal(missing.ok, false)
  assert.equal(calls.length, 0)

  const owner = await tool.execute({ action: 'qzone-post', text: 'owner post' }, { agent: { session: { id: 'owner-session' } } })
  assert.equal(owner.ok, true)
  assert.equal(calls.length, 1)
})

test('按人翻说说与看资料卡同样只在主人会话里能用（新读动作不绕过老闸）', async () => {
  const calls = []
  const tool = buildEcosystemTool({
    loader: { status: async () => ({ version: 'test', extensions: [], tools: [], bridge: {}, whale: {} }) },
    qq: {
      async strangerInfo(uin) { calls.push(['profile', uin]); return { ok: true, userId: uin, nickname: 'x', qid: '', longNick: '', qqLevel: 0, remark: '', regTime: 0 } },
    },
    world: { isOwnerSession: (id) => id === 'owner-session' },
    qzone: {
      status: () => ({ ok: true }),
      async listUserMsgs(args) { calls.push(['msgs', args]); return { ok: true, total: 0, items: [], pos: 0, num: 20, hasMore: false } },
    },
  })

  const guestMsgs = await tool.execute({ action: 'qzone-msg-list', uin: '12345' }, { agent: { session: { id: 'guest-session' } } })
  const guestProfile = await tool.execute({ action: 'qq-profile', uin: '12345' }, { agent: { session: { id: 'guest-session' } } })
  assert.equal(guestMsgs.ok, false, '客人翻不了说说')
  assert.equal(guestProfile.ok, false, '客人看不了资料卡')
  assert.equal(calls.length, 0, '被拒时不许已经打到上游')

  const ownerMsgs = await tool.execute({ action: 'qzone-msg-list', uin: '12345' }, { agent: { session: { id: 'owner-session' } } })
  const ownerProfile = await tool.execute({ action: 'qq-profile', uin: '12345' }, { agent: { session: { id: 'owner-session' } } })
  assert.equal(ownerMsgs.ok, true, '主人翻说说放行')
  assert.equal(ownerProfile.ok, true, '主人看资料卡放行')
  assert.deepEqual(calls.map((item) => item[0]), ['msgs', 'profile'], '两条各打了一次上游')
})
