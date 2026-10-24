import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStickers } from '../lib/stickers.mjs'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
const GIF_BYTES = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00])

function makeStore(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'qce-stickers-'))
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const stickers = createStickers({ home, config: () => config, logger })
  return { home, stickers, config }
}

test('鱼收藏表情：额度、标签、格式识别、删除、改标签', async () => {
  const { stickers, config } = makeStore({ stickers: { enabled: true, hourlyLimit: 2 } })

  const a = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { tags: ['开心', ' 开心 ', '贴贴'], name: '开心贴贴' })
  assert.equal(a.format, 'png')
  assert.deepEqual(a.tags, ['开心', '贴贴'])
  assert.equal(a.name, '开心贴贴')
  assert.equal(stickers.summary().total, 1)
  assert.equal(stickers.summary().remainingThisHour, 1)

  const b = await stickers.add({ base64: GIF_BYTES.toString('base64') }, { tags: ['委屈'] })
  assert.equal(b.format, 'gif')
  assert.equal(stickers.summary().remainingThisHour, 0)

  await assert.rejects(() => stickers.add({ base64: PNG_BYTES.toString('base64') }, { tags: ['超了'] }), /额度已用完/)

  // 按标签检索
  assert.equal(stickers.byTag('开心').length, 1)
  assert.equal(stickers.byTag('开心')[0].id, a.id)

  // 改标签
  const updated = stickers.updateTags(a.id, ['兴奋', '贴贴'])
  assert.deepEqual(updated.tags, ['兴奋', '贴贴'])

  // 删除
  assert.equal(stickers.remove(b.id), true)
  assert.equal(stickers.summary().total, 1)

  // 额度上限 0 时禁止收藏
  const limited = makeStore({ stickers: { enabled: true, hourlyLimit: 0 } })
  await assert.rejects(() => limited.stickers.add({ base64: PNG_BYTES.toString('base64') }), /额度已用完/)

  // 功能停用时禁止收藏
  const disabled = makeStore({ stickers: { enabled: false, hourlyLimit: 5 } })
  await assert.rejects(() => disabled.stickers.add({ base64: PNG_BYTES.toString('base64') }), /已停用/)
})

test('send 记录使用次数', async () => {
  const { stickers } = makeStore({ stickers: { enabled: true, hourlyLimit: 5 } })
  const item = await stickers.add({ base64: PNG_BYTES.toString('base64') }, { tags: ['吃饭'] })
  const qq = {
    sendSticker: async () => ({ ok: true, dryRun: false, sent: [{ kind: 'private', id: 1 }] }),
  }
  const receipt = await stickers.send(qq, '', item.id)
  assert.equal(receipt.ok, true)
  assert.equal(stickers.get(item.id).useCount, 1)
})

test('setLimit 校验范围', () => {
  const { stickers } = makeStore({ stickers: { enabled: true, hourlyLimit: 5 } })
  assert.equal(stickers.setLimit(10), 10)
  assert.throws(() => stickers.setLimit(-1))
  assert.throws(() => stickers.setLimit(1001))
})

test('收藏下载拒绝本机/内网地址和不支持的图片格式', async () => {
  const { stickers } = makeStore({ stickers: { enabled: true, hourlyLimit: 5 } })
  await assert.rejects(() => stickers.add({ url: 'http://127.0.0.1/latest/meta-data' }), /公网地址/)
  await assert.rejects(() => stickers.add({ url: 'http://[::1]/private.png' }), /公网地址/)
  await assert.rejects(() => stickers.add({ base64: Buffer.from('not an image').toString('base64') }), /不支持的图片格式/)
})

test('并发收藏也遵守同一小时额度', async () => {
  const { stickers } = makeStore({ stickers: { enabled: true, hourlyLimit: 1 } })
  const results = await Promise.allSettled([
    stickers.add({ base64: PNG_BYTES.toString('base64') }),
    stickers.add({ base64: GIF_BYTES.toString('base64') }),
  ])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1)
  assert.equal(stickers.summary().total, 1)
})

test('旧版 whale-stickers 数据以复制方式迁入鱼世界收藏库', () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-world-sticker-migration-'))
  const legacy = join(home, 'whale-stickers')
  mkdirSync(legacy, { recursive: true })
  const oldItem = { id: 'stk_legacy_1', name: '旧收藏', format: 'png', tags: ['旧'], addedAt: 1, useCount: 0 }
  writeFileSync(join(legacy, `${oldItem.id}.png`), PNG_BYTES)
  writeFileSync(join(legacy, 'stickers.json'), JSON.stringify({ version: 1, stickers: [oldItem], hourly: { key: '', count: 0 } }))
  const stickers = createStickers({ home, config: () => ({ stickers: { enabled: true, hourlyLimit: 5 } }), logger: {} })
  assert.equal(stickers.get(oldItem.id).name, '旧收藏')
  assert.ok(existsSync(join(home, 'fish-world', 'stickers', `${oldItem.id}.png`)))
  assert.ok(existsSync(join(legacy, `${oldItem.id}.png`)), '迁移保留旧文件作为回滚副本')
})
