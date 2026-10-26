// 知识库：梗、角色、外观、约定。给模型查，也给面板看。
//
// 落盘：
//   <根>/鱼的记忆/知识库.json        真源（人工/模型维护）
//   <根>/鱼的记忆/知识库索引.json    派生物（向量索引，删了会自动重建）
//   $DSH_HOME/fish-world-knowledge.json   只有 apiKey，权限 0600，不进主配置
//
// 约定：
//   · 关着（enabled=false）就是纯字面检索，一个字节都不改既有行为。
//   · 打开就是混合检索；向量那步出任何问题都退回字面档，并把原因报出来。
//   · 模型换了索引整体作废——不同模型的向量不在同一个空间，混着算就是噪声。
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import {
  DEFAULTS as KB_DEFAULTS,
  buildIndex,
  createEmbedder,
  loadIndex,
  normalizeConfig as normalizeKb,
  saveIndex,
  search as kbSearch,
} from './kb-vector.mjs'
import { DSH_HOME } from './paths.mjs'
import { ROOT_FOLDER } from './storage.mjs'

export const KNOWLEDGE_FOLDER = '鱼的记忆'
const KNOWLEDGE_FILE = '知识库.json'
export const INDEX_FILE = '知识库索引.json'
const SECRET_FILE = join(DSH_HOME, 'fish-world-knowledge.json')
/** 记忆目录里除了真源之外，还有几份人类可读的说明；面板把它们一起列出来。 */
const COMPANION_FILES = ['知识库.md', '外观设定.md']

const KIND_LABEL = { meme: '梗', character: '角色', look: '外观', rule: '约定', fact: '事实' }
const MAX_QUERY = 200

export const DEFAULT_KNOWLEDGE = {
  enabled: false,
  mode: 'off',
  baseUrl: '',
  model: '',
  vectorsFile: '',
  weightLexical: 0.7,
  weightVector: 0.3,
  budgetTokens: 800,
  limit: 3,
  minCoverage: 0.25,
  minAbsolute: 5,
  minVector: 0.55,
  localModel: 'Xenova/bge-small-zh-v1.5',
  localModule: '',
  localDir: '',
  localDtype: 'q8',
  indexFile: '',
}

function num(value, lo, hi, fallback) {
  const x = Number(value)
  if (!Number.isFinite(x)) return fallback
  return Math.min(hi, Math.max(lo, x))
}

function absPath(value) {
  const text = String(value == null ? '' : value).trim()
  return text && isAbsolute(text) ? text : ''
}

export function normalizeKnowledge(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const kb = normalizeKb({
    enabled: src.enabled === true,
    mode: String(src.mode || 'off'),
    baseUrl: src.baseUrl,
    model: src.model,
    vectorsFile: src.vectorsFile,
    weightLexical: src.weightLexical,
    weightVector: src.weightVector,
    budgetTokens: src.budgetTokens,
    batchSize: src.batchSize,
    timeoutMs: src.timeoutMs,
    minCoverage: src.minCoverage,
    minAbsolute: src.minAbsolute,
    minVector: src.minVector,
    localModel: src.localModel,
    localModule: src.localModule,
    localDir: src.localDir,
    localDtype: src.localDtype,
  })
  return {
    enabled: kb.config.enabled,
    mode: kb.config.mode,
    baseUrl: kb.config.baseUrl,
    model: kb.config.model,
    vectorsFile: kb.config.vectorsFile,
    weightLexical: kb.config.weightLexical,
    weightVector: kb.config.weightVector,
    budgetTokens: Math.round(num(src.budgetTokens, 100, 4000, DEFAULT_KNOWLEDGE.budgetTokens)),
    limit: Math.round(num(src.limit, 1, 10, DEFAULT_KNOWLEDGE.limit)),
    minCoverage: kb.config.minCoverage,
    minAbsolute: kb.config.minAbsolute,
    minVector: kb.config.minVector,
    localModel: kb.config.localModel,
    localModule: kb.config.localModule,
    localDir: kb.config.localDir,
    localDtype: kb.config.localDtype,
    indexFile: absPath(src.indexFile),
  }
}

/** 密钥只落盘一处、只读写这一处；接口永远不返回明文。 */
export function readKnowledgeSecret({ home = DSH_HOME } = {}) {
  const file = home === DSH_HOME ? SECRET_FILE : join(home, 'fish-world-knowledge.json')
  if (process.env.DSH_FISH_WORLD_EMBED_KEY) return { key: String(process.env.DSH_FISH_WORLD_EMBED_KEY), source: 'env' }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw.apiKey === 'string' && raw.apiKey) return { key: raw.apiKey, source: 'file' }
  } catch {}
  return { key: '', source: '' }
}

export function writeKnowledgeSecret(apiKey, { home = DSH_HOME } = {}) {
  const file = home === DSH_HOME ? SECRET_FILE : join(home, 'fish-world-knowledge.json')
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

function oneLine(text, max = 160) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max)
}

export function createKnowledge({ storage, home = DSH_HOME, config, logger, fetchImpl, loadLibrary } = {}) {
  let building = null
  let lastError = ''
  let embedderCache = { key: '', embedder: null }

  function rootDir() {
    try {
      const paths = storage?.layout?.()
      if (paths?.root) return paths.root
    } catch {}
    return join(home, ROOT_FOLDER)
  }

  function kbPath() {
    return join(rootDir(), KNOWLEDGE_FOLDER, KNOWLEDGE_FILE)
  }

  function currentConfig() {
    const raw = typeof config === 'function' ? config() : config
    return normalizeKnowledge(raw && raw.knowledge ? raw.knowledge : {})
  }

  function indexPath(cfg) {
    return cfg.indexFile || join(rootDir(), KNOWLEDGE_FOLDER, INDEX_FILE)
  }

  function loadItems() {
    const file = kbPath()
    if (!existsSync(file)) return { items: [], error: '知识库还没建：' + file, file }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
      return {
        items: items.filter((it) => it && typeof it === 'object' && (it.id || it.name)),
        error: '',
        file,
      }
    } catch (error) {
      return { items: [], error: '知识库解析失败：' + (error?.message || error), file }
    }
  }

  async function embedderFor(cfg) {
    if (!cfg.enabled || cfg.mode === 'off') return { embedder: null, problems: [] }
    const secret = readKnowledgeSecret({ home })
    const probe = normalizeKb({ ...cfg, apiKey: secret.key })
    // 模型加载一次就够了：本地档每次重建 pipeline 要几秒，白等。
    const key = [probe.config.mode, probe.config.model, probe.config.localModel, probe.config.baseUrl,
      probe.config.localModule, probe.config.localDir, probe.config.localDtype, secret.key ? 'k' : ''].join('|')
    if (probe.problems.length && !embedderCache.embedder) return { embedder: null, problems: probe.problems }
    if (embedderCache.key === key && embedderCache.embedder) return { embedder: embedderCache.embedder, problems: probe.problems }
    try {
      const embedder = await createEmbedder(probe.config, { fetchImpl, loadLibrary })
      embedderCache = { key, embedder }
      return { embedder, problems: probe.problems }
    } catch (error) {
      embedderCache = { key: '', embedder: null }
      return { embedder: null, problems: [...probe.problems, String(error?.message || error)] }
    }
  }

  /** 索引里期望的模型标识：本地档带 local: 前缀，跟 openai 档的模型名不是一回事。 */
  function expectedModelId(cfg) {
    if (cfg.mode === 'local') return 'local:' + (cfg.localModel || '')
    if (cfg.mode === 'openai') return String(cfg.model || '')
    return ''
  }

  /** 索引过期判断：模型变了、维度变了、知识库文件比索引新，都算过期。 */
  function indexState(index, cfg, file) {
    if (!index) return { ok: false, why: '还没有索引' }
    const want = expectedModelId(cfg)
    if (want && index.model?.id !== want) return { ok: false, why: '索引是 ' + (index.model?.id || '未知模型') + ' 建的，要重建' }
    if (!want && !index.model?.id) return { ok: false, why: '索引没记模型' }
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch {}
    if (Number(index.kbMtime) && mtime && Number(index.kbMtime) < mtime) return { ok: false, why: '知识库改过了，索引要重建' }
    return { ok: true, why: '' }
  }

  async function ensureIndex({ force = false } = {}) {
    const cfg = currentConfig()
    const loaded = loadItems()
    if (loaded.error) return { ok: false, error: loaded.error, notes: [] }
    if (!cfg.enabled) return { ok: false, error: '向量检索没开（enabled=false）', notes: [] }

    const { embedder, problems } = await embedderFor(cfg)
    if (!embedder) return { ok: false, error: problems.join('；') || '没有可用的 embedding 后端', notes: problems }

    const file = indexPath(cfg)
    if (!force) {
      let existing = null
      try { existing = existsSync(file) ? loadIndex(file) : null } catch (error) {
        return { ok: false, error: '索引读不出来：' + (error?.message || error), notes: [] }
      }
      const state = indexState(existing, cfg, kbPath())
      if (state.ok) return { ok: true, index: existing, rebuilt: false, notes: [] }
      if (existing) logger?.info?.('fish-world: ' + state.why)
    }

    if (building) return building
    building = (async () => {
      try {
        const index = await buildIndex(loaded.items, embedder)
        try { index.kbMtime = statSync(kbPath()).mtimeMs } catch {}
        saveIndex(file, index)
        return { ok: true, index, rebuilt: true, notes: [] }
      } catch (error) {
        // 建索引失败不等于这一问失败：把原因带回去，由调用方退回字面档。
        return { ok: false, error: '建索引失败：' + String(error?.message || error), notes: [] }
      } finally {
        building = null
      }
    })()
    return building
  }

  function brief(it) {
    const kind = KIND_LABEL[it.type] || it.type || '其它'
    const bits = [it.name + ' [' + kind + ']']
    if (it.meaning) bits.push('是什么：' + oneLine(it.meaning, 120))
    if (it.usage) bits.push('怎么用：' + oneLine(it.usage, 80))
    if (it.avoid) bits.push('别怎么用：' + oneLine(it.avoid, 80))
    if (Array.isArray(it.aliases) && it.aliases.length) bits.push('别名：' + it.aliases.slice(0, 6).join('、'))
    return bits.join('；')
  }

  /** 记忆目录里现在有哪些文件（只报名字/大小/时间，不读内容）。 */
  function filesInfo() {
    const dir = join(rootDir(), KNOWLEDGE_FOLDER)
    const out = []
    for (const name of [KNOWLEDGE_FILE, ...COMPANION_FILES]) {
      const file = join(dir, name)
      try {
        const info = statSync(file)
        out.push({ name, exists: true, bytes: info.size, mtime: Math.round(info.mtimeMs) })
      } catch {
        out.push({ name, exists: false, bytes: 0, mtime: 0 })
      }
    }
    try {
      const extra = readdirSync(dir).filter((name) => name.endsWith('.md') && !out.some((row) => row.name === name))
      for (const name of extra) {
        const info = statSync(join(dir, name))
        out.push({ name, exists: true, bytes: info.size, mtime: Math.round(info.mtimeMs) })
      }
    } catch {}
    return { folder: dir, files: out }
  }

  return {
    file: kbPath,
    files: filesInfo,
    indexPath: () => indexPath(currentConfig()),

    status() {
      const cfg = currentConfig()
      const loaded = loadItems()
      let index = null
      try { index = existsSync(indexPath(cfg)) ? loadIndex(indexPath(cfg)) : null } catch {}
      const state = index ? indexState(index, cfg, kbPath()) : { ok: false, why: loaded.error || '还没有索引' }
      const listing = filesInfo()
      return {
        file: loaded.file,
        folder: listing.folder,
        files: listing.files,
        ok: !loaded.error,
        error: loaded.error || '',
        items: loaded.items.length,
        enabled: cfg.enabled,
        mode: cfg.mode,
        model: cfg.model,
        hasKey: Boolean(readKnowledgeSecret({ home }).key),
        // 配置上的问题（比如「开着但没选后端」「远程缺 key」）要在面板上说出来，不能只藏在日志里。
        problems: normalizeKb({ ...cfg, apiKey: readKnowledgeSecret({ home }).key }).problems,
        index: index
          ? { model: index.model?.id || '', dim: index.model?.dim || 0, builtAt: index.model?.builtAt || 0, fresh: state.ok }
          : null,
        indexFresh: state.ok,
        indexWhy: state.why,
        lastError,
      }
    },

    async search(query, options = {}) {
      const text = oneLine(query, MAX_QUERY)
      const cfg = currentConfig()
      const loaded = loadItems()
      if (loaded.error) return { ok: false, error: loaded.error, hits: [] }
      if (!text) return { ok: false, error: '没给要查的词', hits: [] }
      if (!loaded.items.length) return { ok: false, error: '知识库里一条都没有', hits: [] }

      const limit = Math.round(num(options.limit, 1, 10, cfg.limit))
      const notes = []
      let index = null
      let embedder = null

      if (cfg.enabled) {
        let built = null
        try {
          built = await ensureIndex()
        } catch (error) {
          built = { ok: false, error: '索引没准备好：' + String(error?.message || error) }
        }
        if (built && built.ok) {
          index = built.index
          const made = await embedderFor(cfg)
          embedder = made.embedder
          if (!embedder) notes.push(...made.problems, '已退回字面档')
        } else {
          lastError = (built && built.error) || '索引没准备好'
          notes.push(lastError, '已退回字面档')
        }
      }

      const result = await kbSearch(text, {
        items: loaded.items,
        index,
        embedder,
        config: { ...KB_DEFAULTS, ...cfg, apiKey: '' },
        limit,
      })
      for (const note of result.notes || []) if (!notes.includes(note)) notes.push(note)

      const byId = new Map(loaded.items.map((it) => [it.id, it]))
      const hits = result.hits.map((hit) => {
        const item = byId.get(hit.id) || {}
        return {
          id: hit.id,
          type: item.type || '',
          name: item.name || hit.id,
          score: hit.score,
          lexical: hit.lexical,
          vector: hit.vector,
          coverage: hit.coverage,
          text: brief(item),
          item,
        }
      })
      return {
        ok: true,
        backend: result.backend,
        hits,
        truncated: result.truncated,
        notes,
        used: result.used,
      }
    },

    async rebuild() {
      const cfg = currentConfig()
      if (!cfg.enabled) return { ok: false, error: '向量检索没开（enabled=false），不需要索引' }
      try {
        const built = await ensureIndex({ force: true })
        if (!built.ok) { lastError = built.error || '建索引失败'; return built }
        return { ok: true, rebuilt: true, model: built.index.model, items: built.index.items.length }
      } catch (error) {
        lastError = '建索引失败：' + (error?.message || error)
        return { ok: false, error: lastError }
      }
    },
  }
}
