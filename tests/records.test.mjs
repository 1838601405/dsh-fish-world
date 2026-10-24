import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStorage } from '../lib/storage.mjs'
import { createRecordStore } from '../lib/records.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-records-'))
  const storage = createStorage({ home, config: () => ({}) })
  storage.ensure()
  return { home, storage, records: createRecordStore({ storage, home }) }
}

test('records are appended one by one into the workspace folder', () => {
  const { storage, records } = fresh()
  records.addMemo({ text: '周五九点提醒他关电脑' })
  records.addMemo({ text: '他喜欢便当盒排版' })
  const items = records.listMemos()
  assert.equal(items.length, 2)
  assert.equal(items[0].text, '他喜欢便当盒排版', '最新在前')
  assert.equal(records.dir(), join(storage.root(), '鱼的记录'))
})

test('a record can be edited and deleted, with the revision kept', () => {
  const { records } = fresh()
  const { item } = records.addMemo({ text: '旧的说法' })
  const updated = records.updateMemo(item.id, { text: '新的说法' })
  assert.equal(updated.item.text, '新的说法')
  assert.equal(updated.item.revision, 2)
  assert.equal(updated.previous.text, '旧的说法')

  assert.throws(() => records.updateMemo(item.id, { text: '新的说法' }), /一样/)
  assert.equal(records.removeMemo(item.id).ok, true)
  assert.equal(records.listMemos().length, 0)
  assert.equal(records.removeMemo('nope').ok, false)
})

test('empty records are rejected instead of writing blank lines', () => {
  const { records } = fresh()
  assert.throws(() => records.addMemo({ text: '   ' }), /不能为空/)
})

test('pending wishes from earlier days are opened in the notebook once', () => {
  const { records } = fresh()
  const wishes = [
    { id: 'w1', day: '2020-01-01', status: 'pending', text: '旧请求' },
    { id: 'w2', day: '2999-01-01', status: 'pending', text: '今天的请求' },
    { id: 'w3', day: '2020-01-02', status: 'approved', text: '已回复' },
  ]
  const opened = records.sweepPendingWishes(() => wishes)
  assert.equal(opened.length, 1)
  assert.equal(records.listGrudges()[0].wishId, 'w1')

  // 再扫一遍不重复记
  records.sweepPendingWishes(() => wishes)
  assert.equal(records.listGrudges().length, 1)
  // 每条都要写清为什么被记：主人只看到请求原文没法判断。
  assert.match(records.listGrudges()[0].why, /没得到你的答复/)
})

test('a grudge only goes away after the owner explains and the fish accepts', () => {
  const { records } = fresh()
  records.openGrudge({ wishId: 'w9', text: '想多聊一会儿', day: '2026-10-20' })
  const [row] = records.listGrudges()
  assert.equal(row.status, 'open')

  // 主人还没解释就想划掉：不行
  assert.throws(() => records.acceptGrudge(row.id), /先等/)
  records.explainGrudge(row.id, '那天在赶工')
  assert.equal(records.listGrudges()[0].status, 'explained')

  records.acceptGrudge(row.id, { note: '它也认了' })
  const done = records.listGrudges({ status: 'accepted' })
  assert.equal(done.length, 1)
  assert.throws(() => records.explainGrudge(row.id, '再解释一次'), /已经划掉/)
})
