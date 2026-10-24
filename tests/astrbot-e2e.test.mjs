// 端到端：起一个真的 HTTP 服务假装成 AstrBot 桥，验证鱼侧完整链路。
// 这不是单测，是把 lib/astrbot.mjs + lib/qq.mjs 合起来跑一遍真实网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAstrbot } from '../lib/astrbot.mjs'
import { createQQ } from '../lib/qq.mjs'

const TOKEN = 'fw_e2e_test_token'

// 假的 AstrBot 桥：记录收到的 OneBot 动作，回 OneBot 11 形态的响应。
function startFakeBridge() {
  const calls = []
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization || '')
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'bad token' }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch {}

      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, status: 'ok', userId: '10001', nickname: '鱼' }))
        return
      }
      if (req.url === '/onebot') {
        calls.push(body)
        const action = body.action
        if (action === 'get_login_info') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '鱼' } }))
          return
        }
        if (action === 'send_private_msg') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 555 } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'failed', retcode: 1404, data: {}, message: 'unknown action' }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, calls, port })
    })
  })
}

function makeQQ(home, astrbot) {
  const config = {
    qq: { enabled: true, respectBridgeSwitches: true, dryRun: false, allowForeignTargets: true, timeoutMs: 5000 },
    whale: { rolePrefix: false, role: 'auto' },
  }
  return createQQ({ home, config: () => config, logger: null, sandbox: null, astrbot })
}

test('端到端：鱼通过 AstrBot 桥查到登录号', async () => {
  const { server, calls, port } = await startFakeBridge()
  const home = mkdtempSync(join(tmpdir(), 'fw-e2e-'))
  try {
    const astrbot = createAstrbot({ home })
    astrbot.save({ enabled: true, useForQQ: true, baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 5000 })
    const qq = makeQQ(home, astrbot)

    assert.equal(qq.snapshot().transport, 'astrbot', '应该切到 AstrBot 通道')

    const login = await qq.loginInfo()
    assert.equal(login.ok, true)
    assert.equal(login.userId, '10001')
    assert.equal(login.nickname, '鱼')

    // 确认请求真的到了"AstrBot"，且带上正确的 action。
    assert.equal(calls.length, 1)
    assert.equal(calls[0].action, 'get_login_info')
  } finally {
    server.close()
  }
})

test('端到端：鱼通过 AstrBot 桥发出一条私聊', async () => {
  const { server, calls, port } = await startFakeBridge()
  const home = mkdtempSync(join(tmpdir(), 'fw-e2e-'))
  try {
    const astrbot = createAstrbot({ home })
    astrbot.save({ enabled: true, useForQQ: true, baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 5000 })
    const qq = makeQQ(home, astrbot)

    const receipt = await qq.send('private:10001', [{ type: 'text', text: '在的' }])
    assert.equal(receipt.ok, true, '应该发送成功')
    assert.equal(receipt.dryRun, false)

    const sendCall = calls.find((c) => c.action === 'send_private_msg')
    assert.ok(sendCall, '应该调用 send_private_msg')
    assert.equal(String(sendCall.params.user_id), '10001')
    // 消息段要原样透传，不能被吞。
    assert.equal(Array.isArray(sendCall.params.message), true)
    assert.equal(sendCall.params.message[0].type, 'text')
    assert.equal(sendCall.params.message[0].data.text, '在的')
  } finally {
    server.close()
  }
})

test('端到端：token 不对时桥拒绝，鱼拿到明确的失败而不是假成功', async () => {
  const { server, port } = await startFakeBridge()
  const home = mkdtempSync(join(tmpdir(), 'fw-e2e-'))
  try {
    const astrbot = createAstrbot({ home })
    astrbot.save({ enabled: true, useForQQ: true, baseUrl: `http://127.0.0.1:${port}`, token: 'fw_wrong', timeoutMs: 5000 })
    const qq = makeQQ(home, astrbot)

    const receipt = await qq.send('private:10001', [{ type: 'text', text: 'hi' }])
    assert.equal(receipt.ok, false, '不能假装成功')
  } finally {
    server.close()
  }
})

test('端到端：健康检查会记下 AstrBot 的登录身份', async () => {
  const { server, port } = await startFakeBridge()
  const home = mkdtempSync(join(tmpdir(), 'fw-e2e-'))
  try {
    const astrbot = createAstrbot({ home })
    astrbot.save({ enabled: true, baseUrl: `http://127.0.0.1:${port}`, token: TOKEN })
    const health = await astrbot.health()
    assert.equal(health.ok, true)
    assert.equal(health.userId, '10001')

    // 身份被记住后，即使没有 QQ 桥配置也能推出默认私聊目标。
    assert.equal(astrbot.identityView().userId, '10001')
  } finally {
    server.close()
  }
})
