// 鱼的记忆 · 多语义槽（K 表）与冷存原文（V 表）。
//
// 边界（主人 2026-11-18 定）：**不替换** 知识库.json / growth.mjs，新槽表与它并存，靠 id 关联。
// K 只存静态量：hits / 新鲜度 / 衰减一律不写进 K，检索时现算。
//
// 一条记忆可拆多个槽 —— 「一图多义」靠这个：同一张图在「说累 / 催进度 / 自嘲 / 被嘲」
// 四个场景各是一个槽，各带自己的标签与向量。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const KIND = Object.freeze({ FACT: '事实', STICKER: '表情', MEME: '梗' })
export const KINDS = Object.freeze([KIND.FACT, KIND.STICKER, KIND.MEME])
export const DIMENSIONS = Object.freeze(['主体', '情绪', '动作', '场景', '形态'])

/** 打分权重（可调，但每次调整要在提交信息里写清依据）。 */
export const SCORE_WEIGHTS = Object.freeze({
  tag: 0.6,
  cosine: 0.3,
  freshness: 0.1,
  samePerson: 0.2,
  longTerm: 0.2,
})

export const SLOT_DIM = 512
export const K_VERSION = 1
export const FILES = Object.freeze({
  k: '槽表.json',
  v: '槽原文.json',
  state: '槽状态.json',
  pending: '待审队列.json',
})

// ───────────────── 向量：同一 encoder 才能比余弦 ─────────────────

/**
 * 兜底 encoder：字符二元组哈希到 512 维，L2 归一化。
 *
 * 为什么要有它：本地/远程 embedding 模型都不在时（本机实测没装 transformers、也没配远端），
 * 没有向量就没法验「双通道 + 余弦」。兜底 encoder 是**确定性**的，能跑通机制，
 * 但**语义能力弱**——K 里记 `encoder:'fallback-hash-512'`，将来换真 encoder 靠 kVersion 区分并全库重建。
 */
export function encodeFallback(text) {
  const vec = new Float32Array(SLOT_DIM)
  const s = String(text || '').replace(/\s+/g, '')
  if (!s) return vec
  for (let i = 0; i < s.length; i += 1) {
    const gram = s.slice(i, i + 2)
    const h = createHash('sha1').update(gram).digest()
    const idx = ((h[0] << 8) | h[1]) % SLOT_DIM
    const sign = h[2] % 2 === 0 ? 1 : -1
    vec[idx] += sign
  }
  let norm = 0
  for (let i = 0; i < SLOT_DIM; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < SLOT_DIM; i += 1) vec[i] /= norm
  return vec
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

/** K 可 int8 量化：存的是 int8，读出来还原成 Float32（余弦照样能用）。 */
export function quantize(vec) {
  let max = 0
  for (const v of vec) max = Math.max(max, Math.abs(v))
  const scale = max ? 127 / max : 1
  const out = new Array(vec.length)
  for (let i = 0; i < vec.length; i += 1) out[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * scale)))
  return { q: out, scale }
}

export function dequantize(q, scale) {
  const out = new Float32Array(q.length)
  for (let i = 0; i < q.length; i += 1) out[i] = q[i] / (scale || 1)
  return out
}

// ───────────────── 值得记？ ─────────────────

/**
 * 按序命中即止：
 *   1 用户明确要求记住 → 直接收
 *   2 同一内容出现 >=2 次 → 收
 *   3 有明确复用场景（表情 / 称呼 / 梗）→ 收
 *   4 小模型判定有价值 → **只进待审队列**，不直接入库
 * 都不通过：丢弃并计数（计数落在 state，用来调阈值）。
 */
export function worthRemembering({
  text = '',
  explicit = false,
  seenCount = 0,
  reuseScene = false,
  modelVerdict = null,
} = {}) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: '空内容' }
  if (explicit) return { ok: true, reason: '用户明确要求记住', needsReview: false }
  if (Number(seenCount) >= 2) return { ok: true, reason: '同一内容出现 ≥2 次', needsReview: false }
  if (reuseScene) return { ok: true, reason: '有明确复用场景', needsReview: false }
  if (modelVerdict && modelVerdict.value === true) {
    return { ok: true, reason: '小模型判定有价值（待审）', needsReview: true }
  }
  return { ok: false, reason: '不值得记' }
}

// ───────────────── 写入归一化 ─────────────────

const NOISE_LINK_ONLY = /^(https?:\/\/\S+|\s*\[?(图片|表情|语音|视频)\]?\s*)$/i
const SYSTEM_HINT = /^(系统提示|\[系统\]|你撤回了一条消息)/

/** 桥接入参：source 必填；去噪、长文分段、按 hash 去重。 */
export function normalizeIncoming(input = {}, { maxSegment = 400 } = {}) {
  const source = String(input.source || '').trim()
  if (!source) throw new Error('source 必填（qq / bili / dsh）')
  const rawText = String(input.text || '').trim()
  const files = Array.isArray(input.files) ? input.files.filter(Boolean).map(String) : []
  if (!rawText && !files.length) return { source, who: '', when: '', segments: [], files, hash: '', skipped: '空内容' }
  if (NOISE_LINK_ONLY.test(rawText) && !files.length) {
    return { source, who: '', when: '', segments: [], files, hash: '', skipped: '纯链接/纯表情' }
  }
  if (SYSTEM_HINT.test(rawText) && !files.length) {
    return { source, who: '', when: '', segments: [], files, hash: '', skipped: '系统提示' }
  }
  const segments = []
  const clean = rawText.replace(/\r\n/g, '\n')
  for (const para of clean.split(/\n{2,}/)) {
    const text = para.trim()
    if (!text) continue
    if (text.length <= maxSegment) segments.push(text)
    else for (let i = 0; i < text.length; i += maxSegment) segments.push(text.slice(i, i + maxSegment))
  }
  const hash = createHash('sha256')
    .update([clean, ...files].join('\u0000'))
    .digest('hex')
    .slice(0, 24)
  return {
    source,
    who: String(input.who || ''),
    when: String(input.when || ''),
    segments,
    files,
    hash,
    skipped: '',
  }
}

// ───────────────── 标签 → K ─────────────────

/** 每一维的默认锚点词。加新词 = 加锚点，不重训。 */
export const DEFAULT_ANCHORS = Object.freeze({
  主体: ['我', '你', '他', '她', '群友', '主人', '鱼'],
  情绪: ['累', '难过', '开心', '生气', '委屈', '兴奋', '平静', '烦'],
  动作: ['发图', '接梗', '催', '自嘲', '安慰', '吐槽', '问', '答'],
  场景: ['说累', '催进度', '被嘲', '自嘲', '闲聊', '求助', '深夜', '早上'],
  形态: ['立绘', '表情包', '特写', '动图', '文字', '语音'],
})

function softmax(scores) {
  const max = Math.max(...scores)
  const exps = scores.map((s) => Math.exp(s - max))
  const sum = exps.reduce((a, b) => a + b, 0) || 1
  return exps.map((e) => e / sum)
}

/**
 * 零样本近邻打标：每维把候选词编码成锚点向量，取余弦最近。
 * 返回 { tags:{维:词}, confidence:{维:分数} }
 * 置信度低于该维阈值时，调用方只把这一维交给生成模型。
 */
export function tagByAnchors({ text = '', anchors = DEFAULT_ANCHORS, encode = encodeFallback } = {}) {
  const textVec = encode(text)
  const tags = {}
  const confidence = {}
  for (const dim of DIMENSIONS) {
    const words = anchors[dim] || []
    let best = ''
    let bestScore = 0
    for (const word of words) {
      // 零样本余弦为主；字面出现算一个小加分，避免短词哈希向量全 0 时整维空掉
      const s = cosine(textVec, encode(word)) + (text.includes(word) ? 0.5 : 0)
      if (s > bestScore) {
        bestScore = s
        best = word
      }
    }
    tags[dim] = best
    confidence[dim] = Number(bestScore.toFixed(4))
  }
  return { tags, confidence }
}

/**
 * 从标签到 K：标签 → 向量化 → 得分 → softmax → 加权聚合。
 * **只烘静态版本**（标签重要度）；跟查询相关的那次打分留到检索时做。
 */
export function composeVector({ tags = {}, semantic = '', anchors = DEFAULT_ANCHORS, encode = encodeFallback } = {}) {
  const parts = []
  const perDim = {}
  for (const dim of DIMENSIONS) {
    const word = tags[dim]
    const words = anchors[dim] || []
    if (!word && !words.length) continue
    const semVec = encode(semantic || '')
    const scores = words.map((w) => cosine(semVec, encode(w)))
    const weights = softmax(scores)
    // 静态重要度：被标中的那一维权重更高（1.0 vs 0.6）
    const bonus = word ? 1 : 0.6
    for (let i = 0; i < words.length; i += 1) {
      perDim[`${dim}:${words[i]}`] = Number((weights[i] * bonus).toFixed(4))
      parts.push({ vec: encode(words[i]), w: weights[i] * bonus })
    }
  }
  const out = new Float32Array(SLOT_DIM)
  let total = 0
  for (const part of parts) {
    total += part.w
    for (let i = 0; i < out.length; i += 1) out[i] += part.vec[i] * part.w
  }
  if (total) for (let i = 0; i < out.length; i += 1) out[i] /= total
  let norm = 0
  for (let i = 0; i < out.length; i += 1) norm += out[i] * out[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i += 1) out[i] /= norm
  return { vec: out, weights: perDim }
}

/** 生成一个 K 槽（不含 hits / 新鲜度——那些不写进 K）。 */
export function makeSlot({
  id = '',
  kind = KIND.FACT,
  semantic = '',
  trigger = [],
  response = '',
  tags = {},
  source = '',
  person = '',
  at = '',
  caution = false,
  status = 'active',
  publicTopic = false,
  room = '',
  anchors = DEFAULT_ANCHORS,
  encode = encodeFallback,
  encoder = 'fallback-hash-512',
  vId = '',
} = {}) {
  const slotId = id || 'k_' + createHash('sha1').update(semantic + '|' + source + '|' + at).digest('hex').slice(0, 12)
  const composed = composeVector({ tags, semantic, anchors, encode })
  const quant = quantize(composed.vec)
  return {
    id: slotId,
    kind,
    semantic: String(semantic || '').slice(0, 200),
    trigger: Array.isArray(trigger) ? trigger.map(String).slice(0, 8) : [],
    response: String(response || '').slice(0, 300),
    tags,
    tagWeights: composed.weights,
    vec: quant,
    encoder,
    source: String(source || ''),
    person: String(person || ''),
    at: String(at || ''),
    status: String(status || 'active'),
    publicTopic: publicTopic === true,
    room: String(room || ''),
    caution: caution === true,
    kVersion: K_VERSION,
    vId: vId || '',
  }
}

export function slotVector(slot) {
  if (!slot || !slot.vec) return null
  return dequantize(slot.vec.q, slot.vec.scale)
}

// ───────────────── 存储 ─────────────────

function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 槽库：K 常驻、V 冷存（只在命中时才读原文）。
 * 损坏 = 写入被中断 → 抛错，**不许静默重建**。
 */
export function createSlotStore({ rootDir = '', dir = '' } = {}) {
  const base = dir || join(rootDir, '鱼的记忆', '槽')
  const kFile = join(base, FILES.k)
  const vFile = join(base, FILES.v)
  const stateFile = join(base, FILES.state)
  const pendingFile = join(base, FILES.pending)

  function loadK() {
    let raw
    try {
      raw = readFileSync(kFile, 'utf8')
    } catch {
      return []
    }
    try {
      const data = JSON.parse(raw)
      return Array.isArray(data) ? data : []
    } catch (error) {
      throw new Error('槽表损坏（' + kFile + '）：' + String(error?.message || error))
    }
  }

  function saveK(slots) {
    writeJsonAtomic(kFile, Array.isArray(slots) ? slots : [])
  }

  function loadV() {
    return readJsonSafe(vFile, {})
  }

  /** V 冷存：原文/文件 + 预览（≤80 字）+ size/mtime/hash。 */
  function putV(id, { text = '', file = '', preview = '', size = 0, mtime = 0, hash = '' } = {}) {
    const all = loadV()
    all[String(id)] = {
      text: String(text || ''),
      file: String(file || ''),
      preview: String(preview || text || '').slice(0, 80),
      size: Number(size) || 0,
      mtime: Number(mtime) || 0,
      hash: String(hash || ''),
    }
    writeJsonAtomic(vFile, all)
    return all[String(id)]
  }

  function getV(id) {
    return loadV()[String(id)] || null
  }

  function state() {
    return readJsonSafe(stateFile, { dropped: 0, seen: {}, negative: {} })
  }

  function saveState(next) {
    writeJsonAtomic(stateFile, next || {})
  }

  function pending() {
    return readJsonSafe(pendingFile, [])
  }

  function addPending(item) {
    const list = pending()
    list.push(item)
    writeJsonAtomic(pendingFile, list.slice(-500))
  }

  /** 按 hash 去重：同一个内容不重复建槽（返回已有槽）。 */
  function findByHash(hash) {
    if (!hash) return null
    const all = loadV()
    for (const [id, v] of Object.entries(all)) {
      if (v && v.hash === hash) return id
    }
    return null
  }

  function upsert(slot) {
    const slots = loadK()
    const idx = slots.findIndex((s) => s && s.id === slot.id)
    if (idx >= 0) slots[idx] = slot
    else slots.push(slot)
    saveK(slots)
    return slot
  }

  function update(id, patch = {}) {
    const slots = loadK()
    const idx = slots.findIndex((s) => s && s.id === id)
    if (idx < 0) return null
    slots[idx] = { ...slots[idx], ...patch }
    saveK(slots)
    return slots[idx]
  }

  function count() {
    return loadK().length
  }

  return { base, kFile, vFile, stateFile, pendingFile, loadK, saveK, loadV, putV, getV, state, saveState, pending, addPending, findByHash, upsert, update, count }
}


// ───────────────── 真 embedding 的异步路径 ─────────────────

/** 五维置信度阈值初值（统一 0.6）：低于它 → 只把这一维交给生成模型。 */
export const TAG_THRESHOLDS = Object.freeze({ 主体: 0.6, 情绪: 0.6, 动作: 0.6, 场景: 0.6, 形态: 0.6 })

/**
 * 异步打标：用真 encoder（bge 之类）把文本与锚点词编码后取余弦最近。
 * 返回 { tags, confidence, lowDims }：lowDims 是低于阈值的维度，调用方把它们交给生成模型。
 */
export async function tagAsync({ text = '', anchors = DEFAULT_ANCHORS, encoder, thresholds = TAG_THRESHOLDS } = {}) {
  if (!encoder || typeof encoder.encodeMany !== 'function') throw new Error('tagAsync 需要 encoder')
  const dims = DIMENSIONS.filter((dim) => (anchors[dim] || []).length)
  const words = []
  for (const dim of dims) for (const word of anchors[dim]) words.push({ dim, word })
  const vecs = await encoder.encodeMany([String(text || ''), ...words.map((w) => w.word)])
  const textVec = vecs[0]
  const tags = {}
  const confidence = {}
  const lowDims = []
  for (const dim of dims) {
    let best = ''
    let bestScore = -1
    words.forEach((entry, index) => {
      if (entry.dim !== dim) return
      const score = cosine(textVec, vecs[index + 1])
      if (score > bestScore) {
        bestScore = score
        best = entry.word
      }
    })
    tags[dim] = best
    confidence[dim] = Number(bestScore.toFixed(4))
    if (bestScore < (thresholds[dim] ?? 0.6)) lowDims.push(dim)
  }
  return { tags, confidence, lowDims }
}

/** 异步版的「标签 → 向量 → softmax → 聚合」。 */
export async function composeVectorAsync({ tags = {}, semantic = '', anchors = DEFAULT_ANCHORS, encoder } = {}) {
  if (!encoder) throw new Error('composeVectorAsync 需要 encoder')
  const pieces = []
  for (const dim of DIMENSIONS) {
    const words = anchors[dim] || []
    if (!words.length) continue
    const word = tags[dim]
    const bonus = word ? 1 : 0.6
    const vecs = await encoder.encodeMany([semantic || '', ...words])
    const sem = vecs[0]
    const scores = words.map((_, i) => cosine(sem, vecs[i + 1]))
    const weights = softmax(scores)
    for (let i = 0; i < words.length; i += 1) pieces.push({ vec: vecs[i + 1], w: weights[i] * bonus })
  }
  const out = new Float32Array(SLOT_DIM)
  let total = 0
  for (const piece of pieces) {
    total += piece.w
    for (let i = 0; i < out.length; i += 1) out[i] += piece.vec[i] * piece.w
  }
  if (total) for (let i = 0; i < out.length; i += 1) out[i] /= total
  let norm = 0
  for (let i = 0; i < out.length; i += 1) norm += out[i] * out[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i += 1) out[i] /= norm
  return out
}

/** 异步建槽：真 embedding 下用这个（makeSlot 是同步兜底版）。 */
export async function makeSlotAsync({
  id = '',
  kind = KIND.FACT,
  semantic = '',
  trigger = [],
  response = '',
  tags = {},
  source = '',
  person = '',
  at = '',
  caution = false,
  status = 'active',
  publicTopic = false,
  room = '',
  anchors = DEFAULT_ANCHORS,
  encoder,
  vId = '',
} = {}) {
  if (!encoder) throw new Error('makeSlotAsync 需要 encoder')
  const slotId = id || 'k_' + createHash('sha1').update(semantic + '|' + source + '|' + at).digest('hex').slice(0, 12)
  const vec = await composeVectorAsync({ tags, semantic, anchors, encoder })
  const quant = quantize(vec)
  return {
    id: slotId,
    kind,
    semantic: String(semantic || '').slice(0, 200),
    trigger: Array.isArray(trigger) ? trigger.map(String).slice(0, 8) : [],
    response: String(response || '').slice(0, 300),
    tags,
    vec: quant,
    encoder: encoder.id,
    source: String(source || ''),
    person: String(person || ''),
    room: String(room || ''),
    publicTopic: publicTopic === true,
    at: String(at || ''),
    status: String(status || 'active'),
    caution: caution === true,
    kVersion: K_VERSION,
    vId: vId || '',
  }
}
