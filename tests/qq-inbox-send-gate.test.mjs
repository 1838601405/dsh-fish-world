// 发前闸接线：5 条带病文本一条都不许发出去，正常鱼话原样发。
// 用假 qq + 假 world，不连真 QQ。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createQQInbox } from '../lib/qq-inbox.mjs'

function makeInbox() {
  const root = mkdtempSync(join(tmpdir(), 'fw-send-gate-'))
  mkdirSync(join(root, '鱼的记忆'), { recursive: true })
  writeFileSync(join(root, '鱼的记忆', '梗百科-禁用条目.json'), JSON.stringify({
    version: 1,
    blockedTags: [],
    entries: [{ title: '五十万', why: '涉政' }],
  }), 'utf8')
  const sent = []
  const qq = {
    send: async (chatKey, content) => { sent.push({ chatKey, text: content.map((c) => c.text).join('') }); return { ok: true } },
    sendTextBatch: async (chatKey, parts) => { sent.push({ chatKey, text: parts.join('\n') }); return { ok: true } },
    isMuted: () => false,
    recent: () => [],
    recentSent: () => [],
    bridgeConfig: () => ({}),
  }
  const world = { status: () => ({ worldPath: root }), listRelations: () => ({ owner: {} }) }
  const inbox = createQQInbox({ qq, world, deliver: async () => ({ ok: true }) })
  return { inbox, sent, root }
}

const POISON = [
  '<invoke name="fish_tone">\n<parameter name="text">嗯</parameter>\n</invoke>',
  '## 今天总结\n吃了白饭',
  '- 第一条\n- 第二条',
  '您好，请问有什么可以帮您？如有需要请随时告诉我。',
  '作为一个AI助手，我不能回答这个问题。',
]

test('5 条带病文本一条病句都没发出去（允许剥掉坏行后剩下的真话）', async () => {
  const { inbox, sent } = makeInbox()
  for (const text of POISON) {
    await inbox._sendBubblesForTest('private:1', text)
  }
  for (const row of sent) {
    assert.ok(!row.text.includes('<invoke'), '泄漏了工具语法：' + row.text)
    assert.ok(!/^\s*#{1,6}\s/m.test(row.text), '泄漏了 markdown 标题：' + row.text)
    assert.ok(!/^\s*[-*+]\s/m.test(row.text), '泄漏了 markdown 列表：' + row.text)
    assert.ok(!row.text.includes('您好'), '泄漏了客服腔：' + row.text)
    assert.ok(!row.text.includes('作为一个'), '泄漏了自我介绍：' + row.text)
  }
  // 纯工具语法那条不该产出任何气泡
  const only = await inbox._sendBubblesForTest('private:1', POISON[0])
  assert.equal(only.ok, false)
})

test('正常鱼话原样发出去', async () => {
  const { inbox, sent } = makeInbox()
  const out = await inbox._sendBubblesForTest('private:1', '白饭')
  assert.equal(out.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '白饭')
})

test('禁用条目出现就整条不发', async () => {
  const { inbox, sent } = makeInbox()
  const out = await inbox._sendBubblesForTest('private:1', '这个可以看五十万那个梗')
  assert.equal(out.ok, false)
  assert.equal(sent.length, 0)
})

test('八股整段只发最短那句', async () => {
  const { inbox, sent } = makeInbox()
  const text = '宁可少挣点，也不能坏了规矩，先把规矩立住，路才能越走越宽，用料实在，吃了才不烧心'
  const out = await inbox._sendBubblesForTest('private:1', text)
  assert.equal(out.ok, true)
  assert.equal(sent.length, 1)
  assert.ok(sent[0].text.length < text.length, '应当只发最短那句')
  assert.ok(text.includes(sent[0].text), '发出去的那句必须是原文里的片段')
})
