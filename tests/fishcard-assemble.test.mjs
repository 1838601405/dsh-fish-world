// 鱼卡 v3 装配判据（规格 §5 的 11 步 + §11 验收 #1 的 prompt 侧）。
//
// ★ 两条最硬的：
//   ① 旧卡（无 front-matter）→ prompt 里**逐字节**含原文（验收 #1：同一轮 prompt 与改前一致）
//   ② 标签行「以下是她自己的话：」必须在**所有她的话之前**（规格 §5：少了这行，
//      第一人称裸拼进对话，模型会读成用户在自述）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePrompt } from '../lib/fishcard-assemble.mjs'
import { sectionId } from '../lib/fishcard-select.mjs'
import { parseCard } from '../lib/fishcard.mjs'

// ── 旧卡样本：形状照抄 default.md（无 front-matter、无 ### 节头、中文序号分节） ──
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
  '我一条最多十个字。',
  '',
].join('\n')

/** 一张新卡（有 front-matter + 三档），用来测分档与顺序。 */
const NEW_CARD = [
  '---',
  'fishcard: 3',
  'preset: 小鲸鱼',
  'version: 3',
  '---',
  '',
  '### 【常驻】你是谁',
  '我是小鲸鱼，混在群里的一个角色。',
  '',
  '### 【常驻】怎么说话',
  '我一条最多十个字。',
  '',
  '### 【条件 keys=白饭】白饭',
  '主食白饭。',
  '',
  '### 【条件 when=attachment】看到图',
  '先说看到什么，再说看法。',
  '',
  '### 【语料】冷启动示例',
  '「你到底是人是AI？」→「你猜～」',
  '',
].join('\n')

const BASE = { name: '小鲸鱼', role: 'whale', scene: 'QQ 群', who: '某人' }

function indexOf(text, needle) {
  const i = text.indexOf(needle)
  assert.ok(i >= 0, `★ prompt 里找不到「${needle.slice(0, 30)}…」`)
  return i
}

test('★★ 验收#1：旧卡 → prompt 逐字节含原文（不许被切坏）', () => {
  const r = assemblePrompt({ ...BASE, card: LEGACY, round: 10 })
  assert.equal(r.used.legacy, true, '★ 要认出是旧卡')
  // 整张作为常驻进来 —— 每一行都得在
  for (const line of LEGACY.split('\n')) {
    if (line.trim() === '') continue
    assert.ok(r.text.includes(line), `★ 丢了原文的一行：${line.slice(0, 40)}`)
  }
  assert.equal(r.warnings.length, 0, '旧卡不该有警告')
})

test('★★ 标签行必须在所有「她的话」之前（规格 §5 第 3 行）', () => {
  const r = assemblePrompt({ ...BASE, card: NEW_CARD, round: 1, facts: { kind: 'group' } })
  const tag = indexOf(r.text, '以下是她自己的话：')
  const firstHers = indexOf(r.text, '我是小鲸鱼，混在群里的一个角色。')
  assert.ok(tag < firstHers, '★ 标签行要在常驻之前')
  // 身份行与场景锚在标签行之前（它们是给模型的框架，不是「她的话」）
  assert.ok(indexOf(r.text, '你是小鲸鱼（角色 whale）。') < tag, '★ 身份行在标签行前')
  assert.ok(indexOf(r.text, '当前在QQ 群，对象是某人。') < tag, '★ 场景锚在标签行前')
})

test('★★ 11 步顺序：身份 → 场景锚 → 标签 → 常驻 → 风格 → 语料 → 记忆 → 惦记 → 条件 → 槽 → 成长', () => {
  const r = assemblePrompt({
    ...BASE, card: NEW_CARD, round: 1, facts: { kind: 'private', attachment: true },
    memory: ['你记得：他叫小明'], thoughts: ['我还惦记着他上次问的问题'],
    habits: ['别用客服腔'], growth: '你以前总结过：短句更好',
    styleHome: undefined,   // 不给风格根 → 跳过风格层（顺序里少一环，其余照验）
  })
  const order = [
    '你是小鲸鱼（角色 whale）。',
    '当前在QQ 群，对象是某人。',
    '以下是她自己的话：',
    '我是小鲸鱼，混在群里的一个角色。',
    '「你到底是人是AI？」→「你猜～」',       // 语料（round=1 ≤3）
    '你记得：他叫小明',                      // 记忆
    '我还惦记着他上次问的问题',              // 惦记
    '先说看到什么，再说看法。',              // 条件（when=attachment 命中）
    '别用客服腔',                           // 槽
    '你以前总结过：短句更好',                // 成长（末尾位）
  ]
  const idx = order.map((s) => indexOf(r.text, s))
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i - 1] < idx[i], `★ 顺序错了：「${order[i - 1].slice(0, 16)}」应在「${order[i].slice(0, 16)}」之前`)
  }
  assert.ok(r.text.endsWith('你以前总结过：短句更好'), '★ 成长反哺占末尾位（卡里不再放东西）')
})

test('★★ 语料只在前 3 轮（规格 §5 第 6 步）', () => {
  for (const round of [1, 2, 3]) {
    const r = assemblePrompt({ ...BASE, card: NEW_CARD, round })
    assert.ok(r.text.includes('冷启动示例') || r.text.includes('你猜～'), `★ 第 ${round} 轮该有语料`)
  }
  for (const round of [4, 10]) {
    const r = assemblePrompt({ ...BASE, card: NEW_CARD, round })
    assert.equal(r.text.includes('你猜～'), false, `★ 第 ${round} 轮不该有语料`)
  }
})

test('★ 条件命中 ≤3 条（P2 选择器的上限在这里也成立）', () => {
  const card = ['---', 'fishcard: 3', '---', '',
    ...Array.from({ length: 6 }, (_, i) => `### 【条件 when=group】场景${i}\n第${i}条\n`),
  ].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 1, facts: { kind: 'group' } })
  assert.equal(r.used.conditions, 3, `★ 最多 3 条，实为 ${r.used.conditions}`)
})

test('★ 槽 ≤2 / 惦记 ≤3 / 记忆 ≤6（规格 §5 的上限）', () => {
  const r = assemblePrompt({
    ...BASE, card: NEW_CARD, round: 10,
    habits: ['a', 'b', 'c', 'd'],
    thoughts: ['t1', 't2', 't3', 't4', 't5'],
    memory: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
  })
  assert.ok(!r.text.includes('c'), '★ 槽第 3 条不该进')
  assert.ok(!r.text.includes('t4'), '★ 惦记第 4 条不该进')
  assert.ok(!r.text.includes('m7'), '★ 记忆第 7 条不该进')
  assert.ok(r.text.includes('a') && r.text.includes('t1') && r.text.includes('m6'))
})

test('★ 空段跳过：没有卡 / 没有记忆 / 没有风格 → 不出空行也不炸', () => {
  const r = assemblePrompt({ name: '鱼', round: 5 })
  assert.equal(r.text.includes('以下是她自己的话：'), false, '★ 全空时不留孤零零的标签行')
  assert.equal(r.text.trim(), '你是鱼。')
  assert.equal(r.used.legacy, true)
  assert.deepEqual(r.used, { conditions: 0, conditionIds: [], style: null, legacy: true })
})

test('★★ 判据#9：改预设库里的卡 → 已应用的角色下一轮 prompt 逐字节一致（快照生效）', () => {
  // 这条已在 fishcard-preset.test 里验（应用→改预设→逐字节不变）。
  // 这里在**装配侧**再钉一次：同一卡、同一输入，prompt 完全确定（不依赖外部状态）。
  const r1 = assemblePrompt({ ...BASE, card: NEW_CARD, round: 1, facts: { kind: 'group' } })
  const r2 = assemblePrompt({ ...BASE, card: NEW_CARD, round: 1, facts: { kind: 'group' } })
  assert.equal(r1.text, r2.text, '★★ 同输入必出同 prompt（逐字节，可复现）')
})

// ══════════ §3.1 时间感（施工单刚加的第二条） ══════════

test('★★ 判据#1：隔三小时再聊，第一句能带出那个间隔', () => {
  const now = 1_700_000_000_000
  const r = assemblePrompt({ ...BASE, card: NEW_CARD, round: 5, lastAt: now - 3 * 3600_000, now })
  assert.ok(r.text.includes('距上次对话过去了3 小时'), `★ 应带出间隔，实为：${r.text.slice(0, 120)}`)
})

test('★★ 判据#2：连续快速对话时不出现这一行', () => {
  const now = 1_700_000_000_000
  // 间隔 5 分钟（远小于 15 分钟）⇒ 不写
  const r = assemblePrompt({ ...BASE, card: NEW_CARD, round: 2, lastAt: now - 5 * 60_000, now })
  assert.equal(r.text.includes('距上次对话过去了'), false, '★ 快速对话不该提醒')
  // 间隔 14 分钟（仍在 15 分钟以下）⇒ 也不写
  const r2 = assemblePrompt({ ...BASE, card: NEW_CARD, round: 2, lastAt: now - 14 * 60_000, now })
  assert.equal(r2.text.includes('距上次对话过去了'), false, '★ 14 分钟还没到 15 分钟，不写')
})

test('★★ 判据#3：面板会话同样生效（时间感与场景无关）', () => {
  const now = 1_700_000_000_000
  const r = assemblePrompt({
    ...BASE, scene: '面板', card: NEW_CARD, round: 1,
    lastAt: now - 45 * 60_000, now,
  })
  assert.ok(r.text.includes('距上次对话过去了'), '★ 面板场景也要写（判据 3）')
  assert.ok(r.text.includes('45 分钟'), `★ 时长要算对：${r.text}`)
})

test('★★ 只给时长、不给解释（施工单原话）+ 边界：不给 lastAt 不写', () => {
  const now = 1_700_000_000_000
  const r = assemblePrompt({ ...BASE, card: NEW_CARD, round: 1, lastAt: now - 200 * 60_000, now })
  const line = r.text.split('\n').find((l) => l.includes('距上次对话过去了'))
  assert.ok(line, '★ 应有这一行')
  assert.equal(line, '距上次对话过去了3 小时 20 分钟', '★ 只给时长，格式干净')
  // 不许替她下结论
  for (const bad of ['请考虑', '注意', '建议', '请留意']) {
    assert.equal(line.includes(bad), false, `★ 时间感不许带解释性措辞（${bad}）`)
  }

  // 不给 lastAt（或 <=0）⇒ 不写
  const noLast = assemblePrompt({ ...BASE, card: NEW_CARD, round: 1, now })
  assert.equal(noLast.text.includes('距上次对话过去了'), false, '★ 没有 lastAt 不写')
})

test('★ 警告透传：解析层的兜底警告要能到调用方（不静默）', () => {
  const card = ['---', 'fishcard: 3', '---', '', '### 【條件】拼错', '正文', ''].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 1 })
  assert.ok(r.warnings.some((w) => /未识别的节头/.test(w)), '★ 解析层的警告要透出来：' + r.warnings.join(' | '))
})

test('★★ 扫描窗口（§3）：keys 命中"上一条"时注入，但**提示里不出现历史原文**（不许插进中间）', () => {
  // 上一条说「白饭」，这一条说「来点别的」—— keys=白饭 靠扫描窗口命中
  const card = [
    '---', 'fishcard: 3', '---', '',
    '### 【条件 keys=白饭】白饭档', '主食白饭。', '',
  ].join('\n')
  const r = assemblePrompt({
    ...BASE, card, round: 8,
    facts: { text: '今天想点别的', kind: 'group', recentTexts: ['昨天我们吃白饭', '好'] },
  })
  assert.ok(r.text.includes('主食白饭'), '★★ 扫描窗口命中 ⇒ 这一档该进提示')
  // ★ 关键：历史原文**不许**出现在 prompt 里（那就等于把内容插进历史中间，打前缀缓存）
  assert.equal(r.text.includes('昨天我们吃白饭'), false, '★ 提示里不许出现历史原文（前缀缓存）')
  assert.equal(r.text.includes('今天想点别的'), false, '★ 提示里也不许出现当前条原文（那是用户消息，在 history）')
})

// ══════════ §4 预算（施工单判据 #6：按顺序丢，面板列出丢了哪几条） ══════════
//
// ★ 为什么必须有：§4 同时明令「不许从尾部砍字符（personaForPrompt 就是这么干的，要改掉）」——
//   砍字符那道兜底去掉后，得有**按段丢弃**的兜底，否则超长卡整张塞进 prompt。

/** 造一张 N 个常驻节、每节 body长 len 字的卡。 */
function bigCard(sectionCount, bodyLen, { withFrontmatter = true } = {}) {
  const secs = Array.from({ length: sectionCount }, (_, i) =>
    `### 【常驻】节${i}\n${'字'.repeat(bodyLen)}\n`)
  return withFrontmatter ? ['---', 'fishcard: 3', '---', '', ...secs].join('\n') : secs.join('\n')
}

test('★★ 判据#6：常驻超 3000 → 从末段整段丢，且 dropped 报得出来', () => {
  // 5 节 × 900 字 = 4500 > 3000
  const r = assemblePrompt({ ...BASE, card: bigCard(5, 900), round: 10 })
  assert.ok(r.dropped.length > 0, '★ 超预算必须有 dropped（面板要列「丢了哪几条」）')
  assert.ok(r.dropped.every((d) => d.tier === '常驻'), '★ 这里只该丢常驻')
  // 丢的是**末段**（节4 先丢），至少留 1 节
  assert.equal(r.dropped[0].title, '节4', '★ 先丢最后一个节（末段）')
  assert.ok(r.text.includes('字'.repeat(900)), '★ 留下的段要完整（不砍字符）')
  assert.ok(r.warnings.some((w) => /超预算丢弃/.test(w)), '★ 要报一条，别静默')
})

test('★★ 判据#6：常驻再超也至少留 1 节（全丢了她就没人设了）+ 不许砍字符', () => {
  // 1 节 5000 字 > 3000 —— 没有可丢的末段了
  const r = assemblePrompt({ ...BASE, card: bigCard(1, 5000), round: 10 })
  assert.equal(r.dropped.length, 0, '★ 只有 1 节时不丢（丢了就没人设）')
  assert.ok(r.warnings.some((w) => /仍超预算/.test(w)), '★ 但要报出来（不静默）')
  assert.ok(r.text.includes('字'.repeat(5000)), '★★ 全量保留 —— §4 不许砍字符')
  assert.equal(r.text.includes('（人设卡过长，已截断）'), false, '★ 不许出现砍字符的标记')
})

test('★★ 判据#6：条件超 1500 → order 最大的先丢，且剩余保持原注入顺序', () => {
  // ★ 受 selectConditions 的 **≤3 条上限**约束：造 4 条也只有 3 条进得来，
  //   所以要让**选中的 3 条**总长超 1500 ⇒ 单条 600（3×600=1800）。
  // ★ body 带 index 特征：prompt 里拼的是 **body 不是 title**（我第一版断言查 `条件2`
  //   这个 title，它永远不在 text 里 ⇒ 假红）。
  const secs = Array.from({ length: 3 }, (_, i) =>
    `### 【条件 when=group order=${(i + 1) * 10}】条件${i}\n甲${i}${'甲'.repeat(598)}\n`)
  const card = ['---', 'fishcard: 3', '---', '', ...secs].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 10, facts: { kind: 'group' } })

  assert.equal(r.used.conditions, 2, '★ 3 条选中 → 丢 1（1800>1500）→ 留 2（used 是丢后的数）')
  assert.equal(r.dropped.length, 1, '★ 只丢到 ≤1500 就停（丢 1 条后 1200）')
  assert.equal(r.dropped[0].tier, '条件')
  assert.equal(r.dropped[0].order, 30, '★★ order 最大的先丢（§4 顺序）')
  // 剩下 2 条按**原 order 升序**出现（丢弃不打乱注入顺序）—— 按 body 特征查
  const i10 = r.text.indexOf('甲0'), i20 = r.text.indexOf('甲1')
  assert.ok(i10 >= 0 && i20 >= 0, '★ order 10/20 的 body 都还在')
  assert.ok(i10 < i20, '★ 剩余顺序仍是 order 升序')
  assert.equal(r.text.includes('甲2'), false, '★ order 30 那条被丢了')
})

test('★★ 判据#6：语料超 500 → 从最后一条丢', () => {
  // 3×200=600 > 500 ⇒ 丢 1 条（样例2）后 400 ≤ 500 停 ⇒ 剩 0/1
  // ★ body 带 index 特征（title 不进 prompt，断言只能查 body）。
  const secs = Array.from({ length: 3 }, (_, i) => `### 【语料】样例${i}\n例${i}${'例'.repeat(198)}\n`)
  const card = ['---', 'fishcard: 3', '---', '', ...secs].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 1 })   // round=1 才出语料
  assert.ok(r.dropped.length > 0, '★ 600 > 500 要丢')
  assert.equal(r.dropped[0].tier, '语料')
  assert.equal(r.dropped[0].title, '样例2', '★ 先丢最后一条')
  assert.equal(r.dropped.length, 1, '★ 只丢到 ≤500 就停（丢 1 条后 400）')
  assert.equal(r.text.includes('例2'), false, '★ 被丢那条的 body 不在 prompt')
  assert.ok(r.text.includes('例0') && r.text.includes('例1'), '★ 前两条留着')
})

test('★★ 判据#6：三档都超时，dropped 顺序 = 语料 → 条件 → 常驻（§4 固定顺序）', () => {
  // 各档都要**真的超**：常驻 4×900=3600>3000；条件 2×900=1800>1500；语料 900>500
  // （第一版常驻 3×900=2700 没超、条件单条 900 没超 ⇒ 只丢了语料）
  const card = [
    '---', 'fishcard: 3', '---', '',
    `### 【常驻】A\n${'常'.repeat(900)}\n`,
    `### 【常驻】B\n${'常'.repeat(900)}\n`,
    `### 【常驻】C\n${'常'.repeat(900)}\n`,
    `### 【常驻】D\n${'常'.repeat(900)}\n`,
    `### 【条件 when=group order=50】高\n${'条'.repeat(900)}\n`,
    `### 【条件 when=group order=60】更高\n${'条'.repeat(900)}\n`,
    `### 【语料】S\n${'语'.repeat(900)}\n`,
  ].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 1, facts: { kind: 'group' } })
  const tiers = r.dropped.map((d) => d.tier)
  const firstSample = tiers.indexOf('语料'), firstCond = tiers.indexOf('条件'), firstRes = tiers.indexOf('常驻')
  assert.ok(firstSample >= 0, '★ 语料该丢（900>500），实为 ' + tiers.join(','))
  assert.ok(firstCond >= 0, '★ 条件该丢（1800>1500），实为 ' + tiers.join(','))
  assert.ok(firstRes >= 0, '★ 常驻该丢（3600>3000），实为 ' + tiers.join(','))
  assert.ok(firstSample < firstCond, '★ 语料先于条件（§4 顺序）')
  assert.ok(firstCond < firstRes, '★ 条件先于常驻（§4 顺序）')
})

test('★ 没超预算 → dropped 为空（别报假丢弃）', () => {
  const r = assemblePrompt({ ...BASE, card: NEW_CARD, round: 1, facts: { kind: 'group' } })
  assert.deepEqual(r.dropped, [], '★ 没超就不该有 dropped')
  assert.equal(r.warnings.some((w) => /超预算丢弃/.test(w)), false)
})

test('★★ used.conditionIds：真正注入的条件标识（调用方拿它回写 cooldown）', () => {
  // 选择器不改 state、回写是调用方的活 —— 所以必须把「注入了哪几条」交出去
  const card = [
    '---', 'fishcard: 3', '---', '',
    `### 【条件 when=group order=10】甲\n${'一'.repeat(600)}\n`,
    `### 【条件 when=group order=20】乙\n${'二'.repeat(600)}\n`,
    `### 【条件 when=group order=30】丙\n${'三'.repeat(600)}\n`,
  ].join('\n')
  const r = assemblePrompt({ ...BASE, card, round: 1, facts: { kind: 'group' } })

  assert.equal(r.used.conditions, 2, '前提：3 条超 1500 丢 1 条')
  assert.equal(r.used.conditionIds.length, 2, '★ ids 要和注入条数一致')
  assert.ok(r.used.conditionIds.every((id) => typeof id === 'string' && id.includes('::')), '★ 形态是 sectionId')
  // 丢掉的那条（order 30 = 丙）不该在 ids 里
  assert.equal(r.used.conditionIds.some((id) => id.startsWith('丙')), false, '★ 丢掉的不许回写冷却')
  assert.ok(r.used.conditionIds.some((id) => id.startsWith('甲')), '★ 注入的要能对上')

  // 与选择器用的是**同一个 sectionId**（否则调用方回写的键永远对不上）
  const parsed = parseCard(card)
  const first = parsed.sections.find((s) => s.title === '甲')
  assert.ok(r.used.conditionIds.includes(sectionId(first)), '★ 与 fishcard-select.sectionId 同源')
})
