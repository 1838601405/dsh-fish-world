// 双阶连携（herframe 设计移植）判据。
// 入口攒 1.2 秒（硬顶 3 秒）/ 发话前认领补充 / 带图视频不吸收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  LINK_HARD_CAP_MS,
  LINK_QUIET_MS,
  createLinkTracker,
  hasMedia,
  linkDecision,
  splitSupplements,
  supplementNotice
} from '../lib/link-batch.mjs'

// ─── 时长约定 ───

test('入口攒 1.2 秒、硬顶 3 秒', () => {
  assert.equal(LINK_QUIET_MS, 1200)
  assert.equal(LINK_HARD_CAP_MS, 3000)
})

// ─── 该不该投 ───

test('安静不到 1.2 秒不投', () => {
  const r = linkDecision({ firstAt: 1000, lastAt: 1000, messages: [{}] }, 1000 + 800)
  assert.equal(r.flush, false)
  assert.equal(r.reason, 'waiting')
})

test('安静满 1.2 秒就投', () => {
  const r = linkDecision({ firstAt: 1000, lastAt: 1000, messages: [{}] }, 1000 + 1200)
  assert.equal(r.flush, true)
  assert.equal(r.reason, 'quiet')
})

test('硬顶 3 秒：一直有零碎消息也要投', () => {
  // 每秒都来一条，安静窗口永不满足，但硬顶到了
  const r = linkDecision({ firstAt: 1000, lastAt: 1000 + 2900, messages: [{}] }, 1000 + 3000)
  assert.equal(r.flush, true)
  assert.equal(r.reason, 'hard-cap')
})

test('空桶不投', () => {
  assert.equal(linkDecision(null, 1000).flush, false)
  assert.equal(linkDecision({ firstAt: 0 }, 1000).flush, false)
})

// ─── 带图/视频不吸收 ───

test('hasMedia 认图、视频、mface', () => {
  assert.equal(hasMedia({ images: [{ file: 'a.png' }] }), true)
  assert.equal(hasMedia({ videos: ['http://x'] }), true)
  assert.equal(hasMedia({ parts: [{ kind: 'image' }] }), true)
  assert.equal(hasMedia({ parts: [{ kind: 'mface' }] }), true)
  assert.equal(hasMedia({ text: '纯文字' }), false)
})

test('拆分：纯文字补充进 supplements，带图进 others', () => {
  const msgs = [
    { userId: 'u1', text: '今天好累' },
    { userId: 'u1', text: '不想动' },
    { userId: 'u1', text: '看这个', images: [{ file: 'a.png' }] },
    { userId: 'u2', text: '别人说的话' }
  ]
  const r = splitSupplements(msgs)
  assert.equal(r.main.text, '今天好累')
  assert.deepEqual(r.supplements.map((m) => m.text), ['不想动'], '带图的和别人的都不算补充')
  assert.equal(r.others.length, 2)
})

test('拆分：换人说话不算补充', () => {
  const msgs = [
    { userId: 'u1', text: 'A' },
    { userId: 'u2', text: 'B' }
  ]
  const r = splitSupplements(msgs)
  assert.equal(r.supplements.length, 0)
  assert.equal(r.others.length, 1)
})

test('拆分：单条没有补充', () => {
  const r = splitSupplements([{ userId: 'u1', text: '只有一句' }])
  assert.equal(r.supplements.length, 0)
  assert.equal(r.others.length, 0)
})

// ─── 认领提示 ───

test('有补充时如实告知，且把决定权交给她', () => {
  const notice = supplementNotice([{ text: '不想动' }, { text: '饭也不想吃' }])
  assert.match(notice, /又补了 2 句/)
  assert.match(notice, /不想动/)
  assert.match(notice, /饭也不想吃/)
  // 不许替她决定
  assert.match(notice, /可以/)
  assert.doesNotMatch(notice, /必须改写|一定要提/)
})

test('没有补充就不加任何东西', () => {
  assert.equal(supplementNotice([]), '')
  assert.equal(supplementNotice(null), '')
  assert.equal(supplementNotice([{ text: '   ' }]), '')
})

test('补充句子太长要截断（防撑爆上下文）', () => {
  const long = 'あ'.repeat(200)
  const notice = supplementNotice([{ text: long }])
  assert.ok(notice.length < long.length, '要截断')
  assert.match(notice, /…/)
})

// ─── 状态机 ───

test('状态机：攒同一会话的多条，1.2 秒后该投', () => {
  let t = 1_000_000
  const tr = createLinkTracker({ now: () => t })
  tr.touch('private:1', { userId: 'u1', text: '第一句' })
  t += 400
  tr.touch('private:1', { userId: 'u1', text: '第二句' })
  assert.equal(tr.decide('private:1').flush, false)
  t += 1200
  const d = tr.decide('private:1')
  assert.equal(d.flush, true)
  assert.equal(d.reason, 'quiet')
  // take 之后桶清空
  const b = tr.take('private:1')
  assert.equal(b.messages.length, 2)
  assert.equal(tr.peek('private:1'), null)
})

test('状态机：不同会话互不影响', () => {
  let t = 1_000_000
  const tr = createLinkTracker({ now: () => t })
  tr.touch('private:1', { text: 'a' })
  tr.touch('group:2', { text: 'b' })
  assert.equal(tr.size(), 2)
  t += 1300
  assert.equal(tr.decide('private:1').flush, true)
  assert.equal(tr.decide('group:2').flush, true)
})

// ─── 接进 mergeBatch（源码级） ───

test('mergeBatch 真的把补充认领进去（接线判据）', () => {
  const src = readFileSync('lib/qq-inbox.mjs', 'utf8')
  assert.match(src, /splitSupplements/, '要调拆分函数')
  assert.match(src, /supplementNotice/, '要调提示生成')
  // 必须在截断之后拼（否则提示会被截掉一半）
  const cut = src.indexOf('if (text.length > 上限)')
  const noticeUse = src.indexOf('const notice = supplementNotice')
  assert.ok(cut > 0 && noticeUse > cut, '认领提示要加在正文截断之后')
})
