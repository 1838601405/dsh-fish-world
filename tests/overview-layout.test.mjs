// 总览「详细」模式的布局契约：行必须闭合、按钮必须安静、间距必须横纵一致。
//
// 主人 2026-10-27：「详细模式下有问题」+ 治理拉伸 / 按钮厚重 / 间距不一致 / 顶部砍头。
// 这几条都是改一行就静默复发的类型（比如把某张卡跨度从 4 改回 3，右边就空 3 列），
// 所以钉成测试，而不是靠肉眼再看一遍。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const js = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
const css = readFileSync(join(ROOT, 'ui', 'panel.css'), 'utf8')
const tokens = readFileSync(join(ROOT, 'ui', 'tokens.css'), 'utf8')

test('间距横纵一致：JS 网格间距必须等于 --space-4（16px）', () => {
  // 卡片位置由 JS 算（绝对定位），卡片内间距由 CSS 写。两边不一致就会出现
  // 「横向 16、纵向 20」这种一眼看出来的不整齐，而两边分别改都不会报错。
  const jsGap = Number((js.match(/GRID_GAP = (\d+)/) || [])[1])
  assert.ok(Number.isFinite(jsGap) && jsGap > 0, '找不到 GRID_GAP')
  const space4 = Number((tokens.match(/--space-4: (\d+)px/) || [])[1])
  assert.equal(jsGap, space4, `网格间距 ${jsGap}px 必须与 --space-4 (${space4}px) 一致`)
})

test('详细概览每一行的跨度合计 12（不留半行空洞）', () => {
  // 抓 viewOverviewDetailed 里 dataCard 的 span 序列，按源码顺序模拟一行行填 12 列。
  // 必须按括号配对取函数体：用 indexOf('}') 会在内部的 dataCard 函数处提前截断，
  // 反过来截太长又会把别的分区的 span 也算进来（两种都会让这条测试假红/假绿）。
  const at = js.indexOf('function viewOverviewDetailed')
  assert.ok(at > 0, '找不到 viewOverviewDetailed')
  let depth = 0
  let end = js.indexOf('{', at)
  for (let k = end; k < js.length; k += 1) {
    if (js[k] === '{') depth += 1
    else if (js[k] === '}') { depth -= 1; if (depth === 0) { end = k; break } }
  }
  const body = js.slice(at, end + 1)
  const spans = [...body.matchAll(/span: (\d+),/g)].map((m) => Number(m[1]))
  assert.ok(spans.length >= 6, `详细模式的卡片数量看起来不对：${spans.length}`)
  // 逐行装箱：能填满 12 就换行；结束时若最后一行没满，说明存在空洞
  let row = 0
  const rows = []
  for (const span of spans) {
    if (row + span > 12) { rows.push(row); row = 0 }
    row += span
  }
  rows.push(row)
  const holes = rows.filter((r) => r !== 12)
  assert.deepEqual(holes, [], `有行没闭合到 12（会有半行空白）：${JSON.stringify({ spans, rows })}`)
})

test('按钮规范：无边框、28px 高、13px 字、只过渡背景', () => {
  const at = css.indexOf('.fw-btn {')
  assert.ok(at > 0, '找不到 .fw-btn')
  const block = css.slice(at, css.indexOf('}', at) + 1)
  assert.match(block, /border: 0/, '默认按钮不该有边框（降噪）')
  assert.match(block, /min-height: 28px/, '28px 高：32px + 描边让一排按钮比数据还显眼')
  assert.match(block, /padding: 0 var\(--space-3\)/, '左右 12px')
  assert.match(block, /font-size: var\(--text-body\)/, '字号 13px（不得低于正文下限）')
  assert.match(block, /border-radius: var\(--radius-sm\)/, '圆角只有 --radius-sm，不许胶囊')
  assert.doesNotMatch(block, /transition:[^;]*transform/, '不许位移')
})

test('卡片操作区不沉底：固定间距，不靠 margin-top:auto 撑开', () => {
  const at = css.indexOf('.fw-card-actions {')
  assert.ok(at > 0, '找不到 .fw-card-actions')
  const block = css.slice(at, css.indexOf('}', at) + 1)
  assert.doesNotMatch(block, /margin-top: auto/, '沉底会把按钮与正文之间撑出一大段空档')
  assert.match(block, /margin-top: var\(--space-3\)/, '紧跟内容')
})

test('状态点 6px（4px 在深色下几乎看不见）', () => {
  for (const sel of ['.fw-dot {', '.fw-mini-dot {', '.fw-dep-dot {']) {
    const at = css.indexOf(sel)
    assert.ok(at > 0, `找不到 ${sel}`)
    const block = css.slice(at, css.indexOf('}', at) + 1)
    assert.match(block, /width: 6px/, `${sel} 应为 6px`)
    assert.match(block, /height: 6px/, `${sel} 应为 6px`)
  }
})

test('容器留白 24px：顶部卡片不被砍头', () => {
  const at = css.indexOf('.fw-main {')
  const block = css.slice(at, css.indexOf('}', at) + 1)
  assert.match(block, /padding: var\(--space-6\)/, '主内容区四周 24px')
})
