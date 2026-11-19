// 跨平台心跳判据（2026-11-20 主人指出）。
//
// 问题：桌面版写 %APPDATA%\大肥鱼\qq-heartbeat.json，插件版不写
// ⇒ 面板在插件模式下一直显示「心跳停了」，是误报。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  createHeartbeatWriter,
  defaultHeartbeatFile
} from '../lib/heartbeat.mjs'

function mk(nowRef = { at: Date.now() }) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-'))
  const file = join(dir, 'qq-heartbeat.json')
  const logs = []
  const w = createHeartbeatWriter({ file, now: () => nowRef.at, log: (l) => logs.push(l) })
  return { dir, file, w, nowRef, logs }
}

test('写一次：文件出现，含 at 与 source=plugin', () => {
  const { file, w } = mk()
  const r = w.writeOnce()
  assert.equal(r.ok, true)
  assert.ok(existsSync(file), '要真写出文件')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(raw.at, '要有 at')
  assert.equal(raw.source, 'plugin', '要标明是插件写的')
  w.stop()
})

test('与桌面版同一个文件格式（旧面板只读 at 也能用）', () => {
  const { file, w } = mk()
  w.writeOnce()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  // 桌面版写的是 {"at": "ISO"} —— 新文件必须仍含 at 且能被 Date.parse
  assert.ok(Number.isFinite(Date.parse(raw.at)), 'at 必须是能解析的 ISO 时间')
  w.stop()
})

test('status：刚写的不算 stale', () => {
  const { w } = mk()
  w.writeOnce()
  const s = w.status()
  assert.equal(s.exists, true)
  assert.equal(s.stale, false)
  assert.equal(s.source, 'plugin')
  w.stop()
})

test('status：超过阈值算 stale（面板据此显示「停了」）', () => {
  const nowRef = { at: Date.now() }
  const { w } = mk(nowRef)
  w.writeOnce()
  nowRef.at += HEARTBEAT_STALE_MS + 60_000
  assert.equal(w.status().stale, true, '超阈值要判 stale')
  w.stop()
})

test('文件不存在 → stale=true，不炸', () => {
  const { w } = mk()
  const s = w.status()
  assert.equal(s.exists, false)
  assert.equal(s.stale, true)
  assert.equal(s.ok, true, '缺文件不是错误，只是没心跳')
  w.stop()
})

test('文件坏了 → ok=false 但仍报 stale（不吞）', () => {
  const { file, w } = mk()
  writeFileSync(file, '{ 坏掉的 json', 'utf8')
  const s = w.status()
  assert.equal(s.exists, true)
  assert.equal(s.stale, true)
  assert.equal(s.ok, false, '要如实说读不出来')
  assert.ok(s.error)
  w.stop()
})

test('桌面版写的内容也能被这里读（反向兼容）', () => {
  const nowRef = { at: Date.now() }
  const { file, w } = mk(nowRef)
  // 模拟桌面版写的：只有 at，没有 source
  writeFileSync(file, JSON.stringify({ at: new Date(nowRef.at).toISOString() }), 'utf8')
  const s = w.status()
  assert.equal(s.stale, false, '桌面版写的也要能认出来')
  assert.equal(s.source, 'desktop', '没有 source 就按桌面版算')
  w.stop()
})

test('原子写：不留下临时文件', () => {
  const { dir, w } = mk()
  w.writeOnce()
  const names = readdirSync(dir)
  assert.ok(names.includes('qq-heartbeat.json'), '要写出正式文件')
  assert.equal(names.filter((n) => n.endsWith('.tmp')).length, 0, '不许留下 .tmp')
  w.stop()
})

test('start 会立刻写一次（面板马上能看到）', () => {
  const { file, w } = mk()
  w.start()
  assert.ok(existsSync(file), 'start 后应立即有文件')
  w.stop()
})

test('stop 后不再写', async () => {
  const nowRef = { at: Date.now() }
  const { file, w } = mk(nowRef)
  w.start()
  const first = readFileSync(file, 'utf8')
  w.stop()
  nowRef.at += 120_000
  await new Promise((r) => setTimeout(r, 50))
  const after = readFileSync(file, 'utf8')
  assert.equal(after, first, 'stop 之后不该再改文件')
})

test('写失败要留痕（不静默）', () => {
  const w = createHeartbeatWriter({
    // 非法路径：盘符不存在
    file: 'Z:/definitely-not-a-drive/x/qq-heartbeat.json',
    log: () => {}
  })
  const logs = []
  const w2 = createHeartbeatWriter({
    file: 'Z:/definitely-not-a-drive/x/qq-heartbeat.json',
    log: (l) => logs.push(l)
  })
  const r = w2.writeOnce()
  assert.equal(r.ok, false)
  assert.ok(logs.length > 0, '写失败要留日志')
  w.stop()
  w2.stop()
})

test('没给路径 → 明确报错，不静默', () => {
  const w = createHeartbeatWriter({ file: '' })
  const r = w.writeOnce()
  assert.equal(r.ok, false)
  assert.match(r.error, /路径/)
  w.stop()
})

test('配置常量合理', () => {
  assert.ok(HEARTBEAT_INTERVAL_MS >= 30_000, '写盘不能太频繁')
  assert.ok(HEARTBEAT_STALE_MS > HEARTBEAT_INTERVAL_MS * 3, 'stale 阈值要容得下多次漏写')
})

test('默认路径指向 %APPDATA%\\大肥鱼（与桌面版同一个文件）', () => {
  const p = defaultHeartbeatFile()
  assert.match(p, /大肥鱼/, '要在同一个目录')
  assert.match(p, /qq-heartbeat\.json$/, '要叫同一个文件名')
})

test('目标路径是个目录 → 写失败要留痕', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-bad-'))
  const logs = []
  const w = createHeartbeatWriter({ file: dir, log: (l) => logs.push(l) })
  const r = w.writeOnce()
  assert.equal(r.ok, false, '写不进去要报失败')
  assert.ok(logs.length > 0, '要留日志')
  w.stop()
})
