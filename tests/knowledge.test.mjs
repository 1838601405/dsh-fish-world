// 知识库服务：读真源、按开关走档、索引过期重建、坏后端降级。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { INDEX_FILE, KNOWLEDGE_FOLDER, createKnowledge, normalizeKnowledge } from '../lib/knowledge.mjs'

const ITEMS = {
  version: 1,
  items: [
    { id: 'poke', type: 'rule', name: '被戳就戳回去', aliases: ['戳一戳', '拍一拍'],
      meaning: '别人戳我一两下就戳回去，第三下开始哈气', usage: '收到戳时分级回应', avoid: '别被连戳带着走' },
    { id: 'kfc', type: 'meme', name: 'v我50 / 疯狂星期四', aliases: ['v我50', 'KFC'],
      meaning: '肯德基疯狂星期四的促销梗，装可怜要 50 块吃炸鸡', usage: '周四玩梗', avoid: '别真跟人要钱' },
    { id: 'claude', type: 'meme', name: '克劳德 / Claude', aliases: ['黄头发那个', '橙发'],
      meaning: '群里黄橙发的鱼是 Claude', usage: '认同人图', avoid: '别认成我' },
  ],
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fish-knowledge-'))
  mkdirSync(join(root, KNOWLEDGE_FOLDER), { recursive: true })
  writeFileSync(join(root, KNOWLEDGE_FOLDER, '知识库.json'), JSON.stringify(ITEMS), 'utf8')
  const storage = { layout: () => ({ root }) }
  return { root, storage }
}

function fakeFetch(rowsFactory) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    const rows = body.input.map((text, index) => ({ index, embedding: rowsFactory(text) }))
    return { ok: true, status: 200, json: async () => ({ data: rows }) }
  }
}

test('知识库不在：状态要如实报，不编', () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-knowledge-empty-'))
  const knowledge = createKnowledge({ storage: { layout: () => ({ root }) } })
  const state = knowledge.status()
  assert.equal(state.ok, false)
  assert.ok(state.error.includes('知识库还没建'))
  assert.equal(state.items, 0)
})

test('关着就是字面档：查得到、也能报没这条', async () => {
  const { storage } = fixture()
  const knowledge = createKnowledge({ storage, config: () => ({ knowledge: { enabled: false } }) })
  assert.equal(knowledge.status().items, 3)

  const hit = await knowledge.search('疯狂星期四')
  assert.equal(hit.ok, true)
  assert.equal(hit.backend, 'lexical')
  assert.equal(hit.hits[0].id, 'kfc')
  assert.ok(hit.hits[0].text.includes('是什么'))

  const miss = await knowledge.search('今天天气怎么样')
  assert.deepEqual(miss.hits, [])
})

test('空查询与空库都要报错，不许返回空结果冒充查过', async () => {
  const { storage } = fixture()
  const knowledge = createKnowledge({ storage })
  const empty = await knowledge.search('   ')
  assert.equal(empty.ok, false)
  assert.ok(empty.error.includes('没给要查的词'))
})

test('关着的时候 rebuild 直接拒绝（没开就没索引这回事）', async () => {
  const { storage } = fixture()
  const knowledge = createKnowledge({ storage, config: () => ({ knowledge: { enabled: false } }) })
  const made = await knowledge.rebuild()
  assert.equal(made.ok, false)
  assert.ok(made.error.includes('没开'))
})

test('打开：建索引、落盘、混合检索，改过知识库要重建', async () => {
  const { root, storage } = fixture()
  const fetchImpl = fakeFetch((text) => {
    const s = String(text)
    const hit = (w) => (s.includes(w) ? 1 : 0)
    return [hit('肯德基') + hit('炸鸡') + hit('星期四'), hit('克劳德') + hit('黄'), hit('戳') + hit('拍'), 0.1]
  })
  const knowledge = createKnowledge({
    storage,
    fetchImpl,
    config: () => ({ knowledge: { enabled: true, mode: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'toy' } }),
  })

  const found = await knowledge.search('那个黄头发的鱼')
  assert.equal(found.ok, true)
  assert.equal(found.backend, 'hybrid')
  assert.equal(found.hits[0].id, 'claude')

  const indexFile = join(root, KNOWLEDGE_FOLDER, INDEX_FILE)
  assert.equal(existsSync(indexFile), true)
  const saved = JSON.parse(readFileSync(indexFile, 'utf8'))
  assert.equal(saved.model.id, 'toy')
  assert.equal(saved.items.length, 3)
  assert.ok(saved.kbMtime > 0)
  assert.equal(knowledge.status().indexFresh, true)

  // 知识库改一行，索引就该判过期（下一轮重建）
  await new Promise((r) => setTimeout(r, 15))
  const changed = structuredClone(ITEMS)
  changed.items.push({ id: 'nailong', type: 'meme', name: '奶龙', meaning: '黄龙', usage: '认图', avoid: '' })
  writeFileSync(join(root, KNOWLEDGE_FOLDER, '知识库.json'), JSON.stringify(changed), 'utf8')
  const state = knowledge.status()
  assert.equal(state.indexFresh, false)
  assert.ok(state.indexWhy.includes('重建'))

  const again = await knowledge.search('奶龙')
  assert.equal(again.ok, true)
  assert.equal(again.hits[0].id, 'nailong')
  assert.equal(knowledge.status().items, 4)
})

test('换了模型：索引整体作废，不许混着算', async () => {
  const { storage } = fixture()
  let model = 'm1'
  let dim = 3
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const data = body.input.map((t, index) => ({ index, embedding: Array.from({ length: dim }, () => String(t).length) }))
    return { ok: true, status: 200, json: async () => ({ data }) }
  }
  const knowledge = createKnowledge({
    storage,
    fetchImpl,
    config: () => ({ knowledge: { enabled: true, mode: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model } }),
  })
  const first = await knowledge.search('KFC')
  assert.equal(first.backend, 'hybrid')
  assert.equal(knowledge.status().index.model, 'm1')

  model = 'm2'
  dim = 5
  const second = await knowledge.search('KFC')
  assert.equal(second.ok, true)
  assert.equal(knowledge.status().index.model, 'm2')
  assert.equal(knowledge.status().index.dim, 5)
})

test('向量那步坏了：当轮退回字面档，原因要写出来', async () => {
  const { storage } = fixture()
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const knowledge = createKnowledge({
    storage,
    fetchImpl,
    config: () => ({ knowledge: { enabled: true, mode: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'dead' } }),
  })
  const found = await knowledge.search('疯狂星期四')
  assert.equal(found.ok, true)
  assert.equal(found.backend, 'lexical')
  assert.ok(found.notes.join(' ').includes('字面档'))
})

test('normalizeKnowledge：只认绝对路径，关着就是关着', () => {
  const off = normalizeKnowledge({})
  assert.equal(off.enabled, false)
  assert.equal(off.mode, 'off')
  assert.equal(off.limit, 3)
  const withIndex = normalizeKnowledge({ enabled: true, mode: 'openai', model: 'm', baseUrl: 'http://127.0.0.1:1/v1', indexFile: '相对/索引.json' })
  assert.equal(withIndex.indexFile, '')
})

test('本地模型：注入运行库就能建索引走混合档', async () => {
  const { storage } = fixture()
  const fakeLib = {
    env: {},
    pipeline: async () => async (texts) => ({
      tolist: () => texts.map((t) => {
        const s = String(t)
        const hit = (w) => (s.includes(w) ? 1 : 0)
        return [hit('肯德基') + hit('炸鸡') + hit('星期四'), hit('克劳德') + hit('黄'), hit('戳') + hit('拍'), 0.1]
      }),
    }),
  }
  const knowledge = createKnowledge({
    storage,
    loadLibrary: async () => fakeLib,
    config: () => ({ knowledge: { enabled: true, mode: 'local', localModel: 'toy/bge' } }),
  })
  const found = await knowledge.search('那条黄头发的鱼')
  assert.equal(found.ok, true)
  assert.equal(found.backend, 'hybrid')
  assert.equal(found.hits[0].id, 'claude')
  assert.equal(knowledge.status().index.model, 'local:toy/bge')
})

test('本地模型没装：当轮退回字面档，别把这一问也弄挂', async () => {
  const { storage } = fixture()
  const knowledge = createKnowledge({
    storage,
    loadLibrary: async () => { throw new Error('没找到 @huggingface/transformers') },
    config: () => ({ knowledge: { enabled: true, mode: 'local', localModel: 'toy/bge' } }),
  })
  const found = await knowledge.search('疯狂星期四')
  assert.equal(found.ok, true)
  assert.equal(found.backend, 'lexical')
  assert.equal(found.hits[0].id, 'kfc')
  assert.ok(found.notes.join(' ').includes('字面档'))
})
