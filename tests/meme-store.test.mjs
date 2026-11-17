import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addCandidate, setStatus, listByStatus } from '../lib/meme-store.mjs'

function kb(items = []) {
  const dir = mkdtempSync(join(tmpdir(), 'meme-'))
  const file = join(dir, '知识库.json')
  writeFileSync(file, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
  return file
}
const src = '群 肘击全世界(681145756) · 2026-11-17 23:40 · 墨墨：他说这叫「赛博上坟」'

test('新梗写进去是 pending，带原句和来源', () => {
  const file = kb()
  const r = addCandidate({ file, candidate: { name: '赛博上坟', kind: 'meme', why: '引号新词', sentence: '他说这叫「赛博上坟」' }, source: src })
  assert.equal(r.action, 'new')
  const items = listByStatus(file, 'pending')
  assert.equal(items.length, 1)
  assert.equal(items[0].name, '赛博上坟')
  assert.equal(items[0].type, 'meme')
  assert.match(items[0].source, /681145756/)
  assert.match(items[0].quote, /赛博上坟/)
})

test('同一个梗再来一次只加别名，不重复建条目', () => {
  const file = kb([{ id: 'x', name: 'v我50', aliases: [], type: 'meme' }])
  const r = addCandidate({ file, candidate: { name: 'v我50', kind: 'meme' }, source: src })
  assert.equal(r.action, 'alias')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.items.length, 1)
  assert.equal(raw.items[0].name, 'v我50')
})

test('别名命中也不新建', () => {
  const file = kb([{ id: 'x', name: '疯狂星期四', aliases: ['v我50'] }])
  const r = addCandidate({ file, candidate: { name: 'v我50', kind: 'meme' }, source: src })
  assert.equal(r.action, 'alias')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items.length, 1)
})

test('确认 / 拒绝改状态，拒绝的不再出现在 pending 列表', () => {
  const file = kb()
  addCandidate({ file, candidate: { name: '赛博上坟', kind: 'meme' }, source: src })
  addCandidate({ file, candidate: { name: '抽象', kind: 'meme' }, source: src })
  const pend = listByStatus(file, 'pending')
  assert.equal(pend.length, 2)
  setStatus({ file, id: pend[0].id, status: 'confirmed' })
  setStatus({ file, id: pend[1].id, status: 'rejected' })
  assert.equal(listByStatus(file, 'pending').length, 0)
  assert.equal(listByStatus(file, 'confirmed').length, 1)
  assert.equal(listByStatus(file, 'rejected').length, 1)
})
