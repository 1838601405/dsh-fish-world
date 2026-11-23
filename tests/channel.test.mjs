// 通道契约判据（2026-11-23《发给 AI.md》任务二 ① 验收 2）。
//
// ★ 验收 2 原文：「加一个只 echo 的假通道（`echo`），能让它完整收发一轮，
//   且**不需要改内核的任何代码**。」
//   ⇒ 「不改内核」的判据怎么落？**本文件就是证明**：内核（lib/channel.mjs）里
//   没有任何 qq/panel/mobile/orb/echo 的具体判断 —— 新通道只经 `register` 进来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createChannelRegistry, createEchoChannel, messageFingerprint } from '../lib/channel.mjs'

const here = dirname(fileURLToPath(import.meta.url))

test('★★ 验收#2：echo 假通道能完整收发一轮', async () => {
  const registry = createChannelRegistry()
  const { channel, received, sent } = createEchoChannel()
  const reg = registry.register(channel)
  assert.equal(reg.ok, true)

  // ① 收：平台形状 → 内部消息
  const got = await registry.receive('echo', { chatKey: 'echo:1', text: '在吗', userId: '42', nickname: '某人' })
  assert.equal(got.ok, true, '★ 收成功')
  assert.equal(got.message.channelId, 'echo', '★ 归一后带 channelId')
  assert.equal(got.message.text, '在吗')
  assert.equal(got.message.userId, '42')
  assert.equal(got.message.nickname, '某人')
  assert.equal(received.length, 1, '★ 通道确实收到了')

  // ② 发：内部回包 → 平台动作
  const out = await registry.send('echo', { text: '在' })
  assert.equal(out.ok, true, '★ 发成功')
  assert.equal(sent.length, 1, '★ 通道确实发出了')
  assert.deepEqual(sent[0].echo, { text: '在' }, '★ 回声原样带回')
})

test('★★ 验收#2：「不需要改内核的任何代码」——内核里没有平台名', () => {
  const src = readFileSync(join(here, '..', 'lib', 'channel.mjs'), 'utf8')
  // 内核（registry/receive/send）不该出现具体平台 id
  // ★ 只查**代码行**（注释里提到平台名是允许且必要的 —— 说明性文字不算实现）
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
      return true
    })
    .join('\n')
  for (const name of ['qq', 'panel', 'mobile', 'orb']) {
    assert.equal(new RegExp(`['"\`]${name}['"\`]`).test(code), false,
      `★ 内核不该硬编码平台「${name}」—— 加通道不许改内核`)
  }
  // 通道是**注册**进来的（有 register，没有 if (id === 'qq') 这类分派）
  assert.match(code, /function register\(/, '★ 要有注册入口')
  assert.equal(/if\s*\(\s*\w+\s*===\s*['"]qq['"]/.test(code), false, '★ 不许按平台 id 分派')
})

test('★ 注册：id 不合法 / 重复 / 既不收也不发 → 都拒且说清', () => {
  const registry = createChannelRegistry()
  assert.equal(registry.register({ id: 'echo', send: async () => ({}) }).ok, true)

  const dup = registry.register({ id: 'echo', send: async () => ({}) })
  assert.equal(dup.ok, false)
  assert.match(dup.error, /已注册/)

  const badId = registry.register({ id: 'QQ 通道', send: async () => ({}) })
  assert.equal(badId.ok, false)
  assert.match(badId.error, /id 不合法/)

  const empty = registry.register({ id: 'nothing' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /既没有 receive 也没有 send/)

  assert.deepEqual(registry.list(), ['echo'], '★ 只有注册成功的在册')
  assert.equal(registry.size(), 1)
})

test('★ 收发到不存在的通道 / 只收不发 / 只发不收 → 如实说，不炸', async () => {
  const registry = createChannelRegistry()
  const noCh = await registry.receive('nope', { text: 'x' })
  assert.equal(noCh.ok, false)
  assert.match(noCh.error, /没有这个通道/)

  registry.register({ id: 'onlyrecv', receive: async (raw) => ({ chatKey: 'k', text: String(raw?.text || '') }) })
  registry.register({ id: 'onlysend', send: async () => ({ ok: true }) })

  const r1 = await registry.receive('onlyrecv', { text: 'hi' })
  assert.equal(r1.ok, true)
  const s1 = await registry.send('onlyrecv', { text: 'x' })
  assert.equal(s1.ok, false, '★ 只收不发要说清')
  assert.match(s1.error, /不发/)

  const s2 = await registry.send('onlysend', { text: 'x' })
  assert.equal(s2.ok, true)
  const r2 = await registry.receive('onlysend', { text: 'x' })
  assert.equal(r2.ok, false, '★ 只发不收要说清')
  assert.match(r2.error, /不收/)
})

test('★ 通道抛错 → registry 不炸，如实带回原因', async () => {
  const registry = createChannelRegistry()
  registry.register({ id: 'boom', receive: async () => { throw new Error('炸了') }, send: async () => { throw new Error('也炸了') } })
  const r = await registry.receive('boom', {})
  assert.equal(r.ok, false)
  assert.match(r.error, /炸了/)
  const s = await registry.send('boom', {})
  assert.equal(s.ok, false)
  assert.match(s.error, /也炸了/)
})

test('★ receive 没给出内部消息 → 拒（不能让内核收到半成品）', async () => {
  const registry = createChannelRegistry()
  registry.register({ id: 'bad', receive: async () => null })
  const r = await registry.receive('bad', {})
  assert.equal(r.ok, false)
  assert.match(r.error, /没给出内部消息/)
})

test('★ messageFingerprint：同内容同指纹、不同内容不同（排查/测试用）', () => {
  const a = { chatKey: 'k', text: '你好', userId: '1' }
  const b = { chatKey: 'k', text: '你好', userId: '1' }
  const c = { chatKey: 'k', text: '你好呀', userId: '1' }
  assert.equal(messageFingerprint(a), messageFingerprint(b), '★ 同内容同指纹')
  assert.notEqual(messageFingerprint(a), messageFingerprint(c), '★ 不同内容不同指纹')
})
