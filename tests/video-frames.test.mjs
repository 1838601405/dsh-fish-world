// 视频帧服务：下载上限、缓存、失败如实返回。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_VIDEO_BYTES, createVideoFrames } from '../lib/video-frames.mjs'

function clipBytes() {
  const dir = mkdtempSync(join(tmpdir(), 'fw-vf-'))
  const file = join(dir, 'clip.mp4')
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=120x90:rate=10:duration=1', '-pix_fmt', 'yuv420p', file], { timeout: 30000 })
  return readFileSync(file)
}

function fixture({ bytes, fail = '', size = 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'fw-vf-root-'))
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (fail) throw new Error(fail)
    return {
      ok: true,
      headers: { get: () => (size ? String(size) : '') },
      arrayBuffer: async () => bytes,
    }
  }
  const service = createVideoFrames({ storage: { layout: () => ({ root }) }, fetchImpl, logger: { warn() {} } })
  return { service, root, calls }
}

test('下载 → 抽帧 → 落一张 PNG；同一个视频第二次直接命中缓存', async (t) => {
  let bytes
  try { bytes = clipBytes() } catch {
    t.skip('本机没有 ffmpeg，跳过')
    return
  }
  const { service, root, calls } = fixture({ bytes })
  const first = await service.fromUrl({ url: 'http://x/video.mp4', name: '群里那个' })
  assert.equal(first.ok, true, first.error)
  assert.equal(existsSync(first.path), true)
  assert.equal(first.cached, false)
  assert.ok(first.frames > 0)
  assert.ok(first.path.startsWith(join(root, '.fish-world', '视频帧')), '落在工作区里，模型才读得到')

  const second = await service.fromUrl({ url: 'http://x/video.mp4', name: '群里那个' })
  assert.equal(second.cached, true)
  assert.equal(second.path, first.path)
  assert.equal(calls.length, 1, '命中的不该再下载一次')
})

test('没有地址、下载失败、太大——三种都要如实说，不许静默', async () => {
  const noUrl = fixture({ bytes: Buffer.alloc(0) })
  assert.equal((await noUrl.service.fromUrl({})).ok, false)

  const broken = fixture({ bytes: Buffer.alloc(0), fail: 'boom' })
  const failed = await broken.service.fromUrl({ url: 'http://x/v.mp4' })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /boom|取视频失败/)

  const huge = fixture({ bytes: Buffer.alloc(0), size: MAX_VIDEO_BYTES + 1 })
  const tooBig = await huge.service.fromUrl({ url: 'http://x/v.mp4' })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /太大/)
})
