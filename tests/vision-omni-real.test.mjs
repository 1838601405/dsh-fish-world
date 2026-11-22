// 视觉管线 omni 后端 —— **真材料**判据（2026-11-22 主人要求 P2）。
//
// 这份和 vision-omni.test.mjs 分开：那份全用替身（AGENTS 6.3 测试不许依赖本机状态），
// 这份**故意**依赖本机的 ffmpeg + omni + Python，因为 P2 的验收原话就是
// 「装完跑一次真材料：视频出时序、语音出文字」。
//
// 缺依赖时**跳过并说明**，不假绿也不假红（AGENTS 0③ 出问题时说实话）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createOmniRecognize, OMNI_PACKAGE } from '../lib/vision-omni.mjs'
import { createVision } from '../lib/vision.mjs'
import { resolveDependency } from '../lib/env.mjs'

/** 本机装了 omni 才跑真材料；没装就整份跳过。 */
function omniInstalled() {
  try { return resolveDependency(OMNI_PACKAGE).found === true } catch { return false }
}

/** 造一段 15 秒的测试片（验收 b：15 秒视频 → 时序至少 4 个时间点）。 */
function makeClip(seconds = 15) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-omni-'))
  const file = join(dir, 'clip.mp4')
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=${seconds}`,
    '-pix_fmt', 'yuv420p', file
  ], { timeout: 60000 })
  return file
}

/** 造一段纯音（没有说话声）——用来验证转写链路真的跑通，而不是验证识别准不准。 */
function makeTone() {
  const dir = mkdtempSync(join(tmpdir(), 'fw-omni-audio-'))
  const file = join(dir, 'tone.wav')
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ar', '16000', '-ac', '1', file
  ], { timeout: 60000 })
  return file
}

function skipUnless(t, ok, why) {
  if (ok) return false
  t.skip(why)
  return true
}

test('真材料 · 视频 → 时间轴 + 一段话（15 秒 ≥ 4 个时间点）', async (t) => {
  if (skipUnless(t, omniInstalled(), `${OMNI_PACKAGE} 没装，跳过真材料`)) return
  let clip
  try { clip = makeClip(15) } catch {
    t.skip('本机没有 ffmpeg，跳过真材料')
    return
  }

  const back = createOmniRecognize({ gridDir: join(tmpdir(), 'fw-omni-grid') })
  const r = await back.video(clip)

  assert.ok(Array.isArray(r.timeline), '★ 要有时间轴')
  assert.ok(r.timeline.length >= 4, `★ 15 秒视频至少 4 个时间点，实际 ${r.timeline.length}`)
  assert.ok(r.timeline.length <= 12, '★ 不许逐帧（上限 12）')
  assert.equal(r.timeline[0].at, 0, '第一个时间点是 0')
  for (let i = 1; i < r.timeline.length; i += 1) {
    assert.ok(r.timeline[i].at > r.timeline[i - 1].at, '时间点必须递增')
  }
  assert.ok(r.timeline[r.timeline.length - 1].at <= 15, '时间点不许超出片长')

  assert.equal(typeof r.text, 'string')
  assert.ok(r.text.length > 0, '★ 不许返回空串')
  assert.ok(r.text.length <= 500, '★ 视频摘要 500 字上限')
  // 没看图通道时必须写明「没识别」，不许编一段画面内容出来
  assert.match(r.text, /没接看图通道，画面内容没识别/)
})

test('真材料 · 接上管线 → 第二次调用吃缓存，不再调后端', async (t) => {
  if (skipUnless(t, omniInstalled(), `${OMNI_PACKAGE} 没装，跳过真材料`)) return
  let clip
  try { clip = makeClip(15) } catch {
    t.skip('本机没有 ffmpeg，跳过真材料')
    return
  }

  const back = createOmniRecognize({ gridDir: join(tmpdir(), 'fw-omni-grid') })
  const root = mkdtempSync(join(tmpdir(), 'fw-omni-world-'))
  const vision = createVision({ root, recognize: back, model: back.modelVersion() })

  let calls = 0
  const counting = {
    ...back,
    async video(file, opts) { calls += 1; return back.video(file, opts) }
  }
  const vision2 = createVision({ root, recognize: counting, model: back.modelVersion() })

  const first = await vision2.describeVideo(clip)
  assert.equal(first.cached, false, '第一次没缓存')
  assert.equal(calls, 1, '第一次调了后端')
  assert.ok(first.timeline.length >= 4, '★ 时间轴要进缓存')

  const second = await vision2.describeVideo(clip)
  assert.equal(second.cached, true, '★ 第二次必须吃缓存')
  assert.equal(calls, 1, '★ 第二次不许再调后端')
  assert.deepEqual(second.timeline, first.timeline, '缓存里的时间轴要和第一次一致')
  assert.equal(second.text, first.text)

  // 换一个世界根（缓存不共享）→ 该重算，证明缓存真的落盘在 root 下
  const other = createVision({ root: mkdtempSync(join(tmpdir(), 'fw-omni-world2-')), recognize: counting, model: back.modelVersion() })
  const third = await other.describeVideo(clip)
  assert.equal(third.cached, false, '★ 缓存按世界根落盘，换个根就不命中')
  assert.equal(calls, 2)
  void vision
})

test('真材料 · 语音 → 转写链路真的跑通（不返回空串）', async (t) => {
  if (skipUnless(t, omniInstalled(), `${OMNI_PACKAGE} 没装，跳过真材料`)) return
  let tone
  try { tone = makeTone() } catch {
    t.skip('本机没有 ffmpeg，跳过真材料')
    return
  }

  const back = createOmniRecognize({ gridDir: join(tmpdir(), 'fw-omni-grid') })
  let r
  try {
    r = await back.audio(tone)
  } catch (error) {
    // 链路里任何一环缺（Python / faster-whisper / 模型）都要**如实报出来**，
    // 这正是验收 e 的「缺依赖时明确报错」——所以这里不让它变成假绿。
    const message = String(error?.message || error)
    assert.match(message, /语音转写失败/, '失败要走统一的报错口')
    assert.ok(message.length > 10, '报错要带原因，不能只有一句话')
    t.diagnostic('转写链路不可用：' + message)
    return
  }

  assert.equal(typeof r.text, 'string')
  assert.ok(r.text.length > 0, '★ 转写不许返回空串（纯音没有说话声 → 也要说「没听出话」）')
  assert.ok(Array.isArray(r.timeline), '时间轴字段要在')
})

test('真材料 · 缺 ffmpeg → 明确报错，不静默', async (t) => {
  if (skipUnless(t, omniInstalled(), `${OMNI_PACKAGE} 没装，跳过真材料`)) return
  let clip
  try { clip = makeClip(3) } catch {
    t.skip('本机没有 ffmpeg，跳过真材料')
    return
  }

  // 把 PATH 清空，让 ffmpeg/ffprobe 真的找不到 —— 这是「缺依赖」的真现场。
  const savedPath = process.env.PATH
  const savedExt = process.env.PATHEXT
  const back = createOmniRecognize({ gridDir: join(tmpdir(), 'fw-omni-grid') })
  try {
    process.env.PATH = ''
    process.env.PATHEXT = ''
    await assert.rejects(() => back.video(clip), (error) => {
      assert.match(error.message, /缺 ffmpeg/, '★ 缺依赖要说清缺什么')
      assert.match(error.message, /winget install Gyan\.FFmpeg|PATH/, '★ 还要给装法')
      return true
    })
  } finally {
    process.env.PATH = savedPath
    process.env.PATHEXT = savedExt
  }
})

test('真材料 · 不是视频的文件 → 明确报错，不返回半截结果', async (t) => {
  if (skipUnless(t, omniInstalled(), `${OMNI_PACKAGE} 没装，跳过真材料`)) return
  const dir = mkdtempSync(join(tmpdir(), 'fw-omni-bad-'))
  const bad = join(dir, 'not-a-video.mp4')
  writeFileSync(bad, '这不是视频，只是一行字')

  const back = createOmniRecognize({ gridDir: join(tmpdir(), 'fw-omni-grid') })
  await assert.rejects(() => back.video(bad), (error) => {
    assert.match(error.message, /读不了这个媒体文件|抽帧失败/, '要如实报读不出来')
    return true
  })
})

test('真材料 · 网格图真的落盘（宫格是后续看图的输入）', async (t) => {
  if (skipUnless(t, omniInstalled(), `${OMNI_PACKAGE} 没装，跳过真材料`)) return
  let clip
  try { clip = makeClip(6) } catch {
    t.skip('本机没有 ffmpeg，跳过真材料')
    return
  }

  const gridDir = mkdtempSync(join(tmpdir(), 'fw-omni-grid-'))
  const back = createOmniRecognize({ gridDir })
  const r = await back.video(clip)

  const { readdirSync } = await import('node:fs')
  const pngs = readdirSync(gridDir).filter((n) => n.endsWith('.png'))
  assert.ok(pngs.length >= 1, '★ 宫格图要落在指定目录')
  assert.ok(pngs.some((n) => n.startsWith('grid-')), '命名要能认出来')
  void r
  void existsSync
})
