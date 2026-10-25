// 把一条 QQ 视频变成一张胶片条，落盘后交给收信层当"图片"投递。
//
// 为什么走图片通道：投递层本来就把 images 里的每一项渲染成 `[图片] <本地路径>`，
// 而模型的 read_image 能直接打开工作区里的路径。这样视频帧不需要任何新的附件管线。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { videoFilmstrip } from './video.mjs'

export const FRAME_FOLDER = '视频帧'
/** 下载上限：超过这个大小就算远程视频，不拉（避免把会话拖住）。 */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 20000

export function createVideoFrames({ storage, home, logger, fetchImpl } = {}) {
  const fetch = fetchImpl || globalThis.fetch

  function rootDir() {
    try {
      const paths = storage?.layout?.()
      if (paths?.root) return paths.root
    } catch {}
    return join(home || '.', '鱼的世界')
  }

  function targetDir() {
    return join(rootDir(), '.fish-world', FRAME_FOLDER)
  }

  async function download(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error('取视频失败：HTTP ' + response.status)
      const length = Number(response.headers?.get?.('content-length') || 0)
      if (length && length > MAX_VIDEO_BYTES) throw new Error('视频太大（' + Math.round(length / 1048576) + 'MB），不抽帧')
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > MAX_VIDEO_BYTES) throw new Error('视频太大（' + Math.round(buffer.length / 1048576) + 'MB），不抽帧')
      return buffer
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @returns {ok:true, path, durationSec, frames, cached} 或 {ok:false, error}
   * 失败一律如实返回，由收信层决定只是少一张图，还是整条消息不投。
   */
  async function fromUrl(video) {
    const url = String(video && video.url ? video.url : '').trim()
    if (!url) return { ok: false, error: '这条视频没有可取的地址' }
    const dir = targetDir()
    const key = createHash('sha256').update(url).digest('hex').slice(0, 16)
    const sheetPath = join(dir, FRAME_FOLDER + '-' + key + '.png')
    if (existsSync(sheetPath)) return { ok: true, path: sheetPath, cached: true, frames: 0, durationSec: 0 }

    let file = ''
    try {
      const bytes = await download(url)
      mkdirSync(dir, { recursive: true })
      file = join(dir, 'src-' + key + '.bin')
      writeFileSync(file, bytes)
      const sheet = await videoFilmstrip(file, { title: String(video.name || '') })
      writeFileSync(sheetPath, sheet.data)
      return { ok: true, path: sheetPath, durationSec: sheet.durationSec, frames: sheet.frames, cached: false }
    } catch (error) {
      const message = String((error && error.message) || error)
      logger?.warn?.('fish-world: 视频抽帧失败：' + message)
      return { ok: false, error: message }
    } finally {
      if (file) { try { rmSync(file, { force: true }) } catch {} }
    }
  }

  return { fromUrl, dir: targetDir }
}
