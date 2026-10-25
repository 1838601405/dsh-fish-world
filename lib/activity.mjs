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
export const ACTIVITY_KINDS = Object.freeze({
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
      actor: actor === 'owner' ? 'owner' : 'fish',
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
    dirOf: (id) => { try { return platformDir(id) } catch { return '' } },
  }
}

export const __test = { dayKey, ACTIVITY_KINDS }
