// 用图闸：五个验收场景 + 基本计数。
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSticker, checkText, explainReason, hasInfo, noteSend, resetState, stateFor } from '../lib/sticker-guard.mjs'

const CHAT = 'group:1'
function fresh() {
  resetState(CHAT)
  return CHAT
}

test('场景 1：被问具体数字 → 只文字（有信息不给配图）', () => {
  const chat = fresh()
  assert.equal(hasInfo('今天发了 3 条，用了 1200 token'), true)
  const got = checkSticker({ chatKey: chat, text: '今天发了 3 条，用了 1200 token', anchor: { use: '夸一句', role: '通用' } })
  assert.equal(got.ok, false)
  assert.ok(['info-bearing', 'same-bubble'].includes(got.reason))
})

test('场景 2：对方讲笑话 → 图可以发（情绪位）', () => {
  const chat = fresh()
  noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'text' })
  const got = checkSticker({ chatKey: chat, anchor: { use: '看戏', role: '通用' } })
  assert.equal(got.ok, true)
})

test('场景 3：对方说累 → 至多一张，第二张拦下', () => {
  const chat = fresh()
  for (let i = 0; i < 3; i += 1) noteSend({ chatKey: chat, kind: 'text' })
  const first = checkSticker({ chatKey: chat, anchor: { use: '哄一句', role: '对你说' } })
  assert.equal(first.ok, true)
  noteSend({ chatKey: chat, kind: 'sticker', anchor: { use: '哄一句', role: '对你说' } })
  const second = checkSticker({ chatKey: chat, anchor: { use: '哄一句', role: '对你说' } })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'too-soon')
})

test('场景 4：有人抬杠 → 文字怼，图至多一张', () => {
  const chat = fresh()
  for (let i = 0; i < 3; i += 1) noteSend({ chatKey: chat, kind: 'text' })
  assert.equal(checkSticker({ chatKey: chat, anchor: { use: '怼回去', role: '对你说' } }).ok, true)
  noteSend({ chatKey: chat, kind: 'sticker', anchor: { use: '怼回去', role: '对你说' } })
  // 文字单独发可以（不是解释图）
  assert.equal(checkText({ chatKey: chat, text: '嘴这么臭 没刷牙？' }).ok, true)
})

test('场景 5：已连发两张图 → 第三条必须纯文字', () => {
  const chat = fresh()
  noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'sticker', anchor: { use: '看戏', role: '通用' } })
  noteSend({ chatKey: chat, kind: 'sticker', anchor: { use: '看戏', role: '通用' } })
  const third = checkSticker({ chatKey: chat, anchor: { use: '看戏', role: '通用' } })
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'after-two')
})

test('一条多图 / 图文同气泡：都拦', () => {
  const chat = fresh()
  for (let i = 0; i < 3; i += 1) noteSend({ chatKey: chat, kind: 'text' })
  assert.equal(checkSticker({ chatKey: chat, images: 2 }).reason, 'multi-image')
  assert.equal(checkSticker({ chatKey: chat, text: '给你看' }).reason, 'same-bubble')
})

test('图配解释文字：拦下这条文字', () => {
  const chat = fresh()
  for (let i = 0; i < 3; i += 1) noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'sticker', anchor: { use: '摆烂给他看', role: '说我' } })
  assert.equal(checkText({ chatKey: chat, text: '这张图就是我现在的心情' }).reason, 'explains-sticker')
  assert.equal(checkText({ chatKey: chat, text: '我也想摆烂' }).reason, 'same-meaning')
  assert.equal(checkText({ chatKey: chat, text: '我去吃饭了' }).ok, true)
})

test('普通闲聊 3–5 轮一张：不到 3 轮不发', () => {
  const chat = fresh()
  noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'text' })
  assert.equal(checkSticker({ chatKey: chat }).reason, 'too-soon')
  noteSend({ chatKey: chat, kind: 'text' })
  assert.equal(checkSticker({ chatKey: chat }).ok, true)
})

test('文字轮数会把连发计数清零', () => {
  const chat = fresh()
  for (let i = 0; i < 3; i += 1) noteSend({ chatKey: chat, kind: 'text' })
  noteSend({ chatKey: chat, kind: 'sticker' })
  noteSend({ chatKey: chat, kind: 'sticker' })
  assert.equal(stateFor(chat).consecutiveStickers, 2)
  noteSend({ chatKey: chat, kind: 'text' })
  assert.equal(stateFor(chat).consecutiveStickers, 0)
})

test('每个理由都有中文说明', () => {
  for (const reason of ['multi-image', 'same-bubble', 'info-bearing', 'after-two', 'too-soon', 'explains-sticker', 'same-meaning']) {
    const text = explainReason(reason)
    assert.ok(text && text !== reason, reason + ' 没有中文说明')
  }
})