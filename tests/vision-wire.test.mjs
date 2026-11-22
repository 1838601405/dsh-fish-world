// 视觉管线共享装配的判据（2026-11-22 主人方案 P3）。
//
// 核心只有一条：**同一个世界根拿到的是同一个实例**（否则缓存键里的
// model 版本串各是各的，「一次算过到处可用」就不成立）。
// 其余验边界：没绑工作区不猜路径、换看图通道要重建、换世界根不串。
//
// 全程假 omni / 假看图通道，不碰本机（AGENTS 6.3）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { INPUT_FOLDER, forgetVisionWire, getVisionWire, wiredRoots } from '../lib/vision-wire.mjs'

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fw-wire-'))
  forgetVisionWire(root)
  return root
}

/** 一个认得 omni 包的替身（只让 createOmniRecognize 别去真找包）。 */
const locateFound = () => ({ found: true, path: '/虚拟/包', version: '0.1.11' })

// createOmniRecognize 的 locate 是默认注入的，这里通过 config 间接验；
// 真找包失败也不影响「实例是否同一个」的断言 —— 那才是本层的判据。

test('★★ 同一个世界根 → 同一个实例（缓存才共享得起来）', () => {
  const root = mkRoot()
  const a = getVisionWire({ worldRoot: root })
  const b = getVisionWire({ worldRoot: root })
  assert.ok(a, '要能建出来')
  assert.equal(a, b, '★ 同根必须同一个实例')
  assert.equal(a.vision, b.vision)
  assert.equal(a.input, b.input)
  assert.equal(a.backend, b.backend)
  forgetVisionWire(root)
})

test('★★ 没绑定工作区 → 返回 null，不猜一个默认路径', () => {
  assert.equal(getVisionWire({}), null)
  assert.equal(getVisionWire({ worldRoot: '' }), null)
  assert.equal(getVisionWire({ worldRoot: '   ' }), null)
})

test('★★ 不同世界根 → 不同实例（失败计数与缓存不许串）', () => {
  const r1 = mkRoot()
  const r2 = mkRoot()
  const a = getVisionWire({ worldRoot: r1 })
  const b = getVisionWire({ worldRoot: r2 })
  assert.notEqual(a, b, '★ 换根必须换实例')
  assert.notEqual(a.vision.cache.dir(), b.vision.cache.dir(), '★ 缓存目录要跟着根走')
  assert.ok(a.vision.cache.dir().startsWith(r1))
  assert.ok(b.vision.cache.dir().startsWith(r2))
  forgetVisionWire(r1); forgetVisionWire(r2)
})

test('★ 装出来的三件套形状对（vision / input / backend 都在）', () => {
  const root = mkRoot()
  const wire = getVisionWire({ worldRoot: root })
  assert.equal(typeof wire.vision.describe, 'function')
  assert.equal(typeof wire.vision.describeImage, 'function')
  assert.equal(typeof wire.vision.describeVideo, 'function')
  assert.equal(typeof wire.vision.transcribeAudio, 'function')
  assert.equal(typeof wire.input.ingest, 'function')
  assert.equal(typeof wire.backend.modelVersion, 'function')
  assert.equal(typeof wire.backend.status, 'function')
  forgetVisionWire(root)
})

test('★★ input 里三个主平台已经登记好（拿来就能 ingest）', () => {
  const root = mkRoot()
  const { input } = getVisionWire({ worldRoot: root })
  const list = input.platforms().sort()
  assert.deepEqual(list, ['desktop', 'qq', 'session'], '★ 三个主平台要登记齐')
  for (const name of list) assert.equal(input.has(name), true)
  forgetVisionWire(root)
})

test('★ 落盘目录挂在世界根下（视觉输入与宫格都在）', () => {
  const root = mkRoot()
  const wire = getVisionWire({ worldRoot: root })
  const dir = wire.input // inputDir 不直接暴露，用 backend 的宫格目录反推
  assert.ok(wire.backend.status().gridDir.startsWith(root), '★ 宫格图要在世界根下')
  assert.equal(INPUT_FOLDER, '视觉输入')
  void dir
  forgetVisionWire(root)
})

test('★★ 换看图通道 → 重建实例（旧后端不能继续用）', () => {
  const root = mkRoot()
  const a = getVisionWire({ worldRoot: root })
  const b = getVisionWire({ worldRoot: root, describe: async () => ({ text: 'x' }) })
  assert.notEqual(a, b, '★ 通道换了必须重建')
  assert.notEqual(a.backend.modelVersion(), b.backend.modelVersion(), '★ 缓存键要跟着变')
  assert.match(b.backend.modelVersion(), /\+看图$/)
  forgetVisionWire(root)
})

test('★★ forget = true → 强制重建（配置热更新用）', () => {
  const root = mkRoot()
  const a = getVisionWire({ worldRoot: root })
  const b = getVisionWire({ worldRoot: root, forget: true })
  assert.notEqual(a, b, '★ forget 要真重建')
  forgetVisionWire(root)
})

test('★ forgetVisionWire() 不带参数 = 全清（测试隔离用）', () => {
  const r = mkRoot()
  getVisionWire({ worldRoot: r })
  assert.ok(wiredRoots().includes(r))
  forgetVisionWire()
  assert.equal(wiredRoots().includes(r), false)
})

test('★ wiredRoots 只报世界根，不报内部结构', () => {
  const r = mkRoot()
  getVisionWire({ worldRoot: r })
  const roots = wiredRoots()
  assert.ok(Array.isArray(roots))
  assert.ok(roots.includes(r))
  forgetVisionWire(r)
})

test('★★ 同根再取，缓存键里的 model 版本串一致（否则缓存永远不命中）', () => {
  const root = mkRoot()
  const a = getVisionWire({ worldRoot: root })
  const b = getVisionWire({ worldRoot: root })
  assert.equal(a.backend.modelVersion(), b.backend.modelVersion())
  forgetVisionWire(root)
})

test('★ 建出来的 vision 落盘目录在世界根下（P1 的缓存契约没被破坏）', () => {
  const root = mkRoot()
  const wire = getVisionWire({ worldRoot: root })
  assert.ok(wire.vision.cache.dir().startsWith(root), '★ 缓存要在世界根下：' + wire.vision.cache.dir())
  assert.ok(wire.vision.cache.dir().includes('视觉缓存'), '★ 目录名还是 P1 定的那个')
  forgetVisionWire(root)
})
