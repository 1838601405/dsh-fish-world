import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  COLLECTION_FOLDER, LEGACY_COLLECTION_FOLDER, createStorage, migrateCollectionName, storageLayout,
} from '../lib/storage.mjs'

test('new workspaces use 鱼之宝库 as the collection folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-rename-new-'))
  const storage = createStorage({ home, config: () => ({}) })
  storage.ensure()
  const layout = storage.layout()
  assert.equal(COLLECTION_FOLDER, '鱼之宝库')
  assert.ok(layout.collection.endsWith(COLLECTION_FOLDER))
  assert.ok(existsSync(layout.gallery), '图库应建在新名字下面')
  assert.equal(existsSync(join(layout.root, LEGACY_COLLECTION_FOLDER)), false, '不该再出现旧名字目录')
})

test('an existing 鱼的收藏 folder is renamed to 鱼之宝库 with its data', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-rename-old-'))
  const root = join(home, '鱼的世界')
  const legacy = join(root, LEGACY_COLLECTION_FOLDER)
  mkdirSync(join(legacy, '1 图库'), { recursive: true })
  writeFileSync(join(legacy, '1 图库', 'stickers.json'), '{"stickers":[]}')

  const storage = createStorage({ home, config: () => ({}) })
  storage.ensure()
  assert.equal(existsSync(legacy), false, '旧目录应已改名')
  // 子目录也一并改名：1 图库 → 图库
  const moved = join(root, COLLECTION_FOLDER, '图库', 'stickers.json')
  assert.ok(existsSync(moved))
  assert.equal(readFileSync(moved, 'utf8'), '{"stickers":[]}')
})

test('when both folder names exist nothing is merged or overwritten', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-rename-both-'))
  const root = join(home, '鱼的世界')
  mkdirSync(join(root, LEGACY_COLLECTION_FOLDER), { recursive: true })
  mkdirSync(join(root, COLLECTION_FOLDER), { recursive: true })
  writeFileSync(join(root, LEGACY_COLLECTION_FOLDER, 'old.txt'), 'old')
  writeFileSync(join(root, COLLECTION_FOLDER, 'new.txt'), 'new')

  assert.equal(migrateCollectionName(root), COLLECTION_FOLDER)
  assert.equal(readFileSync(join(root, LEGACY_COLLECTION_FOLDER, 'old.txt'), 'utf8'), 'old', '旧目录原样保留')
  assert.equal(readFileSync(join(root, COLLECTION_FOLDER, 'new.txt'), 'utf8'), 'new')
})

test('layout marks whether gallery and sites still live inside the collection', () => {
  const layout = storageLayout('C:\\ws\\鱼的世界')
  assert.equal(layout.collection, join('C:\\ws\\鱼的世界', COLLECTION_FOLDER))
  assert.ok(layout.collection.endsWith(COLLECTION_FOLDER))
})
