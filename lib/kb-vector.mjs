// kb-vector.mjs — 知识库的向量能力（默认关，打开就能用）。源：工具/kb-vector/。
// 纯 ESM、零依赖、可离线；不选 openai 后端就不出网。
// 约定见 鱼的记忆/知识库-设计.md：json 是真源，索引是派生物，随时能重建。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export const VERSION = 1

export const DEFAULTS = {
  enabled: false,
  mode: 'off',            // off | openai | file | local
  baseUrl: '',            // openai 兼容的根，比如 http://127.0.0.1:8080/v1
  model: '',              // 比如 bge-m3 / text-embedding-3-small
  apiKey: '',
  vectorsFile: '',        // mode=file：{model:{id,dim}, vectors:{id:[...]}}
  weightLexical: 0.7,
  weightVector: 0.3,
  budgetTokens: 800,
  batchSize: 16,
  timeoutMs: 15000,
  localModel: 'Xenova/bge-small-zh-v1.5',  // 本地小模型：中文、约 24MB（q8）
  localModule: '',        // 运行库位置（留空 = 按 profile / 插件依赖链自己找）
  localDir: '',           // 模型缓存目录（留空 = $DSH_HOME/fish-world-models）
  localDtype: 'q8',       // q8 | fp16 | fp32
  minCoverage: 0.25,      // 查询词被覆盖到几成才算命中（挡单字误报）
  minAbsolute: 5,         // 或者原始 BM25 分够高
  minVector: 0.55,        // 余弦低于这个不当命中
}

const MODES = new Set(['off', 'openai', 'file', 'local'])

function clamp(n, lo, hi, fallback) {
  const x = Number(n)
  if (!Number.isFinite(x)) return fallback
  return Math.min(hi, Math.max(lo, x))
}

// 归一化配置：不改调用方对象；坏值不抛异常，攒进 problems 如实报。
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const problems = []
  const config = { ...DEFAULTS, ...input }

  config.enabled = input.enabled === true
  config.mode = MODES.has(input.mode) ? input.mode : 'off'
  if (input.mode !== undefined && !MODES.has(input.mode)) problems.push('不认识的后端：' + String(input.mode))

  for (const key of ['baseUrl', 'model', 'apiKey', 'vectorsFile', 'localModule', 'localDir']) {
    config[key] = typeof input[key] === 'string' ? input[key].trim() : ''
  }
  // 本地模型名有默认值：没填就回落，别拿空串去问模型（会变成去网上拉一个叫 "" 的模型）
  config.localModel = typeof input.localModel === 'string' && input.localModel.trim()
    ? input.localModel.trim()
    : DEFAULTS.localModel
  config.weightLexical = clamp(input.weightLexical, 0, 1, DEFAULTS.weightLexical)
  config.weightVector = clamp(input.weightVector, 0, 1, DEFAULTS.weightVector)
  config.budgetTokens = Math.round(clamp(input.budgetTokens, 100, 8000, DEFAULTS.budgetTokens))
  config.batchSize = Math.round(clamp(input.batchSize, 1, 128, DEFAULTS.batchSize))
  config.timeoutMs = Math.round(clamp(input.timeoutMs, 1000, 120000, DEFAULTS.timeoutMs))
  config.localDtype = ['q8', 'fp16', 'fp32'].includes(String(input.localDtype)) ? String(input.localDtype) : DEFAULTS.localDtype
  config.minCoverage = clamp(input.minCoverage, 0, 1, DEFAULTS.minCoverage)
  config.minAbsolute = clamp(input.minAbsolute, 0, 200, DEFAULTS.minAbsolute)
  config.minVector = clamp(input.minVector, -1, 1, DEFAULTS.minVector)

  if (config.enabled && config.mode === 'off') problems.push('向量开关开着，但没选后端（off）')
  if (config.mode === 'openai') {
    if (!/^https?:\/\//i.test(config.baseUrl)) problems.push('baseUrl 不是 http(s) 地址')
    else {
      let host = ''
      try { host = new URL(config.baseUrl).hostname } catch { problems.push('baseUrl 解析失败') }
      const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
      if (!loopback && !/^https:/i.test(config.baseUrl)) problems.push('非本机的 baseUrl 必须是 https')
    }
    if (!config.model) problems.push('没填模型名')
  }
  if (config.mode === 'file' && !config.vectorsFile) problems.push('没填向量文件路径')
  if (config.mode === 'local') {
    if (!config.localModel) problems.push('没填本地模型名')
    for (const key of ['localModule', 'localDir']) {
      if (config[key] && !isAbsolute(config[key])) {
        problems.push(key + ' 必须是绝对路径')
        config[key] = ''
      }
    }
    if (!['q8', 'fp16', 'fp32'].includes(String(input.localDtype || DEFAULTS.localDtype))) {
      problems.push('localDtype 只认 q8 / fp16 / fp32')
    }
  }

  const usable = config.enabled && config.mode !== 'off' && problems.length === 0
  return { config, problems, usable }
}

// ---- 本地小模型：@huggingface/transformers + onnxruntime，在插件进程里直接跑 ----
// 模型文件第一次用时下载（默认 bge-small-zh-v1.5 的 q8 大约 24MB），之后离线。
const LOCAL_LIB = '@huggingface/transformers'

function defaultModelDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'fish-world-models')
}

// 入口可能按条件嵌套好几层（node → import → default），一层层剥到字符串为止；
// 顺手跳过 .d.ts，那是类型声明不是代码。
function pickEntry(value) {
  if (typeof value === 'string') return value.endsWith('.d.ts') ? '' : value
  if (!value || typeof value !== 'object') return ''
  for (const key of ['node', 'import', 'module', 'default']) {
    const found = pickEntry(value[key])
    if (found) return found
  }
  return ''
}

export function packageEntryUrl(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const exp = pkg && pkg.exports ? (pkg.exports['.'] || pkg.exports) : null
  const rel = pickEntry(exp) || pkg?.module || pkg?.main || 'dist/transformers.mjs'
  return pathToFileURL(join(pkgDir, rel)).href
}

/** 找运行库：显式路径 → 直接 import → profile 依赖链。找不到要把试过什么说出来。 */
export async function loadTransformersLibrary(config = {}, options = {}) {
  const importLib = typeof options.importLib === 'function' ? options.importLib : (spec) => import(spec)
  const failures = []
  const explicit = String(config.localModule || process.env.DSH_FISH_WORLD_TRANSFORMERS || '').trim()
  if (explicit) {
    try {
      const url = isAbsolute(explicit) && existsSync(join(explicit, 'package.json')) ? packageEntryUrl(explicit) : pathToFileURL(explicit).href
      return await importLib(url)
    } catch (error) {
      failures.push('localModule: ' + String(error?.message || error))
    }
  }
  try {
    return await importLib(LOCAL_LIB)
  } catch (error) {
    failures.push('直接 import: ' + String(error?.message || error))
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profiles = [...new Set([process.env.DSH_PROFILE, 'desktop', 'web'].filter(Boolean))]
  for (const profile of profiles) {
    try {
      const anchor = join(home, 'profiles', profile, 'node_modules', '__fish_world__.cjs')
      const pkgPath = createRequire(anchor).resolve(LOCAL_LIB + '/package.json')
      return await importLib(packageEntryUrl(dirname(pkgPath)))
    } catch (error) {
      failures.push(profile + ' profile: ' + String(error?.message || error))
    }
  }
  throw new Error('没找到 ' + LOCAL_LIB + '（装进 profile：npm i ' + LOCAL_LIB + '；或把 localModule 指到包目录）。试过：' + failures.join('；'))
}

async function createLocalEmbedder(config, options = {}) {
  const loader = options.loadLibrary || loadTransformersLibrary
  const lib = await loader(config)
  const pipeline = lib && lib.pipeline
  if (typeof pipeline !== 'function') throw new Error(LOCAL_LIB + ' 里没有 pipeline()')
  if (lib.env && typeof lib.env === 'object') {
    lib.env.cacheDir = config.localDir || defaultModelDir()
    lib.env.allowLocalModels = true
  }
  const pipe = await pipeline('feature-extraction', config.localModel, { dtype: config.localDtype || 'q8' })
  let dim = 0
  return {
    id: 'local:' + config.localModel,
    get dim() { return dim },
    source: 'local',
    async embed(texts) {
      const list = (texts || []).map((t) => String(t))
      const out = await pipe(list, { pooling: 'cls', normalize: true })
      const rows = out && typeof out.tolist === 'function' ? out.tolist() : out
      if (!Array.isArray(rows) || rows.length !== list.length) throw new Error('本地模型返回条数对不上')
      const vectors = rows.map((row) => (Array.isArray(row) ? row.map(Number) : []))
      for (const vec of vectors) {
        if (!vec.length) throw new Error('本地模型返回的 embedding 是空的')
        if (dim && vec.length !== dim) throw new Error('维度不一致：先 ' + dim + ' 现在 ' + vec.length)
        dim = vec.length
      }
      return vectors
    },
  }
}

// 造 embedder，统一形状 { id, dim, embed(texts) }
export async function createEmbedder(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (!config || !config.enabled || config.mode === 'off') return null

  if (config.mode === 'file') {
    const raw = JSON.parse(readFileSync(config.vectorsFile, 'utf8'))
    const model = (raw && raw.model) || {}
    const vectors = (raw && raw.vectors) || {}
    const ids = Object.keys(vectors)
    const dim = ids.length ? vectors[ids[0]].length : Number(model.dim) || 0
    if (!dim) throw new Error('向量文件里没有可用的向量')
    return {
      id: String(model.id || 'file'),
      dim,
      // 文件后端只能查已有条目，给不了新文本算向量；这是它的本质限制，不藏
      async embed() { throw new Error('file 后端不支持对新文本求向量，只能查已有条目') },
      lookup(id) { return Array.isArray(vectors[id]) ? vectors[id] : null },
      source: 'file',
    }
  }

  if (config.mode === 'local') return createLocalEmbedder(config, options)

  const url = config.baseUrl.replace(/\/+$/, '') + '/embeddings'
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch')

  let dim = 0
  async function call(texts) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}),
        },
        body: JSON.stringify({ model: config.model, input: texts }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('embedding 服务返回 ' + res.status) // 只报状态码，不回显响应体
      const body = await res.json()
      const rows = Array.isArray(body && body.data) ? body.data.slice() : []
      if (rows.length !== texts.length) throw new Error('返回条数对不上：要 ' + texts.length + '，给 ' + rows.length)
      rows.sort((a, b) => (a.index || 0) - (b.index || 0))
      const out = []
      for (const row of rows) {
        const vec = row && row.embedding
        if (!Array.isArray(vec) || !vec.length) throw new Error('返回的 embedding 不是数组')
        if (dim && vec.length !== dim) throw new Error('维度不一致：先 ' + dim + ' 现在 ' + vec.length)
        dim = vec.length
        out.push(vec.map(Number))
      }
      return out
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    id: String(config.model),
    get dim() { return dim },
    async embed(texts) {
      const list = (texts || []).map((t) => String(t))
      const out = []
      for (let i = 0; i < list.length; i += config.batchSize) {
        const batch = list.slice(i, i + config.batchSize)
        const rows = await call(batch)
        for (const r of rows) out.push(r)
      }
      return out
    },
    source: 'openai',
  }
}

// ---- 分词：中文按字 + 二元组，西文按词 ----
// 单字只给 0.35 的权重，它是「随便什么都能蹭上」的主要噪声源。
const CJK = /[\u3400-\u9fff]+/g
const LATIN = /[a-z0-9][a-z0-9_+-]*/g
export const UNIGRAM_WEIGHT = 0.35

export function tokensOf(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  for (const run of s.match(CJK) || []) {
    for (let i = 0; i < run.length; i++) {
      out.push({ t: run[i], w: UNIGRAM_WEIGHT })
      if (i + 1 < run.length) out.push({ t: run.slice(i, i + 2), w: 1 })
    }
  }
  for (const w of s.match(LATIN) || []) out.push({ t: w, w: 1 })
  return out
}

export function tokenize(text) {
  return tokensOf(text).map((x) => x.t)
}

// 条目转成供检索的文本（名字最重、别名次之）
export function itemText(item) {
  const parts = []
  const name = String(item.name || '').trim()
  const aliases = Array.isArray(item.aliases) ? item.aliases.filter(Boolean) : []
  if (name) parts.push(name, name, name)
  for (const a of aliases) parts.push(String(a), String(a))
  for (const key of ['tags', 'meaning', 'usage', 'avoid']) {
    const v = item[key]
    if (Array.isArray(v)) parts.push(v.join(' '))
    else if (v) parts.push(String(v))
  }
  return parts.join(' ').trim()
}

// ---- 字面档：BM25 ----
export function buildLexicon(items) {
  const docs = items.map((item) => {
    const toks = tokensOf(itemText(item))
    const m = new Map()
    for (const pair of toks) m.set(pair.t, (m.get(pair.t) || 0) + pair.w)
    return { id: item.id, weighted: m, set: new Set(m.keys()), len: toks.length }
  })
  const df = new Map()
  for (const doc of docs) for (const t of doc.set) df.set(t, (df.get(t) || 0) + 1)
  const total = docs.reduce((n, d) => n + d.len, 0)
  return {
    ids: docs.map((d) => d.id),
    tf: docs.map((d) => d.weighted),
    sets: docs.map((d) => d.set),
    df,
    n: docs.length,
    avgdl: docs.length ? total / docs.length : 0,
  }
}

// 返回 Map(条目 id -> { absolute, coverage })
export function lexicalScores(lexicon, query) {
  const pairs = tokensOf(query)
  const out = new Map()
  if (!pairs.length || !lexicon.n) return out
  const k1 = 1.2
  const b = 0.75
  const distinct = [...new Set(pairs.map((x) => x.t))]
  const weightOf = new Map(pairs.map((x) => [x.t, x.w]))
  for (let i = 0; i < lexicon.n; i++) {
    const m = lexicon.tf[i]
    let score = 0
    let covered = 0
    for (const t of distinct) {
      const f = m.get(t)
      if (!f) continue
      covered++
      const df = lexicon.df.get(t) || 0
      const idf = Math.log(1 + (lexicon.n - df + 0.5) / (df + 0.5))
      const norm = f + k1 * (1 - b + (b * lexicon.sets[i].size) / (lexicon.avgdl || 1))
      score += (weightOf.get(t) || 1) * idf * ((f * (k1 + 1)) / norm)
    }
    if (score > 0) out.set(lexicon.ids[i], { absolute: score, coverage: covered / distinct.length })
  }
  return out
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

// ---- 索引 ----
export async function buildIndex(items, embedder) {
  if (!embedder) throw new Error('没有可用的 embedding 后端')
  const texts = items.map((item) => itemText(item))
  const vectors = await embedder.embed(texts)
  const dim = embedder.dim || (vectors[0] ? vectors[0].length : 0)
  if (!dim) throw new Error('拿到的向量维度是 0')
  return {
    version: VERSION,
    model: { id: String(embedder.id || 'unknown'), dim, builtAt: Date.now() },
    items: items.map((item, i) => ({ id: item.id, text: texts[i], vec: vectors[i] })),
  }
}

export function saveIndex(path, index) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(index), 'utf8')
  return path
}

export function loadIndex(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// 模型换了、维度混了，索引整体作废（不许混着算余弦）
export function validateIndex(index, embedder) {
  const reasons = []
  if (!index || typeof index !== 'object') return { ok: false, reasons: ['索引不是对象'] }
  if (index.version !== VERSION) reasons.push('索引版本 ' + String(index.version) + ' 不是 ' + VERSION)
  const model = index.model || {}
  if (embedder && model.id && String(model.id) !== String(embedder.id)) {
    reasons.push('模型变了：索引是 ' + model.id + '，当前是 ' + embedder.id + '（要重建）')
  }
  const dim = Number(model.dim) || 0
  if (!dim) reasons.push('索引没记维度')
  for (const row of index.items || []) {
    if (!Array.isArray(row.vec) || row.vec.length !== dim) {
      reasons.push('条目 ' + row.id + ' 的向量维度不是 ' + dim)
      break
    }
  }
  return { ok: reasons.length === 0, reasons }
}

// ---- 检索主入口 ----
// 门槛：查询词覆盖够、或原始分够高、或余弦够高；都不够就当没查到。
// 宁可回空，也不给一条蹭字的假命中。
export async function search(query, options) {
  const opts = options || {}
  const items = opts.items || []
  const index = opts.index || null
  const embedder = opts.embedder || null
  const limit = opts.limit || 5
  const cfg = { ...DEFAULTS, ...(opts.config || {}) }

  const notes = []
  const byId = new Map(items.map((it) => [it.id, it]))
  const lex = buildLexicon(items)
  const raw = lexicalScores(lex, query)
  const vecRaw = new Map()
  let backend = 'lexical'

  if (embedder && index) {
    const check = validateIndex(index, embedder)
    if (!check.ok) {
      notes.push(...check.reasons, '已退回字面档')
    } else {
      try {
        const [qv] = await embedder.embed([String(query)])
        const dim = index.model.dim
        if (!qv || qv.length !== dim) throw new Error('查询向量维度不是 ' + dim)
        for (const row of index.items) {
          if (!byId.size || byId.has(row.id)) {
            const c = cosine(qv, row.vec)
            if (c > 0) vecRaw.set(row.id, c)
          }
        }
        backend = 'hybrid'
      } catch (e) {
        notes.push('向量这一步失败：' + String((e && e.message) || e), '已退回字面档')
        vecRaw.clear()
      }
    }
  }

  const kept = []
  for (const [id, it] of byId) {
    const l = raw.get(id) || null
    const v = vecRaw.get(id) || 0
    const lexPass = !!l && (l.coverage >= cfg.minCoverage || l.absolute >= cfg.minAbsolute)
    const vecPass = v >= cfg.minVector
    if (!lexPass && !vecPass) continue
    kept.push({ id, it, absolute: l ? l.absolute : 0, coverage: l ? l.coverage : 0, vector: v })
  }

  let maxLex = 0
  let maxVec = 0
  for (const k of kept) {
    if (k.absolute > maxLex) maxLex = k.absolute
    if (k.vector > maxVec) maxVec = k.vector
  }

  const scored = kept.map((k) => {
    const ln = maxLex ? k.absolute / maxLex : 0
    const vn = maxVec ? k.vector / maxVec : 0
    const score = backend === 'hybrid' ? cfg.weightLexical * ln + cfg.weightVector * vn : ln
    return {
      id: k.id,
      name: k.it.name,
      score: Number(score.toFixed(4)),
      lexical: Number(ln.toFixed(4)),
      vector: Number(vn.toFixed(4)),
      coverage: Number(k.coverage.toFixed(2)),
      chars: itemText(k.it).length,
    }
  })
  scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))

  const budget = Number(cfg.budgetTokens) || DEFAULTS.budgetTokens
  const hits = []
  let used = 0
  let truncated = false
  for (const hit of scored) {
    if (hits.length >= limit) { truncated = true; break }
    if (used + hit.chars > budget) { truncated = true; break }
    hits.push(hit)
    used += hit.chars
  }
  if (truncated) notes.push('已按预算 ' + budget + ' token 截断')

  return { backend, hits, truncated, used, notes }
}
