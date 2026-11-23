// 对人的记录：一个人一条账，查一遍就地更新，删了留墓碑。
//
// 和 records.mjs（一句话一条）的区别就在折叠规则：同一个人重复查不能堆成好几条，
// 否则主人看到一堆一样的记录，分不清哪份是新的。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPersonRecordStore } from '../lib/person-records.mjs'
import { createStorage } from '../lib/storage.mjs'

function fresh(now) {
  const home = mkdtempSync(join(tmpdir(), 'fw-person-records-'))
  const storage = createStorage({ home, config: () => ({}) })
  storage.ensure()
  const options = { storage, home }
  if (now) options.now = now
  return { home, storage, store: createPersonRecordStore(options) }
}

const PLATFORMS = [
  { site: 'GitHub', url: 'https://github.com/alice', status: 'claimed', httpStatus: '200', junk: '不该落盘' },
  { site: 'GitLab', url: 'https://gitlab.com/alice', status: 'available', httpStatus: '200' },
  { site: 'Reddit', url: 'https://reddit.com/user/alice', status: 'unknown', httpStatus: '?' },
]

test('落盘在 鱼的记录/对人的记录.jsonl，一条一个人', () => {
  const { storage, store } = fresh()
  const saved = store.save({ subject: '小明', username: 'alice', platforms: PLATFORMS, counts: { claimed: 1 } })
  assert.equal(saved.ok, true)
  assert.equal(store.dir(), join(storage.root(), '鱼的记录'))
  assert.ok(store.file().endsWith('对人的记录.jsonl'))
  const items = store.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].subject, '小明')
  assert.equal(items[0].username, 'alice')
  assert.equal(items[0].source, 'sherlock')
  assert.equal(items[0].revision, 1)
  assert.equal(items[0].status, 'active')
  assert.ok(items[0].checkedAt, '要带查询时间，不然看不出这份账有多旧')
})

test('★ 同一个人重复查是原地更新，不堆成两条', () => {
  const { store } = fresh()
  store.save({ subject: '小明', username: 'alice', platforms: PLATFORMS })
  store.save({
    subject: '小明',
    username: 'alice',
    platforms: [...PLATFORMS, { site: 'X', url: 'https://x.com/alice', status: 'claimed', httpStatus: '200' }],
    counts: { claimed: 2 },
  })
  const items = store.list()
  assert.equal(items.length, 1, '重复查询必须覆盖，不能多出一条')
  assert.equal(items[0].revision, 2, '修订号要涨，才能看出这份账更新过')
  assert.equal(items[0].platforms.length, 4, '新结果整份覆盖旧清单')
  assert.deepEqual(items[0].counts, { claimed: 2 })
})

test('用户名相同但称呼不同 = 两条（不同的人共用一个号是两回事）', () => {
  const { store } = fresh()
  store.save({ subject: '小明', username: 'alice', platforms: [] })
  store.save({ subject: '小红', username: 'alice', platforms: [] })
  assert.equal(store.list().length, 2)
})

test('用户名大小写不敏感：ALICE 和 alice 是同一条', () => {
  const { store } = fresh()
  store.save({ subject: '小明', username: 'Alice', platforms: [] })
  store.save({ subject: '小明', username: 'alice', platforms: [] })
  assert.equal(store.list().length, 1)
})

test('缺人或缺用户名直接拒，不写空行', () => {
  const { store } = fresh()
  assert.throws(() => store.save({ subject: '', username: '' }), /不能为空/)
  assert.throws(() => store.save({ subject: '小明', username: '   ' }), /用户名不能为空/)
  assert.equal(store.list().length, 0)
})

test('只留声明过的四个字段：上游多给的一律不落盘', () => {
  const { store } = fresh()
  const saved = store.save({
    subject: '小明',
    username: 'alice',
    platforms: [
      { site: 'GitHub', url: 'https://github.com/alice', status: 'claimed', httpStatus: '200', junk: 'x', responseTime: 1.2 },
      { site: '', url: 'https://nope', status: 'claimed' },
      { site: 'Weird', url: 'u', status: '不是四态之一' },
    ],
  })
  assert.equal(saved.item.platforms.length, 2, '没有站名的那条丢掉')
  const [first, second] = saved.item.platforms
  assert.deepEqual(Object.keys(first).sort(), ['httpStatus', 'site', 'status', 'url'])
  assert.equal(second.status, 'unknown', '认不出的状态一律按未知存，不当成没有')
})

test('★ 重新查不会抹掉手写备注；传了空串才清空', () => {
  const { store } = fresh()
  store.save({ subject: '小明', username: 'alice', note: '大学同学', platforms: PLATFORMS })
  // 再查一次，不带 note：备注要留着，查询只该更新平台清单。
  const again = store.save({ subject: '小明', username: 'alice', platforms: [] })
  assert.equal(again.item.note, '大学同学', '查询不该把手写的备注冲掉')
  assert.equal(again.item.platforms.length, 0)
  // 显式传空串 = 清空。
  const cleared = store.save({ subject: '小明', username: 'alice', note: '' })
  assert.equal(cleared.item.note, '')
})

test('按关键词筛：人名、用户名、备注都能搜到', () => {
  const { store } = fresh()
  store.save({ subject: '小明', username: 'alice', note: '大学同学' })
  store.save({ subject: '小红', username: 'bob', note: '' })
  assert.equal(store.list({ keyword: '小明' }).length, 1)
  assert.equal(store.list({ keyword: 'bob' }).length, 1)
  assert.equal(store.list({ keyword: '大学' }).length, 1)
  assert.equal(store.list({ keyword: '查无此人' }).length, 0)
})

test('备注可改，内容没变就拒；修订号跟着涨', () => {
  const { store } = fresh()
  const { item } = store.save({ subject: '小明', username: 'alice', note: '旧备注' })
  const updated = store.updateNote(item.id, '新备注')
  assert.equal(updated.item.note, '新备注')
  assert.equal(updated.item.revision, 2)
  assert.equal(updated.previous.note, '旧备注')
  assert.throws(() => store.updateNote(item.id, '新备注'), /一样/)
  assert.throws(() => store.updateNote('nope', 'x'), /没有找到/)
  assert.throws(() => store.updateNote('', 'x'), /缺少记录 id/)
})

test('删除写墓碑：列表里消失，但账本行还在（可回溯）', () => {
  const { store } = fresh()
  const { item } = store.save({ subject: '小明', username: 'alice', platforms: PLATFORMS })
  assert.equal(store.remove(item.id).ok, true)
  assert.equal(store.list().length, 0, '删了就不该再列出来')
  assert.equal(store.get(item.id), null)
  assert.equal(store.remove('nope').ok, false)
  // 同一个人再存一次是全新的一条（旧的已墓碑，不再被当成「已存在」去更新）。
  const again = store.save({ subject: '小明', username: 'alice', platforms: [] })
  assert.notEqual(again.item.id, item.id)
  assert.equal(again.item.revision, 1)
})

test('汇总按状态分开计数，unknown 单独一栏', () => {
  const { store } = fresh()
  store.save({ subject: '小明', username: 'alice', platforms: PLATFORMS })
  store.save({ subject: '小红', username: 'bob', platforms: [PLATFORMS[0]] })
  const summary = store.summary()
  assert.equal(summary.people, 2)
  assert.deepEqual(summary.platforms, { claimed: 2, available: 1, unknown: 1, illegal: 0 })
  assert.match(summary.note, /未知/)
  assert.equal(summary.exists, true)
})

test('一条记录都没有时汇总也是好的（不是报错、不是 undefined）', () => {
  const { store } = fresh()
  const summary = store.summary()
  assert.equal(summary.people, 0)
  assert.deepEqual(summary.platforms, { claimed: 0, available: 0, unknown: 0, illegal: 0 })
  assert.equal(summary.exists, false)
  assert.deepEqual(store.list(), [])
  assert.equal(store.get('anything'), null)
})

test('手写的记录（source=manual）和查来的分得开', () => {
  const { store } = fresh()
  const manual = store.save({ subject: '小明', username: 'alice', source: 'manual' })
  const queried = store.save({ subject: '小红', username: 'bob', source: 'sherlock' })
  assert.equal(manual.item.source, 'manual')
  assert.equal(queried.item.source, 'sherlock')
})

test('最新查的排最前（拨表验，不靠真等）', () => {
  // 拨表而不是 setTimeout：时间相关的断言要能确定性复现。
  let tick = Date.parse('2026-11-22T10:00:00Z')
  const { store } = fresh(() => new Date(tick))
  store.save({ subject: '先查的', username: 'aaa' })
  tick += 60_000
  store.save({ subject: '后查的', username: 'bbb' })
  assert.deepEqual(store.list().map((row) => row.subject), ['后查的', '先查的'])
  assert.equal(store.list()[0].day, '2026-11-22', 'dayKey 也走同一套时钟（北京时间口径）')
})
