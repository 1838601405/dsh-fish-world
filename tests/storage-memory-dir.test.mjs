// 「建立或修复目录」必须把面板上列出的结构一次建全，包括知识库目录。
//
// 真实问题（主人 2026-10-27）：点过「建立或修复」之后，鱼的记忆卡仍显示
// 「知识库还没建 …… 知识库.json」——因为 ensure() 只建了 6 个目录，
// 知识库目录不在里面，而主人并不知道那只是缺一个空目录。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStorage } from '../lib/storage.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fish-storage-memory-'))
  const root = join(home, '鱼的世界')
  const store = createStorage({
    home,
    // 用 config 指定根目录（createStorage 从 config.storage.root 读，要求绝对路径）
    config: () => ({ storage: { root } }),
    world: { root: () => root },
    logger: { info() {} },
  })
  return { home, root, store }
}

test('建立目录：知识库目录（鱼的记忆）也要建出来', () => {
  const { store } = fresh()
  const paths = store.ensure({ adopt: false })
  assert.ok(paths.memory, 'layout 里要有 memory')
  assert.equal(existsSync(paths.memory), true, '知识库目录必须被建出来，否则面板会一直说「知识库还没建」')
  // 与 lib/knowledge.mjs 的拼法一致：<root>/鱼的记忆
  assert.ok(paths.memory.endsWith('鱼的记忆'), paths.memory)
  assert.ok(paths.memory.startsWith(paths.root), '知识库目录必须在工作区里')
})

test('目录检查：缺失时能报出知识库目录，建立后恢复正常', () => {
  const { store } = fresh()
  const before = store.audit()
  const memoryItem = before.dirs.find((d) => d.key === 'memory')
  assert.ok(memoryItem, 'audit 必须列出知识库目录')
  assert.equal(memoryItem.exists, false, '还没建时应报缺失')
  assert.ok(before.problems.some((p) => /鱼的记忆/.test(p.text)), '缺失要进 problems，面板才看得见')

  store.ensure({ adopt: false })
  const after = store.audit()
  const item = after.dirs.find((d) => d.key === 'memory')
  assert.equal(item.exists, true)
  assert.equal(item.isDir, true)
  assert.equal(item.writable, true)
})

test('目录检查：知识库文件能解析时列为已建立，坏文件要报出来', () => {
  const { store } = fixtureWithKnowledge('{"version":1,"items":[{"id":"a","name":"A"}]}')
  const okIndex = store.audit().indexes.find((i) => i.key === 'knowledge')
  assert.ok(okIndex, 'audit 要列出知识库')
  assert.equal(okIndex.exists, true)
  assert.equal(okIndex.valid, true)

  const broken = fixtureWithKnowledge('{ 这不是 JSON')
  const badIndex = broken.store.audit().indexes.find((i) => i.key === 'knowledge')
  assert.equal(badIndex.exists, true)
  assert.equal(badIndex.valid, false, '解析失败要报出来，而不是当成没有')
})

function fixtureWithKnowledge(content) {
  const { store, home } = fresh()
  const paths = store.ensure({ adopt: false })
  mkdirSync(paths.memory, { recursive: true })
  writeFileSync(join(paths.memory, '知识库.json'), content, 'utf8')
  void home
  return { store }
}
