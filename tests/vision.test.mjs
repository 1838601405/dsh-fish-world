// 视觉管线 + 缓存判据（2026-11-22 主人要求 P1）。
//
// P1 的核心判据只有一条：**同一文件第二次调用 cached=true，不调模型**。
// 但那一条背后要成立，得同时保证：
//   · 缓存键分得清（focus 不同、模型不同 → 不能互相顶掉）
//   · 缓存抓得对（sha256 变了 → 必须重算）
//   · 失败不污染缓存（失败结果不许被缓存成"答案"）
//   · 连续失败两次 → 标记不可用，不再重试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cacheKey, createVisionCache, hashBytes } from '../lib/vision-cache.mjs'
import {
  AUDIO_TEXT_MAX,
  DEFAULT_FRAMES,
  FAIL_LIMIT,
  IMAGE_TEXT_MAX,
  VIDEO_TEXT_MAX,
  clampText,
  createVision,
  kindOf,
  renderForContext
} from '../lib/vision.mjs'

function mkWorld() {
  const root = mkdtempSync(join(tmpdir(), 'vision-'))
  mkdirSync(join(root, '素材'), { recursive: true })
  return root
}

/** 造一个假文件（内容可控，用来测 sha256）。 */
function mkFile(root, name, content = 'hello') {
  const p = join(root, '素材', name)
  writeFileSync(p, content)
  return p
}

/** 计数的假后端。 */
function mkBackend(answer = '一只鲸鱼在游') {
  const calls = { describe: 0, video: 0, audio: 0 }
  return {
    calls,
    backend: {
      async describe(file, opts) {
        calls.describe += 1
        return { text: typeof answer === 'function' ? answer(file, opts) : answer, tags: ['鲸'] }
      },
      async video(file, opts) {
        calls.video += 1
        return {
          text: typeof answer === 'function' ? answer(file, opts) : answer,
          timeline: [0, 2, 4, 6]
        }
      },
      async audio(file, opts) {
        calls.audio += 1
        return { text: '今天好累' }
      }
    }
  }
}

// ══════════ ★★ P1 核心判据 ══════════

test('★★ 同一文件第二次调用 cached=true，且不调模型', async () => {
  const root = mkWorld()
  const { backend, calls } = mkBackend()
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const img = mkFile(root, 'a.png')

  const first = await v.describeImage(img)
  assert.equal(first.cached, false, '第一次没缓存')
  assert.equal(calls.describe, 1, '第一次调了模型')

  const second = await v.describeImage(img)
  assert.equal(second.cached, true, '★ 第二次必须 cached=true')
  assert.equal(calls.describe, 1, '★ 第二次不许再调模型')
  assert.equal(second.text, first.text, '两次结果一致')
})

test('★★ 换文件内容（sha256 变）→ 必须重算', async () => {
  const root = mkWorld()
  const { backend, calls } = mkBackend()
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const img = mkFile(root, 'b.png', '内容1')

  await v.describeImage(img)
  writeFileSync(img, '内容2')   // 同一路径，内容变了
  const r2 = await v.describeImage(img)

  assert.equal(r2.cached, false, '★ 内容变了不能吃旧缓存')
  assert.equal(calls.describe, 2, '★ 要重算')
})

test('★ 改文件名字不影响缓存（跨平台共享的前提）', async () => {
  const root = mkWorld()
  const { backend, calls } = mkBackend()
  const v = createVision({ root, recognize: backend, model: 'm1' })

  const a = mkFile(root, 'qq-收到.png', '同一张图')
  const b = mkFile(root, 'b站封面.png', '同一张图')   // 内容一样，名字不同

  const r1 = await v.describeImage(a)
  const r2 = await v.describeImage(b)

  assert.equal(r1.cached, false)
  assert.equal(r2.cached, true, '★ 同一份内容换个名字要命中同一缓存')
  assert.equal(calls.describe, 1, '★ 只算一次')
})

test('★ 换 focus → 不同答案，不互相顶掉', async () => {
  const root = mkWorld()
  const { backend, calls } = mkBackend((f, o) => 'focus=' + (o?.focus || ''))
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const img = mkFile(root, 'c.png')

  const a = await v.describeImage(img, { focus: '有没有文字' })
  const b = await v.describeImage(img, { focus: '画风' })
  assert.notEqual(a.text, b.text, '不同 focus 答案不同')
  assert.equal(b.cached, false, '★ 新 focus 不能吃旧缓存')
  assert.equal(calls.describe, 2)

  // 再问同一个 focus → 命中
  const c = await v.describeImage(img, { focus: '有没有文字' })
  assert.equal(c.cached, true)
  assert.equal(calls.describe, 2, '★ 只算两次')
})

test('★ 换模型版本 → 旧缓存失效', async () => {
  const root = mkWorld()
  const { backend, calls } = mkBackend()
  const img = mkFile(root, 'd.png')

  const v1 = createVision({ root, recognize: backend, model: 'm1' })
  await v1.describeImage(img)

  const v2 = createVision({ root, recognize: backend, model: 'm2' })
  const r = await v2.describeImage(img)
  assert.equal(r.cached, false, '★ 换了模型不能吃旧答案')
  assert.equal(calls.describe, 2)
})

// ══════════ 成本纪律 ══════════

test('★ 图 300 字上限，超了截断并标记', async () => {
  const root = mkWorld()
  const long = '鲸'.repeat(500)
  const { backend } = mkBackend(long)
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v.describeImage(mkFile(root, 'e.png'))

  assert.ok(r.text.length <= IMAGE_TEXT_MAX + 1, '★ 不许超过 300 字（+1 是省略号）')
  assert.equal(r.truncated, true, '★ 要标记已截断')
})

test('★ 视频摘要 500 字上限', async () => {
  const root = mkWorld()
  const { backend } = mkBackend('视'.repeat(800))
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v.describeVideo(mkFile(root, 'f.mp4'))
  assert.ok(r.text.length <= VIDEO_TEXT_MAX + 1)
  assert.equal(r.truncated, true)
})

test('★ 语音转写上限比视频宽（转写本来就长）', async () => {
  assert.ok(AUDIO_TEXT_MAX > VIDEO_TEXT_MAX, 'AUDIO_TEXT_MAX 应该比 VIDEO_TEXT_MAX 大')
})

test('★ 视频默认抽 6–8 帧', () => {
  assert.ok(DEFAULT_FRAMES >= 6 && DEFAULT_FRAMES <= 8, '默认帧数要在 6–8：' + DEFAULT_FRAMES)
})

test('★ 帧数给太大会被夹住（不逐帧）', async () => {
  const root = mkWorld()
  let got = null
  const backend = {
    async video(f, o) { got = o.frames; return { text: 'x' } },
    async describe() { return { text: 'x' } },
    async audio() { return { text: 'x' } }
  }
  const v = createVision({ root, recognize: backend, model: 'm1' })
  await v.describeVideo(mkFile(root, 'g.mp4'), { frames: 999 })
  assert.ok(got <= 12, '★ 帧数要夹到上限（12），不许逐帧')
})

// ══════════ 失败处理 ══════════

test('★★ 后端抛错 → 不乱写缓存（下次还要试）', async () => {
  const root = mkWorld()
  let n = 0
  const backend = {
    async describe() { n += 1; throw new Error('模型超时') },
    async video() { throw new Error('x') },
    async audio() { throw new Error('x') }
  }
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const img = mkFile(root, 'h.png')

  const r1 = await v.describeImage(img)
  assert.equal(r1.text, '', '失败不编内容')
  assert.equal(r1.note, 'failed')
  assert.match(r1.why, /模型超时/, '★ 要如实带原因')

  // 第二次还试（没到 FAIL_LIMIT）
  await v.describeImage(img)
  assert.equal(n, 2, '★ 第一次失败不该被缓存成答案')
})

test('★★ 连续失败 2 次 → 标记不可用，第三次不再调', async () => {
  const root = mkWorld()
  let n = 0
  const backend = {
    async describe() { n += 1; throw new Error('一直失败') },
    async video() { throw new Error('x') },
    async audio() { throw new Error('x') }
  }
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const img = mkFile(root, 'i.png')

  await v.describeImage(img)
  await v.describeImage(img)
  assert.equal(n, FAIL_LIMIT, '两次都试了')

  const third = await v.describeImage(img)
  assert.equal(n, FAIL_LIMIT, '★ 第三次不许再调模型')
  assert.equal(third.note, 'unavailable')
})

test('★★ 后端返回空 → 说「没看清」，不返回空串', async () => {
  const root = mkWorld()
  const { backend } = mkBackend('')
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v.describeImage(mkFile(root, 'j.png'))
  assert.equal(r.text, '没看清', '★ 主人要求：不返回空串')
  assert.equal(r.note, 'blank')
})

test('没接后端 → 明确说，不假装成功', async () => {
  const root = mkWorld()
  const v = createVision({ root, model: 'm1' })
  const r = await v.describeImage(mkFile(root, 'k.png'))
  assert.equal(r.note, '没接识别后端')
  assert.equal(r.why, 'no-backend')
})

test('文件不存在 → 明确报错', async () => {
  const root = mkWorld()
  const { backend } = mkBackend()
  const v = createVision({ root, recognize: backend, model: 'm1' })
  await assert.rejects(() => v.describeImage(join(root, '没有这个.png')), /文件不存在/)
})

// ══════════ 统一输出 ══════════

test('★★ 输出字段齐全（id/kind/text/tags/cached/model/at）', async () => {
  const root = mkWorld()
  const { backend } = mkBackend()
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v.describeImage(mkFile(root, 'l.png'))
  for (const f of ['id', 'kind', 'text', 'tags', 'cached', 'model', 'at']) {
    assert.ok(f in r, '要有字段 ' + f)
  }
  assert.equal(r.kind, 'image')
  assert.ok(Array.isArray(r.tags))
})

test('★ 视频输出带 timeline', async () => {
  const root = mkWorld()
  const { backend } = mkBackend()
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v.describeVideo(mkFile(root, 'm.mp4'))
  assert.ok(Array.isArray(r.timeline), '视频要有 timeline')
  assert.ok(r.timeline.length >= 4, '★ 主人验收：至少 4 个时间点')
})

// ══════════ 平台无关 ══════════

test('★★ 平台信息不进描述正文（同一张图在哪看都是同一句话）', async () => {
  const root = mkWorld()
  const { backend } = mkBackend('一只鲸鱼')
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const img = mkFile(root, 'n.png')

  // 管线本身就不接受 source/who —— 签名里没有这两个参数
  const r1 = await v.describeImage(img)
  const r2 = await v.describeImage(img, { focus: '' })
  assert.equal(r1.text, r2.text)
  // 输出里不该出现平台词
  const json = JSON.stringify(r1)
  for (const w of ['qq', 'QQ', 'bilibili', 'B站', '空间']) {
    assert.equal(json.includes(w), false, '★ 输出里不许有平台信息：' + w)
  }
})

test('★ kindOf 按扩展名判，判不出就抛（不猜）', () => {
  assert.equal(kindOf('a.png'), 'image')
  assert.equal(kindOf('b.MP4'), 'video')
  assert.equal(kindOf('c.m4a'), 'audio')
  assert.throws(() => kindOf('d.xyz'), /看不出/)
})

// ══════════ 进上下文只放摘要 ══════════

test('★★ 进上下文只放摘要 + id，不放全文', async () => {
  const root = mkWorld()
  const { backend } = mkBackend('鲸'.repeat(300))
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v.describeImage(mkFile(root, 'o.png'))

  const line = renderForContext(r, { maxChars: 60 })
  assert.ok(line.length < 100, '★ 进上下文的那行要短')
  assert.match(line, /\[图 /, '要标类型')
  assert.ok(line.includes(r.id.slice(0, 8)), '要带 id（便于按 id 取原文）')
})

test('★ 视频的上下文行标注时间点数量', async () => {
  const root = mkWorld()
  const { backend } = mkBackend()
  const v = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v.describeVideo(mkFile(root, 'p.mp4'))
  const line = renderForContext(r)
  assert.match(line, /时间点/)
})

// ══════════ 缓存工具 ══════════

test('clampText：不超限不动，超了截断+省略号', () => {
  assert.deepEqual(clampText('短', 10), { text: '短', truncated: false })
  const long = clampText('x'.repeat(20), 10)
  assert.equal(long.truncated, true)
  assert.equal(long.text.length, 11, '10 字 + 1 个省略号')
})

test('hashBytes 稳定', () => {
  assert.equal(hashBytes(Buffer.from('abc')), hashBytes(Buffer.from('abc')))
  assert.notEqual(hashBytes(Buffer.from('abc')), hashBytes(Buffer.from('abd')))
})

// ══════════ P1 真机判据：缓存落盘 ══════════

test('★★ 缓存真的落盘（换一个管线实例也能命中）', async () => {
  const root = mkWorld()
  const { backend, calls } = mkBackend()
  const img = mkFile(root, 'q.png')

  const v1 = createVision({ root, recognize: backend, model: 'm1' })
  await v1.describeImage(img)

  // 新建一个实例（模拟插件重启）
  const v2 = createVision({ root, recognize: backend, model: 'm1' })
  const r = await v2.describeImage(img)
  assert.equal(r.cached, true, '★ 落盘后新实例也能命中')
  assert.equal(calls.describe, 1, '★ 重启后不重算')
})

test('★ 缓存目录在世界根下面', async () => {
  const root = mkWorld()
  const v = createVision({ root, model: 'm1' })
  assert.ok(v.cache.dir().startsWith(root), '缓存要在世界根下：' + v.cache.dir())
})
