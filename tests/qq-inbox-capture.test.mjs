// 收信落库链路：收到文字消息 → 抽出语录/梗 → 写进知识库 pending，并去重。
// 临时目录 + 假 world，不碰真实知识库。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createQQInbox } from '../lib/qq-inbox.mjs'

function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'fw-inbox-capture-'))
  const memeDir = join(root, '鱼的记忆')
  mkdirSync(memeDir, { recursive: true })
  const file = join(memeDir, '知识库.json')
  writeFileSync(file, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8')
  const world = { status: () => ({ worldPath: root }) }
  return { root, file, world }
}

test('收到语录就落库：长文本写成 quote pending', () => {
  const { file, world } = makeWorld()
  const inbox = createQQInbox({ world })
  inbox._captureMemeForTest('AI文案三大定律：不是而是定律、主语不动定律、化简为繁定律。', '墨墨', '123', world)
  const items = JSON.parse(readFileSync(file, 'utf8')).items
  assert.equal(items.length, 1)
  assert.equal(items[0].type, 'quote')
  assert.equal(items[0].status, 'pending')
  assert.match(items[0].name, /AI文案三大定律/)
  assert.match(items[0].meaning, /不是而是定律/)
})

test('短句不落库，避免闲聊污染', () => {
  const { file, world } = makeWorld()
  const inbox = createQQInbox({ world })
  inbox._captureMemeForTest('今天天气不错', '甲', '1', world)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items.length, 0)
})

test('同一条再来说只加别名，不重复建', () => {
  const { file, world } = makeWorld()
  const inbox = createQQInbox({ world })
  const text = 'AI文案三大定律：不是而是定律。'
  inbox._captureMemeForTest(text, '甲', '1', world)
  inbox._captureMemeForTest(text, '乙', '2', world)
  const items = JSON.parse(readFileSync(file, 'utf8')).items
  assert.equal(items.length, 1)
  assert.equal(items[0].name, 'AI文案三大定律：不是而是定律。')
})
