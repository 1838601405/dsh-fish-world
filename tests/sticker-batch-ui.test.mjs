// 面板「批量选择 / 批量操作条」的契约。
//
// 面板是浏览器文件（依赖 window / document，不能在 Node 里 import），所以照
// tests/panel-display.test.mjs 的做法：把 galleryChildren 从源码里抽出来，在假 DOM 上跑。
// 钉住的是「点了会怎样」这类改一行就静默坏掉的行为：
//   · 每张图一个勾选框（左上角角标位），选中后 data-selected 变 true
//   · 选中 ≥1 张才出现批量条；「已选 N 张」「全选 / 取消全选」跟着走
//   · 追加标签真的发到 /stickers/batch（action=tags, ids, tags）
//   · 批量删除两步：第一次只换确认，第二次才发请求
//   · 视觉整理没接入时不给灰按钮，而是如实写「暂不可用 + 原因」
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const UI = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

/** 抽出 galleryChildren 的函数体（按大括号配对，注释里没有花括号，直接数就行）。 */
function extractGalleryChildren(source) {
  const at = source.indexOf('  function galleryChildren() {')
  assert.ok(at > 0, '找不到 galleryChildren，解析规则该跟着改了')
  let depth = 0
  let end = at
  for (let i = source.indexOf('{', at); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  return source.slice(at, end)
}

// ---------- 假 DOM ----------

function el(tag) {
  const node = {
    tag,
    attrs: {},
    children: [],
    listeners: {},
    dataset: {},
    style: {},
    className: '',
    checked: false,
    disabled: false,
    hidden: false,
    appendChild(child) { this.children.push(child); return child },
    setAttribute(key, value) { this.attrs[key] = value },
    getAttribute(key) { return this.attrs[key] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
  }
  let text = ''
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (value) => {
      text = String(value == null ? '' : value)
      // 面板里靠 `pickBar.textContent = ''` 清空重画；假 DOM 也要跟着清 children。
      if (text === '') node.children.length = 0
    },
  })
  return node
}

/** 与 ui/panel.js 的 h() 同规则的极简版。 */
function h(tag, attrs, children) {
  const node = el(tag)
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      const value = attrs[key]
      if (value == null || value === false) return
      if (key === 'text') node.textContent = value
      else if (key === 'class') node.className = value
      else if (key === 'dataset') Object.keys(value).forEach((name) => { node.dataset[name] = value[name] })
      else if (typeof value === 'function' && /^on[a-z]+$/.test(key)) node.addEventListener(key.slice(2).toLowerCase(), value)
      else node.setAttribute(key, value === true ? '' : String(value))
    })
  }
  ;(children || []).forEach((child) => {
    if (child == null) return
    node.children.push(typeof child === 'string' ? { tag: '#text', textContent: child, children: [], dataset: {} } : child)
  })
  return node
}

function flat(node, out = []) {
  if (!node) return out
  out.push(node)
  for (const child of node.children || []) flat(child, out)
  return out
}

function byText(root, text) {
  return flat(root).find((node) => node.tag === 'button' && node.textContent === text)
}

function texts(root) {
  return flat(root).map((node) => node.textContent).filter(Boolean)
}

function click(node) {
  assert.ok(node, '要点的按钮不存在')
  for (const fn of node.listeners.click || []) fn()
}

/**
 * 在假 DOM 上跑一次 galleryChildren。
 * posts 记录所有 POST；loads 记录 loadStickers 调用；state 是面板 state 的替身。
 */
function runGallery({ items, selected = [], vision = { ready: true }, stickerBatchTags = '' }) {
  const state = {
    stickers: { items, summary: { useCustomFace: true, synced: 0, total: items.length } },
    stickerDir: null,
    storage: null,
    portrait: null,
    errors: {},
    stickerSyncBusy: false,
    stickerSyncMsg: null,
    stickerSelected: selected.slice(),
    stickerBatchTags,
    stickerBatchMsg: null,
    stickerBatchBusy: '',
    stickerBatchConfirm: false,
    stickerVision: vision,
  }
  const posts = []
  const loads = []
  const schedules = []
  const body = extractGalleryChildren(UI)
  const factory = new Function(
    'state', 'h', 'statusLine', 'emptyState', 'switchRow', 'ghostButton', 'quietButton',
    'postJSON', 'loadStickers', 'render', 'setError', 'relPath', 'openDirPicker',
    'scheduleRelayout', 'main',
    body + '\nreturn galleryChildren()',
  )
  const children = factory(
    state,
    h,
    (text, tone) => h('p', { class: 'fw-status', dataset: { tone: tone || '' }, text: text || '' }),
    (text, hint) => h('div', { class: 'fw-empty' }, [h('p', { text: text }), hint ? h('p', { text: hint }) : null]),
    (opts) => h('div', { class: 'fw-row' }, [h('span', { text: opts.label })]),
    (label) => h('button', { class: 'fw-btn fw-btn-ghost', text: label }),
    (label, onClick) => {
      const button = h('button', { class: 'fw-btn fw-btn-quiet', type: 'button', text: label })
      button.addEventListener('click', onClick)
      return button
    },
    (path, payload) => {
      posts.push({ path, body: payload })
      const extra = payload.action === 'tags'
        ? { updated: payload.ids.length, failed: [] }
        : (payload.action === 'remove' ? { removed: payload.ids.length, failed: [] } : { total: payload.ids.length, done: payload.ids.length, failed: 0, results: [] })
      return Promise.resolve({ ok: true, ...extra, summary: {} })
    },
    () => { loads.push(1); return Promise.resolve() },
    () => {},
    (key, message) => { state.errors[key] = message },
    (value) => String(value || ''),
    () => {},
    () => { schedules.push(1) },
    // 面板里 main 就是卡片容器；这里给个真值，好验证「选完会重量一次卡片高度」。
    {},
  )
  return { state, children, posts, loads, schedules }
}

const ITEMS = [
  { id: 'stk_a', name: '歪头', tags: ['可爱'], emojiId: 'x'.repeat(96) },
  { id: 'stk_b', name: '拍桌', tags: ['生气'], animated: true, organized: true },
]

test('每张图一个勾选框，选中态写在 data-selected 上（不改图、不位移）', () => {
  const { children } = runGallery({ items: ITEMS })
  const grid = children.find((node) => node.className === 'fw-gallery-grid')
  const boxes = flat(grid).filter((node) => node.className === 'fw-gallery-check')
  assert.equal(boxes.length, 2, '每张图都要有一个勾选框')
  assert.ok(flat(grid).some((node) => node.className === 'fw-gallery-pick'), '勾选框要有独立的可点热区（label）')
  assert.ok(boxes.every((box) => box.checked === false))

  const figures = flat(grid).filter((node) => node.className === 'fw-gallery-item')
  assert.equal(figures.length, 2)
  assert.deepEqual(figures.map((node) => node.dataset.selected), ['false', 'false'])
  assert.deepEqual(figures.map((node) => node.dataset.sticker), ['stk_a', 'stk_b'], '每格要能对上 id')

  // 单张操作还在（删除 / 整理），批量只是加了一层，没有把它们挤掉。
  assert.ok(flat(grid).some((node) => node.className.indexOf('fw-gallery-del') >= 0))
  assert.ok(flat(grid).some((node) => node.className.indexOf('fw-gallery-organize') >= 0))
})

test('没选中时不出现批量操作条，只有「全选」入口', () => {
  const { children } = runGallery({ items: ITEMS })
  const pickBar = children.find((node) => node.className === 'fw-gallery-pickbar')
  assert.ok(pickBar, '网格上方要有选择条')
  assert.ok(byText(pickBar, '全选'), '要有全选按钮')
  assert.equal(texts(pickBar).some((text) => text === '追加标签'), false, '没选中时不该出现批量条')
  assert.ok(texts(pickBar).some((text) => /勾图左上角的框/.test(text)), '要说明怎么选')
})

test('点全选：两张都选中、出现批量条、文案变「已选 2 张 / 取消全选」', () => {
  const { state, children, schedules } = runGallery({ items: ITEMS })
  const pickBar = children.find((node) => node.className === 'fw-gallery-pickbar')
  const grid = children.find((node) => node.className === 'fw-gallery-grid')

  click(byText(pickBar, '全选'))
  assert.deepEqual(state.stickerSelected, ['stk_a', 'stk_b'])
  // 批量条撑高了卡片（卡片是绝对定位 + overflow:hidden），必须重量一次，否则下半截被裁。
  assert.ok(schedules.length >= 1, '改完选中态要请外层重新量卡片高度')
  assert.deepEqual(
    flat(grid).filter((node) => node.className === 'fw-gallery-check').map((node) => node.checked),
    [true, true],
    '勾选框要跟着变成已选',
  )
  assert.deepEqual(
    flat(grid).filter((node) => node.className === 'fw-gallery-item').map((node) => node.dataset.selected),
    ['true', 'true'],
  )
  assert.ok(texts(pickBar).includes('已选 2 张'))
  assert.ok(byText(pickBar, '取消全选'), '全选之后按钮要变成取消全选')
  assert.ok(byText(pickBar, '追加标签'))
  assert.ok(byText(pickBar, '批量整理'))
  assert.ok(byText(pickBar, '批量删除'))
  assert.ok(byText(pickBar, '清除选择'))

  // 再点取消全选：全部退回未选，批量条收起来。
  click(byText(pickBar, '取消全选'))
  assert.deepEqual(state.stickerSelected, [])
  assert.equal(byText(pickBar, '追加标签'), undefined)
})

test('单张勾选：只选中那一张，批量条跟着出现', () => {
  const { state, children } = runGallery({ items: ITEMS })
  const pickBar = children.find((node) => node.className === 'fw-gallery-pickbar')
  const grid = children.find((node) => node.className === 'fw-gallery-grid')
  const box = flat(grid).filter((node) => node.className === 'fw-gallery-check')[1]

  box.checked = true
  for (const fn of box.listeners.change || []) fn()
  assert.deepEqual(state.stickerSelected, ['stk_b'])
  assert.ok(texts(pickBar).includes('已选 1 张'))
  assert.ok(byText(pickBar, '追加标签'))
})

test('追加标签：空输入只提示不动；填了就发到 /stickers/batch（合并去重后交给后端）', async () => {
  const { state, children, posts, loads } = runGallery({ items: ITEMS, selected: ['stk_a', 'stk_b'] })
  const pickBar = children.find((node) => node.className === 'fw-gallery-pickbar')
  assert.ok(byText(pickBar, '追加标签'))

  // 空输入：只写一句提示，不发请求。
  click(byText(pickBar, '追加标签'))
  assert.equal(posts.length, 0)
  assert.ok(texts(pickBar).some((text) => /先填要加的标签/.test(text)))

  const input = flat(pickBar).find((node) => node.className === 'fw-input')
  assert.ok(input, '要有标签输入框')
  input.value = '新标签，可爱 乖'
  for (const fn of input.listeners.input || []) fn()
  click(byText(pickBar, '追加标签'))
  assert.equal(posts.length, 1)
  assert.equal(posts[0].path, '/dsh-fish-world/stickers/batch')
  assert.equal(posts[0].body.action, 'tags')
  assert.deepEqual(posts[0].body.ids, ['stk_a', 'stk_b'])
  // 逗号 / 中文逗号 / 空格都算分隔符。
  assert.deepEqual(posts[0].body.tags, ['新标签', '可爱', '乖'])

  await Promise.resolve()
  await Promise.resolve()
  assert.ok(loads.length >= 1, '批量改完要重新读图库，否则卡片上还是旧标签')
  // 结果就近显示：重绘后由 syncPickBar 把 state.stickerBatchMsg 摆到批量条下面。
  assert.match(state.stickerBatchMsg.text, /已给 2 张追加标签「新标签、可爱、乖」/)
  assert.equal(state.stickerBatchMsg.tone, 'success')
})

test('批量删除两步：第一次只换确认并说明后果，第二次才真发请求', async () => {
  const { state, children, posts } = runGallery({ items: ITEMS, selected: ['stk_a', 'stk_b'] })
  const pickBar = children.find((node) => node.className === 'fw-gallery-pickbar')

  click(byText(pickBar, '批量删除'))
  assert.equal(posts.length, 0, '第一次点不能删')
  assert.equal(state.stickerBatchConfirm, true)
  assert.ok(texts(pickBar).some((text) => text === '将删除 2 张图，不可恢复。确认后立即从磁盘删掉。'))
  const confirm = byText(pickBar, '确认删除 2 张')
  assert.ok(confirm, '要出现确认按钮')

  click(confirm)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].body.action, 'remove')
  assert.deepEqual(posts[0].body.ids, ['stk_a', 'stk_b'])
  await Promise.resolve()
  await Promise.resolve()
  assert.match(state.stickerBatchMsg.text, /已删除 2 张/)
  assert.equal(state.stickerBatchMsg.tone, 'success')
})

test('视觉整理没接入：不放灰按钮，如实说原因', () => {
  const { children } = runGallery({ items: ITEMS, selected: ['stk_a'], vision: { ready: false, reason: '缺少 API key' } })
  const pickBar = children.find((node) => node.className === 'fw-gallery-pickbar')
  assert.equal(byText(pickBar, '批量整理'), undefined, '接不上就不该有按钮')
  assert.ok(texts(pickBar).some((text) => /批量整理暂不可用：缺少 API key/.test(text)), '要说明缺什么')
  // 另外两个按钮不受影响，照常可用。
  assert.ok(byText(pickBar, '追加标签'))
  assert.ok(byText(pickBar, '批量删除'))
})

test('批量整理：接了视觉接口就发 action=organize，并汇总成功/失败', async () => {
  const { state, children, posts } = runGallery({ items: ITEMS, selected: ['stk_a', 'stk_b'] })
  const pickBar = children.find((node) => node.className === 'fw-gallery-pickbar')
  click(byText(pickBar, '批量整理'))
  assert.equal(posts.length, 1)
  assert.equal(posts[0].body.action, 'organize')
  assert.deepEqual(posts[0].body.ids, ['stk_a', 'stk_b'])
  await Promise.resolve()
  await Promise.resolve()
  assert.match(state.stickerBatchMsg.text, /整理完成：成功 2 张/)
  assert.equal(state.stickerBatchMsg.tone, 'success')
})
