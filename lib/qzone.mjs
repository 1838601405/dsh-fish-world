// Fish-world's small, DSH-native QQ Space client.
// 现在全部走协议端（SnowLuma）的 OneBot 空间接口（qq.call）：登录态由协议端自己保管，
// 这里不再申请 cookie、不再直连任何 CGI。调用方只能操作此前从这里返回过的动态/评论 ID。
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from './util.mjs'

const CALL_TIMEOUT_MS = 15000
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

function decodeHtml(text) {
  return String(text || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim()
}

// 把 get_qzone_feeds 的一条动态归一成鱼世界内部形状。
// 上游同时给 content（已抽纯文本）与 html（原始）：优先纯文本，缺了再从 html 解一层。
function normalizeFeed(row) {
  const uin = String(row?.uin ?? '')
  const tid = String(row?.tid ?? row?.key ?? '')
  if (!validUin(uin) || !validTid(tid)) return null
  const stamp = Number(row.time ?? 0)
  const content = cleanText(row.content || decodeHtml(row.html || ''), 800)
  if (!content) return null
  return {
    uin,
    tid,
    content,
    nickname: cleanText(row.nickname ?? uin, 48),
    at: stamp > 1e12 ? stamp : stamp > 0 ? stamp * 1000 : 0,
    likes: Number(row.like_count ?? 0) || 0,
    comments: Number(row.comment_count ?? 0) || 0,
  }
}

// 把 get_qzone_msg_detail 的一条评论（含二级回复）归一成鱼世界内部形状。
// 上游字段是 name / comment_id / parent_comment_id；保留旧 CGI 字段名做兜底。
function normalizeComment(row, feed) {
  const uin = String(row?.uin ?? '')
  const id = String(row?.comment_id ?? row?.commentid ?? row?.commentId ?? row?.id ?? '')
  const content = cleanText(decodeHtml(row?.content ?? row?.html ?? row?.text ?? ''), 500)
  if (!validUin(uin) || !/^\d{1,30}$/.test(id) || !content) return null
  return {
    uin,
    id,
    feedUin: feed.uin,
    feedTid: feed.tid,
    nickname: cleanText(row.name ?? row.nickname ?? row.nick ?? uin, 48),
    content,
    parentId: String(row.parent_comment_id ?? row.parentTid ?? row.parentId ?? ''),
  }
}

export function createQzoneService({ qq, world, config } = {}) {
  let loginCache = null
  let mutationQueue = Promise.resolve()

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
        // 写操作一旦发出，结果就可能不确定。保留额度槽位，
        // 防止重试在公开主页上重复操作。
        const latest = loadState()
        const entry = latest.actions.find((item) => item.id === actionId)
        if (entry) entry.status = 'uncertain'
        saveState(latest)
        throw error
      }
    })
  }

  // 同步闸门：外发开关、世界绑定、QQ 桥在位。读写共用，失败就地如实报错。
  function requireGate() {
    if (settings().enabled === false) throw new Error('QQ 空间能力已关闭')
    const worldStatus = world?.status?.()
    if (!worldStatus?.ok) throw new Error(worldStatus?.error || '鱼的世界尚未绑定工作区')
    if (!qq || typeof qq.call !== 'function') throw new Error('QQ 桥未提供 OneBot 调用能力')
  }
  /**
   * 鱼自己的 QQ 号：只问一次协议端（get_login_info），5 分钟内用缓存。
   * 只在写操作前用它做一次「桥登录的确实是鱼自己的账号」的确认；读操作不强制，
   * 省一次往返，也让读在登录探针偶发失败时不至于误报（读失败由上游接口自己如实报）。
   * 注意：点赞/评论要的 target_uin 不是这个号，而是被操作说说的主人（feeds 里的 uin）。
   */
  async function selfUin() {
    if (loginCache && Date.now() - loginCache.at < 5 * 60 * 1000) return loginCache.uin
    const response = await qq.call('get_login_info', {}, { timeoutMs: 5000 })
    const uin = String(response?.data?.user_id ?? '')
    if (!response?.ok || !validUin(uin)) {
      throw new Error(`无法确认鱼自己的 QQ 号：${response?.error || '请确认 bot 已登录'}`)
    }
    loginCache = { uin, at: Date.now() }
    return uin
  }
  // 调一个上游空间接口：失败只报状态/措辞，不回显响应体，也不打印任何登录态。
  async function callQzone(action, params, label) {
    const response = await qq.call(action, params, { timeoutMs: CALL_TIMEOUT_MS })
    if (!response?.ok) {
      const detail = response?.error || response?.raw?.message || response?.raw?.wording
        || `retcode ${response?.raw?.retcode ?? '?'}`
      throw new Error(`${label}失败：${String(detail).slice(0, 120)}`)
    }
    return response.data && typeof response.data === 'object' ? response.data : {}
  }

  async function listFeeds(count = 10) {
    requireGate()
    const limit = Math.max(1, Math.min(20, Number(count) || Number(settings().maxFeeds) || 10))
    const data = await callQzone('get_qzone_feeds', {}, '读取好友动态')
    const rows = Array.isArray(data?.feeds) ? data.feeds : []
    const items = rows.map(normalizeFeed).filter(Boolean).slice(0, limit).map((item) => ({ ...item, cachedAt: Date.now() }))
    const state = loadState()
    state.feedCache = items.map(({ uin, tid, nickname, at, cachedAt }) => ({ uin, tid, nickname, at, cachedAt }))
    state.commentCache = {}
    saveState(state)
    return { ok: true, items, hasMore: Boolean(data?.has_more) }
  }
  function requireCachedFeed(uin, tid) {
    if (!validUin(uin) || !validTid(tid)) throw new Error('目标 QQ 号或动态 ID 无效，请从最近的动态列表中选择。')
    const feed = cachedFeed(loadState(), uin, tid)
    if (!feed) throw new Error('该动态不在最近一次列表里或缓存已过期；请先刷新好友动态，再操作。')
    return feed
  }
  async function listComments(uin, tid) {
    const feed = requireCachedFeed(uin, tid)
    requireGate()
    const data = await callQzone('get_qzone_msg_detail', { tid: feed.tid, target_uin: Number(feed.uin) }, '读取动态详情')
    const top = Array.isArray(data?.comments) ? data.comments : []
    // 上游把二级回复内联在每条评论的 replies 里；这里摊平成一维列表，
    // 回复带上 parentId —— 面板契约（qzone-comments 返回一维 comments 数组）保持不变。
    const rows = top.flatMap((row) => [row, ...(Array.isArray(row?.replies) ? row.replies : [])])
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
    requireGate()
    await selfUin()
    const kind = diary ? 'diary' : 'post'
    return performWrite(kind, '', async () => {
      const data = await callQzone('send_qzone_msg', {
        content,
        // 仅自己可见（64）：保持鱼世界原有的「只给自己看」语义 —— 铁律②外发默认最小暴露。
        ugc_right: 64,
      }, diary ? '发空间日记' : '发空间动态')
      const tid = String(data?.tid ?? '')
      if (!tid) throw new Error('协议端未返回动态 ID，无法确认发布成功；为避免重复已保留本次额度')
      return { ok: true, tid, kind, content: `已发布到 QQ 空间：${content.slice(0, 60)}${content.length > 60 ? '…' : ''}` }
    })
  }
  async function like({ uin, tid } = {}) {
    const feed = requireCachedFeed(uin, tid)
    requireGate()
    await selfUin()
    return performWrite('like', feedKey(feed.uin, feed.tid), async () => {
      // target_uin 是被点赞说说的主人（feeds 里的 uin），不是鱼自己。
      await callQzone('like_qzone', {
        tid: feed.tid,
        target_uin: Number(feed.uin),
        abstime: feed.at ? Math.floor(feed.at / 1000) : 0,
      }, '点赞')
      return { ok: true, content: `已给 ${feed.nickname} 的动态点赞。` }
    })
  }
  async function comment({ uin, tid, content } = {}) {
    const feed = requireCachedFeed(uin, tid)
    const text = cleanText(content, Math.max(1, Math.min(1000, Number(settings().maxCommentChars) || 200)))
    if (!text) throw new Error('评论不能为空')
    requireGate()
    await selfUin()
    return performWrite('comment', feedKey(feed.uin, feed.tid), async () => {
      // target_uin 是被评论说说的主人（feeds 里的 uin），不是鱼自己。
      const data = await callQzone('comment_qzone', {
        tid: feed.tid,
        content: text,
        target_uin: Number(feed.uin),
      }, '评论')
      return { ok: true, content: `已在 ${feed.nickname} 的动态下评论。`, commentId: String(data?.comment_id ?? '') }
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
    const chosen = cache.comments.find((item) => item.id === String(commentId) && item.uin === String(commentUin))
    if (!chosen) throw new Error('这条评论不在最近查看的评论清单中。')
    requireGate()
    await selfUin()
    const targetKey = `${feedKey(feed.uin, feed.tid)}:${chosen.id}:${chosen.uin}`
    return performWrite('reply', targetKey, async () => {
      // 楼中楼：comment_id / comment_uin 必须是「一级评论」。若选中的是一条二级回复
      //（有 parentId），就挂到它的根评论下，再用 reply_uin / reply_name 指向真正要回复的那个人。
      const root = chosen.parentId
        ? (cache.comments.find((item) => item.id === String(chosen.parentId) && !item.parentId) || chosen)
        : chosen
      const data = await callQzone('comment_qzone', {
        tid: feed.tid,
        content: text,
        // target_uin 仍是说说的主人；comment_id/comment_uin 是被回复的一级评论；
        // reply_uin/reply_name 让协议端拼出楼中楼的 @，这里不再手拼 @{uin:…} 串。
        target_uin: Number(feed.uin),
        comment_id: String(root.id),
        comment_uin: Number(root.uin),
        reply_uin: Number(chosen.uin),
        reply_name: cleanText(chosen.nickname, 48) || String(chosen.uin),
      }, '回复评论')
      return { ok: true, content: `已回复 ${chosen.nickname} 的评论。`, commentId: String(data?.comment_id ?? '') }
    })
  }

  return { status, diaryMaterial, claimDiaryReminder, listFeeds, listComments, post, like, comment, reply }
}

export const __test = { normalizeFeed, normalizeComment, validUin, validTid, dayKey }
