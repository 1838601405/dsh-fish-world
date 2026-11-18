// 出口闸单点（herframe 设计移植）判据。
// 六道闸顺序：时段 → 额度 → 群闸 → 重复 → 敏感 → 放行；wrap 之后不可能绕过。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GATE, createOutboundGate, inQuietHours } from '../lib/outbound-gate.mjs'

function mk(cfg = {}, nowRef = { at: Date.parse('2026-11-19T14:00:00+08:00') }) {
  const blocked = []
  const gate = createOutboundGate({
    config: () => cfg,
    now: () => nowRef.at,
    log: (info) => blocked.push(info)
  })
  return { gate, cfg, nowRef, logged: blocked }
}

// ─── 时段 ───

test('inQuietHours：普通时段与跨零点时段都对', () => {
  const at2300 = Date.parse('2026-11-19T23:00:00+08:00')
  const at0300 = Date.parse('2026-11-19T03:00:00+08:00')
  const at1400 = Date.parse('2026-11-19T14:00:00+08:00')
  // 跨零点：23:00-07:00
  assert.equal(inQuietHours(at2300, '23:00-07:00'), true)
  assert.equal(inQuietHours(at0300, '23:00-07:00'), true)
  assert.equal(inQuietHours(at1400, '23:00-07:00'), false)
  // 不跨零点：13:00-15:00
  assert.equal(inQuietHours(at1400, '13:00-15:00'), true)
  assert.equal(inQuietHours(at2300, '13:00-15:00'), false)
  // 空配置不拦
  assert.equal(inQuietHours(at0300, ''), false)
})

test('安静时段被拦，gate 标成 quiet-hours', () => {
  const { gate } = mk({ quietHours: '23:00-07:00' })
  const r = gate.check({ chatKey: 'private:1', text: '在吗', at: Date.parse('2026-11-19T03:00:00+08:00') })
  assert.equal(r.ok, false)
  assert.equal(r.gate, GATE.QUIET)
})

test('时段排最前：即使额度也满了，报的是时段', () => {
  const { gate } = mk({ quietHours: '23:00-07:00', maxPerHour: 1 })
  const at = Date.parse('2026-11-19T03:00:00+08:00')
  const r = gate.check({ chatKey: 'private:1', text: 'x', at })
  assert.equal(r.gate, GATE.QUIET, '顺序要对：时段在额度之前')
})

// ─── 额度 ───

test('每小时额度用完就拦', () => {
  const { gate, nowRef } = mk({ maxPerHour: 2 })
  assert.equal(gate.check({ chatKey: 'private:1', text: 'a' }).ok, true)
  gate.noteSent({ chatKey: 'private:1', text: 'a' })
  assert.equal(gate.check({ chatKey: 'private:1', text: 'b' }).ok, true)
  gate.noteSent({ chatKey: 'private:1', text: 'b' })
  const r = gate.check({ chatKey: 'private:1', text: 'c' })
  assert.equal(r.ok, false)
  assert.equal(r.gate, GATE.QUOTA)
  // 过了一小时又能发
  nowRef.at += 3600_000 + 1
  assert.equal(gate.check({ chatKey: 'private:1', text: 'd' }).ok, true)
})

test('每天额度独立于每小时', () => {
  const { gate, nowRef } = mk({ maxPerDay: 2 })
  gate.noteSent({ chatKey: 'private:1', text: 'a' })
  nowRef.at += 3600_000
  gate.noteSent({ chatKey: 'private:1', text: 'b' })
  nowRef.at += 3600_000
  const r = gate.check({ chatKey: 'private:1', text: 'c' })
  assert.equal(r.gate, GATE.QUOTA)
  assert.match(r.reason, /每天/)
})

test('额度按会话分别算', () => {
  const { gate } = mk({ maxPerHour: 1 })
  gate.noteSent({ chatKey: 'private:1', text: 'a' })
  assert.equal(gate.check({ chatKey: 'private:1', text: 'b' }).ok, false)
  assert.equal(gate.check({ chatKey: 'private:2', text: 'b' }).ok, true, '别的会话不该被连坐')
})

// ─── 群闸 ───

test('群内限额只对群生效', () => {
  const { gate } = mk({ groupMaxPerHour: 1 })
  gate.noteSent({ chatKey: 'group:99', text: 'a' })
  assert.equal(gate.check({ chatKey: 'group:99', text: 'b', kind: 'group' }).ok, false)
  // 私聊不受群限额影响
  assert.equal(gate.check({ chatKey: 'private:1', text: 'b' }).ok, true)
})

// ─── 重复 ───

test('同一句短时间重复发被拦', () => {
  const { gate, nowRef } = mk({})
  assert.equal(gate.check({ chatKey: 'private:1', text: '好耶' }).ok, true)
  assert.equal(gate.check({ chatKey: 'private:1', text: '好耶' }).ok, false)
  // 过了窗口又能发
  nowRef.at += 61_000
  assert.equal(gate.check({ chatKey: 'private:1', text: '好耶' }).ok, true)
})

test('不同会话说同一句不算重复', () => {
  const { gate } = mk({})
  assert.equal(gate.check({ chatKey: 'private:1', text: '好耶' }).ok, true)
  assert.equal(gate.check({ chatKey: 'private:2', text: '好耶' }).ok, true)
})

// ─── 敏感 ───

test('凭据形态的内容被拦', () => {
  const { gate } = mk({})
  assert.equal(gate.check({ chatKey: 'private:1', text: 'sk-abcdefghijklmnopqrstuvwx' }).gate, GATE.SENSITIVE)
  assert.equal(gate.check({ chatKey: 'private:1', text: '密码: abcdef123' }).gate, GATE.SENSITIVE)
  assert.equal(gate.check({ chatKey: 'private:1', text: 'Bearer abcdefghijklmnopqrstuvwxyz' }).gate, GATE.SENSITIVE)
})

test('普通话不被敏感闸误拦', () => {
  const { gate } = mk({})
  for (const text of ['今天好累', '吃了吗', '我去做饭了', '哈哈哈哈']) {
    assert.equal(gate.check({ chatKey: 'private:1', text }).ok, true, text + ' 不该被拦')
  }
})

test('空消息不发（不算闸，是常识）', () => {
  const { gate } = mk({})
  assert.equal(gate.check({ chatKey: 'private:1', text: '' }).ok, false)
  assert.equal(gate.check({ chatKey: 'private:1', text: '   ' }).ok, false)
})

// ─── wrap：不可能绕过 ───

test('wrap 后被拦的不调用底层发送', async () => {
  // ★ 把时钟设到安静时段之内（默认 mk 是 14:00，不在 23:00-07:00 里）。
  const at = Date.parse('2026-11-19T03:00:00+08:00')
  const gate = createOutboundGate({
    config: () => ({ quietHours: '23:00-07:00' }),
    now: () => at,
    log: () => {}
  })
  let called = 0
  const send = gate.wrap(async () => { called++; return { ok: true } })
  const r = await send('private:1', [{ type: 'text', text: 'hi' }])
  assert.equal(called, 0, '被拦下就不该真发')
  assert.equal(r.ok, false)
  assert.equal(r.blocked, true)
  assert.equal(r.gate, GATE.QUIET)
})

test('wrap 通过时真发并记账', async () => {
  const { gate } = mk({ maxPerHour: 1 })
  let called = 0
  const send = gate.wrap(async () => { called++; return { ok: true } })
  const r1 = await send('private:1', [{ type: 'text', text: 'hi' }])
  assert.equal(r1.ok, true)
  assert.equal(called, 1)
  // 额度已用掉，第二次被拦
  const r2 = await send('private:1', [{ type: 'text', text: 'again' }])
  assert.equal(r2.blocked, true)
  assert.equal(called, 1, '第二次不该真发')
})

test('发送失败不占额度', async () => {
  const { gate } = mk({ maxPerHour: 1 })
  const send = gate.wrap(async () => ({ ok: false, error: '网络错' }))
  const r1 = await send('private:1', [{ type: 'text', text: 'hi' }])
  assert.equal(r1.ok, false)
  // 失败没记账 → 下一句还能发
  const send2 = gate.wrap(async () => ({ ok: true }))
  const r2 = await send2('private:1', [{ type: 'text', text: 'hi2' }])
  assert.equal(r2.ok, true, '失败不该吃掉额度')
})

test('wrap 能识别多段里的文字（图片段不算文字）', async () => {
  const { gate } = mk({})
  const seen = []
  const send = gate.wrap(async (k, segs) => { seen.push(segs); return { ok: true } })
  await send('private:1', [{ type: 'image', file: 'a.png' }, { type: 'text', text: '看图' }])
  assert.equal(seen[0].length, 2)
})
