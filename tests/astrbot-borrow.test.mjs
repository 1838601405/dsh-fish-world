// B 方案：借用 AstrBot 的「手」，但不让它开口。
//
// 这是本项目最容易做错的地方：如果让 AstrBot 生成回复，出来的就不是鱼了。
// 这些测试就是钉住这条边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAstrbot } from '../lib/astrbot.mjs'

const TOKEN = 'fw_borrow_token'

// 假桥：记录收到的请求，按 action 回不同结果。
function startFakeBridge() {
  const requests = []
  const server = createServer((req, res) => {
    if (String(req.headers.authorization || '') !== `Bearer ${TOKEN}`) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch {}

      if (req.url === '/tools') {
        requests.push({ url: '/tools', body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          tools: [
            { name: 'web_search', description: '搜索网页', parameters: { type: 'object' } },
            { name: 'translate', description: '翻译文本', parameters: { type: 'object' } },
          ],
        }))
        return
      }
      if (req.url === '/tool') {
        requests.push({ url: '/tool', body })
        if (body.name === 'web_search') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, name: 'web_search', output: '搜索结果：三条链接' }))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '没有这个工具' }))
        return
      }
      // /agent 不该被调用 —— 有任何请求进来就记下来，测试会断言它为空。
      requests.push({ url: req.url, body })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }))
  })
}

async function setup() {
  const { server, requests, port } = await startFakeBridge()
  const home = mkdtempSync(join(tmpdir(), 'fw-borrow-'))
  const astrbot = createAstrbot({ home })
  astrbot.save({
    enabled: true,
    borrowTools: true,
    baseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
    timeoutMs: 5000,
  })
  return { server, requests, astrbot }
}

test('列出可借用工具时带上参数 schema', async () => {
  const { server, astrbot } = await setup()
  try {
    const result = await astrbot.tools()
    assert.equal(result.ok, true)
    assert.equal(result.tools.length, 2)
    assert.equal(result.tools[0].name, 'web_search')
    // schema 要带给鱼，否则它只能瞎猜参数。
    assert.deepEqual(result.tools[0].parameters, { type: 'object' })
  } finally {
    server.close()
  }
})

test('执行工具返回原始结果，不是生成好的回复', async () => {
  const { server, astrbot } = await setup()
  try {
    const result = await astrbot.runTool({ name: 'web_search', params: { q: '便当盒布局' } })
    assert.equal(result.ok, true)
    assert.equal(result.name, 'web_search')
    // 关键：拿到的是工具原始输出，鱼要自己消化后再说。
    assert.equal(result.output, '搜索结果：三条链接')
  } finally {
    server.close()
  }
})

test('参数被原样传给 AstrBot', async () => {
  const { server, requests, astrbot } = await setup()
  try {
    await astrbot.runTool({ name: 'web_search', params: { q: '测试', limit: 3 } })
    const call = requests.find((r) => r.url === '/tool')
    assert.ok(call, '应该请求 /tool')
    assert.equal(call.body.name, 'web_search')
    assert.deepEqual(call.body.params, { q: '测试', limit: 3 })
  } finally {
    server.close()
  }
})

test('绝不调用 /agent —— AstrBot 不许替鱼说话', async () => {
  const { server, requests, astrbot } = await setup()
  try {
    await astrbot.tools()
    await astrbot.runTool({ name: 'web_search', params: {} })
    const agentCalls = requests.filter((r) => r.url === '/agent')
    assert.equal(agentCalls.length, 0, '任何情况下都不该让 AstrBot 生成回复')
  } finally {
    server.close()
  }
})

test('模块上不再暴露会"代为回答"的 agent 方法', async () => {
  const { server, astrbot } = await setup()
  try {
    // 防止以后有人又把"让 AstrBot 生成回复"加回来。
    assert.equal(typeof astrbot.agent, 'undefined', '不应存在 agent()，那会让鱼变成别的机器人')
    assert.equal(typeof astrbot.runTool, 'function')
  } finally {
    server.close()
  }
})

test('工具不存在时如实报错，不假装成功', async () => {
  const { server, astrbot } = await setup()
  try {
    const result = await astrbot.runTool({ name: 'no_such_tool', params: {} })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /没有这个工具/)
  } finally {
    server.close()
  }
})

test('缺工具名时直接拒绝，不发请求', async () => {
  const { server, requests, astrbot } = await setup()
  try {
    const result = await astrbot.runTool({ name: '', params: {} })
    assert.equal(result.ok, false)
    assert.equal(requests.length, 0, '参数不全就不该打网络')
  } finally {
    server.close()
  }
})

test('桥不可达时返回结构化失败', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-borrow-'))
  const astrbot = createAstrbot({ home })
  astrbot.save({ enabled: true, borrowTools: true, baseUrl: 'http://127.0.0.1:59997', token: TOKEN, timeoutMs: 800 })
  const result = await astrbot.runTool({ name: 'web_search', params: {} })
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
})
