// 离线摘要（2026-11-22 主人要求「上线先看一遍：离线摘要 + 简短回复」）。
//
// ── 目标 ──
// 她离线一段时间再回来时，不逐条补回复，也不装作什么都没发生：
// 先看一眼这段时间发生了什么，再用一两句话接上。
//
// ── 四步（对应主人的方案）──
//   ① 判定离线窗口：上次处理时间 vs 本次上线时间，超过 15 分钟才算
//   ② 拉取离线期间消息（只读，不投递）：白名单会话 / 每会话 ≤30 条 /
//      总 ≤200 条 / 时间窗 ≤6 小时；超限只记一条「还有 N 条更早的没看」
//   ③ 生成内部摘要（≤120 字，只进这一轮上下文，用完即弃）+ 写 activity
//   ④ 回复策略：只在有人直接找她时才回；一次上线 ≤2 条；同一个人只回一次；
//      有补投队列的会话只用于摘要不回
//
// ── 两个设计判断（写下来免得下次重新猜）──
//   1. 「上次处理时间」持久化在 <世界根>/.fish-world/上线状态.json，
//      每次 tick 结束刷新。进程内存里的 lastTickAt 重启就没了，靠不住。
//   2. 溢出的 N（还有几条更早的没看）桥不返回总数（实测 data 里只有 messages），
//      所以对**溢出的会话**做一次计数读（count=100，桥的上限）：
//      N = 窗口内条数 - 30。计数读只用于数数，不进摘要材料、不投递。
//      若计数读也触顶（100 条全在窗口内），N=70 可能低估 —— 已记在收口单未验证项。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 离线超过 15 分钟才需要「看一眼」（主人定的阈值）。 */
export const OFFLINE_THRESHOLD_MS = 15 * 60_000
/** 时间窗最多 6 小时：只看上线前 6 小时内的消息。 */
export const DIGEST_WINDOW_MS = 6 * 3600_000
/** 每个会话最多 30 条进摘要材料。 */
export const PER_CHAT_CAP = 30
/** 实际拉 31 条：多出的 1 条用来探测「窗口内是否还有更早的」。 */
export const PULL_PER_CHAT = PER_CHAT_CAP + 1
/** 所有会话的摘要材料总上限 200 条。 */
export const TOTAL_CAP = 200
/** 一次上线最多回 2 条（补回复的总预算）。 */
export const REPLY_BUDGET = 2
/** 摘要 ≤120 字，超了截断。 */
export const DIGEST_TEXT_MAX = 120
/** 计数读的上限（桥 count 最大 100）。 */
export const COUNT_READ_LIMIT = 100
/** 群里至少这么多条（且没人点名她）才考虑回一句总括。 */
export const GENERAL_MIN_GROUP = 3

const KIND_GROUP = 'group'

/** 群/私聊从 chatKey 判（白名单条目不一定带 kind）。 */
function kindOfChatKey(chatKey) {
  return String(chatKey || '').startsWith('group:') ? KIND_GROUP : 'private'
}

function normText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/**
 * 拼摘要正文（纯函数，判据直接打这里）。
 *
 * 只回答三件事：谁找过她 / 有没有人直接问她或 @ 她 / 群里在聊什么。
 * 拉不到就说「这段没看到」，不编。
 *
 * @param {object} s
 * @param {number} s.okPulls        成功读到的会话数
 * @param {number} s.failedChats    读取失败的会话数
 * @param {number} s.skippedChats   因总上限没轮到读的会话数
 * @param {Array<{name:string,count:number,firstAt:number}>} s.privateSenders 私聊找她的人（按最早发言排序）
 * @param {number} s.groupCount     群里（合格的）消息条数
 * @param {string[]} s.groupDirect  群里点名/@ 她的人（去重）
 * @param {string} s.newestGroupText 群里最新一条的文字（做「在聊什么」的引子）
 * @param {number} s.overflow       超出每会话 30 条上限、更早没看的总条数
 * @returns {string} ≤120 字
 */
export function buildDigestText({
  okPulls = 0,
  failedChats = 0,
  skippedChats = 0,
  privateSenders = [],
  groupCount = 0,
  groupDirect = [],
  newestGroupText = '',
  overflow = 0
} = {}) {
  // 全部读不到 → 如实说没看到（主人：拉不到就说「这段没看到」）
  if (okPulls === 0 && failedChats > 0) {
    return clamp(`你不在的这段：这段没看到（${failedChats} 个会话读不到）。`)
  }

  const parts = []

  // ① 谁找过她（私聊）
  if (privateSenders.length) {
    parts.push(privateSenders
      .map((s) => (s.count > 1 ? `${s.name} 找了你 ${s.count} 次` : `${s.name} 找过你`))
      .join('、'))
  }

  // ② 群里点名 / @ 她（并进群聊那句，别拆成两段）
  // ③ 群里在聊什么
  if (groupCount > 0) {
    const directBit = groupDirect.length ? `${groupDirect.join('、')} 点名你` : '没人叫你'
    parts.push(`${groupCount} 条群里消息，${directBit}，最新在聊「${snippetOf(newestGroupText)}」`)
  }

  if (!parts.length) parts.push('没人找你')

  let text = `你不在的这段：${parts.join('；')}。`
  if (overflow > 0) text += `还有 ${overflow} 条更早的没看。`
  if (skippedChats > 0) text += `另有 ${skippedChats} 个会话没看到。`
  if (failedChats > 0 && okPulls > 0) text += `有 ${failedChats} 个会话没读到。`
  return clamp(text)
}

function clamp(text) {
  return text.length <= DIGEST_TEXT_MAX ? text : text.slice(0, DIGEST_TEXT_MAX - 1) + '…'
}

/** 群里最新一条做引子：压成短句，空的（纯图）说「发了张图」。 */
function snippetOf(text) {
  const s = normText(text)
  if (!s) return '发了张图'
  return s.length > 14 ? s.slice(0, 14) + '…' : s
}

/**
 * 从拉取结果算摘要素材（纯函数）。
 *
 * @param {Map<string,{kind:string,target:object,material:object[]}>} pulls
 * @param {(msg:object,target:object)=>boolean} isDirect 直接找她（私聊/@/点名）
 * @param {(msg:object,target:object)=>boolean} isEligible 合格消息（非自己/非禁言/#sl）
 */
export function summarizePulls(pulls, isDirect, isEligible) {
  const senders = new Map()          // 私聊：personId → { name, count, firstAt }
  const directNames = new Map()      // 群点名：personId → name（去重）
  let groupCount = 0
  let newest = null

  for (const pull of pulls.values()) {
    for (const msg of pull.material) {
      if (isEligible && !isEligible(msg, pull.target)) continue
      const at = Number(msg.at) || 0
      const id = String(msg.userId ?? '')
      const name = String(msg.nickname || id || '有人')
      if (pull.kind !== KIND_GROUP) {
        const cur = senders.get(id) || { name, count: 0, firstAt: at }
        cur.count += 1
        if (at < cur.firstAt) cur.firstAt = at
        senders.set(id, cur)
        continue
      }
      groupCount += 1
      if (isDirect && isDirect(msg, pull.target) && !directNames.has(id)) {
        directNames.set(id, name)
      }
      if (!newest || at >= newest.at) newest = { at, text: String(msg.text || '') }
    }
  }

  return {
    privateSenders: [...senders.values()].sort((a, b) => a.firstAt - b.firstAt),
    groupCount,
    groupDirect: [...directNames.values()],
    newestGroupText: newest ? newest.text : ''
  }
}

/**
 * 排补回复的计划（纯函数）。
 *
 * 规则（主人方案第四步）：
 *   · 只在「有人直接找她」时才回：私聊、@ 她、点名问她
 *   · 同一个人只回一次（取他最早那条）
 *   · 一次上线最多回 REPLY_BUDGET 条
 *   · 补投队列里的消息只用于摘要，不回（isPending 过滤）
 *   · 没人直接找她、群里又热闹（≥GENERAL_MIN_GROUP 条）→ 最多一句总括
 *     （回群里最新那条，让她顺着说「刚回来，你们聊到哪了」）
 *
 * @returns {{deliveries:Array, general:object|null, materialTotal:number}}
 *   deliveries 按时间升序；第一条 attach=true（摘要只挂第一条，用完即弃）
 */
export function planBacklog({
  pulls,
  keyOf,
  isDirect,
  isEligible,
  isPending,
  budget = REPLY_BUDGET
} = {}) {
  const directs = []
  const groupMsgs = new Map()   // chatKey → [msg]（升序）
  let materialTotal = 0

  for (const [chatKey, pull] of pulls) {
    for (const msg of pull.material) {
      materialTotal += 1
      if (isEligible && !isEligible(msg, pull.target)) continue
      if (isPending && isPending(chatKey, msg)) continue   // 补投队列：只用于摘要
      if (isDirect && isDirect(msg, pull.target)) {
        directs.push({ chatKey, msg })
      } else if (pull.kind === KIND_GROUP) {
        if (!groupMsgs.has(chatKey)) groupMsgs.set(chatKey, [])
        groupMsgs.get(chatKey).push(msg)
      }
    }
  }

  // 直接找她：按时间升序，每人最早那条，预算封顶
  directs.sort((a, b) => (Number(a.msg.at) || 0) - (Number(b.msg.at) || 0))
  const deliveries = []
  const persons = new Set()
  for (const d of directs) {
    if (deliveries.length >= budget) break
    const person = String(d.msg.userId ?? '')
    if (person && persons.has(person)) continue
    if (person) persons.add(person)
    deliveries.push({ chatKey: d.chatKey, key: keyOf(d.msg), person, attach: false })
  }

  // 总括句：一条直接回复都没排上、群里又热闹时，挑最热闹那个群的最新一条
  let general = null
  if (!deliveries.length) {
    let bestKey = ''
    let bestCount = 0
    for (const [chatKey, list] of groupMsgs) {
      if (list.length > bestCount) { bestKey = chatKey; bestCount = list.length }
    }
    if (bestKey && bestCount >= GENERAL_MIN_GROUP) {
      const list = groupMsgs.get(bestKey)
      general = { chatKey: bestKey, key: keyOf(list[list.length - 1]), person: '', attach: true }
    }
  }

  if (deliveries.length) deliveries[0].attach = true
  return { deliveries, general, materialTotal }
}

/**
 * 建离线摘要器。
 *
 * @param {object} deps
 * @param {string} deps.stateFile   上次处理时间的落盘位置
 * @param {(chatKey:string,limit:number)=>Promise<{ok:boolean,messages?:object[]}>} deps.recent
 * @param {()=>Array} deps.whitelist 白名单会话（world.chatWhitelist）
 * @param {()=>number} [deps.now]
 * @param {(text:string)=>void} [deps.log]   写 activity（kind=offline-digest）
 * @param {(chatKey:string)=>boolean} [deps.stagedKeys] 攒批里有暂存（会话忙）
 * @param {()=>Promise<Array>} [deps.queueItems] 补投队列（[{qq,text}]）
 * @param {(msg:object)=>string} deps.keyOf  消息键（和 inbox 的 messageKey 同一个）
 */
export function createOfflineDigest({
  stateFile,
  recent,
  whitelist,
  now = () => Date.now(),
  log,
  stagedKeys,
  queueItems,
  keyOf
} = {}) {
  if (!stateFile) throw new Error('离线摘要需要 stateFile（上次处理时间落哪）')
  if (typeof recent !== 'function') throw new Error('离线摘要需要 recent（只读拉消息）')
  if (typeof whitelist !== 'function') throw new Error('离线摘要需要 whitelist（只碰白名单）')
  if (typeof keyOf !== 'function') throw new Error('离线摘要需要 keyOf（和 inbox 用同一个消息键）')

  function readState() {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      const at = Number(raw?.lastOnlineAt) || 0
      return at > 0 ? { lastOnlineAt: at } : null
    } catch {
      return null
    }
  }

  /** 每次 tick 结束刷新「上次处理时间」。写失败不影响收信（缓存/状态都只是优化）。 */
  function markOnline() {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify({ lastOnlineAt: now() }), 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** 溢出会话的精确 N：计数读一次（只数数，不进摘要、不投递）。 */
  async function countOverflow(chatKey, windowStart, onlineAt) {
    try {
      const res = await recent(chatKey, COUNT_READ_LIMIT)
      if (res && res.ok) {
        const n = (res.messages || []).filter((m) => {
          const at = Number(m.at) || 0
          return at >= windowStart && at <= onlineAt
        }).length
        return Math.max(1, n - PER_CHAT_CAP)
      }
    } catch { /* 计数读失败就用已证明的下限 1 */ }
    return 1
  }

  /**
   * 上线第一次跑：判定窗口 → 只读拉取 → 拼摘要 → 排回复计划 → 写 activity。
   *
   * @param {object} opts
   * @param {string} opts.selfId
   * @param {(msg:object,target:object)=>boolean} opts.isDirect
   * @param {(msg:object,target:object)=>boolean} opts.isEligible
   * @returns {Promise<null|{onlineAt:number,text:string,keys:Set,attachKeys:Set,gapMinutes:number}>}
   *   null = 没到阈值 / 首次没有基线 / 没有白名单
   */
  async function ensure({ selfId = '', isDirect, isEligible } = {}) {
    const st = readState()
    if (!st) {
      // 首次运行没有基线：先记下现在，不猜"离线了多久"
      markOnline()
      return null
    }

    const onlineAt = now()
    const gap = onlineAt - st.lastOnlineAt
    if (gap <= OFFLINE_THRESHOLD_MS) return null   // 低于/等于 15 分钟按正常流程

    const windowStart = onlineAt - DIGEST_WINDOW_MS
    const chats = (whitelist() || []).filter((c) => c && String(c.chatKey || '').trim())

    const pulls = new Map()
    let okPulls = 0
    let failedChats = 0
    let skippedChats = 0
    let materialTotal = 0
    const overflowChats = []

    for (const chat of chats) {
      const chatKey = String(chat.chatKey)
      if (materialTotal >= TOTAL_CAP) { skippedChats += 1; continue }   // 总上限
      let res = null
      try { res = await recent(chatKey, PULL_PER_CHAT) } catch { res = null }
      if (!res || !res.ok) { failedChats += 1; continue }
      okPulls += 1

      const inWin = (res.messages || [])
        .filter((m) => {
          const at = Number(m.at) || 0
          return at >= windowStart && at <= onlineAt
        })
        .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))

      // 拉满 31 条且全在窗口内 ⇒ 窗口里还有更早的没拉到
      const overflow = inWin.length >= PULL_PER_CHAT
      const room = TOTAL_CAP - materialTotal
      const material = inWin.slice(-Math.min(PER_CHAT_CAP, room))
      materialTotal += material.length
      pulls.set(chatKey, {
        kind: kindOfChatKey(chatKey),
        target: { ...chat, kind: kindOfChatKey(chatKey) },
        material
      })
      if (overflow) overflowChats.push(chatKey)
    }

    // 溢出的 N：每个溢出会话一次计数读
    let overflow = 0
    for (const chatKey of overflowChats) {
      overflow += await countOverflow(chatKey, windowStart, onlineAt)
    }

    const stats = summarizePulls(pulls, isDirect, isEligible)
    const text = buildDigestText({
      okPulls,
      failedChats,
      skippedChats,
      overflow,
      privateSenders: stats.privateSenders,
      groupCount: stats.groupCount,
      groupDirect: stats.groupDirect,
      newestGroupText: stats.newestGroupText
    })

    // 补投队列（桥侧未投 + 本会话攒批）：这些会话只用于摘要，不重复回
    const queue = typeof queueItems === 'function' ? await queueItems().catch(() => []) : []
    const pendingPriv = new Set()
    const pendingPair = new Set()
    for (const item of queue || []) {
      const qq = String(item?.qq || '')
      if (qq) pendingPriv.add(qq)
      const t = normText(item?.text)
      if (qq && t) pendingPair.add(qq + '\u0001' + t)
    }
    const isPending = (chatKey, msg) => {
      if (typeof stagedKeys === 'function' && stagedKeys(chatKey)) return true
      const uid = String(msg?.userId ?? '')
      if (String(chatKey).startsWith('private:') && pendingPriv.has(uid)) return true
      const t = normText(msg?.text)
      return Boolean(uid && t && pendingPair.has(uid + '\u0001' + t))
    }

    const plan = planBacklog({
      pulls, keyOf, isDirect, isEligible, isPending, budget: REPLY_BUDGET
    })

    const gapMinutes = Math.round(gap / 60_000)
    if (typeof log === 'function') {
      try { log(`离线 ${gapMinutes} 分钟 · ${text}`) } catch { /* 留档失败不影响回复 */ }
    }

    const keys = new Set()
    const attachKeys = new Set()
    for (const d of plan.deliveries) {
      keys.add(d.key)
      if (d.attach) attachKeys.add(d.key)
    }
    if (plan.general) {
      keys.add(plan.general.key)
      if (plan.general.attach) attachKeys.add(plan.general.key)
    }

    return { onlineAt, text, keys, attachKeys, gapMinutes, plan }
  }

  return { ensure, markOnline, readState, stateFile: () => stateFile }
}
