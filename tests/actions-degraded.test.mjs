// 降级路径：只接核心服务（loader/qq/roles/world），其余全缺。
//
// 真问题（2026-10-28 扫出来的）：缺服务时 14 条动作直接把 JS 原始错误丢给模型——
// `Cannot read properties of undefined (reading 'search')`、`loader.reload is not a function`。
// 模型读不出「是前置插件没装 / 插件没初始化完」，只会以为鱼本身坏了。
//
// 这里不要求「缺服务时必须成功」——缺就是缺。只要求：失败时说的是人话。
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEcosystemTool } from '../lib/tool.mjs'

/** 只有核心服务的最小桩，故意什么都不给。 */
function bareTool() {
  return buildEcosystemTool({
    loader: { list: () => [], status: () => ({}) },
    qq: {},
    roles: { current: () => ({ id: 'default', name: '鱼' }) },
    world: { status: () => ({ ok: true }), isOwnerSession: () => true, chatTargetForSession: () => null, listRelations: () => ({ people: [] }) },
  })
}

const ACTIONS = [
  'status', 'list', 'enable', 'disable', 'reload', 'send', 'persona', 'stickers', 'history', 'forward',
  'qq-status', 'sticker-list', 'sticker-collect', 'sticker-send', 'sticker-sync', 'sticker-tags', 'sticker-remove',
  'link-list', 'link-collect', 'link-remove', 'world', 'relations', 'diary', 'diary-comment-ack',
  'wish', 'growth', 'platforms', 'activity', 'record', 'know', 'doctor', 'env-check',
  'qzone-status', 'qzone-feeds', 'qzone-comments', 'qzone-post', 'qzone-diary', 'qzone-like',
  'qzone-comment', 'qzone-reply', 'astrbot-tools', 'astrbot-tool', 'qqagent-tools', 'qqagent-tool',
  'video',
]

const ARGS = {
  send: { text: 'x' }, history: {}, forward: { forwardId: 'f' },
  'sticker-collect': { url: 'https://example.com/a.jpg' }, 'sticker-send': { name: 'a' },
  'sticker-tags': { id: 'a' }, 'sticker-remove': { name: 'a' },
  'link-collect': { url: 'https://example.com' }, 'link-remove': { id: 'l1' },
  enable: { id: 'x' }, disable: { id: 'x' }, diary: { text: 'x' }, 'diary-comment-ack': { commentId: 'c' },
  wish: { text: 'x' }, growth: { text: 'x' }, record: { text: 'x' }, know: { query: 'x' },
  'astrbot-tool': { tool: 't' }, 'qqagent-tool': { tool: 't' },
  'qzone-post': { text: 'x' }, 'qzone-diary': { text: 'x' }, 'qzone-like': { tid: 't' },
  'qzone-comment': { tid: 't', text: 'x' }, 'qzone-reply': { tid: 't', commentId: 'c', text: 'x' },
  video: { op: 'health' },
}

// 「人话」的判据：能落在这些说法之一，就说明代码主动解释过，而不是把 JS 异常甩出去。
const 人话 = /没接上|这次没能执行|未接入|没打开|还没有打开|不可用|没绑定|需要 |缺少|不能|拒绝|没有找到|已到上限|体检发现|待处理/

for (const action of ACTIONS) {
  test(`降级：${action} 失败时说的是人话，不是 JS 异常`, async () => {
    const tool = bareTool()
    const result = await tool.execute({ action, ...(ARGS[action] || {}) }, { agent: { sessionId: 's1' } })
    if (result.ok) return // 纯本地动作（status/list/world 之类）能跑通更好
    const err = String(result.error || '')
    assert.ok(err.trim(), `${action} 失败了却没给原因`)
    assert.ok(人话.test(err), `${action} 的错误不像人话：${err.slice(0, 100)}`)
    // 也不许把「未知 action」当成缺服务的借口。
    assert.ok(!/未知 action/.test(err), `${action} 没走到实现`)
  })
}

test('降级：内部服务缺失时说清是「内部服务没初始化」，不是「前置插件没装」', async () => {
  const tool = bareTool()
  const stickers = await tool.execute({ action: 'stickers' }, {})
  assert.equal(stickers.ok, false)
  assert.match(stickers.error, /表情库没接上/)
  assert.match(stickers.error, /内部这个服务没初始化完成/)
  const links = await tool.execute({ action: 'link-list' }, {})
  assert.match(links.error, /链接库没接上/)
})


