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
