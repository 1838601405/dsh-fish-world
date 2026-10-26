// 「关于」这类收尾卡要钉在分区末尾，拖拽与旧存档都挪不走它。
//
// 主人 2026-10-27：「关于的卡片置底」。面板会记住每页的拖拽顺序，
// 只改源码顺序不够 —— 旧存档会把它塞回中间，所以顺序整理时要再钉一次。
// 第一版把 pinLastCards 的过滤顺序写反（钉尾的排到了最前），
// 靠下面「旧存档把 about 放最前」这条用例才发现。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

/** 从源码里抽出 pinLastCards，在假节点上跑（浏览器文件不能 import）。 */
function extractPinLast(source) {
  const at = source.indexOf('function pinLastCards(')
  assert.ok(at > 0, '没找到 pinLastCards')
  let end = source.indexOf('{', at)
  let depth = 0
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1
    else if (source[end] === '}') { depth -= 1; if (depth === 0) break }
  }
  return new Function(source.slice(at, end + 1) + '\nreturn pinLastCards')()
}

const node = (key, pinned) => ({ dataset: { cardKey: key, ...(pinned ? { pinLast: 'true' } : {}) } })

test('pinLastCards：钉尾的卡排到最后，其余保持原序', () => {
  const pinLast = extractPinLast(panel)
  const out = pinLast([node('about', true), node('theme'), node('extensions')]).map((n) => n.dataset.cardKey)
  assert.deepEqual(out, ['theme', 'extensions', 'about'])
})

test('pinLastCards：旧存档把「关于」放在最前时，也要被钉回末尾', () => {
  const pinLast = extractPinLast(panel)
  // savedOrder 回来的顺序可能就是这样的（用户拖过 / 老版本存的）
  const saved = ['about', 'theme', 'extensions', 'display-flags'].map((k) => node(k, k === 'about'))
  const out = pinLast(saved).map((n) => n.dataset.cardKey)
  assert.equal(out[out.length - 1], 'about', '钉尾卡必须在最后一位')
  assert.deepEqual(out.slice(0, -1), ['theme', 'extensions', 'display-flags'], '其余卡保持存档里的顺序')
})

test('「关于」卡标了 pinLast，且不显示抓手（不给可拖的假象）', () => {
  assert.match(panel, /key: 'about'[\s\S]{0,200}pinLast: true/, '「关于」卡要标 pinLast')
  // 有抓手却能拖 = 骗人一次，松手就弹回；所以钉尾的卡不渲染抓手
  assert.match(panel, /opts\.draggable === false \|\| opts\.pinLast \? null : h\('span'/, '钉尾卡不给抓手')
})

test('三条顺序整理路径都调了 pinLastCards（恢复存档 / 拖拽落盘 / 键盘重排）', () => {
  // 少接一条，那一类操作就会把「关于」放回中间
  assert.equal((panel.match(/pinLastCards\(/g) || []).length, 4, '1 处定义 + 3 处调用')
  const calls = panel.split('\n').filter((l) => /pinLastCards\(/.test(l) && !/function pinLastCards/.test(l))
  assert.equal(calls.length, 3, calls.join(' ;; '))
})
