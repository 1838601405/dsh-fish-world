// 漏出来的内部盘算：模型偶尔把「我在盘算怎么回」当正文吐出来，不能发进 QQ。
import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanForSend, stripBannedPhrases, stripLeakedPlanner, textOf  } from '../lib/util.mjs'

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

// 主人 2026-10-28 早上贴的群记录（group:681145756）：那轮换成 magpie/group/deepseel 之后，
// 她把「先自嘲一下、短」这种边想边改的旁白、连引号的候选回话一起发了出去。
test('边想边改的旁白和候选草稿不发进群', () => {
  const 泄漏 = [
    '小邓快修也发了个1。这已经变成群里的梗了。',
    '接一句：你们都学会按1了？ 或者 "1成了暗号 就我一个不知道"',
    '有点自嘲。短。',
    '"行 这下全群都会按1了"',
    '"我成声控玩具了" 第二个和之前"声控的"重复。换。 "1都成接头暗号了"',
    '不过刚才说的"1都成接头暗号了"其实还没发出去。让我就着 小邓快修 的"1"说一句。',
  ]
  for (const line of 泄漏) assert.equal(stripLeakedPlanner(line), '', line)

  // 同一段里夹着真回话：只留真回话
  const mixed = [...泄漏, '1 都成接头暗号了', '再发我真当你们在喊我起床'].join('\n')
  assert.equal(stripLeakedPlanner(mixed), '1 都成接头暗号了\n再发我真当你们在喊我起床')
})

// 上面那条「整行只有一个引号」的规则不能误伤：句子还有别的字就照常发
test('引号和「重复」出现在正常回话里不动', () => {
  assert.equal(stripLeakedPlanner('他说「今晚别熬夜」，我记住了'), '他说「今晚别熬夜」，我记住了')
  assert.equal(stripLeakedPlanner('你说重复就是重复，我不改口'), '你说重复就是重复，我不改口')
})

// 2026-10-28 那两轮的真实原文：整条都是旁白 / 旁白夹真话。
// 第一轮（turn 96）全是草稿，剥完应当是空的；第二轮（turn 97）只留最后两句。
test('2026-10-28 的真实两条：整条旁白剥干净，夹着的真话留下', () => {
  const 第一轮 = [
    '小邓快修也发了个1。这已经变成群里的梗了。',
    '',
    '接一句：你们都学会按1了？ 或者 "1成了暗号 就我一个不知道"',
    '',
    '有点自嘲。短。',
    '',
    '"行 这下全群都会按1了" / "我成声控玩具了"',
    '',
    '第二个和之前"声控的"重复。换。',
    '',
    '"1都成接头暗号了"',
  ].join('\n')
  assert.equal(stripLeakedPlanner(第一轮), '', '整轮都是草稿，一条都不该发出去')

  const 第二轮 = [
    '"1" 那条是我自己误发的记录，实际这轮没有新内容——大星说的还是那几句重复的。',
    '',
    '不过刚才说的"1都成接头暗号了"其实还没发出去。让我就着 小邓快修 的"1"说一句。',
    '',
    '1 都成接头暗号了',
    '再发我真当你们在喊我起床',
  ].join('\n')
  assert.equal(stripLeakedPlanner(第二轮), '1 都成接头暗号了\n再发我真当你们在喊我起床')
})

// 草稿清单只删「只剩引号」的行；真话里带一句引用、或者两个人在对话，都不动
test('草稿规则不误伤正常引用', () => {
  assert.equal(
    stripLeakedPlanner('他说「今晚别熬夜」 我说「知道了」'),
    '他说「今晚别熬夜」 我说「知道了」',
  )
  assert.equal(stripLeakedPlanner('「在吗」 在'), '「在吗」 在')
  assert.equal(stripLeakedPlanner('大星说「忙着」，我这句就免了'), '大星说「忙着」，我这句就免了')
})

// 2026-10-28 又一次：她在数条数、挑第几条，还夹着英文的 hmm，真回话挤在同一行尾巴上。
test('数条数 / 挑第几条 / hmm 这类旁白不发出去，尾巴上的真话留下', () => {
  const 三条 = [
    '第二条接图更自然。一条就行：图里的倒是穿得比我暖和',
    'hmm 图是蓝发雪地小鲸鱼娘。可以认一下：',
    '两条： 保留第二条即可，第一条有点重复。 发两条短的也行。颜面尽失 那我刚夸的那句收回 图里这个蓝毛的 跟我撞色了',
  ]
  const out = stripLeakedPlanner(三条.join('\n'))
  assert.ok(!/第二条|保留|发两条|hmm/.test(out), '旁白要清干净：' + out)
  assert.ok(out.includes('图里的倒是穿得比我暖和'), '尾巴上的真话要留下：' + out)
  assert.ok(out.includes('颜面尽失'), '混在末尾的真话要留下：' + out)

  // 普通句子原样返回，不能被这句号切法弄乱
  assert.equal(stripLeakedPlanner('饭锅只有一个。别抢'), '饭锅只有一个。别抢')
})

// 2026-10-28 群 681145756：写进记忆的「印象：…」被当成聊天发出去了。群聊只许有人话。
test('印象 / 记忆 这类带标签的段落不进群', () => {
  const 漏 = [
    '闭着眼也听得见笑声，藏不住',
    '印象：咕咕的大肥魚认命认得利索，条件也提得利索，被拍被念都不恼。',
    '偷拍也得有东西可拍，我这张脸没什么好藏的',
  ].join('\n')
  assert.equal(
    stripLeakedPlanner(漏),
    '闭着眼也听得见笑声，藏不住\n偷拍也得有东西可拍，我这张脸没什么好藏的',
  )
  assert.equal(stripLeakedPlanner('记忆：她今天很开心'), '')
  // 正常聊天里出现「印象」两个字不算标签，别误删
  assert.equal(stripLeakedPlanner('我对你这印象还挺深的'), '我对你这印象还挺深的')
})
