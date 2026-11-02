import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createChatContext, trimHistory } from '../lib/chat-context.mjs'

test('trimHistory：条数上限 + 字符上限，丢掉最旧的', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(100),
  }))
  assert.equal(trimHistory(list, { limit: 10, maxChars: 5000 }).length, 10)
  const chars = trimHistory(list, { limit: 30, maxChars: 1000 })
  assert.ok(chars.reduce((sum, m) => sum + m.content.length, 0) <= 1000)
  assert.equal(trimHistory([{ role: 'system', content: 'x' }, { role: 'user', content: 'ok' }], { limit: 5 }).length, 1)
})

test('按会话存取、文件名可读且带短哈希、清空', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx-'))
  const ctx = createChatContext({ home })
  ctx.append('group:123', { role: 'user', content: '在吗' }, { limit: 5, maxChars: 1000 })
  ctx.append('group:123', { role: 'assistant', content: '在' }, { limit: 5, maxChars: 1000 })
  assert.deepEqual(ctx.load('group:123').map((m) => m.content), ['在吗', '在'])
  assert.match(ctx.fileFor('group:123'), /group_123-[0-9a-f]{8}\.json$/)
  ctx.clear('group:123')
  assert.deepEqual(ctx.load('group:123'), [])
})

test('不同会话互不串台', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx2-'))
  const ctx = createChatContext({ home })
  ctx.append('group:1', { role: 'user', content: 'a' }, { limit: 5, maxChars: 1000 })
  ctx.append('group:2', { role: 'user', content: 'b' }, { limit: 5, maxChars: 1000 })
  assert.deepEqual(ctx.load('group:1').map((m) => m.content), ['a'])
  assert.deepEqual(ctx.load('group:2').map((m) => m.content), ['b'])
})
