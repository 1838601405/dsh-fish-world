// 批量收藏：逐张理由 + 汇总句。临时目录 + 假 storage，不碰真实图库。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStickers } from '../lib/stickers.mjs'

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09, 0x08, 0x07])

function make() {
  const root = mkdtempSync(join(tmpdir(), 'fw-sticker-batchadd-'))
  const gallery = join(root, 'gallery')
  mkdirSync(gallery, { recursive: true })
  const stickers = createStickers({
    home: join(root, 'home'),
    config: () => ({ stickers: { enabled: true, hourlyLimit: 100 } }),
    storage: { layout: () => ({ gallery }), appendSecurity() {} },
  })
  return { stickers, gallery }
}

test('批量收藏：重复 / 不是表情包 / 过大都给理由，汇总句报全', async () => {
  const { stickers } = make()
  // 先收一张进库，之后同名不同路径的同一张图要判 repeat。
  await stickers.add({ base64: PNG_A.toString('base64') }, { name: '原有的' })

  const items = [
    { base64: PNG_A.toString('base64'), name: '重复的那张' },
    { base64: PNG_B.toString('base64'), name: '新收的' },
    { verdict: 'not-sticker', name: '截图一张' },
    { base64: Buffer.alloc(9 * 1024 * 1024, 1).toString('base64'), name: '超大图' },
  ]
  const out = await stickers.addBatch(items)
  assert.equal(out.ok, true)
  assert.equal(out.collected.length, 1)
  assert.equal(out.collected[0].name, '新收的')
  assert.equal(out.skipped.length, 3)
  const reasons = out.skipped.map((row) => row.reason)
  assert.ok(reasons.includes('repeat'))
  assert.ok(reasons.includes('not-sticker'))
  assert.ok(reasons.includes('too-large'))
  assert.match(out.summary, /收了 1 张/)
  assert.match(out.summary, /跳过 3 张/)
  assert.match(out.summary, /1 张和库里重复/)
  assert.match(out.summary, /1 张不是表情包/)
  assert.match(out.summary, /1 张图太大/)
  assert.match(out.content, /逐张：/)
})

test('批量收藏：全部收下时不写「跳过 0 张」以外的废话', async () => {
  const { stickers } = make()
  const out = await stickers.addBatch([
    { base64: PNG_A.toString('base64'), name: 'A' },
    { base64: PNG_B.toString('base64'), name: 'B' },
  ])
  assert.equal(out.collected.length, 2)
  assert.equal(out.skipped.length, 0)
  assert.match(out.summary, /收了 2 张（A\/B）/)
  assert.match(out.summary, /跳过 0 张/)
})

test('批量收藏：同一批里两张相同的，后一张算重复', async () => {
  const { stickers } = make()
  const out = await stickers.addBatch([
    { base64: PNG_A.toString('base64'), name: '第一张' },
    { base64: PNG_A.toString('base64'), name: '第二张' },
  ])
  assert.equal(out.collected.length, 1)
  assert.equal(out.skipped[0].reason, 'repeat')
})
