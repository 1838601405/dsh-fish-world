#!/usr/bin/env node
// 表情锚点回填 / 重算：把每张图的「原意」派生出一组锚点（use + role + w）。
//
//   node scripts/derive-sticker-anchors.mjs           只算不写（dry-run，默认）
//   node scripts/derive-sticker-anchors.mjs --write   写回 stickers.json（先备份）
//   node scripts/derive-sticker-anchors.mjs --write --file <索引路径>
//
// 纪律（主人 2026-11-18）：
//   · 改词表 / 改规则后**只拿「原意」重算**，不重读图；所以原意一旦有了就复用，不覆盖。
//   · 弃掉的不进库，但理由要存档（锚点派生-弃档.json），备查「弃的有没有误杀」。
//   · 不写任何具体图片的专门规则：规则全在 lib/sticker-annotate.mjs 的通用词表里。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deriveAnchors, explainDerive, vocabSanity } from '../lib/sticker-annotate.mjs'
import { deriveOrigin } from '../lib/sticker-origin.mjs'
import { DERIVE_VERSION } from '../lib/sticker-vocab.mjs'

const args = new Set(process.argv.slice(2))
const write = args.has('--write')
const fileArg = (() => {
  const i = process.argv.indexOf('--file')
  return i > 0 ? process.argv[i + 1] : ''
})()
const FILE = fileArg || 'D:/大肥鱼/鱼的世界/鱼之宝库/图库/stickers.json'
const ARCHIVE = join(dirname(FILE), '锚点派生-弃档.json')

const sanity = vocabSanity()
if (!sanity.ok) {
  console.error('词表自检没过：' + JSON.stringify(sanity))
  process.exit(2)
}
if (!existsSync(FILE)) {
  console.error('找不到索引：' + FILE)
  process.exit(2)
}

const raw = JSON.parse(readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''))
const items = Array.isArray(raw.stickers) ? raw.stickers : []
let derived = 0
let keptOrigin = 0
let noAnchor = 0
const discardArchive = []
const anchorCounter = new Map()
const roleCounter = new Map()

for (const item of items) {
  const tagWords = Array.isArray(item.tagWords)
    ? item.tagWords
    : (Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [])
  // 原意已经有画面就直接用（不重读图）；没有才从名字/说明/自由词还原一次。
  const existing = item['原意'] && String(item['原意'].画面 || '').trim() && !/unknown/i.test(String(item['原意'].画面))
  const origin = existing
    ? { 画面: item['原意'].画面, 情绪: item['原意'].情绪 || 'unknown', 梗: item['原意'].梗 || 'unknown' }
    : deriveOrigin({ name: item.name, note: item.note, tagWords })
  if (existing) keptOrigin += 1
  const result = deriveAnchors({ origin, words: tagWords })
  if (!result.anchors.length) noAnchor += 1
  if (result.discarded.length) {
    discardArchive.push({
      id: item.id,
      name: item.name,
      原意: origin,
      discarded: result.discarded.map((d) => ({ use: d.use, role: d.role, why: d.why })),
      explain: explainDerive(result).filter((line) => line.startsWith('弃：')),
    })
  }
  for (const a of result.anchors) {
    anchorCounter.set(a.use, (anchorCounter.get(a.use) || 0) + 1)
    roleCounter.set(a.role, (roleCounter.get(a.role) || 0) + 1)
  }
  if (write) {
    item['原意'] = { 画面: origin.画面, 情绪: origin.情绪, 梗: origin.梗 }
    item.tags = result.anchors.map(({ act, role, use, w }) => ({ act, role, use, w }))
    item.tagWords = tagWords
    item.deriveVersion = DERIVE_VERSION
    derived += 1
  }
}

const summary = {
  file: FILE,
  deriveVersion: DERIVE_VERSION,
  mode: write ? 'write' : 'dry-run',
  total: items.length,
  derived,
  reusedOrigin: keptOrigin,
  withoutAnchor: noAnchor,
  anchors: [...anchorCounter.entries()].sort((a, b) => b[1] - a[1]),
  roles: [...roleCounter.entries()].sort((a, b) => b[1] - a[1]),
  discarded: discardArchive.length,
}
console.log(JSON.stringify(summary, null, 2))

if (write) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${FILE}.bak-before-derive-${stamp}`
  try { if (!existsSync(backup)) copyFileSync(FILE, backup) } catch {}
  raw.stickers = items
  const tmp = `${FILE}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
  writeFileSync(FILE, JSON.stringify(raw, null, 2), 'utf8')
  writeFileSync(tmp, '', 'utf8')
  writeFileSync(ARCHIVE, JSON.stringify({ deriveVersion: DERIVE_VERSION, at: new Date().toISOString(), items: discardArchive }, null, 2), 'utf8')
  console.log('written: ' + FILE + '（备份 ' + backup + '）')
  console.log('弃档: ' + ARCHIVE)
  // 人看的索引跟着重画（图库索引.md 是派生物，别让它停在旧标签上）。
  try {
    const { createStickers } = await import('../lib/stickers.mjs')
    const { dirname: dirOf } = await import('node:path')
    const gallery = dirOf(FILE)
    const store = createStickers({ home: 'D:/DSH-home', config: () => ({ stickers: { enabled: true, hourlyLimit: 0 } }), storage: { layout: () => ({ gallery }), appendSecurity() {} } })
    if (typeof store.rebuildGalleryIndex === 'function') store.rebuildGalleryIndex()
    console.log('索引已重画：' + gallery + '/图库索引.md')
  } catch (error) {
    console.log('索引重画失败（不影响数据）：' + String(error?.message || error))
  }
}