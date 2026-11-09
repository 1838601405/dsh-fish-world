import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chatWithModel, readModelConfig, saveModelConfig } from '../lib/model-api.mjs'

test('模型 API：保存地址/模型/key，并用 OpenAI 兼容接口聊天', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-model-api-'))
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const data = JSON.parse(body || '{}')
      assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, 'Bearer sk-test')
      assert.equal(data.model, 'test-model')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '收到' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  saveModelConfig({ home, baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'test-model', apiKey: 'sk-test' })
  const saved = readModelConfig({ home })
  assert.equal(saved.baseUrl, 'http://127.0.0.1:' + port + '/v1')
  assert.equal(saved.model, 'test-model')
  assert.equal(saved.hasKey, true)
  const got = await chatWithModel({ home, messages: [{ role: 'user', content: '你好' }] })
  assert.equal(got.ok, true)
  assert.equal(got.reply, '收到')
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(home, { recursive: true, force: true })
})
