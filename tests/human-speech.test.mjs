// 真人发言库的测试。最要紧的一条：recallShape 的返回里不许出现任何一句原文。
//
// 「借接法」和「借用词」的分界线就在这条断言上：一旦返回样本句子，
// 模型就会照着那些句子写，等于把用词也借出去了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rememberHumanLine, recallShape, statsOf } from '../lib/human-speech.mjs'

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'human-speech-')), '真人发言.jsonl')
}

/** 直接读盘：验的是真落盘的东西，不是内存里的返回。一条都没收时文件还不存在。 */
function rowsOf(file) {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

/** 返回 JSON 里出现了哪几句原文（空数组 = 干净）。 */
function leakedRaws(result, raws) {
  const blob = JSON.stringify(result)
  return raws.filter((raw) => blob.includes(raw))
}

// ---- 收：入库 ----

test('收一条真人发言：写进 JSONL，带群 / 人 / 时间来源', () => {
  const file = tempFile()
  const r = rememberHumanLine({
    file,
    text: '  又加班？ ',
    chatKey: 'group:681145756',
    who: '墨墨',
    qqId: '10001',
    at: '2026-11-17T23:40:00+08:00',
  })
  assert.equal(r.ok, true)
  const rows = rowsOf(file)
  assert.equal(rows.length, 1)
  // 空白收干净：存的是「她说了什么」，不是原始填充。
  assert.equal(rows[0].text, '又加班？')
  assert.equal(rows[0].chatKey, 'group:681145756')
  assert.equal(rows[0].who, '墨墨')
  assert.equal(rows[0].qqId, '10001')
  assert.equal(rows[0].len, 4)
  assert.match(rows[0].at, /^2026-11-17T/)
})

test('不是人话的不收：空 / 纯链接 / 工具调用 / markdown / 太长 / AI 自述 / 纯标点', () => {
  const file = tempFile()
  const cases = [
    ['', '空文本'],
    ['   ', '空文本'],
    ['https://example.com/a/b?c=1', '纯链接'],
    ['www.bilibili.com/video/BV1xx', '纯链接'],
    ['<invoke name="fish_tone"><parameter name="text">你好</parameter></invoke>', '像工具调用或 markdown'],
    ['```json {"name":"fish_tone","arguments":{}} ```', '像工具调用或 markdown'],
    ['## 今日总结', '像工具调用或 markdown'],
    ['1. 第一点', '像工具调用或 markdown'],
    ['作为 AI 我不能这样接', '像 AI 自述'],
    ['字'.repeat(201), '太长'],
    ['。。。', '没有文字'],
  ]
  for (const [text, reason] of cases) {
    const r = rememberHumanLine({ file, text, chatKey: 'group:1', who: '某人' })
    assert.equal(r.ok, false, `应该跳过：${String(text).slice(0, 20)}`)
    assert.equal(r.skipped, reason, `跳过理由不对：${String(text).slice(0, 20)}`)
  }
  assert.deepEqual(rowsOf(file), [])
})

test('同一个人 5 分钟内说同一句只算一条；换个人说同一句另算一条', () => {
  const file = tempFile()
  const base = { file, text: '笑死', chatKey: 'group:1', who: '墨墨' }
  assert.equal(rememberHumanLine({ ...base, at: '2026-11-17T10:00:00Z' }).ok, true)
  const again = rememberHumanLine({ ...base, at: '2026-11-17T10:03:00Z' })
  assert.equal(again.ok, false)
  assert.equal(again.skipped, '重复')
  assert.equal(rowsOf(file).length, 1)
  // 换个人说同一句：那是另一条真人发言，要收。
  assert.equal(rememberHumanLine({ ...base, who: '汐阳', at: '2026-11-17T10:04:00Z' }).ok, true)
  assert.equal(rowsOf(file).length, 2)
})

test('同一个 (群, 人, 原话) 收过一次就不再收 —— 隔多久都一样', () => {
  const file = tempFile()
  const base = { file, text: '好饿', chatKey: 'group:1', who: '墨墨' }
  assert.equal(rememberHumanLine({ ...base, at: '2026-11-17T10:00:00Z' }).ok, true)
  const later = rememberHumanLine({ ...base, at: '2026-11-20T10:00:00Z' })
  assert.equal(later.ok, false)
  assert.equal(later.skipped, '已收过')
  assert.equal(rowsOf(file).length, 1)
})

// ---- 参考：只借接法 ----

// 三条同类的「加班」接话，够 MIN_HITS = 3。
const RAW_LINES = ['又加班？', '又加班啊', '又加班到几点']

function seedLines(file) {
  for (const text of RAW_LINES) {
    rememberHumanLine({ file, text, chatKey: 'group:681145756', who: '群友', at: '2026-11-17T23:40:00+08:00' })
  }
}

test('样本够了：只回接法，整个返回 JSON 里一句原文都没有', () => {
  const file = tempFile()
  seedLines(file)
  const got = recallShape({ file, text: '又加班了' })
  assert.equal(got.ok, true)
  assert.equal(got.stats.n, 3)
  assert.ok(got.hint, 'hint 不能空')

  // ★★ 本任务的灵魂：返回里不许出现任何一句原文（借接法，不借用词）。
  assert.deepEqual(leakedRaws(got, RAW_LINES), [], '泄露了原文')

  // 连样本开头的 3 个字也不许出现在 hint 里：hint 只能讲接法，不能借用词。
  for (const raw of RAW_LINES) {
    const head = raw.replace(/[？?！!。，,]/g, '').slice(0, 3)
    assert.ok(!got.hint.includes(head), `hint 借了原句用词：${head}`)
  }

  // sample 只有来源 / 时间 / 长度，没有文本。
  for (const item of got.sample) {
    assert.deepEqual(Object.keys(item).sort(), ['at', 'chatKey', 'len'])
    assert.equal(item.chatKey, 'group:681145756')
    assert.ok(Number.isFinite(item.len) && item.len > 0)
  }
  // stats 只有 n / opener / medianLen。
  assert.deepEqual(Object.keys(got.stats).sort(), ['medianLen', 'n', 'opener'])
  assert.ok(['问', '怼', '顺着接'].includes(got.stats.opener))

  console.log('[human-speech] hint 例子：' + got.hint)
})

test('★ 判据自检：泄露检查本身能抓到泄露（不是恒真）', () => {
  const leaky = { ok: true, hint: '', stats: {}, sample: [{ chatKey: 'g', at: '', len: 4, text: '又加班？' }] }
  assert.deepEqual(leakedRaws(leaky, RAW_LINES), ['又加班？'])
  const clean = { ok: true, hint: '以前这种话真人多是先接一句', stats: {}, sample: [] }
  assert.deepEqual(leakedRaws(clean, RAW_LINES), [])
})

test('样本不够就正常说：只有 1 条时 ok:false，不硬套接法', () => {
  const file = tempFile()
  rememberHumanLine({ file, text: '又加班？', chatKey: 'group:1', who: '墨墨' })
  const got = recallShape({ file, text: '又加班了' })
  assert.equal(got.ok, false)
  assert.equal(got.reason, '样本不够')
  assert.equal(got.hint, '')
  assert.equal(got.stats.n, 1)
  // 不够也不许借原文。
  assert.deepEqual(leakedRaws(got, ['又加班？']), [])
})

test('完全不相关的话：n=0，照样 ok:false 不硬套', () => {
  const file = tempFile()
  seedLines(file)
  const got = recallShape({ file, text: '今天天气不错' })
  assert.equal(got.ok, false)
  assert.equal(got.reason, '样本不够')
  assert.equal(got.stats.n, 0)
})

test('没有可比的话（空 text / 没有文件）也不炸', () => {
  assert.equal(recallShape({ file: tempFile(), text: '   ' }).ok, false)
  assert.equal(recallShape({ file: '', text: '又加班了' }).ok, false)
  assert.equal(recallShape({}).ok, false)
})

test('limit 限制参与统计的条数', () => {
  const file = tempFile()
  seedLines(file)
  const got = recallShape({ file, text: '又加班了', limit: 2 })
  assert.equal(got.ok, true)
  assert.equal(got.stats.n, 2)
  assert.equal(got.sample.length, 2)
})

test('开头动作取多数：先怼的样本多，hint 就说先怼一句', () => {
  const file = tempFile()
  const refute = ['才不是加班呢', '才不是加班啊', '才不是加班啦']
  for (const text of refute) {
    rememberHumanLine({ file, text, chatKey: 'group:1', who: '群友', at: '2026-11-17T10:00:00Z' })
  }
  const got = recallShape({ file, text: '才不是加班吧' })
  assert.equal(got.ok, true)
  assert.equal(got.stats.opener, '怼')
  assert.match(got.hint, /先怼一句/)
  assert.deepEqual(leakedRaws(got, refute), [])
})

test('开头动作取多数：问句样本多，hint 就说先问一句', () => {
  const file = tempFile()
  const asks = ['今天又加班吗', '今天又加班呢', '今天又加班了？']
  for (const text of asks) {
    rememberHumanLine({ file, text, chatKey: 'group:1', who: '群友', at: '2026-11-17T10:00:00Z' })
  }
  const got = recallShape({ file, text: '今天又加班吧' })
  assert.equal(got.ok, true)
  assert.equal(got.stats.opener, '问')
  assert.match(got.hint, /先问一句/)
  assert.deepEqual(leakedRaws(got, asks), [])
})

test('长度档：中位数 ≤6 说「6 个字以内」，7–12 说区间', () => {
  const shortFile = tempFile()
  for (const text of ['又加班？', '又加班啊', '又加班到几点']) {
    rememberHumanLine({ file: shortFile, text, chatKey: 'group:1', who: '群友' })
  }
  const shortGot = recallShape({ file: shortFile, text: '又加班了' })
  assert.ok(shortGot.stats.medianLen <= 6)
  assert.match(shortGot.hint, /6 个字以内/)

  const midFile = tempFile()
  for (const text of ['又加班到这么晚真的辛苦', '又加班到这么晚不困吗', '又加班到这么晚吃了吗']) {
    rememberHumanLine({ file: midFile, text, chatKey: 'group:1', who: '群友' })
  }
  const midGot = recallShape({ file: midFile, text: '又加班到这么晚' })
  assert.equal(midGot.ok, true)
  assert.ok(midGot.stats.medianLen > 6 && midGot.stats.medianLen <= 12)
  assert.match(midGot.hint, /7 到 12 个字/)
})

// ---- 天花板：文件会一直长 ----

test('超过 5000 行只留最近 3000 行，原子写不留临时文件', () => {
  const file = tempFile()
  const lines = []
  for (let i = 0; i < 5001; i += 1) {
    lines.push(JSON.stringify({
      text: `第 ${i} 条旧发言`,
      chatKey: 'group:9',
      who: '老群友',
      qqId: '',
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      len: 9,
    }))
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')

  const r = rememberHumanLine({ file, text: '刚说的新话', chatKey: 'group:9', who: '新群友', at: '2026-11-17T12:00:00Z' })
  assert.equal(r.ok, true)
  assert.equal(r.trimmed, true)

  const kept = rowsOf(file)
  assert.equal(kept.length, 3000)
  assert.equal(kept[kept.length - 1].text, '刚说的新话')
  // 原子写：临时文件不该留在目录里。
  assert.deepEqual(readdirSync(dirname(file)).filter((name) => name.includes('.tmp-')), [])
})

// ---- 总账 ----

test('statsOf：总数 / 按群分布 / 最后一条时间', () => {
  const file = tempFile()
  assert.deepEqual(statsOf(file), { total: 0, byChat: {}, lastAt: null })
  rememberHumanLine({ file, text: '白饭', chatKey: 'group:1', who: '墨墨', at: '2026-11-17T10:00:00Z' })
  rememberHumanLine({ file, text: '好饿', chatKey: 'group:2', who: '汐阳', at: '2026-11-17T11:00:00Z' })
  rememberHumanLine({ file, text: '笑死', chatKey: 'group:1', who: '墨墨', at: '2026-11-17T09:00:00Z' })
  const got = statsOf(file)
  assert.equal(got.total, 3)
  assert.deepEqual(got.byChat, { 'group:1': 2, 'group:2': 1 })
  assert.equal(got.lastAt, '2026-11-17T11:00:00.000Z')
})

test('statsOf 也不吐正文（面板能直接给主人看）', () => {
  const file = tempFile()
  seedLines(file)
  assert.deepEqual(leakedRaws(statsOf(file), RAW_LINES), [])
})
