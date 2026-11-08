import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryAction, unifiedEntries } from '../lib/memory-hub.mjs'

test('记忆动作：标记待确认，然后忘记；源文件保留可恢复', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-memory-action-'))
  const dir = path.join(home, 'fish-memory')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session-test.json')
  fs.writeFileSync(file, JSON.stringify({
    memories: [{ id: 'm1', text: '临时记忆', at: new Date().toISOString(), category: 'event' }],
  }, null, 2), 'utf8')

  const pending = memoryAction({ home, id: 'm1', action: 'pending' })
  assert.equal(pending.ok, true)
  assert.equal(pending.verified, true)
  assert.equal(unifiedEntries({ home }).find((item) => item.id === 'm1')?.status, 'pending')

  const forget = memoryAction({ home, id: 'm1', action: 'forget' })
  assert.equal(forget.ok, true)
  assert.equal(unifiedEntries({ home }).some((item) => item.id === 'm1'), false)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.deleted.includes('m1'), true)
  assert.equal(raw.memories[0].status, 'forgotten')
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('.bak-memory-action-')))
  fs.rmSync(home, { recursive: true, force: true })
})
