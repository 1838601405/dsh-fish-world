import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMobile } from '../lib/mobile.mjs'

test('手机入口：无 token 拒绝；带 token 能打开页面 / 状态 / 聊天', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-mobile-'))
  const m = createMobile({
    home,
    getConfig: () => ({ mobile: { enabled: true, port: 3397 } }),
    getState: () => ({ ok: true, ready: true, relations: 2 }),
    chat: async (text) => ({ ok: true, text: '收到：' + text }),
  })
  const started = await m.start()
  assert.equal(started.running, true)
  const base = 'http://127.0.0.1:' + started.port
  assert.equal((await fetch(base + '/')).status, 401)
  const page = await fetch(base + '/?t=' + encodeURIComponent(m.token))
  assert.equal(page.status, 200)
  assert.match(await page.text(), /鱼的世界/)
  const state = await (await fetch(base + '/api/state?t=' + encodeURIComponent(m.token))).json()
  assert.equal(state.ok, true)
  const chat = await (await fetch(base + '/api/chat?t=' + encodeURIComponent(m.token), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
  })).json()
  assert.equal(chat.ok, true)
  assert.equal(chat.text, '收到：你好')
  m.stop()
  fs.rmSync(home, { recursive: true, force: true })
})
