import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { listMemoryEntries } from '../lib/memory-hub.mjs'

const ROOT = path.join(import.meta.dirname, '..')

test('记忆册列表只取会话/群友，不把知识库塞进来；deleted 不出现', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-memory-book-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-memory-root-'))
  const store = path.join(home, 'fish-memory')
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(path.join(store, 'session-test.json'), JSON.stringify({
    deleted: ['gone'],
    memories: [
      { id: 'keep', text: '留下的记忆', at: '2026-11-08T10:00:00.000Z', category: 'event' },
      { id: 'gone', text: '已忘记', at: '2026-11-08T11:00:00.000Z', category: 'event' },
    ],
  }), 'utf8')
  const persons = path.join(root, '鱼的记忆', '群友')
  fs.mkdirSync(persons, { recursive: true })
  fs.writeFileSync(path.join(persons, '10001.json'), JSON.stringify({
    qq: '10001', summary: { text: '群友印象', at: Date.now() },
  }), 'utf8')

  const entries = listMemoryEntries({ home, rootDir: root })
  assert.deepEqual(entries.map((item) => item.id).sort(), ['keep', 'person:10001:summary'])
  assert.equal(entries.some((item) => item.source === 'knowledge'), false)

  const panel = fs.readFileSync(path.join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /fw-memory-book/, '面板要有三栏记忆册')
  const css = fs.readFileSync(path.join(ROOT, 'ui', 'panel.css'), 'utf8')
  assert.match(css, /\.fw-memory-book/, '记忆册三栏样式要存在')
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})
