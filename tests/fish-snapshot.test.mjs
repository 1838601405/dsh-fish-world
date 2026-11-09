import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFishSnapshot } from '../lib/fish-snapshot.mjs'

test('动态快照：DSH 面板拿到的是当前鱼世界，不是旧构建', () => {
  const snap = buildFishSnapshot()
  assert.equal(snap.ok, true)
  assert.ok(Array.isArray(snap.roots) && snap.roots.length > 0)
  assert.equal(typeof snap.diary, 'object')
  assert.equal(typeof snap.memory, 'object')
  assert.equal(typeof snap.qq, 'object')
  assert.ok(Number(snap.diary.total) >= 0)
})
