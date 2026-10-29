// 衣柜桥：把「群友印象」这类记忆顺手也写进 dsh-fish-memory 的会话库。
//
// 为什么要有这一层（2026-10-28 实测出来的）：她的记忆现在是两套，而且互不相认——
//  · 群聊这边按人记：<根>/鱼的记忆/群友/<QQ>.json（印象 + 最近来回）；
//  · 跟主人聊天时，真正被想起来的是 dsh-fish-memory 的会话库
//    （`<DSH_HOME>/fish-memory/session-<会话id>.json`，按会话分文件）。
// 于是群里认识的人，换个窗口跟主人聊天时她一点都想不起来：两条鱼。
//
// 合并数据是大事，先从这里切开一个小口子：**新写下的印象两边都落**。
// 已经存在的历史记忆不动（那要主人点头，见面板「鱼的记忆账本」）。
//
// 边界：
//  · 插件没装就安静返回 unavailable，调用方的写入照旧成功；
//  · 直接改文件、不调插件内部函数——插件内部函数今天能用，明天升级就没了；
//  · 同一个「事实键」只留最新那条：旧条目标成「已被取代」，保留可查，不删除。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

const STORE_DIR = join(DSH_HOME, 'fish-memory')
const SESSION_FILE = /^session-[A-Za-z0-9_-]+\.json$/
/** 没写时间的记忆按这个鲜活度算（与插件默认一致）。 */
const FRESH = 1

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function newId() {
  return 'fw' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 衣柜里最新的那份会话库是哪个：按文件修改时间「最近写过」的那个会话。 */
export function latestWardrobeFile({ home = DSH_HOME } = {}) {
  const dir = join(home, 'fish-memory')
  if (!existsSync(dir)) return ''
  let best = null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue
    const file = join(dir, entry.name)
    const at = Number(Date.parse(readJson(file)?.updatedAt || 0) || 0)
    const list = (readJson(file)?.memories || [])
    const latest = list.reduce((max, item) => Math.max(max, Date.parse(item?.at || item?.createdAt || 0) || 0), 0)
    const score = Math.max(at, latest)
    if (!best || score > best.score) best = { file, score }
  }
  return best ? best.file : ''
}

/**
 * 写一条记忆进衣柜。
 *
 * payload: { text, tags?, 事实键?, importance?, category? }
 * 返回 { ok, unavailable?, file?, id?, replaced?, error? }——调用方只需要看 ok。
 */
export function writeToWardrobe(payload = {}, { home = DSH_HOME, now = () => new Date() } = {}) {
  const text = String(payload.text || '').trim()
  if (!text) return { ok: false, error: '记忆内容不能为空' }
  const file = latestWardrobeFile({ home })
  if (!file) return { ok: false, unavailable: true, error: 'dsh-fish-memory 还没建过会话库（插件没装或没跑过）' }
  const store = readJson(file)
  if (!store || !Array.isArray(store.memories)) return { ok: false, error: '会话库读不出来' }

  const at = now().toISOString()
  const key = String(payload.事实键 || '').trim()
  let replaced = ''
  // 同一个键 = 同一件事：旧的那条标「已被取代」，写进去的是新的那条。
  if (key) {
    for (const item of store.memories) {
      if (item && item['事实键'] === key && !item['已被取代']) {
        item['已被取代'] = { 被谁: 'pending', 为什么: '新写下的记忆取代了它', 作废于: at }
        replaced = String(item.id || '')
      }
    }
  }

  const entry = {
    id: newId(),
    text,
    at,
    createdAt: at,
    category: String(payload.category || 'event'),
    importance: typeof payload.importance === 'number' ? payload.importance : 0.6,
    emotion: null,
    tags: Array.isArray(payload.tags) ? payload.tags.map(String).slice(0, 8) : [],
    source: '鱼的记忆（鱼的世界补给）',
    reinforcedAt: null,
    lastReinforcedDay: null,
    related: [],
    relatedAt: at,
    activation0: FRESH,
    ...(key ? { 事实键: key } : {}),
  }
  if (replaced) {
    for (const item of store.memories) {
      if (item && item['事实键'] === key && item['已被取代'] && item['已被取代'].被谁 === 'pending') {
        item['已被取代'].被谁 = entry.id
      }
    }
  }
  store.memories = [...store.memories, entry].slice(-2000)
  store.version = Number(store.version) || 2
  store.traces = Array.isArray(store.traces) ? store.traces : []

  mkdirSync(join(home, 'fish-memory'), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')

  // 回读确认：写进去再读回来，真有条才算成功（不假成功）。
  const after = readJson(file)
  const landed = Array.isArray(after?.memories) && after.memories.some((item) => item && item.id === entry.id)
  if (!landed) return { ok: false, error: '写进会话库后又读回来对不上' }
  return { ok: true, file, id: entry.id, replaced }
}

/** 给面板看的状态：衣柜在不在、有几条、最后一次写是什么时候。 */
export function wardrobeStatus({ home = DSH_HOME } = {}) {
  const file = latestWardrobeFile({ home })
  if (!file) return { available: false, file: '', count: 0, latestAt: '' }
  const store = readJson(file) || {}
  const list = Array.isArray(store.memories) ? store.memories : []
  const latestAt = list.reduce((max, item) => {
    const at = item?.at || item?.createdAt || ''
    return at > max ? String(at) : max
  }, '')
  return {
    available: true,
    file,
    count: list.length,
    fromUs: list.filter((item) => item && String(item.source || '').includes('鱼的世界')).length,
    latestAt,
  }
}
