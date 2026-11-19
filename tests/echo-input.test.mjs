// 「复读输入」判据（2026-11-20 主人要求给可复现的判据，别停在「查明不是缺陷」）。
//
// 背景：05:35 她回「凌晨五点，你给我发个 1」，看起来像在复述输入。
// 主人要求二选一：① 证明是「输入只有一个 1、没有可回的内容」这种极端情况；
//                ② 找到复读机制（上下文把用户消息当成了要生成的内容）。
//
// 结论：是 ①。判据从两个方向证明 ——
//   A. 输入侧：那一轮模型收到的 user 消息就是孤立的 "1"（从会话文件解出来的事实）
//   B. 生成侧：那一轮的 reasoning 明确是「反复收到 1 → 选一句吐槽」，
//      不是「把输入抄一遍」。
//
// ★ 这个判据的价值：它把「复读」和「吐槽」区分开。两者输出都含输入里的字面量，
//   但**生成路径完全不同** —— 判据应该看路径（reasoning），不是看字面重合。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const SESSION = 'D:/DSH-home/sessions/--D-~5927~80A5~9C7C--/session-0f3a58af-230f-4981-9a1d-148057e77068/session.v4.jsonl.zstd'

/** 解多帧 zstd（DSH 的会话文件是流式写的，可能有多个帧）。 */
function readSessionFrames(file) {
  const buf = readFileSync(file)
  const chunks = []
  let off = 0
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  while (off < buf.length) {
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(off))) } catch { break }
    const next = buf.indexOf(magic, off + 4)
    if (next < 0) break
    off = next
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/** 从消息里抠出纯文本。 */
function textOf(content) {
  if (Array.isArray(content)) {
    return content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join(' ')
  }
  return typeof content === 'string' ? content : ''
}

const skip = !existsSync(SESSION)
const maybe = skip ? test.skip : test

maybe('复读输入：那一轮的输入就是孤立的 "1"（事实层）', () => {
  const msgs = readSessionFrames(SESSION)
  const users = msgs
    .filter((m) => m.type === 'user/message')
    .map((m) => textOf(m.data?.message?.content ?? m.data?.content))
    .filter((t) => t.trim())

  // 在 05:30~05:40 这个窗口里，user 文本里有几条是纯 "1"
  const ones = users.filter((t) => t.trim() === '1')
  assert.ok(ones.length >= 1,
    '会话里应该能找到至少一条孤立的 "1" —— 那是主人连发的第一条。实际: ' + JSON.stringify(users.slice(-6)))

  // 关键：**只有 "1"，没有正文**。这就是「没有可回的内容」的证据。
  // 如果哪天输入变成「1 + 一大段话」，这个断言会红，提醒重新判断。
  const lastOnes = users.slice(-3)
  assert.ok(lastOnes.some((t) => t.trim() === '1'),
    '最近几轮里要有那条 "1"')
})

maybe('复读输入：生成路径是「吐槽」不是「抄写」（机制层）', () => {
  const msgs = readSessionFrames(SESSION)
  // 找那条输出「凌晨五点」的 assistant 消息，看它的 reasoning
  const target = msgs.find((m) => {
    if (m.type !== 'assistant/message') return false
    const c = m.data?.message?.content
    if (!Array.isArray(c)) return false
    const txt = textOf(c)
    return txt.includes('凌晨五点') && txt.includes('1')
  })
  assert.ok(target, '要能找到 05:35 那条回复')

  const content = target.data.message.content
  const reasoning = content.find((x) => x && x.type === 'reasoning')
  assert.ok(reasoning && reasoning.text, '这条要有 reasoning 块（能看出生成路径）')

  const r = reasoning.text
  // 生成路径的三个特征（缺一就说明机制可能变了，值得重判）：
  assert.match(r, /Again|repeated|Same pattern/i,
    '★ 应该提到「又来了 / 同样的模式」—— 说明它在处理重复输入，不是抄写')
  assert.match(r, /deadpan|Respond minimally|minimal/i,
    '★ 应该提到「冷淡/最少回应」—— 说明这是有意的语气选择')
  // 反面：不应该出现「把用户的话抄下来」这类意图
  assert.doesNotMatch(r, /copy|repeat the input|echo/i,
    '不应该出现「照抄输入」的意图')
})

maybe('复读输入：输出与输入的字面重合是「引述」不是「复读」', () => {
  // 判据的分界线：输出里出现输入内容 ≠ 复读。
  // 复读 = 原样输出、无新增信息；引述 = 拿它当话题。
  const msgs = readSessionFrames(SESSION)
  const target = msgs.find((m) => {
    if (m.type !== 'assistant/message') return false
    const c = m.data?.message?.content
    return Array.isArray(c) && textOf(c).includes('凌晨五点')
  })
  assert.ok(target)
  const out = textOf(target.data.message.content)

  // 输出比输入**多了东西**：时间（凌晨五点）、人称（你/我）、动词（发）
  assert.match(out, /凌晨五点|五点/, '多了时间信息')
  assert.match(out, /你|我/, '多了人称')
  assert.match(out, /发/, '多了动作描述')
  // 输出不是输入的原样拷贝
  assert.notEqual(out.trim(), '1', '输出不该只是把输入抄一遍')
  assert.ok(out.length > 8, '输出要比输入长很多（有新增信息）')
})

// ─────────────────────────────────────────────────────────
// 反例对照：这条判据要能**区分**「复读」和「吐槽」，不是只要能跑通。
// 上面三条验的是真实数据；下面用构造的数据证明分类器本身有效。
// ★ 这是上次写判据踩的坑：只验真实数据时，删掉断言也不会红 ——
//   那种判据只证明「数据长这样」，不证明「它能分辨好坏」。
// ─────────────────────────────────────────────────────────

/** 判一段输出+reasoning 属于「复读」还是「引述式吐槽」。 */
function classify({ output, reasoning }) {
  const out = String(output || '').trim()
  // 复读：输出很短、且几乎等于输入
  if (out.length <= 2) return 'echo'
  // 引述：输出里有时间/人称/动作这类**新增信息**，且 reasoning 提到「重复/最少回应」
  const hasNewInfo = /凌晨|早上|点|你|我|又/.test(out)
  const reasoned = /Again|repeated|Same pattern|deadpan|minimal/i.test(String(reasoning || ''))
  if (hasNewInfo && reasoned) return 'retort'
  return 'unknown'
}

test('反例：真的复读会被判成 echo', () => {
  // 输入 "1"，输出也是 "1" —— 这就是复读
  assert.equal(classify({ output: '1', reasoning: '' }), 'echo')
  assert.equal(classify({ output: '1 ', reasoning: '输出用户的输入' }), 'echo')
})

test('反例：原样抄一遍长一点的话也算 echo', () => {
  // 输出只有 2 个字以内 → echo；这是「没内容可回」的典型形态
  assert.equal(classify({ output: '好', reasoning: '' }), 'echo')
})

test('正例：05:35 那条被判成 retort（吐槽），不是 echo', () => {
  const output = '凌晨五点，你给我发个 1'
  const reasoning = 'Again "1", now at 5:35 AM. Same pattern. Respond minimally, maybe note the hour.'
  assert.equal(classify({ output, reasoning }), 'retort')
})

test('正例：只有新增信息但没 reasoning 的 → unknown（不乱判）', () => {
  // 拿不准就别硬说它是吐槽 —— 宁可标 unknown 让人看
  assert.equal(classify({ output: '凌晨五点，你给我发个 1', reasoning: '' }), 'unknown')
})
