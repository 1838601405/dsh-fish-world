#!/usr/bin/env node
/**
 * tools/fish-snapshot.mjs
 * 蓝鲸娘侧 → 鱼的世界新版（`flutter/` 独立程序）的「鱼的世界」只读聚合（只含「鱼」+「鱼与 QQ」）。
 *
 * 契约见 docs/蓝鲸娘-Flutter-鱼的世界同步-20261107.md 第四节。
 *   · 纯 Node ESM：不依赖 Electron、不启动窗口、没有第三方依赖。
 *   · **只读**：只 readFileSync / readdirSync / statSync，绝不写 D:\DSH-home 与 D:\大肥鱼。
 *   · 平台**只做 QQ**：微信 / 抖音 / B 站的字段与数据不采集、不返回。
 *   · 单项读不到 ⇒ 给空值 + errors 里记一条，绝不整体抛错、绝不编造。
 *
 * 导出：
 *   buildFishSnapshot(opts)  → 整份「鱼的世界」快照
 *   buildFishQQ(opts)        → 只算「鱼与 QQ」那一段（给 GET /api/fish/qq 复用）
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 数据根（真源，2026-11-07 实测）：DSH 侧一个、工作区一个。 */
export const DSH_HOME_DEFAULT = 'D:\\DSH-home'
export const WORLD_ROOT_DEFAULT = 'D:\\大肥鱼\\鱼的世界'
export const DATA_ROOTS_DEFAULT = Object.freeze([
  join(DSH_HOME_DEFAULT, '鱼的世界'),
  WORLD_ROOT_DEFAULT,
])

/** 文本截断上限（契约第三节约定）。 */
const STATUS_TEXT_MAX = 8000
const DIARY_TEXT_MAX = 4000
const PERSONA_TEXT_MAX = 20000
const WISH_TEXT_MAX = 4000
const RECORD_TEXT_MAX = 2000
const MEMORY_TEXT_MAX = 2000
const QQ_LOG_TEXT_MAX = 500
const MEMORY_ITEMS_MAX = 200
const RECORD_ITEMS_MAX = 200
const QQ_LOG_MAX = 30
const ACTIVITY_LINES_PER_FILE_MAX = 20000
const ACTIVITY_FILES_MAX = 400
const MAX_ERRORS = 60

/** 成长阶段：与 E:\dsh_fish_world\lib\growth.mjs 的 STAGES 同源（照抄，别自造）。 */
const GROWTH_STAGES = Object.freeze([
  { id: 'fry', name: '幼鱼', min: 0, note: '刚开始记事，什么都很新鲜。' },
  { id: 'young', name: '小鱼', min: 3, note: '开始有自己的判断，但还容易改。' },
  { id: 'growing', name: '长身体的鱼', min: 8, note: '会拿旧事对照新事，知道自己在变。' },
  { id: 'deep', name: '深水的鱼', min: 18, note: '有稳定的看法，也知道哪里还不确定。' },
  { id: 'elder', name: '老鲸', min: 36, note: '记得很久以前的事，不急着下结论。' },
])

/**
 * QQ 平台开关的**展示字段**：从老版插件真源
 * E:\dsh_fish_world\ui\panel.js 的 PLATFORM_FIELDS.qq 逐项抄来（key/label/kind/hint/danger），
 * 与契约第四节（2026-11-07 更正版）一致，共 18 项；不含微信 / 抖音 / B 站任何一项。
 */
export const PLATFORM_QQ_FIELDS = Object.freeze([
  { key: 'enabled', label: '启用 QQ 能力', kind: 'bool', hint: '默认关闭，打开后鱼才会收发 QQ' },
  { key: 'readHistory', label: '读取聊天历史', kind: 'bool', hint: '只读最近的文字、图片与合并转发' },
  { key: 'superviseProtocol', label: '启动时自动拉起协议端', kind: 'bool', hint: '只在直连 SnowLuma 时生效：启动那一下探一次，没在跑就拉起来（不做周期轮询）' },
  { key: 'groupNotice', label: '收群公告', kind: 'bool', hint: '群里发公告时告诉你一句（默认关）' },
  { key: 'videoFrames', label: '视频抽帧看图', kind: 'bool', hint: '收到视频时抽 6 帧拼成一张图（要本机有 ffmpeg，默认关）' },
  { key: 'forwardExpand', label: '展开合并转发的聊天记录', kind: 'bool', hint: '收到聊天记录卡片时把卡片里全部内容摊开（默认开）' },
  { key: 'sendMessage', label: '发送消息', kind: 'bool', hint: '仍受 QQ 桥总开关、试运行与转私聊/转群限制', danger: true },
  { key: 'dailyMessages', label: '每日发送上限', kind: 'num', min: 0, max: 3000, unit: '条', hint: '0 = 不限' },
  { key: 'qzoneEnabled', label: '打理自己的 QQ 空间', kind: 'bool', hint: '只在主人的隔离会话中可写', danger: true },
  {
    key: 'qzoneDailyDiary',
    label: '每天写完日记就发一条空间',
    kind: 'bool',
    danger: true,
    hint: '打开后：当天本机写过日记就提醒她发一条空间日记，并顺便看看别人在她空间的赞与评论。默认关——这是会被真人看见的外发；点赞回评仍受空间额度限制。',
  },
  { key: 'batchEnabled', label: '等他说完再回', kind: 'bool', hint: '同一个人连发几条时合成一件事回，不逐条抢答' },
  { key: 'batchQuietSec', label: '安静多久算说完', kind: 'num', min: 1, max: 120, unit: '秒' },
  { key: 'batchUnfinishedExtraSec', label: '像没说完再多等', kind: 'num', min: 0, max: 120, unit: '秒' },
  { key: 'batchMaxWaitSec', label: '最久等多久先回', kind: 'num', min: 5, max: 600, unit: '秒' },
  { key: 'liveContextCount', label: '开口前摆几句现场', kind: 'num', min: 0, max: 60, unit: '条', hint: '别人的发言当背景，0 = 不摆' },
  { key: 'stickerSubType', label: '表情按哪种形式发', kind: 'num', min: 0, max: 1, hint: '1 = 小表情（可长按收藏），0 = 普通大图' },
  { key: 'autoPokeBack', label: '被戳一下自动戳回去', kind: 'bool', danger: true, hint: '默认关：这是会被真人看见的动作' },
  { key: 'pokeTalk', label: '被戳时说一句话', kind: 'bool', danger: true, hint: '默认关：把「有人戳你」投进会话，让她自己回一句，而不是只回戳' },
])


/** B 站平台开关的展示字段：从老版插件真源 ui/panel.js 的 PLATFORM_FIELDS.bili 逐项抄来（26 项）。 */
export const PLATFORM_BILI_FIELDS = Object.freeze([{"key":"enabled","label":"启用 B 站能力","kind":"bool","group":"监听","hint":"默认关闭，打开后鱼才会浏览 B 站、听评论与私信"},{"key":"watchEnabled","label":"浏览视频","kind":"bool","hint":"允许她去刷视频、看内容"},{"key":"listenComment","label":"听评论","kind":"bool","hint":"别人在她视频下评论时知道（写进 bili-whale 的 listen.comment）"},{"key":"listenCommentIntervalSec","label":"多久看一次评论","kind":"num","min":10,"max":3600,"unit":"秒"},{"key":"listenScope","label":"评论回到什么程度","kind":"select","options":[{"value":"reply","label":"只回提到她的"},{"value":"both","label":"也回评论里的其他人"}]},{"key":"listenOncePerPerson","label":"同一个人只回一次","kind":"bool","hint":"关掉后同一个人再说还会接话"},{"key":"listenAllDay","label":"全天都听","kind":"bool","hint":"关掉 = 只在她醒着的时段里听"},{"key":"listenDm","label":"听私信","kind":"bool"},{"key":"listenDmIntervalSec","label":"多久看一次私信","kind":"num","min":10,"max":3600,"unit":"秒"},{"key":"listenLive","label":"听直播","kind":"bool","hint":"进直播间听弹幕；直播间号码在 bili-whale 自己的设置页填"},{"key":"shareEnabled","label":"分享值得的视频给主人","kind":"bool","danger":true,"group":"分享","hint":"外发：会拿她的号去评论 / 私信。整个平台没启用时仍会被闸门拦住"},{"key":"shareVia","label":"分享用什么方式","kind":"select","options":[{"value":"comment","label":"发评论 @ 主人"},{"value":"dm","label":"私信主人"}]},{"key":"shareMinScore","label":"至少多少分才分享","kind":"num","min":0,"max":100,"unit":"分","hint":"低于这个分数就当「今天没有值得发的」"},{"key":"shareAiCommentGuard","label":"评论区像 AI 就别发","kind":"bool","hint":"评论区 AI 味太重时放弃这条，不硬发"},{"key":"shareDaily","label":"每天最多分享","kind":"num","min":0,"max":20,"unit":"条"},{"key":"riskReadDaily","label":"每天读的上限","kind":"num","min":0,"max":30000,"unit":"次","group":"风控配额","hint":"读得太快容易被风控，这是硬上限"},{"key":"riskWriteDaily","label":"每天写的上限","kind":"num","min":0,"max":300,"unit":"次","hint":"评论 / 私信 / 点赞这类写操作的总量"},{"key":"riskMinGapMs","label":"两次写之间至少隔","kind":"num","min":100,"max":60000,"unit":"毫秒"},{"key":"nightMaxVideos","label":"一次醒来最多看","kind":"num","min":1,"max":20,"unit":"个","group":"作息","hint":"多久醒、每天最多醒几次在 bili-whale 的作息窗口里，不在这页"},{"key":"nightSkipChance","label":"这次醒来跳过的概率","kind":"num","min":0,"max":1,"step":0.05,"hint":"0 = 每次都看，1 = 每次都跳过"},{"key":"nightMinGapMin","label":"两次醒来至少隔","kind":"num","min":0,"max":240,"unit":"分钟"},{"key":"personaName","label":"角色名","kind":"text","group":"人设","hint":"写给模型看的「你是谁」；留空 = 用 bili-whale 自己的默认"},{"key":"personaOwnerTitle","label":"怎么称呼主人","kind":"text","hint":"例如「主人」「你」"},{"key":"personaSelfClaim","label":"怎么自称","kind":"text","hint":"例如「我」「本鱼」"},{"key":"ownerMid","label":"主人的 B 站 UID","kind":"text","group":"主人","hint":"分享时 @ 的人（数字 UID）；只用于白名单查询"},{"key":"ownerName","label":"主人的 B 站昵称","kind":"text","hint":"正文里 @ 的名字；改过昵称要跟着改"}])

/** QQ 留存的 kind → 中文动作名（与 E:\dsh_fish_world\lib\activity.mjs 的 ACTIVITY_KINDS 同源）。 */
const ACTIVITY_KIND_LABELS = Object.freeze({
  watch: '浏览',
  read: '阅读',
  like: '点赞',
  favorite: '收藏',
  comment: '评论',
  reply: '回复',
  post: '发布',
  send: '发送',
  receive: '收到',
  search: '搜索',
  notice: '通知',
  other: '其它',
})

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/i
const DAY_MD_FILE_RE = /^记忆摘要-(\d{4}-\d{2}-\d{2})\.json$/i

/* ── 小工具（全部只读、全部带兜底） ─────────────────────────────── */

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function safeStat(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

function clampText(value, max) {
  return String(value == null ? '' : value).slice(0, Math.max(0, max))
}

function cleanOneLine(value, max) {
  return clampText(String(value == null ? '' : value).replace(/\s+/g, ' ').trim(), max)
}

/** 北京时间（+8）日期键：与鱼世界的「按天」口径一致，避免跨零点把一天劈两半。 */
export function dayKeyShanghai(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function makeCtx(opts = {}) {
  const dshHome = typeof opts.dshHome === 'string' && opts.dshHome ? opts.dshHome : DSH_HOME_DEFAULT
  const worldRoot = typeof opts.worldRoot === 'string' && opts.worldRoot ? opts.worldRoot : WORLD_ROOT_DEFAULT
  const roots = Array.isArray(opts.roots) && opts.roots.length
    ? opts.roots.filter((r) => typeof r === 'string' && r)
    : [join(dshHome, '鱼的世界'), worldRoot]
  const now = opts.now ? new Date(opts.now) : new Date()
  return { dshHome, worldRoot, roots, now, errors: [] }
}

function pushError(ctx, section, message) {
  if (ctx.errors.length >= MAX_ERRORS) return
  ctx.errors.push({ section: String(section || 'unknown'), message: String(message == null ? '' : message) })
}

function readJson(file, ctx, section) {
  const text = readTextSafe(file)
  if (text == null) {
    pushError(ctx, section, '读不到文件：' + file)
    return null
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    pushError(ctx, section, 'JSON 解析失败：' + ((e && e.message) || e) + '（' + file + '）')
    return null
  }
}

function readJsonl(file, ctx, section) {
  const text = readTextSafe(file)
  if (text == null) {
    pushError(ctx, section, '读不到文件：' + file)
    return []
  }
  const out = []
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const row = JSON.parse(s)
      if (row && typeof row === 'object' && !Array.isArray(row)) out.push(row)
    } catch {
      bad += 1
    }
  }
  if (bad) pushError(ctx, section, bad + ' 行 JSON 解析失败：' + file)
  return out
}

/** 在多个根里挑「最像有货」的目录（条目最多的那个）；都没有返回 null。 */
function pickDir(candidates, match) {
  let best = null
  let bestCount = -1
  for (const dir of candidates) {
    if (!dir || !existsSync(dir)) continue
    let count = 0
    for (const ent of safeReaddir(dir)) if (ent.isFile() && match(ent.name)) count += 1
    if (count > bestCount) {
      best = dir
      bestCount = count
    }
  }
  return best
}

/** 在多个根里挑体积最大的文件；都没有返回 null。 */
function pickLargestFile(candidates) {
  let best = null
  let bestSize = -1
  for (const file of candidates) {
    const st = safeStat(file)
    if (!st || !st.isFile()) continue
    if (st.size > bestSize) {
      best = file
      bestSize = st.size
    }
  }
  return best
}

function relRootCandidates(ctx, rel) {
  return ctx.roots.map((root) => join(root, rel))
}

function personaDir(ctx) {
  return join(ctx.dshHome, 'fish-world-personas')
}

/* ── 知识库：17MB，只统计，不回传全文（按 mtime+size 缓存统计结果） ── */

const knowledgeStatsCache = new Map()

function readKnowledgeStats(file, ctx) {
  const st = safeStat(file)
  if (!st) {
    pushError(ctx, 'memory.knowledge', '知识库文件读不到：' + file)
    return { entries: 0, chars: 0, updatedAt: '', file }
  }
  const cacheKey = file + '|' + st.size + '|' + st.mtimeMs
  const hit = knowledgeStatsCache.get(cacheKey)
  if (hit) return { ...hit }
  const text = readTextSafe(file)
  if (text == null) {
    pushError(ctx, 'memory.knowledge', '知识库读取失败：' + file)
    return { entries: 0, chars: 0, updatedAt: '', file }
  }
  let raw = null
  try {
    raw = JSON.parse(text)
  } catch (e) {
    pushError(ctx, 'memory.knowledge', '知识库解析失败：' + ((e && e.message) || e))
    return { entries: 0, chars: 0, updatedAt: '', file }
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : []
  let chars = 0
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    chars += String(item.name || '').length
      + String(item.meaning || '').length
      + String(item.usage || '').length
      + String(item.avoid || '').length
  }
  const stats = {
    entries: items.length,
    chars,
    updatedAt: String((raw && raw.exportedAt) || new Date(st.mtimeMs).toISOString()),
    file,
  }
  knowledgeStatsCache.set(cacheKey, stats)
  return { ...stats }
}

/* ── 鱼的日记（正文 + 批语） ────────────────────────────────────── */

function collectDiary(ctx) {
  /** @type {Map<string, object[]>} diaryId → comments */
  const commentsByDiary = new Map()
  for (const root of ctx.roots) {
    const dir = join(root, '鱼的日记', '批语')
    if (!existsSync(dir)) continue
    for (const ent of safeReaddir(dir)) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.jsonl')) continue
      const rows = readJsonl(join(dir, ent.name), ctx, 'diary.comments')
      for (const row of rows) {
        const diaryId = String(row.diaryId || '')
        if (!diaryId) continue
        if (!commentsByDiary.has(diaryId)) commentsByDiary.set(diaryId, [])
        commentsByDiary.get(diaryId).push({
          id: String(row.id || ''),
          at: String(row.at || ''),
          text: clampText(row.text, DIARY_TEXT_MAX),
          who: String(row.actorName || ''),
          quote: String(row.quote || ''),
        })
      }
    }
  }

  const items = []
  const seen = new Set()
  for (const root of ctx.roots) {
    const dir = join(root, '鱼的日记')
    if (!existsSync(dir)) continue
    for (const ent of safeReaddir(dir)) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.jsonl')) continue
      const dayFromFile = DAY_FILE_RE.test(ent.name) ? ent.name.slice(0, 10) : ''
      const rows = readJsonl(join(dir, ent.name), ctx, 'diary')
      for (const row of rows) {
        const id = String(row.id || '')
        if (id && seen.has(id)) continue
        const text = String(row.text == null ? '' : row.text)
        if (!text.trim()) continue // 空正文不进列表（面板同样不显示）
        if (id) seen.add(id)
        const at = String(row.at || '')
        const comments = commentsByDiary.get(id) || []
        comments.sort((a, b) => String(a.at).localeCompare(String(b.at)))
        items.push({
          id,
          date: dayFromFile || at.slice(0, 10),
          at,
          who: String(row.actorName || ''),
          status: String(row.status || ''),
          text: clampText(text, DIARY_TEXT_MAX),
          comments,
        })
      }
    }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const today = dayKeyShanghai(ctx.now)
  return {
    total: items.length,
    pending: items.filter((it) => it.status === 'pending').length,
    today: items.filter((it) => it.date === today).length,
    items,
  }
}

/* ── 鱼的请求（愿望 + 想收藏） ──────────────────────────────────── */

function collectWishes(ctx) {
  const items = []
  const seen = new Set()
  for (const root of ctx.roots) {
    const dir = join(root, '鱼的请求')
    if (!existsSync(dir)) continue
    for (const ent of safeReaddir(dir)) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.jsonl')) continue
      const dayFromFile = DAY_FILE_RE.test(ent.name) ? ent.name.slice(0, 10) : ''
      const rows = readJsonl(join(dir, ent.name), ctx, 'wishes')
      for (const row of rows) {
        const id = String(row.id || '')
        if (id && seen.has(id)) continue
        const text = String(row.text == null ? '' : row.text)
        if (!text.trim()) continue
        if (id) seen.add(id)
        items.push({
          id,
          day: String(row.day || dayFromFile || String(row.at || '').slice(0, 10)),
          at: String(row.at || ''),
          kind: String(row.kind || 'wish'),
          urgency: String(row.urgency || 'normal'),
          status: String(row.status || ''),
          text: clampText(text, WISH_TEXT_MAX),
          reply: clampText(row.reply, 300),
        })
      }
    }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)))

  const stickerNames = new Set()
  for (const root of ctx.roots) {
    const dir = join(root, '鱼的请求', '想收藏')
    if (!existsSync(dir)) continue
    for (const ent of safeReaddir(dir)) {
      if (ent.isFile()) stickerNames.add(ent.name)
      else if (ent.isDirectory()) stickerNames.add(ent.name)
    }
  }
  // 鱼的声音：请求记录里没有「鱼自己的回应」字段，不拿主人的 reply 冒充；
  // 退回 mood state 的 lastReason 首句，原文直出，不改写。
  let voice = ''
  try {
    const moodFile = pickLargestFile(relRootCandidates(ctx, '鱼的状态\\心理\\state.json'))
    if (moodFile) {
      const raw = readJson(moodFile, ctx, 'wishes.voice')
      const moods = raw && raw.moods && typeof raw.moods === 'object' ? raw.moods : {}
      let best = null
      for (const value of Object.values(moods)) {
        if (!value || typeof value !== 'object') continue
        const reason = String(value.lastReason || '').trim()
        if (!reason) continue
        if (!best || Number(value.updatedAt) > Number(best.updatedAt)) best = value
      }
      if (best) {
        const reason = String(best.lastReason || '').trim()
        const m = reason.match(/^.*?[。！？]/)
        voice = (m ? m[0] : reason).trim()
      }
    }
  } catch {}
  return {
    pending: items.filter((it) => it.status === 'pending').length,
    total: items.length,
    items,
    stickers: [...stickerNames].sort().map((name) => ({ name })),
    voice,
  }
}

/* ── 鱼的成长（ledger） ────────────────────────────────────────── */

function stageForCount(count) {
  let current = GROWTH_STAGES[0]
  for (const stage of GROWTH_STAGES) if (count >= stage.min) current = stage
  const next = GROWTH_STAGES.find((s) => s.min > count) || null
  return {
    id: current.id,
    name: current.name,
    desc: current.note,
    min: current.min,
    next: next ? { id: next.id, name: next.name, min: next.min } : null,
    toNext: next ? next.min - count : 0,
    progress: next ? Math.min(1, (count - current.min) / Math.max(1, next.min - current.min)) : 1,
  }
}


function collectWorldActivity(ctx) {
  const rows = []
  const seen = new Set()
  const platforms = ['QQ', 'B站', '抖音', '应用']
  for (const root of ctx.roots) {
    for (const name of platforms) {
      const dir = join(root, '鱼与世界', name)
      if (!existsSync(dir)) continue
      for (const ent of safeReaddir(dir)) {
        if (!ent.isFile() || !DAY_FILE_RE.test(ent.name)) continue
        for (const row of readJsonl(join(dir, ent.name), ctx, 'world.activity')) {
          if (!row || !row.at) continue
          const key = String(row.at) + '|' + String(row.kind || '') + '|' + String(row.text || '')
          if (seen.has(key)) continue
          seen.add(key)
          rows.push({
            at: String(row.at),
            day: String(row.at).slice(0, 10),
            platform: name,
            kind: String(row.kind || 'other'),
            actor: row.actor === 'owner' ? 'owner' : row.actor === 'other' ? 'other' : 'fish',
            text: clampText(row.text, 200),
          })
        }
      }
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const perDay = {}
  for (const r of rows) {
    const d = perDay[r.day] || { day: r.day, total: 0, owner: 0, fish: 0, kinds: {} }
    d.total++
    if (r.actor === 'owner') d.owner++
    if (r.actor === 'fish') d.fish++
    d.kinds[r.kind] = (d.kinds[r.kind] || 0) + 1
    perDay[r.day] = d
  }
  const days = Object.values(perDay).sort((a, b) => a.day.localeCompare(b.day))
  // 今日按小时分布（面板「今日动态」24 格用），只覆盖保留期内的记录。
  const today = dayKeyShanghai()
  const todayHours = new Array(24).fill(0)
  for (const r of rows) {
    if (r.day !== today) continue
    const h = Number(String(r.at).slice(11, 13))
    if (Number.isInteger(h) && h >= 0 && h < 24) todayHours[h] += 1
  }
  return { total: rows.length, days: days.length, first: days[0] || null, perDay: days, recent: rows.slice(0, 60), today, todayHours }
}


/* ── 心情（feiyu-mood state.json，只读裁剪） ───────────────────── */
const MOOD_DIMS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']

function collectMood(ctx) {
  const empty = { value: null, dims: {}, reason: '', updatedAt: 0, timeline: [], events: [] }
  try {
    const file = pickLargestFile(relRootCandidates(ctx, '鱼的状态\\心理\\state.json'))
    if (!file) return empty
    const raw = readJson(file, ctx, 'mood')
    const moods = raw && raw.moods && typeof raw.moods === 'object' ? raw.moods : {}
    // 优先有分维数据、时间线最长的那条；避免挑到全零的衰减记录。
    let best = null
    let bestScore = -1
    for (const v of Object.values(moods)) {
      if (!v || typeof v !== 'object') continue
      const dsum = MOOD_DIMS.reduce((sum, k) => sum + (Number(v.dims && v.dims[k]) || 0), 0)
      const len = Array.isArray(v.timeline) ? v.timeline.length : 0
      const score = dsum > 0 ? 100000 + len : len + (String(v.lastReason || '').trim() ? 1000 : 0)
      if (score > bestScore) { bestScore = score; best = v }
    }
    if (!best) return empty
    const dims = {}
    for (const k of MOOD_DIMS) dims[k] = Number(best.dims && best.dims[k]) || 0
    const tl = Array.isArray(best.timeline) ? best.timeline : []
    const timeline = tl.slice(-24).map((e) => ({
      at: Number(e && e.at) || 0,
      mood: Number(e && e.mood) || 0,
      delta: Number(e && e.delta) || 0,
    }))
    const events = tl.slice(-3).reverse().map((e) => ({
      at: Number(e && e.at) || 0,
      delta: Number(e && e.delta) || 0,
      reason: clampText(String((e && e.reason) || ''), 160),
    }))
    const reason = String(best.lastReason || '').trim()
    const first = (reason.match(/^.*?[。！？]/) || [reason])[0].trim()
    return {
      value: Number.isFinite(Number(best.mood)) ? Number(best.mood) : null,
      dims,
      reason: first,
      updatedAt: Number(best.updatedAt) || 0,
      timeline,
      events,
    }
  } catch {
    return empty
  }
}

function collectGrowth(ctx) {
  const items = []
  const seen = new Set()
  for (const root of ctx.roots) {
    const file = join(root, '鱼的成长', 'ledger.jsonl')
    if (!existsSync(file)) continue
    for (const row of readJsonl(file, ctx, 'growth')) {
      if (!row || row.type !== 'entry') continue
      if (row.status === 'retracted') continue
      const id = String(row.id || '')
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      const text = String(row.text == null ? '' : row.text)
      if (!text.trim()) continue
      items.push({
        id,
        day: String(row.day || String(row.at || '').slice(0, 10)),
        at: String(row.at || ''),
        kind: String(row.kind || ''),
        text: clampText(text, MEMORY_TEXT_MAX),
        quote: clampText(row.quote, MEMORY_TEXT_MAX),
        source: row.source && typeof row.source === 'object'
          ? { type: String(row.source.type || ''), id: String(row.source.id || '') }
          : null,
        revision: Number.isFinite(Number(row.revision)) ? Number(row.revision) : 1,
        status: String(row.status || 'active'),
      })
    }
  }
  items.sort((a, b) => String(b.at || b.day).localeCompare(String(a.at || a.day)))
  const days = [...new Set(items.map((e) => e.day))].sort()
  const today = dayKeyShanghai(ctx.now)
  return {
    stage: stageForCount(items.length),
    stages: GROWTH_STAGES,
    total: items.length,
    items,
    days: days.length,
    firstDay: days[0] || '',
    lastDay: days[days.length - 1] || '',
    todayCount: items.filter((e) => e.day === today).length,
    dailyLimit: 2,
    byKind: {
      insight: items.filter((e) => e.kind === 'insight').length,
      next: items.filter((e) => e.kind === 'next').length,
      milestone: items.filter((e) => e.kind === 'milestone').length,
    },
  }
}

/* ── 鱼的记忆（知识库 / 人设 / 记忆条目 / 记录 / 图库 / 链接 / 摘要） ── */

function collectPersonas(ctx) {
  const dir = personaDir(ctx)
  const rolesFile = join(ctx.dshHome, 'fish-world-roles', 'roles.json')
  const rolesRaw = existsSync(rolesFile) ? readJson(rolesFile, ctx, 'profile.roles') : null
  const roleList = Array.isArray(rolesRaw && rolesRaw.roles) ? rolesRaw.roles : []
  const roleNames = new Map()
  for (const role of roleList) if (role && role.id) roleNames.set(String(role.id), String(role.name || ''))

  const files = []
  for (const ent of safeReaddir(dir)) {
    if (!ent.isFile()) continue
    if (!ent.name.toLowerCase().endsWith('.md')) continue
    if (ent.name.includes('.bak')) continue
    files.push(ent.name)
  }
  files.sort((a, b) => (a === 'default.md' ? -1 : b === 'default.md' ? 1 : a.localeCompare(b)))

  const personas = []
  for (const name of files) {
    const id = basename(name, '.md')
    const text = readTextSafe(join(dir, name))
    if (text == null) {
      pushError(ctx, 'memory.personas', '人设卡读不到：' + join(dir, name))
      continue
    }
    personas.push({
      id,
      name: roleNames.get(id) || (id === 'default' ? '默认' : id),
      preview: cleanOneLine(text, 200),
      length: text.length,
      file: name,
    })
  }
  const active = String((rolesRaw && rolesRaw.current) || '').trim() || 'default'
  return { personas, active, roleNames, roles: roleList }
}

function collectMemories(ctx) {
  const dirs = []
  for (const d of [join(ctx.dshHome, 'fish-memory'), ...ctx.roots.map((root) => join(root, '鱼的记忆'))]) {
    // DSH-home/fish-memory 常是指向工作区的 junction，别把同一份 traces 数两遍。
    try {
      const real = realpathSync(d)
      if (dirs.some((x) => x.real === real)) continue
      dirs.push({ dir: d, real })
    } catch {
      if (existsSync(d)) dirs.push({ dir: d, real: d })
    }
  }

  const byKey = new Map()
  const deleted = new Set()
  // traces 才是「被想起」的真实记录：picked 里出现过的 id，记它的最晚时间。
  const recall = new Map()
  let tracesScanned = 0
  for (const entry of dirs) {
    const dir = entry.dir
    if (!existsSync(dir)) continue
    for (const ent of safeReaddir(dir)) {
      if (!ent.isFile()) continue
      if (!ent.name.toLowerCase().endsWith('.json')) continue
      if (ent.name.includes('.bak')) continue
      const data = readJson(join(dir, ent.name), ctx, 'memory.memories')
      if (!data || typeof data !== 'object') continue
      if (Array.isArray(data.deleted)) for (const id of data.deleted) deleted.add(String(id))
      for (const t of Array.isArray(data.traces) ? data.traces : []) {
        tracesScanned++
        const atMs = Number(t && t.at) || 0
        if (!atMs || !Array.isArray(t.picked)) continue // picked 为空 = 这次检索没命中，不算想起
        for (const pid of t.picked) {
          const id = String(pid || '')
          if (!id) continue
          if (!recall.has(id) || atMs > recall.get(id)) recall.set(id, atMs)
        }
      }
      const list = Array.isArray(data.memories) ? data.memories : []
      for (const row of list) {
        if (!row || typeof row !== 'object') continue
        const text = String(row.text == null ? '' : row.text)
        if (!text.trim()) continue
        const id = String(row.id || '')
        if (id && deleted.has(id)) continue
        const key = id || 'text:' + text
        const at = String(row.at || row.createdAt || '')
        const prev = byKey.get(key)
        // 同一 id 在多个会话文件出现时，取更晚的那份（reinforcedAt 也算更新时间）
        const stamp = String(row.reinforcedAt || at)
        const prevStamp = prev ? String(prev._stamp || '') : ''
        if (prev && prevStamp && stamp && stamp <= prevStamp) continue
        byKey.set(key, {
          id,
          text: clampText(text, MEMORY_TEXT_MAX),
          at,
          category: String(row.category || ''),
          tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [],
          kind: String(row.kind || ''),
          source: row.source || '',
          importance: Number(row.importance) || 0,
          pinned: row.pinned === true,
          hits: Number(row.hits) || 0,
          lastUsedAt: String(row.lastUsedAt || ''),
          lastConfirmedAt: String(row.lastConfirmedAt || ''),
          status: String(row.status || ''),
          domain: String(row.domain || 'memory'),
          _stamp: stamp,
        })
      }
    }
  }
  const items = [...byKey.values()]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .map(({ _stamp, ...rest }) => {
      const atMs = rest.id ? recall.get(rest.id) : 0
      const fromTrace = atMs ? new Date(atMs).toISOString() : ''
      const lastUsedAt = String(rest.lastUsedAt || '') || fromTrace
      return { ...rest, lastUsedAt, neverRecalled: !lastUsedAt }
    })
  return { total: items.length, items: items.slice(0, MEMORY_ITEMS_MAX), tracesScanned }
}

function collectRecords(ctx) {
  const items = []
  const seen = new Set()
  for (const root of ctx.roots) {
    const file = join(root, '鱼的记录', '记录.jsonl')
    if (!existsSync(file)) continue
    for (const row of readJsonl(file, ctx, 'memory.records')) {
      const id = String(row.id || '')
      if (id && seen.has(id)) continue
      if (row.status === 'retracted') continue
      const text = String(row.text == null ? '' : row.text)
      if (!text.trim()) continue
      if (id) seen.add(id)
      items.push({
        id,
        day: String(row.day || String(row.at || '').slice(0, 10)),
        at: String(row.at || ''),
        text: clampText(text, RECORD_TEXT_MAX),
      })
    }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return items.slice(0, RECORD_ITEMS_MAX)
}

function collectGallery(ctx) {
  const dir = pickDir(relRootCandidates(ctx, '鱼之宝库\\图库'), (name) => IMG_RE.test(name))
  if (!dir) return { total: 0, items: [] }
  const names = []
  for (const ent of safeReaddir(dir)) if (ent.isFile() && IMG_RE.test(ent.name)) names.push(ent.name)
  names.sort((a, b) => a.localeCompare(b))
  // 标签/名字/使用次数都在图库自己的 stickers.json 索引里；只读，不改它。
  let index = []
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'stickers.json'), 'utf8'))
    index = Array.isArray(raw?.stickers) ? raw.stickers : []
  } catch {}
  const byKey = new Map()
  for (const item of index) {
    if (!item || typeof item !== 'object') continue
    if (item.file) byKey.set(String(item.file), item)
    if (item.name) byKey.set(String(item.name), item)
  }
  const items = names.map((name) => {
    const base = name.replace(/\.[^.]+$/, '')
    const meta = byKey.get(base) || byKey.get(name) || null
    const tags = Array.isArray(meta?.tags) ? meta.tags.map((t) => String(t)).filter(Boolean) : []
    const note = String(meta?.note || '')
    return {
      name,
      id: String(meta?.id || ''),
      displayName: String(meta?.name || base),
      tags,
      addedAt: Number(meta?.addedAt) || 0,
      useCount: Number(meta?.useCount) || 0,
      // 视觉整理器留下的说明以「画面：」开头；这类图还没人工校对。
      auto: note.startsWith('画面：') || tags.includes('静图') || tags.includes('动图'),
    }
  })
  return { total: names.length, items }
}

function collectLinks(ctx) {
  const file = pickLargestFile(relRootCandidates(ctx, '鱼之宝库\\网站链接\\links.json'))
  if (!file) return { total: 0, items: [] }
  const raw = readJson(file, ctx, 'memory.links')
  const list = Array.isArray(raw && raw.links) ? raw.links : Array.isArray(raw) ? raw : []
  const items = []
  for (const link of list) {
    if (!link || typeof link !== 'object') continue
    const url = String(link.url || '')
    if (!url.trim()) continue
    items.push({
      name: String(link.title || link.host || url),
      url,
      note: clampText(link.note, 300),
      kind: String(link.kind || ''),
      at: String(link.at || ''),
    })
  }
  return { total: items.length, items }
}

/* ── 鱼的状态（最新记忆摘要 + 历史按天计数） ───────────────────── */

function collectStatus(ctx) {
  /** @type {Map<string, {file: string, mtimeMs: number}>} */
  const byDay = new Map()
  for (const root of ctx.roots) {
    const dir = join(root, '鱼的状态')
    if (!existsSync(dir)) continue
    for (const ent of safeReaddir(dir)) {
      if (!ent.isFile()) continue
      const m = DAY_MD_FILE_RE.exec(ent.name)
      if (!m) continue
      const day = m[1]
      const file = join(dir, ent.name)
      const st = safeStat(file)
      if (!st) continue
      const prev = byDay.get(day)
      if (!prev || st.mtimeMs > prev.mtimeMs) byDay.set(day, { file, mtimeMs: st.mtimeMs })
    }
  }
  const days = [...byDay.keys()].sort().reverse()
  const history = []
  const parsed = new Map()
  for (const day of days) {
    const data = readJson(byDay.get(day).file, ctx, 'status')
    if (!data || typeof data !== 'object') continue
    parsed.set(day, data)
    history.push({
      day,
      count: Number(data.count) || 0,
    })
  }
  const latestDay = history.length ? history[0].day : ''
  const latest = latestDay ? parsed.get(latestDay) : null
  return {
    day: latestDay,
    at: String((latest && latest.at) || ''),
    count: Number((latest && latest.count) || 0),
    chars: Number((latest && latest.chars) || 0),
    text: clampText(latest && latest.text, STATUS_TEXT_MAX),
    history,
    digest: {
      day: latestDay,
      count: Number((latest && latest.count) || 0),
      chars: Number((latest && latest.chars) || 0),
    },
  }
}

/* ── 鱼的设定（人设 + 主人 + 存储位置） ────────────────────────── */

function collectProfile(ctx, personas) {
  const configFile = join(ctx.dshHome, 'fish-world-config.json')
  const config = existsSync(configFile) ? readJson(configFile, ctx, 'profile.config') : null
  const fishCfg = (config && config.fish) || {}

  const active = personas.active
  const dir = personaDir(ctx)
  const candidates = [join(dir, active + '.md'), join(dir, 'default.md')]
  let personaPath = ''
  for (const candidate of candidates) if (existsSync(candidate)) { personaPath = candidate; break }
  let personaText = ''
  let personaLength = 0
  if (personaPath) {
    const text = readTextSafe(personaPath)
    if (text == null) pushError(ctx, 'profile.personaText', '人设卡读不到：' + personaPath)
    else {
      personaLength = text.length
      personaText = clampText(text, PERSONA_TEXT_MAX)
    }
  } else {
    pushError(ctx, 'profile.personaText', '没有找到人设卡：' + dir)
  }

  const roleAvatar = (id) => {
    const key = String(id || 'default')
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      if (existsSync(join(ctx.dshHome, 'fish-world-roles', key + '.' + ext))) {
        return '/dsh-fish-world/role-image?id=' + encodeURIComponent(key)
      }
    }
    return ''
  }
  const roles = personas.roles.length
    ? personas.roles.map((role) => {
      const id = String(role.id || '')
      const persona = personas.personas.find((p) => p.id === id)
      const avatar = roleAvatar(id)
      return {
        id,
        name: String(role.name || (persona && persona.name) || id),
        preview: persona ? persona.preview : '',
        length: persona ? persona.length : 0,
        avatar,
        hasImage: Boolean(avatar),
      }
    })
    : personas.personas.map((p) => {
      const avatar = roleAvatar(p.id)
      return { id: p.id, name: p.name, preview: p.preview, length: p.length, avatar, hasImage: Boolean(avatar) }
    })

  const storage = []
  const storageCandidates = [
    ['鱼的设定', join(ctx.dshHome, 'fish-world-personas')],
    ['鱼的日记', join(ctx.worldRoot, '鱼的日记')],
    ['鱼的请求', join(ctx.worldRoot, '鱼的请求')],
    ['鱼的成长', join(ctx.worldRoot, '鱼的成长')],
    ['鱼的记忆', join(ctx.roots[0], '鱼的记忆')],
    ['鱼的状态', join(ctx.worldRoot, '鱼的状态')],
    ['鱼的记录', join(ctx.worldRoot, '鱼的记录')],
    ['鱼之宝库', join(ctx.worldRoot, '鱼之宝库')],
    ['鱼与世界', join(ctx.worldRoot, '鱼与世界')],
  ]
  for (const [label, path] of storageCandidates) {
    if (existsSync(path)) storage.push({ label, path })
  }
  // 工作区根可能和默认不一样：成长 / 记忆按实际存在的根补齐
  if (!storage.some((s) => s.label === '鱼的成长')) {
    for (const root of ctx.roots) {
      const path = join(root, '鱼的成长')
      if (existsSync(path)) { storage.push({ label: '鱼的成长', path }); break }
    }
  }
  if (!storage.some((s) => s.label === '鱼的记忆')) {
    for (const root of ctx.roots) {
      const path = join(root, '鱼的记忆')
      if (existsSync(path)) { storage.push({ label: '鱼的记忆', path }); break }
    }
  }

  return {
    name: String(fishCfg.name || '大肥鱼'),
    ownerTitle: String(fishCfg.ownerTitle || '主人'),
    personaFile: personaPath ? basename(personaPath) : '',
    personaText,
    personaLength,
    active: String(personas.active || ''),
    roles,
    storage,
  }
}

/* ── 鱼与 QQ（唯一保留的平台） ────────────────────────────────── */

function detectQQInstalled(ctx) {
  const candidates = [
    join(ctx.dshHome, 'node_modules', 'dsh-qq-bridge'),
    locateQQBridgeInProfiles(ctx.dshHome),
  ]
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return true
  }
  return false
}

function locateQQBridgeInProfiles(dshHome) {
  const profilesDir = join(dshHome, 'profiles')
  for (const ent of safeReaddir(profilesDir)) {
    if (!ent.isDirectory()) continue
    const dir = join(profilesDir, ent.name, 'node_modules', 'dsh-qq-bridge')
    if (existsSync(dir)) return dir
  }
  return ''
}

function qqPlatformFields(qqCfg) {
  return PLATFORM_QQ_FIELDS.map((field) => {
    const has = qqCfg && Object.prototype.hasOwnProperty.call(qqCfg, field.key)
    const out = {
      key: field.key,
      label: field.label,
      kind: field.kind,
      value: has ? qqCfg[field.key] : null,
      hint: field.hint || '',
      danger: field.danger === true,
    }
    if (field.unit) out.unit = field.unit
    if (Number.isFinite(field.min)) out.min = field.min
    if (Number.isFinite(field.max)) out.max = field.max
    return out
  })
}

function biliPlatformFields(biliCfg) {
  return PLATFORM_BILI_FIELDS.map((field) => {
    const has = biliCfg && Object.prototype.hasOwnProperty.call(biliCfg, field.key)
    const out = {
      key: field.key,
      label: field.label,
      kind: field.kind,
      value: has ? biliCfg[field.key] : null,
      hint: field.hint || '',
      danger: field.danger === true,
    }
    if (field.unit) out.unit = field.unit
    if (Number.isFinite(field.min)) out.min = field.min
    if (Number.isFinite(field.max)) out.max = field.max
    if (Number.isFinite(field.step)) out.step = field.step
    if (field.group) out.group = field.group
    if (Array.isArray(field.options)) out.options = field.options.map((o) => ({ value: String(o.value), label: String(o.label) }))
    return out
  })
}

function countEnabledFields(fields) {
  let n = 0
  for (const field of fields) {
    if (field.kind === 'bool' && field.value === true) n += 1
    else if (field.kind === 'num' && Number(field.value) > 0) n += 1
    else if (field.kind === 'text' && String(field.value || '').trim()) n += 1
  }
  return n
}

function readQQActivity(ctx) {
  const dir = pickDir(relRootCandidates(ctx, '鱼与世界\\QQ'), (name) => DAY_FILE_RE.test(name))
  if (!dir) return { activity: { day: '', days: 0, total: 0, byType: {}, capped: false }, log: [], today: { receive: 0, send: 0, groups: 0 } }
  const files = []
  for (const ent of safeReaddir(dir)) if (ent.isFile() && DAY_FILE_RE.test(ent.name)) files.push(ent.name)
  files.sort()

  let total = 0
  let capped = false
  const byKind = {}
  const byType = {}
  let latestRows = []
  const scan = files.slice(-ACTIVITY_FILES_MAX)
  for (const name of scan) {
    const rows = readJsonl(join(dir, name), ctx, 'qq.activity')
    total += rows.length
    // 单个文件过大时只扫描前 N 行来分类型（总量仍按真实行数），并在 capped 里说明
    if (rows.length > ACTIVITY_LINES_PER_FILE_MAX) capped = true
    for (const row of rows.slice(0, ACTIVITY_LINES_PER_FILE_MAX)) {
      const kind = String((row && row.kind) || 'other')
      byKind[kind] = (byKind[kind] || 0) + 1
    }
    if (name === scan[scan.length - 1]) latestRows = rows
  }
  for (const [kind, count] of Object.entries(byKind)) {
    const label = ACTIVITY_KIND_LABELS[kind] || kind
    byType[label] = (byType[label] || 0) + count
  }
  const log = latestRows
    .slice(-QQ_LOG_MAX)
    .map((row) => ({
      at: String((row && row.at) || ''),
      kind: String((row && row.kind) || ''),
      text: clampText((row && row.text) || (((row && row.url) || '') ? '链接：' + row.url : ''), QQ_LOG_TEXT_MAX),
    }))
    .filter((row) => row.text || row.kind)

  const todayName = new Intl.DateTimeFormat('sv-SE').format(ctx.now || new Date()) + '.jsonl'
  const todayRows = files.includes(todayName) ? readJsonl(join(dir, todayName), ctx, 'qq.activity') : []
  let todayReceive = 0
  let todaySend = 0
  const todayGroups = new Set()
  for (const row of todayRows) {
    const kind = String((row && row.kind) || '')
    if (kind === 'receive') todayReceive += 1
    if (kind === 'send') todaySend += 1
    const hit = String((row && row.text) || '').match(/group:([0-9]+)/)
    if (hit && kind === 'receive') todayGroups.add(hit[1])
  }

  return {
    activity: {
      day: scan.length ? scan[scan.length - 1].slice(0, 10) : '',
      days: files.length,
      total,
      byType,
      capped,
    },
    log,
    today: { receive: todayReceive, send: todaySend, groups: todayGroups.size },
  }
}

function readQQChats(ctx) {
  const chatsFile = pickLargestFile(relRootCandidates(ctx, '鱼的关系\\chats.json'))
  const peopleFile = pickLargestFile(relRootCandidates(ctx, '鱼的关系\\people.json'))
  const chatsRaw = chatsFile ? readJson(chatsFile, ctx, 'qq.chats') : null
  const peopleRaw = peopleFile ? readJson(peopleFile, ctx, 'qq.chats') : null

  const chats = []
  const owner = (peopleRaw && peopleRaw.owner) || {}
  const ownerQQ = String(owner.qqId || '')
  if (ownerQQ) {
    chats.push({
      type: 'private',
      id: ownerQQ,
      title: '主人',
      session: String(owner.sessionId || ''),
      mode: 'normal',
    })
  }

  const list = Array.isArray(chatsRaw && chatsRaw.items) ? chatsRaw.items : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const kind = String(item.kind || '')
    if (kind !== 'group' && kind !== 'private') continue
    const id = String(item.id || '')
    if (!id) continue
    if (ownerQQ && kind === 'private' && id === ownerQQ) continue // 主人绑定已在上面
    chats.push({
      type: kind,
      id,
      title: String(item.name || (kind === 'group' ? '群 ' + id : 'QQ ' + id)),
      session: String(item.sessionId || ''),
      mode: item.enabled === false ? 'off' : 'normal',
    })
  }
  return chats
}

function collectQQ(ctx) {
  const bridgeFile = join(ctx.dshHome, 'qq-bridge-config.json')
  const hasBridgeConfig = existsSync(bridgeFile)
  const bridgeCfg = hasBridgeConfig ? readJson(bridgeFile, ctx, 'qq.config') : null
  const bridge = bridgeCfg && typeof bridgeCfg === 'object' ? bridgeCfg : {}

  const fishConfigFile = join(ctx.dshHome, 'fish-world-config.json')
  const fishConfig = existsSync(fishConfigFile) ? readJson(fishConfigFile, ctx, 'qq.platform') : null
  const qqCfg = (fishConfig && fishConfig.platforms && fishConfig.platforms.qq) || {}

  const installed = detectQQInstalled(ctx)
  const masterOn = bridge['总开关'] === true
  const dryRun = bridge['试运行'] === true
  const fields = qqPlatformFields(qqCfg)
  const { activity, log, today } = readQQActivity(ctx)
  const bindings = Array.isArray(bridge['绑定']) ? bridge['绑定'] : []
  const config = {
    总开关: masterOn,
    试运行: dryRun,
    私聊QQ: String(bridge['私聊QQ'] || ''),
    群号: String(bridge['群号'] || ''),
    目标会话: String(bridge['目标会话'] || ''),
    NapCat: String(bridge['NapCat'] || ''),
    绑定: bindings
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        类型: String(b['类型'] || ''),
        号码: String(b['号码'] || ''),
        称呼: String(b['称呼'] || ''),
      })),
  }

  return {
    installed,
    enabled: masterOn,
    dryRun,
    config,
    platform: {
      enabledCount: countEnabledFields(fields),
      total: fields.length,
      fields,
    },
    chats: readQQChats(ctx),
    activity,
    log,
    today,
  }
}

function collectBili(ctx) {
  const fishConfigFile = join(ctx.dshHome, 'fish-world-config.json')
  const fishConfig = existsSync(fishConfigFile) ? readJson(fishConfigFile, ctx, 'bili.platform') : null
  const biliCfg = (fishConfig && fishConfig.platforms && fishConfig.platforms.bili) || {}
  const fields = biliPlatformFields(biliCfg)
  // 鱼自己的 B站登录号在 bili-whale 的共享配置里；读不到就如实留空，由面板显示未登录。
  const whaleFile = join(ctx.dshHome, 'bili-whale.config.json')
  const whale = existsSync(whaleFile) ? readJson(whaleFile, ctx, 'bili.account') : null
  const self = (whale && whale.self) || {}
  const owner = (whale && whale.owner) || {}
  return {
    installed: Object.keys(biliCfg).length > 0,
    enabled: biliCfg.enabled === true,
    account: {
      mid: String(self.mid || ''),
      name: String(self.name || ''),
    },
    owner: {
      mid: String(owner.mid || biliCfg.ownerMid || ''),
      name: String(owner.name || biliCfg.ownerName || ''),
    },
    platform: {
      enabledCount: countEnabledFields(fields),
      total: fields.length,
      fields,
    },
  }
}

/** GET /api/fish/bili 用：{ ok, generatedAt, errors, bili }。 */
export function buildFishBili(opts = {}) {
  const ctx = makeCtx(opts)
  const bili = collectBili(ctx)
  return { ok: true, generatedAt: ctx.now.toISOString(), errors: ctx.errors, bili }
}

/** GET /api/fish/qq 用：{ ok, generatedAt, errors, qq }。 */
export function buildFishQQ(opts = {}) {
  const ctx = makeCtx(opts)
  const qq = collectQQ(ctx)
  return {
    ok: true,
    generatedAt: ctx.now.toISOString(),
    errors: ctx.errors,
    qq,
  }
}

/* ── 总装 ─────────────────────────────────────────────────────── */

export function buildFishSnapshot(opts = {}) {
  const ctx = makeCtx(opts)

  const diary = collectDiary(ctx)
  const wishes = collectWishes(ctx)
  const growth = collectGrowth(ctx)
  const worldActivity = collectWorldActivity(ctx)
  const mood = collectMood(ctx)
  const personas = collectPersonas(ctx)
  const memories = collectMemories(ctx)
  const records = collectRecords(ctx)
  const gallery = collectGallery(ctx)
  const links = collectLinks(ctx)
  const status = collectStatus(ctx)
  const profile = collectProfile(ctx, personas)
  const qq = collectQQ(ctx)
  const bili = collectBili(ctx)

  const knowledgeFile = pickLargestFile(relRootCandidates(ctx, '鱼的记忆\\知识库.json'))
  const knowledge = knowledgeFile
    ? readKnowledgeStats(knowledgeFile, ctx)
    : { entries: 0, chars: 0, updatedAt: '', file: '' }

  const memory = {
    knowledge,
    personas: personas.personas.map(({ file, ...rest }) => rest),
    active: personas.active,
    memories,
    records,
    gallery,
    links,
    digest: status.digest,
  }
  const collections = { gallery, links }

  return {
    ok: true,
    generatedAt: ctx.now.toISOString(),
    roots: ctx.roots.slice(),
    errors: ctx.errors,
    overview: {
      stage: growth.stage,
      diary: { total: diary.total, pending: diary.pending, today: diary.today },
      wishes: { pending: wishes.pending, total: wishes.total },
      growth: { total: growth.total },
      memory: { memories: memories.total, knowledge: knowledge.entries },
      qq: { installed: qq.installed, enabled: qq.enabled, dryRun: qq.dryRun },
      bili: { installed: bili.installed, enabled: bili.enabled },
    },
    status: {
      day: status.day,
      at: status.at,
      count: status.count,
      chars: status.chars,
      text: status.text,
      history: status.history,
    },
    diary: { total: diary.total, pending: diary.pending, items: diary.items },
    wishes: { pending: wishes.pending, total: wishes.total, items: wishes.items, stickers: wishes.stickers },
    growth: {
      stage: growth.stage,
      total: growth.total,
      days: growth.days,
      firstDay: growth.firstDay,
      lastDay: growth.lastDay,
      todayCount: growth.todayCount,
      dailyLimit: growth.dailyLimit,
      byKind: growth.byKind,
      items: growth.items,
    },
    memory,
    profile,
    qq: {
      installed: qq.installed,
      enabled: qq.enabled,
      dryRun: qq.dryRun,
      config: qq.config,
      platform: qq.platform,
      chats: qq.chats,
      activity: qq.activity,
      today: qq.today,
      log: qq.log,
    },
    bili: { installed: bili.installed, enabled: bili.enabled, platform: bili.platform },
    collections,
    activity: worldActivity,
    mood,
  }
}

export default buildFishSnapshot
