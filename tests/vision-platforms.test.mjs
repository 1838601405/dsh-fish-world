// 三个主平台适配器的判据（2026-11-22 主人方案 P3）。
//
// 验的是「各平台的原始形状 → 统一结构」这一步：
//   · QQ 给 url（要下载）、语音段藏在 parts 里、有译文就别再转写一遍
//   · DSH 会话给 base64 块或已落盘路径
//   · 桌面版给路径、网页版给 dataURL
//
// 以及方案的判据：**三个平台走同一套归一化 → 管线，同一张图只算一次**。
// 全程假管线 + 假 fetch，不碰本机（AGENTS 6.3）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createVisionInput, makeEntry, normalizeFile } from '../lib/vision-input.mjs'
import { MAX_FILES, fromDesktop, fromQQ, fromSession, registerMainPlatforms } from '../lib/vision-platforms.mjs'

function mkDir() { return mkdtempSync(join(tmpdir(), 'fw-vp-')) }

function pngBytes(tag) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('图-' + tag)
  ])
}

function mkVision() {
  const seen = new Map()
  const calls = { describe: 0 }
  return {
    calls,
    async describe(file, { focus = '' } = {}) {
      const key = createHash('sha256').update(readFileSync(file)).digest('hex') + '|' + focus
      const hit = seen.get(key)
      if (hit) return { ...hit, cached: true }
      calls.describe += 1
      const r = { id: key.slice(0, 16), kind: 'image', text: '看图-' + seen.size, tags: [], cached: false, model: 'fake', at: 1 }
      seen.set(key, r)
      return { ...r }
    }
  }
}

/** 造一条 qq.mjs normalizeMessage 形状的消息。 */
function qqRow(over = {}) {
  return {
    id: '10000001',
    chatKey: 'group:10000002',
    userId: '10000003',
    nickname: '小明',
    text: '看这个',
    parts: [],
    images: [],
    videos: [],
    forwards: [],
    at: 1790000000000,
    ...over
  }
}

// ══════════ QQ ══════════

test('★★ QQ：图 + 视频给 url（这层不下载）', () => {
  const e = fromQQ(qqRow({
    images: [{ url: 'https://例子.test/a.png', file: 'a.png' }],
    videos: [{ url: 'https://例子.test/b.mp4', name: 'b.mp4' }]
  }))
  assert.equal(e.source, 'qq')
  assert.equal(e.who, '小明')
  assert.equal(e.when, 1790000000000)
  assert.equal(e.raw_id, '10000001')
  assert.equal(e.files.length, 2)
  assert.equal(e.files[0].url, 'https://例子.test/a.png')
  assert.equal(e.files[1].url, 'https://例子.test/b.mp4')
  assert.ok(!('bytes' in e.files[0]), '★ QQ 给的是地址，不是字节')
})

test('★★ QQ：有译文的语音不再当附件（同一句不花两次钱）', () => {
  const withText = fromQQ(qqRow({
    text: '[语音] 今天好累',
    parts: [{ kind: 'record', label: '语音', url: 'https://例子.test/v.silk' }]
  }))
  assert.equal(withText.files.length, 0, '★ 正文里已经有译文就别再转写')

  const noText = fromQQ(qqRow({
    text: '',
    parts: [{ kind: 'record', label: '语音', url: 'https://例子.test/v.silk' }]
  }))
  assert.equal(noText.files.length, 1, '★ 没译文才把音频交出去')
  assert.equal(noText.files[0].url, 'https://例子.test/v.silk')
})

test('★ QQ：一条消息最多转一段语音（不排一队）', () => {
  const e = fromQQ(qqRow({
    parts: [
      { kind: 'record', url: 'https://例子.test/1.silk' },
      { kind: 'record', url: 'https://例子.test/2.silk' }
    ]
  }))
  assert.equal(e.files.length, 1)
})

test('★ QQ：附件超过 8 个就截断', () => {
  const images = Array.from({ length: 20 }, (_, i) => ({ url: `https://例子.test/${i}.png` }))
  const e = fromQQ(qqRow({ images }))
  assert.equal(e.files.length, MAX_FILES)
})

test('★ QQ：空消息摊出来仍是合法统一结构', () => {
  const e = fromQQ({})
  assert.equal(e.source, 'qq')
  assert.deepEqual(e.files, [])
  assert.equal(e.text, '')
  // makeEntry 的校验还在（source 必须有）
  assert.throws(() => makeEntry({}), /source/)
})

// ══════════ DSH 会话 ══════════

test('★★ 会话：base64 图块 → bytes（这层不判类型，交给归一化）', () => {
  const bytes = pngBytes('会话')
  const e = fromSession(
    { type: 'image', data: bytes.toString('base64'), mediaType: 'image/png', name: 'pasted.png' },
    { who: '主人', when: 123, text: '粘贴的图', raw_id: 'sess-1' }
  )
  assert.equal(e.source, 'session')
  assert.equal(e.who, '主人')
  assert.equal(e.raw_id, 'sess-1')
  assert.equal(e.files.length, 1)
  assert.ok(Buffer.isBuffer(e.files[0].bytes), '★ base64 要解成字节')
  assert.equal(e.files[0].bytes.toString('hex'), bytes.toString('hex'))
})

test('★★ 会话：已落盘的路径原样带出去（不再读一遍再写一遍）', () => {
  const e = fromSession({ path: 'D:/某处/a.png', name: 'a.png' })
  assert.equal(e.files[0].path, 'D:/某处/a.png')
  assert.ok(!('bytes' in e.files[0]))
})

test('★ 会话：一块数组一起收，空块跳过', () => {
  const e = fromSession([
    { type: 'image', data: pngBytes('1').toString('base64'), mediaType: 'image/png' },
    null,
    {},
    { type: 'image', data: pngBytes('2').toString('base64'), mediaType: 'image/png' }
  ])
  assert.equal(e.files.length, 2)
})

test('★ 会话：mediaType 决定落盘后缀（video/audio/image 各归各位）', () => {
  const v = fromSession({ type: 'video', data: 'AAAA', mediaType: 'video/mp4' })
  assert.match(v.files[0].name, /\.mp4$/)
  const a = fromSession({ type: 'audio', data: 'AAAA', mediaType: 'audio/mp4' })
  assert.match(a.files[0].name, /\.(m4a|mp4)$/)
})

// ══════════ 桌面版 ══════════

test('★★ 桌面版：本地路径原样带出（桌面能读本机文件）', () => {
  const e = fromDesktop('D:/拖进来的/a.png', { who: '主人', raw_id: 'drop-1' })
  assert.equal(e.source, 'desktop')
  assert.equal(e.files.length, 1)
  assert.equal(typeof e.files[0], 'string', '★ 裸路径就是字符串')
})

test('★★ 网页面板：dataURL 收得下（读不到本机文件的那端）', () => {
  const b64 = pngBytes('面板').toString('base64')
  const e = fromDesktop('data:image/png;base64,' + b64)
  assert.equal(e.files.length, 1)
  assert.match(String(e.files[0]), /^data:image\/png;base64,/)
})

test('★ 框面版：对象与数组两种入参都收', () => {
  const a = fromDesktop({ path: 'D:/a.png', name: 'a.png' })
  assert.equal(a.files[0].path, 'D:/a.png')
  assert.equal(a.files[0].name, 'a.png')

  const b = fromDesktop(['D:/a.png', 'data:image/png;base64,AAAA'])
  assert.equal(b.files.length, 2)
})

// ══════════ ★★ P3 判据：三个平台同一张图，只算一次 ══════════

test('★★ 三个主平台登记后，同一张图从哪来都只调一次模型', async () => {
  const dir = mkDir()
  const bytes = pngBytes('三平台同一张')
  const local = join(dir, '拖进来的.png')
  writeFileSync(local, bytes)

  const vision = mkVision()
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })
  const reg = registerMainPlatforms(input)

  assert.equal(reg.count, 3)
  assert.deepEqual([...reg.platforms].sort(), ['desktop', 'qq', 'session'])

  // 同一份内容，三个平台各用自己拿得到的形态
  const rQQ = await input.ingest('qq', qqRow({ images: [{ url: 'https://例子.test/x.png' }] }), {
    meta: { who: '小明' }
  }).catch(() => null)
  void rQQ

  // QQ 那条走的是 url（要下载），这里用假 fetch 给出同一份字节
  const fetchImpl = async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
  const input2 = createVisionInput({ vision, inputDir: join(dir, 'in'), fetchImpl })
  registerMainPlatforms(input2)

  const a = await input2.ingest('qq', qqRow({ images: [{ url: 'https://例子.test/x.png' }] }))
  const b = await input2.ingest('session', { type: 'image', data: bytes.toString('base64'), mediaType: 'image/png' })
  const c = await input2.ingest('desktop', local)

  assert.equal(vision.calls.describe, 1, '★ 三个平台同一张图只调一次模型')
  assert.equal(a.results[0].sha256, b.results[0].sha256)
  assert.equal(b.results[0].sha256, c.results[0].sha256)
  assert.equal(a.results[0].result.text, b.results[0].result.text, '★ 描述一致')
  assert.equal(b.results[0].result.text, c.results[0].result.text, '★ 描述一致')
  assert.equal(a.entry.source, 'qq')
  assert.equal(b.entry.source, 'session')
  assert.equal(c.entry.source, 'desktop')
})

test('★★ 平台名只进 entry.source，不进描述正文', async () => {
  const dir = mkDir()
  const bytes = pngBytes('不带平台')
  const vision = mkVision()
  const fetchImpl = async () => new Response(bytes, { status: 200 })
  const input = createVisionInput({ vision, inputDir: join(dir, 'in'), fetchImpl })
  registerMainPlatforms(input)

  const a = await input.ingest('qq', qqRow({ images: [{ url: 'https://例子.test/y.png' }] }))
  const b = await input.ingest('desktop', (() => { const p = join(dir, 'd.png'); writeFileSync(p, bytes); return p })())

  assert.equal(a.results[0].result.text, b.results[0].result.text)
  const json = JSON.stringify(a.results[0].result)
  for (const w of ['qq', 'QQ', 'desktop', 'session', '桌面', '会话']) {
    assert.equal(json.includes(w), false, '★ 描述里不许出现平台名：' + w)
  }
})

test('★ 三个平台的适配器互不依赖（单独导出也能用）', () => {
  assert.equal(typeof fromQQ, 'function')
  assert.equal(typeof fromSession, 'function')
  assert.equal(typeof fromDesktop, 'function')
  // 各自独立产出合法统一结构
  assert.equal(fromQQ(qqRow()).source, 'qq')
  assert.equal(fromSession({ path: '/a.png' }).source, 'session')
  assert.equal(fromDesktop('/a.png').source, 'desktop')
})

test('★★ 没登记就用 → 报错并列出已登记的', async () => {
  const dir = mkDir()
  const input = createVisionInput({ vision: mkVision(), inputDir: join(dir, 'in') })
  registerMainPlatforms(input)
  await assert.rejects(() => input.ingest('bilibili', {}), /没登记平台「bilibili」/)
})

test('★ registerMainPlatforms 拒掉不是实例的东西', () => {
  assert.throws(() => registerMainPlatforms(null), /vision-input 实例/)
  assert.throws(() => registerMainPlatforms({}), /vision-input 实例/)
})

// ══════════ 归一化在三平台上口径一致 ══════════

test('★★ 同一份字节：QQ 下载来的 / 会话 base64 / 桌面路径 → 同一个 sha256', async () => {
  const dir = mkDir()
  const bytes = pngBytes('口径一致')
  const local = join(dir, 'same.png')
  writeFileSync(local, bytes)

  const fromUrl = await normalizeFile({ url: 'https://例子.test/s.png' }, {
    inputDir: join(dir, 'in'),
    fetchImpl: async () => new Response(bytes, { status: 200 })
  })
  const fromB64 = await normalizeFile({ bytes }, { inputDir: join(dir, 'in') })
  const fromPath = await normalizeFile({ path: local }, { inputDir: join(dir, 'in') })

  assert.equal(fromUrl.sha256, fromB64.sha256, '★ 下载来的与 base64 的同一个 sha256')
  assert.equal(fromB64.sha256, fromPath.sha256, '★ base64 与本地路径的同一个 sha256')
  assert.equal(fromUrl.kind, 'image')
  assert.equal(fromB64.kind, 'image')
  assert.equal(fromPath.kind, 'image')
})
