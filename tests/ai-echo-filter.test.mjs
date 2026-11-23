// AI 味句式过滤器判据（2026-11-21 主人要求二）。
//
// ★ 硬约束：这些句子**只进代码，不进人设 / 前缀 / 系统提示**。
//   主人早就定过：每轮进上下文的禁词会形成语义引力井（白熊效应），越写越容易撞上。
//   所以本文件里有专门一条去 grep 人设卡与系统提示，确认这些句子一个字都没有。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  AI_ECHO_PATTERNS,
  AI_ECHO_REASON,
  detectAiEcho,
  shouldBlockAiEcho
} from '../lib/ai-echo-filter.mjs'
import { createOutboundGate } from '../lib/outbound-gate.mjs'

// ─────────────── 该拦的（主人点名的那批） ───────────────

const SHOULD_BLOCK = [
  '这句话稳',
  '这话稳',
  '比之前的都重',
  '比之前的都轻',
  '比刚才稳',
  '我记下了',
  '我记住了',
  '我记得了',
  '这个账我记住了',
  '这话我记着',
  '睡吧，我守着',
  '我守着',
  '我不拦',
  '我不催',
  '你去，我跟',
  '行，我认',
  '什么心思都写着脸上',
  '问别人还是问自己',
  '说的比谁都响',
  '你自己掂量',
  '这话接得漂亮'
]

// ─────────────── 不许误杀的（正常鱼话） ───────────────

const SHOULD_PASS = [
  '6',
  '？',
  '草',
  '睡吧',
  '白饭',
  '不知道',
  '我认错',          // 「我认」后面接「错」，不是"认下这句"
  '稳',              // 单个字是正常反应词
  '好',
  '嗯',
  '难绷',
  '刚才那个图呢',
  '我记性不好',      // 提到"记"但不是旁白式自述
  '你先睡',
  '我不饿',
  '我在想一件事',
  '这名字难绷',
  '哈哈哈哈'
]

test('该拦的：主人点名的那批句式都能识别', () => {
  const missed = []
  for (const t of SHOULD_BLOCK) {
    if (!detectAiEcho(t).hit) missed.push(t)
  }
  assert.deepEqual(missed, [], '这些没识别出来：' + JSON.stringify(missed))
})

test('★ 不许误杀：正常鱼话一条都不许拦', () => {
  const wrongKilled = []
  for (const t of SHOULD_PASS) {
    if (detectAiEcho(t).hit) wrongKilled.push(t)
  }
  assert.deepEqual(wrongKilled, [],
    '★ 误杀比漏掉更糟（漏掉难听一次，误杀让她说不出话）：' + JSON.stringify(wrongKilled))
})

test('过滤器返回的样本只有模式编号，不含被命中的原文', () => {
  // ★ 这点很重要：如果把命中的词回传出去，日志回灌时等于又念了一遍八股
  const r = shouldBlockAiEcho('这句话稳')
  assert.equal(r.blocked, true)
  assert.equal(r.reason, AI_ECHO_REASON)
  for (const s of r.samples) {
    assert.match(s, /^pattern#\d+$/, '样本只该是模式编号，实际: ' + s)
  }
  assert.doesNotMatch(JSON.stringify(r.samples), /稳/, '★ 不许把原文带出来')
})

test('空消息不拦（那不是 AI 味，是没内容）', () => {
  assert.equal(detectAiEcho('').hit, false)
  assert.equal(detectAiEcho('   ').hit, false)
})

// ─────────────── 出站闸里真的生效 ───────────────

test('出站闸：AI 味句式被拦，gate 标 custom + reason=ai-echo', () => {
  const gate = createOutboundGate({ config: () => ({}), log: () => {} })
  const r = gate.check({ chatKey: 'private:1', text: '这句话稳' })
  assert.equal(r.ok, false, '★ 要真的被拦下')
  assert.equal(r.reason, 'ai-echo')
  assert.ok(Array.isArray(r.echoPatterns), '要带模式编号（不带原文）')
})

test('出站闸：正常鱼话照常放行', () => {
  const gate = createOutboundGate({ config: () => ({}), log: () => {} })
  for (const t of ['6', '白饭', '睡觉', '不知道']) {
    const r = gate.check({ chatKey: 'private:2', text: t })
    assert.equal(r.ok, true, '不该拦：' + t)
  }
})

test('出站闸：拦下时不消耗发言额度（失败不占额度）', () => {
  const gate = createOutboundGate({ config: () => ({ maxPerHour: 3 }), log: () => {} })
  // 连拦 5 次
  for (let i = 0; i < 5; i++) gate.check({ chatKey: 'private:3', text: '我记下了' })
  // 正常的还能发（说明拦截没占额度）
  const ok = gate.check({ chatKey: 'private:3', text: '好' })
  assert.equal(ok.ok, true, '被拦下的不该占额度')
})

// ─────────────── ★ 核心约束：不进上下文 ───────────────

/** 递归找文件。 */
function walk(dir, out = []) {
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git') continue
    const p = join(dir, n)
    let st = null
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(mjs|js|md|txt|dart)$/.test(n)) out.push(p)
  }
  return out
}

test('★★ 硬约束：这些句子不许出现在人设 / 系统提示里', () => {
  // 人设/提示词可能落的地方：
  //   · DSH_HOME/fish-world-personas/*.md   ← 角色人设卡（真实位置，实测）
  //   · 插件里拼提示词的几个模块
  const MD_DIR = 'D:/DSH-home/fish-world-personas'
  const codeFiles = [
    'lib/fish-snapshot.mjs',
    'lib/qq-inbox.mjs',
    'lib/chat-context.mjs',
    'lib/fish-tone.mjs',
    'lib/human-speech.mjs'
  ]

  const offenders = []
  const scan = (label, src, allowInComment) => {
    for (const phrase of SHOULD_BLOCK) {
      let idx = -1
      while ((idx = src.indexOf(phrase, idx + 1)) >= 0) {
        const before = src.slice(Math.max(0, idx - 80), idx)
        const after = src.slice(idx + phrase.length, idx + phrase.length + 80)
        if (allowInComment) {
          // 代码文件：允许出现在注释里（解释为什么这么做），不许在字符串里
          const inString = /['"`]\s*$/.test(before) && /^\s*['"`]/.test(after)
          if (inString) offenders.push(label + ' :: ' + phrase)
        } else {
          // markdown 人设卡：出现在正文任何地方都不行（那就是在给模型看）
          offenders.push(label + ' :: ' + phrase)
        }
      }
    }
  }

  // ① 人设卡（markdown）
  let mds = []
  try { mds = readdirSync(MD_DIR).filter((n) => n.endsWith('.md')) } catch {}
  for (const n of mds) {
    let src = ''
    try { src = readFileSync(join(MD_DIR, n), 'utf8') } catch { continue }
    scan('personas/' + n, src, false)
  }
  assert.ok(mds.length > 0, '要能读到人设卡（否则这条判据在空转）')

  // ② 拼提示词的代码（只看字符串）
  for (const rel of codeFiles) {
    let src = ''
    try { src = readFileSync(rel, 'utf8') } catch { continue }
    scan(rel, src, true)
  }

  assert.deepEqual(offenders, [],
    '★ 这些句子出现在人设/提示词里了（会形成语义引力井）：' + JSON.stringify(offenders))
})

test('★★ 过滤器只在出站路径被引用，不在提示词拼装处', () => {
  // ★ 2026-11-21：qq-inbox.mjs 现在是合法的引用方 —— 它在 sendBubbles 里做
  //   「评论员兜底」（丢掉点评句 / 整条不发）。那是**出站过滤**，不是提示词。
  //
  //   真正要防的是：有人拿它去生成提示词（比如把禁词清单拼进 system prompt）。
  //   所以判据改成「引用点必须在发送相关的函数里，且不能出现在拼提示词的函数里」。
  const PIN = [
    'lib/qq-inbox.mjs',
    'lib/fish-snapshot.mjs',
    'lib/chat-context.mjs',
    'lib/fish-tone.mjs'
  ]
  // 拼提示词的函数名（出现这些名字的函数体里不该调过滤器）
  const PROMPT_FUNCS = ['systemMemoryBrief', 'buildPrompt', 'buildContext', 'systemPrompt', 'personaText']

  const offenders = []
  for (const rel of PIN) {
    let src = ''
    try { src = readFileSync(rel, 'utf8') } catch { continue }
    if (!src.includes('ai-echo-filter')) continue

    // 找出所有调用点，看它在哪个函数里
    for (const m of src.matchAll(/(detectAiEcho|stripCommentary|shouldBlockAiEcho)\s*\(/g)) {
      const at = m.index
      // 往回找最近的函数声明
      const before = src.slice(0, at)
      const fnMatch = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)].pop()
      const fn = fnMatch ? (fnMatch[1] || fnMatch[2] || '') : ''
      if (PROMPT_FUNCS.some((p) => fn.toLowerCase().includes(p.toLowerCase()))) {
        offenders.push(rel + ' :: ' + fn + ' :: ' + m[1])
      }
    }
  }
  assert.deepEqual(offenders, [],
    '★ 过滤器不许出现在拼提示词的函数里（那等于把清单送进上下文）：' + JSON.stringify(offenders))
})

test('★★ 过滤器文件本身不导出任何"给提示词用"的文本', () => {
  const src = readFileSync('lib/ai-echo-filter.mjs', 'utf8')
  // 不许导出成段的说明文字（那种东西很容易被拼进 prompt）
  const exports = [...src.matchAll(/export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  assert.ok(exports.includes('detectAiEcho'), '要有检测函数')
  assert.ok(exports.includes('stripCommentary'), '要有剥离函数')
  // AI_ECHO_PATTERNS 是正则数组，不是给模型看的文本 —— 但要确认没被别处拼进 prompt
  assert.ok(exports.includes('AI_ECHO_PATTERNS'))
  // 关键：它不导出任何 `prompt` / `instruction` / `hintToModel` 之类的东西
  for (const name of exports) {
    assert.doesNotMatch(name, /prompt|instruction|hint|tellModel/i,
      '★ 不许导出给提示词用的东西：' + name)
  }
})

test('★★ 人设卡的正面锚定还在（不是靠禁词，是靠正向写法）', () => {
  // 主人要求：人设层**只放正向锚定**，禁词不进上下文。
  // 下面这些是**人设卡里实际有的原文**（2026-11-21 核对过 default.md），
  // 不是按主人表述猜的词 —— 猜的词会让判据假红。
  const MD_DIR = 'D:/DSH-home/fish-world-personas'
  // ★ 2026-11-21 人设瘦身后：只保留确实在卡里、且是正向锚定的说法。
  //   「不给自己加旁白」带"不"字，瘦身时连同其它负面规约一起删了 ——
  //   它的作用改由执行层承担（judgeReply 的自述式旁白那类）。
  //   判据改成验"留下来的正向锚定"。
  // ★ 2026-11-24 换卡（主人定的第一人称字）⇒ 改成**等价候选组：每组任一命中**（方案 A）——
  //   同一件事措辞不同不算缺：新卡写「短、碎、口语」「顺着往下走一层」（少了「它」）。
  const wanted = [
    ['短句', '短、碎', '一条 1–10 字', '能一个字说完'],     // 说话要短（正向锚定）
    ['顺着它往下走一层', '顺着往下走一层'],                 // 对方递来歪理时的正解
    ['回应的是人'],                                          // 回应的是人，不是文本
  ]
  const all = []
  let mds = []
  try { mds = readdirSync(MD_DIR).filter((n) => n.endsWith('.md')) } catch {}
  for (const n of mds) {
    try { all.push(readFileSync(join(MD_DIR, n), 'utf8')) } catch { /* 单个读不到就跳过，别的还算 */ }
  }
  const blob = all.join('\n')
  const missing = wanted.filter((group) => !group.some((w) => blob.includes(w)))
  assert.deepEqual(missing, [],
    '★ 人设里该有正向锚定，缺了：' + JSON.stringify(missing) + '（禁词不是替代品；每组任一等价说法即可）')
})

test('模式表本身是可枚举的（便于以后加），且全部是正则', () => {
  assert.ok(AI_ECHO_PATTERNS.length >= 20, '至少要覆盖主人点名的那批')
  for (const re of AI_ECHO_PATTERNS) {
    assert.ok(re instanceof RegExp, '模式表里只该有正则')
  }
})
