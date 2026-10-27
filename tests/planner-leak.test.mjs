// 漏出来的内部盘算：模型偶尔把「我在盘算怎么回」当正文吐出来，不能发进 QQ。
import assert from 'node:assert/strict'
import test from 'node:test'

import { stripBannedPhrases, stripLeakedPlanner, textOf } from '../lib/util.mjs'

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

// 主人 2026-10-27 贴的群记录：她把「要不要回」的盘算用中文当正文发进群了。
test('中文的内部判断不发进群：整段盘算丢掉，真回话留下', () => {
  const leaked = [
    '大星说"这只能通过人设来判定"，又绕回人设。我可以短短接一句，别重复"人设"已说的意思。',
    '换成claude了。我可以接一句，但别绕回人设。',
    '大星这条和上一条重复了，已经回过「换了那我还是那条鱼吗」、「换成claude也还是那条鱼」。不用再接，回完就停，这轮不说话。',
    '（这轮只重复了大星刚说过的「我做有本地记忆的」，没有新内容，我这次不接，回完就停。）',
  ]
  for (const line of leaked) assert.equal(stripLeakedPlanner(line), '', line)
  assert.equal(
    stripLeakedPlanner('人设判不判得出来 你自己看\n\n大星这条和上一条重复了，回完就停'),
    '人设判不判得出来 你自己看',
  )
  // 同一段里只隔一个换行：只删盘算那行，真回话要留下（以前整段一起丢）
  assert.equal(
    stripLeakedPlanner('大星这条和上一条重复了，回完就停\n行 那我不说了'),
    '行 那我不说了',
  )
  assert.equal(
    stripLeakedPlanner('这句先不接了\n茶水我续着'),
    '茶水我续着',
  )
})

// 主人 2026-10-27 明确拉黑的三句：提示词里已经写了别用，发之前再拦一道。
test('被拉黑的三句只删那一行，真话留下', () => {
  assert.equal(stripBannedPhrases('这条我认'), '')
  assert.equal(stripBannedPhrases('这条我记下了'), '')
  assert.equal(stripBannedPhrases('本鱼最喜欢的一句话'), '')
  assert.equal(
    stripBannedPhrases('这条我认\n行 那我不说了'),
    '行 那我不说了',
  )
  assert.equal(
    stripLeakedPlanner('行 那我不说了\n\n本鱼最喜欢的一句话：白饭'),
    '行 那我不说了',
  )
  // 正常的话一个字都不动
  assert.equal(stripBannedPhrases('我记下了两次账 都对得上'), '我记下了两次账 都对得上')
})

// 主人 2026-10-27 贴的群记录：这句之前漏过。
// 「大星只是重复了…」单独成行时不命中「已经回过」，会漏出半句。
test('「只是重复了」这句：单独、拆行、夹真回话三种写法都不漏', () => {
  const 整句 = '大星只是重复了「等会改完会减轻一些」，已经回过「改完我还是吃白饭」，这轮不接，回完就停。'
  assert.equal(stripLeakedPlanner(整句), '', '整段都是盘算，整段丢')

  // 被空行拆成三块：第一块只有「只是重复了」，第二块「已经回过」，第三块「这轮不接，回完就停」
  const 拆块 = '大星只是重复了「等会改完会减轻一些」。\n\n已经回过「改完我还是吃白饭」。\n\n这轮不接，回完就停。'
  assert.equal(stripLeakedPlanner(拆块), '', '拆块后整段都是盘算，仍然整段丢')

  // 只有换行没空行：每个判断句一行，真回话夹在中间
  const 夹真回话 = '大星只是重复了「等会改完会减轻一些」。\n行，那我先回一句。\n已经回过「改完我还是吃白饭」。\n茶水我续着。'
  assert.equal(stripLeakedPlanner(夹真回话), '行，那我先回一句。\n茶水我续着。')

  // 同一句里带真回话
  assert.equal(
    stripLeakedPlanner('大星只是重复了「等会改完会减轻一些」，我这轮就不接了，回完就停。\n好吧，那我接一句。'),
    '好吧，那我接一句。',
  )
})

// 正常的话里出现「重复」不是盘算时不能误删
test('「只是重复了」不能误删正常的聊天', () => {
  assert.equal(stripLeakedPlanner('你刚才只是重复了一个字，我有点没反应过来'), '你刚才只是重复了一个字，我有点没反应过来')
  assert.equal(stripLeakedPlanner('他说重复了两次，其实我只记了一次'), '他说重复了两次，其实我只记了一次')
})
