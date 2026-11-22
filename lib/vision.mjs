// 视觉管线（2026-11-22，主人要求「平台无关的一层，所有入口共用，一次算过到处可用」）。
//
// ── 为什么要有这一层 ──
// 之前"看图"散在四处：QQ 收图、表情入库、B站封面、空间配图，各自实现、各自口径；
// 视频基本等于没看过。同一张图从两个入口来会被算两次，花的钱和上下文都是重复的。
//
// ── 这一层只认什么 ──
// **只认文件，不认平台。** 平台信息由调用方通过 { source, who, when } 带进来，
// 它只用来记账，**不进描述正文** —— 同一张图在哪看都是同一句话。
//
// ── 三个能力 ──
//   describeImage(file, { focus })    单图描述
//   describeVideo(file, { frames })   视频时序理解
//   transcribeAudio(file)             语音转写
//
// ── 成本纪律（决定这套能不能长期跑）──
//   · 缓存键 = sha256 + focus + 模型版本，跨平台共享
//   · 视频默认抽 6–8 帧；长视频分段摘要，不逐帧
//   · 图 300 字、视频摘要 500 字上限，超了截断并标记
//   · 每轮上下文只放摘要 + id，原文留库按 id 取
//   · 同一文件连续失败 2 次 → 标记不可用，不再重试
//
// ── 统一输出（不许调用方自己拼字符串）──
//   { id, kind, text, timeline?, tags, cached, model, at, truncated?, note? }

import { existsSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { cacheKey, hashFile, createVisionCache } from './vision-cache.mjs'

/** 图描述字数上限（主人定的 300）。 */
export const IMAGE_TEXT_MAX = 300
/** 视频摘要字数上限（主人定的 500）。 */
export const VIDEO_TEXT_MAX = 500
/** 语音转写字数上限（没有明说，比视频放宽一点，转写本来就长）。 */
export const AUDIO_TEXT_MAX = 1500
/** 视频默认抽帧数。 */
export const DEFAULT_FRAMES = 7
/** 连续失败到这个次数就标记不可用。 */
export const FAIL_LIMIT = 2

const KIND = Object.freeze({ IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' })

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.amr'])

/** 按扩展名判 kind。判不出来就抛 —— 不猜。 */
export function kindOf(file) {
  const ext = extname(String(file || '')).toLowerCase()
  if (IMAGE_EXT.has(ext)) return KIND.IMAGE
  if (VIDEO_EXT.has(ext)) return KIND.VIDEO
  if (AUDIO_EXT.has(ext)) return KIND.AUDIO
  throw new Error(`看不出这是什么类型的文件（扩展名 ${ext || '(无)'}）`)
}

/** 截断到上限，返回 {text, truncated}。 */
export function clampText(text, max) {
  const s = String(text == null ? '' : text).trim()
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max) + '…', truncated: true }
}

/**
 * 建视觉管线。
 *
 * @param {object} opts
 * @param {string} opts.root          世界根（缓存落这里）
 * @param {object} [opts.cache]       现成的缓存器（不给就自己建）
 * @param {object} [opts.recognize]   识别后端：{ describe(file, opts), video(file, opts), audio(file, opts) }
 * @param {string} [opts.model]       模型标识（进缓存键）
 * @param {object} [opts.logger]
 * @param {() => number} [opts.now]
 * @param {object} [opts.marks]       不可用标记存储（默认内存）
 */
export function createVision({
  root,
  cache,
  recognize,
  model = '',
  logger,
  now = () => Date.now(),
  marks
} = {}) {
  if (!root) throw new Error('视觉管线需要世界根目录')

  const store = cache || createVisionCache({ root, now, logger })

  // 失败计数：{ key: { count, at, why } }，超过 FAIL_LIMIT 就不再试
  const failures = marks || new Map()

  function markFailed(key, why) {
    const cur = failures.get(key) || { count: 0 }
    const next = { count: cur.count + 1, at: now(), why: String(why || '').slice(0, 200) }
    failures.set(key, next)
    return next
  }

  function isDead(key) {
    const cur = failures.get(key)
    return Boolean(cur && cur.count >= FAIL_LIMIT)
  }

  /**
   * 统一入口：判类型 → 查缓存 → 调后端 → 落缓存 → 归一输出。
   *
   * ★ 所有对外能力都走这里，保证「输出格式只有一处定义」。
   */
  async function run({ file, kind, focus = '', max, call, timelineOf }) {
    if (!file) throw new Error('没给文件')
    if (!existsSync(file)) throw new Error('文件不存在：' + file)

    let stat
    try { stat = statSync(file) } catch (error) {
      throw new Error('读不到文件：' + String(error?.message || error))
    }
    if (!stat.isFile()) throw new Error('给的不是文件：' + file)

    const sha256 = hashFile(file)
    const key = cacheKey({ sha256, focus, model })

    // ① 缓存命中：不调模型
    const hit = store.get(key)
    if (hit) {
      return { ...hit, cached: true }
    }

    // ② 标记不可用：连续失败两次就不试了
    if (isDead(key)) {
      const cur = failures.get(key) || {}
      return {
        id: key,
        kind,
        text: '这个文件之前连续两次没识别成功，不再重试',
        tags: [],
        cached: false,
        model,
        at: now(),
        note: 'unavailable',
        why: String(cur.why || '')
      }
    }

    // ③ 没接后端
    if (!recognize) {
      return {
        id: key,
        kind,
        text: '',
        tags: [],
        cached: false,
        model,
        at: now(),
        note: '没接识别后端',
        why: 'no-backend'
      }
    }

    // ④ 调后端
    let raw
    try {
      raw = await call(recognize)
    } catch (error) {
      const why = String(error?.message || error)
      const cur = markFailed(key, why)
      return {
        id: key,
        kind,
        text: '',
        tags: [],
        cached: false,
        model,
        at: now(),
        note: cur.count >= FAIL_LIMIT ? 'unavailable' : 'failed',
        why: why.slice(0, 300)
      }
    }

    // 后端说"没看清" —— 那不是失败，是诚实的答案（主人要求：不返回空串）
    const saidText = String(raw?.text == null ? '' : raw.text).trim()
    if (!saidText) {
      const cur = markFailed(key, '后端返回空')
      return {
        id: key,
        kind,
        text: '没看清',
        tags: [],
        cached: false,
        model,
        at: now(),
        note: 'blank',
        why: cur.count >= FAIL_LIMIT ? '连续空返回，已标记不可用' : '后端返回空'
      }
    }

    // ⑤ 归一 + 截断
    const { text, truncated } = clampText(saidText, max)
    const out = {
      id: key,
      kind,
      text,
      tags: Array.isArray(raw?.tags) ? raw.tags.filter((x) => typeof x === 'string').slice(0, 20) : [],
      cached: false,
      model,
      at: now()
    }
    if (timelineOf) {
      const tl = timelineOf(raw)
      if (Array.isArray(tl) && tl.length) out.timeline = tl
    }
    if (truncated) out.truncated = true

    // ⑥ 落缓存（失败不影响返回）
    store.set(key, out)
    try { store.maybePrune?.() } catch {}

    return out
  }

  /** 单图描述。 */
  async function describeImage(file, { focus = '' } = {}) {
    return run({
      file,
      kind: KIND.IMAGE,
      focus,
      max: IMAGE_TEXT_MAX,
      call: (backend) => backend.describe(file, { focus })
    })
  }

  /**
   * 视频：抽帧 + 时序。
   *
   * ★ 长视频不逐帧：默认 7 帧（主人要求 6–8），摘要上限 500 字。
   */
  async function describeVideo(file, { focus = '', frames = DEFAULT_FRAMES } = {}) {
    const n = Math.max(2, Math.min(12, Number(frames) || DEFAULT_FRAMES))
    return run({
      file,
      kind: KIND.VIDEO,
      focus,
      max: VIDEO_TEXT_MAX,
      call: (backend) => backend.video(file, { focus, frames: n }),
      timelineOf: (raw) => raw?.timeline
    })
  }

  /** 语音转写。 */
  async function transcribeAudio(file, { focus = '' } = {}) {
    return run({
      file,
      kind: KIND.AUDIO,
      focus,
      max: AUDIO_TEXT_MAX,
      call: (backend) => backend.audio(file, { focus }),
      timelineOf: (raw) => raw?.timeline
    })
  }

  /** 按文件类型自动选。 */
  async function describe(file, opts = {}) {
    const kind = kindOf(file)
    if (kind === KIND.IMAGE) return describeImage(file, opts)
    if (kind === KIND.VIDEO) return describeVideo(file, opts)
    return transcribeAudio(file, opts)
  }

  return {
    describeImage,
    describeVideo,
    transcribeAudio,
    describe,
    kindOf,
    cache: store,
    /** 看某个文件当前的失败状态（面板/排查用）。 */
    statusOf: (file, { focus = '' } = {}) => {
      try {
        const key = cacheKey({ sha256: hashFile(file), focus, model })
        return { key, failed: failures.get(key) || null, dead: isDead(key) }
      } catch { return null }
    },
    /** 手动清掉失败标记（文件换过了、或主人要求重试）。 */
    clearFailure: (key) => failures.delete(key)
  }
}

/**
 * 把管线输出渲染成**进上下文的一行**。
 *
 * ★ 主人要求「每轮上下文只放摘要 + id，原文留库按 id 取」。
 *   所以这里只给：类型 + id + 摘要 + 时间点数量。
 *   平台信息一个字都不加 —— 同一张图在哪看都是同一句话。
 */
export function renderForContext(result, { maxChars } = {}) {
  if (!result) return ''
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 120
  const body = String(result.text || '').trim()
  if (!body) return ''
  const short = body.length > cap ? body.slice(0, cap) + '…' : body
  const tag = result.kind === KIND.VIDEO ? '视频' : result.kind === KIND.AUDIO ? '语音' : '图'
  const marks = []
  if (result.cached) marks.push('缓存')
  if (result.truncated) marks.push('已截断')
  if (Array.isArray(result.timeline) && result.timeline.length) {
    marks.push(result.timeline.length + ' 个时间点')
  }
  const suffix = marks.length ? '（' + marks.join(' · ') + '）' : ''
  return `[${tag} ${String(result.id || '').slice(0, 8)}] ${short}${suffix}`
}
