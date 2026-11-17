import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCandidate,
  extractQuote,
  repeatedQuote,
  findDuplicate,
  buildPendingItem,
  splitForPrompt,
} from '../lib/meme-capture.mjs'

test('梗句式能被抽成候选', () => {
  const c = extractCandidate('v我50')
  assert.equal(c.name, 'v我50')
  assert.equal(c.kind, 'meme')
  const d = extractCandidate('这也太抽象了吧是什么鬼')
  assert.equal(d.name, '是什么鬼')
  assert.match(d.why, /梗句式/)
})

test('引号里的新词被抽出来', () => {
  const c = extractCandidate('他说这叫「赛博上坟」')
  assert.equal(c.name, '赛博上坟')
})

test('普通长句不是候选', () => {
  assert.equal(extractCandidate('今天天气不错，我去楼下买了个西瓜顺便看了会儿猫'), null)
})

test('长文本 / 段子被抽成语录候选：首句摘要 + 关键句', () => {
  const text = 'AI文案三大定律：不是而是定律、主语不动定律、化简为繁定律。以后靠这个简单分辨AI文案。'
  const q = extractQuote({ text })
  assert.equal(q.kind, 'quote')
  assert.ok(q.name.length <= 24)
  assert.match(q.name, /AI文案三大定律/)
  assert.match(q.meaning, /不是而是定律/)
  assert.equal(q.sentence, text)
})

test('引用体 / 多人对话也算语录', () => {
  assert.ok(extractQuote({ text: '甲「这是什么」\n乙「不知道」\n甲「典中典」' }))
  assert.ok(extractQuote({ text: '「赛博上坟」：给已经停更的号留言，像上坟一样' }))
})

test('普通短句不会误判成语录', () => {
  assert.equal(extractQuote({ text: '白饭' }), null)
  assert.equal(extractQuote({ text: '今天天气不错，我下楼买了杯咖啡' }), null)
})

test('语录的 meaning 不是待确认占位', () => {
  const it = buildPendingItem({ name: 'AI文案三大定律', kind: 'quote', meaning: '转折永远是最重要的部分', sentence: '全文', now: 1 })
  assert.equal(it.type, 'quote')
  assert.equal(it.status, 'pending')
  assert.equal(it.meaning, '转折永远是最重要的部分')
  const fallback = buildPendingItem({ name: '某段子', kind: 'quote', sentence: '整段原文', now: 2 })
  assert.equal(fallback.meaning, '整段原文')
})

test('同一句被多人重复才算语录候选', () => {
  assert.equal(repeatedQuote({ text: '难绷', speakers: ['a'], count: 3 }), null)
  const q = repeatedQuote({ text: '今天也是白饭的一天', speakers: ['a', 'b'], count: 2 })
  assert.equal(q.kind, 'quote')
})

test('去重：name 或别名命中就复用原条目', () => {
  const items = [{ id: 'x', name: 'v我50', aliases: ['疯狂星期四'] }]
  assert.equal(findDuplicate(items, 'v我50').id, 'x')
  assert.equal(findDuplicate(items, '疯狂星期四').id, 'x')
  assert.equal(findDuplicate(items, '赛博上坟'), null)
})

test('待确认条目字段沿用现有知识库', () => {
  const it = buildPendingItem({
    name: '赛博上坟',
    kind: 'meme',
    why: '被引号括起来的新词',
    sentence: '他说这叫「赛博上坟」',
    source: '群 肘击全世界(681145756) · 2026-11-17 23:40 · 墨墨',
    now: 1795000000000,
  })
  assert.equal(it.type, 'meme')
  assert.equal(it.status, 'pending')
  assert.equal(it.meaning, '待确认')
  assert.ok(it.source.includes('681145756'))
  assert.ok(it.quote.includes('赛博上坟'))
})

test('回复只用 confirmed；pending 单独拿', () => {
  const r = splitForPrompt([
    { name: 'a', status: 'confirmed' },
    { name: 'b', status: 'pending' },
    { name: 'c' },
  ])
  assert.deepEqual(r.confirmed.map((x) => x.name), ['a', 'c'])
  assert.deepEqual(r.pending.map((x) => x.name), ['b'])
})
