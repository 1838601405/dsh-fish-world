// 图片整理：让一个视觉模型看图，产出名字 / 标签 / 说明，写回图库。
//
// 落盘：
//   $DSH_HOME/fish-world-sticker-vision.json   只有 apiKey，权限 0600，不进主配置
//   （baseUrl / model / enabled 这些非敏感配置走主配置的 stickerVision 段）
//
// 约定：
//   · 关着（enabled=false）就一个字都不改既有行为：收藏照旧只存图。
//   · 开着但没配好（缺 baseUrl / model / key）→ 整理时返回明确原因，不假装成功。
//   · 接口按 OpenAI 兼容的 /chat/completions 走，图片用 image_url + base64 data URL。
//     这样能接任何兼容服务（本地 llama.cpp / Ollama / 各家云），不绑定单一厂商。
//   · 只认结构化 JSON 回包；解析不出来就把原文截断报出来，不编标签。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

const SECRET_FILE = join(DSH_HOME, 'fish-world-sticker-vision.json')

export const DEFAULT_STICKER_VISION = {
  enabled: false,
  baseUrl: '',
  model: '',
  timeoutMs: 30000,
  // 交给模型的整理指令。留空就用内置的那段。
  prompt: '',
}

const DEFAULT_PROMPT = [
  '你在帮一个表情图库做整理。看这张图，只回一个 JSON 对象，不要任何多余文字。',
  '字段：',
  'name：给这张图起一个不超过 20 字的中文短名，描述画面主体（例如「蓝鲸娘·掏刀」「猫·垂眼」）。',
  'tags：3 到 6 个中文标签，覆盖：主体、动作/表情、风格、是不是动图。',
  'note：一句话说明这张图适合在什么情绪/场景下用，不超过 40 字。',
  '只依据画面里真实存在的东西，不要瞎编没看到的元素。',
].join('\n')

function num(value, lo, hi, fallback) {
  const x = Number(value)
  if (!Number.isFinite(x)) return fallback
  return Math.min(hi, Math.max(lo, x))
}

export function normalizeStickerVision(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const url = String(src.baseUrl == null ? '' : src.baseUrl).trim()
  return {
    enabled: src.enabled === true,
    baseUrl: /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : '',
    model: String(src.model == null ? '' : src.model).trim().slice(0, 120),
    timeoutMs: Math.round(num(src.timeoutMs, 3000, 120000, DEFAULT_STICKER_VISION.timeoutMs)),
    prompt: String(src.prompt == null ? '' : src.prompt).slice(0, 2000),
  }
}

/** 密钥只落盘一处、只读写这一处；接口永远不返回明文。 */
export function readStickerVisionSecret({ home = DSH_HOME } = {}) {
  const file = home === DSH_HOME ? SECRET_FILE : join(home, 'fish-world-sticker-vision.json')
  if (process.env.DSH_FISH_WORLD_VISION_KEY) return { key: String(process.env.DSH_FISH_WORLD_VISION_KEY), source: 'env' }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw.apiKey === 'string' && raw.apiKey) return { key: raw.apiKey, source: 'file' }
  } catch {}
  return { key: '', source: '' }
}

export function writeStickerVisionSecret(apiKey, { home = DSH_HOME } = {}) {
  const file = home === DSH_HOME ? SECRET_FILE : join(home, 'fish-world-sticker-vision.json')
  const value = String(apiKey == null ? '' : apiKey)
  if (!value) {
    try { writeFileSync(file, '{}', { encoding: 'utf8', mode: 0o600 }) } catch {}
    return { hasKey: false }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ apiKey: value }), { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(file, 0o600) } catch {}
  return { hasKey: true }
}

function mimeFor(format) {
  if (format === 'gif') return 'image/gif'
  if (format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

/** 从模型回包里抠出 JSON 对象：容忍 ```json 包裹、前后多余文字。 */
function parseJsonLoose(text) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced ? fenced[1] : '', raw]
  for (const candidate of candidates) {
    const body = String(candidate || '').trim()
    if (!body) continue
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      const obj = JSON.parse(body.slice(start, end + 1))
      if (obj && typeof obj === 'object') return obj
    } catch {}
  }
  return null
}

function cleanTags(value, limit, perLength) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,，、\s]+/)
  const out = []
  const seen = new Set()
  for (const entry of list) {
    const tag = String(entry == null ? '' : entry).trim().replace(/\s+/g, ' ').slice(0, perLength)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 视觉整理器。给一个 { bytes, format }，回 { name, tags, note }。
 * 依赖注入 fetchImpl，方便测试与离线替换。
 */
export function createStickerVision({ config, home = DSH_HOME, fetchImpl } = {}) {
  function currentConfig() {
    let raw = {}
    try { raw = config?.getConfig ? config.getConfig().stickerVision || {} : {} } catch {}
    return normalizeStickerVision(raw)
  }

  function secret() {
    return readStickerVisionSecret({ home })
  }

  /** 是否具备真正可用的整理能力：开关开了且三件套齐全。 */
  function ready() {
    const cfg = currentConfig()
    if (!cfg.enabled) return { ok: false, reason: 'disabled' }
    if (!cfg.baseUrl) return { ok: false, reason: '缺少接口地址' }
    if (!cfg.model) return { ok: false, reason: '缺少模型名' }
    if (!secret().key) return { ok: false, reason: '缺少 API key' }
    return { ok: true, config: cfg }
  }

  function status() {
    const cfg = currentConfig()
    const s = secret()
    const r = ready()
    return {
      ok: true,
      config: {
        enabled: cfg.enabled,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        prompt: cfg.prompt,
      },
      hasKey: !!s.key,
      keySource: s.source,
      ready: r.ok,
      reason: r.ok ? '' : r.reason,
    }
  }

  /**
   * 看一张图，回 { ok, name, tags, note } 或 { ok:false, error }。
   * 不写盘、不碰图库，纯识别 —— 写回由调用方决定。
   */
  async function describe({ bytes, format, animated = false }) {
    const r = ready()
    if (!r.ok) return { ok: false, error: `视觉整理未就绪：${r.reason}` }
    const cfg = r.config
    if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行时没有 fetch' }
    if (!bytes || !bytes.length) return { ok: false, error: '图片为空' }

    const dataUrl = `data:${mimeFor(format)};base64,${Buffer.from(bytes).toString('base64')}`
    // 动图只喂得到第一帧：明确告诉模型，别让它把动图当静图描述。
    const animatedHint = animated
      ? '\n注意：这是一张动图（GIF / 动图 WebP），你看到的只是第一帧，画面里有动作或表情变化。请至少给一个「动图」标签，name 尽量点出这个动作。'
      : ''
    const instructions = (cfg.prompt || DEFAULT_PROMPT) + animatedHint
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const res = await fetchImpl(cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + secret().key,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.2,
          max_tokens: 400,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: instructions },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      })
      if (!res.ok) return { ok: false, error: `视觉接口返回 ${res.status}` }
      const body = await res.json()
      const text = body?.choices?.[0]?.message?.content
      const content = Array.isArray(text)
        ? text.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
        : String(text == null ? '' : text)
      const obj = parseJsonLoose(content)
      if (!obj) return { ok: false, error: '模型没有返回可解析的 JSON：' + content.replace(/\s+/g, ' ').slice(0, 120) }
      return {
        ok: true,
        name: String(obj.name == null ? '' : obj.name).trim().slice(0, 80),
        tags: cleanTags(obj.tags, 12, 24),
        note: String(obj.note == null ? '' : obj.note).replace(/\s+/g, ' ').trim().slice(0, 200),
      }
    } catch (error) {
      const msg = error?.name === 'AbortError' ? '视觉接口超时' : String(error?.message || error)
      return { ok: false, error: msg }
    } finally {
      clearTimeout(timer)
    }
  }

  return { currentConfig, ready, status, describe }
}
