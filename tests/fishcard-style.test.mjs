// 鱼卡 v3 风格层判据（规格 §4 / §10 预算 200 字）。
//
// ★ 验收 #9「私聊与群聊回复长度中位数差 ≥ 2 倍」是**行为验收**，要真跑对话统计，
//   这里验不到（标在收口单 §五）。这里能钉住的是它成立的前提：
//   ① 场景选对（选错场景就永远不会差 2 倍）
//   ② 文本**原样**返回（trim/截断会污染长度统计）
//   ③ 没有风格文件时返回 null（装配跳过 ⇒ 默认行为逐字节不变，M6）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickStyle, styleFile, loadStyle, SCENES, STYLE_FOLDER } from '../lib/fishcard-style.mjs'

function mkHome() {
  const home = mkdtempSync(join(tmpdir(), 'fstyle-'))
  mkdirSync(join(home, STYLE_FOLDER), { recursive: true })
  return home
}

test('★★ pickStyle：三个场景各选各的，面板是默认', () => {
  assert.equal(pickStyle({ kind: 'group' }), '群聊')
  assert.equal(pickStyle({ kind: 'private' }), '私聊')
  assert.equal(pickStyle({ kind: 'panel' }), '面板', '★ 面板显式给也认')
  assert.equal(pickStyle({}), '面板', '★ 没有 kind → 面板（默认，规格把面板当基准）')
  assert.equal(pickStyle(null), '面板', '★ null 不炸')
  // 规格 §4 的三列一个都不能少
  assert.deepEqual(SCENES, ['群聊', '私聊', '面板'])
})

test('★ styleFile：路径约定 `<家>/风格/<场景>.md`（同一个文件族，不开新存储）', () => {
  const home = 'D:/某处/fish-world-personas'
  assert.equal(styleFile(home, '群聊'), join(home, STYLE_FOLDER, '群聊.md'))
  // 场景名非法 / 没给 → 按 facts 选
  assert.equal(styleFile(home, '不存在的场景', { kind: 'private' }), join(home, STYLE_FOLDER, '私聊.md'))
  assert.equal(styleFile(home, undefined, { kind: 'group' }), join(home, STYLE_FOLDER, '群聊.md'))
  // ★ 只认三个场景，路径不能被注入（安全：scene 里带 ../ 也不能逃出去）
  assert.equal(styleFile(home, '../../etc/passwd', { kind: 'group' }), join(home, STYLE_FOLDER, '群聊.md'))
})

test('★★ loadStyle：文件不存在 / 空文件 / home 缺失 → null（装配据此跳过，默认行为不变）', () => {
  const home = mkHome()
  assert.equal(loadStyle({ home, scene: '群聊' }), null, '★ 文件不在 → null，不是空串也不是抛错')
  assert.equal(loadStyle({}), null, '★ 没给 home → null')
  assert.equal(loadStyle({ home: '', scene: '群聊' }), null)

  // 空文件（或只有空白）→ 当没有，别注入一个空段
  writeFileSync(join(home, STYLE_FOLDER, '私聊.md'), '   \n')
  assert.equal(loadStyle({ home, scene: '私聊' }), null, '★ 空文件当没有')
})

test('★★ loadStyle：读到就**原样**返回（不 trim 不截断 —— 验收 #9 长度统计的前提）', () => {
  const home = mkHome()
  const text = '  想到半句就发。断行、省标点都行。\n\n'
  writeFileSync(join(home, STYLE_FOLDER, '群聊.md'), text, 'utf8')

  const r = loadStyle({ home, scene: '群聊' })
  assert.ok(r, '★ 读到了')
  assert.equal(r.scene, '群聊')
  assert.equal(r.text, text, '★★ 必须逐字节原样 —— trim 了长度统计就假了')
})

test('★★ BOM 要剥掉（编码标记不是内容，留着会脏 prompt 第一行）', () => {
  const home = mkHome()
  // Windows 记事本 / PowerShell `Set-Content -Encoding UTF8` 存出来就是这个形状
  const file = join(home, STYLE_FOLDER, '群聊.md')
  writeFileSync(file, '﻿我在群里话短。', 'utf8')

  // 前提：**文件**确实带 BOM（查文件，不是查返回值 —— 返回值本来就不该带）
  const onDisk = readFileSync(file, 'utf8')
  assert.equal(onDisk.charCodeAt(0), 0xfeff, '前提：文件确实带 BOM')

  const r = loadStyle({ home, scene: '群聊' })
  assert.ok(r, '★ 读到了')
  assert.notEqual(r.text.charCodeAt(0), 0xfeff, '★ 返回值不许带 BOM')
  assert.equal(r.text, '我在群里话短。', '★ 只剥标记，内容一个字不动')
  assert.ok(r.text.length <= 200, '★ 长度按剥完算（否则预算统计虚高）')
})

test('★ loadStyle 按 facts 选（不给 scene 时）', () => {
  const home = mkHome()
  writeFileSync(join(home, STYLE_FOLDER, '面板.md'), '带信息，不装可爱。', 'utf8')
  writeFileSync(join(home, STYLE_FOLDER, '私聊.md'), '可以撒娇、可以追问。', 'utf8')

  assert.equal(loadStyle({ home, facts: { kind: 'private' } }).scene, '私聊')
  assert.equal(loadStyle({ home, facts: { kind: 'group' } }), null, '★ 群聊文件没写 → null（不硬造）')
  assert.equal(loadStyle({ home }).scene, '面板', '★ 没 kind → 面板')
})

test('★ 预算：风格文本 ≤ 200 字（规格 §10 上限）', () => {
  const home = mkHome()
  const ok = '人多就躲，没被点名少接。断行、省标点都行，句号基本不打。'
  writeFileSync(join(home, STYLE_FOLDER, '群聊.md'), ok, 'utf8')
  const r = loadStyle({ home, scene: '群聊' })
  assert.ok(r.text.length <= 200, `★ 超预算：${r.text.length} 字`)

  // 超了要能被读出来（不静默截断 —— 截断会让验收 #9 的统计失真）
  const big = '字'.repeat(300)
  writeFileSync(join(home, STYLE_FOLDER, '群聊.md'), big, 'utf8')
  const r2 = loadStyle({ home, scene: '群聊' })
  assert.equal(r2.text.length, 300, '★ 原样返回，超不超由体检/写卡的人负责，不在这层截')
})
