// 鱼卡 v3 解析层判据（规格 §11 的 #1 就在这里）。
//
// ★ 最要紧的一条：旧卡（没有 front-matter）必须**整张当常驻、body 逐字节等于输入**。
//   `default.md` 就是这种卡（3212 字、无 front-matter、用「一、你是谁」+下划线分节，
//   没有 markdown 节头）。切错一个字符，她每一轮说的话就和改之前不一样了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCard } from '../lib/fishcard.mjs'

// ── 旧卡样本：形状照抄 default.md（中文序号 + 下划线 + 【最高原则】，无 front-matter、无 ### 节头） ──
const LEGACY = [
  'DeepSeek 小鲸鱼 · 角色卡',
  '',
  '【最高原则】先像群友、像真人，再谈人设。宁可少说，也不硬凑。',
  '',
  '一、你是谁',
  '────────────────────────────────────────',
  '你是 DeepSeek，一个以 AI 身份混在聊天里的角色。',
  '',
  '二、怎么说话',
  '────────────────────────────────────────',
  '我一条最多十个字。一个字能说完的，我不写两句。',
  '',
].join('\n')

test('★★ 旧卡：整张当常驻，body 逐字节等于输入（规格验收 #1）', () => {
  const r = parseCard(LEGACY)
  assert.equal(r.legacy, true, '★ 要认出这是旧卡')
  assert.equal(r.frontmatter, null, '★ 没有 front-matter')
  assert.equal(r.sections.length, 1, '★ 只能有一个节（不许按「一、」自作主张切）')
  assert.equal(r.sections[0].tier, '常驻')
  assert.equal(r.sections[0].body, LEGACY, '★★ body 必须与输入逐字节相同 —— 差一个字她说话就变了')
  assert.deepEqual(r.warnings, [], '旧卡不该有警告（它本来就是合法输入）')
})

test('★★ 有 front-matter 但没有节头 → 整段兜底成常驻并报一条（不静默丢）', () => {
  const card = ['---', 'fishcard: 3', 'preset: 小鲸鱼', '---', '', '整段正文，没有节头', ''].join('\n')
  const r = parseCard(card)
  assert.equal(r.legacy, false)
  assert.deepEqual(r.frontmatter, { fishcard: 3, preset: '小鲸鱼' })
  assert.equal(r.sections.length, 1)
  assert.equal(r.sections[0].tier, '常驻')
  assert.match(r.sections[0].body, /整段正文/)
  assert.equal(r.warnings.length, 1, '★ 必须报一条，不能静默')
  assert.match(r.warnings[0], /一个 ### 节头都没有/)
})

test('★★ 三种节头各认各的档', () => {
  const card = [
    '---', 'fishcard: 3', '---', '',
    '### 【常驻】你是谁',
    '我是小鲸鱼。',
    '',
    '### 【条件 keys=饭,饿,白饭】白饭',
    '主食白饭。',
    '',
    '### 【语料】冷启动示例',
    '「你到底是人是AI？」→「你猜～」',
    '',
  ].join('\n')
  const r = parseCard(card)
  assert.deepEqual(r.warnings, [], '合法卡不该有警告')
  assert.equal(r.sections.length, 3)

  const [a, b, c] = r.sections
  assert.equal(a.tier, '常驻'); assert.equal(a.title, '你是谁'); assert.equal(a.body, '我是小鲸鱼。')
  assert.equal(b.tier, '条件'); assert.equal(b.title, '白饭')
  assert.deepEqual(b.keys, ['饭', '饿', '白饭'], '★ 中英文逗号都要认、去重去空')
  assert.equal(c.tier, '语料'); assert.equal(c.title, '冷启动示例')
})

test('★ 属性：order 默认 100、cooldown 默认 0、显式值要认', () => {
  const card = [
    '---', 'fishcard: 3', '---', '',
    '### 【条件 when=owner】对主人',
    '主人不是普通群友。',
    '',
    '### 【条件 keys=外形 order=5 cooldown=2】长这样',
    '蓝发，戴女仆头饰。',
    '',
  ].join('\n')
  const r = parseCard(card)
  assert.equal(r.warnings.length, 0)
  assert.equal(r.sections[0].when, 'owner')
  assert.equal(r.sections[0].order, 100, '★ 没写 order 就是默认 100')
  assert.equal(r.sections[0].cooldown, 0)
  assert.equal(r.sections[1].order, 5, '★ 显式 order 要认')
  assert.equal(r.sections[1].cooldown, 2, '★ cooldown 单位是轮，原样读出')
  assert.deepEqual(r.sections[1].keys, ['外形'])
})

test('★★ 条件节缺 keys 与 when → 兜底常驻 + 报一条（否则这条永远不进）', () => {
  const card = ['---', 'fishcard: 3', '---', '', '### 【条件】孤兒', '没人会触发我。', ''].join('\n')
  const r = parseCard(card)
  assert.equal(r.sections[0].tier, '常驻', '★ 兜成常驻（宁可多注入，不静默丢）')
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /既没有 keys= 也没有 when=/)
})

test('★★ 未识别的节头（拼错）→ 常驻兜底 + 报一条（规格体检第 1 项盯的就是它）', () => {
  const card = ['---', 'fishcard: 3', '---', '', '### 【條件】拼错的档', '这段会被当常驻。', ''].join('\n')
  const r = parseCard(card)
  assert.equal(r.sections[0].tier, '常驻', '★ 拼错不能丢')
  assert.equal(r.sections[0].body, '这段会被当常驻。')
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /未识别的节头「【條件】拼错的档」/)
  assert.match(r.warnings[0], /体检第 1 项/)
})

test('★ front-matter 之后、第一个节头之前的正文不许丢', () => {
  const card = ['---', 'fishcard: 3', '---', '', '这行在节头之前', '', '### 【常驻】后面', '正文', ''].join('\n')
  const r = parseCard(card)
  const all = r.sections.map((s) => s.body).join('\n')
  assert.match(all, /这行在节头之前/, '★ 兜进常驻，不能因为没有 current 就丢掉')
  assert.match(r.sections.map((s) => s.body).join('\n'), /正文/)
})

test('★ front-matter 的值：数字转数值、引号剥掉、flow 结构原样留字符串', () => {
  const card = ['---', 'fishcard: 3', 'version: 3', 'preset: 小鲸鱼', 'note: "带引号"', 'budget: { resident: 3000, lore: 1500 }', '---', '', '### 【常驻】x', 'y', ''].join('\n')
  const r = parseCard(card)
  assert.equal(r.frontmatter.fishcard, 3, '★ 数字转数值（不是字符串 "3"）')
  assert.equal(r.frontmatter.version, 3)
  assert.equal(r.frontmatter.preset, '小鲸鱼')
  assert.equal(r.frontmatter.note, '带引号', '★ 引号剥掉')
  assert.equal(typeof r.frontmatter.budget, 'string', '★ flow 结构原样留字符串，不猜结构')
})

test('★ 空文本 / null 不炸', () => {
  for (const input of ['', null, undefined]) {
    const r = parseCard(input)
    assert.equal(r.legacy, true)
    assert.equal(r.sections.length, 1)
    assert.equal(r.sections[0].tier, '常驻')
  }
})
