// QQ Agent 借手通道：地址/token 校验、列工具、执行工具、失败如实报。
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_QQAGENT, createQQAgent, normalizeQQAgent } from '../lib/qqagent.mjs'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'fw-qqagent-'))
}

async function fakeBridge(handlers = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, auth: req.headers.authorization || '', body }
      seen.push(entry)
      const send = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
      if (req.url === '/health') return send(200, { ok: true, version: '0.1.0', account: '457310173' })
      if (entry.auth !== 'Bearer fq_test') return send(401, { ok: false, error: 'bad token' })
      if (req.url === '/tools') return send(200, { ok: true, tools: handlers.tools || [{ name: 'search', description: '搜一搜' }] })
      if (req.url === '/tool') {
        const parsed = JSON.parse(body || '{}')
        if (parsed.name === 'boom') return send(200, { ok: false, error: '工具自己报错了' })
        return send(200, { ok: true, output: '结果：' + JSON.stringify(parsed.params || {}) })
      }
      return send(404, { ok: false, error: 'no route' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, baseUrl: 'http://127.0.0.1:' + server.address().port }
}

test('默认关着：没配 token 就调不动，但视图如实说缺什么', async () => {
  const bot = createQQAgent({ home: tempHome() })
  const view = bot.view()
  assert.equal(view.enabled, false)
  assert.equal(view.active, false)
  assert.equal(view.hasToken, false)
  assert.equal(view.baseUrl, DEFAULT_QQAGENT.baseUrl)
  const tools = await bot.tools()
  assert.equal(tools.ok, false)
  assert.match(tools.error, /token/)
})

test('地址校验沿用 AstrBot 那套：非本机必须 https，别把 token 明文过网', () => {
  assert.equal(normalizeQQAgent({ baseUrl: 'http://127.0.0.1:3211' }).baseUrl, 'http://127.0.0.1:3211')
  assert.equal(normalizeQQAgent({ baseUrl: 'http://example.com' }).baseUrl, DEFAULT_QQAGENT.baseUrl, '不合法就回落默认，不静默接受')
  const bot = createQQAgent({ home: tempHome() })
  assert.throws(() => bot.save({ baseUrl: 'ftp://x' }), /http\(s\)|只支持/)
})

test('生成 token 后文件权限收紧，明文只出现一次', () => {
  const home = tempHome()
  const bot = createQQAgent({ home })
  const made = bot.rotateToken()
  assert.match(made.token, /^fq_/)
  assert.equal(bot.view().hasToken, true)
  assert.equal(JSON.stringify(bot.view()).includes(made.token), false, '视图里不许有明文')
  const mode = statSync(join(home, 'fish-world-qqagent.json')).mode & 0o777
  assert.ok(mode === 0o600 || process.platform === 'win32', '权限位：' + mode.toString(8))
})

test('列工具 / 执行工具：带 Bearer，返回原始输出', async () => {
  const bridge = await fakeBridge()
  try {
    const bot = createQQAgent({ home: tempHome() })
    bot.save({ baseUrl: bridge.baseUrl, token: 'fq_test', enabled: true })
    assert.equal(bot.view().active, true)

    const health = await bot.health()
    assert.equal(health.ok, true)
    assert.equal(health.account, '457310173')

    const tools = await bot.tools()
    assert.equal(tools.ok, true)
    assert.equal(tools.tools[0].name, 'search')

    const ran = await bot.runTool({ name: 'search', params: { q: '鲸鱼' } })
    assert.equal(ran.ok, true)
    assert.match(ran.output, /鲸鱼/)
    assert.ok(bridge.seen.every((row) => row.auth === 'Bearer fq_test' || row.url === '/health'))
  } finally {
    bridge.server.close()
  }
})

test('对端报错要转达，不许假装成功', async () => {
  const bridge = await fakeBridge()
  try {
    const bot = createQQAgent({ home: tempHome() })
    bot.save({ baseUrl: bridge.baseUrl, token: 'fq_test' })
    const bad = await bot.runTool({ name: 'boom' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /工具自己报错了/)

    const wrongToken = createQQAgent({ home: tempHome() })
    wrongToken.save({ baseUrl: bridge.baseUrl, token: 'fq_wrong' })
    const denied = await wrongToken.tools()
    assert.equal(denied.ok, false)
    assert.match(denied.error, /bad token|401/)
  } finally {
    bridge.server.close()
  }
})

test('对端没起来：报错而不是空列表', async () => {
  const bot = createQQAgent({ home: tempHome() })
  bot.save({ baseUrl: 'http://127.0.0.1:59991', token: 'fq_test' })
  const tools = await bot.tools()
  assert.equal(tools.ok, false)
  assert.ok(tools.error.length > 0)
})
