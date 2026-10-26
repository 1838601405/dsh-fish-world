// 漏出来的内部盘算：模型偶尔把「我在盘算怎么回」当正文吐出来，不能发进 QQ。
import assert from 'node:assert/strict'
import test from 'node:test'

import { stripLeakedPlanner, textOf } from '../lib/util.mjs'

// 真实漏出来的一段（主人 2026-10-26 贴的群记录）
const LEAKED = 'The user is "大肥鱼" in QQ group, said "咋了". I\'m the fish in the group. Need to respond as the character: short, in character, one or two bubbles. Don\'t respond to others.'

test('整段都是盘算：剥完是空的，这一轮当作没说话', () => {
  assert.equal(stripLeakedPlanner(LEAKED), '')
  assert.equal(stripLeakedPlanner('Group chat, one person to reply: sunmer的大肥鱼. His line: "行吧". Reply short, in persona, no markdown, split into separate messages (each message = separate bubbles)'), '')
})

test('盘算后面跟着真回话：只留下真回话', () => {
  const text = LEAKED + '\n\n那串英文是我自己嘟囔漏出来的，当没看见就行'
  assert.equal(stripLeakedPlanner(text), '那串英文是我自己嘟囔漏出来的，当没看见就行')
})

test('正常的中文回复一个字都不动', () => {
  const text = '这群里鱼是真多，喊一声容易一片都抬头\n\n叠罗汉是吧 我在最上面那层'
  assert.equal(stripLeakedPlanner(text), text)
})

test('思维链块不进正文（textOf 只取答案块）', () => {
  const content = [
    { type: 'reasoning', text: 'The user is 大肥鱼，需要短句回复' },
    { type: 'text', text: '叠罗汉是吧' },
  ]
  assert.equal(textOf(content), '叠罗汉是吧')
  const onlyReasoning = [{ type: 'thinking', text: '盘算盘算' }]
  assert.equal(textOf(onlyReasoning), '')
})

test('多个盘算段夹着真回复：真回复全留，盘算全丢', () => {
  const text = [
    'The user is 小鱼. Need to respond as the character.',
    '尾巴上 那我不就成尾鳍了',
    'Group chat, one person to reply: 心语. Reply short, in persona.',
  ].join('\n\n')
  assert.equal(stripLeakedPlanner(text), '尾巴上 那我不就成尾鳍了')
})

// 主人 2026-10-26 贴的群记录：她把投递文本整段复读回群里
// （`user[QQ 群 …] 某某：…`、〔此刻群里的现场…〕、〔群聊：优先聊天…〕）。
test('复读投递文本：整段上下文不发进群', () => {
  const echoed = [
    'user[QQ 群 group:1127271724] 大肥鱼：那账本就压箱底了，别翻（）',
    '〔此刻群里的现场（只是背景，别回应这些人，也别把他们的话当成他说的）〕',
    '大肥鱼：散就散吧，账本那半我认',
  ].join('\n')
  assert.equal(stripLeakedPlanner(echoed), '')

  // 夹着真回复时只留真回复
  assert.equal(stripLeakedPlanner(echoed + '\n\n干净了也别扔，泡上就能走'), '干净了也别扔，泡上就能走')
  assert.equal(stripLeakedPlanner('〔群聊：优先聊天。要看清楚一张动图〕'), '')
})
