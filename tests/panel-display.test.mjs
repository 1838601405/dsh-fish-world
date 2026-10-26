// 面板显示开关：认「朗读桥卡」必须靠内容，不能靠 z-index 数字。
//
// 真实翻车（2026-10-26）：ttsCardElements() 原来用 style 里含 '2147483000' 判定，
// 而鱼世界自己的面板是 z-index:2147483002 —— 字符串里同样含有 2147483000。
// 结果 applyOriginals() 把面板自己也当成朗读桥卡去 display:none。
// 设置页那边同样按这个数字探测，于是明明有朗读桥卡却提示「当前窗口没有这个挂件」。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')

/** 从源码里抽出 ttsCardElements 的实现，在假 DOM 上跑（浏览器文件不能 import）。 */
function extractTtsCardElements(source) {
  const m = source.match(/function ttsCardElements\(\) \{[\s\S]*?\n  \}/)
  assert.ok(m, '没找到 ttsCardElements，解析规则该跟着改了')
  return new Function('document', m[0] + '\nreturn ttsCardElements()')
}

function node(style, text) {
  return {
    textContent: text,
    getAttribute: (k) => (k === 'style' ? style : null),
    style: { display: '' },
  }
}

test('朗读桥卡按内容识别：不会把鱼世界面板误判成朗读桥', () => {
  const src = readFileSync(join(ROOT, 'lib', 'panel.js'), 'utf8')
  const run = extractTtsCardElements(src)

  const tts = node('position:fixed;right:14px;bottom:14px;z-index:2147483000;padding:7px 10px', '🐳 朗读桥 还没念过')
  // 鱼世界自己的面板：2147483002 里含 2147483000，正是这处误判的来源
  const panel = node('display:none;position:fixed;z-index:2147483002;width:340px', '鱼的世界 总览 鱼的日记')
  const mood = node('position:fixed;right:18px;bottom:18px;z-index:99990', '93')

  const found = run({ querySelectorAll: (sel) => (sel === 'div[style]' ? [tts, panel, mood] : []) })
  assert.equal(found.length, 1, '只该认出朗读桥卡')
  assert.equal(found[0], tts, '认出的必须是朗读桥卡本身')
  assert.equal(found.includes(panel), false, '鱼世界自己的面板不能被当成朗读桥卡')
})

test('非 fixed 的元素不算朗读桥卡（哪怕文字里有朗读桥）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'panel.js'), 'utf8')
  const run = extractTtsCardElements(src)
  const inline = node('position:relative', '说明文字里提到朗读桥')
  const found = run({ querySelectorAll: () => [inline] })
  assert.equal(found.length, 0)
})

test('设置页的探测与 lib/panel.js 同一口径（都按内容，不按 z-index 数字）', () => {
  const ui = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  // 判定逻辑里不该再出现 2147483000 这个数字（注释里提到不算）
  const codeLines = ui.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l) && /2147483000/.test(l))
  assert.deepEqual(codeLines, [], 'ui/panel.js 的判定不该再靠 2147483000 这个数字')
  assert.match(ui, /function findTtsCards\(\)/, '应有一个按内容找朗读桥卡的函数')
  assert.match(ui, /朗读桥/, '按文字识别，不按 z-index')
})
