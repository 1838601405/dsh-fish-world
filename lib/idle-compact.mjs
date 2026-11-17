// 闲置压缩：闲 ≥30 分钟、且上下文 token 超阈值，才把这一段就地压成「摘要 + 关键事实」。
//
// 为什么挂在 idle 上、不挂在每轮生成里（主人 2026-11-18 反复强调的坑）：
//   生成循环里查阈值 ⇒ 每两三轮就压一次，等于没存；而且会话正忙时压缩会把正在说的话截断。
//   所以：只在**闲下来**的时候检查，而且一个「闲置窗口」只压一次（压过就记下时间，等下段闲置再说）。
//
// 压缩方式：原地压缩 —— 会话不变、记忆映射不变。
//   · 我们自己的上下文（每个 QQ 会话的短历史）直接就地重写成「摘要 + 关键事实 + 最后一条」；
//   · 摘要与事实同时写进记忆库，所以压完 recall 还找得到压之前聊的具体事。
//   · 宿主会话（DSH 那边）我们改不了；若宿主提供 /compact 同类接口，可通过 hostCompact 注进来复用。
import { statSync } from 'node:fs'
import { readJson, writeJson } from './util.mjs'

export const DEFAULT_IDLE_MS = 30 * 60 * 1000
export const DEFAULT_TOKEN_THRESHOLD = 6000
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000
export const COMPACT_STATE_FILE = 'idle-compact-state.json'

/** 粗估 token：中文约 1 字 1 token，英文按 4 字符 1 token。够用来判阈值，不用精确。 */
export function estimateTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export function tokensOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .reduce((sum, entry) => sum + estimateTokens(entry && entry.content), 0)
}

/**
 * 该不该压。三个条件同时成立：
 *   · 闲够久（idleMs ≥ idleMinMs）；
 *   · 上下文够大（tokens > tokenThreshold）；
 *   · 这段闲置还没压过（lastCompactAt 早于本次闲置起点）。
 * 另外给一个冷却：两次压缩之间至少 cooldownMs，防止边界抖动。
 */
export function shouldCompact({
  idleMs = 0,
  tokens = 0,
  lastCompactAt = 0,
  lastActivityAt = 0,
  now = Date.now(),
  idleMinMs = DEFAULT_IDLE_MS,
  tokenThreshold = DEFAULT_TOKEN_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  if (!Number.isFinite(idleMs) || idleMs < idleMinMs) return { ok: false, why: 'idle-too-short' }
  if (!Number.isFinite(tokens) || tokens <= tokenThreshold) return { ok: false, why: 'under-threshold' }
  // 这段闲置里已经压过：不再压（这就是「不是每轮都压」的闸）。
  if (lastCompactAt && lastCompactAt >= lastActivityAt) return { ok: false, why: 'already-compacted' }
  if (lastCompactAt && now - lastCompactAt < cooldownMs) return { ok: false, why: 'cooldown' }
  return { ok: true, why: 'compact' }
}

/** 抽「关键事实」：带具体的人/时间/数字/约定的句子，最多 n 条。 */
export function keyFacts(entries, n = 5) {
  const lines = (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry && entry.content || '').trim())
    .filter(Boolean)
  const picked = []
  for (const line of lines) {
    if (picked.length >= n) break
    if (line.length < 6 || line.length > 160) continue
    if (/(喜欢|讨厌|约定|说好|记住|别忘|叫|名字|明天|昨天|今天|刚才|吃|点|元|个|次|号|不能|不要|必须|住在|去过)/.test(line)) picked.push(line)
  }
  return picked
}

/**
 * 把一段上下文压成原地的新上下文。
 * 返回 { entries, summary, facts, tokensBefore, tokensAfter }
 * 纯函数（摘要由调用方传进来），便于测。
 */
export function compactEntries(entries, { summary = '', maxTail = 1 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.content)
  const before = tokensOf(list)
  const facts = keyFacts(list)
  const tail = list.slice(-Math.max(0, maxTail))
  const head = []
  if (summary) head.push({ role: 'assistant', content: '〔前情摘要〕' + summary })
  if (facts.length) head.push({ role: 'assistant', content: '〔关键事实〕' + facts.join('；') })
  const next = [...head, ...tail]
  return { entries: next, summary, facts, tokensBefore: before, tokensAfter: tokensOf(next) }
}

/**
 * 建一个闲置压缩器。
 *
 * deps：
 *   contextStore —— { load(chatKey), save(chatKey, list), fileFor?, keys? }
 *   memoryWriter —— (payload) => { ok }（把摘要+事实写进记忆库，保证压完 recall 还能命中）
 *   runner       —— 本地模型（可空；空了就用抽取式摘要，不编）
 *   hostCompact  —— 宿主 /compact 同类接口（有就优先用；没有就自己就地重写）
 *   stateFile    —— 记「每个会话上次压缩时间」的文件
 */
export function createIdleCompactor({
  contextStore,
  memoryWriter = null,
  // 摘要写进记忆库时要带上这个聊天室的隐私 scope（否则压完就查不到）。
  scopeOf = null,
  hintWriter = null,
  runner = null,
  hostCompact = null,
  stateFile,
  now = () => Date.now(),
  logger = null,
  idleMinMs = DEFAULT_IDLE_MS,
  tokenThreshold = DEFAULT_TOKEN_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  chats = null,
} = {}) {
  let state = {}
  try { state = readJson(stateFile, {}) || {} } catch { state = {} }
  let timer = null
  const stats = { checks: 0, compacts: 0, skipped: 0, lastError: '' }

  function knownChats() {
    if (typeof chats === 'function') { try { return (chats() || []).map(String) } catch { return [] } }
    if (Array.isArray(chats)) return chats.map(String)
    // 没给聊天清单就扫上下文目录里的文件名反推（测试与兜底用）。
    try {
      const dir = contextStore?.dir?.()
      if (!dir) return []
      return (contextStore.keys?.() || []).map(String)
    } catch { return [] }
  }

  function lastActivityOf(chatKey) {
    try {
      if (contextStore?.fileFor) return statSync(contextStore.fileFor(chatKey)).mtimeMs
    } catch {}
    return 0
  }

  async function summarize(list) {
    const facts = keyFacts(list)
    if (runner && runner.ok) {
      try {
        const text = list.map((entry) => String(entry.content || '')).join('\n').slice(0, 2000)
        const out = await runner.generate(
          '把这段聊天压成三句以内的中文摘要，只回摘要；另起一行用「事实：」列出确定的事实。\n' + text,
          { maxTokens: 200 },
        )
        const raw = String(out || '').trim()
        const [summaryPart, factsPart] = raw.split(/事实[：:]/)
        const summary = String(summaryPart || '').replace(/^摘要[：:]/, '').trim().slice(0, 200)
        const more = String(factsPart || '').split(/[；;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 5)
        if (summary) return { summary, facts: more.length ? more : facts, via: runner.via || 'local' }
      } catch { /* 落到抽取式 */ }
    }
    // 没有模型：不编摘要，只保留「关键事实」+ 一句话说明。
    return {
      summary: facts.length ? '（无模型，只保留关键事实）' : '',
      facts,
      via: 'fallback',
    }
  }

  async function compactOne(chatKey, { idleMs } = {}) {
    const before = contextStore.load(chatKey)
    const tokens = tokensOf(before)
    const lastActivityAt = lastActivityOf(chatKey) || (now() - idleMs || 0)
    const lastCompactAt = Number(state[chatKey] || 0)
    const verdict = shouldCompact({
      idleMs,
      tokens,
      lastCompactAt,
      lastActivityAt,
      now: now(),
      idleMinMs,
      tokenThreshold,
      cooldownMs,
    })
    if (!verdict.ok) return { ok: false, why: verdict.why }

    const { summary, facts, via } = await summarize(before)
    let result = null
    // 宿主有 /compact 就先复用；它负责改自己的会话上下文。
    if (typeof hostCompact === 'function') {
      try { result = await hostCompact({ chatKey }) } catch { result = null }
    }
    const compacted = compactEntries(before, { summary })
    const saved = contextStore.save(chatKey, compacted.entries)
    if (!saved) return { ok: false, why: 'save-failed' }

    // 摘要与事实同时进记忆库：压完 recall 仍要命中压之前的具体事。
    if (typeof memoryWriter === 'function' && (summary || facts.length)) {
      try {
        const saved = memoryWriter({
          text: [summary, facts.length ? '事实：' + facts.join('；') : ''].filter(Boolean).join('\n'),
          category: 'stable_profile',
          importance: 0.7,
          tags: ['压缩摘要'],
          事实键: '压缩摘要:' + chatKey,
        })
        // 摘要记忆继承这个聊天室的 scope：压完只能在原来的场合被想起来。
        if (saved && saved.id && typeof hintWriter === 'function' && typeof scopeOf === 'function') {
          try {
            const scope = scopeOf(chatKey) || {}
            hintWriter({ id: saved.id, scope, evidence: '闲置压缩产出的摘要', via: 'idle-compact' })
          } catch {}
        }
      } catch (error) { stats.lastError = String(error?.message || error) }
    }

    state[chatKey] = now()
    try { writeJson(stateFile, state) } catch {}
    stats.compacts += 1
    try { logger?.info?.(`[idle-compact] ${chatKey} 压了：${compacted.tokensBefore}→${compacted.tokensAfter} token（${via}）`) } catch {}
    return {
      ok: true,
      chatKey,
      tokensBefore: compacted.tokensBefore,
      tokensAfter: compacted.tokensAfter,
      facts: facts.length,
      via,
      hostCompact: Boolean(result),
    }
  }

  /** 一次检查：谁闲够了、够大了，就压谁。返回压了哪些。 */
  async function tick() {
    stats.checks += 1
    const out = []
    for (const chatKey of knownChats()) {
      const lastActivity = lastActivityOf(chatKey)
      const idleMs = lastActivity ? now() - lastActivity : 0
      const got = await compactOne(chatKey, { idleMs })
      if (got.ok) out.push(got)
      else stats.skipped += 1
    }
    return out
  }

  function start({ intervalMs = 60 * 1000 } = {}) {
    if (timer) return { ok: true, already: true }
    timer = setInterval(() => { tick().catch((error) => { stats.lastError = String(error?.message || error) }) }, Math.max(1000, intervalMs))
    if (typeof timer.unref === 'function') timer.unref()
    return { ok: true, already: false }
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  return { tick, compactOne, start, stop, stats: () => ({ ...stats }), state: () => ({ ...state }) }
}