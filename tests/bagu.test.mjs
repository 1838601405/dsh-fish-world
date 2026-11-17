// 鱼八股检测的判据自检：lib/bagu.mjs。
//
// 这里的数据是**测试数据**，不是上下文 —— 八股例句只允许活在这个文件里，
// 不许进人设 / 前缀 / 提示词 / README。
//
// 每个用例都对准一条判据，而不是对准一句话：
//   · 判据要能失败（真格言堆叠必须红）
//   · 判据在真鱼话上不能误红（带人/时间/物的段落必须绿）
//   · 单句金句不许红（一条签名句不是堆）
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  baguReport,
  clausesOf,
  isSignatureClause,
  looksLikeBagu,
  shortestClause,
} from '../lib/bagu.mjs'

// ── 测试数据：三段「格言堆叠」（每句都能当签名，整段没有一个具体的人/时间/物）──

/** 段一：讲规矩。两句都是「谁都能拿去当签名」的判断句。 */
const BAGU_RULES = '规矩就是规矩，先把规矩立住。路才能越走越宽。'

/** 段二：讲踏实。全是抽象判断，一个落地指代都没有。 */
const BAGU_STEADY = '人这一辈子，图的就是个踏实。踏实了，日子才过得下去。'

/** 段三：讲稳。短句 + 判断词，串起来像几条横幅。 */
const BAGU_SLOW = '慢下来一点没关系。稳才是真的快。急了就要摔跟头。'

/**
 * 段四：**一整段逗号连缀** —— 只有句末一个标点，六个判断全靠逗号串起来。
 * 这是最典型的形态，也是只按句子数会漏掉的假阴性。
 */
const BAGU_RUNON = '宁可少挣点，也不能坏了规矩，先把规矩立住，路才能越走越宽，用料实在，吃了才不烧心'

// ── 测试数据：三段「正常鱼话」（有人在现场，带人/时间/物）──

/** 段一：有我、有今天、有 3 点。 */
const FISH_TODAY = '我今天吃了白饭，3 点才起。你呢？'

/** 段二：有你、有这个。 */
const FISH_OPINION = '你这个想法有点怪，不过我喜欢。'

/** 段三：有刚才、有那个、有明天。 */
const FISH_STICKER = '刚才那个图我存了。明天发群里。'

// ── clausesOf ────────────────────────────────────────────────────────────

test('clausesOf：按句末标点和换行切，逗号不算分隔符', () => {
  assert.deepEqual(clausesOf('第一句。第二句！第三句？'), ['第一句', '第二句', '第三句'])
  assert.deepEqual(clausesOf('规矩就是规矩，先把规矩立住。'), ['规矩就是规矩，先把规矩立住'])
  assert.deepEqual(clausesOf('一\n二\r\n三'), ['一', '二', '三'])
  assert.deepEqual(clausesOf('带分号；也带叹号!'), ['带分号', '也带叹号'])
})

test('clausesOf：空输入给空数组，不抛', () => {
  assert.deepEqual(clausesOf(''), [])
  assert.deepEqual(clausesOf('   '), [])
  assert.deepEqual(clausesOf('。。。'), [])
  assert.deepEqual(clausesOf(null), [])
  assert.deepEqual(clausesOf(undefined), [])
  assert.deepEqual(clausesOf(42), [])
})

test('clausesOf：切出来的每句都是原文里真实存在的一段', () => {
  for (const text of [BAGU_RULES, BAGU_STEADY, BAGU_SLOW, FISH_TODAY, FISH_OPINION]) {
    for (const clause of clausesOf(text)) {
      assert.ok(text.includes(clause), `切出来的「${clause}」在原文里找不到`)
    }
  }
})

// ── isSignatureClause ───────────────────────────────────────────────────

test('isSignatureClause：有判断词 + 无落地指代 + 长度合适 = 能当签名', () => {
  assert.equal(isSignatureClause('路才能越走越宽'), true)
  assert.equal(isSignatureClause('稳才是真的快'), true)
  assert.equal(isSignatureClause('人这一辈子，图的就是个踏实'), true)
})

test('isSignatureClause：缺判断词就不算签名（那是叙述）', () => {
  assert.equal(isSignatureClause('白饭刚吃完'), false)
  assert.equal(isSignatureClause('天空蓝蓝的'), false)
})

test('isSignatureClause：有落地指代就不算签名', () => {
  assert.equal(isSignatureClause('我今天吃了白饭'), false) // 人称 + 时间
  assert.equal(isSignatureClause('你这个想法有点怪'), false) // 人称 + 指代
  assert.equal(isSignatureClause('3 点才起'), false) // 具体时间
  assert.equal(isSignatureClause('三天才看完'), false) // 数字 + 量词
  assert.equal(isSignatureClause('这三天才是真的快'), false) // 这 + 量词
  assert.equal(isSignatureClause('看 https://example.com 就懂了'), false) // URL
  assert.equal(isSignatureClause('`code` 就是证据'), false) // 行内代码
})

test('isSignatureClause：长度窗口 6..40（太短是口头禅，太长是解释）', () => {
  assert.equal(isSignatureClause('就是'), false) // 2 字
  assert.equal(isSignatureClause('才是真的快'), false) // 5 字，差一个字
  assert.equal(isSignatureClause('稳才是真的快'), true) // 6 字
  const long = '道理就是道理，' + '越说越有道理，'.repeat(4) + '说到底还是道理'
  assert.ok([...long].length > 40)
  assert.equal(isSignatureClause(long), false)
})

test('isSignatureClause：非字符串一律 false，不抛', () => {
  assert.equal(isSignatureClause(null), false)
  assert.equal(isSignatureClause(undefined), false)
  assert.equal(isSignatureClause(''), false)
  assert.equal(isSignatureClause(7), false)
})

// ── looksLikeBagu ───────────────────────────────────────────────────────

test('looksLikeBagu：三段格言堆叠 → true', () => {
  for (const [name, text] of [
    ['规矩', BAGU_RULES],
    ['踏实', BAGU_STEADY],
    ['慢稳', BAGU_SLOW],
  ]) {
    assert.equal(looksLikeBagu(text), true, `${name} 这段应当判八股`)
  }
})

test('looksLikeBagu：正常鱼话（我/你/今天/3 点/这个/刚才）→ false', () => {
  for (const [name, text] of [
    ['白饭', FISH_TODAY],
    ['想法', FISH_OPINION],
    ['存图', FISH_STICKER],
  ]) {
    assert.equal(looksLikeBagu(text), false, `${name} 这段不该判八股`)
  }
})

test('looksLikeBagu：只有一条签名句 → false（不能只凭一句就判）', () => {
  assert.equal(looksLikeBagu('路才能越走越宽。'), false)
  assert.equal(looksLikeBagu('路才能越走越宽。今天先这样。'), false)
  assert.equal(looksLikeBagu('白饭。稳才是真的快。'), false)
})

test('looksLikeBagu：带具体人/时间的排比 → false（那是有人在说话）', () => {
  assert.equal(looksLikeBagu('今天你说要减肥，刚才又说算了。'), false)
  assert.equal(looksLikeBagu('你早上说要早点睡，晚上又说再刷五分钟。'), false)
  assert.equal(looksLikeBagu('3 点才睡，7 点就起。'), false)
})

test('looksLikeBagu：整段只要有一个落地指代就放行', () => {
  // 两条签名句本来够判，但末尾一句带「我」⇒ 有人在现场 ⇒ 放行
  assert.equal(looksLikeBagu('规矩就是规矩，先把规矩立住。路才能越走越宽。我记着了。'), false)
  // 同样的两条，去掉那句人话 ⇒ 判八股
  assert.equal(looksLikeBagu('规矩就是规矩，先把规矩立住。路才能越走越宽。'), true)
})

test('looksLikeBagu：空段 / 非字符串 → false', () => {
  assert.equal(looksLikeBagu(''), false)
  assert.equal(looksLikeBagu(null), false)
  assert.equal(looksLikeBagu('。！？'), false)
})

test('looksLikeBagu：纯函数（同样输入两次同一结果）', () => {
  assert.equal(looksLikeBagu(BAGU_SLOW), looksLikeBagu(BAGU_SLOW))
  assert.equal(looksLikeBagu(FISH_TODAY), looksLikeBagu(FISH_TODAY))
})

// ── shortestClause ─────────────────────────────────────────────────────

test('shortestClause：返回最短的那一段（分句层面）', () => {
  assert.equal(shortestClause(BAGU_SLOW), '稳才是真的快')
  assert.equal(shortestClause(FISH_STICKER), '明天发群里')
})

test('shortestClause：返回的一定是原文里真实存在的一段', () => {
  const texts = [BAGU_RULES, BAGU_STEADY, BAGU_SLOW, FISH_TODAY, FISH_OPINION, FISH_STICKER]
  for (const text of texts) {
    const got = shortestClause(text)
    assert.ok(got.length > 0)
    assert.ok(text.includes(got), `「${got}」在原文里找不到`)
  }
})

test('shortestClause：逗号连缀里也返回真实片段，不返回整段', () => {
  const got = shortestClause(BAGU_RUNON)
  assert.ok(BAGU_RUNON.includes(got))
  assert.ok(got.length < BAGU_RUNON.length)
})

test('shortestClause：一样长取先出现的；切不出句子给空串', () => {
  assert.equal(shortestClause('一二三。四五六。'), '一二三')
  assert.equal(shortestClause(''), '')
  assert.equal(shortestClause(null), '')
})

// ── 回归：主人给的 6 条验收（逗号连缀那类是必红的假阴性）──────────────

test('验收①：整段逗号连缀的格言堆叠 → true', () => {
  // 一整段只有句末一个标点，六个判断全靠逗号连起来 —— 只按句子数会漏掉它
  assert.equal(looksLikeBagu(BAGU_RUNON), true)
  assert.equal(clausesOf(BAGU_RUNON).length, 1) // 句层面确实只有 1 句
})

test('验收②：两句对仗的格言 → true（别改坏）', () => {
  assert.equal(looksLikeBagu('东西好不好，吃过才知道。人靠不靠谱，处过才明白。'), true)
})

test('验收③：带人/时间的排比 → false', () => {
  assert.equal(looksLikeBagu('今天你说要减肥，刚才又说算了'), false)
})

test('验收④：有「我」的日常嘴硬 → false', () => {
  assert.equal(looksLikeBagu('我才没生气，就是有点饿'), false)
})

test('验收⑤：单词、短句 → false', () => {
  assert.equal(looksLikeBagu('白饭'), false)
  assert.equal(looksLikeBagu('才不是大肥鱼！是小鲸鱼'), false)
})

test('验收⑥：短句横幅式八股仍然 true（按句子数那条路没坏）', () => {
  assert.equal(looksLikeBagu(BAGU_SLOW), true)
})

// ── baguReport（诊断视图）──────────────────────────────────────────────

test('baguReport：把判定中间结果摊开，且和 looksLikeBagu 一致', () => {
  const red = baguReport(BAGU_RULES)
  assert.equal(red.bagu, true)
  assert.equal(red.anchored, false)
  assert.equal(red.clauseCount, 2)
  assert.equal(red.pieceCount, 3) // 逗号再切一层：规矩/立住/越走越宽
  assert.equal(red.shortest, shortestClause(BAGU_RULES))

  const runon = baguReport(BAGU_RUNON)
  assert.equal(runon.bagu, true)
  assert.equal(runon.clauseCount, 1)
  assert.ok(runon.signaturePieces.length >= 2)

  const green = baguReport(FISH_TODAY)
  assert.equal(green.bagu, false)
  assert.equal(green.anchored, true)
})

