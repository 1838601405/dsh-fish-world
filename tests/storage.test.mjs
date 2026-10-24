import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  COLLECTION_FOLDER, GALLERY_FOLDER, PLATFORM_DIRS, ROOT_FOLDER, SITES_FOLDER,
  adoptLegacyDir, createStorage, defaultStorageRoot, storageLayout,
} from '../lib/storage.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-storage-'))
  return { home, storage: createStorage({ home, config: () => ({}) }) }
}

/** describe 默认不落盘；需要看目录结构时的写法。 */
function describeAfterCreate(storage) {
  storage.ensure()
  return storage.describe()
}

test('storage layout puts gallery and sites under 鱼的收藏 with numbered folders', () => {
  const layout = storageLayout('C:\\Users\\x\\Desktop\\鱼的世界')
  assert.equal(layout.collection, 'C:\\Users\\x\\Desktop\\鱼的世界\\' + COLLECTION_FOLDER)
  assert.equal(layout.gallery, join(layout.collection, GALLERY_FOLDER))
  assert.equal(layout.sites, join(layout.collection, SITES_FOLDER))
  assert.equal(PLATFORM_DIRS.qq, 'QQ')
  assert.equal(layout.platform('bili'), join('C:\\Users\\x\\Desktop\\鱼的世界', '鱼与世界', 'B站'))
})

test('ensure creates the workspace tree and reports the folders', () => {
  const { home, storage } = fresh()
  const info = describeAfterCreate(storage)
  assert.equal(info.ok, true)
  assert.equal(info.root, join(home, ROOT_FOLDER))
  for (const dir of [info.folders.collection, info.folders.gallery, info.folders.sites, info.folders.platforms]) {
    assert.ok(existsSync(dir), dir + ' 应存在')
  }
  assert.equal(info.folders.byPlatform.qq, join(info.root, '鱼与世界', 'QQ'))
  assert.equal(info.configured, false)
})

test('describe does not touch the disk until something is written', () => {
  const { home, storage } = fresh()
  const info = storage.describe()
  assert.equal(info.exists, false)
  assert.equal(existsSync(join(home, ROOT_FOLDER)), false, '只看一眼不该建目录')
  storage.ensure()
  assert.equal(existsSync(join(home, ROOT_FOLDER)), true)
})

test('a configured root wins over the workspace default', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-storage-cfg-'))
  const custom = join(home, 'somewhere-else')
  const storage = createStorage({ home, config: () => ({ storage: { root: custom } }) })
  assert.equal(storage.root(), custom)
  assert.equal(storage.describe().configured, true)
})

test('gallery and sites can be overridden independently', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-storage-override-'))
  const gallery = join(home, 'my-gallery')
  const storage = createStorage({ home, config: () => ({ storage: { gallery } }) })
  const layout = storage.layout()
  assert.equal(layout.gallery, gallery)
  assert.equal(layout.sites, join(home, ROOT_FOLDER, COLLECTION_FOLDER, SITES_FOLDER))
})

test('defaultStorageRoot falls back to home when there is no Desktop', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-storage-nodek-'))
  const root = defaultStorageRoot({ home })
  assert.equal(root, join(home, ROOT_FOLDER))
})

test('old collection folders are adopted into the workspace once', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-storage-adopt-'))
  const legacy = join(home, 'fish-world', 'stickers')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'stickers.json'), JSON.stringify({ stickers: [{ id: 'stk_a' }] }))
  writeFileSync(join(legacy, 'stk_a.png'), 'x')

  const storage = createStorage({ home, config: () => ({}) })
  storage.ensure()
  const gallery = storage.layout().gallery
  assert.ok(existsSync(join(gallery, 'stickers.json')), '索引应被搬进图库')
  assert.ok(existsSync(join(gallery, 'stk_a.png')), '图片应被搬进图库')
  assert.equal(readFileSync(join(gallery, 'stk_a.png'), 'utf8'), 'x')
})

test('adoptLegacyDir never overwrites an existing target', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-storage-keep-'))
  const source = join(home, 'old')
  const target = join(home, 'new')
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(source, 'a.txt'), 'old')
  writeFileSync(join(target, 'a.txt'), 'new')
  assert.equal(adoptLegacyDir(source, target), false, '目标非空时不动它')
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'new')
})
