// 梗百科闸门：禁用表在磁盘、在代码里过滤，测试用临时文件 + 真实词库（只读）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { blockedByTitle, checkOutboundText, loadBlocked, lookup, status } from '../lib/meme-gate.mjs'

const DB = 'D:/DSH-home/profiles/desktop/node_modules/dsh-memewiki/data/memes.db'

function blockedFile(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'meme-gate-'))
  const file = join(dir, '梗百科-禁用条目.json')
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  return file
}

const LIST = {
  version: 1,
  blockedTags: ['政治梗', '软色情'],
  entries: [{ title: '五十万', why: '涉政' }, { title: '单', why: '太短不该拦' }],
}

test('禁用表读得出来，标题精确匹配', () => {
  const file = blockedFile(LIST)
  const list = loadBlocked(file)
  assert.equal(list.entries.length, 2)
  assert.equal(blockedByTitle(list, '五十万').why, '涉政')
  assert.equal(blockedByTitle(list, '别的梗'), null)
})

test('出站检查：单字标题不拦，多字标题出现就拦', () => {
  const list = loadBlocked(blockedFile(LIST))
  assert.equal(checkOutboundText(list, '看这个 五十万 梗'), '五十万')
  assert.equal(checkOutboundText(list, '我单身'), '')
  assert.equal(checkOutboundText(list, '白饭 才不是大肥鱼'), '')
})

test('禁用表文件不在时退化成空表，不报错', () => {
  const list = loadBlocked(join(tmpdir(), '不存在-梗百科.json'))
  assert.deepEqual(list.entries, [])
  assert.equal(checkOutboundText(list, '五十万'), '')
})

test('查梗：正常梗回内容，禁用梗只回「不能用」不回内容', async (t) => {
  const file = blockedFile(LIST)
  const st = status({ dbPath: DB, blockedFile: file })
  if (!st.dbExists) return t.skip('词库没装，跳过')
  const ok = await lookup({ dbPath: DB, blockedFile: file, query: '疯狂星期四' })
  assert.equal(ok.ok, true)
  const blocked = await lookup({ dbPath: DB, blockedFile: file, query: '五十万' })
  assert.equal(blocked.ok, true)
  const hit = blocked.items.find((it) => it.title === '五十万')
  assert.ok(hit)
  assert.equal(hit.blocked, true)
  // 禁用条目不许把正文带出来
  assert.equal(hit.summary, undefined)
  assert.equal(hit.usage, undefined)
})

test('查梗：标签命中禁用标签也不给内容', async (t) => {
  const file = blockedFile(LIST)
  const st = status({ dbPath: DB, blockedFile: file })
  if (!st.dbExists) return t.skip('词库没装，跳过')
  const got = await lookup({ dbPath: DB, blockedFile: file, query: 'ZZZQ' })
  if (!got.items.length) return t.skip('词库里没有这个词条')
  for (const item of got.items) {
    if (item.blocked) assert.equal(item.summary, undefined)
  }
})

test('查不到就明说没这条', async (t) => {
  const file = blockedFile(LIST)
  const st = status({ dbPath: DB, blockedFile: file })
  if (!st.dbExists) return t.skip('词库没装，跳过')
  const got = await lookup({ dbPath: DB, blockedFile: file, query: '这个梗一定不存在xyzq' })
  assert.equal(got.ok, true)
  assert.equal(got.items.length, 0)
  assert.match(got.note, /没这条/)
})
