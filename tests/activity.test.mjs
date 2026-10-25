import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStorage } from '../lib/storage.mjs'
import { createActivityStore } from '../lib/activity.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-activity-'))
  const storage = createStorage({ home, config: () => ({}) })
  return { home, storage, activity: createActivityStore({ storage }) }
}

test('activity lands in the workspace platform folder, one file per day', () => {
  const { storage, activity } = fresh()
  const saved = activity.append({ platform: 'bili', kind: 'watch', text: '看了一个讲排版视频', url: 'https://www.bilibili.com/video/BV1' })
  assert.equal(saved.ok, true)
  const dir = storage.layout().platform('bili')
  assert.ok(saved.day.match(/^\d{4}-\d{2}-\d{2}$/))
  assert.ok(existsSync(join(dir, `${saved.day}.jsonl`)))
  const line = JSON.parse(readFileSync(join(dir, `${saved.day}.jsonl`), 'utf8').trim())
  assert.equal(line.kind, 'watch')
  assert.equal(line.actor, 'fish')
  assert.ok(existsSync(join(dir, '说明.md')), '人看的说明也应重写')
})

test('unknown platforms are rejected and unknown kinds fall back to other', () => {
  const { activity } = fresh()
  assert.throws(() => activity.append({ platform: 'weibo', text: 'x' }), /未知平台/)
  assert.throws(() => activity.append({ platform: 'qq' }), /没有内容也没有链接/)
  // 动作类型是白名单：写不进别的字符串，只会归到「其它」。
  const saved = activity.append({ platform: 'qq', kind: 'hack', text: '随手记一笔' })
  assert.equal(saved.record.kind, 'other')
})

test('QQ 通知是独立一类，不会被归成「其它」也不会被当成鱼做的动作', () => {
  const { activity } = fresh()
  const saved = activity.append({ platform: 'qq', kind: 'notice', actor: 'other', text: '[入群] 阿明 进群了' })
  // 撤回 / 禁言 / 入退群这些是平台上发生的事，不是鱼的动作；
  // 归成 other 会和真正的「其它」混在一起，归成 fish 会读成鱼自己干的。
  assert.equal(saved.record.kind, 'notice')
  assert.equal(saved.record.actor, 'other')
  assert.ok(activity.status().kinds.some((kind) => kind.id === 'notice' && kind.label === '通知'))
})

test('主人记的一条留痕主体是 owner，其它仍默认 fish', () => {
  const { activity } = fresh()
  assert.equal(activity.append({ platform: 'qq', kind: 'other', actor: 'owner', text: '主人说的话' }).record.actor, 'owner')
  assert.equal(activity.append({ platform: 'qq', kind: 'other', text: '没写主体' }).record.actor, 'fish')
})

test('non-http links are dropped instead of stored raw', () => {
  const { activity } = fresh()
  const saved = activity.append({ platform: 'qq', kind: 'send', text: '提醒主人早点睡', url: 'javascript:alert(1)' })
  assert.equal(saved.record.url, '')
})

test('list and status group records by platform', () => {
  const { activity } = fresh()
  activity.append({ platform: 'qq', kind: 'send', text: '晚安' })
  activity.append({ platform: 'bili', kind: 'like', text: '给一个手作视频点了赞' })
  const all = activity.list({ limit: 10 })
  assert.equal(all.length, 2)
  assert.deepEqual(new Set(all.map((item) => item.platform)), new Set(['qq', 'bili']))

  const status = activity.status()
  assert.equal(status.platforms.qq.total, 1)
  assert.equal(status.platforms.douyin.total, 0)
  assert.ok(status.kinds.some((kind) => kind.id === 'watch' && kind.label === '浏览'))
})
