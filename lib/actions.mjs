// 「所有具体操作都可视化」：把鱼自己动过的手摊成一条时间线。
//
// 真源是 `<根>/安全与审计/<日期>.jsonl`——鱼写日记、开请求、主人批准驳回、
// 空间发动态，每一件都在那里落一行。这个模块只做两件事：
//   1. 把它读成给人看的话（action → 中文，recordId → 那句正文）；
//   2. 把散在 lib 里**还没进审计**的动作补成同一张表（比如插件开关）。
//
// 边界：只读，不写审计；不编造——recordId 找不到对应正文时，就如实只显示 id。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
/** 「鱼的家」数目录时最多看多少项：一个塞满的目录不该把面板拖住。 */
const MAX_HOME_ENTRIES = 500
/** 「鱼的家」每个目录最多回几条最近改动：够认出是哪份文件就行，不列整个目录。 */
const MAX_HOME_RECENT = 8

/** 审计里会出现的动作。没列进来的按原样显示，不硬翻译。 */
export const ACTION_LABELS = Object.freeze({
  'diary-write': '写了日记',
  'diary-suggestion': '提了一篇日记草稿',
  'diary-comment': '主人在日记上留了批语',
  'diary-comment-quote': '主人引用了日记里的一句',
  'wish-open': '提了一个请求',
  'wish-approved': '主人同意了请求',
  'wish-rejected': '主人没同意请求',
  'qzone-post': '在空间发了动态',
  'qzone-diary': '在空间发了日记',
  'qzone-like': '给空间动态点了赞',
  'qzone-comment': '在空间留了评论',
  'qzone-reply': '在空间回了评论',
  'sticker-collect': '收了一张表情',
  'sticker-remove': '删了一张表情',
  'sticker-update': '改了一张表情的名字或标签',
  'sticker-organize': '让视觉模型整理了一张表情',
  'sticker-organize-all': '让视觉模型整理了全部表情',
  'link-collect': '存了一个网站',
  'link-remove': '删了一个网站',
  'link-update': '改了一个网站的记录',
  'portrait-set': '换了情绪图',
  'portrait-clear': '删了一张情绪图',
  'growth-record': '记下一点自己的变化',
  'hub-toggle': '改了整合包开关',
  'wardrobe-merge': '把衣柜里的记忆并进了知识库',
  'borrow-astrbot': '借了 AstrBot 的手',
  'borrow-qqagent': '借了 QQ Agent 的手',
  'config-change': '改了设置',
  'knowledge-reindex': '重建了知识库索引',
  'record-add': '往小本本记了一条',
  'record-update': '改了小本本上的一条',
  'record-remove': '从小本本划掉了一条',
  'record-explain': '解释了一件记着的事',
  'record-accept': '认下了一件记着的事',
  'growth-revise': '改了成长里的一条',
  'growth-retract': '收回了成长的一天',
  'growth-restore': '恢复了成长的一天',
  'persona-set': '改了人设卡',
  'protocol-launch': '手动拉起了协议端',
  'sticker-wish-approve': '同意了一条表情包愿望',
  'sticker-wish-reject': '驳回了一条表情包愿望',
  'link-repair': '重排了网站库的文件',
  'declare-self': '把鱼的世界写进 profile 清单',
  'platform-change': '改了平台设置',
  'bridge-change': '改了 QQ 桥设置',
  'extension-setting': '改了一个扩展的设置',
  'market-install': '装了一个扩展',
  'deps-install': '装了依赖',
  'role-change': '动了角色卡',
  'relation-change': '改了关系表',
  'qqagent-setting': '改了 QQ Agent 借手通道',
  'astrbot-setting': '改了 AstrBot 借手通道',
  'person-memory-summary': '更新了对某个人的印象',
  'diary-review': '审核了日记',
  'chat-whitelist': '改了聊天白名单',
  'profile-change': '改了主人绑定',
})

const ROLE_LABELS = Object.freeze({ fish: '鱼', owner: '主人', trusted: '信任者' })

/** 压成一行、截断：正文只用来认出是哪件事，不是拿来复述全文。 */
function oneLine(text, max = 48) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

/**
 * recordId → 那句正文。
 *
 * 审计里只留 id，光看 id 认不出是哪篇日记、哪个请求——时间线就退化成一串乱码。
 * 日记和请求都把全文留在自己的 jsonl 里，按这几天的文件建一张 id→正文的表，
 * 把 id 换成人话。找不到就返回空串（调用方退回显示 id），不猜、不编。
 */
function textIndex(rootDir, days) {
  const index = new Map()
  if (!rootDir) return index
  const places = [
    join(rootDir, '鱼的日记'),
    join(rootDir, '鱼的日记', '待主人确认'),
    join(rootDir, '鱼的日记', '批语'),
    join(rootDir, '鱼的请求'),
  ]
  for (const dir of places) {
    for (const day of days) {
      for (const row of readJsonl(join(dir, `${day}.jsonl`))) {
        if (row && row.id && row.text) index.set(String(row.id), oneLine(row.text))
      }
    }
  }
  // 成长是按账本存的（一个大文件），也补上——时间线上「记下一点自己的变化」得看得见那句话。
  for (const row of readJsonl(join(rootDir, '鱼的成长', 'ledger.jsonl'))) {
    if (row && row.type === 'entry' && row.id && row.text) index.set(String(row.id), oneLine(row.text))
  }
  // 小本本同理：记录与小怨气都是固定文件名，不按天分。
  for (const name of ['记录.jsonl', '小本本.jsonl']) {
    for (const row of readJsonl(join(rootDir, '鱼的记录', name))) {
      if (row && row.id && row.text) index.set(String(row.id), oneLine(row.text))
    }
  }
  return index
}

function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function auditDir(rootDir) {
  return rootDir ? join(rootDir, '安全与审计') : ''
}

/**
 * 读审计时间线。
 *
 * rootDir = 鱼的世界根目录。days 限定读最近几天（审计是按天一个文件，读全部没必要）。
 * role 按身份筛（fish / owner / trusted）：主人想「只看我自己动过什么」或「只看她自己做了什么」，
 * 不用在一长串里挑。筛的时候 `total` 也跟着变——面板上的条数得和列出来的一致。
 */
export function readActions({ rootDir = '', days = 7, limit = 40, role = '' } = {}) {
  const dir = auditDir(rootDir)
  const files = dir && existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && DAY_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, Math.max(1, days))
    : []

  const all = files.flatMap((name) => readJsonl(join(dir, name)).map((item) => ({ ...item, day: name.slice(0, 10) })))
  const wanted = String(role || '').trim()
  const records = (wanted ? all.filter((item) => String(item.role || '') === wanted) : all.slice())
  records.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))

  // id → 正文：只为最后真要列出来的那几条建表，不为整个时间线翻全文。
  const texts = textIndex(rootDir, files.map((name) => name.slice(0, 10)))

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    rootDir,
    days: files.map((name) => name.slice(0, 10)),
    total: records.length,
    items: records.slice(0, Math.max(1, Math.min(Number(limit) || 40, 200))).map((item) => ({
      at: String(item.at || ''),
      // 这条是哪一天的：按审计文件名的日期，不按 ISO 的 UTC 日期算
      // （凌晨那几条按 UTC 会落到前天去，主人看到「今天」就会少几条）。
      day: String(item.day || ''),
      action: String(item.action || ''),
      label: ACTION_LABELS[item.action] || String(item.action || '未知动作'),
      role: String(item.role || ''),
      roleLabel: ROLE_LABELS[item.role] || String(item.role || ''),
      recordId: String(item.recordId || ''),
      // 那句正文：查得到就给人看（面板显示它），查不到就是空串（面板退回显示 id）。
      // 不猜——宁可显示 id，也不能拿相近的一句话冒充。
      text: texts.get(String(item.recordId || '')) || '',
      // 审批的语气（安抚 / 解释 / 冷淡…）原样带过去，不在这一层解释。
      tone: String(item.tone || ''),
    })),
    // 「今天」的小结：面板那一栏只说今天，不用它自己再筛一遍。
    // 日期按北京时间算（与 lib/growth.mjs 的 dayKeyShanghai 同一套），否则凌晨那几条会落到「昨天」。
    // 「今天」永远按全部记录算，不跟着 role 筛：那一栏说的是「这条鱼今天过了什么」，
    // 滤成「只看主人」之后数字会变小，看着像今天什么都没干。
    today: summarizeDay(all, dayKeyShanghai()),
  }
}

/** 北京时间日期字符串（与 growth.mjs 里那份算法一致：+8 小时后取 ISO 的日期部分）。 */
export function dayKeyShanghai(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 某一天的动作计数。day 传空就是「今天没有记录」。 */
function summarizeDay(records, day) {
  const ofDay = day ? records.filter((item) => String(item.day || '') === day) : []
  const byAction = {}
  for (const item of ofDay) {
    const key = String(item.action || '')
    byAction[key] = (byAction[key] || 0) + 1
  }
  return {
    day,
    total: ofDay.length,
    byAction,
    labels: Object.keys(byAction).map((key) => ({ action: key, label: ACTION_LABELS[key] || key, count: byAction[key] })),
  }
}

/**
 * 一天里各类动作的计数。面板用一行小数字说「今天干了什么」，
 * 不用把时间线里每一条都念一遍。
 */
export function actionCounts({ rootDir = '', days = 7 } = {}) {
  const { total, items } = readActions({ rootDir, days, limit: 200 })
  const byAction = {}
  for (const item of items) byAction[item.action] = (byAction[item.action] || 0) + 1
  return { total, byAction }
}

/** 根目录下有哪些目录真的存在。folders 既可以是目录名，也可以是完整路径。 */
/**
 * 「鱼的家」：每个目录在不在，以及里面有多少东西。
 *
 * 只报「在 / 不在」不够用：日记目录空不空、图库有没有货、记忆目录最近动过没，
 * 这些才是人真正想知道的。所以顺带数一层（不递归、不跟随符号链接），
 * 免得一个目录里塞了几千个文件把面板拖住。
 */
export function describeHome({ rootDir = '', folders = [] } = {}) {
  return folders.map((entry) => {
    const isPath = /[\\/]/.test(String(entry))
    const path = isPath ? String(entry) : (rootDir ? join(rootDir, String(entry)) : '')
    let exists = false
    try {
      exists = Boolean(path) && existsSync(path)
    } catch {
      exists = false
    }
    const detail = exists ? shallowSummary(path) : { entries: 0, files: 0, bytes: 0, latestAt: '' }
    return { name: isPath ? '' : String(entry), path, exists, ...detail }
  })
}

/** 数一层目录：多少项、多少文件、多大、最近一次改动。失败就当空。 */
function shallowSummary(dir) {
  const out = { entries: 0, files: 0, bytes: 0, latestAt: '', recent: [] }
  try {
    const list = readdirSync(dir, { withFileTypes: true }).slice(0, MAX_HOME_ENTRIES)
    out.entries = list.length
    let latest = 0
    const rows = []
    for (const entry of list) {
      // 符号链接 / 联接一律不进去：跟着走可能跑到别的盘，甚至绕死。
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      try {
        const info = statSync(full)
        const isFile = entry.isFile()
        if (isFile) {
          out.files += 1
          out.bytes += Number(info.size) || 0
        }
        if (info.mtimeMs > latest) latest = info.mtimeMs
        // 「里面有什么」：只留最近改动的几条，够人认出这是不是他在找的那份。
        rows.push({ name: entry.name, dir: !isFile, bytes: isFile ? Number(info.size) || 0 : 0, mtime: Number(info.mtimeMs) || 0 })
      } catch {
        // 单个文件读不到就跳过，别让一个坏文件把整张卡弄没。
      }
    }
    // 只留最近 8 条，按改动时间倒序（契约里叫 recent，别在面板再排一次）。
    out.recent = rows.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_HOME_RECENT)
    if (latest) out.latestAt = new Date(latest).toISOString()
  } catch {
    // 目录读不了（权限 / 并发删除）：保持空。
  }
  return out
}

export const __test = { readJsonl, DAY_FILE }
