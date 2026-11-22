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

// 两帧 GIF：两个 Graphic Control Extension（0x21 0xF9）＝ 动图。
// 单帧 GIF 只有一个。这样能验证 isAnimatedImage 真的按帧数判断。
const GIF_ANIM_BYTES = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x3b,
])
const GIF_STILL_BYTES = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x3b,
])

function makeVision({ config, fetchImpl }) {
  const home = mkdtempSync(join(tmpdir(), 'qce-vision-'))
  const vision = createStickerVision({ config: { getConfig: () => config }, home, fetchImpl })
  return { home, vision }
}

/**
 * 同上，但**先写好 key** —— 给「走管线」那批新测试用。
 *
 * ★ 不并进 makeVision：原测试里有两条专门验「缺 key 要如实报」，
 *   共用帮手把 key 补上会把它们弄红 —— 那是改帮手让测试变绿，方向反了。
 */
async function makeReadyVision({ config, fetchImpl }) {
  const { home, vision } = makeVision({ config, fetchImpl })
  const { writeStickerVisionSecret } = await import('../lib/sticker-vision.mjs')
  writeStickerVisionSecret('sk-test', { home })
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
  assert.deepEqual(after.tagWords, ['已有', '补充']) // 标签并集（自由词）
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

test('动图识别：多帧 GIF 标 animated，单帧 GIF / 静图不标', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-anim-'))
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const stickers = createStickers({ home, config: () => ({ stickers: { enabled: true, hourlyLimit: 10 } }), logger })

  const anim = await stickers.add({ base64: GIF_ANIM_BYTES.toString('base64'), hint: 'gif' }, { tags: ['x'] })
  assert.equal(anim.format, 'gif')
  assert.equal(anim.animated, true)

  const still = await stickers.add({ base64: GIF_STILL_BYTES.toString('base64'), hint: 'gif' }, { tags: ['y'] })
  assert.equal(still.animated, false)

  const png = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { tags: ['z'] })
  assert.equal(png.animated, false)
})

test('整理动图：给模型带「动图」提示，且写回时必定有「动图」标签', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-anim-organize-'))
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const config = { stickers: { enabled: true, hourlyLimit: 10 }, ...READY_CONFIG }
  const calls = []
  const vision = createStickerVision({
    config: { getConfig: () => config },
    home,
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body))
      return {
        ok: true,
        status: 200,
        // 模型没给「动图」标签，验证代码兜底补上
        json: async () => ({ choices: [{ message: { content: '{"name":"挥手","tags":["挥手"],"note":"打招呼"}' } }] }),
      }
    },
  })
  const { writeStickerVisionSecret } = await import('../lib/sticker-vision.mjs')
  writeStickerVisionSecret('sk-test', { home })
  const stickers = createStickers({ home, config: () => config, logger, vision })

  const item = await stickers.add({ base64: GIF_ANIM_BYTES.toString('base64'), hint: 'gif' }, {})
  // 等自动整理落盘
  await new Promise((resolve) => setTimeout(resolve, 60))

  // 提示词里明确告诉了模型这是动图
  const text = calls[0].messages[0].content.find((p) => p.type === 'text').text
  assert.match(text, /动图/)

  const after = stickers.get(item.id)
  assert.ok(after.tagWords.includes('动图'))
  assert.equal(after.animated, true)
})

// ══════════ ★★ P5 收口：走视觉管线（同一张图第二次吃缓存） ══════════

/** 一个只认「图 → 描述」的假管线：计数 + 可注入失败。 */
function fakeWire({ fail = false, text } = {}) {
  const calls = { describeImage: 0, files: [] }
  const wire = {
    inputDir: mkdtempSync(join(tmpdir(), 'qce-wire-')),
    calls,
    vision: {
      async describeImage(file, opts) {
        calls.describeImage += 1
        calls.files.push({ file, opts })
        if (fail) throw new Error('缺 ffmpeg / ffprobe，读不了这个文件')
        return {
          id: 'x',
          kind: 'image',
          text: text ?? '{"name":"鲸鱼","tags":["鲸","蓝"],"note":"适合打招呼"}',
          tags: [],
          cached: calls.describeImage > 1,
          model: 'fake',
          at: 1,
        }
      },
    },
  }
  return wire
}

test('★★ 给了 wire → 走管线（不自己打接口），出参形状和原来一模一样', async () => {
  const { impl, calls } = fakeFetch({ choices: [{ message: { content: '不该被调到' } }] })
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: impl })
  const wire = fakeWire()

  const r = await vision.describe({ bytes: PNG_BYTES, format: 'png', wire })

  assert.equal(r.ok, true, '★ 走管线也要能出结果')
  assert.equal(r.name, '鲸鱼')
  assert.deepEqual(r.tags, ['鲸', '蓝'])
  assert.equal(r.note, '适合打招呼')
  assert.equal(calls.length, 0, '★ 给了 wire 就不许自己 fetch（P5：全仓只有一处调视觉模型）')
  assert.equal(wire.calls.describeImage, 1)
  void home
})

test('★★ 走管线时字数上限放宽到 800（默认 300 会把 JSON 截断）', async () => {
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: async () => { throw new Error('不该 fetch') } })
  const wire = fakeWire()
  await vision.describe({ bytes: PNG_BYTES, format: 'png', wire })
  const max = wire.calls.files[0].opts.max
  assert.ok(max >= 800, '★ 上限要 ≥800，否则整理 JSON 会被截成半截：' + max)
  void home
})

test('★★ focus 用整理提示词（进缓存键：同一张图 + 同一提示词 = 同一条缓存）', async () => {
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: async () => { throw new Error('不该 fetch') } })
  const wire = fakeWire()
  await vision.describe({ bytes: PNG_BYTES, format: 'png', wire })
  const focus = wire.calls.files[0].opts.focus
  assert.match(focus, /JSON/, '★ 提示词要要求回 JSON')
  assert.match(focus, /name/, '★ 字段要求不能丢')
  void home
})

test('★★ 动图提示词要跟着进 focus（否则动图会被当静图整理）', async () => {
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: async () => { throw new Error('不该 fetch') } })
  const wire = fakeWire()
  await vision.describe({ bytes: GIF_ANIM_BYTES, format: 'gif', animated: true, wire })
  assert.match(wire.calls.files[0].opts.focus, /动图/)
  void home
})

test('★★ 管线抛错 → 退回直连（缓存是优化，不能连累整理）', async () => {
  const { impl, calls } = fakeFetch({
    choices: [{ message: { content: '{"name":"兜底","tags":["兜"],"note":"直连救回来的"}' } }]
  })
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: impl })
  const wire = fakeWire({ fail: true })

  const r = await vision.describe({ bytes: PNG_BYTES, format: 'png', wire })

  assert.equal(r.ok, true, '★ 管线坏了也要出结果（退回直连）')
  assert.equal(r.name, '兜底')
  assert.equal(calls.length, 1, '★ 退回后确实走了直连')
  void home
})

test('★★ 管线返回空描述 → 也退回直连，不把空当成功', async () => {
  const { impl, calls } = fakeFetch({
    choices: [{ message: { content: '{"name":"直连","tags":[],"note":"x"}' } }]
  })
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: impl })
  const wire = fakeWire({ text: '   ' })

  const r = await vision.describe({ bytes: PNG_BYTES, format: 'png', wire })

  assert.equal(r.ok, true)
  assert.equal(r.name, '直连')
  assert.equal(calls.length, 1)
  void home
})

test('★★ 不给 wire → 走直连，行为与改动前一字不差', async () => {
  const { impl, calls } = fakeFetch({
    choices: [{ message: { content: '{"name":"老路","tags":["旧"],"note":"没 wire 时"}' } }]
  })
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: impl })

  const r = await vision.describe({ bytes: PNG_BYTES, format: 'png' })

  assert.equal(r.ok, true)
  assert.equal(r.name, '老路')
  assert.equal(calls.length, 1, '★ 没 wire 就走原来那条路')
  void home
})

test('★ wire 没有 inputDir / describeImage → 当作没给，直接走直连', async () => {
  const { impl, calls } = fakeFetch({
    choices: [{ message: { content: '{"name":"半截wire","tags":[],"note":"x"}' } }]
  })
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: impl })

  const r1 = await vision.describe({ bytes: PNG_BYTES, format: 'png', wire: {} })
  const r2 = await vision.describe({ bytes: PNG_BYTES, format: 'png', wire: { vision: {} } })

  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(calls.length, 2, '★ 残缺的 wire 不该把整理带沟里')
  void home
})

test('★ 管线回的 JSON 解析不了 → 如实报错，不编标签', async () => {
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: async () => { throw new Error('不该 fetch') } })
  const wire = fakeWire({ text: '这不是 JSON，是一段散文' })

  const r = await vision.describe({ bytes: PNG_BYTES, format: 'png', wire })

  // 解析不了 → 退回直连 → 直连这里被我们弄成抛错 → 最终如实报错
  assert.equal(r.ok, false)
  assert.match(String(r.error), /不该 fetch|没有返回可解析的 JSON|运行时没有 fetch/)
  void home
})

// ══════════ ★★ P3 桌面版：收图 → 自动整理 → 走管线 ══════════
//
// 这条链是「桌面版/面板收表情」的入口（stickers.add → scheduleAutoOrganize →
// organizeOne → vision.describe({wire})）。以前 wire 是内部现取、注入不进去，
// 判据只能看代码、证明不了它真的走了管线 —— 现在 visionWire 可注入。

test('★★ 收图 → 自动整理走视觉管线（注入的 wire 生效，不自己打接口）', async () => {
  const wire = fakeWire()
  const { impl, calls } = fakeFetch({
    choices: [{ message: { content: '{"name":"不该被调到","tags":[],"note":"x"}' } }]
  })
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: impl })

  const config = () => ({ stickers: { autoOrganize: true } })
  const stickers = createStickers({
    home,
    config,
    vision,
    visionWire: () => wire,
    logger: { warn() {} },
  })

  const item = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, {})
  // 自动整理是异步调度的（scheduleAutoOrganize 用 Promise.resolve().then）
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.ok(item && item.id, '收图本身要成功')
  assert.equal(wire.calls.describeImage, 1, '★ 自动整理要走注入的管线')
  assert.equal(calls.length, 0, '★ 走了管线就不许自己 fetch（P5：只有一处调视觉模型）')

  // 走管线时上限要放宽（整理回的是 JSON）
  assert.ok(wire.calls.files[0].opts.max >= 800, '★ 上限要 ≥800')
  assert.match(wire.calls.files[0].opts.focus, /JSON/, '★ focus 要是整理提示词')
})

test('★ 没注入 wire → 自动整理退回直连（行为与改动前一致）', async () => {
  const { impl, calls } = fakeFetch({
    choices: [{ message: { content: '{"name":"老路","tags":["旧"],"note":"没 wire"}' } }]
  })
  const { home, vision } = await makeReadyVision({ config: READY_CONFIG, fetchImpl: impl })

  const stickers = createStickers({
    home,
    config: () => ({ stickers: { autoOrganize: true } }),
    vision,
    // 不给 visionWire —— 走真实那条（storage 没有 layout.root ⇒ 取不到 ⇒ undefined）
    storage: { layout: () => ({ root: '' }) },
    logger: { warn() {} },
  })

  await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, {})
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(calls.length, 1, '★ 没 wire 就走原来的直连')
})

test('★ 视觉整理没就绪（开关关着）→ 收图照常成功，不因为没配就失败', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-off-'))
  const { createStickerVision } = await import('../lib/sticker-vision.mjs')
  // enabled:false ⇒ ready() 不 ok ⇒ scheduleAutoOrganize 直接 return
  const vision = createStickerVision({
    config: { getConfig: () => ({ stickerVision: { enabled: false } }) },
    home,
    fetchImpl: async () => { throw new Error('不该被调') },
  })
  const stickers = createStickers({
    home,
    config: () => ({ stickers: {} }),
    vision,
    logger: { warn() {} },
  })

  const item = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, {})
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.ok(item && item.id, '★ 开关关着也要能收图（默认关不改变既有行为）')
  assert.equal(stickers.get(item.id).organizeError || '', '', '★ 没整理就不该留失败痕')
})

