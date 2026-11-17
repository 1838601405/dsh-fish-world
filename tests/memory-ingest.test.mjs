// 入库管道三件：话题属性、延迟摘要（缓存）、指代消歧 → scope。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TOPICS, lazySummary, readScopeHints, resolveCoref, summaryKey, tagTopics, writeScopeHint } from '../lib/memory-ingest.mjs'
import { localConfigOf } from '../lib/local-model.mjs'
import { recall } from '../lib/memory-hub.mjs'

function counterRunner({ reply = '{}', summary = '一句摘要' } = {}) {
  const calls = []
  return {
    calls,
    ok: true,
    via: 'fake',
    model: 'fake-4b',
    async generate(prompt) {
      calls.push(prompt)
      if (prompt.includes('摘要')) return summary
      return reply
    },
  }
}

test('话题属性：没有本地模型时按关键词规则标，并标明 fallback', async () => {
  const got = await tagTopics('ta 说以后每次都要先问一句，约定好了')
  assert.ok(got.topics.includes('约定'), JSON.stringify(got))
  assert.equal(got.via, 'fallback')
  for (const topic of got.topics) assert.ok(TOPICS.includes(topic))
})

test('话题属性：有本地模型就让它标，via 记模型来源', async () => {
  const runner = counterRunner({ reply: '["偏好","关系"]' })
  const got = await tagTopics('他喜欢吃香菜', { runner })
  assert.deepEqual(got.topics, ['偏好', '关系'])
  assert.equal(got.via, 'fake')
})

test('延迟摘要：第一次生成并落缓存，第二次不再调模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-'))
  const cacheFile = join(dir, '摘要缓存.json')
  const runner = counterRunner({ summary: '她爱吃香菜，别外传' })

  const first = await lazySummary({ id: 'm1', text: '别告诉别人我喜欢吃香菜', cacheFile, runner })
  assert.equal(first.ok, true)
  assert.equal(first.cached, false)
  assert.equal(runner.calls.length, 1)

  const second = await lazySummary({ id: 'm1', text: '别告诉别人我喜欢吃香菜', cacheFile, runner })
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(runner.calls.length, 1, '第二次必须直接读缓存，不再调模型')
  assert.equal(second.summary, '她爱吃香菜，别外传')
  assert.ok(existsSync(cacheFile))
})

test('延迟摘要：没有本地模型就不生成（不编），也不写缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lazy2-'))
  const cacheFile = join(dir, '摘要缓存.json')
  const got = await lazySummary({ id: 'm2', text: '别告诉别人我喜欢吃香菜', cacheFile, runner: { ok: false } })
  assert.equal(got.ok, false)
  assert.equal(got.summary, '')
  assert.equal(existsSync(cacheFile), false)
})

test('缓存键随原文变化：改了原文就重新生成', () => {
  assert.notEqual(summaryKey('m1', '原文A'), summaryKey('m1', '原文B'))
  assert.equal(summaryKey('m1', '原文A'), summaryKey('m1', '原文A'))
})

test('指代消歧：规则兜底能认出第三方指代与在场对象', async () => {
  const got = await resolveCoref({ text: '别告诉他我喜欢吃香菜', speaker: '3767749705', listener: '10001' })
  assert.equal(got.self, '3767749705')
  assert.equal(got.other, '10001')
  assert.ok(got.thirdParty.includes('他'))
  assert.equal(got.via, 'fallback')
})

test('指代消歧：有模型时用模型回的 JSON', async () => {
  const runner = counterRunner({ reply: '{"self":"A","other":"B","thirdParty":"C"}' })
  const got = await resolveCoref({ text: '她说他爱吃香菜', speaker: 'A', listener: 'B', runner })
  assert.equal(got.thirdParty, 'C')
  assert.equal(got.via, 'fake')
})

test('消歧结果写进 scope：群里问不出私聊里的香菜，同一私聊能答出', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ingest-home-'))
  const root = mkdtempSync(join(tmpdir(), 'ingest-world-'))
  const store = join(home, 'fish-memory')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'session-s1.json'), JSON.stringify({
    version: 2,
    memories: [{ id: 'm1', text: '别告诉别人我喜欢吃香菜', at: new Date().toISOString(), category: 'event' }],
    traces: [],
    deleted: [],
  }), 'utf8')

  // ingest：标话题 + 消歧 + 落 scope 线索（房间认不出，靠消歧给出人物）
  const coref = await resolveCoref({ text: '别告诉别人我喜欢吃香菜', speaker: '3767749705', listener: '10001' })
  const hintFile = join(root, '鱼的记忆', 'scope-hints.json')
  writeScopeHint({
    file: hintFile,
    id: 'm1',
    scope: { room: '', person: coref.self, private: true },
    evidence: coref.evidence,
    via: coref.via,
  })
  assert.ok(readScopeHints(hintFile).m1, '线索要落盘')

  const group = recall({ rootDir: root, home, query: '他喜欢吃什么 香菜', limit: 8, audience: { kind: 'group', chatKey: 'group:1' } })
  assert.equal(group.picked.some((e) => String(e.text).includes('香菜')), false, '群里答不出')

  const other = recall({ rootDir: root, home, query: '他喜欢吃什么 香菜', limit: 8, audience: { kind: 'private', chatKey: 'private:10001', person: '10001' } })
  assert.equal(other.picked.some((e) => String(e.text).includes('香菜')), false, '别人私聊也答不出')

  const owner = recall({ rootDir: root, home, query: '我喜欢吃什么 香菜', limit: 8, audience: { kind: 'private', chatKey: 'private:3767749705', person: '3767749705' } })
  assert.equal(owner.picked.some((e) => String(e.text).includes('香菜')), true, '同一私聊要答得出')
})

test('本地模型配置口径：复用 kb-vector 的 localModel/localDir/dtype', () => {
  const cfg = localConfigOf({ localModel: 'Qwen/Qwen3.5-4B-Instruct', localDir: 'D:\\models', localDtype: 'q4' })
  assert.equal(cfg.model, 'Qwen/Qwen3.5-4B-Instruct')
  assert.equal(cfg.localDir, 'D:\\models')
  assert.equal(cfg.dtype, 'q4')
  assert.ok(cfg.maxTokens >= 32)
})

test('会话级线索：ingest 记下「这个会话属于谁」，recall 按它补 scope', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ingest-home2-'))
  const root = mkdtempSync(join(tmpdir(), 'ingest-world2-'))
  const store = join(home, 'fish-memory')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'session-sid0099.json'), JSON.stringify({
    version: 2,
    memories: [{ id: 'm9', text: '他说他喜欢喝冰美式', at: new Date().toISOString(), category: 'event' }],
    traces: [],
    deleted: [],
  }), 'utf8')
  // ingest 在收信时落的是 session 级线索（qq-inbox 就是这么写的）
  writeScopeHint({
    file: join(root, '鱼的记忆', 'scope-hints.json'),
    id: 'session:sid0099',
    scope: { room: 'private:3767749705', person: '3767749705', private: true },
    evidence: '句中出现「你」：对象在场',
    via: 'fallback/fallback',
  })
  const inOwner = recall({ rootDir: root, home, query: '喜欢喝什么 冰美式', limit: 8, audience: { kind: 'private', chatKey: 'private:3767749705', person: '3767749705' } })
  assert.equal(inOwner.picked.some((e) => String(e.text).includes('冰美式')), true, '主人私聊要答得出')
  const inGroup = recall({ rootDir: root, home, query: '喜欢喝什么 冰美式', limit: 8, audience: { kind: 'group', chatKey: 'group:1' } })
  assert.equal(inGroup.picked.some((e) => String(e.text).includes('冰美式')), false, '群里答不出')
})
