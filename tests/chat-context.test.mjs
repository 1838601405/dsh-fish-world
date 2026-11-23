import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

// ══════════ 每会话状态：round + cooldowns（施工单 §5 判据 #5/#7；主人 2026-11-23 选 A） ══════════

test('★★ 旧格式（纯数组）文件必须一条不丢地读出来（格式升级的兼容底线）', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx3-'))
  const ctx = createChatContext({ home })

  // 直接造一个**旧格式**文件（升级前所有历史都是这个形状）
  const file = ctx.fileFor('group:old')
  mkdirSync(dirname(file), { recursive: true })
  const legacy = [
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '回了' },
    { role: 'user', content: '第二条' },
  ]
  writeFileSync(file, JSON.stringify(legacy), 'utf8')

  assert.deepEqual(ctx.load('group:old'), legacy, '★★ 逐条逐字读出，一条都不能丢')
  assert.deepEqual(ctx.state('group:old'), { round: 0, cooldowns: {}, lastAt: 0, lastHits: {} }, '★ 旧文件没有状态字段 → 给默认值')

  // 往旧文件上 append（升级路径）：历史保留 + 写成新格式
  ctx.append('group:old', { role: 'user', content: '第三条' }, { limit: 10, maxChars: 5000 })
  assert.deepEqual(ctx.load('group:old').map((m) => m.content), ['第一条', '回了', '第二条', '第三条'], '★ append 后历史仍在')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Array.isArray(raw), false, '★ 写出来已是新格式（对象）')
  assert.equal(raw.messages.length, 4)
})

test('★ bumpRound：每会话 +1，跨读写保持，且互不串台', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx4-'))
  const ctx = createChatContext({ home })
  assert.equal(ctx.state('group:a').round, 0)
  assert.equal(ctx.bumpRound('group:a'), 1)
  assert.equal(ctx.bumpRound('group:a'), 2)
  assert.equal(ctx.state('group:a').round, 2, '★ 跨读写保持')
  assert.equal(ctx.state('group:b').round, 0, '★ 别的会话不受影响')
  // 会话之间换着 bump 也不串
  ctx.bumpRound('group:b')
  assert.equal(ctx.state('group:a').round, 2)
  assert.equal(ctx.state('group:b').round, 1)
})

test('★★ save 历史不许把 round / cooldowns 清掉（否则每次存历史状态就没了）', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx5-'))
  const ctx = createChatContext({ home })
  ctx.bumpRound('group:x')
  ctx.bumpRound('group:x')
  ctx.patchState('group:x', { cooldowns: { '白饭::': 2 } })

  ctx.save('group:x', [{ role: 'user', content: '新的' }])   // ← 只换 messages

  const s = ctx.state('group:x')
  assert.equal(s.round, 2, '★★ round 还在（没被 save 冲掉）')
  assert.deepEqual(s.cooldowns, { '白饭::': 2 }, '★★ cooldowns 还在')
  assert.deepEqual(ctx.load('group:x').map((m) => m.content), ['新的'])
})

test('★ patchState：cooldowns 浅合并、round 显式给才覆盖', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx6-'))
  const ctx = createChatContext({ home })
  ctx.patchState('group:y', { cooldowns: { a: 1, b: 1 }, round: 5 })
  ctx.patchState('group:y', { cooldowns: { b: 9, c: 3 } })     // 只给 cooldowns

  const s = ctx.state('group:y')
  assert.deepEqual(s.cooldowns, { a: 1, b: 9, c: 3 }, '★ 浅合并（b 覆盖、a 保留、c 新增）')
  assert.equal(s.round, 5, '★ 没给 round 就不动')

  ctx.patchState('group:y', { round: 7 })
  assert.equal(ctx.state('group:y').round, 7)
})

test('★ state 返回的是副本（改它不影响存的）+ clear 连状态一起重置', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx7-'))
  const ctx = createChatContext({ home })
  ctx.patchState('group:z', { cooldowns: { k: 1 }, round: 3, lastAt: 5000 })

  const s = ctx.state('group:z')
  s.cooldowns.k = 999
  s.round = 999
  s.lastAt = 999
  s.lastHits['x'] = 1
  assert.deepEqual(ctx.state('group:z'), { round: 3, cooldowns: { k: 1 }, lastAt: 5000, lastHits: {} }, '★ 副本改了不影响存的')

  ctx.clear('group:z')
  assert.deepEqual(ctx.state('group:z'), { round: 0, cooldowns: {}, lastAt: 0, lastHits: {} }, '★★ clear = 新会话，状态一起归零')
  assert.deepEqual(ctx.load('group:z'), [])
})

test('★★ §3.1 时间感的落点：lastAt 跨读写保持 + 只在显式给时覆盖', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-chat-ctx8-'))
  const ctx = createChatContext({ home })

  assert.equal(ctx.state('group:t').lastAt, 0, '★ 初始 0（没有上一轮）')
  ctx.patchState('group:t', { lastAt: 1700000000000 })
  assert.equal(ctx.state('group:t').lastAt, 1700000000000, '★ 写进去')

  // 存历史不能把它冲掉（同 round/cooldowns 的教训）
  ctx.save('group:t', [{ role: 'user', content: '新的' }])
  assert.equal(ctx.state('group:t').lastAt, 1700000000000, '★★ save 历史不许清 lastAt')

  // 没给 lastAt 就不动
  ctx.patchState('group:t', { round: 5 })
  assert.equal(ctx.state('group:t').lastAt, 1700000000000, '★ 没给就不覆盖')
  assert.equal(ctx.state('group:t').round, 5)
})
