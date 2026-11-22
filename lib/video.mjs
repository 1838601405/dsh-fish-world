// 视频帧：先抽几帧，再交给 read-animation 的胶片条合成一张图。
//
// 复用而不是重造：
//   · **抽帧与读时长走视觉管线**（lib/vision-omni.mjs）—— 这是方案 P5 的收口点：
//     全仓只许 vision 层起 ffmpeg，这里以前自己 execFile 一条一条抽，现在只问结果；
//   · 拼版、标时间戳、压预算全部走 core-plugins/read-animation/filmstrip.js；
//   · sharp 也走它自己的解析链（read-animation/sharp.js），不另找一份。
//
// 产物是一张 PNG：落盘后把路径写进投递文本，模型用 read_image 就能看。
// ★ 产物形状没变 —— 仍是**胶片条图**，不是文字摘要。改成摘要会让 QQ 视频
//   从「她自己看画面」降级成「读一段转述」，那是能力回退，P5 不做这种事。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFilmstrip } from './core-plugins/read-animation/filmstrip.js'
import { loadSharp } from './core-plugins/read-animation/sharp.js'
import { createOmniRecognize } from './vision-omni.mjs'

const DEFAULT_FRAME_COUNT = 6
export const DEFAULT_MAX_EDGE = 480
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_DIMENSION = 1600

/**
 * 视觉后端（懒建一次）。
 *
 * ★ 不带 worldRoot：抽帧不进缓存（缓存键是 sha256+focus+模型版本，
 *   而胶片条每次的取点都按片长算，且产物要的是图不是字），
 *   所以这里只要一个能起 ffmpeg 的后端，不要管线实例。
 * ★ 建不出来（没装 omni）时不在这里抛 —— 让第一次 probe/frames 时抛，
 *   那样错误信息里能带上「装法」，而不是在模块加载时就炸。
 */
let backend = null
function omniBackend() {
  if (!backend) backend = createOmniRecognize({})
  return backend
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

/**
 * 抽帧 + 拼成一张胶片条。
 * 返回 { data, width, height, durationSec, frames }；没有可用帧时抛错，由调用方降级。
 *
 * @param {string} file 视频路径
 * @param {object} [options]
 * @param {number} [options.count]       抽几帧（默认 6，最多 16）
 * @param {number} [options.maxEdge]     单帧最长边
 * @param {number} [options.maxBytes]    产物大小预算
 * @param {number} [options.maxDimension] 产物最长边预算
 * @param {string} [options.title]       抬头写什么
 */
export async function videoFilmstrip(file, options = {}) {
  const {
    count = DEFAULT_FRAME_COUNT,
    maxEdge = DEFAULT_MAX_EDGE,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDimension = DEFAULT_MAX_DIMENSION,
    title = '',
  } = options

  // ① 读时长（走视觉层；缺 ffprobe / 不是视频 → 带原文抛出）
  let durationSec = 0
  try {
    const info = await omniBackend().probe(file)
    durationSec = Number(info?.duration) || 0
  } catch (error) {
    // 保留原来那句人话（调用方与测试都认它），后面补上真原因，别把细节吞了。
    throw new Error(`读不出视频时长（不是视频文件，或者 ffmpeg 不在 PATH 上）：${String(error?.message || error)}`)
  }

  const times = planTimes(durationSec, count)
  if (!times.length) throw new Error('读不出视频时长（不是视频文件，或者 ffmpeg 不在 PATH 上）')

  // ② 抽帧（走视觉层）。帧先落临时目录，拼完就删 —— 不留在宿主工作目录里。
  const dir = mkdtempSync(join(tmpdir(), 'fw-frames-'))
  try {
    const picked = await loadFrames(file, times, { width: maxEdge, dir })
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

    // ③ 拼版（这一步一直走 read-animation，没动）
    const sheet = await buildFilmstrip(loadSharp(), {
      tiles,
      header,
      maxBytes,
      maxDimension,
      tileMaxWidth: maxEdge,
      tileMaxHeight: maxEdge,
    })
    return { ...sheet, durationSec, frames: picked.length }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 按时间点抽帧 → 读回内存 → 量出宽高。
 *
 * ★ 宽高必须真量：omni 只给路径与字节数，而 buildFilmstrip 要 width/height 排版。
 *   少量这一步会把 [object Object] 之类的脏东西拼进胶片条。
 */
async function loadFrames(file, times, { width, dir }) {
  const sharp = loadSharp()
  const picked = []
  let frames = []
  try {
    frames = await omniBackend().frames(file, { at: times, width, outDir: dir })
  } catch (error) {
    // 「一个时间点都没抽到」是这里要的降级信号；缺依赖那类错误照原样抛（带装法）。
    if (!/一帧都没抽出来|超出了片长/.test(String(error?.message || error))) throw error
    return picked
  }

  for (const frame of frames) {
    try {
      const data = readFileSync(frame.path)
      const meta = await sharp(data).metadata()
      if (!meta.width || !meta.height) continue
      picked.push({ data, width: meta.width, height: meta.height, timeMs: Number(frame.at) * 1000 })
    } catch {
      // 单帧读不出来就跳过：少一帧不影响整条，最后 picked 为空才报「一帧都没抽出来」。
    }
  }
  return picked
}
