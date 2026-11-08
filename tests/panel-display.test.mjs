// 面板显示开关：0.2.5 起只保留心情挂饰，不再集成朗读桥。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')

const UI = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

test('面板显示不再出现朗读桥开关与朗读桥文案', () => {
  assert.doesNotMatch(UI, /showTts/, '不该再有朗读桥显示开关')
  assert.doesNotMatch(UI, /朗读桥|dsh-tts-bridge/, '不该再有朗读桥文案或依赖')
  assert.match(UI, /key: 'showMood'/, '心情挂饰开关要保留')
})

test('开关必须有执行方：心情挂饰的显示由 ui/panel.js 自己执行', () => {
  assert.match(UI, /function applyDisplayFlags\(\)/, 'ui/panel.js 必须自己执行显隐，不能只探测')
  const body = UI.slice(UI.indexOf('function applyDisplayFlags'), UI.indexOf('function watchDisplayFlags'))
  assert.match(body, /style\.display = showMood/, '心情挂饰要按开关值设 display')
  assert.match(body, /\.fm-widget/, '心情挂饰的选择器要保留')
  assert.equal(body.includes('dshwv'), false, '不该碰鲸鱼挂件')
  assert.match(UI, /watchDisplayFlags\(\)/, 'build 里要调用，否则永远不执行')
  assert.match(UI, /'dshcp:flag'/, '要接住设置页派发的即时生效事件')
})

/** 抽出 hostDocuments + displayTargetPresent，在假窗口上跑（浏览器文件不能 import）。 */
function extractDisplayProbe(source) {
  const start = source.indexOf('  function hostDocuments() {')
  const end = source.indexOf('  // 开关必须有人执行')
  assert.ok(start > 0 && end > start, '没找到 hostDocuments/displayTargetPresent，解析规则该跟着改了')
  return source.slice(start, end)
}

function makeProbe(selfDoc, parentDoc) {
  const factory = new Function(
    'window',
    'document',
    'var DISPLAY_TARGETS={showMood:".fm-widget"};\n' + extractDisplayProbe(UI) +
      '\nreturn displayTargetPresent',
  )
  return factory({ parent: { document: parentDoc } }, selfDoc)
}

const emptyDoc = { querySelectorAll: () => [], querySelector: () => null }

test('设置页 iframe 能在父窗口里找到心情挂饰', () => {
  const mood = {}
  const parentDoc = { querySelectorAll: () => [], querySelector: (sel) => (sel === '.fm-widget' ? mood : null) }
  assert.equal(makeProbe(emptyDoc, parentDoc)('showMood'), true)
  assert.equal(makeProbe(emptyDoc, emptyDoc)('showMood'), false)
})

// 2026-10-30 主人：「记录用户操作后的界面，不要每次进入鱼的世界就重新到总览页面」。
// 视图存 dshcp.view，进面板时恢复；只认 NAV 里真实存在的 id（失效 id 回落总览）。
test('面板记住上次分区：进入时恢复，不强制回总览', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /function readPanelView\(\)/, '要有读取上次分区的函数')
  assert.match(panel, /function writePanelView\(view\)/, '要有写入上次分区的函数')
  assert.match(panel, /view: readPanelView\(\)/, 'state.view 初始化应读取上次分区')
  assert.match(panel, /localStorage.getItem\('dshcp.view'\)/, '键名固定为 dshcp.view')
  assert.match(panel, /writePanelView\(view\)/, 'navigate 时应写回当前分区')
  // 失效 id 不能被恢复：必须对着 NAV 校验
  assert.match(panel, /NAV\.some\(function \(n\) \{ return n\.id === v \}\)/, '恢复前要校验 NAV')
  // 启动时不许再硬编码回总览
  assert.doesNotMatch(panel, /state\.view = 'overview'/, '不许在启动/渲染时把视图强制设回总览')
})


// 2026-10-30 主人：「不应该只能左右，应该还允许上下」。缩放把手要同时改列数与高度。
test('缩放把手支持上下：高度按分区存、可恢复、矮于内容时内部滚动', () => {
  const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
  const css = readFileSync(join(ROOT, 'ui', 'panel.css'), 'utf8')
  assert.match(panel, /function savedHeights\(\)/, '要有高度存储读取')
  assert.match(panel, /function saveHeight\(key, px\)/, '要有高度写入')
  assert.match(panel, /function heightOf\(node\)/, '要有按卡片取高度')
  assert.match(panel, /dshcp\.cardHeights\./, '高度键按分区存')
  assert.match(panel, /MIN_CARD_H/, '要有最小高度')
  assert.match(panel, /MAX_CARD_H/, '要有最大高度')
  // 拖动要同时看 X 和 Y
  assert.match(panel, /event\.clientY - resizeState\.startY/, '纵向按 clientY 跟手')
  // 手动高度参与量高
  assert.match(panel, /manual \|\| natural/, '量高时手动高度优先')
  assert.match(panel, /item\.dataset\.manualH = manual < natural \? 'clip' : 'room'/, '矮于内容时标 clip')
  assert.match(css, /data-manual-h="clip"\] > \.fw-card-body/, 'clip 时正文内部滚动')
  // 键盘也能调高度；双击恢复
  assert.match(panel, /ArrowDown' \? 40/, 'Alt+下箭头加高')
  assert.match(panel, /dblclick/, '双击恢复自动高度')
  assert.match(css, /cursor: nwse-resize/, '把手光标提示双向缩放')
})
