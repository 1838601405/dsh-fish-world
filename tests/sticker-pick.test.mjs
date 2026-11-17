// 选图：立场由人给 → 倒排 use → 取 w 最高 → 打平取最近没发过的。
// 只注入两个词；同一张图在四个场景下不许全选同一条（那就是立场没生效）。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { USES, ROLES } from '../lib/sticker-vocab.mjs'
import { createStickers } from '../lib/stickers.mjs'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

function make() {
  const root = mkdtempSync(join(tmpdir(), 'fw-pick-'))
  const gallery = join(root, 'gallery')
  mkdirSync(gallery, { recursive: true })
  const stickers = createStickers({
    home: join(root, 'home'),
    config: () => ({ stickers: { enabled: true, hourlyLimit: 100 } }),
    storage: { layout: () => ({ gallery }), appendSecurity() {} },
  })
  return stickers
}

async function seed(stickers) {
  const rows = [
    { name: '催的', anchors: [{ act: '盯', role: '对你说', use: '催他一下', w: 0.8 }] },
    { name: '摆烂的', anchors: [{ act: '躺', role: '说我', use: '摆烂给他看', w: 0.8 }] },
    { name: '怼的', anchors: [{ act: '掏刀', role: '对你说', use: '怼回去', w: 0.8 }] },
    { name: '哄的', anchors: [{ act: '摸头', role: '对你说', use: '哄一句', w: 0.8 }] },
    { name: '通用的', anchors: [{ act: null, role: '通用', use: '看戏', w: 0.6 }] },
  ]
  for (const row of rows) {
    const item = await stickers.add({ base64: PNG.toString('base64') }, { name: row.name })
    stickers.setDerived(item.id, { origin: { 画面: row.name, 情绪: 'unknown', 梗: 'unknown' }, anchors: row.anchors })
  }
}

const SCENES = [
  { label: '被问进度', use: '催他一下', role: '对你说' },
  { label: '说自己也被催', use: '摆烂给他看', role: '说我' },
  { label: '被无理由嘲', use: '怼回去', role: '对你说' },
  { label: '对方低落', use: '哄一句', role: '对你说' },
]

test('四个场景各选到该选的那张，且互不相同', async () => {
  const stickers = make()
  await seed(stickers)
  const ids = []
  for (const scene of SCENES) {
    const got = stickers.pickForReply({ use: scene.use, role: scene.role })
    assert.equal(got.ok, true, scene.label + ' 没命中')
    ids.push(got.id)
  }
  assert.equal(new Set(ids).size, 4, '四个场景选出同一张 = 立场没生效：' + ids.join(','))
})

test('返回只摆两个词和一个 id，不带画面/情绪/梗', async () => {
  const stickers = make()
  await seed(stickers)
  const got = stickers.pickForReply({ use: '怼回去', role: '对你说' })
  assert.deepEqual(Object.keys(got.anchor).sort(), ['role', 'use'])
  assert.ok(USES.includes(got.anchor.use))
  assert.ok(ROLES.includes(got.anchor.role))
  assert.equal(got.origin, undefined)
  assert.equal(got.note, undefined)
})

test('通用立场的图也能被「对你说」用上；反过来也成立', async () => {
  const stickers = make()
  await seed(stickers)
  const a = stickers.pickForReply({ use: '看戏', role: '对你说' })
  assert.equal(a.ok, true)
  const b = stickers.pickForReply({ use: '看戏', role: '通用' })
  assert.equal(b.ok, true)
})

test('没有命中就明说，不硬配', () => {
  const stickers = make()
  const got = stickers.pickForReply({ use: '庆祝', role: '对你说' })
  assert.equal(got.ok, false)
  assert.match(got.reason, /没有命中/)
})

test('词表外说法归并；归并不了报「没有可用法」', () => {
  const stickers = make()
  assert.equal(stickers.pickForReply({ use: '礼貌', role: '对你说' }).ok, false)
  assert.match(stickers.pickForReply({ use: '礼貌', role: '对你说' }).reason, /没有可用法/)
})

test('w 打平取最近没发过的', async () => {
  const stickers = make()
  const a = await stickers.add({ base64: PNG.toString('base64') }, { name: '老图' })
  const b = await stickers.add({ base64: PNG.toString('base64') }, { name: '新图' })
  stickers.setDerived(a.id, { origin: { 画面: '刀', 情绪: '凶', 梗: 'unknown' }, anchors: [{ act: '掏刀', role: '对你说', use: '怼回去', w: 0.8 }] })
  stickers.setDerived(b.id, { origin: { 画面: '刀', 情绪: '凶', 梗: 'unknown' }, anchors: [{ act: '掏刀', role: '对你说', use: '怼回去', w: 0.8 }] })
  stickers.markUsed(a.id)
  const got = stickers.pickForReply({ use: '怼回去', role: '对你说' })
  assert.equal(got.id, b.id, '应该先挑没发过的那张')
})

test('excludeIds 能把刚发过的排掉', async () => {
  const stickers = make()
  const a = await stickers.add({ base64: PNG.toString('base64') }, { name: 'A' })
  const b = await stickers.add({ base64: PNG.toString('base64') }, { name: 'B' })
  for (const item of [a, b]) {
    stickers.setDerived(item.id, { origin: { 画面: '合十', 情绪: '慌', 梗: 'unknown' }, anchors: [{ act: '合十', role: '对你说', use: '求饶', w: 0.8 }] })
  }
  const got = stickers.pickForReply({ use: '求饶', role: '对你说', excludeIds: [a.id] })
  assert.equal(got.id, b.id)
})