// 鱼的头像：按心情换样子。
//
// 两种来源，优先级从高到低：
//  1. 主人自己放的情绪图：$DSH_HOME/fish-world-moods/<emotion>.png|gif|webp
//     命名用心情维度（happy / calm / sweet / heartache / worry / sad / jealous）
//     或心情档（great / good / ok / low / bad）。
//  2. 角色卡图片 + 视觉滤镜：只有一张图时，用色彩与明度表达情绪，
//     并在界面上如实说明这是滤镜而不是另一张画。
//
// 这里只读文件、不写文件；情绪图由主人自己放进去。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

const MOOD_DIR_NAME = 'fish-world-moods'

// 心情维度 → 中文名与滤镜参数。滤镜只改观感，不伪造内容。
const EMOTION_STYLE = {
  happy: { label: '开心', filter: 'saturate(1.15) brightness(1.06)' },
  calm: { label: '踏实', filter: 'saturate(0.9) brightness(1.02)' },
  sweet: { label: '甜蜜', filter: 'saturate(1.1) brightness(1.04) hue-rotate(-6deg)' },
  heartache: { label: '心疼', filter: 'saturate(0.75) brightness(0.96)' },
  worry: { label: '担心', filter: 'saturate(0.7) brightness(0.92)' },
  sad: { label: '难过', filter: 'saturate(0.45) brightness(0.86)' },
  jealous: { label: '吃醋', filter: 'saturate(1.05) hue-rotate(18deg) brightness(0.98)' },
  neutral: { label: '平静', filter: 'none' },
  // 五档兜底：没有维度数据时 dominantEmotion 会返回 great/good/ok/low/bad，
  // 这里必须有对应条目，否则标签会回落成「平静」（以前 72 分显示平静、上游显示开心）。
  // 名字与 dsh-feiyu-mood 的 moodLabel 对齐：欢喜 80 / 开心 62 / 一般 42 / 心疼 25 / 难过。
  great: { label: '欢喜', filter: 'saturate(1.2) brightness(1.08)' },
  good: { label: '开心', filter: 'saturate(1.1) brightness(1.04)' },
  ok: { label: '一般', filter: 'none' },
  low: { label: '心疼', filter: 'saturate(0.7) brightness(0.94)' },
  bad: { label: '难过', filter: 'saturate(0.45) brightness(0.86)' },
}

// 情绪 → 表情库里的标签/名字关键词。图库的标签是主人自己打的（「哭」「比耶」「炸毛」…），
// 这里按**包含**匹配，不要求完全相等：打「微笑着」也能命中「微笑」。
// 没配专属情绪图时，头像就按这张表去表情库里挑一张。
const EMOTION_KEYWORDS = {
  happy: ['开心', '高兴', '笑', '兴奋', '比耶', '点赞', '得意', '可爱', '萌', '期待', '好嘞'],
  calm: ['淡定', '平静', '面无表情', '呆', '观察', '摊手', '喝茶', '看戏', '无语'],
  sweet: ['亲亲', '爱心', '比心', '脸红', '害羞', '撒娇', '抱抱', '爱你'],
  heartache: ['心疼', '抱抱', '安慰', '担心', '委屈'],
  worry: ['担心', '冒汗', '流汗', '问号', '疑惑', '紧张', '着急'],
  sad: ['难过', '哭', '流泪', '眼泪', '泪眼', '丧', '瘫', '崩溃', '委屈'],
  jealous: ['吃醋', '生气', '哼', '嫌弃', '斜眼', '白眼', '凶'],
  neutral: ['淡定', '面无表情', '呆', '观察', '无语', '看戏'],
  // 没有维度数据时的五档兜底
  great: ['开心', '兴奋', '星星眼', '比耶', '点赞', '得意'],
  good: ['微笑', '可爱', '期待', '享受', '惬意'],
  ok: ['淡定', '面无表情', '呆', '观察', '喝茶'],
  low: ['委屈', '丧', '无奈', '叹', '瘫'],
  bad: ['哭', '流泪', '难过', '崩溃', '眼泪'],
}

// 反义排除：图库标签是主人随手打的，一张「气死你」也会带「得意」。
// 正向情绪不能挑到明显负面的图（哭/生气/抓狂…），反过来也一样。
const NEGATIVE_STRONG = ['生气', '气死', '凶', '抓狂', '崩溃', '哭', '流泪', '难过', '怒', '骂', '黑化', '嫌弃', '白眼', '死鱼眼', '丧']
const EMOTION_EXCLUDE = {
  happy: NEGATIVE_STRONG,
  great: NEGATIVE_STRONG,
  good: NEGATIVE_STRONG,
  calm: NEGATIVE_STRONG,
  sweet: NEGATIVE_STRONG,
  neutral: NEGATIVE_STRONG,
  ok: NEGATIVE_STRONG,
  // 负面情绪反过来：别挑到明显在生气的图
  sad: ['生气', '气死', '凶', '抓狂', '怒气', '骂', '黑化', '白眼'],
  worry: ['生气', '气死', '凶', '抓狂', '怒气', '骂'],
  heartache: ['生气', '气死', '凶', '抓狂', '怒气', '骂'],
  low: ['生气', '气死', '凶', '抓狂', '怒气', '骂'],
  bad: ['生气', '气死', '凶', '抓狂', '怒气', '骂'],
  jealous: [], // 吃醋本来就常带一点生气
}

const IMAGE_EXT = ['png', 'gif', 'webp', 'jpg', 'jpeg']
const MAX_BYTES = 8 * 1024 * 1024

/** 小型确定性哈希（FNV-1a）：同一天、同情绪总是挑到同一张，刷新不闪。 */
function hash32(text) {
  let h = 0x811c9dc5
  const value = String(text || '')
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 从表情库里按情绪挑一张。返回 { id, name, tags, url } 或 null。
 *
 * 打分：标签完全相等 4 / 标签包含关键词 3 / 名字包含关键词 2；取最高分那一组，
 * 再按「情绪 + 日期」做一次确定性轮换——同一天不会来回闪，隔天会换一张。
 * 没有匹配就返回 null（调用方退回角色图 + 滤镜，不随便拿一张不相干的图冒充）。
 */
export function pickStickerForEmotion(items, emotion, { dayKey = '' } = {}) {
  const list = Array.isArray(items) ? items : []
  const keywords = EMOTION_KEYWORDS[emotion] || EMOTION_KEYWORDS.neutral
  if (!keywords.length) return null

  const excludes = EMOTION_EXCLUDE[emotion] || []
  const scoreOf = (item) => {
    if (!item || !item.id) return 0
    const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag)) : []
    const name = String(item.name || '')
    // 先过反义排除：带明显反义情绪的图，这张情绪不用它。
    if (excludes.length) {
      const hay = tags.join('|') + '|' + name
      if (excludes.some((word) => hay.includes(word))) return 0
    }
    let score = 0
    for (const keyword of keywords) {
      if (tags.some((tag) => tag === keyword)) score = Math.max(score, 4)
      else if (tags.some((tag) => tag.includes(keyword))) score = Math.max(score, 3)
      else if (name.includes(keyword)) score = Math.max(score, 2)
    }
    return score
  }

  const scored = list.map((item) => ({ item, score: scoreOf(item) })).filter((x) => x.score > 0)
  if (!scored.length) return null
  const max = scored.reduce((best, x) => Math.max(best, x.score), 0)
  const top = scored
    .filter((x) => x.score === max)
    .map((x) => x.item)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const index = dayKey ? hash32(`${emotion}|${dayKey}`) % top.length : 0
  const item = top[index] || top[0]
  return {
    id: String(item.id),
    name: String(item.name || ''),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 6).map((tag) => String(tag)) : [],
    url: `/dsh-fish-world/sticker-image?id=${encodeURIComponent(String(item.id))}`,
  }
}

/**
 * 心情总分成五档，用于没有维度数据时兜底。
 *
 * 阈值与 dsh-feiyu-mood 的 moodLabel / moodEmoji 完全对齐（80 / 62 / 42 / 25）：
 * 挂饰显示「开心」而头像却是「一般」，会让人以为数据错了。
 */
export function bandOf(mood) {
  // null / undefined / '' 都表示"没有数据"，不能当成 0 分。
  if (mood == null || mood === '') return 'neutral'
  const value = Number(mood)
  if (!Number.isFinite(value)) return 'neutral'
  // 档位边界对齐 dsh-feiyu-mood：欢喜 80 / 开心 62 / 一般 42 / 心疼 25 / 难过
  if (value >= 80) return 'great'
  if (value >= 62) return 'good'
  if (value >= 42) return 'ok'
  if (value >= 25) return 'low'
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

export function createPortrait({ home = DSH_HOME, stickers = null, now = () => Date.now() } = {}) {
  const dir = home === DSH_HOME ? join(DSH_HOME, MOOD_DIR_NAME) : join(home, MOOD_DIR_NAME)

  /** 表情库（可以是服务对象，也可以是取服务的函数：它比 portrait 晚初始化）。 */
  function stickerList() {
    try {
      const value = typeof stickers === 'function' ? stickers() : stickers
      return value && typeof value.list === 'function' ? value.list() : []
    } catch { return [] }
  }

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
    const customHit = custom[emotion] || null
    const style = EMOTION_STYLE[emotion] || EMOTION_STYLE.neutral
    // 主人没放这张情绪图时，去表情库按标签挑一张：同一天稳定、隔天换一张。
    const dayKey = new Date(now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const stickerHit = customHit ? null : pickStickerForEmotion(stickerList(), emotion, { dayKey })
    const source = customHit ? 'custom' : (stickerHit ? 'sticker' : 'role')
    return {
      ok: true,
      emotion,
      emotionLabel: style.label,
      // 优先级：主人放的情绪图 → 表情库自动挑 → 角色图 + 滤镜
      source,
      imageUrl: customHit
        ? `/dsh-fish-world/mood-image?name=${encodeURIComponent(emotion)}`
        : (stickerHit ? stickerHit.url : (role?.avatar || '')),
      // 表情库的图本来就是按情绪挑的，不再叠滤镜；只有角色图才用滤镜补情绪。
      filter: source === 'role' ? style.filter : 'none',
      sticker: stickerHit ? { id: stickerHit.id, name: stickerHit.name, tags: stickerHit.tags } : null,
      displayName: role?.displayName || '鱼',
      available: Object.keys(custom),
      dir,
      note: customHit
        ? '正在使用你放进去的情绪图。'
        : (stickerHit
          ? `没有专属情绪图，头像从表情库自动挑了一张：${stickerHit.name || stickerHit.id}（按「${style.label}」的标签匹配）。`
          : (Object.keys(custom).length
            ? '没有这个情绪的专属图，表情库里也没找到匹配的，暂时用角色图加滤镜。'
            : '把情绪图放进 moodDir，或给表情库打上情绪标签，就会自动替换。')),
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
