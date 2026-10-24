// 鱼的头像：按心理状态换样子。
//
// 两种来源，优先级从高到低：
//  1. 主人自己放的情绪图：$DSH_HOME/fish-world-moods/<emotion>.png|gif|webp
//     命名用心理维度（happy / calm / sweet / heartache / worry / sad / jealous）
//     或心情档（great / good / ok / low / bad）。
//  2. 角色卡图片 + 视觉滤镜：只有一张图时，用色彩与明度表达情绪，
//     并在界面上如实说明这是滤镜而不是另一张画。
//
// 这里只读文件、不写文件；情绪图由主人自己放进去。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const MOOD_DIR_NAME = 'fish-world-moods'

// 心理维度 → 中文名与滤镜参数。滤镜只改观感，不伪造内容。
const EMOTION_STYLE = {
  happy: { label: '开心', filter: 'saturate(1.15) brightness(1.06)' },
  calm: { label: '踏实', filter: 'saturate(0.9) brightness(1.02)' },
  sweet: { label: '甜蜜', filter: 'saturate(1.1) brightness(1.04) hue-rotate(-6deg)' },
  heartache: { label: '心疼', filter: 'saturate(0.75) brightness(0.96)' },
  worry: { label: '担心', filter: 'saturate(0.7) brightness(0.92)' },
  sad: { label: '难过', filter: 'saturate(0.45) brightness(0.86)' },
  jealous: { label: '吃醋', filter: 'saturate(1.05) hue-rotate(18deg) brightness(0.98)' },
  neutral: { label: '平静', filter: 'none' },
}

const IMAGE_EXT = ['png', 'gif', 'webp', 'jpg', 'jpeg']
const MAX_BYTES = 8 * 1024 * 1024

/** 心情总分成五档，用于没有维度数据时兜底。 */
export function bandOf(mood) {
  // null / undefined / '' 都表示"没有数据"，不能当成 0 分。
  if (mood == null || mood === '') return 'neutral'
  const value = Number(mood)
  if (!Number.isFinite(value)) return 'neutral'
  if (value >= 80) return 'great'
  if (value >= 65) return 'good'
  if (value >= 45) return 'ok'
  if (value >= 30) return 'low'
  return 'bad'
}

/** 从 dims 里挑出最强的那一维；没有就用总分档位。 */
export function dominantEmotion(mood, dims) {
  const list = Array.isArray(dims) ? dims : []
  let best = null
  for (const dim of list) {
    if (!dim || !Object.hasOwn(EMOTION_STYLE, dim.key)) continue
    const value = Number(dim.value) || 0
    // 负面维度需要更高门槛：担心 40 分不一定比开心 30 分更主导。
    const weight = ['sad', 'worry', 'heartache', 'jealous'].includes(dim.key) ? 0.75 : 1
    const score = value * weight
    if (!best || score > best.score) best = { key: dim.key, score }
  }
  if (best && best.score >= 20) return best.key
  return bandOf(mood)
}

export function createPortrait({ home = DSH_HOME } = {}) {
  const dir = home === DSH_HOME ? join(DSH_HOME, MOOD_DIR_NAME) : join(home, MOOD_DIR_NAME)

  function ensureDir() {
    if (!existsSync(dir)) return false
    return true
  }

  /** 列出主人放进去的情绪图。 */
  function customImages() {
    if (!ensureDir()) return {}
    const out = {}
    try {
      for (const name of readdirSync(dir)) {
        const dot = name.lastIndexOf('.')
        if (dot <= 0) continue
        const key = name.slice(0, dot).toLowerCase()
        const ext = name.slice(dot + 1).toLowerCase()
        if (!IMAGE_EXT.includes(ext)) continue
        if (!Object.hasOwn(EMOTION_STYLE, key) && !['great', 'good', 'ok', 'low', 'bad'].includes(key)) continue
        if (!out[key]) out[key] = { file: name, ext }
      }
    } catch {}
    return out
  }

  /**
   * 解析当前应该显示什么。
   * @param {{ mood?: number, dims?: Array, role?: { avatar?: string, displayName?: string } }} input
   */
  function resolve({ mood, dims, role } = {}) {
    const emotion = dominantEmotion(mood, dims)
    const custom = customImages()
    const customHit = custom[emotion] || (['great', 'good', 'ok', 'low', 'bad'].includes(emotion) ? null : null)
    const style = EMOTION_STYLE[emotion] || EMOTION_STYLE.neutral
    return {
      ok: true,
      emotion,
      emotionLabel: style.label,
      // 有主人自己的情绪图就用它，否则退回角色图 + 滤镜
      source: customHit ? 'custom' : 'role',
      imageUrl: customHit ? `/dsh-fish-world/mood-image?name=${encodeURIComponent(emotion)}` : (role?.avatar || ''),
      filter: customHit ? 'none' : style.filter,
      displayName: role?.displayName || '鱼',
      available: Object.keys(custom),
      dir,
      note: customHit
        ? '正在使用你放进去的情绪图。'
        : (Object.keys(custom).length
          ? '没有这个情绪的专属图，暂时用角色图加滤镜。'
          : '把情绪图放进 moodDir，就会自动替换。'),
    }
  }

  /**
   * 保存用户上传的情绪图。
   * @param {string} emotion 情绪 key（happy / calm / ... / neutral / great / low ...）
   * @param {{ base64?: string, dataUrl?: string, bytes?: Buffer }} source
   */
  function saveImage(emotion, source) {
    const key = String(emotion || '').toLowerCase()
    const allowed = Object.hasOwn(EMOTION_STYLE, key) || ['great', 'good', 'ok', 'low', 'bad'].includes(key)
    if (!allowed) throw new Error('不支持的情绪名称')
    const bytes = decodeImage(source)
    if (!bytes || !bytes.length) throw new Error('图片内容为空')
    if (bytes.length > MAX_BYTES) throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1048576)}MB`)
    const format = detectFormat(bytes)
    if (!format) throw new Error('只支持 PNG / JPEG / GIF / WebP')
    mkdirSync(dir, { recursive: true })
    // 覆盖同名旧图前，先删掉该情绪的其它格式，避免两份并存时取到旧的
    for (const ext of IMAGE_EXT) {
      const old = join(dir, `${key}.${ext}`)
      if (existsSync(old) && ext !== format) {
        try { rmSync(old) } catch {}
      }
    }
    writeFileSync(join(dir, `${key}.${format}`), bytes)
    return { ok: true, emotion: key, format, bytes: bytes.length }
  }

  function decodeImage(source) {
    if (!source) return null
    if (Buffer.isBuffer(source.bytes)) return source.bytes
    const raw = String(source.dataUrl || source.base64 || '')
    if (!raw) return null
    const comma = raw.indexOf(',')
    const b64 = raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw.replace(/^base64:\/\//, '')
    try { return Buffer.from(b64, 'base64') } catch { return null }
  }

  /** 用文件头判断真实格式，不信任文件名或 MIME。 */
  function detectFormat(bytes) {
    if (!bytes || bytes.length < 8) return ''
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
    if (bytes.length >= 12
      && bytes.slice(0, 4).toString('ascii') === 'RIFF'
      && bytes.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
    return ''
  }

  function removeImage(emotion) {
    const key = String(emotion || '').toLowerCase()
    let removed = 0
    for (const ext of IMAGE_EXT) {
      const file = join(dir, `${key}.${ext}`)
      if (!existsSync(file)) continue
      try { rmSync(file); removed += 1 } catch {}
    }
    return { ok: removed > 0, removed }
  }

  return { resolve, dir: () => dir, customImages, EMOTION_STYLE, saveImage, removeImage }
}
