// fish_world 工具里的 astrbot-tools / astrbot-tool：权限闸门必须真的挡住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEcosystemTool } from '../lib/tool.mjs'

// 只关心 astrbot 两个 action，其余依赖给最小桩。
function buildTool({ canBorrowTools, toolsResult, runResult }) {
  const calls = { tools: 0, runTool: [] }
  const astrbot = {
    view: () => ({ canBorrowTools }),
    tools: async () => {
      calls.tools += 1
      return toolsResult
    },
    runTool: async (args) => {
      calls.runTool.push(args)
      return runResult
    },
    snapshot: () => ({}),
  }
  const tool = buildEcosystemTool({
    loader: { list: () => [], status: () => ({}), setEnabled: async () => {}, reload: async () => {} },
    qq: { snapshot: () => ({}), send: async () => ({ ok: true }), recent: async () => ({ ok: true, messages: [] }) },
    whale: { persona: () => ({ role: null }), summary: () => ({ roles: [] }) },
    world: {},
    stickers: {}, links: {}, qzone: {}, environment: null, growth: {}, platforms: {},
    astrbot,
    toolName: 'fish_world',
  })
  return { tool, calls }
}

async function call(tool, args) {
  return tool.execute(args, {})
}

test('没开借用开关时，astrbot-tools 被拒绝', async () => {
  const { tool, calls } = buildTool({
    canBorrowTools: false,
    toolsResult: { ok: true, tools: [] },
    runResult: { ok: true, output: '' },
  })
  const result = await call(tool, { action: 'astrbot-tools' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /还没有打开/)
  assert.equal(calls.tools, 0, '没授权就不该去问 AstrBot')
})

test('没开借用开关时，astrbot-tool 被拒绝', async () => {
  const { tool, calls } = buildTool({
    canBorrowTools: false,
    toolsResult: { ok: true, tools: [] },
    runResult: { ok: true, output: '' },
  })
  const result = await call(tool, { action: 'astrbot-tool', tool: 'web_search' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /还没有打开/)
  assert.equal(calls.runTool.length, 0, '没授权就绝不该执行别人的插件')
})

test('打开开关后能列出工具', async () => {
  const { tool } = buildTool({
    canBorrowTools: true,
    toolsResult: {
      ok: true,
      tools: [
        { name: 'web_search', description: '搜索网页' },
        { name: 'translate', description: '翻译文本' },
      ],
    },
    runResult: { ok: true, output: '' },
  })
  const result = await call(tool, { action: 'astrbot-tools' })
  assert.equal(result.ok, true)
  assert.match(result.content, /web_search/)
  assert.match(result.content, /translate/)
  assert.equal(result.tools.length, 2)
})

test('执行工具时把原始结果标注来源交回', async () => {
  const { tool, calls } = buildTool({
    canBorrowTools: true,
    toolsResult: { ok: true, tools: [] },
    runResult: { ok: true, name: 'web_search', output: '三条链接' },
  })
  const result = await call(tool, { action: 'astrbot-tool', tool: 'web_search', params: { q: 'x' } })
  assert.equal(result.ok, true)
  // 必须标明这是借来的能力，不能让鱼误当成自己的观察。
  assert.match(result.content, /通过 AstrBot 的 web_search/)
  assert.match(result.content, /三条链接/)
  assert.equal(calls.runTool.length, 1)
  assert.equal(calls.runTool[0].name, 'web_search')
  assert.deepEqual(calls.runTool[0].params, { q: 'x' })
})

test('缺 tool 参数时给出可操作的提示', async () => {
  const { tool, calls } = buildTool({
    canBorrowTools: true,
    toolsResult: { ok: true, tools: [] },
    runResult: { ok: true, output: '' },
  })
  const result = await call(tool, { action: 'astrbot-tool' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /tool/)
  assert.equal(calls.runTool.length, 0)
})

test('AstrBot 执行失败时如实转达，不编造结果', async () => {
  const { tool } = buildTool({
    canBorrowTools: true,
    toolsResult: { ok: true, tools: [] },
    runResult: { ok: false, error: '没有这个工具' },
  })
  const result = await call(tool, { action: 'astrbot-tool', tool: 'nope' })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /没有这个工具/)
})
