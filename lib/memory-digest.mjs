// 每日记忆摘要：把分散的记忆压缩成一段按天稳定的文本，注入全局 systemPrompt。
//
// 规则：
//  · 一天只算一次（缓存在 <世界>/鱼的状态/记忆摘要-<YYYY-MM-DD>.json）；
//  · 重建在后台异步跑，当轮仍返回旧的，绝不拖慢回合；
//  · 空来源返回 ''（段自动不出现）；
//  · 失败保留旧摘要，并在 status 里给 lastError。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

const DAY = 24 * 60 * 60 * 1000
const DIGEST_FOLDER = '鱼的状态'
const DIGEST_PREFIX = '记忆摘要-'
const DEFAULT_BASE_HALF_LIFE = 30
const DEFAULT_EMOTION_HALF_LIFE = 7

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function listJson(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function normText(text) {
  // 去掉**所有**空白再比：上游存的时候可能带空格/换行，同一句话不该因为排版不同算两条。
  return String(text || '').replace(/\s+/g, '').trim().toLowerCase()
}

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 鲜活度：与 dsh-fish-memory 同一套公式（长期事实不淡；带情绪标记的按情绪半衰期）。 */
function activationOf(entry, baseHalfLife, emotionHalfLife, now = Date.now()) {
  const isFact = entry.category === 'stable_profile' || entry.fact === true || entry.pinned === true
  if (isFact) return 1
  const anchor = entry.at || entry.updatedAt || entry.createdAt || null
  const ms = anchor ? Date.parse(anchor) : NaN
  if (!Number.isFinite(ms)) return 0.5
  const days = Math.max(0, (now - ms) / DAY)
  const importance = typeof entry.importance === 'number' ? entry.importance : 0
  // 情绪类（有 emotion 标记的）淡得快：沿用 dsh-fish-memory 的口径（7 天半衰期）。
  const base = entry.emotion != null ? emotionHalfLife : baseHalfLife * (1 + 2 * importance)
  const halfLife = base || 1
  return Math.pow(2, -days / halfLife)
}

function formatRelative(ms, now) {
  const days = Math.round((now - ms) / DAY)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.round(days / 7)}周前`
  return `${Math.round(days / 30)}个月前`
}

export function createMemoryDigest({ home, world, storage, config, logger, now = () => Date.now() } = {}) {
  const _now = now

  function cacheFile(dateKey) {
    const root = (() => {
      try {
        const r = world?.root?.() || storage?.root?.()
        if (r) return join(r, DIGEST_FOLDER)
      } catch {}
      return ''
    })()
    if (!root) return ''
    return join(root, `${DIGEST_PREFIX}${dateKey}.json`)
  }

  function readPolicy() {
    const files = listJson(join(home || DSH_HOME, 'fish-memory'))
    for (const name of files) {
      if (!name.startsWith('session-')) continue
      const data = readJson(join(home || DSH_HOME, 'fish-memory', name))
      if (data && typeof data.policy === 'object') {
        return {
          baseHalfLifeDays: Number(data.policy.baseHalfLifeDays) || DEFAULT_BASE_HALF_LIFE,
          emotionHalfLifeDays: Number(data.policy.emotionHalfLifeDays) || DEFAULT_EMOTION_HALF_LIFE,
        }
      }
    }
    return { baseHalfLifeDays: DEFAULT_BASE_HALF_LIFE, emotionHalfLifeDays: DEFAULT_EMOTION_HALF_LIFE }
  }

  function loadSessionEntries() {
    const out = []
    let skipped = 0
    let files = 0
    const storeDir = join(home || DSH_HOME, 'fish-memory')
    for (const name of listJson(storeDir).filter((n) => n.startsWith('session-'))) {
      const data = readJson(join(storeDir, name))
      if (!data || !Array.isArray(data.memories)) {
        skipped += 1
        continue
      }
      files += 1
      for (const item of data.memories) {
        if (!item || typeof item !== 'object') continue
        const text = String(item.text || '').trim()
        if (!text) continue
        // 被取代的旧说法不进展：否则摘要里会出现互相矛盾的两句。
        if (item['已被取代']) continue
        out.push({
          text,
          at: String(item.at || item.createdAt || ''),
          category: String(item.category || 'event'),
          importance: typeof item.importance === 'number' ? item.importance : 0,
          emotion: item.emotion,
          fact: item.category === 'stable_profile',
          pinned: item.pinned === true,
          source: 'fish-memory',
        })
      }
    }
    return { entries: out, files, skipped }
  }

  function loadPersonImpressions() {
    const out = []
    let count = 0
    try {
      const root = (() => {
        try {
          const r = world?.root?.() || storage?.root?.()
          if (r) return join(r, '鱼的记忆', '群友')
        } catch {}
        return ''
      })()
      if (!root || !existsSync(root)) return { entries: out, count }
      for (const name of listJson(root)) {
        const data = readJson(join(root, name))
        if (data && data.summary && data.summary.text) {
          count += 1
          out.push({
            text: String(data.summary.text),
            at: data.summary.at ? new Date(Number(data.summary.at)).toISOString() : '',
            category: 'profile',
            importance: 0.8,
            emotion: null,
            fact: false,
            pinned: false,
            source: 'persons',
          })
        }
      }
    } catch {}
    return { entries: out, count }
  }

  function buildText(entries, opts) {
    const { maxChars = 1200, topK = 24 } = opts || {}
    if (!entries.length) return ''
    const header = '【记得的事·按天更新】\n'
    const headerLen = header.length
    let used = headerLen
    const lines = []
    for (const entry of entries.slice(0, topK)) {
      const relative = entry.at ? formatRelative(Date.parse(entry.at) || _now(), _now()) : ''
      const suffix = relative ? `（${relative}）` : ''
      const raw = String(entry.text || '')
      const clipped = raw.length > 80 ? raw.slice(0, 80) + '…' : raw
      const line = `- ${clipped}${suffix}`
      if (used + line.length + 1 > maxChars) break
      lines.push(line)
      used += line.length + 1
    }
    if (!lines.length) return ''
    return header + lines.join('\n')
  }

  function rebuild(force = false) {
    const cfg = (typeof config === 'function' ? config() : config) || {}
    if (cfg.enabled === false) return { ok: true, text: '', disabled: true }

    const policy = readPolicy()
    const nowMs = _now()
    const { entries: sessionEntries, files: sessionFiles, skipped: sessionSkipped } = loadSessionEntries()
    const { entries: personEntries, count: personCount } = loadPersonImpressions()
    const all = [...sessionEntries, ...personEntries]

    // 去重：归一化文本相同只留最新
    const seen = new Map()
    for (const entry of all) {
      const key = normText(entry.text)
      if (!key) continue
      const prev = seen.get(key)
      const atMs = entry.at ? Date.parse(entry.at) : 0
      if (!prev || atMs > (prev.atMs || 0)) {
        seen.set(key, { ...entry, atMs })
      }
    }
    const unique = Array.from(seen.values())

    // 打分：长期事实置顶，其余按新鲜度
    const scored = unique
      .map((entry) => ({
        ...entry,
        score: activationOf(entry, policy.baseHalfLifeDays, policy.emotionHalfLifeDays, nowMs)
          + (entry.fact || entry.pinned ? 10 : 0)
          + (entry.source === 'persons' ? 0.05 : 0),
      }))
      .sort((a, b) => b.score - a.score)

    const text = buildText(scored, { maxChars: cfg.maxChars, topK: cfg.topK })
    const linesCount = text.split('\n').filter((l) => l.startsWith('- ')).length

    const dateKey = dayKey(new Date(nowMs))
    const file = cacheFile(dateKey)
    if (file) {
      try {
        const dir = dirname(file)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(file, JSON.stringify({
          text,
          dateKey,
          count: linesCount,
          chars: text.length,
          sources: {
            sessionFiles,
            sessionEntries: sessionEntries.length,
            persons: personCount,
            skippedFiles: sessionSkipped,
          },
          at: new Date(nowMs).toISOString(),
        }, null, 2), 'utf8')
      } catch (error) {
        try { logger?.warn?.(`fish-world: 记忆摘要缓存写入失败：${error?.message || error}`) } catch {}
      }
    }

    return {
      ok: true,
      text,
      entries: scored.length,
      lines: linesCount,
      sources: { sessionFiles, persons: personCount, skippedFiles: sessionSkipped },
    }
  }

  function readCache(dateKey) {
    const file = cacheFile(dateKey)
    if (!file || !existsSync(file)) return null
    const data = readJson(file)
    if (!data || typeof data.text !== 'string') return null
    return data
  }

  function sectionText() {
    const cfg = (typeof config === 'function' ? config() : config) || {}
    if (cfg.enabled === false) return ''
    const dateKey = dayKey(new Date(_now()))
    const cached = readCache(dateKey)
    if (cached) return cached.text
    // 当天没有：后台异步重建，当轮返回空（下一轮就有）
    queueMicrotask(() => {
      try { rebuild() } catch {}
    })
    return ''
  }

  function status() {
    const cfg = (typeof config === 'function' ? config() : config) || {}
    const dateKey = dayKey(new Date(_now()))
    const cached = readCache(dateKey)
    return {
      enabled: cfg.enabled !== false,
      dateKey,
      cached: !!cached,
      textLength: cached ? cached.text.length : 0,
      lines: cached ? cached.count || 0 : 0,
      sources: cached ? cached.sources : null,
      updatedAt: cached ? cached.at : '',
      nextRebuild: '日期变化或手动触发',
    }
  }

  return { sectionText, rebuild, status }
}
