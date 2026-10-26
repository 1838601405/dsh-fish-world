// 体检页的两条布局契约：每行必须闭合（不留黑洞）、右列数值必须对齐成一条线。
//
// 主人 2026-10-27：「依赖检查占左、右边完全空置」+「5/5、4/4、v22.0.0、待检查
// 要固定宽度 + 等宽数字 + 垂直对齐」。这类问题肉眼看不出来，改一行 span 就会复发。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const js = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
const css = readFileSync(join(ROOT, 'ui', 'panel.css'), 'utf8')

test('体检页：收起时「依赖检查」与「版本更新」并排，该行填满 12 列', () => {
  // 两张卡必须用同一个 span 表达式；版本更新原来固定 12 列，会在依赖检查右边留下半行空洞。
  const dep = /key: 'doctor-dep',[\s\S]{0,200}?span: ([^\n,]+),/.exec(js)
  const up = /key: 'doctor-up',[\s\S]{0,200}?span: ([^\n,]+),/.exec(js)
  assert.ok(dep && up, '找不到两张卡的 span')
  assert.equal(dep[1].trim(), up[1].trim(), `span 表达式必须一致：${dep[1]} vs ${up[1]}`)
  assert.match(dep[1], /depOpen \? 12 : 6/, '收起 6/6、展开各占一行')
})

test('数值列：数字与状态点共用一个宽度，且用等宽数字', () => {
  assert.match(css, /--num-col:\s*\d+px/, '要有统一的数值列宽 token')
  const col = css.slice(css.indexOf('.fw-row > .fw-num,'))
  const block = col.slice(0, col.indexOf('}') + 1)
  assert.match(block, /min-width: var\(--num-col\)/, '数字与状态点共用一个列宽，右边界才能成一条线')
  assert.match(block, /tabular-nums/, '等宽数字：斜杠与小数点垂直对齐')
  // 只能给最小宽度，不许锁死：状态点也被 infoRow 用（「登录账号」那种长昵称），
  // 固定 max-width 会把没超长的值也截断；flex:none 会让长值顶破卡片。
  assert.doesNotMatch(block, /flex:\s*none/, '不许 flex:none（长值要能收缩 + 省略号）')
  assert.doesNotMatch(block, /max-width:\s*var\(--num-col\)/, '不许把列宽当上限（会硬截断长文字）')
})

test('降噪：次要操作用无边框半透明底，hover 只加深背景', () => {
  assert.match(css, /\.fw-btn-quiet \{\s*border-color: transparent;/, '安静按钮：去掉边框')
  const at = css.indexOf('.fw-btn-quiet:hover')
  assert.ok(at > 0, '要有 hover 态')
  const block = css.slice(at, css.indexOf('}', at) + 1)
  assert.match(block, /background:/, 'hover 加深背景')
  assert.doesNotMatch(block, /border|color|transform|box-shadow/, 'hover 不改边框 / 文字色 / 位移（单轨反馈）')
  // 体检与解除安装都必须是安静按钮，不能还剩描边
  assert.match(js, /quietButton\(state\.doctorBusy \? '检查中…' : '体检'/, '「体检」要降噪')
  assert.match(js, /quietButton\('解除安装'/, '「解除安装」要降噪')
})

test('展开行贴住数值：整行可点，且不承担沉底间距', () => {
  assert.match(css, /\.fw-disclosure-compact \{[^}]*padding-top: var\(--space-1\)/, '紧凑变体去掉大间距')
  // 展开行要在操作区（margin-top:auto 沉底）之前推入，否则中间会空出一截
  const toggle = js.indexOf('depBody.push(depToggle)')
  const foot = js.indexOf("depBody.push(h('div', { class: 'fw-card-foot' }")
  assert.ok(toggle > 0 && foot > toggle, '展开行必须先于沉底操作区')
})

test('概览「可更新」不用破折号占位，0 或未查用 disabled 色', () => {
  assert.doesNotMatch(js, /label: '可更新',\s*value: up \? String\(upCounts\.outdated \|\| 0\) : null/, '不许再用 null 渲染成 —')
  assert.match(js, /value: up \? String\(upCounts\.outdated \|\| 0\) : '未查'/, '没查过时直接写状态')
  assert.match(css, /\.fw-mini\[data-dim="true"\] \.fw-mini-value \{[^}]*--text-disabled/, '0 / 未查 用 disabled 色')
})
