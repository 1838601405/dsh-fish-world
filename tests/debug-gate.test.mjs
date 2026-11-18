// 排障页安全模型（herframe 设计移植）判据。
// 默认锁 / 423 / 登记理由解锁 30 分钟 / 到期自动回封 / 审计落 UI 自己的根。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDebugGate, HTTP_LOCKED, UNLOCK_MS } from '../lib/debug-gate.mjs'

function mk(nowRef = { at: 1_700_000_000_000 }) {
  const uiRoot = mkdtempSync(join(tmpdir(), 'dbg-ui-'))
  const gate = createDebugGate({ uiRoot, now: () => nowRef.at })
  return { uiRoot, gate, nowRef }
}

test('默认就是锁着的', () => {
  const { gate } = mk()
  const st = gate.status()
  assert.equal(st.locked, true)
  assert.equal(st.remainingMs, 0)
})

test('未解锁时 guard 返回 423（不是 403）', () => {
  const { gate } = mk()
  const g = gate.guard()
  assert.ok(g, '锁着时必须有拦截结果')
  assert.equal(g.code, HTTP_LOCKED)
  assert.equal(g.code, 423, '423 = 存在但需解锁；403 = 永远没权限。排障属于前者')
  assert.match(g.body.error, /锁着/)
  // 响应体要告诉人怎么解锁，否则只有「锁着」没法往下走
  assert.match(g.body.hint, /解锁/)
})

test('不给理由不解锁', () => {
  const { gate } = mk()
  assert.equal(gate.unlock('').ok, false)
  assert.equal(gate.unlock('  ').ok, false)
  assert.equal(gate.unlock('看').ok, false, '一个字太短，要求至少两个字')
  assert.equal(gate.status().locked, true)
})

test('登记理由后解锁 30 分钟', () => {
  const nowRef = { at: 1_700_000_000_000 }
  const { gate } = mk(nowRef)
  const r = gate.unlock('排查 QQ 掉线')
  assert.equal(r.ok, true)
  assert.equal(r.status.locked, false)
  assert.equal(r.status.reason, '排查 QQ 掉线')
  // 30 分钟 = 1800 秒
  assert.equal(r.status.unlockSeconds, 1800)
  assert.equal(Math.round(UNLOCK_MS / 1000), 1800)
  assert.equal(gate.guard(), null, '解锁后要放行')
})

test('到期自动回封（不用手动关）', () => {
  const nowRef = { at: 1_700_000_000_000 }
  const { gate } = mk(nowRef)
  gate.unlock('排查')
  // 29 分钟：还开着
  nowRef.at += 29 * 60 * 1000
  assert.equal(gate.status().locked, false)
  // 31 分钟：自动关
  nowRef.at += 2 * 60 * 1000
  assert.equal(gate.status().locked, true)
  assert.equal(gate.guard()?.code, 423)
})

test('可以手动回封', () => {
  const { gate } = mk()
  gate.unlock('看看')
  assert.equal(gate.status().locked, false)
  gate.lock('不想看了')
  assert.equal(gate.status().locked, true)
})

test('审计写在 UI 自己的数据根，不在鱼的库', () => {
  const { uiRoot, gate } = mk()
  gate.unlock('排查同步失败')
  const auditFile = join(uiRoot, '排障', '审计.jsonl')
  assert.ok(existsSync(auditFile), '审计要落在 <uiRoot>/排障/')
  const text = readFileSync(auditFile, 'utf8')
  assert.match(text, /排查同步失败/)
  assert.match(text, /unlock/)
  // 不能写进世界根（鱼的记忆/日记/关系）
  assert.doesNotMatch(auditFile, /鱼的记忆|鱼的日记|鱼的关系/)
})

test('审计能读回来，含理由与到期时间', () => {
  const { gate } = mk()
  gate.unlock('排查 A')
  gate.lock('完事')
  const list = gate.readAudit(10)
  assert.ok(list.length >= 2)
  const unlockEntry = list.find((e) => e.kind === 'unlock')
  assert.equal(unlockEntry.reason, '排查 A')
  assert.ok(unlockEntry.until, '要记下到期时间')
})

test('锁着也记审计（谁想看看不成）', () => {
  const { uiRoot, gate } = mk()
  gate.log('尝试访问排障页被拒')
  const text = readFileSync(join(uiRoot, '排障', '审计.jsonl'), 'utf8')
  assert.match(text, /被拒/)
})

test('理由超长要拒（防塞大段文本）', () => {
  const { gate } = mk()
  assert.equal(gate.unlock('x'.repeat(300)).ok, false)
})
