import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStickers } from '../lib/stickers.mjs'
import {
  DEFAULT_STICKER_VISION,
  createStickerVision,
  normalizeStickerVision,
} from '../lib/sticker-vision.mjs'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])

function makeVision({ config, fetchImpl }) {
  const home = mkdtempSync(join(tmpdir(), 'qce-vision-'))
  const vision = createStickerVision({ config: { getConfig: () => config }, home, fetchImpl })
  return { home, vision }
}

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }
  }
  return { impl, calls }
}

const READY_CONFIG = {
  stickerVision: { enabled: true, baseUrl: 'https://example.invalid/v1', model: 'vision-x' },
}

test('默认关着：配置归一化后不启用，ready 明确报原因', () => {
  const normalized = normalizeStickerVision({})
  assert.equal(normalized.enabled, false)
  assert.equal(normalized.baseUrl, '')
  assert.equal(normalized.timeoutMs, DEFAULT_STICKER_VISION.timeoutMs)

  // 非法地址不收
  assert.equal(normalizeStickerVision({ baseUrl: 'ftp://x' }).baseUrl, '')

  const { vision } = makeVision({ config: {} })
  const ready = vision.ready()
  assert.equal(ready.ok, false)
  assert.equal(ready.reason, 'disabled')
})

test('开着但缺三件套：不假装成功，说清缺哪一样', async () => {
  const { vision } = makeVision({ config: { stickerVision: { enabled: true } } })
  assert.equal(vision.ready().reason, '缺少接口地址')

  const noKey = makeVision({ config: { stickerVision: { enabled: true, baseUrl: 'https://a.invalid/v1', model: 'm' } } })
  assert.equal(noKey.vision.ready().reason, '缺少 API key')

  const described = await noKey.vision.describe({ bytes: PNG_BYTES, format: 'png' })
  assert.equal(described.ok, false)
  assert.match(described.error, /未就绪/)
})

test('真看图：把图发成 data URL，解析模型回的 JSON', async () => {
  const { home, vision } = makeVision({ config: READY_CONFIG })
  // 直接写密钥文件（与生产同一条落盘路径）
  const { writeStickerVisionSecret } = await import('../lib/sticker-vision.mjs')
  writeStickerVisionSecret('sk-test', { home })

  const payload = {
    choices: [{ message: { content: '```json\n{"name":"蓝鲸娘·掏刀","tags":["蓝鲸娘","掏刀","动图","动图"],"note":"想怼人时用"}\n```' } }],
  }
  const { impl, calls } = fakeFetch(payload)
  const wired = createStickerVision({ config: { getConfig: () => READY_CONFIG }, home, fetchImpl: impl })

  const described = await wired.describe({ bytes: PNG_BYTES, format: 'png' })
  assert.equal(described.ok, true)
  assert.equal(described.name, '蓝鲸娘·掏刀')
  assert.deepEqual(described.tags, ['蓝鲸娘', '掏刀', '动图']) // 去重
  assert.equal(described.note, '想怼人时用')

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/chat\/completions$/)
  const parts = calls[0].body.messages[0].content
  const image = parts.find((p) => p.type === 'image_url')
  assert.match(image.image_url.url, /^data:image\/png;base64,/)
  assert.equal(calls[0].body.model, 'vision-x')
})

test('接口报错 / 回包不是 JSON：如实报，不编标签', async () => {
  const { home } = makeVision({ config: READY_CONFIG })
  const { writeStickerVisionSecret } = await import('../lib/sticker-vision.mjs')
  writeStickerVisionSecret('sk-test', { home })

  const bad = createStickerVision({
    config: { getConfig: () => READY_CONFIG },
    home,
    fetchImpl: fakeFetch({}, { status: 503 }).impl,
  })
  const failed = await bad.describe({ bytes: PNG_BYTES, format: 'png' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /503/)

  const garbage = createStickerVision({
    config: { getConfig: () => READY_CONFIG },
    home,
    fetchImpl: fakeFetch({ choices: [{ message: { content: '这张图很好看' } }] }).impl,
  })
  const parsed = await garbage.describe({ bytes: PNG_BYTES, format: 'png' })
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /没有返回可解析的 JSON/)
})

test('整理写回：补名字、并标签、填说明、打标记；已有内容不被打架', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-organize-'))
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const config = { stickers: { enabled: true, hourlyLimit: 10 }, ...READY_CONFIG }
  const vision = createStickerVision({
    config: { getConfig: () => config },
    home,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"name":"新名字","tags":["补充"],"note":"模型说明"}' } }] }),
    }),
  })
  const { writeStickerVisionSecret } = await import('../lib/sticker-vision.mjs')
  writeStickerVisionSecret('sk-test', { home })

  const stickers = createStickers({ home, config: () => config, logger, vision })

  // 名字是手填的、标签已有、说明已有 → 模型结果只补空位
  const item = await stickers.add(
    { base64: PNG_BYTES.toString('base64'), hint: 'png' },
    { name: '手填的名字', tags: ['已有'], note: '已有的说明' },
  )
  // 等自动整理（入库即整理）落盘
  await new Promise((resolve) => setTimeout(resolve, 60))
  const after = stickers.get(item.id)
  assert.equal(after.name, '手填的名字')       // 手填名不被覆盖
  assert.deepEqual(after.tags, ['已有', '补充']) // 标签并集
  assert.equal(after.note, '已有的说明')        // 已有说明保留
  assert.equal(after.organized, true)
  assert.ok(after.organizedAt > 0)
})

test('没接视觉时整理明确报未接入，不动数据', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-novision-'))
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const stickers = createStickers({ home, config: () => ({ stickers: { enabled: true, hourlyLimit: 10 } }), logger })
  const item = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { tags: ['x'] })
  const result = await stickers.organizeOne(item.id)
  assert.equal(result.ok, false)
  assert.match(result.error, /未接入/)
  assert.equal(stickers.get(item.id).organized, undefined)
})
