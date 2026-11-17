// 闲置压缩：只在闲够久 + token 超阈值时压，且一段闲置只压一次。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createChatContext } from '../lib/chat-context.mjs'
import {
  compactEntries,
  createIdleCompactor,
  estimateTokens,
  keyFacts,
  shouldCompact,
  tokensOf,
} from '../lib/idle-compact.mjs'
import { writeToWardrobe } from '../lib/fish-memory-bridge.mjs'
import { recall } from '../lib/memory-hub.mjs'
import { writeScopeHint } from '../lib/memory-ingest.mjs'

const MIN = 60 * 1000

function makeStore() {
  const home = mkdtempSync(join(tmpdir(), 'idle-ctx-'))
  const ctx = createChatContext({ home })
  return { home, ctx }
}

function bigHistory(n = 60) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    rows.push({ role: 'user', content: `第 ${i} 句：今天又在群里聊了很多废话，天气不错，吃了白饭，真困。` })
    rows.push({ role: 'assistant', content: `第 ${i} 句回：草，那你先睡，醒了继续累。` })
  }
  return rows
}

test('token 估算与阈值口径', () => {
  assert.ok(estimateTokens('白饭') >= 1)
  assert.ok(estimateTokens('hello world') >= 2)
  assert.equal(tokensOf([{ content: '白饭' }, { content: '12' }]) > 0, true)
})

test('空闲不够 / token 不够 / 已压过 / 冷却中，都不压', () => {
  const now = 1_000_000_000
  assert.equal(shouldCompact({ idleMs: 5 * MIN, tokens: 99999, now }).ok, false)
  assert.equal(shouldCompact({ idleMs: 40 * MIN, tokens: 10, now }).ok, false)
  const base = { idleMs: 40 * MIN, tokens: 99999, lastActivityAt: now - 40 * MIN, now }
  assert.equal(shouldCompact({ ...base, lastCompactAt: now - 10 * MIN }).ok, false, '这段闲置已压过')
  assert.equal(shouldCompact({ ...base, lastCompactAt: now - 20 * MIN, cooldownMs: 30 * MIN }).ok, false, '冷却中')
  assert.equal(shouldCompact(base).ok, true)
})

test('压缩结果：摘要 + 关键事实 + 最后一条，token 明显下降', () => {
  const rows = bigHistory(30)
  const facts = keyFacts(rows)
  assert.ok(facts.length > 0, '应能抽出带具体信息的句子')
  const got = compactEntries(rows, { summary: '这段在聊睡觉和白饭' })
  assert.equal(got.entries[0].content.includes('前情摘要'), true)
  assert.equal(got.entries[1].content.includes('关键事实'), true)
  assert.ok(got.tokensAfter < got.tokensBefore / 2, 'token 要明显降')
  assert.equal(got.entries[got.entries.length - 1].content, rows[rows.length - 1].content, '最后一条保留')
})

test('闲置 31 分钟、token 超阈值 → 只压一次；再 tick 不再压', async () => {
  const { home, ctx } = makeStore()
  const chatKey = 'private:3767749705'
  ctx.save(chatKey, bigHistory(40))
  const at = (Date.now() - 31 * MIN) / 1000
  utimesSync(ctx.fileFor(chatKey), at, at)

  const written = []
  const compactor = createIdleCompactor({
    contextStore: ctx,
    memoryWriter: (payload) => written.push(payload),
    stateFile: join(home, 'idle-compact-state.json'),
    tokenThreshold: 500,
    chats: [chatKey],
  })
  const first = await compactor.tick()
  assert.equal(first.length, 1, '第一次要压')
  assert.equal(written.length, 1, '摘要要进记忆库')
  const afterFirst = readFileSync(ctx.fileFor(chatKey), 'utf8')

  const second = await compactor.tick()
  assert.equal(second.length, 0, '同一段闲置不许重复压')
  assert.equal(readFileSync(ctx.fileFor(chatKey), 'utf8'), afterFirst, '上下文不该再变')
})

test('高频对话（一直有新消息）不压', async () => {
  const { home, ctx } = makeStore()
  const chatKey = 'group:1127271724'
  ctx.save(chatKey, bigHistory(60))
  // 刚有消息：mtime = 1 分钟前
  const at = (Date.now() - MIN) / 1000
  utimesSync(ctx.fileFor(chatKey), at, at)

  const compactor = createIdleCompactor({
    contextStore: ctx,
    memoryWriter: () => {},
    stateFile: join(home, 'state.json'),
    tokenThreshold: 500,
    chats: [chatKey],
  })
  for (let i = 0; i < 5; i += 1) assert.equal((await compactor.tick()).length, 0)
})

test('压缩后记忆不丢：压前聊的具体事，recall 还能命中', async () => {
  const home = mkdtempSync(join(tmpdir(), 'idle-home-'))
  const root = mkdtempSync(join(tmpdir(), 'idle-world-'))
  mkdirSync(join(home, 'fish-memory'), { recursive: true })
  writeFileSync(join(home, 'fish-memory', 'session-abc.json'), JSON.stringify({
    version: 2, memories: [], traces: [], deleted: [],
  }), 'utf8')

  const ctx = createChatContext({ home })
  const chatKey = 'private:3767749705'
  ctx.save(chatKey, [
    { role: 'user', content: '别告诉别人，我喜欢吃香菜，每周三晚上都去吃那家兰州拉面' },
    ...bigHistory(30),
  ])
  const at = (Date.now() - 31 * MIN) / 1000
  utimesSync(ctx.fileFor(chatKey), at, at)

  const compactor = createIdleCompactor({
    contextStore: ctx,
    memoryWriter: (payload) => writeToWardrobe(payload, { home }),
    scopeOf: () => ({ room: chatKey, person: '3767749705', private: true }),
    hintWriter: ({ id, scope, evidence, via }) => writeScopeHint({
      file: join(root, '鱼的记忆', 'scope-hints.json'), id, scope, evidence, via,
    }),
    stateFile: join(home, 'state.json'),
    tokenThreshold: 500,
    chats: [chatKey],
  })
  assert.equal((await compactor.tick()).length, 1)

  // 压缩后上下文里没有原文长句了，但记忆库里留下了事实
  const owner = recall({
    rootDir: root, home, query: '香菜 拉面 喜欢吃什么', limit: 8,
    audience: { kind: 'private', chatKey, person: '3767749705' },
  })
  assert.equal(owner.picked.some((entry) => String(entry.text).includes('香菜')), true, '压完 recall 仍要命中香菜')
})

test('宿主有 /compact 时就先复用它', async () => {
  const { home, ctx } = makeStore()
  const chatKey = 'private:1'
  ctx.save(chatKey, bigHistory(30))
  const at = (Date.now() - 31 * MIN) / 1000
  utimesSync(ctx.fileFor(chatKey), at, at)
  let hostCalled = 0
  const compactor = createIdleCompactor({
    contextStore: ctx,
    stateFile: join(home, 's.json'),
    tokenThreshold: 500,
    chats: [chatKey],
    hostCompact: async () => { hostCalled += 1; return { ok: true } },
  })
  const out = await compactor.tick()
  assert.equal(hostCalled, 1)
  assert.equal(out[0].hostCompact, true)
})