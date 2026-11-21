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

test('★★ 过滤器文件本身不被 prompt 引用', () => {
  // ai-echo-filter.mjs 只该被 outbound-gate.mjs 引用；
  // 被提示词相关文件引用 = 清单进了上下文
  const all = walk('lib')
  const referrers = []
  for (const f of all) {
    let src = ''
    try { src = readFileSync(f, 'utf8') } catch { continue }
    if (!src.includes('ai-echo-filter')) continue
    const rel = f.replace(/\\/g, '/')
    if (rel.endsWith('lib/ai-echo-filter.mjs')) continue
    if (rel.endsWith('lib/outbound-gate.mjs')) continue
    referrers.push(rel)
  }
  assert.deepEqual(referrers, [],
    '★ 只有 outbound-gate 能引用它（别的文件引用 = 清单可能漏进上下文）：' + JSON.stringify(referrers))
})

test('★★ 人设卡的正面锚定还在（不是靠禁词，是靠正向写法）', () => {
  // 主人要求：人设层**只放正向锚定**，禁词不进上下文。
  // 下面这些是**人设卡里实际有的原文**（2026-11-21 核对过 default.md），
  // 不是按主人表述猜的词 —— 猜的词会让判据假红。
  const MD_DIR = 'D:/DSH-home/fish-world-personas'
  const wanted = [
    '短句',              // L37/L75/L105
    '不给自己加旁白',    // L108 ← 这条正是 AI 味旁白的正向说法
    '具体优先'           // L110
  ]
  const found = new Set()
  let mds = []
  try { mds = readdirSync(MD_DIR).filter((n) => n.endsWith('.md')) } catch {}
  for (const n of mds) {
    let src = ''
    try { src = readFileSync(join(MD_DIR, n), 'utf8') } catch { continue }
    for (const w of wanted) if (src.includes(w)) found.add(w)
  }
  const missing = wanted.filter((w) => !found.has(w))
  assert.deepEqual(missing, [],
    '★ 人设里该有正向锚定，缺了：' + JSON.stringify(missing) + '（禁词不是替代品）')
})

test('模式表本身是可枚举的（便于以后加），且全部是正则', () => {
  assert.ok(AI_ECHO_PATTERNS.length >= 20, '至少要覆盖主人点名的那批')
  for (const re of AI_ECHO_PATTERNS) {
    assert.ok(re instanceof RegExp, '模式表里只该有正则')
  }
})
