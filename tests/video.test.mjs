// 视频帧：取点规则、时长解析，以及真的用 ffmpeg 抽一帧拼图。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseDuration, planTimes, videoFilmstrip } from '../lib/video.mjs'

test('时长解析：从 ffmpeg 的 stderr 里抠，不额外依赖 ffprobe', () => {
  assert.equal(parseDuration('  Duration: 00:00:03.00, start: 0.000000, bitrate: 123 kb/s'), 3)
  assert.equal(parseDuration('  Duration: 01:02:03.50, start: 0'), 3723.5)
  assert.equal(parseDuration('no duration here'), 0)
})

test('取点：避开片头片尾，均匀分布', () => {
  const times = planTimes(10, 4)
  assert.equal(times.length, 4)
  assert.ok(times[0] > 0, '别从 0 开始抽（常常是黑屏）')
  assert.ok(times[times.length - 1] < 10)
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]))
  assert.deepEqual(planTimes(0, 6), [])
  assert.equal(planTimes(5, 999).length, 16, '最多 16 帧')
})

function makeClip() {
  const dir = mkdtempSync(join(tmpdir(), 'fw-video-'))
  const file = join(dir, 'clip.mp4')
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', '-pix_fmt', 'yuv420p', file], { timeout: 30000 })
  return file
}

test('真抽帧：拼成一张带时间标注的胶片条', async (t) => {
  let file
  try { file = makeClip() } catch {
    t.skip('本机没有 ffmpeg，跳过真实抽帧')
    return
  }
  const sheet = await videoFilmstrip(file, { title: '测试片', count: 4, maxEdge: 240 })
  assert.ok(sheet.data.length > 1000, '产出的 PNG 不该是空壳')
  assert.equal(sheet.frames, 4)
  assert.ok(Math.abs(sheet.durationSec - 2) < 0.2)
  assert.ok(sheet.width > 100 && sheet.height > 100)
  // PNG 魔数：别把别的格式当图片交出去
  assert.equal(sheet.data.subarray(1, 4).toString('ascii'), 'PNG')
})

test('不是视频就如实报错，别返回半张图', async (t) => {
  let result
  try {
    const dir = mkdtempSync(join(tmpdir(), 'fw-video-bad-'))
    const bad = join(dir, 'not-a-video.mp4')
    execFileSync('node', ['-e', "require('node:fs').writeFileSync(process.argv[1], 'hello')", bad], { timeout: 10000 })
    result = await videoFilmstrip(bad, { count: 2 })
  } catch (error) {
    assert.match(String(error.message), /读不出视频时长|一帧都没抽出来/)
    return
  }
  assert.fail('不是视频却成功了：' + JSON.stringify(result && result.frames))
})
