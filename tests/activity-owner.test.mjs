// 和主人的生活记录：只从 QQ 留存里算，不另建台账；认不出主人时要如实说明。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createActivityStore } from '../lib/activity.mjs'
import { PLATFORM_DIRS } from '../lib/storage.mjs'

// 留存落在 <根>/鱼与世界/<平台>/ 下（lib/storage.mjs 的 paths.platform）。
// 这里按同一个约定拼路径：少一层「鱼与世界」就会一个文件都读不到（曾经写错过）。
const PLATFORM_ROOT = '鱼与世界'

function fixture(rowsByDay) {
  const root = mkdtempSync(join(tmpdir(), 'fish-activity-'))
  // 留存落在 <根>/鱼与世界/<平台>/ 下（lib/storage.mjs 的 paths.platform）
  const dir = join(root, PLATFORM_ROOT, PLATFORM_DIRS.qq)
  mkdirSync(dir, { recursive: true })
  for (const [day, rows] of Object.entries(rowsByDay)) {
    writeFileSync(join(dir, day + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  }
  const storage = {
    layout: () => ({
      root,
      platform: (id) => join(root, PLATFORM_ROOT, PLATFORM_DIRS[id] || String(id || '其它')),
    }),
  }
  return createActivityStore({ storage, logger: { info() {} } })
}

const row = (at, kind, actor, text = 'x') => ({ at, kind, actor, text })

test('和主人相处：只算收发，不把平台浏览和群通知算进去', () => {
  const store = fixture({
    '2026-10-26': [
      row('2026-10-26T10:00:00.000Z', 'receive', 'owner'),
      row('2026-10-26T10:01:00.000Z', 'send', 'fish'),
      row('2026-10-26T11:00:00.000Z', 'notice', 'other'),
      row('2026-10-26T12:00:00.000Z', 'watch', 'fish', '看了个视频'),
    ],
    '2026-10-27': [
      row('2026-10-27T09:00:00.000Z', 'receive', 'owner'),
      row('2026-10-27T09:01:00.000Z', 'send', 'fish'),
      row('2026-10-27T09:02:00.000Z', 'receive', 'other', '路人'),
    ],
  })
  const s = store.withOwnerStats()
  assert.equal(s.interactions, 4, '主人 2 条 + 鱼 2 条；通知、浏览、路人都不算')
  assert.equal(s.ownerSaid, 2)
  assert.equal(s.fishSaid, 2)
  assert.equal(s.days, 2)
  assert.equal(s.streak, 2, '26、27 连续两天')
  assert.equal(s.ownerKnown, true)
  assert.equal(s.recentDays.length, 2)
})

test('和主人相处：连续天数断了就重新数，不硬凑', () => {
  const store = fixture({
    '2026-10-20': [row('2026-10-20T10:00:00.000Z', 'receive', 'owner')],
    '2026-10-21': [row('2026-10-21T10:00:00.000Z', 'receive', 'owner')],
    // 中间空 22 号
    '2026-10-23': [row('2026-10-23T10:00:00.000Z', 'receive', 'owner')],
  })
  const s = store.withOwnerStats()
  assert.equal(s.days, 3)
  assert.equal(s.streak, 1, '最近一天只有它自己')
})

test('和主人相处：老数据认不出主人时如实说，不把别人算成主人', () => {
  const store = fixture({
    '2026-10-26': [
      row('2026-10-26T10:00:00.000Z', 'receive', 'other', '以前一律记成 other'),
      row('2026-10-26T10:01:00.000Z', 'send', 'fish'),
    ],
  })
  const s = store.withOwnerStats()
  assert.equal(s.ownerKnown, false)
  assert.equal(s.ownerSaid, 0, '认不出来就不能记在主人头上')
  assert.equal(s.interactions, 1, '只算到鱼这一侧')
  assert.match(s.note, /没有记「是谁说的」/)
})

test('和主人相处：一条记录都没有时是 0，不报错', () => {
  const store = fixture({})
  const s = store.withOwnerStats()
  assert.equal(s.interactions, 0)
  assert.equal(s.days, 0)
  assert.equal(s.streak, 0)
  assert.equal(s.peakHour, null)
  assert.deepEqual(s.recentDays, [])
})
