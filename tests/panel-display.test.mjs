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

const UI = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

/** 从源码里抽出 findTtsCardsIn 的实现，在假 DOM 上跑（浏览器文件不能 import）。 */
function extractFindTtsCardsIn(source) {
  const m = source.match(/function findTtsCardsIn\(doc\) \{[\s\S]*?\n  \}/)
  assert.ok(m, '没找到 findTtsCardsIn，解析规则该跟着改了')
  return new Function('doc', m[0] + '\nreturn findTtsCardsIn(doc)')
}

function node(style, text) {
  return {
    textContent: text,
    getAttribute: (k) => (k === 'style' ? style : null),
    style: { display: '' },
  }
}

test('朗读桥卡按内容识别：不会把鱼世界面板误判成朗读桥', () => {
  const run = extractFindTtsCardsIn(UI)

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
  const run = extractFindTtsCardsIn(UI)
  const inline = node('position:relative', '说明文字里提到朗读桥')
  const found = run({ querySelectorAll: () => [inline] })
  assert.equal(found.length, 0)
})

test('设置页的探测按内容判定，不按 z-index 数字', () => {
  const ui = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  // 判定逻辑里不该再出现 2147483000 这个数字（注释里提到不算）
  const codeLines = ui.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l) && /2147483000/.test(l))
  assert.deepEqual(codeLines, [], 'ui/panel.js 的判定不该再靠 2147483000 这个数字')
  assert.match(ui, /function findTtsCards\(\)/, '应有一个按内容找朗读桥卡的函数')
  assert.match(ui, /朗读桥/, '按文字识别，不按 z-index')
})

// 真实教训（主人 2026-10-26「朗读桥的面板关不掉」）：探测写在 ui/panel.js，
// 而隐藏动作只写在另一份文件里。面板实际加载的是 ui/ 那份，
// 于是拨开关没有任何东西去改卡片的 display —— 开关是空的。
test('开关必须有执行方：探测与隐藏要在同一份被加载的文件里', () => {
  const ui = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(ui, /function applyDisplayFlags\(\)/, 'ui/panel.js 必须自己执行显隐，不能只探测')
  // 执行时要真的写 display，且两个挂件都管到
  const body = ui.slice(ui.indexOf('function applyDisplayFlags'), ui.indexOf('function watchDisplayFlags'))
  assert.match(body, /style\.display = showTts/, '朗读桥卡要按开关值设 display')
  assert.match(body, /style\.display = showMood/, '心情挂饰同样要管')
  // 必须在启动时挂上，并接回即时生效事件（同文档 storage / BroadcastChannel 收不到自己）
  assert.match(ui, /watchDisplayFlags\(\)/, 'build 里要调用，否则永远不执行')
  assert.match(ui, /'dshcp:flag'/, '要接住设置页派发的即时生效事件')
})

test('解耦后不再去改鲸鱼挂件的 display（不影响 dsh-whale-widget 运行）', () => {
  // 新面板里管显隐的是 applyDisplayFlags：只管朗读桥卡与自己的心情挂饰 .fm-widget。
  const at = UI.indexOf('function applyDisplayFlags')
  assert.ok(at >= 0, '没找到 applyDisplayFlags')
  const body = UI
    .slice(at, UI.indexOf('function watchDisplayFlags'))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('\n')
  assert.equal(body.includes('dshwv'), false, '不该再碰鲸鱼的容器')
  assert.equal(body.includes('applyBubbleVisibility'), false, '不该再往鲸鱼气泡注入 display:none')
  assert.match(body, /\.fm-widget/, '自己管的心情挂饰仍然要管')
})

// 真实翻车（主人 2026-10-26「鱼的世界里那个开关没正常运作」）：
// 面板实际是从 Harness 设置页的 iframe 打开的，挂件长在**父窗口**的文档里。
// 只在自己这篇 document 上查/改，永远找不到朗读桥卡，也就永远拨不动它。
/** 抽出 hostDocuments + displayTargetPresent，在假窗口上跑（浏览器文件不能 import）。 */
function extractDisplayProbe(source) {
  const start = source.indexOf('  function hostDocuments() {')
  const end = source.indexOf('  // 开关必须有人执行')
  assert.ok(start > 0 && end > start, '没找到 hostDocuments/displayTargetPresent，解析规则该跟着改了')
  return source.slice(start, end)
}

function makeProbe(selfDoc, parentDoc, cardsIn) {
  const ui = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  const factory = new Function(
    'window',
    'document',
    'findTtsCardsIn',
    'var DISPLAY_TARGETS={showTts:"__tts_by_text__",showMood:".fm-widget"};\n' + extractDisplayProbe(ui) +
      '\nreturn displayTargetPresent',
  )
  return factory({ parent: { document: parentDoc } }, selfDoc, cardsIn)
}

const emptyDoc = { querySelectorAll: () => [], querySelector: () => null }

test('设置页 iframe 认得出父窗口里的朗读桥卡（不再误报「当前窗口没有这个挂件」）', () => {
  const card = { style: { display: '' } }
  const probe = makeProbe(emptyDoc, emptyDoc, (doc) => (doc === emptyDoc ? [card] : []))
  assert.equal(probe('showTts'), true, '父窗口有朗读桥卡时不能说没有')
  assert.equal(makeProbe(emptyDoc, emptyDoc, () => [])('showTts'), false, '两边都没有才算没有')
})

test('心情挂饰同样要在父窗口里找', () => {
  const mood = {}
  const parentDoc = { querySelectorAll: () => [], querySelector: (sel) => (sel === '.fm-widget' ? mood : null) }
  assert.equal(makeProbe(emptyDoc, parentDoc, () => [])('showMood'), true)
})

