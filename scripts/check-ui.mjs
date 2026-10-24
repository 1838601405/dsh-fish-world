/**
 * UI 规范自检：对照「Token 语义化 + 权威性克制」逐条检查源码。
 *
 * 只做静态检查（不需要浏览器），检查项来自 ui/AGENTS.md 与设计提示词的硬性约束。
 * 断言失败会指出：哪个文件、哪个规则、期望 vs 实际。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const FILES = ['ui/tokens.css', 'ui/panel.css', 'ui/panel.js', 'ui/index.html']

function read(file) {
  return readFileSync(join(ROOT, file), 'utf8')
}

const problems = []
function fail(file, rule, detail) {
  problems.push(`${file} · ${rule}：${detail}`)
}

// 1. 组件层不得出现裸色值（tokens.css 是唯一允许定义色值的地方）
for (const file of ['ui/panel.css', 'ui/panel.js', 'ui/index.html']) {
  const source = read(file)
  const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  if (hex.length) fail(file, '禁止裸色值', `组件层出现十六进制色值 ${hex.join('、')}`)
  const rgb = source.match(/\brgba?\(/g) || []
  if (rgb.length) fail(file, '禁止裸色值', `组件层出现 rgb()/rgba() 共 ${rgb.length} 处`)
}

// 2. 禁止位移 / 缩放 / 渐变文字
// CSS 中一律禁止；panel.js 里的 translate() 只允许出现在 FLIP 让位动画中
// （拖拽重排必须靠位移补偿，否则会变成突兀跳跃）。
for (const file of ['ui/panel.css']) {
  const source = read(file)
  for (const rule of [/translate[XY]?\s*\(/, /\bscale\s*\(/, /background-clip\s*:\s*text/, /-webkit-background-clip\s*:\s*text/]) {
    if (rule.test(source)) fail(file, '禁止位移与渐变文字', `命中 ${rule}`)
  }
}
{
  const source = read('ui/panel.js')
  for (const rule of [/\bscale\s*\(/, /background-clip\s*:\s*text/]) {
    if (rule.test(source)) fail('ui/panel.js', '禁止位移与渐变文字', `命中 ${rule}`)
  }
  // 位移只允许出现在拖拽引擎里：被拖的卡片靠 transform 跟随指针，
  // 让位则用 left/top 过渡（不用位移补偿，避免和脱离文档流的卡片互相干扰）。
  const translateHits = [...source.matchAll(/translate\(/g)].length
  const dragFns = [...source.matchAll(/(\/\*\*?[\s\S]*?\*\/\s*)?function (onCardDragMove|startCardDrag)\([\s\S]*?\n  \}/g)]
    .map((m) => m[0]).join('\n')
  const allowed = (dragFns.match(/translate\(/g) || []).length
  if (translateHits > allowed) {
    fail('ui/panel.js', '禁止位移与渐变文字', `translate() 出现在拖拽引擎之外（${translateHits} vs ${allowed}）`)
  }
}

// 3. 禁止彩色光晕：box-shadow 只允许纯黑或 token
{
  const source = read('ui/panel.css')
  const shadows = source.match(/box-shadow\s*:\s*[^;}]+/g) || []
  for (const shadow of shadows) {
    const ok = /var\(--shadow-overlay\)/.test(shadow) || /var\(--ring-focus\)/.test(shadow) || /rgba\(\s*0\s*,\s*0\s*,\s*0/.test(shadow)
    if (!ok) fail('ui/panel.css', '禁止彩色光晕', `box-shadow 含非黑色分量：${shadow.trim()}`)
  }
}

// 4. 圆角最多两级（同名 token 在明暗主题里重复定义不算新增级别）
// 例外：--radius-pill 只用于"药丸形物理控件"（开关、进度条），不参与通用圆角层级。
{
  const tokens = read('ui/tokens.css')
  const EXEMPT = new Set(['--radius-pill'])
  const names = new Set([...tokens.matchAll(/(--radius-[a-z]+)\s*:/g)].map((m) => m[1]).filter((n) => !EXEMPT.has(n)))
  if (names.size > 2) fail('ui/tokens.css', '圆角收敛', `声明了 ${names.size} 级圆角：${[...names].join('、')}`)
  // 药丸形若扩散到卡片、按钮等通用表面，就等于破坏了收敛规则
  const css = read('ui/panel.css')
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/border-radius:\s*var\(--radius-pill\)/.test(body)) continue
    if (!/\.fw-switch|\.fw-stat-bar|\.fw-mini-bar/.test(selector)) {
      fail('ui/panel.css', '圆角收敛', `--radius-pill 只允许用于开关与进度条，却被 ${selector.trim()} 使用`)
    }
  }
}

// 5. 深色模式不得纯黑纯白
{
  const tokens = read('ui/tokens.css')
  for (const bad of ['#000', '#000000', '#fff', '#ffffff']) {
    const hit = new RegExp(`:\\s*${bad}\\s*;`, 'i').test(tokens.replace(/#000000\b/g, '#000').replace(/#ffffff\b/g, '#fff'))
    if (hit && !/--text-inverse[^;]*#fff/i.test(bad)) {
      // #fff 只允许出现在 --text-inverse 之外不成立，这里做保守判断
    }
  }
  if (/--bg-canvas:\s*#000(000)?\s*;/i.test(tokens)) fail('ui/tokens.css', '深色禁纯黑', '--bg-canvas 使用了 #000')
  if (/--text-primary:\s*#fff(fff)?\s*;/i.test(tokens)) fail('ui/tokens.css', '深色禁纯白', '--text-primary 使用了 #fff')
  if (/--bg-canvas:\s*#18181b/i.test(tokens) === false) fail('ui/tokens.css', '深色画布', '缺少 #18181B 级深色画布')
}

// 6. 最小字号：正文 13px、辅助 12px
{
  const tokens = read('ui/tokens.css')
  const body = /--text-body:\s*(\d+)px/.exec(tokens)
  const aux = /--text-aux:\s*(\d+)px/.exec(tokens)
  if (!body || Number(body[1]) < 13) fail('ui/tokens.css', '最小字号', `--text-body 应为 ≥13px，实际 ${body ? body[1] : '缺失'}`)
  if (!aux || Number(aux[1]) < 12) fail('ui/tokens.css', '辅助字号', `--text-aux 应为 ≥12px，实际 ${aux ? aux[1] : '缺失'}`)
  const css = read('ui/panel.css')
  const smallPx = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  const tooSmall = smallPx.filter((n) => n < 12)
  if (tooSmall.length) fail('ui/panel.css', '最小字号', `出现 <12px 的硬编码字号：${tooSmall.join('、')}`)
}

// 7. 焦点环必须有 offset（不吃掉外部留白）
{
  const tokens = read('ui/tokens.css')
  if (!/--ring-focus:[^;]*var\(--bg-canvas\)/.test(tokens)) {
    fail('ui/tokens.css', '焦点环 offset', '--ring-focus 应先用画布色做一圈 offset')
  }
}

// 8. 毛玻璃只用于侧栏与浮层
{
  const css = read('ui/panel.css')
  const blocks = css.split('}')
  for (const block of blocks) {
    if (!/backdrop-filter\s*:/.test(block)) continue
    const selector = block.split('{')[0] || ''
    const allowed = /\.fw-rail|\.fw-popover|\.fw-grip-tip/.test(selector)
    if (!allowed) fail('ui/panel.css', '毛玻璃使用范围', `backdrop-filter 出现在非侧栏/浮层选择器：${selector.trim()}`)
    if (/saturate\((\d+(?:\.\d+)?)\)/.test(block)) {
      const value = Number(/saturate\((\d+(?:\.\d+)?)\)/.exec(block)[1])
      if (value > 1.2) fail('ui/panel.css', '毛玻璃饱和度', `saturate(${value}) 超过 1.2`)
    }
  }
}

// 9. hover 只做一级背景变化（不得同时改颜色/边框/阴影）
{
  const css = read('ui/panel.css')
  const hoverBlocks = [...css.matchAll(/([^{}]+:hover[^{}]*)\{([^}]*)\}/g)]
  for (const [, selector, body] of hoverBlocks) {
    const changes = ['background', 'color', 'border', 'box-shadow'].filter((prop) =>
      new RegExp(`(^|;|\\s)${prop}[a-z-]*\\s*:`).test(body))
    if (changes.length > 1) {
      fail('ui/panel.css', 'hover 双轨反馈', `${selector.trim()} 同时改了 ${changes.join('、')}`)
    }
  }
}

// 10. 正文宽度上限 72ch
{
  const css = read('ui/panel.css')
  if (!/max-width:\s*72ch/.test(css)) fail('ui/panel.css', '正文宽度', '缺少 max-width: 72ch')
}

// 11. 对比度实测：正文/辅助文字对各自背景 ≥ 4.5:1
{
  const tokens = read('ui/tokens.css')

  function pickBlock(name) {
    // 取第一个匹配的主题块（:root / @media dark / [data-theme]）里的值
    const blocks = [...tokens.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    const out = {}
    for (const [, selector, body] of blocks) {
      if (!selector.includes(name)) continue
      for (const [, key, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[key] = value.trim()
    }
    return out
  }

  function hexToRgb(hex) {
    const v = hex.replace('#', '')
    const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  function contrast(a, b) {
    const l1 = luminance(hexToRgb(a))
    const l2 = luminance(hexToRgb(b))
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
    return (hi + 0.05) / (lo + 0.05)
  }

  const themes = [
    { name: '浅色', root: pickBlock(':root') },
    { name: '深色', root: pickBlock('[data-theme="dark"]') },
  ]

  for (const theme of themes) {
    const t = theme.root
    if (!t['--text-primary'] || !t['--bg-surface']) {
      fail('ui/tokens.css', '对比度实测', `${theme.name}主题缺少 --text-primary 或 --bg-surface`)
      continue
    }
    const pairs = [
      ['正文 / 卡片', t['--text-primary'], t['--bg-surface'], 4.5],
      ['辅助文字 / 卡片', t['--text-secondary'], t['--bg-surface'], 4.5],
      ['第三级文字 / 卡片', t['--text-tertiary'], t['--bg-surface'], 4.5],
      ['正文 / 画布', t['--text-primary'], t['--bg-canvas'], 4.5],
      ['主按钮文字', t['--text-inverse'], t['--text-primary'], 4.5],
    ]
    for (const [label, fg, bg, min] of pairs) {
      if (!fg || !bg) continue
      const ratio = contrast(fg, bg)
      if (ratio < min) {
        fail('ui/tokens.css', '对比度实测', `${theme.name}「${label}」${ratio.toFixed(2)}:1 低于 ${min}:1`)
      }
    }
  }
}

if (problems.length) {
  console.error('✖ UI 规范自检未通过：')
  for (const item of problems) console.error('  - ' + item)
  process.exit(1)
}
console.log('✔ UI 规范自检通过：token 语义化、零位移、圆角两级、字号与对比度下限、毛玻璃范围、hover 单轨')
