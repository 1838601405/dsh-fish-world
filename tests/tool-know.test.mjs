// fish_world 的 know 动作：查得到、查不到、重建索引，三种都要像人话且不假成功。
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEcosystemTool } from '../lib/tool.mjs'

function fakeKnowledge(overrides = {}) {
  const calls = { search: [], rebuild: 0 }
  const base = {
    status: () => ({ ok: true, items: 3, enabled: false, mode: 'off', model: '' }),
    async search(query, options) {
      calls.search.push({ query, options })
      return {
        ok: true,
        backend: 'lexical',
        hits: [{
          id: 'kfc', type: 'meme', name: 'v我50 / 疯狂星期四', score: 1, lexical: 1, vector: 0, coverage: 1,
          text: 'v我50 / 疯狂星期四 [梗]；是什么：肯德基疯狂星期四；怎么用：周四玩梗；别怎么用：别真跟人要钱',
        }],
        truncated: false,
        notes: [],
      }
    },
    async rebuild() { calls.rebuild++; return { ok: true, rebuilt: true, model: { id: 'toy', dim: 4 }, items: 3 } },
  }
  return { knowledge: { ...base, ...overrides }, calls }
}

test('know：查到了就说查到几条，带上条目正文', async () => {
  const { knowledge, calls } = fakeKnowledge()
  const tool = buildEcosystemTool({ knowledge, toolName: 'fish_world' })
  const out = await tool.execute({ action: 'know', query: '疯狂星期四' })
  assert.equal(out.ok, true)
  assert.ok(out.content.includes('查到 1 条'))
  assert.ok(out.content.includes('是什么'))
  assert.equal(out.hits[0].id, 'kfc')
  assert.equal(calls.search[0].query, '疯狂星期四')
})

test('know：查不到就明说没这条，别编', async () => {
  const { knowledge } = fakeKnowledge({ search: async () => ({ ok: true, backend: 'lexical', hits: [], truncated: false, notes: [] }) })
  const tool = buildEcosystemTool({ knowledge, toolName: 'fish_world' })
  const out = await tool.execute({ action: 'know', query: '不存在的梗' })
  assert.equal(out.ok, true)
  assert.ok(out.content.includes('没这条'))
  assert.deepEqual(out.hits, [])
})

test('know：不带词就是看状态，不是空查', async () => {
  const { knowledge, calls } = fakeKnowledge()
  const tool = buildEcosystemTool({ knowledge, toolName: 'fish_world' })
  const out = await tool.execute({ action: 'know' })
  assert.equal(out.ok, true)
  assert.ok(out.content.includes('3 条'))
  assert.equal(calls.search.length, 0)
})

test('know：rebuild 走重建，失败要报错不能假成功', async () => {
  const ok = fakeKnowledge()
  const tool = buildEcosystemTool({ knowledge: ok.knowledge, toolName: 'fish_world' })
  const done = await tool.execute({ action: 'know', rebuild: true })
  assert.equal(done.ok, true)
  assert.ok(done.content.includes('索引重建好了'))
  assert.equal(ok.calls.rebuild, 1)

  const bad = fakeKnowledge({ rebuild: async () => ({ ok: false, error: 'embedding 服务返回 500' }) })
  const tool2 = buildEcosystemTool({ knowledge: bad.knowledge, toolName: 'fish_world' })
  const failed = await tool2.execute({ action: 'know', rebuild: true })
  assert.equal(failed.ok, false)
  assert.ok(failed.error.includes('500'))
})

test('know：查询失败把原因带出来', async () => {
  const { knowledge } = fakeKnowledge({ search: async () => ({ ok: false, error: '知识库解析失败：x' }) })
  const tool = buildEcosystemTool({ knowledge, toolName: 'fish_world' })
  const out = await tool.execute({ action: 'know', query: 'x' })
  assert.equal(out.ok, false)
  assert.ok(out.error.includes('解析失败'))
})

test('know：没接知识库时直说，不崩', async () => {
  const tool = buildEcosystemTool({ toolName: 'fish_world' })
  const out = await tool.execute({ action: 'know', query: 'x' })
  assert.equal(out.ok, false)
  assert.ok(out.error.includes('未接入'))
})

test('qqagent-tools / qqagent-tool：没开通道就说没开，开了才借手', async () => {
  const closed = buildEcosystemTool({ qqagent: { view: () => ({ ok: true, active: false }) }, toolName: 'fish_world' })
  const denied = await closed.execute({ action: 'qqagent-tools' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /还没打开/)

  const calls = []
  const fake = {
    view: () => ({ ok: true, active: true }),
    tools: async () => ({ ok: true, tools: [{ name: 'search', description: '搜一搜' }] }),
    runTool: async ({ name, params }) => { calls.push({ name, params }); return { ok: true, name, output: '搜到 3 条' } },
  }
  const tool = buildEcosystemTool({ qqagent: fake, toolName: 'fish_world' })
  const listed = await tool.execute({ action: 'qqagent-tools' })
  assert.equal(listed.ok, true)
  assert.match(listed.content, /search/)
  const ran = await tool.execute({ action: 'qqagent-tool', tool: 'search', params: { q: '鲸鱼' } })
  assert.equal(ran.ok, true)
  assert.match(ran.content, /通过 QQ Agent 的 search 得到/)
  assert.deepEqual(calls, [{ name: 'search', params: { q: '鲸鱼' } }])

  const bad = buildEcosystemTool({ qqagent: { ...fake, runTool: async () => ({ ok: false, error: '对端没起' }) }, toolName: 'fish_world' })
  const failed = await bad.execute({ action: 'qqagent-tool', tool: 'search' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /对端没起/)
})
