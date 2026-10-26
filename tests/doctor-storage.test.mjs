// 目录与索引审计：缺目录、不可写、索引损坏都要如实报出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage, GALLERY_FOLDER, SITES_FOLDER } from '../lib/storage.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-audit-'))
  const storage = createStorage({ home, config: () => ({}), world: { root: () => '' } })
  return { home, storage }
}

test('全新环境：目录都不存在，审计不通过', () => {
  const { storage } = fresh()
  const audit = storage.audit()
  assert.equal(audit.ok, false)
  assert.equal(audit.exists, false)
  assert.equal(audit.dirs.length, 7, '含知识库目录：建立目录要一次建全，面板才不会一直说「知识库还没建」')
  assert.ok(audit.dirs.every((dir) => dir.exists === false))
  assert.ok(audit.problems.some((p) => /缺少目录/.test(p.text)))
})

test('ensure 之后目录齐全且可写', () => {
  const { storage } = fresh()
  storage.ensure()
  const audit = storage.audit()
  assert.equal(audit.ok, true, JSON.stringify(audit.problems))
  assert.equal(audit.exists, true)
  assert.ok(audit.dirs.every((dir) => dir.exists && dir.isDir), '每个目录都应存在且是目录')
  assert.ok(audit.dirs.every((dir) => dir.writable), '每个目录都应可写')
})

test('ensure 会建立「鱼的成长」目录', () => {
  const { storage } = fresh()
  storage.ensure()
  const audit = storage.audit()
  const growth = audit.dirs.find((dir) => dir.key === 'growth')
  assert.equal(growth.exists, true, '鱼的成长目录应该被建立')
})

test('索引缺失视为正常（全新环境本来就没有）', () => {
  const { storage } = fresh()
  storage.ensure()
  const audit = storage.audit()
  assert.ok(audit.indexes.every((index) => index.valid === true))
  assert.ok(audit.indexes.every((index) => index.exists === false))
  assert.equal(audit.problems.length, 0, '缺索引不该算问题')
})

test('索引损坏会被标出来', () => {
  const { storage } = fresh()
  const paths = storage.ensure()
  writeFileSync(join(paths.gallery, 'stickers.json'), '{ this is not json', 'utf8')
  const audit = storage.audit()
  const gallery = audit.indexes.find((index) => index.key === 'gallery')
  assert.equal(gallery.exists, true)
  assert.equal(gallery.valid, false)
  assert.ok(audit.problems.some((p) => /图库索引解析失败/.test(p.text)))
})

test('索引能读出条数', () => {
  const { storage } = fresh()
  const paths = storage.ensure()
  writeFileSync(join(paths.gallery, 'stickers.json'), JSON.stringify({ stickers: [{ id: 'a' }, { id: 'b' }] }), 'utf8')
  const audit = storage.audit()
  const gallery = audit.indexes.find((index) => index.key === 'gallery')
  assert.equal(gallery.valid, true)
  assert.equal(gallery.count, 2)
})

test('同名文件挡住目录时明确报错', () => {
  const { home, storage } = fresh()
  const paths = storage.layout()
  mkdirSync(paths.root, { recursive: true })
  // 把「图库」位置写成文件
  mkdirSync(paths.collection, { recursive: true })
  writeFileSync(join(paths.collection, GALLERY_FOLDER), 'not a directory', 'utf8')
  const audit = storage.audit()
  const gallery = audit.dirs.find((dir) => dir.key === 'gallery')
  assert.equal(gallery.exists, true)
  assert.equal(gallery.isDir, false)
  assert.ok(audit.problems.some((p) => /同名文件挡住了目录/.test(p.text)))
})

test('目录键与顺序稳定，方便界面逐行展示', () => {
  const { storage } = fresh()
  const audit = storage.audit()
  assert.deepEqual(audit.dirs.map((d) => d.key), ['root', 'collection', 'gallery', 'sites', 'platforms', 'growth', 'memory'])
  assert.deepEqual(audit.indexes.map((i) => i.key), ['gallery', 'sites', 'knowledge'])
})

test('网站索引也走同一套校验', () => {
  const { storage } = fresh()
  const paths = storage.ensure()
  writeFileSync(join(paths.sites, 'links.json'), '[]', 'utf8') // 顶层不是对象
  const audit = storage.audit()
  const sites = audit.indexes.find((index) => index.key === 'sites')
  assert.equal(sites.valid, true, '顶层是数组也应能解析')
  assert.equal(sites.count, 0)
  assert.equal(SITES_FOLDER.length > 0, true)
})
