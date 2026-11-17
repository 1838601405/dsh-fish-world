#!/usr/bin/env node
// 锚点覆盖率体检：把一批「真实句子」映射到 use 词表，算未命中率。
//
//   node scripts/anchor-coverage.mjs                     扫描默认语料（知识库 + 鱼记忆 + 日记）
//   node scripts/anchor-coverage.mjs --file <path.jsonl>  用自己的一批句子（每行一条，或 JSON 里 text 字段）
//
// 判据（主人 2026-11-18 第六节第 3 条）：拿 200 条真实回复映射到 use 词表，算未命中率。
// 这里只做「能不能映射到 12 个动作短语」这一件事，不判断该不该发图。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { USES, normalizeUse } from '../lib/sticker-vocab.mjs'

const WORLD = 'D:/大肥鱼/鱼的世界'
const argFile = (() => {
  const i = process.argv.indexOf('--file')
  return i > 0 ? process.argv[i + 1] : ''
})()

function collectTexts() {
  const out = []
  const push = (text) => {
    const s = String(text || '').trim()
    if (s.length >= 2 && s.length <= 120) out.push(s)
  }
  // 知识库里的语录原句
  try {
    const kb = JSON.parse(readFileSync(join(WORLD, '鱼的记忆', '知识库.json'), 'utf8').replace(/^\uFEFF/, ''))
    for (const item of kb.items || []) {
      if (item.quote) push(item.quote)
      if (item.meaning) push(item.meaning)
    }
  } catch {}
  // 鱼的记忆（session-*.json 里的 memories[].text）
  const memDir = join(WORLD, '鱼的记忆')
  try {
    for (const name of readdirSync(memDir)) {
      if (!/^session-.*\.json$/.test(name)) continue
      try {
        const raw = JSON.parse(readFileSync(join(memDir, name), 'utf8'))
        for (const row of raw.memories || []) push(row.text)
      } catch {}
    }
  } catch {}
  // 日记
  const diaryDir = join(WORLD, '鱼的日记')
  try {
    for (const name of readdirSync(diaryDir)) {
      if (!name.endsWith('.json') && !name.endsWith('.md')) continue
      const text = readFileSync(join(diaryDir, name), 'utf8')
      for (const line of text.split(/[\n。！？]/)) push(line)
    }
  } catch {}
  return out
}

const texts = argFile && existsSync(argFile)
  ? readFileSync(argFile, 'utf8').split(/\n+/).map((line) => line.trim()).filter(Boolean)
  : collectTexts()

const hits = new Map()
let miss = 0
for (const text of texts) {
  const use = normalizeUse(text)
  if (use) hits.set(use, (hits.get(use) || 0) + 1)
  else miss += 1
}
const total = texts.length
console.log(JSON.stringify({
  source: argFile || '知识库 + 鱼记忆 + 日记',
  total,
  hit: total - miss,
  miss,
  missRate: total ? Math.round((miss / total) * 1000) / 10 + '%' : 'n/a',
  byUse: [...hits.entries()].sort((a, b) => b[1] - a[1]),
  vocab: USES,
}, null, 2))