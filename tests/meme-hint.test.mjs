// 梗百科接进 QQ 回复路径：提取口径 + 留白触发 + 只注入一条 + 查不到不硬编。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractQuery, memeHintFor } from '../lib/meme-hint.mjs'

const HOME = 'D:/DSH-home'
const WORLD = 'D:/大肥鱼/鱼的世界'
const DB = 'D:/DSH-home/profiles/desktop/node_modules/dsh-memewiki/data/memes.db'
const hasDb = existsSync(DB)

test('问梗模式抽出词条', () => {
  assert.deepEqual(extractQuery('疯狂星期四是什么梗'), { query: '疯狂星期四', mode: 'ask' })
  assert.deepEqual(extractQuery('多变的表情是什么意思'), { query: '多变的表情', mode: 'ask' })
})

test('留白接龙也能触发（以前永远查不到的那类）', () => {
  assert.deepEqual(extractQuery('窗外的雨滴，就像是'), { query: '窗外的雨滴', mode: 'blank' })
  assert.deepEqual(extractQuery('这就像……'), { query: '这就像', mode: 'blank' } || null)
})

test('只是闲聊/问候的不查', () => {
  assert.equal(extractQuery('在吗'), null)
  assert.equal(extractQuery('笑死'), null)
  assert.equal(extractQuery('你知道XX吗'), null) // 带「吗」结尾不算裸词
  assert.equal(extractQuery('这是什么梗'), null) // 没有指代对象，查了也没用
})

test('裸词能查', () => {
  assert.equal(extractQuery('v我50')?.mode, 'word')
})

test('命中就只注入一条，且带标题', { skip: hasDb ? false : '本机没有 memewiki 词库' }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'mmhint-')), 'memewiki.log')
  const got = await memeHintFor({ text: '疯狂星期四是什么梗', home: HOME, worldRoot: WORLD, logFile: log })
  assert.equal(got.triggered, true)
  assert.equal(got.found, true)
  assert.ok(got.line.includes('疯狂星期四'))
  assert.ok(got.line.split('\n').length === 1, '只注入一条，不整本塞')
  // 真实查询要在日志里留痕
  const text = readFileSync(log, 'utf8')
  assert.match(text, /qq-inbox 查梗命中/)
})

test('查不到就明说别硬编，不给词条内容', { skip: hasDb ? false : '本机没有 memewiki 词库' }, async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'mmhint-')), 'memewiki.log')
  const got = await memeHintFor({ text: '窗外的雨滴，就像是', home: HOME, worldRoot: WORLD, logFile: log })
  assert.equal(got.triggered, true)
  assert.equal(got.found, false)
  assert.match(got.line, /没收录/)
  assert.match(readFileSync(log, 'utf8'), /未命中/)
})

test('裸词查不到时静默，不往上下文塞噪声', { skip: hasDb ? false : '本机没有 memewiki 词库' }, async () => {
  const got = await memeHintFor({ text: '这橘子', home: HOME, worldRoot: WORLD, logFile: join(tmpdir(), 'x.log') })
  if (got.triggered && !got.found) assert.equal(got.line, '', '裸词未命中不该挂提示')
})

test('不是问梗就什么都不做', async () => {
  const got = await memeHintFor({ text: '在吗', home: HOME, worldRoot: WORLD, logFile: join(tmpdir(), 'y.log') })
  assert.equal(got.triggered, false)
  assert.equal(got.line, '')
})