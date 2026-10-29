// 鱼与外界的往来留存：QQ / B 站 / 抖音上的浏览与互动，都留在本地工作区里。
//
// 落盘：<根>/鱼与世界/<平台>/<YYYY-MM-DD>.jsonl
//   · 一天一个文件，追加写入，不覆盖历史；
//   · 每条记录带时间、动作、内容摘要与可选链接；
//   · 同目录的 <平台> 说明.md 记录这个平台留下了多少条，方便直接翻。
//
// 这里只做"留档"，不决定能做不能做——权限与额度仍由 lib/platforms.mjs 的闸门管。
// 外部插件想补记一条，也可以通过本地 HTTP 面 POST /dsh-fish-world/world/activity。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_DIRS } from './storage.mjs'

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const MAX_TEXT = 800
const MAX_URL = 2048
const MAX_LINES = 500

/** 记什么：动作类型固定成白名单，宁可少记也不写任意字符串。 */
const ACTIVITY_KINDS = Object.freeze({
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
  // QQ 的 notice 上报（撤回 / 禁言 / 入退群 / 名片 / 群文件 / 表情回应）：
  // 不是鱼做的动作，也不是收到的聊天消息，单独一档才在留存里分得清。
  notice: '通知',
  other: '其它',
})

function safeText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function dayKey(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 数一份留存里的东西：按类型、按谁说的。
 *
 * 为什么要单独算：`status()` 的每日行只给「一共几条」，而「她说了 3 句、旁听 3400 条」
 * 和「总共 3403 条」是两件完全不同的事——只报后者，看着像她一天到晚在说话。
 * 只读、只数；文件读不到就当空。
 */
export function tallyDayFile(file, { maxLines = 20000 } = {}) {
  const byKind = {}
  const byActor = { fish: 0, owner: 0, other: 0 }
  let total = 0
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      if (total >= maxLines) break
      let row = null
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!row || typeof row !== 'object') continue
      total += 1
      const kind = String(row.kind || 'other')
      byKind[kind] = (byKind[kind] || 0) + 1
      const actor = String(row.actor || 'other')
      if (Object.hasOwn(byActor, actor)) byActor[actor] += 1
      else byActor.other += 1
    }
  } catch {
    // 文件不存在 / 读不动：返回全零，调用方自己决定怎么显示。
  }
  return { total, byKind, byActor, capped: total >= maxLines }
}

export function createActivityStore({ storage, logger } = {}) {
  function platformDir(id) {
    const paths = storage?.layout?.()
    if (!paths) throw new Error('存储位置尚未就绪')
    return paths.platform(id)
  }

  function summaryFile(id) {
    return join(platformDir(id), '说明.md')
  }

  function readLines(file) {
    try {
      return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    } catch { return [] }
  }

  function rewriteSummary(id) {
    const dir = platformDir(id)
    let files = []
    try { files = readdirSync(dir).filter((name) => DAY_FILE.test(name)).sort().reverse() } catch {}
    const rows = []
    let total = 0
    for (const name of files) {
      const lines = readLines(join(dir, name))
      total += lines.length
      let head = ''
      try { head = JSON.parse(lines[0] || '{}') } catch {}
      rows.push({
        day: name.slice(0, 10),
        count: lines.length,
        kinds: [...new Set(lines.map((line) => {
          try { return JSON.parse(line).kind } catch { return '' }
        }).filter(Boolean))],
        first: head,
      })
    }
    const lines = [
      `# 鱼与${PLATFORM_DIRS[id] || id}`,
      '',
      `共 ${total} 条留存 · ${files.length} 天 · 由鱼世界自动生成。`,
      '',
      '这些是鱼在这个平台上的浏览与互动记录，只留在本机工作区，不上传。',
      '',
      '| 日期 | 条数 | 包含动作 |',
      '|---|---|---|',
      ...rows.map((row) => `| ${row.day} | ${row.count} | ${row.kinds.map((k) => ACTIVITY_KINDS[k] || k).join('、')} |`),
      '',
    ]
    try { writeFileSync(summaryFile(id), lines.join('\n'), 'utf8') } catch {}
    return { total, days: files.length, rows }
  }

  function append({ platform, kind = 'other', text = '', url = '', ref = '', actor = 'fish' } = {}) {
    const id = String(platform || '').trim()
    if (!Object.hasOwn(PLATFORM_DIRS, id)) throw new Error(`未知平台：${id || '（空）'}`)
    const clean = safeText(text, MAX_TEXT)
    const link = safeText(url, MAX_URL)
    if (!clean && !link) throw new Error('这条记录既没有内容也没有链接')
    const dir = platformDir(id)
    mkdirSync(dir, { recursive: true })
    const day = dayKey()
    const record = {
      at: new Date().toISOString(),
      kind: Object.hasOwn(ACTIVITY_KINDS, kind) ? kind : 'other',
      text: clean,
      url: /^https?:\/\//i.test(link) ? link : '',
      ref: safeText(ref, 120),
      // 三种主体：鱼自己、主人、别人/系统。QQ 的 notice（撤回、入退群…）
      // 既不是鱼做的也不是主人做的，归成 'fish' 会让留存读起来像「鱼撤回了消息」。
      actor: actor === 'owner' ? 'owner' : actor === 'other' ? 'other' : 'fish',
    }
    // 同日追加，历史不重写。
    writeFileSync(join(dir, `${day}.jsonl`), JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' })
    const stats = rewriteSummary(id)
    try { logger?.info?.(`[activity] ${id} ${record.kind}：${clean.slice(0, 40) || record.url}`) } catch {}
    return { ok: true, platform: id, day, record, stats }
  }

  /** 今天某个平台上某类动作记了多少条：给「每日额度」当计数，不另开一套台账。 */
  function countToday(platform, kind) {
    const id = String(platform || '').trim()
    if (!Object.hasOwn(PLATFORM_DIRS, id)) return 0
    const day = dayKey()
    let lines = []
    try { lines = readLines(join(platformDir(id), `${day}.jsonl`)) } catch { return 0 }
    return lines.reduce((n, line) => {
      try {
        const row = JSON.parse(line)
        return row.kind === kind ? n + 1 : n
      } catch { return n }
    }, 0)
  }

  function list({ platform, limit = 50 } = {}) {
    const id = String(platform || '').trim()
    const targets = id
      ? [id]
      : Object.keys(PLATFORM_DIRS)
    const out = []
    for (const key of targets) {
      if (!Object.hasOwn(PLATFORM_DIRS, key)) continue
      const dir = platformDir(key)
      let files = []
      try { files = readdirSync(dir).filter((name) => DAY_FILE.test(name)).sort().reverse() } catch {}
      for (const name of files) {
        for (const line of readLines(join(dir, name))) {
          try {
            const row = JSON.parse(line)
            out.push({ ...row, platform: key, day: name.slice(0, 10) })
          } catch {}
        }
      }
    }
    out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return out.slice(0, Math.max(1, Math.min(Number(limit) || 50, MAX_LINES)))
  }

  /**
   * 和主人相处：从 QQ 留存里算，不另建台账。
   *
   * 口径（写在这里，面板上照这个说话）：
   *   · 互动次数 = 主人说的话 + 鱼说的话（不含「通知」「旁听别人」）；
   *   · 相处天数 = 至少有一次互动的天数；
   *   · 最近 30 天按天计数，用来看作息；
   *   · 连续 = 从今天（没有今天则从最近一天）往回数，连续的相处天数。
   * 认不出主人（老数据一律记成 other）时如实返回 ownerKnown: false，
   * 面板要说明「只统计到一部分」，不能把别人的消息算成主人。
   */
  function withOwnerStats() {
    const id = 'qq'
    let files = []
    try { files = readdirSync(platformDir(id)).filter((name) => DAY_FILE.test(name)).sort() } catch {}
    const perDay = new Map()
    let ownerKnown = false
    let firstAt = ''
    let lastAt = ''
    for (const name of files) {
      const day = name.slice(0, 10)
      const slot = { owner: 0, fish: 0, total: 0, hours: new Array(24).fill(0) }
      for (const line of readLines(join(platformDir(id), name))) {
        let row
        try { row = JSON.parse(line) } catch { continue }
        // 只算对话：发送 / 收到 / 旁听。通知与平台浏览不算「相处」。
        if (!['send', 'receive', 'read', 'reply'].includes(row.kind)) continue
        // 主体判定：鱼自己发的一定是 fish，不看 actor（老数据可能没这个字段）；
        // 收到的按 actor 分主人 / 别人，分不清就归别人——绝不替主人认领。
        const actor = row.kind === 'send'
          ? 'fish'
          : row.actor === 'owner' ? 'owner' : 'other'
        if (actor === 'owner') ownerKnown = true
        if (actor === 'other') continue
        slot[actor] += 1
        slot.total += 1
        const at = String(row.at || '')
        const hour = Number(at.slice(11, 13))
        if (Number.isInteger(hour) && hour >= 0 && hour < 24) slot.hours[hour] += 1
        if (at && (!firstAt || at < firstAt)) firstAt = at
        if (at && at > lastAt) lastAt = at
      }
      if (slot.total) perDay.set(day, slot)
    }

    const days = [...perDay.keys()].sort()
    let interactions = 0
    let ownerSaid = 0
    let fishSaid = 0
    const hours = new Array(24).fill(0)
    for (const day of days) {
      const slot = perDay.get(day)
      interactions += slot.total
      ownerSaid += slot.owner
      fishSaid += slot.fish
      for (let i = 0; i < 24; i += 1) hours[i] += slot.hours[i]
    }

    // 连续天数：从最近一天往回数（今天没聊也不算断，从最近一次开始算）
    let streak = 0
    if (days.length) {
      const last = days[days.length - 1]
      const cursor = new Date(last + 'T00:00:00Z')
      for (let i = days.length - 1; i >= 0; i -= 1) {
        const key = cursor.toISOString().slice(0, 10)
        if (days[i] !== key) break
        streak += 1
        cursor.setUTCDate(cursor.getUTCDate() - 1)
      }
    }

    const recentDays = days.slice(-30).map((day) => {
      const slot = perDay.get(day)
      return { day, total: slot.total, owner: slot.owner, fish: slot.fish }
    })
    const peakHour = hours.reduce((best, n, i) => (n > hours[best] ? i : best), 0)

    return {
      ok: true,
      platform: id,
      interactions,
      ownerSaid,
      fishSaid,
      days: days.length,
      streak,
      firstAt,
      lastAt,
      peakHour: interactions ? peakHour : null,
      hours,
      recentDays,
      ownerKnown,
      note: ownerKnown
        ? '只算你和鱼之间的收发，不含平台浏览与群通知。'
        : '以前的消息没有记「是谁说的」，所以只统计了鱼这一侧；从现在起主客会分清。',
    }
  }

  function status() {
    const platforms = {}
    for (const id of Object.keys(PLATFORM_DIRS)) {
      let stats = { total: 0, days: 0, rows: [] }
      try { stats = rewriteSummary(id) } catch { /* 存储还没就绪时保持空 */ }
      platforms[id] = {
        id,
        name: PLATFORM_DIRS[id],
        dir: (() => { try { return platformDir(id) } catch { return '' } })(),
        total: stats.total,
        days: stats.days,
        recent: stats.rows.slice(0, 7),
      }
    }
    return {
      ok: true,
      platforms,
      kinds: Object.entries(ACTIVITY_KINDS).map(([id, label]) => ({ id, label })),
      note: '浏览与互动记录只写入本机工作区，鱼世界不上传、不镜像。',
    }
  }

  return {
    append,
    list,
    status,
    countToday,
    withOwnerStats,
    dirOf: (id) => { try { return platformDir(id) } catch { return '' } },
  }
}

export const __test = { dayKey, ACTIVITY_KINDS }
