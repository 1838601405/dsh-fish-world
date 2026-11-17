// 入库管道：接内容 → 标话题属性 → 摘要（延迟）→ 消歧 → 落 scope。
//
// 主人 2026-11-18 的规矩：
//   · 「接内容 → 标记话题属性 → 摘要 → 入库」交给本地模型，宿主只做最终对话生成；
//   · 摘要**延迟**：原文落盘时只标话题，recall 时按需生成并缓存，命中即用；
//   · 指代消歧在 ingest 阶段做（「你/她」指谁），结果写进 scope（来源房间/对方身份/是否私密）。
//
// 本地模型不在时：话题属性退回关键词规则、摘要不生成（标 via:'fallback'），
// 绝不假装模型跑过。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SUMMARY_CACHE_FILE = '摘要缓存.json'
export const SCOPE_HINTS_FILE = 'scope-hints.json'

/** 话题属性：固定几类，便于检索和面板看。 */
export const TOPICS = Object.freeze(['关系', '偏好', '约定', '事件', '情绪', '状态', '任务', '知识'])

const TOPIC_RULES = [
  ['约定', /约定|说好|以后|每次|规矩|别忘|记得要/],
  ['偏好', /喜欢|讨厌|爱吃|不吃|爱喝|口味|偏好/],
  ['关系', /主人|群友|朋友|认识|关系|称呼|名字/],
  ['任务', /要做|帮我|进度|截止|准备|计划|安排/],
  ['情绪', /难过|生气|开心|委屈|烦|焦虑|低落|emo/],
  ['状态', /困|饿|累|生病|加班|睡|醒/],
  ['知识', /梗|意思|出处|词条|解释|是什么/],
  ['事件', /今天|昨天|刚才|发生|去了|吃了|见了/],
]

function hashOf(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16)
}

function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return raw && typeof raw === 'object' ? raw : fallback
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 标话题属性。有本地模型就让它标（只回 JSON 数组），没有就按关键词规则标。
 * 返回 { topics, via, model }
 */
export async function tagTopics(text, { runner = null } = {}) {
  const s = String(text || '').trim()
  if (!s) return { topics: [], via: 'empty', model: '' }
  if (runner && runner.ok) {
    try {
      const prompt = [
        '给下面这句话标话题属性。只回一个 JSON 数组，元素只能从这些里选：',
        TOPICS.join('、'),
        '句子：' + s.slice(0, 300),
      ].join('\n')
      const out = await runner.generate(prompt, { maxTokens: 48 })
      const m = String(out || '').match(/\[[^\]]*\]/)
      if (m) {
        const picked = JSON.parse(m[0]).map((x) => String(x).trim()).filter((x) => TOPICS.includes(x))
        if (picked.length) return { topics: [...new Set(picked)].slice(0, 3), via: runner.via, model: runner.model || '' }
      }
    } catch { /* 落到规则 */ }
  }
  const topics = []
  for (const [topic, re] of TOPIC_RULES) if (re.test(s)) topics.push(topic)
  return { topics: topics.slice(0, 3), via: 'fallback', model: '' }
}

/**
 * 指代消歧：这句话里的「我 / 你 / 她」指的是谁。
 * 返回 { self, other, thirdParty, evidence, via }
 *   · self：说话人（「我」）
 *   · other：对话对象（「你」）
 *   · thirdParty：第三方（「他/她」）—— 有第三方时默认按私密处理（宁严勿漏）
 */
export async function resolveCoref({ text = '', speaker = '', listener = '', runner = null } = {}) {
  const s = String(text || '').trim()
  const result = {
    self: String(speaker || '').trim(),
    other: String(listener || '').trim(),
    thirdParty: '',
    evidence: '',
    via: 'fallback',
  }
  if (!s) return result
  if (runner && runner.ok) {
    try {
      const prompt = [
        '读这句话，判断人称指的是谁。只回一个 JSON 对象，字段 self / other / thirdParty（没有就空串）。',
        '说话人：' + (speaker || '未知'),
        '对话对象：' + (listener || '未知'),
        '句子：' + s.slice(0, 200),
      ].join('\n')
      const out = await runner.generate(prompt, { maxTokens: 80 })
      const m = String(out || '').match(/\{[\s\S]*\}/)
      if (m) {
        const obj = JSON.parse(m[0])
        result.self = String(obj.self || result.self || '').slice(0, 40)
        result.other = String(obj.other || result.other || '').slice(0, 40)
        result.thirdParty = String(obj.thirdParty || '').slice(0, 40)
        result.evidence = '本地模型标注'
        result.via = runner.via
        return result
      }
    } catch { /* 落到规则 */ }
  }
  // 规则兜底：出现「他/她」就记一个第三方线索；出现「你」说明对象在场。
  const third = s.match(/(他|她|他们|她们|那个人)/)
  if (third) result.thirdParty = third[0]
  if (/你/.test(s)) result.evidence = '句中出现「你」：对象在场'
  else if (third) result.evidence = '句中出现第三方指代'
  return result
}

/**
 * 延迟摘要：第一次问才生成，之后命中缓存。
 * cache 文件按「记忆 id + 原文指纹」存，原文变了自然失效。
 */
export async function lazySummary({ id, text, cacheFile, runner = null } = {}) {
  const key = summaryKey(id, text)
  const cache = readJsonSafe(cacheFile, {})
  if (cache[key] && cache[key].summary) {
    return { ok: true, summary: String(cache[key].summary), cached: true, via: String(cache[key].via || 'cache') }
  }
  const s = String(text || '').trim()
  if (!s) return { ok: false, cached: false, summary: '', via: 'empty' }
  if (!runner || !runner.ok) {
    // 没本地模型：不生成摘要，调用方继续用原文——不编。
    return { ok: false, cached: false, summary: '', via: 'fallback', reason: '本地模型不可用' }
  }
  try {
    const prompt = [
      '把下面这段记忆压成一句不超过 30 字的中文摘要，只回摘要本身，不要引号、不要解释。',
      s.slice(0, 400),
    ].join('\n')
    const out = String(await runner.generate(prompt, { maxTokens: 80 }) || '').trim()
    const summary = out.replace(/^["“「]+|["”」]+$/g, '').slice(0, 60)
    if (!summary) return { ok: false, cached: false, summary: '', via: 'empty' }
    cache[key] = { summary, at: new Date().toISOString(), via: runner.via, model: runner.model || '' }
    writeJsonAtomic(cacheFile, cache)
    return { ok: true, summary, cached: false, via: runner.via }
  } catch (error) {
    return { ok: false, cached: false, summary: '', via: 'error', reason: String(error?.message || error) }
  }
}

/** 摘要缓存的键：记忆 id + 原文指纹（原文变了自然失效）。 */
export function summaryKey(id, text) {
  return String(id || '') + ':' + hashOf(text)
}

/** 只读摘要缓存（注入侧同步用，不触发生成）。 */
export function readSummaryCache(file) {
  return readJsonSafe(file, {})
}

/** scope 线索：ingest 阶段把消歧结果落盘，recall 时用来补 scope。 */
export function writeScopeHint({ file, id, scope = {}, evidence = '', via = 'fallback' } = {}) {
  const key = String(id || '')
  if (!key) return { ok: false, error: '没有 id' }
  const data = readJsonSafe(file, {})
  data[key] = {
    room: String(scope.room || ''),
    person: String(scope.person || ''),
    private: scope.private !== false,
    evidence: String(evidence || '').slice(0, 120),
    via,
    at: new Date().toISOString(),
  }
  writeJsonAtomic(file, data)
  return { ok: true, id: key }
}

export function readScopeHints(file) {
  return readJsonSafe(file, {})
}