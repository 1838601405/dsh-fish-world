// 视频帧：先用 ffmpeg 抽几帧，再交给 read-animation 的胶片条合成一张图。
//
// 复用而不是重造：
//   · 解码靠系统 ffmpeg（不引原生解码库、不改宿主内核）；
//   · 拼版、标时间戳、压预算全部走 core-plugins/read-animation/filmstrip.js；
//   · sharp 也走它自己的解析链（read-animation/sharp.js），不另找一份。
//
// 产物是一张 PNG：落盘后把路径写进投递文本，模型用 read_image 就能看。
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFilmstrip } from './core-plugins/read-animation/filmstrip.js'
import { loadSharp } from './core-plugins/read-animation/sharp.js'

export const FFMPEG_ENV = 'DSH_FISH_WORLD_FFMPEG'
export const DEFAULT_FRAME_COUNT = 6
export const DEFAULT_MAX_EDGE = 480
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_DIMENSION = 1600

function run(exe, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(exe, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout, stderr: String(stderr || ''), error })
      })
    } catch (error) {
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: '', error })
    }
  })
}

export function ffmpegPath() {
  return String(process.env[FFMPEG_ENV] || '').trim() || 'ffmpeg'
}

/** 从 ffmpeg -i 的 stderr 里读时长：不额外依赖 ffprobe。 */
export function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''))
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** 均匀取点，但避开片头片尾：头和尾常常是黑屏或过场。 */
export function planTimes(durationSec, count) {
  const n = Math.max(1, Math.min(Math.round(Number(count) || DEFAULT_FRAME_COUNT), 16))
  const total = Number(durationSec) || 0
  if (!total) return []
  const start = total * 0.05
  const end = total * 0.95
  const span = Math.max(0, end - start)
  return Array.from({ length: n }, (_, index) => Number((start + (span * index) / Math.max(1, n - 1)).toFixed(3)))
}

export async function probeDuration(file, { exe = ffmpegPath(), timeoutMs } = {}) {
  const result = await run(exe, ['-hide_banner', '-i', file], { timeoutMs })
  // ffmpeg 只报信息不产出时也会以非 0 退出，所以这里看 stderr 而不是退出码。
  return parseDuration(result.stderr)
}

async function grabFrame(file, timeSec, { exe, maxEdge }) {
  // 滤镜里的逗号是参数分隔符，`min(iw,480)` 必须用引号包住，否则 ffmpeg 会把 480):-2 当成滤镜名。
  const filter = "scale='min(iw," + maxEdge + ")':-2"
  const result = await run(exe, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(timeSec), '-i', file,
    '-frames:v', '1',
    '-vf', filter,
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  ])
  if (!result.ok || !result.stdout || !result.stdout.length) return null
  const sharp = loadSharp()
  const meta = await sharp(result.stdout).metadata()
  return { data: result.stdout, width: meta.width || 0, height: meta.height || 0, timeMs: timeSec * 1000 }
}

/**
 * 抽帧 + 拼成一张胶片条。
 * 返回 { data, width, height, durationSec, frames }；没有可用帧时抛错，由调用方降级。
 */
export async function videoFilmstrip(file, options = {}) {
  const {
    count = DEFAULT_FRAME_COUNT,
    maxEdge = DEFAULT_MAX_EDGE,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDimension = DEFAULT_MAX_DIMENSION,
    title = '',
    exe = ffmpegPath(),
  } = options

  const durationSec = await probeDuration(file, { exe })
  const times = planTimes(durationSec, count)
  if (!times.length) throw new Error('读不出视频时长（不是视频文件，或者 ffmpeg 不在 PATH 上）')

  const picked = []
  for (const time of times) {
    const frame = await grabFrame(file, time, { exe, maxEdge })
    if (frame && frame.width && frame.height) picked.push(frame)
  }
  if (!picked.length) throw new Error('一帧都没抽出来')

  const tiles = picked.map((frame, index) => ({
    data: frame.data,
    width: frame.width,
    height: frame.height,
    frame: { index: index + 1, timeMs: Math.round(frame.timeMs) },
  }))
  const header = [
    title ? '视频：' + title : '视频',
    '时长 ' + durationSec.toFixed(1) + 's · 抽了 ' + picked.length + ' 帧（每帧标了时间）',
  ].join('\n')

  const sheet = await buildFilmstrip(loadSharp(), {
    tiles,
    header,
    maxBytes,
    maxDimension,
    tileMaxWidth: maxEdge,
    tileMaxHeight: maxEdge,
  })
  return { ...sheet, durationSec, frames: picked.length }
}

/** 落盘成一张 PNG，返回路径；目录不存在就建。 */
export function saveFrameSheet(dir, name, data) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, data)
  return file
}
