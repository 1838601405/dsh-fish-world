// 重构判据（2026-11-21 主人要求「把方法论从每轮上下文里拿出去」）。
//
// 根因：每条群消息都带约 250 字规约，里面有「不要把你判断写进消息里」这种元指令，
// 也点名了被拉黑的句子。后果：她每轮都在自我检查，于是说出「对，我在先总结再挑一句」——
// 那不是接话，是被规约训练出来的自我监控。
//
// 三步改造：
//   一、每轮上下文只放「现场」，不放「方法」（GROUP_CHAT_HINT ≤60 字）
//   二、人设卡瘦身（≤3000 字，负面规约 ≤3 条且全是安全类）
//   三、执行层兜底（保留，但只做兜底）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const PERSONA = 'D:/DSH-home/fish-world-personas/default.md'

function persona() {
  return readFileSync(PERSONA, 'utf8')
}

/** 去掉误判词后的负面规约行。 */
function negativeRules(text) {
  const NEG = /(?:不要|别|禁止|不许|不准|不能|切勿)/
  // 这些词里的「别」不是规约
  const FALSE = ['别人', '告别', '区别', '分别', '特别', '别的', '个别', '类别', '级别', '派别', '别家']
  const out = []
  for (const raw of String(text).split('\n')) {
    if (!NEG.test(raw)) continue
    let cleaned = raw
    for (const w of FALSE) cleaned = cleaned.split(w).join('')
    if (!NEG.test(cleaned)) continue
    out.push(raw.trim())
  }
  return out
}

/**
 * 取 GROUP_CHAT_HINT 的**完整**值。
 *
 * ★ 踩过的坑：原来的 HINT 是 `'...' + '...' + '...'` 多行拼接，
 *   最初的正则只抓了第一段 —— 于是「改回原版」时判据抓不到，
 *   反证 e 只红了一条。现在把整个声明（到第一个换行后的非 + 行）拼起来。
 */
function groupChatHint() {
  const src = readFileSync('lib/qq-inbox.mjs', 'utf8')
  const start = src.indexOf('const GROUP_CHAT_HINT =')
  if (start < 0) throw new Error('找不到 GROUP_CHAT_HINT')
  const lines = src.slice(start).split('\n')
  const pieces = []
  // ★ 判据：**下一行**是不是以 + 开头，而不是"本行有没有 +"。
  //   踩过的坑：第一行 `const HINT = '第一段'` 末尾是单引号不带 +，
  //   用"本行不带 + 就停"会立刻退出，只取到第一段 —— 于是原版 250 字被当成 56 字，
  //   反证 e 只红了一条。
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const m of line.matchAll(/'([^']*)'/g)) pieces.push(m[1])
    const next = (lines[i + 1] || '').trim()
    if (!next.startsWith('+')) break
  }
  return pieces.join('')
}


/** 安全类判定：不越权 / 不泄密 / 不骂人。 */
function isSecurityRule(line) {
  return /越权|泄密|隐私|密码|令牌|骂人|人身攻击|底线|不伤人|不真生气|不上纲/.test(line)
}

// ══════════ 一、每轮上下文只放现场 ══════════

test('★★ GROUP_CHAT_HINT ≤60 字', () => {
  const src = readFileSync('lib/qq-inbox.mjs', 'utf8')
  const hint = groupChatHint()
  assert.ok(hint.length > 0, '要能找到 GROUP_CHAT_HINT')
  assert.ok(hint.length <= 60,
    '★ 要压到 60 字以内（现在 ' + hint.length + ' 字）：' + hint)
})

test('★★ GROUP_CHAT_HINT 里没有元指令', () => {
  const hint = groupChatHint()

  // 「不要…」「别…」类元指令一个都不许有
  for (const bad of ['不要', '别', '禁止', '不许', '不准']) {
    assert.equal(hint.includes(bad), false,
      '★ 上下文里不许有元指令「' + bad + '」：' + hint)
  }
})

test('★★ GROUP_CHAT_HINT 里没有点名禁句', () => {
  const hint = groupChatHint()

  // 主人点名的那批句子一个都不许出现在上下文里
  const banned = [
    '这条我记下了',
    '不是…而是',
    '不是...而是',
    '我在先',
    '已升级',
    '已被拉黑',
    '拉黑'
  ]
  for (const b of banned) {
    assert.equal(hint.includes(b), false,
      '★ 上下文里不许出现禁止用词「' + b + '」')
  }
})

test('GROUP_CHAT_HINT 只含事实性信息（谁在说 / 看得到什么 / 怎么查）', () => {
  const hint = groupChatHint()
  // 正向锚定：要有「看得到」和「可以查」这类事实
  assert.match(hint, /看得到|看得见/, '要说明看得到什么')
  assert.match(hint, /查/, '要说明更早的可以查')
})

// ══════════ 二、人设卡瘦身 ══════════

test('★★ 人设卡 ≤3000 字（去空白）', () => {
  const text = persona()
  const chars = text.replace(/\s/g, '').length
  assert.ok(chars <= 3000,
    '★ 人设卡要瘦到 3000 字以内（现在 ' + chars + ' 字）')
})

test('★★ 人设卡负面规约 ≤3 条', () => {
  const rules = negativeRules(persona())
  assert.ok(rules.length <= 3,
    '★ 负面规约要 ≤3 条（现在 ' + rules.length + ' 条）：\n  ' + rules.join('\n  '))
})

test('★★ 剩下的负面规约必须全是安全类', () => {
  const rules = negativeRules(persona())
  const nonSecurity = rules.filter((r) => !isSecurityRule(r))
  assert.deepEqual(nonSecurity, [],
    '★ 负面规约只允许安全类（不越权/不泄密/不骂人），这些不是：\n  ' + nonSecurity.join('\n  '))
})

test('★★ 人设卡里没有写作规约（不排比/不总结/不三段式）', () => {
  const text = persona()
  const writingRules = [
    '不排比',
    '不三段式',
    '不段尾总结',
    '不「这意味着」',
    '不总结',
    '别把话说圆'
  ]
  const found = writingRules.filter((r) => text.includes(r))
  assert.deepEqual(found, [],
    '★ 写作规约该放执行层（代码），不该在她每轮读的文本里：' + JSON.stringify(found))
})

test('人设卡保留身份 / 说话习惯 / 例子', () => {
  const text = persona()
  // 身份
  assert.match(text, /你是 DeepSeek/, '要保留身份')
  assert.match(text, /小鲸鱼/, '要保留自我认知')
  // 说话习惯
  assert.match(text, /怎么说话/, '要保留说话那一节')
  // 例子
  assert.match(text, /你到底是人是AI/, '要保留例子')
  const examples = (text.match(/群友：/g) || []).length
  assert.ok(examples >= 3, '★ 至少保留三个例子（现在 ' + examples + ' 个）')
})

// ══════════ 三、执行层兜底还在 ══════════

test('★ 执行层仍在（兜底不是主要手段，但不能没有）', () => {
  const src = readFileSync('lib/execution-gate.mjs', 'utf8')
  assert.match(src, /export function judgeReply/, '三闸还在')
  assert.match(src, /export function buildRewriteInstruction/, '重写还在')
  assert.match(src, /export function pickMinimalReaction/, '兜底还在')
})

test('★ 执行层不进上下文（只做兜底，不教她说话）', () => {
  // 执行层的规则不该出现在人设卡里
  const text = persona()
  const gateWords = ['通篇', '只有…那句是真的', '我在先总结']
  const found = gateWords.filter((w) => text.includes(w))
  assert.deepEqual(found, [],
    '★ 执行层的规则不该写进人设（那会形成语义引力井）：' + JSON.stringify(found))
})

// ══════════ 反证准备：改造前后可对比 ══════════

test('备份还在（能对比改造前后）', () => {
  // 改造前的备份必须留着，否则 e) 反证做不了
  const dir = 'D:/DSH-home/fish-world-personas'
  const files = readdirSync(dir).filter((n) => n.includes('r-persona-slim'))
  assert.ok(files.length > 0,
    '要留着改造前的备份（用于 e 反证和 d 对比）。现有备份：' + files.join(', '))
})
