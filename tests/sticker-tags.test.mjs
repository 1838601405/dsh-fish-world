// 表情标签体系：同义词归一 / 去重 / 维度提示词。
// 主人 2026-11-09：标签要细、别重复太多，鱼只按标签取图，不再逐张识别画面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeTags, dedupeTags, normalizeTag, promptHints, TAG_DIMENSIONS } from '../lib/sticker-tags.mjs'

test('同义词归一：同一件事只留一种写法', () => {
  assert.equal(normalizeTag('摸一摸'), '摸头')
  assert.equal(normalizeTag('被摸头'), '摸头')
  assert.equal(normalizeTag('摸摸头'), '摸头')
  assert.equal(normalizeTag('高兴'), '开心')
  assert.equal(normalizeTag('GIF'), '动图')
  assert.equal(normalizeTag('gif'), '动图')
  assert.equal(normalizeTag('鲸鱼娘'), '蓝鲸娘')
})

test('归一化顺手去掉结尾的「了」', () => {
  assert.equal(normalizeTag('害羞了'), '害羞')
  assert.equal(normalizeTag('好困了'), '困') // 「好困」本身也是同义词，归到词表里的「困」
})

test('去重：归一后重复的只留一条，保序、丢空串', () => {
  assert.deepEqual(dedupeTags(['摸一摸', '摸头', '开心', '高兴', '', null]), ['摸头', '开心'])
})

test('词表内的标签排前面（鱼看目录时常用词更显眼）', () => {
  const out = canonicalizeTags(['自创词', '开心', '另一个自创'])
  assert.equal(out[0], '开心')
})

test('提示词带五个维度、动图要求和「别自创新词」', () => {
  const text = promptHints()
  for (const dim of TAG_DIMENSIONS) assert.ok(text.includes(dim.key), '缺维度：' + dim.key)
  assert.ok(text.includes('动图'), '动图必须写')
  assert.ok(text.includes('不要自创新词'), '要限制造词')
})

test('五个维度都有样例词，不是空壳', () => {
  for (const dim of TAG_DIMENSIONS) {
    assert.ok(Array.isArray(dim.sample) && dim.sample.length >= 4, dim.key + ' 样例太少')
  }
})
