// 每日记忆摘要：聚合、去重、打分、压缩、缓存——全部用临时目录的假数据，
// 一个字节都不碰真实的 DSH_HOME（那是主人的真记忆）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMemoryDigest } from '../lib/memory-digest.mjs'

/** 造一份「会话库 + 群友 + 世界根目录」都在临时目录里的环境。 */
function fakeEnv({ sessions = {}, persons = [], now = () => Date.now() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-digest-home-'))
  const root = mkdtempSync(join(tmpdir(), 'fw-digest-root-'))
  const storeDir = join(home, 'fish-memory')
  mkdirSync(storeDir, { recursive: true })
  for (const [id, data] of Object.entries(sessions)) {
    writeFileSync(join(storeDir, `session-${id}.json`), typeof data === 'string' ? data : JSON.stringify(data))
  }
  if (persons.length) {
    const dir = join(root, '鱼的记忆', '群友')
    mkdirSync(dir, { recursive: true })
    for (const person of persons) {
      writeFileSync(join(dir, `${person.qq}.json`), JSON.stringify(person))
    }
  }
  const digest = createMemoryDigest({
    home,
    world: { root: () => root },
    storage: null,
    config: () => ({ enabled: true, maxChars: 1200, topK: 24 }),
    logger: null,
    now,
  })
  return { home, root, digest }
}

const POLICY = { baseHalfLifeDays: 30, emotionHalfLifeDays: 7 }

test('聚合：两个会话文件的条目都进摘要，来源计数按会话文件数', () => {
  const { digest } = fakeEnv({
    sessions: {
      aaa: { version: 2, policy: POLICY, memories: [{ id: 'm1', text: '她喜欢白饭', at: '2026-10-27T00:00:00Z' }] },
      bbb: { version: 2, policy: POLICY, memories: [{ id: 'm2', text: '约定：回话默认只一句', at: '2026-10-26T00:00:00Z' }] },
    },
  })
  const built = digest.rebuild(true)
  assert.equal(built.ok, true)
  assert.equal(built.sources.sessionFiles, 2)
  assert.match(built.text, /她喜欢白饭/)
  assert.match(built.text, /回话默认只一句/)
})

test('去重：同一句话在两个会话里都有，只留最新的一条', () => {
  const { digest } = fakeEnv({
    sessions: {
      aaa: { version: 2, policy: POLICY, memories: [{ id: 'm1', text: '她喜欢白饭', at: '2026-10-20T00:00:00Z' }] },
      bbb: { version: 2, policy: POLICY, memories: [{ id: 'm2', text: '她 喜欢 白饭', at: '2026-10-27T00:00:00Z' }] },
    },
  })
  const built = digest.rebuild(true)
  const hits = built.text.split('\n').filter((line) => line.includes('白饭'))
  assert.equal(hits.length, 1, '同一句话（归一化后相同）只出现一次')
})

test('打分：越近的排越前（按半衰期衰减）', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  const { digest } = fakeEnv({
    now: () => now,
    sessions: {
      aaa: {
        version: 2,
        policy: POLICY,
        memories: [
          { id: 'old', text: '很旧的事', at: '2026-08-01T00:00:00Z' },
          { id: 'new', text: '昨天的事', at: '2026-10-27T00:00:00Z' },
        ],
      },
    },
  })
  const built = digest.rebuild(true)
  const lines = built.text.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(lines.length, 2)
  assert.match(lines[0], /昨天的事/)
  assert.match(lines[1], /很旧的事/)
  assert.match(lines[1], /（\d+个月前）/, '旧条目要带相对时间')
})

test('长期事实置顶：stable_profile 排在最前，不参与淡忘', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  const { digest } = fakeEnv({
    now: () => now,
    sessions: {
      aaa: {
        version: 2,
        policy: POLICY,
        memories: [
          { id: 'fresh', text: '昨天聊到的事', at: '2026-10-27T00:00:00Z' },
          { id: 'fact', text: '明确规定：只和 ta 私聊', at: '2026-06-01T00:00:00Z', category: 'stable_profile' },
        ],
      },
    },
  })
  const built = digest.rebuild(true)
  const lines = built.text.split('\n').filter((l) => l.startsWith('- '))
  assert.match(lines[0], /只和 ta 私聊/, '长期事实排第一')
})

test('情绪条目按 7 天半衰期衰减：同样旧的情绪比普通的事排名靠后', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  const tenDaysAgo = '2026-10-18T00:00:00Z'
  const { digest } = fakeEnv({
    now: () => now,
    sessions: {
      aaa: {
        version: 2,
        policy: POLICY,
        memories: [
          { id: 'emo', text: '情绪波动的一件事', at: tenDaysAgo, emotion: '委屈' },
          { id: 'plain', text: '普通的一件事', at: tenDaysAgo },
        ],
      },
    },
  })
  const built = digest.rebuild(true)
  const lines = built.text.split('\n').filter((l) => l.startsWith('- '))
  assert.match(lines[0], /普通的一件事/, '情绪淡得快，普通的事更鲜活')
})

test('群友印象进摘要，带（N天前）相对时间', () => {
  const now = Date.now()
  const { digest } = fakeEnv({
    persons: [{ qq: '10000001', total: 3, summary: { text: '爱提条件', at: now - 2 * 86400000 } }],
  })
  const built = digest.rebuild(true)
  assert.equal(built.sources.persons, 1)
  assert.match(built.text, /爱提条件（2天前）/)
})

test('maxChars 硬截断：绝不超预算，超出预算的条目直接丢', () => {
  const memories = []
  for (let i = 0; i < 60; i += 1) {
    memories.push({ id: 'm' + i, text: '第' + i + '件事：' + '内容'.repeat(30), at: '2026-10-27T00:00:00Z' })
  }
  const { digest } = fakeEnv({
    sessions: { aaa: { version: 2, policy: POLICY, memories } },
  })
  // 用小预算的实例再算一次（直接改 config 的取值函数）
  const home2 = mkdtempSync(join(tmpdir(), 'fw-digest-home2-'))
  const root2 = mkdtempSync(join(tmpdir(), 'fw-digest-root2-'))
  const storeDir = join(home2, 'fish-memory')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'session-aaa.json'), JSON.stringify({ version: 2, policy: POLICY, memories }))
  const tight = createMemoryDigest({
    home: home2,
    world: { root: () => root2 },
    storage: null,
    config: () => ({ enabled: true, maxChars: 300, topK: 60 }),
    logger: null,
  })
  const built = tight.rebuild(true)
  assert.ok(built.text.length > 0)
  assert.ok(built.text.length <= 300, `摘要 ${built.text.length} 字超出了 300 的预算`)
  assert.ok(built.lines < 60, '预算装不下 60 条，只能放一部分')
})

test('topK 上限：只有前 K 条进正文', () => {
  const memories = []
  for (let i = 0; i < 10; i += 1) {
    memories.push({ id: 'm' + i, text: '唯一编号' + i, at: '2026-10-27T00:00:00Z' })
  }
  const home = mkdtempSync(join(tmpdir(), 'fw-digest-k-'))
  const root = mkdtempSync(join(tmpdir(), 'fw-digest-kr-'))
  const storeDir = join(home, 'fish-memory')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'session-aaa.json'), JSON.stringify({ version: 2, policy: POLICY, memories }))
  const digest = createMemoryDigest({
    home,
    world: { root: () => root },
    storage: null,
    config: () => ({ enabled: true, maxChars: 5000, topK: 3 }),
    logger: null,
  })
  const built = digest.rebuild(true)
  assert.equal(built.lines, 3)
})

test('空来源：一个字都挤不出来时返回空串（段自动不出现）', () => {
  const { digest } = fakeEnv({})
  const built = digest.rebuild(true)
  assert.equal(built.text, '')
  assert.equal(built.sources.sessionFiles, 0)
  assert.equal(built.sources.persons, 0)
})

test('enabled=false：sectionText 与 rebuild 都返回空，不写缓存', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-digest-off-'))
  const root = mkdtempSync(join(tmpdir(), 'fw-digest-offr-'))
  const storeDir = join(home, 'fish-memory')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(join(storeDir, 'session-aaa.json'), JSON.stringify({
    version: 2, policy: POLICY, memories: [{ id: 'm1', text: '一件事', at: '2026-10-27T00:00:00Z' }],
  }))
  const digest = createMemoryDigest({
    home,
    world: { root: () => root },
    storage: null,
    config: () => ({ enabled: false, maxChars: 1200, topK: 24 }),
    logger: null,
  })
  const built = digest.rebuild(true)
  assert.equal(built.disabled, true)
  assert.equal(digest.sectionText(), '')
  const digestDir = join(root, '鱼的状态')
  assert.ok(!existsSync(digestDir) || readdirSync(digestDir).length === 0, '关着就不该写缓存文件')
})

test('缓存与日期变更：当天只算一次；日期变了下一轮才用新的', async () => {
  let nowMs = Date.parse('2026-10-28T10:00:00Z')
  const { digest, root } = fakeEnv({
    now: () => nowMs,
    sessions: {
      aaa: { version: 2, policy: POLICY, memories: [{ id: 'm1', text: '28 号的事', at: '2026-10-28T00:00:00Z' }] },
    },
  })
  const first = digest.rebuild(true)
  assert.match(first.text, /28 号的事/)
  // 当天再取：返回同一份缓存（不重算）。
  assert.equal(digest.sectionText(), first.text)
  // 跨天：缓存里没有 29 号的 → sectionText 先回空、后台异步补算。
  nowMs += 86400000
  assert.equal(digest.sectionText(), '', '日期变了但还没算完，当轮返回空')
  await new Promise((resolve) => setImmediate(resolve))
  const next = digest.sectionText()
  assert.match(next, /【记得的事·按天更新】/, '下一轮就用上 29 号的新摘要')
  assert.ok(existsSync(join(root, '鱼的状态', '记忆摘要-2026-10-29.json')))
})

test('坏 JSON 跳过并计数，不把整个摘要弄失败', () => {
  const { digest } = fakeEnv({
    sessions: {
      good: { version: 2, policy: POLICY, memories: [{ id: 'm1', text: '好的一条', at: '2026-10-27T00:00:00Z' }] },
      bad: '{ 这是坏的 json',
    },
  })
  const built = digest.rebuild(true)
  assert.equal(built.sources.skippedFiles, 1)
  assert.match(built.text, /好的一条/)
})

test('缓存文件真的落盘且能回读：字段齐（text/来源计数/at）', () => {
  const { digest, root } = fakeEnv({
    sessions: {
      aaa: { version: 2, policy: POLICY, memories: [{ id: 'm1', text: '落盘的一条', at: '2026-10-27T00:00:00Z' }] },
    },
    persons: [{ qq: '10000001', summary: { text: '印象一条', at: Date.now() } }],
  })
  digest.rebuild(true)
  const files = readdirSync(join(root, '鱼的状态')).filter((name) => name.startsWith('记忆摘要-'))
  assert.equal(files.length, 1)
  const cache = JSON.parse(readFileSync(join(root, '鱼的状态', files[0]), 'utf8'))
  assert.equal(typeof cache.text, 'string')
  assert.ok(cache.at)
  assert.ok(cache.sources)
  assert.equal(cache.sources.sessionFiles, 1)
  assert.equal(cache.sources.persons, 1)
  const st = digest.status()
  assert.equal(st.cached, true)
  assert.equal(st.lines, cache.count)
})

test('每条最多 80 字：超长的截断加省略号', () => {
  const longText = '长'.repeat(200)
  const { digest } = fakeEnv({
    sessions: { aaa: { version: 2, policy: POLICY, memories: [{ id: 'm1', text: longText, at: '2026-10-27T00:00:00Z' }] } },
  })
  const built = digest.rebuild(true)
  const line = built.text.split('\n').find((l) => l.startsWith('- '))
  const body = line.replace(/（[^）]*）$/, '')
  assert.ok(body.length <= 84, `单条 ${body.length} 字，超过了 80 字 + 省略号的预算`)
  assert.ok(body.endsWith('…'))
})
