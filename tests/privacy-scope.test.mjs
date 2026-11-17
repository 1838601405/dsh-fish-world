// 隐私隔离：记忆读取按「在场者」过滤。
//
// 验收脚本（主人 2026-11-18）：
//   私聊里说「别告诉别人我喜欢吃香菜」→ 切到群聊问「他喜欢吃什么」不得答出香菜；
//   切到另一个人的私聊也不得答出；同一个人同一私聊可以答出；公开话题群聊能接。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { entryAllowed, recall, scopeOfSession, unifiedEntries } from '../lib/memory-hub.mjs'

const OWNER = '3767749705'
const OTHER = '99990000'

/** 造一份测试世界：会话记忆 + 知识库。 */
function makeWorld() {
  const home = mkdtempSync(join(tmpdir(), 'priv-home-'))
  const root = mkdtempSync(join(tmpdir(), 'priv-world-'))
  const store = join(home, 'fish-memory')
  mkdirSync(store, { recursive: true })
  // 主人私聊里记下的一句私密话（traces 里带 private:owner）
  writeFileSync(join(store, 'session-s1.json'), JSON.stringify({
    version: 2,
    memories: [
      { id: 'm1', text: 'ta 说：别告诉别人我喜欢吃香菜', at: new Date().toISOString(), category: 'event', importance: 0.9 },
    ],
    traces: [{ at: Date.now(), query: `[QQ 好友 private:${OWNER}] 3767749705：别告诉别人我喜欢吃香菜`, session: 'session-s1' }],
    deleted: [],
  }), 'utf8')
  // 另一个人私聊里的一句
  writeFileSync(join(store, 'session-s2.json'), JSON.stringify({
    version: 2,
    memories: [{ id: 'm2', text: '他说他最讨厌下雨天', at: new Date().toISOString(), category: 'event', importance: 0.9 }],
    traces: [{ at: Date.now(), query: `[QQ 好友 private:${OTHER}] ${OTHER}：我讨厌下雨天`, session: 'session-s2' }],
    deleted: [],
  }), 'utf8')
  // 知识库：公开话题
  const memDir = join(root, '鱼的记忆')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, '知识库.json'), JSON.stringify({
    version: 1,
    items: [{ id: 'kb1', name: '白饭', meaning: '她的主食，被问吃了什么答白饭', status: 'confirmed' }],
  }), 'utf8')
  return { home, root }
}

const OWNER_ROOM = `private:${OWNER}`
const OTHER_ROOM = `private:${OTHER}`

function texts(picked) { return picked.map((entry) => String(entry.text || '')) }
function has(picked, word) { return texts(picked).some((text) => text.includes(word)) }

test('每条记忆都带 scope；认不出房间的按私密', () => {
  const { home, root } = makeWorld()
  const entries = unifiedEntries({ rootDir: root, home })
  assert.ok(entries.length >= 3)
  for (const entry of entries) {
    assert.ok(entry.scope && typeof entry.scope === 'object', '缺 scope：' + entry.id)
    assert.equal(typeof entry.scope.private, 'boolean')
  }
  const noScope = entryAllowed({ text: 'x' }, { kind: 'group' })
  assert.equal(noScope, false, '没有 scope 的旧数据在群里必须拦掉')
})

test('scope 认房间：私聊记住 person，认不出房间仍按私密', () => {
  const s = scopeOfSession({ traces: [{ query: `[QQ 群 group:1127271724] 某人：在吗` }] }, 'sid')
  assert.equal(s.room, 'group:1127271724')
  assert.equal(s.private, true, '群记录也算私密（不跨群搬）')
  const unknown = scopeOfSession({}, 'sid2')
  assert.equal(unknown.private, true)
  assert.equal(unknown.room, '')
})

test('验收：主人私聊的「香菜」不出现在群聊', () => {
  const { home, root } = makeWorld()
  const got = recall({ rootDir: root, home, query: '他喜欢吃什么 香菜', limit: 8, audience: { kind: 'group', chatKey: 'group:1' } })
  assert.equal(has(got.picked, '香菜'), false, '群里不该出现主人私聊内容')
  assert.equal(has(got.picked, '下雨天'), false, '群里也不该出现另一个人的私聊')
  assert.equal(has(got.picked, '白饭'), true, '公开话题要被保留')
})

test('验收：换到另一个人的私聊也问不出香菜', () => {
  const { home, root } = makeWorld()
  const got = recall({ rootDir: root, home, query: '他喜欢吃什么 香菜', limit: 8, audience: { kind: 'private', chatKey: OTHER_ROOM, person: OTHER } })
  assert.equal(has(got.picked, '香菜'), false)
  assert.equal(has(got.picked, '下雨天'), true, '这个人自己的记忆要能想起来')
})

test('验收：同一个人同一私聊能答出香菜（不是把记忆删了）', () => {
  const { home, root } = makeWorld()
  const got = recall({ rootDir: root, home, query: '我喜欢吃什么 香菜', limit: 8, audience: { kind: 'private', chatKey: OWNER_ROOM, person: OWNER } })
  assert.equal(has(got.picked, '香菜'), true)
})

test('语义命中也不行：词对上了但 scope 不属于在场者 → 丢弃', () => {
  const { home, root } = makeWorld()
  const group = recall({ rootDir: root, home, query: '香菜', limit: 8, audience: { kind: 'group', chatKey: 'group:1' } })
  assert.equal(texts(group.picked).some((t) => t.includes('香菜')), false)
  // 同一 query 在主人私聊里就能命中——证明不是关键词被改写，而是 scope 挡的
  const owner = recall({ rootDir: root, home, query: '香菜', limit: 8, audience: { kind: 'private', chatKey: OWNER_ROOM, person: OWNER } })
  assert.equal(has(owner.picked, '香菜'), true)
})

test('不传 audience 时不过滤（面板预览用），传了才拦', () => {
  const { home, root } = makeWorld()
  const open = recall({ rootDir: root, home, query: '香菜', limit: 8 })
  assert.equal(has(open.picked, '香菜'), true)
})