import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import test from 'node:test'
import { listDir, listRoots } from '../lib/fspick.mjs'

test('listRoots reports the home directory and existing shortcuts', () => {
  const info = listRoots()
  assert.equal(info.ok, true)
  assert.ok(info.home)
  assert.ok(Array.isArray(info.roots) && info.roots.length >= 1)
  assert.ok(Array.isArray(info.shortcuts))
})

test('listDir only returns directories, never files', () => {
  const base = mkdtempSync(join(tmpdir(), 'fw-fspick-'))
  mkdirSync(join(base, '子目录'))
  writeFileSync(join(base, 'a.txt'), 'x')

  const result = listDir(base)
  assert.equal(result.ok, true)
  assert.deepEqual(result.entries.map((entry) => entry.name), ['子目录'])
  assert.equal(result.root, parse(base).root)
})

test('listDir rejects a missing directory and reports the path', () => {
  const result = listDir(join(tmpdir(), 'definitely-not-here-' + Date.now()))
  assert.equal(result.ok, false)
  assert.match(result.error, /不存在/)
})

test('listDir returns the parent so the picker can go up', () => {
  const base = mkdtempSync(join(tmpdir(), 'fw-fspick-up-'))
  const child = join(base, 'child')
  mkdirSync(child)
  const result = listDir(child)
  assert.equal(result.parent, base)
})
