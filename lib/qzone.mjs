// Fish-world's small, DSH-native QQ Space client.
// Network destinations are fixed to Tencent Qzone and the configured OneBot
// endpoint; callers can only act on feed/comment IDs previously returned here.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './util.mjs'

const ORIGIN = 'https://user.qzone.qq.com'
const REQUEST_TIMEOUT_MS = 15000
const STATE_RETENTION_DAYS = 90

function dayKey(time = Date.now()) {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function cleanText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n').trim().slice(0, limit)
}

function validUin(value) { return /^\d{5,11}$/.test(String(value ?? '')) }
function validTid(value) { return /^[a-f\d]{24}$/i.test(String(value ?? '')) }

function gtk(skey) {
  let hash = 5381
  for (const char of String(skey || '')) hash += (hash << 5) + char.charCodeAt(0)
  return String(hash & 0x7fffffff)
}

function parseCookieField(value) {
  const out = new Map()
  if (typeof value === 'string') {
    for (const part of value.split(';')) {
      const eq = part.indexOf('=')
      if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  } else if (Array.isArray(value)) {
    for (const row of value) if (row?.name && row.value != null) out.set(String(row.name), String(row.value))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) if (item != null) out.set(key, String(item))
  }
  return out
}

function skipSpace(source, state) {
  while (state.i < source.length) {
    if (/\s/.test(source[state.i])) { state.i++; continue }
    if (source.startsWith('//', state.i)) {
      const end = source.indexOf('\n', state.i + 2)
      state.i = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', state.i)) {
      const end = source.indexOf('*/', state.i + 2)
      state.i = end < 0 ? source.length : end + 2
      continue
    }
    break
  }
}

function parseString(source, state) {
  const quote = source[state.i++]
  let result = ''
  while (state.i < source.length) {
    const char = source[state.i++]
    if (char === quote) return result
    if (char !== '\\') { result += char; continue }
    if (state.i >= source.length) break
    const next = source[state.i++]
    if (next === 'x' && /^[\da-f]{2}$/i.test(source.slice(state.i, state.i + 2))) {
      result += String.fromCharCode(parseInt(source.slice(state.i, state.i + 2), 16)); state.i += 2
    } else if (next === 'u' && /^[\da-f]{4}$/i.test(source.slice(state.i, state.i + 4))) {
      result += String.fromCharCode(parseInt(source.slice(state.i, state.i + 4), 16)); state.i += 4
    } else {
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
      result += Object.hasOwn(escapes, next) ? escapes[next] : next
    }
  }
  throw new Error('Qzone 响应包含未闭合字符串')
}

// Parse the JSON/JSONP/JS-object response styles used by Qzone without eval.
function parseJsValue(source, state = { i: 0 }) {
  skipSpace(source, state)
  const char = source[state.i]
  if (char === '"' || char === "'") return parseString(source, state)
  if (char === '{') {
    state.i++
    const value = {}
    skipSpace(source, state)
    while (source[state.i] !== '}') {
      const key = source[state.i] === '"' || source[state.i] === "'"
        ? parseString(source, state)
        : (() => {
          const match = /^[\w$.-]+/.exec(source.slice(state.i))
          if (!match) throw new Error('Qzone 响应对象键无效')
          state.i += match[0].length
          return match[0]
        })()
      skipSpace(source, state)
      if (source[state.i++] !== ':') throw new Error('Qzone 响应缺少冒号')
      value[key] = parseJsValue(source, state)
      skipSpace(source, state)
      if (source[state.i] === ',') { state.i++; skipSpace(source, state); if (source[state.i] === '}') break }
      else if (source[state.i] !== '}') throw new Error('Qzone 响应对象分隔符无效')
    }
    state.i++
    return value
  }
  if (char === '[') {
    state.i++
    const value = []
    skipSpace(source, state)
    while (source[state.i] !== ']') {
      value.push(parseJsValue(source, state))
      skipSpace(source, state)
      if (source[state.i] === ',') { state.i++; skipSpace(source, state); if (source[state.i] === ']') break }
      else if (source[state.i] !== ']') throw new Error('Qzone 响应数组分隔符无效')
    }
    state.i++
    return value
  }
  const number = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(source.slice(state.i))
  if (number) { state.i += number[0].length; return Number(number[0]) }
  const word = /^[\w$]+/.exec(source.slice(state.i))
  if (word) {
    state.i += word[0].length
    if (word[0] === 'true') return true
    if (word[0] === 'false') return false
    if (word[0] === 'null' || word[0] === 'undefined' || word[0] === 'NaN' || word[0] === 'Infinity') return null
    return word[0]
  }
  throw new Error('Qzone 响应值无法解析')
}

function parseQzoneResponse(text) {
  const source = String(text || '').trim().replace(/^\uFEFF/, '')
  if (!source) throw new Error('Qzone 返回空响应')
  try { return JSON.parse(source) } catch {}
  const starts = [...source.matchAll(/[\[{]/g)].map((match) => match.index)
  for (const start of starts) {
    try {
      const value = parseJsValue(source, { i: start })
      if (value && typeof value === 'object') return value
    } catch {}
  }
  throw new Error('Qzone 响应格式无法识别')
}

function decodeHtml(text) {
  return String(text || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim()
}

function deepValue(object, names, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 7) return undefined
  for (const name of names) if (Object.hasOwn(object, name) && object[name] != null) return object[name]
  for (const value of Object.values(object)) {
    const got = deepValue(value, names, depth + 1)
    if (got != null) return got
  }
  return undefined
}

function findArray(object, predicate, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 7) return null
  if (Array.isArray(object) && object.some((item) => predicate(item))) return object
  for (const value of Object.values(object)) {
    const got = findArray(value, predicate, depth + 1)
    if (got) return got
  }
  return null
}

function normalizeFeed(row) {
  const uin = String(row?.uin ?? row?.hostuin ?? row?.hostUin ?? '')
  const tid = String(row?.key ?? row?.tid ?? row?.topicId ?? '')
  if (!validUin(uin) || !validTid(tid)) return null
  const stamp = Number(row.abstime ?? row.time ?? row.createTime ?? 0)
  const content = decodeHtml(row.html ?? row.content ?? row.text ?? row.msg ?? '')
  if (!content) return null
  return {
    uin,
    tid,
    content: cleanText(content, 800),
    nickname: cleanText(row.nickname ?? row.nick ?? uin, 48),
    at: stamp > 1e12 ? stamp : stamp > 0 ? stamp * 1000 : 0,
    likes: Number(row.likecount ?? row.likes ?? 0) || 0,
    comments: Number(row.commentcount ?? row.comments ?? 0) || 0,
  }
}

function normalizeComment(row, feed) {
  const uin = String(row?.uin ?? row?.commentUin ?? row?.comment_uin ?? '')
  const id = String(row?.commentid ?? row?.commentId ?? row?.tid ?? row?.id ?? '')
  const content = cleanText(decodeHtml(row?.content ?? row?.html ?? row?.text ?? ''), 500)
  if (!validUin(uin) || !/^\d{1,30}$/.test(id) || !content) return null
  return {
    uin,
    id,
    feedUin: feed.uin,
    feedTid: feed.tid,
    nickname: cleanText(row.nickname ?? row.nick ?? uin, 48),
    content,
    parentId: String(row.parentTid ?? row.parentId ?? ''),
  }
}

function okResponse(response, label) {
  const codes = [
    response?.code, response?.ret, response?.retcode,
    response?.data?.code, response?.data?.ret, response?.data?.retcode,
  ].filter((value) => value != null)
  if (codes.length && codes.every((value) => Number(value) === 0)) return true
  if (codes.length) throw new Error(`${label}失败（Qzone code ${String(codes.find((value) => Number(value) !== 0)).slice(0, 30)}）`)
  if (response?.t1_tid || response?.tid || response?.data?.t1_tid) return true
  throw new Error(`${label}失败：Qzone 未返回成功标记`)
}

export function createQzoneService({ qq, world, config, fetchImpl } = {}) {
  let cookieCache = null
  let mutationQueue = Promise.resolve()
  const fetcher = (...args) => (fetchImpl || globalThis.fetch)(...args)

  function settings() { return config()?.qzone || {} }
  function worldRoot() {
    const status = world?.status?.()
    if (!status?.ok || !status.worldPath) throw new Error(status?.error || '鱼的世界尚未绑定工作区')
    return status.worldPath
  }
  function statePath() { return join(worldRoot(), '安全与审计', 'qzone-actions.json') }
  function emptyState() {
    return { version: 1, createdAt: Date.now(), diaryPromptAt: 0, actions: [], acted: {}, feedCache: [], commentCache: {} }
  }
  function loadState() {
    const raw = readJson(statePath(), null)
    if (!raw || typeof raw !== 'object') {
      const initial = emptyState()
      saveState(initial)
      return initial
    }
    return {
      ...emptyState(),
      ...raw,
      createdAt: Number(raw.createdAt) || Date.now(),
      diaryPromptAt: Number(raw.diaryPromptAt) || 0,
      actions: Array.isArray(raw?.actions) ? raw.actions : [],
      acted: raw?.acted && typeof raw.acted === 'object' ? raw.acted : {},
      feedCache: Array.isArray(raw?.feedCache) ? raw.feedCache : [],
      commentCache: raw?.commentCache && typeof raw.commentCache === 'object' ? raw.commentCache : {},
    }
  }
  function saveState(state) {
    const file = statePath()
    mkdirSync(join(file, '..'), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(temp, file)
  }
  function serialized(fn) {
    const current = mutationQueue.then(fn, fn)
    mutationQueue = current.then(() => undefined, () => undefined)
    return current
  }
  function quotaKind(kind) { return kind === 'diary' ? 'post' : kind }
  function dailyLimit(kind) {
    const names = { post: 'postsPerDay', like: 'likesPerDay', comment: 'commentsPerDay', reply: 'repliesPerDay' }
    const value = Number(settings()[names[quotaKind(kind)]])
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.floor(value))) : 2
  }
  function dayCount(state, day) {
    return state.actions.filter((action) => action.day === day)
  }
  function currentUsage(state, day = dayKey()) {
    const today = state.actions.filter((action) => action.day === day)
    const byKind = Object.fromEntries(['post', 'like', 'comment', 'reply'].map((kind) => {
      const used = today.filter((action) => quotaKind(action.kind) === kind).length
      const limit = dailyLimit(kind)
      return [kind, { used, limit, remaining: Math.max(0, limit - used) }]
    }))
    return { byKind }
  }
  /**
   * 今天的日记状态（两个口径都按上海日界，和额度用的 dayKey 一致）。
   *
   * · localToday：今天鱼在本机写过日记（本地日记本，不含待确认）；
   * · postedToday：今天已经发过一条空间日记。
   * 世界还没绑上时 localToday 给 null —— 那是「读不到」，不能当成「今天没写」。
   */
  function diaryTodayState(state) {
    const today = dayKey()
    const postedToday = state.actions.some((action) => action.kind === 'diary'
      && action.day === today && action.status !== 'failed')
    let localToday = null
    try {
      localToday = (world.listDiary({ limit: 30 }) || [])
        .some((item) => dayKey(Number(new Date(item.at)) || 0) === today)
    } catch { localToday = null }
    return { today, localToday, postedToday }
  }

  function status() {
    try {
      const state = loadState()
      const diaries = state.actions.filter((action) => action.kind === 'diary' && action.status !== 'failed')
        .sort((a, b) => Number(b.at) - Number(a.at))
      const lastDiaryAt = diaries.length ? Number(diaries[0].at) : 0
      const diaryDueAt = lastDiaryAt || Number(state.createdAt) || Date.now()
      const diaryDue = Date.now() - diaryDueAt >= 24 * 60 * 60 * 1000
      const todayState = diaryTodayState(state)
      // 「写完日记就发一次」是另一条触发，只在主人单独打开时才成立（外发默认关）。
      const sameDayDue = todayState.localToday === true && todayState.postedToday === false
      return {
        ok: true,
        enabled: settings().enabled !== false,
        day: dayKey(),
        usage: currentUsage(state),
        lastDiaryAt: lastDiaryAt || null,
        diaryDue,
        diaryToday: todayState.localToday,
        diaryPostedToday: todayState.postedToday,
        sameDayDue,
        diaryPromptAt: Number(state.diaryPromptAt) || 0,
        diaryDueReason: diaryDue
          ? '距上次空间日记已满 24 小时或尚未写过'
          : (sameDayDue ? '今天本机已经写过日记，但空间还没发' : ''),
      }
    } catch (error) {
      return { ok: false, enabled: settings().enabled !== false, error: String(error.message || error) }
    }
  }
  function feedKey(uin, tid) { return `${String(uin)}:${String(tid).toLowerCase()}` }
  function diaryMaterial() {
    const qzoneStatus = status()
    if (!qzoneStatus.ok) return qzoneStatus
    let entries = []
    try { entries = world.listDiary({ limit: 20 }) } catch {}
    // 主人留下的、鱼还没回应的批语：让它在下一次写日记时自然带一句反馈。
    let comments = []
    try { comments = world.pendingDiaryComments({ limit: 20 }) } catch {}
    return {
      ok: true,
      diaryDue: qzoneStatus.diaryDue,
      sameDayDue: qzoneStatus.sameDayDue,
      diaryPostedToday: qzoneStatus.diaryPostedToday,
      lastDiaryAt: qzoneStatus.lastDiaryAt,
      remainingToday: qzoneStatus.usage.byKind.post.remaining,
      entries,
      comments,
      note: '仅返回鱼世界已批准的本地日记素材；没有素材时可写安静的一天，不要编造事件。'
        + (comments.length
          ? ' comments 是主人对你之前日记的批语（quote 为主人圈出的原句），写新日记时可以用一两句自然回应，不要逐条复述，也不要把它写成回复列表。'
          : ''),
    }
  }
  /**
   * 认领一次「该写空间日记了」的提醒。两条触发路径：
   *   · 旧的滚动 24 小时：距上次空间日记（或建档时间）满 24 小时；
   *   · 新的当天触发：allowSameDay 为真时，今天本机写过日记且今天还没发过空间日记。
   * allowSameDay 由主人开关（平台 qzoneDailyDiary）决定，调用方负责读；
   * 这里不默认打开——外发要逐项打开是规矩，不能因为加了条路径就自动生效。
   */
  function claimDiaryReminder({ cooldownMs = 6 * 60 * 60 * 1000, allowSameDay = false } = {}) {
    return serialized(() => {
      const state = loadState()
      if (settings().enabled === false) return false
      const diaries = state.actions.filter((action) => action.kind === 'diary' && action.status !== 'failed')
      const lastDiaryAt = diaries.reduce((latest, item) => Math.max(latest, Number(item.at) || 0), 0)
      const anchor = lastDiaryAt || Number(state.createdAt) || Date.now()
      const now = Date.now()
      const rollingDue = now - anchor >= 24 * 60 * 60 * 1000
      if (!rollingDue) {
        if (!allowSameDay) return false
        const todayState = diaryTodayState(state)
        if (!(todayState.localToday === true && todayState.postedToday === false)) return false
      }
      if (currentUsage(state).byKind.post.remaining <= 0) return false
      if (state.diaryPromptAt && now - state.diaryPromptAt < Math.max(60 * 60 * 1000, Number(cooldownMs) || 0)) return false
      state.diaryPromptAt = now
      saveState(state)
      return true
    })
  }
  function cachedFeed(state, uin, tid) {
    const item = state.feedCache.find((feed) => feedKey(feed.uin, feed.tid) === feedKey(uin, tid))
    if (!item || Date.now() - Number(item.cachedAt || 0) > 24 * 60 * 60 * 1000) return null
    return item
  }
  function reserve(state, kind, target) {
    const now = Date.now()
    const day = dayKey(now)
    const bucket = quotaKind(kind)
    const used = dayCount(state, day).filter((action) => quotaKind(action.kind) === bucket).length
    const limit = dailyLimit(kind)
    if (limit <= used) throw new Error(`今天${kindLabel(bucket)}额度已用完（${used}/${limit} 次/天）`)
    const actionKey = target ? `${kind}:${target}` : ''
    if (actionKey && state.acted[actionKey]) throw new Error(`这条内容今天已经${kindLabel(kind)}过，防止重复操作。`)
    const entry = { id: randomUUID(), kind, day, at: now, target: String(target || ''), status: 'pending' }
    state.actions.push(entry)
    if (actionKey) state.acted[actionKey] = { at: now, day }
    const cutoff = now - STATE_RETENTION_DAYS * 86400000
    state.actions = state.actions.filter((item) => Number(item.at) >= cutoff)
    for (const [key, value] of Object.entries(state.acted)) if (Number(value?.at) < cutoff) delete state.acted[key]
    saveState(state)
    return entry.id
  }
  function kindLabel(kind) {
    return ({ post: '发动态/日记', diary: '发动态/日记', like: '点赞', comment: '评论', reply: '回复' })[kind] || '操作'
  }
  async function performWrite(kind, target, action) {
    return serialized(async () => {
      const state = loadState()
      const actionId = reserve(state, kind, target)
      try {
        const value = await action()
        const latest = loadState()
        const entry = latest.actions.find((item) => item.id === actionId)
        if (entry) entry.status = 'success'
        saveState(latest)
        return value
      } catch (error) {
        // Once the HTTP write starts its result may be ambiguous. Keep the slot
        // consumed so a retry cannot duplicate an action on the public profile.
        const latest = loadState()
        const entry = latest.actions.find((item) => item.id === actionId)
        if (entry) entry.status = 'uncertain'
        saveState(latest)
        throw error
      }
    })
  }
  async function auth() {
    if (settings().enabled === false) throw new Error('QQ 空间能力已关闭')
    const worldStatus = world?.status?.()
    if (!worldStatus?.ok) throw new Error(worldStatus?.error || '鱼的世界尚未绑定工作区')
    if (!qq || typeof qq.call !== 'function') throw new Error('QQ 桥未提供 OneBot 调用能力')
    if (cookieCache && Date.now() - cookieCache.at < 5 * 60 * 1000) return cookieCache
    const response = await qq.call('get_cookies', { domain: 'qzone.qq.com' }, { timeoutMs: 8000 })
    if (!response?.ok) throw new Error(`无法从 OneBot 获取 QQ 空间登录态：${response?.error || '请确认 bot 已登录'}`)
    const data = response.data || response.raw?.data || {}
    const cookies = parseCookieField(data.cookies ?? data.cookie ?? data)
    const pSkey = cookies.get('p_skey')
    if (!pSkey) throw new Error('OneBot 未返回 p_skey；请确认当前 OneBot 实现支持 get_cookies')
    const uin = String(cookies.get('pt2gguin') || cookies.get('uin') || '').replace(/^o+/, '')
    if (!validUin(uin)) throw new Error('登录态中没有有效的 QQ 号；请确认 QQ 桥登录的是鱼自己的账号')
    cookieCache = { cookies, uin, gtk: gtk(pSkey), at: Date.now() }
    return cookieCache
  }
  async function request(method, endpoint, authData, params = {}, form = null) {
    const url = new URL(endpoint, ORIGIN)
    if (url.origin !== ORIGIN) throw new Error('内部错误：Qzone 请求目标超出固定域名')
    for (const [key, value] of Object.entries({ ...params, g_tk: authData.gtk })) url.searchParams.set(key, String(value))
    const headers = {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
      cookie: [...authData.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; '),
      referer: `${ORIGIN}/${authData.uin}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    }
    const response = await fetcher(url, {
      method,
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400) throw new Error('Qzone 重定向到登录页；登录态可能过期')
    if (!response.ok) throw new Error(`Qzone HTTP ${response.status}`)
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) throw new Error('Qzone 响应超过 2MB 上限')
    let bytes
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 2 * 1024 * 1024) {
          await reader.cancel().catch(() => {})
          throw new Error('Qzone 响应超过 2MB 上限')
        }
        chunks.push(Buffer.from(part.value))
      }
      bytes = Buffer.concat(chunks, size)
    } else {
      bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Qzone 响应超过 2MB 上限')
    }
    return parseQzoneResponse(bytes.toString('utf8'))
  }
  async function listFeeds(count = 10) {
    const authData = await auth()
    const limit = Math.max(1, Math.min(20, Number(count) || Number(settings().maxFeeds) || 10))
    const response = await request('GET', '/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more', authData, {
      uin: authData.uin, scope: '0', view: '1', filter: 'all', flag: '1', applist: 'all',
      pagenum: '1', aisortEndTime: '0', aisortOffset: '0', aisortBeginTime: '0',
      begintime: '0', format: 'json', useutf8: '1', outputhtmlfeed: '1',
    })
    const rows = findArray(response, (row) => row && typeof row === 'object' && (row.key || row.tid) && (row.uin || row.hostuin)) || []
    const items = rows.map(normalizeFeed).filter(Boolean).slice(0, limit).map((item) => ({ ...item, cachedAt: Date.now() }))
    const state = loadState()
    state.feedCache = items.map(({ uin, tid, nickname, at, cachedAt }) => ({ uin, tid, nickname, at, cachedAt }))
    state.commentCache = {}
    saveState(state)
    return { ok: true, items, hasMore: Boolean(deepValue(response, ['hasMoreFeeds', 'hasMore'])) }
  }
  function requireCachedFeed(uin, tid) {
    if (!validUin(uin) || !validTid(tid)) throw new Error('目标 QQ 号或动态 ID 无效，请从最近的动态列表中选择。')
    const feed = cachedFeed(loadState(), uin, tid)
    if (!feed) throw new Error('该动态不在最近一次列表里或缓存已过期；请先刷新好友动态，再操作。')
    return feed
  }
  async function listComments(uin, tid) {
    const feed = requireCachedFeed(uin, tid)
    const authData = await auth()
    const response = await request('GET', '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6', authData, {
      uin: feed.uin, tid: feed.tid, format: 'jsonp',
    })
    const rows = findArray(response, (row) => row && typeof row === 'object' && (row.commentid || row.commentId) && (row.content || row.html)) || []
    const comments = rows.map((row) => normalizeComment(row, feed)).filter(Boolean).slice(0, 100)
    const state = loadState()
    state.commentCache[feedKey(feed.uin, feed.tid)] = {
      at: Date.now(),
      comments: comments.map(({ uin, id, feedUin, feedTid, nickname, parentId }) => ({ uin, id, feedUin, feedTid, nickname, parentId })),
    }
    saveState(state)
    return { ok: true, feed: { uin: feed.uin, tid: feed.tid }, comments }
  }
  async function post({ text, diary = false } = {}) {
    const limit = Math.max(1, Math.min(5000, Number(settings().maxPostChars) || 500))
    const content = cleanText(text, limit)
    if (!content) throw new Error('动态内容不能为空')
    const authData = await auth()
    const kind = diary ? 'diary' : 'post'
    return performWrite(kind, '', async () => {
      const response = await request('POST', '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6', authData, {
        uin: authData.uin,
      }, {
        syn_tweet_verson: '1', paramstr: '1', who: '1', con: content, feedversion: '1', ver: '1',
        ugc_right: '1', to_sign: '0', hostuin: authData.uin, code_version: '1', format: 'json',
        qzreferrer: `${ORIGIN}/${authData.uin}`,
      })
      okResponse(response, diary ? '发空间日记' : '发空间动态')
      const tid = String(deepValue(response, ['t1_tid', 'tid']) || '')
      if (!tid) throw new Error('Qzone 未返回动态 ID，无法确认发布成功；为避免重复已保留本次额度')
      return { ok: true, tid, kind, content: `已发布到 QQ 空间：${content.slice(0, 60)}${content.length > 60 ? '…' : ''}` }
    })
  }
  async function like({ uin, tid } = {}) {
    const feed = requireCachedFeed(uin, tid)
    const authData = await auth()
    return performWrite('like', feedKey(feed.uin, feed.tid), async () => {
      const unikey = `${ORIGIN}/${feed.uin}/mood/${feed.tid}.1`
      const response = await request('POST', '/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app', authData, {}, {
        qzreferrer: `${ORIGIN}/${feed.uin}`, opuin: authData.uin, unikey, curkey: unikey,
        from: '-100', fupdate: '1', face: '0', abstime: String(Math.floor((feed.at || Date.now()) / 1000)),
        fid: feed.tid, format: 'json',
      })
      okResponse(response, '点赞')
      return { ok: true, content: `已给 ${feed.nickname} 的动态点赞。` }
    })
  }
  async function comment({ uin, tid, content } = {}) {
    const feed = requireCachedFeed(uin, tid)
    const text = cleanText(content, Math.max(1, Math.min(1000, Number(settings().maxCommentChars) || 200)))
    if (!text) throw new Error('评论不能为空')
    const authData = await auth()
    return performWrite('comment', feedKey(feed.uin, feed.tid), async () => {
      const response = await request('POST', '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds', authData, {}, {
        topicId: `${feed.uin}_${feed.tid}__1`, uin: authData.uin, hostUin: feed.uin, feedsType: '100',
        inCharset: 'utf-8', outCharset: 'utf-8', plat: 'qzone', source: 'ic', platformid: '52',
        format: 'fs', ref: 'feeds', content: text, richval: '', richtype: '', private: '0', paramstr: '1',
        qzreferrer: `${ORIGIN}/${feed.uin}/main`,
      })
      okResponse(response, '评论')
      return { ok: true, content: `已在 ${feed.nickname} 的动态下评论。` }
    })
  }
  async function reply({ uin, tid, commentId, commentUin, content } = {}) {
    const feed = requireCachedFeed(uin, tid)
    const text = cleanText(content, Math.max(1, Math.min(1000, Number(settings().maxCommentChars) || 200)))
    if (!text) throw new Error('回复内容不能为空')
    if (!/^\d{1,30}$/.test(String(commentId || '')) || !validUin(commentUin)) throw new Error('评论 ID 或评论者 QQ 号无效')
    const state = loadState()
    const cache = state.commentCache[feedKey(feed.uin, feed.tid)]
    if (!cache || Date.now() - Number(cache.at || 0) > 24 * 60 * 60 * 1000) throw new Error('请先查看这条动态的评论，再选择要回复的评论。')
    const rootComment = cache.comments.find((item) => item.id === String(commentId) && item.uin === String(commentUin))
    if (!rootComment) throw new Error('这条评论不在最近查看的评论清单中。')
    const authData = await auth()
    const targetKey = `${feedKey(feed.uin, feed.tid)}:${rootComment.id}:${rootComment.uin}`
    return performWrite('reply', targetKey, async () => {
      const mentionName = rootComment.nickname.replace(/[{},]/g, '').slice(0, 48) || rootComment.uin
      const response = await request('POST', '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds', authData, {}, {
        topicId: `${feed.uin}_${feed.tid}__1`, uin: authData.uin, hostUin: feed.uin, feedsType: '100',
        inCharset: 'utf-8', outCharset: 'utf-8', plat: 'qzone', source: 'ic', platformid: '52',
        format: 'fs', ref: 'feeds', content: `@{uin:${rootComment.uin},nick:${mentionName},who:1,auto:1}${text}`,
        commentId: rootComment.id, commentUin: rootComment.uin, richval: '', richtype: '', private: '0',
        paramstr: '2', qzreferrer: `${ORIGIN}/${authData.uin}/main`,
      })
      okResponse(response, '回复评论')
      return { ok: true, content: `已回复 ${rootComment.nickname} 的评论。` }
    })
  }

  return { status, diaryMaterial, claimDiaryReminder, listFeeds, listComments, post, like, comment, reply, parseQzoneResponse }
}

export const __test = { parseCookieField, parseQzoneResponse, normalizeFeed, normalizeComment, validUin, validTid, dayKey }
