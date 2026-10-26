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

// 主人 2026-10-26：面板里改了名字，打开文件夹还是 stk_xxx —— 改名要同步到磁盘。
test('改名同步到磁盘：文件名跟着名字走，非法字符清掉，重名加后缀', async () => {
  const { stickers } = makeStore({ stickers: { enabled: true, hourlyLimit: 5 } })
  const item = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { tags: ['蓝鲸娘'], name: '蓝鲸娘·压人-1' })
  const dir = stickers.dir()
  assert.ok(existsSync(join(dir, `${item.id}.png`)), '刚收藏时先按 id 落盘')

  const renamed = stickers.updateName(item.id, '蓝鲸娘·压人-1')
  assert.equal(renamed.file, '蓝鲸娘·压人-1')
  assert.ok(existsSync(join(dir, '蓝鲸娘·压人-1.png')), '磁盘文件名跟着面板上的名字')
  assert.equal(existsSync(join(dir, `${item.id}.png`)), false, '旧文件名不留下')
  assert.equal(stickers.fileFor(stickers.get(item.id)), join(dir, '蓝鲸娘·压人-1.png'))

  // Windows 非法字符换成空格；结尾的点和空格不能留
  const dirty = stickers.updateName(item.id, ' a/b:c*?"<>| ')
  assert.equal(dirty.file, 'a b c')
  assert.ok(existsSync(join(dir, 'a b c.png')))

  // 撞名（同格式）自动加 -2，先改的那条保住自己的名字
  const second = await stickers.add({ base64: PNG_BYTES.toString('base64') }, { tags: ['撞'] })
  stickers.updateName(second.id, '撞名')
  const clash = stickers.updateName(item.id, '撞名')
  assert.equal(clash.file, '撞名-2')
  assert.ok(existsSync(join(dir, '撞名.png')), '先改的保留原名')
  assert.ok(existsSync(join(dir, '撞名-2.png')))
})

// 主人 2026-10-26：她收藏桥收下来的 QQ 图时报「沙箱内不接受盘符路径」，
// 只好反过来让主人手动搬进鱼箱。桥的收图目录是可信来源，不该再卡这一道。
test('桥替她收下的 QQ 图可以直接收藏，鱼箱外其它路径仍然拒绝', async () => {
  const { stickers, home } = makeStore({ stickers: { enabled: true, hourlyLimit: 5 } })
  const inbox = join(home, 'qq-bridge-inbox')
  mkdirSync(inbox, { recursive: true })
  const file = join(inbox, '2105769975-1.png')
  writeFileSync(file, PNG_BYTES)
  const item = await stickers.add({ localPath: file }, { tags: ['鲸'], name: '扣锅小鲸鱼' })
  assert.equal(item.name, '扣锅小鲸鱼')
  assert.ok(existsSync(join(stickers.dir(), `${item.id}.png`)))

  const outside = join(mkdtempSync(join(tmpdir(), 'fw-outside-')), 'x.png')
  writeFileSync(outside, PNG_BYTES)
  await assert.rejects(() => stickers.add({ localPath: outside }), /鱼箱|拒绝/)
})
