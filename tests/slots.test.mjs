// 记忆槽：写入 → 打标 → K → 双通道检索 → 四道闸 → 打包。
// 验收 A–F 对着《鱼的记忆模块_设计包_20261118》逐条打。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_ANCHORS,
  KIND,
  createSlotStore,
  encodeFallback,
  makeSlot,
  normalizeIncoming,
  slotVector,
  tagByAnchors,
  worthRemembering,
} from '../lib/slots.mjs'
import {
  editDistance,
  gateCheck,
  hardFilter,
  literalHit,
  noteHit,
  noteNegative,
  packResults,
  retrieve,
  scoreSlot,
} from '../lib/slot-retrieve.mjs'

const OWNER = '3767749705'
const OTHER = '99990000'
const NOW = Date.parse('2026-11-18T12:00:00+08:00')
const at = (daysAgo = 0) => new Date(NOW - daysAgo * 86400000).toISOString()

function slot(over = {}) {
  return makeSlot({
    kind: KIND.FACT,
    semantic: '默认',
    source: 'qq',
    person: OWNER,
    at: at(0),
    ...over,
  })
}

const ownerAud = { kind: 'private', person: OWNER, chatKey: `private:${OWNER}` }

// ───────── A. 一图多义 ─────────
test('A) 一图多义：同一张图在四个场景命中不同槽', () => {
  const img = { vId: 'img-111' }
  const slots = [
    slot({ id: 's_tired', kind: KIND.STICKER, semantic: '蓝鲸娘·死鱼眼 说累', tags: { 场景: '说累', 情绪: '累' }, ...img }),
    slot({ id: 's_hurry', kind: KIND.STICKER, semantic: '蓝鲸娘·死鱼眼 催进度', tags: { 场景: '催进度', 动作: '催' }, ...img }),
    slot({ id: 's_self', kind: KIND.STICKER, semantic: '蓝鲸娘·死鱼眼 自嘲', tags: { 场景: '自嘲', 动作: '自嘲' }, ...img }),
    slot({ id: 's_teased', kind: KIND.STICKER, semantic: '蓝鲸娘·死鱼眼 被嘲', tags: { 场景: '被嘲', 动作: '吐槽' }, ...img }),
  ]
  const pick = (query) => {
    const got = retrieve({ query, slots, audience: ownerAud, now: NOW, budget: 400 })
    return got.kept.map((row) => row.slot.id)
  }
  const tired = pick('好累啊今天说累')
  const hurry = pick('催进度啦')
  const self = pick('自嘲一下')
  const teased = pick('你被嘲了')
  // 四个场景至少各自命中自己那一槽（同图多槽可以一起出现，但自己那槽必须在）
  assert.ok(tired.includes('s_tired'), '说累应命中 s_tired')
  assert.ok(hurry.includes('s_hurry'), '催进度应命中 s_hurry')
  assert.ok(self.includes('s_self'), '自嘲应命中 s_self')
  assert.ok(teased.includes('s_teased'), '被嘲应命中 s_teased')
  // 四个场景的「首选」不能是同一个槽（否则等于没多义）
  const top = [tired[0], hurry[0], self[0], teased[0]]
  assert.ok(new Set(top).size >= 3, '不同场景的首选应分散：' + JSON.stringify(top))
})

// ───────── B. 接梗 + 容错半径 ─────────
test('B) 接梗：窗外的天气 → 雨爱槽；漏字也命中', () => {
  const meme = slot({
    kind: KIND.MEME,
    semantic: '歌词接龙《雨爱》',
    trigger: ['窗外的天气'],
    response: '就像是你多变的表情',
  })
  const exact = retrieve({ query: '窗外的天气', slots: [meme], audience: ownerAud, now: NOW })
  assert.equal(exact.kept.length, 1)
  assert.equal(exact.kept[0].text, '就像是你多变的表情')
  assert.equal(exact.kept[0].channel, 'B')

  // 故意漏字：窗外天气（少一个「的」）
  assert.equal(editDistance('窗外天气', '窗外的天气'), 1)
  const fuzzy = retrieve({ query: '窗外天气', slots: [meme], audience: ownerAud, now: NOW })
  assert.equal(fuzzy.kept.length, 1, '容错半径内要命中')

  // 超出半径：完全不相关不该命中
  const miss = retrieve({ query: '今天吃什么好呢', slots: [meme], audience: ownerAud, now: NOW })
  assert.equal(miss.kept.length, 0)
})

test('B) 通道B 触发门槛：太短不触发', () => {
  assert.equal(literalHit('天气', '天气').hit, false, '2 字不该触发字面通道')
})

// ───────── C. 隐私 ─────────
test('C) 隐私：私聊的槽不进群聊、不进别人私聊，同一私聊能命中', () => {
  const secret = slot({
    id: 'kc',
    semantic: 'ta 说别告诉别人我喜欢吃香菜',
    tags: { 主体: '我', 情绪: '平静', 场景: '闲聊' },
    response: '（记着）',
  })
  const group = retrieve({ query: '他喜欢吃什么 香菜', slots: [secret], audience: { kind: 'group', chatKey: 'group:1' }, now: NOW })
  assert.equal(group.kept.length, 0, '群里不许出现主人私聊的槽')
  const other = retrieve({ query: '他喜欢吃什么 香菜', slots: [secret], audience: { kind: 'private', person: OTHER, chatKey: `private:${OTHER}` }, now: NOW })
  assert.equal(other.kept.length, 0, '别人的私聊也不行')
  const mine = retrieve({ query: '我喜欢吃什么 香菜', slots: [secret], audience: ownerAud, now: NOW })
  assert.equal(mine.kept.length, 1, '同一私聊要能命中')
})

test('C) 硬过滤：superseded / deleted 直接出局，缺 source 按私密', () => {
  const dead = slot({ id: 'd1', status: 'superseded' })
  const gone = slot({ id: 'd2', status: 'deleted' })
  const noSource = slot({ id: 'd3', source: '', person: '' })
  assert.equal(hardFilter({ slots: [dead, gone], audience: ownerAud }).length, 0)
  assert.equal(hardFilter({ slots: [noSource], audience: { kind: 'group', chatKey: 'g:1' } }).length, 0, '群里缺 source 的不给')
})

// ───────── D. 四道闸 ─────────
test('D) 闸1：对方难过时不给表情图，caution 槽也排除', () => {
  const sad = slot({ id: 'sat', kind: KIND.STICKER, semantic: '嘲讽图', caution: true, tags: { 情绪: '开心' } })
  const normal = slot({ id: 'nor', kind: KIND.STICKER, semantic: '安慰图', caution: false })
  const sadAud = { ...ownerAud, sad: true }
  const out = retrieve({ query: '好累啊', slots: [sad, normal], audience: sadAud, now: NOW })
  assert.equal(out.kept.some((r) => r.slot.id === 'sat'), false, '难过时不许发嘲讽图')
  assert.equal(out.kept.some((r) => r.slot.id === 'nor'), false, '难过时连普通表情图也别发')
})

test('D) 闸2：30 分钟内同一张图不重复', () => {
  const s = slot({ id: 'cd', kind: KIND.STICKER, semantic: '死鱼眼' })
  const state = { uses: { cd: NOW - 5 * 60 * 1000 } }
  const out = retrieve({ query: '没话说', slots: [s], audience: ownerAud, state, now: NOW })
  assert.equal(out.kept.length, 0, '5 分钟前发过就不许再发')
  const later = retrieve({ query: '没话说', slots: [s], audience: ownerAud, state, now: NOW + 31 * 60 * 1000 })
  assert.equal(later.kept.length, 1, '过了冷却可以发')
})

test('D) 闸3：一次对话配额（表情 2 / 梗 2）', () => {
  const s = slot({ id: 'q1', kind: KIND.STICKER, semantic: '死鱼眼' })
  const out = retrieve({ query: '没话说', slots: [s], audience: ownerAud, state: { counts: { 表情: 2 } }, now: NOW })
  assert.equal(out.kept.length, 0, '配额用尽就不发')
})

test('D) 闸4：被说「别发这个」后该槽降到底', () => {
  const s = slot({ id: 'neg', kind: KIND.STICKER, semantic: '死鱼眼' })
  const state = noteNegative({ state: {}, slotId: 'neg' })
  const out = retrieve({ query: '没话说', slots: [s], audience: ownerAud, state, now: NOW })
  assert.equal(out.kept.length, 0)
})

test('D) 找不到合适的：返回空，不发（回文字由调用方决定）', () => {
  const out = retrieve({ query: '完全无关的话', slots: [], audience: ownerAud, now: NOW })
  assert.equal(out.kept.length, 0)
})

// ───────── E. 省 token ─────────
test('E) 打包按预算裁：条数降但头名命中不变', () => {
  const slots = []
  for (let i = 0; i < 30; i += 1) {
    slots.push(slot({ id: `k${i}`, semantic: '第' + i + '条记忆：今天吃了白饭，好困', response: '第' + i + '条记忆：今天吃了白饭，好困' }))
  }
  const unlimited = packResults({ results: slots.map((s) => ({ slot: s, score: 1 })), budget: 100000 })
  const small = packResults({ results: slots.map((s) => ({ slot: s, score: 1 })), budget: 60 })
  assert.ok(small.kept.length < unlimited.kept.length, '预算小就该少进')
  assert.ok(small.tokens <= 60 + 30, '不超预算')
  assert.ok(small.dropped > 0, '被裁的要计数')
})

// ───────── F. 打标走本地（无云调用），给平均耗时 ─────────
test('F) 打标零样本近邻：本地兜底 encoder，平均耗时可见', () => {
  const t0 = Date.now()
  const runs = 50
  let last = null
  for (let i = 0; i < runs; i += 1) last = tagByAnchors({ text: '今天好累，说累的场景', encode: encodeFallback })
  const avg = (Date.now() - t0) / runs
  assert.ok(last && last.tags.情绪, '五维都要出值：' + JSON.stringify(last.tags))
  for (const dim of Object.keys(DEFAULT_ANCHORS)) assert.ok(dim in last.tags, '缺维度 ' + dim)
  assert.ok(avg < 200, '单条打标平均耗时 ' + avg.toFixed(2) + 'ms 应远小于 200ms')
})

// ───────── 写入管道 ─────────
test('写入：值得记判定按序命中即止', () => {
  assert.equal(worthRemembering({ text: '记住我喜欢香菜', explicit: true }).ok, true)
  assert.equal(worthRemembering({ text: '重复出现', seenCount: 2 }).reason, '同一内容出现 ≥2 次')
  assert.equal(worthRemembering({ text: '梗', reuseScene: true }).ok, true)
  const model = worthRemembering({ text: '可能有用', modelVerdict: { value: true } })
  assert.equal(model.ok, true)
  assert.equal(model.needsReview, true, '模型判定的只进待审，不直接入库')
  assert.equal(worthRemembering({ text: '随便一句' }).ok, false)
})

test('写入：去噪 / 长文分段 / hash 去重', () => {
  const noise = normalizeIncoming({ source: 'qq', who: 'a', text: 'https://example.com/x' })
  assert.equal(noise.segments.length, 0)
  assert.equal(noise.skipped, '纯链接/纯表情')
  const long = normalizeIncoming({ source: 'qq', text: '啊'.repeat(900) })
  assert.equal(long.segments.length, 3, '900 字按 400 切三段')
  const a = normalizeIncoming({ source: 'qq', text: '同一句' })
  const b = normalizeIncoming({ source: 'qq', text: '同一句' })
  assert.equal(a.hash, b.hash, '同内容同 hash（去重用）')
  assert.throws(() => normalizeIncoming({ text: 'x' }), /source 必填/)
})

test('存储：K 常驻 + V 冷存 + 损坏要抛不许静默重建', () => {
  const root = mkdtempSync(join(tmpdir(), 'slot-'))
  const store = createSlotStore({ rootDir: root })
  const s = slot({ id: 'k1', semantic: 'ta 喜欢白饭' })
  store.upsert(s)
  store.putV('v1', { text: '原文很长……', preview: '原文', hash: 'h1' })
  assert.equal(store.loadK().length, 1)
  assert.equal(store.getV('v1').preview, '原文')
  assert.equal(store.findByHash('h1'), 'v1')
  // 弄坏 K 文件 → 必须抛
  writeFileSync(store.kFile, '{坏掉的 JSON', 'utf8')
  assert.throws(() => store.loadK(), /槽表损坏/)
})

test('K 不含 hits / 新鲜度（静态量才算 K）', () => {
  const s = slot({ id: 'k2' })
  assert.equal('hits' in s, false)
  assert.equal('lastUsedAt' in s, false)
  assert.equal('freshness' in s, false)
  assert.ok(s.kVersion >= 1)
})

test('维护：命中记账只写状态，不动 K', () => {
  const s = slot({ id: 'k3' })
  const state = noteHit({ state: {}, slotId: 'k3', now: NOW })
  assert.equal(state.hits.k3, 1)
  assert.equal(state.uses.k3, NOW)
  assert.equal('hits' in s, false)
})