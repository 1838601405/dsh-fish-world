/**
 * 鱼世界面板 —— 便当盒布局 + 语义 token。
 *
 * 这个文件只做「视图与交互」：数据来自父窗口的 /dsh-fish-world/* 路由，
 * 拿不到就退到明确的空态/错误态，不伪造数据。
 *
 * 关键约束（与 ui/AGENTS.md 一致）：
 *  - 颜色/间距/圆角/阴影只走 tokens.css 的变量
 *  - 零位移：没有 translate / scale / 位移式 hover
 *  - hover 只做一级背景变化
 *  - 毛玻璃只用于左栏与浮层
 */
;(function () {
  'use strict'

  var NAV = [
    { id: 'overview', label: '总览' },
    { id: 'diary', label: '鱼的日记' },
    { id: 'wishes', label: '鱼的请求' },
    { id: 'growth', label: '鱼的成长' },
    { id: 'status', label: '鱼的状态' },
    { id: 'stickers', label: '鱼的收藏' },
    { id: 'extensions', label: '扩展与设置' },
    { id: 'profile', label: '鱼的设置' },
    { id: 'platforms', label: '鱼与世界' },
    { id: 'voice', label: '发言 API' },
    { id: 'astrbot', label: 'AstrBot 接入' },
    { id: 'doctor', label: '体检与更新' },
    { id: 'display', label: '面板显示' },
  ]

  // 总览的详略：简化为紧凑摘要，详细为每分区一张卡。默认简化，避免一屏挤满。
  function overviewDetailed() {
    return readFlag('overviewDetail', false)
  }
  function setOverviewDetailFlag(value) {
    writeFlag('overviewDetail', value === true)
  }

  // 面板显示开关：与 DSH 内嵌面板共用同一组 localStorage key。
  var DISPLAY_KEYS = [
    { key: 'showTts', label: '朗读桥卡（默认关闭）', hint: '只控制卡片显隐，不会开启自动朗读' },
    { key: 'showMood', label: '心情挂饰', hint: '原 dsh-feiyu-mood 挂件是否显示' },
    { key: 'showBadge', label: '鲸鱼心情徽标', hint: '有鲸鱼时，心情显示在鲸鱼身上' },
    { key: 'showBubble', label: '鲸鱼余额气泡', hint: '鲸鱼旁的余额消息框' },
  ]

  var state = {
    view: 'overview',
    loading: {},
    errors: {},
    mood: null,
    physical: null,
    wishes: null,
    growth: null,
    platforms: null,
    voice: null,
    astrbot: null,
    portrait: null,
    stickerDir: null,
    storage: null,
    activity: null,
    records: null,
    links: null,
    doctorDep: null,
    doctorUpdate: null,
    doctorBusy: false,
    profile: null,
    persona: null,
    tts: null,
    diary: null,
    diaryDate: '',
    stickers: null,
    qzone: null,
    capabilities: null,
    extensions: null,
    env: null,
  }

  // ---------- 小工具 ----------
  function h(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k]
        if (v == null || v === false) return
        if (k === 'text') node.textContent = v
        else if (k === 'class') node.className = v
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d] })
        else node.setAttribute(k, v === true ? '' : String(v))
      })
    }
    ;(children || []).forEach(function (child) {
      if (child == null) return
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    })
    return node
  }

  function getJSON(path) {
    return fetch(path, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  function postJSON(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  function readFlag(key, fallback) {
    try {
      var v = localStorage.getItem('dshcp.' + key)
      return v == null ? fallback : v === '1'
    } catch (e) { return fallback }
  }

  function writeFlag(key, value) {
    try {
      localStorage.setItem('dshcp.' + key, value ? '1' : '0')
      // 内嵌面板与 mood-badge 脚本都监听 storage / BroadcastChannel。
      try { new BroadcastChannel('dshcp.sync').postMessage({ key: key }) } catch (e) {}
    } catch (e) {}
  }

  function today() {
    var d = new Date()
    var m = String(d.getMonth() + 1).padStart(2, '0')
    var day = String(d.getDate()).padStart(2, '0')
    return d.getFullYear() + '-' + m + '-' + day
  }

  function shortTime(value) {
    if (!value) return ''
    return String(value).slice(0, 16).replace('T', ' ')
  }

  // ---------- 卡片 ----------
  // Bento 卡片：header 固定，body 撑开，按钮靠 margin-top:auto 沉到卡片底部。
  // header 左侧是专属抓手（⠿）：只有它能发起拖拽，正文与按钮保持正常交互。
  function card(opts) {
    var head = h('div', { class: 'fw-card-head' }, [
      opts.draggable === false ? null : h('span', {
        class: 'fw-grip',
        role: 'button',
        tabindex: '0',
        'aria-label': '拖动调整位置',
        title: '按住拖动调整位置 · Alt+方向键移动',
        text: '⠿',
      }),
      h('h2', { class: 'fw-card-title', text: opts.title, title: opts.title }),
      opts.note ? h('span', { class: 'fw-card-note', text: opts.note, title: opts.note }) : null,
    ])
    var body = h('div', { class: 'fw-card-body' }, opts.children || [])
    var node = h('section', {
      class: 'fw-card' + (opts.span ? ' fw-span-' + opts.span : ''),
      dataset: { selected: opts.selected ? 'true' : 'false' },
    }, [head, body])
    if (opts.key) {
      node.dataset.cardKey = String(opts.key)
      registerCard(node)
    }
    return node
  }

  function statusLine(text, tone) {
    return h('p', { class: 'fw-status', dataset: { tone: tone || '' }, text: text || '' })
  }

  function emptyState(text) {
    return h('div', { class: 'fw-empty', text: text })
  }

  // 状态指示：4px 灰阶圆点 + 灰阶文字，不用彩色色块。
  function statusDot(text, level) {
    return h('span', { class: 'fw-dot-status', dataset: { level: level || 'neutral' } }, [
      h('i', { class: 'fw-dot', 'aria-hidden': 'true' }),
      h('span', { text: text || '' }),
    ])
  }

  // 状态行：左侧标题，右侧状态（严格两端对齐，无边框无底纹）。
  function infoRow(label, value, opts) {
    var o = opts || {}
    var valueNode = o.level
      ? statusDot(value, o.level)
      : h('span', { class: 'fw-row-value', text: value == null ? '' : String(value) })
    return h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: label }),
      valueNode,
    ])
  }

  // 幽灵按钮：透明底 + 极细边框 + 次级文字色。禁止纯白底。
  function ghostButton(label, onClick) {
    var b = h('button', { class: 'fw-btn fw-btn-ghost', type: 'button', text: label })
    b.addEventListener('click', onClick)
    return b
  }

  function switchRow(opts) {
    var sw = h('button', {
      class: 'fw-switch',
      type: 'button',
      role: 'switch',
      'aria-checked': opts.checked ? 'true' : 'false',
      'aria-label': opts.label,
    })
    sw.addEventListener('click', function () {
      var next = sw.getAttribute('aria-checked') !== 'true'
      sw.setAttribute('aria-checked', next ? 'true' : 'false')
      if (opts.onChange) opts.onChange(next)
    })
    return h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label' }, [
        h('span', { text: opts.label }),
        opts.hint ? h('span', { class: 'fw-row-hint', text: opts.hint }) : null,
      ]),
      sw,
    ])
  }

  // ---------- 各视图 ----------
  // 总览：默认简化（紧凑摘要），可切到详细（每分区一张卡）。
  function viewOverview() {
    var mood = state.mood
    var tts = state.tts
    var diary = state.diary
    var wishes = state.wishes
    var growth = state.growth
    var platforms = state.platforms
    var profile = state.profile
    var voice = state.voice
    var dep = state.doctorDep
    var detailed = overviewDetailed()

    var moodText = mood && mood.ok
      ? [mood.moodLabel || '心情', mood.mood == null ? '' : String(mood.mood)].filter(Boolean).join(' · ')
      : (state.errors.mood ? '读取失败' : '读取中…')

    var ttsText = tts && tts.ok
      ? (tts.auto ? '自动朗读：开' : '自动朗读：关') + ' · ' + (tts.playing ? '正在念' : '没在念')
      : (state.errors.tts ? '朗读桥不可用' : '读取中…')

    var diaryCount = diary && diary.entries ? diary.entries.length : null
    var pendingWishes = wishes && wishes.wishes
      ? wishes.wishes.filter(function (w) { return w.status === 'pending' }).length : null
    var stageName = growth && growth.stage ? growth.stage.name : ''
    var installed = platforms && platforms.platforms
      ? platforms.platforms.filter(function (p) { return p.installed }).length : null

    // 模式切换：极简文本 tabs，仅靠底部下划线区分，不用方块按钮
    // 这张卡固定在最前，不参与拖拽排序
    var modeBar = card({
      draggable: false,
      title: '总览',
      note: detailed ? '详细：每个分区一张卡' : '简化：只显示要点',
      span: 12,
      children: [
        h('div', { class: 'fw-tabs', role: 'tablist' }, [
          tabItem('简化', !detailed, function () { setOverviewDetail(false) }),
          tabItem('详细', detailed, function () { setOverviewDetail(true) }),
        ]),
        detailed ? null : h('p', { class: 'fw-card-note', style: 'margin-top:var(--space-3)' },
          ['需要逐项操作时切到「详细」，或直接点左侧导航进入对应分区。']),
      ],
    })

    if (!detailed) {
      return [modeBar, ...viewOverviewCompact({
        moodText: moodText, ttsText: ttsText, diaryCount: diaryCount,
        pendingWishes: pendingWishes, stageName: stageName, installed: installed,
        mood: mood, growth: growth, dep: dep, voice: voice,
      })]
    }

    return [modeBar, ...viewOverviewDetailed({
      moodText: moodText, ttsText: ttsText, diaryCount: diaryCount,
      pendingWishes: pendingWishes, stageName: stageName, installed: installed,
      mood: mood, growth: growth, platforms: platforms, profile: profile, voice: voice, dep: dep,
    })]
  }

  function setOverviewDetail(value) {
    setOverviewDetailFlag(value === true)
    render()
  }

  // ---------- 拖拽重排（原生实现，无第三方库） ----------
  // 设计取舍：面板是原生 DOM，没有 React；所以用 CSS Grid + DOM 顺序交换实现，
  // 不引入 dnd-kit / react-grid-layout。
  //  - 只有抓手（⠿）能发起拖拽，卡片内文字与按钮保持正常选区和点击；
  //  - 让位动画用 FLIP：先记录位置，改 DOM，再按位移做反向 transform，150ms ease-out；
  //  - 松手瞬间吸附，无弹簧/惯性；
  //  - 键盘：抓手 Tab 聚焦，Alt + 方向键交换位置。
  var cardRegistry = []
  var dragState = null

  function registerCard(node) {
    cardRegistry.push(node)
  }

  function cardOrderKey(node) {
    return node && node.dataset ? node.dataset.cardKey : ''
  }

  function readOrder(grid) {
    return [...grid.children]
      .filter((el) => el.classList && el.classList.contains('fw-card'))
      .map(cardOrderKey)
      .filter(Boolean)
  }

  function persistOrder(grid) {
    try {
      localStorage.setItem('dshcp.cardOrder', JSON.stringify(readOrder(grid)))
    } catch (e) {}
  }

  function savedOrder() {
    try {
      var raw = localStorage.getItem('dshcp.cardOrder')
      var parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch (e) { return [] }
  }

  /** 按保存的顺序重排网格，未记录的卡片保持原有相对顺序跟在后面。 */
  function applySavedOrder(grid) {
    var order = savedOrder()
    if (!order.length) return
    var nodes = [...grid.children].filter((el) => el.classList && el.classList.contains('fw-card'))
    var byKey = new Map(nodes.map((node) => [cardOrderKey(node), node]))
    var placed = []
    for (var key of order) {
      var node = byKey.get(key)
      if (node && placed.indexOf(node) < 0) placed.push(node)
    }
    for (var rest of nodes) if (placed.indexOf(rest) < 0) placed.push(rest)
    // 可拖拽的卡片按保存顺序排，不可拖拽的（如模式切换条）始终在最前
    var fixed = placed.filter((node) => !cardOrderKey(node))
    var movable = placed.filter((node) => cardOrderKey(node))
    for (var node of fixed.concat(movable)) grid.appendChild(node)
  }

  // FLIP：记录旧位置 -> 改 DOM -> 反向位移 -> 下一帧归零
  function flip(grid, mutate) {
    var cards = [...grid.children].filter((el) => el.classList && el.classList.contains('fw-card'))
    var before = new Map()
    for (var el of cards) before.set(el, el.getBoundingClientRect())

    mutate()

    var after = [...grid.children].filter((el) => el.classList && el.classList.contains('fw-card'))
    for (var node of after) {
      var prev = before.get(node)
      if (!prev) continue
      var next = node.getBoundingClientRect()
      var dx = prev.left - next.left
      var dy = prev.top - next.top
      if (!dx && !dy) continue
      node.style.transition = 'none'
      node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
      // 强制重排后再归零，避免与初始样式合并
      void node.offsetWidth
      node.style.transition = 'transform 160ms ease-out'
      node.style.transform = ''
    }
  }

  function moveCard(grid, node, targetIndex) {
    var cards = [...grid.children].filter((el) => el.classList && el.classList.contains('fw-card'))
    // 没有 key 的卡片（如模式切换条）固定在原位，不参与重排
    if (!cardOrderKey(node)) return
    var current = cards.indexOf(node)
    if (current < 0) return
    var clamped = Math.max(0, Math.min(cards.length - 1, targetIndex))
    var target = cards[clamped]
    if (!target || !cardOrderKey(target)) return
    if (clamped === current) return
    flip(grid, function () {
      var reference = cards[clamped]
      if (clamped > current) grid.insertBefore(node, reference.nextSibling)
      else grid.insertBefore(node, reference)
    })
    persistOrder(grid)
  }

  function canDrag() {
    // 设置页内嵌模式下不启用拖拽（那里是表单流，重排没有意义）
    return window.__DSH_FISH_WORLD_SETTINGS_MODE__ !== true
  }

  function bindDragAndDrop(grid) {
    grid.addEventListener('pointerdown', function (event) {
      if (!canDrag() || event.button !== 0) return
      var grip = event.target.closest && event.target.closest('.fw-grip')
      if (!grip) return
      var node = grip.closest('.fw-card')
      if (!node) return

      event.preventDefault()
      var rect = node.getBoundingClientRect()
      var placeholder = h('div', { class: 'fw-card-placeholder fw-span-' + spanOf(node) })
      placeholder.style.height = rect.height + 'px'

      dragState = {
        grid: grid,
        node: node,
        placeholder: placeholder,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        pointerId: event.pointerId,
      }
      node.classList.add('fw-card-dragging')
      node.style.width = rect.width + 'px'
      node.style.height = rect.height + 'px'
      node.style.left = rect.left + 'px'
      node.style.top = rect.top + 'px'
      grid.insertBefore(placeholder, node)
      document.body.appendChild(node)
      try { grip.setPointerCapture(event.pointerId) } catch (e) {}

      window.addEventListener('pointermove', onDragMove)
      window.addEventListener('pointerup', onDragEnd)
      window.addEventListener('pointercancel', onDragEnd)
    })

    // 键盘：抓到焦点后 Alt + 方向键交换位置
    grid.addEventListener('keydown', function (event) {
      if (!canDrag()) return
      var grip = event.target.closest && event.target.closest('.fw-grip')
      if (!grip || !event.altKey) return
      var node = grip.closest('.fw-card')
      if (!node) return
      var cards = [...grid.children].filter((el) => el.classList && el.classList.contains('fw-card'))
      var index = cards.indexOf(node)
      var delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0
      if (!delta) return
      event.preventDefault()
      moveCard(grid, node, index + delta)
      // 保持焦点在同一个抓手上
      var nextGrip = node.querySelector('.fw-grip')
      if (nextGrip) nextGrip.focus()
    })
  }

  function spanOf(node) {
    for (var n = 3; n <= 12; n += 1) {
      if (node.classList.contains('fw-span-' + n)) return n
    }
    return 12
  }

  function onDragMove(event) {
    if (!dragState) return
    var node = dragState.node
    node.style.left = (event.clientX - dragState.offsetX) + 'px'
    node.style.top = (event.clientY - dragState.offsetY) + 'px'

    // 找指针下方的卡片，把占位符移到它前面/后面
    node.style.visibility = 'hidden'
    var under = document.elementFromPoint(event.clientX, event.clientY)
    node.style.visibility = ''
    var target = under && under.closest ? under.closest('.fw-card') : null
    if (!target || target === node || !dragState.grid.contains(target)) return

    var cards = [...dragState.grid.children].filter((el) => el.classList && el.classList.contains('fw-card') && el !== node)
    var targetIndex = cards.indexOf(target)
    var placeholderIndex = cards.indexOf(dragState.placeholder)
    var before = event.clientX < target.getBoundingClientRect().left + target.offsetWidth / 2
    var nextIndex = before ? targetIndex : targetIndex + 1
    if (nextIndex === placeholderIndex || nextIndex === placeholderIndex + 1) return

    flip(dragState.grid, function () {
      var reference = cards[targetIndex]
      if (before) dragState.grid.insertBefore(dragState.placeholder, reference)
      else dragState.grid.insertBefore(dragState.placeholder, reference.nextSibling)
    })
  }

  function onDragEnd() {
    if (!dragState) return
    var state = dragState
    dragState = null
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    window.removeEventListener('pointercancel', onDragEnd)

    var node = state.node
    // 松手瞬间吸附：不要过渡，直接落位
    node.style.transition = 'none'
    node.style.position = ''
    node.style.left = ''
    node.style.top = ''
    node.style.width = ''
    node.style.height = ''
    node.style.visibility = ''
    node.classList.remove('fw-card-dragging')
    state.grid.insertBefore(node, state.placeholder)
    state.placeholder.remove()
    void node.offsetWidth
    node.style.transition = ''
    persistOrder(state.grid)
  }

  // 文本 tab：选中靠底部下划线 + 文字提亮，不用背景块。
  function tabItem(label, active, onClick) {
    var t = h('button', {
      class: 'fw-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': active ? 'true' : 'false',
      text: label,
    })
    t.addEventListener('click', onClick)
    return t
  }

  // 简化模式：概览用 2 列微型数据网格，待办占 4 列。
  // 微型卡只响应点击与文本选区，拖拽仍然只由卡片头部的抓手触发。
  function miniCard(opts) {
    var clickable = typeof opts.target === 'string' && opts.target
    var node = clickable
      ? h('button', {
        class: 'fw-mini fw-mini-link',
        type: 'button',
        'aria-label': opts.label + '：' + (opts.value == null ? '' : opts.value) + (opts.sub ? ' ' + opts.sub : ''),
      })
      : h('div', { class: 'fw-mini' })

    if (opts.wide) node.style.gridColumn = 'span 2'

    node.appendChild(h('span', { class: 'fw-mini-label', text: opts.label, title: opts.label }))

    var valueRow = h('span', { class: 'fw-mini-value-row' })
    var raw = opts.value == null ? '—' : String(opts.value)
    valueRow.appendChild(h('span', { class: 'fw-mini-value', text: raw, title: raw }))
    // 需要操作时给一个 4px 状态点，不作大面积色块
    if (opts.tone) valueRow.appendChild(h('span', { class: 'fw-mini-dot', dataset: { tone: opts.tone }, 'aria-hidden': 'true' }))
    node.appendChild(valueRow)

    if (opts.sub) node.appendChild(h('span', { class: 'fw-mini-sub', text: opts.sub, title: opts.sub }))

    // 极小进度条：溢出时填满并转警告色，宽度始终夹在 100% 内
    if (opts.progress) {
      var used = Number(opts.progress.value)
      var total = Number(opts.progress.max)
      var ratio = total > 0 ? used / total : 0
      var over = ratio > 1
      var pct = Math.max(0, Math.min(100, ratio * 100))
      var bar = h('span', { class: 'fw-mini-bar' }, [
        h('i', {
          style: 'width:' + pct.toFixed(1) + '%' + (over ? ';background:var(--text-feedback-error)' : ''),
        }),
      ])
      if (over) bar.title = '已超出上限：' + (ratio * 100).toFixed(1) + '%'
      node.appendChild(bar)
    }

    if (clickable) node.addEventListener('click', function () { navigate(opts.target) })
    return node
  }

  function viewOverviewCompact(ctx) {
    // 把状态拆成「主数值 + 从属说明」，主数值用等宽数字对齐
    var moodValue = null
    var moodSub = ctx.moodText
    if (state.mood && state.mood.ok && state.mood.mood != null) {
      moodValue = state.mood.mood
      moodSub = state.mood.moodLabel || '心情'
    }

    var growthValue = ctx.growth ? (ctx.growth.total || 0) : null
    var growthSub = ctx.stageName || (ctx.growth ? '' : '读取中…')

    var diaryValue = ctx.diaryCount == null ? null : ctx.diaryCount
    var wishValue = ctx.pendingWishes == null ? null : ctx.pendingWishes
    var installedValue = ctx.installed == null ? null : ctx.installed

    var depTone = ctx.dep ? (ctx.dep.ok ? 'ok' : 'warn') : 'neutral'
    var depValue = ctx.dep ? (ctx.dep.ok ? '就绪' : '缺失') : '未体检'

    var ttsOn = state.tts && state.tts.ok ? (state.tts.auto ? '开' : '关') : null

    var miniCards = [
      miniCard({ label: '鱼的状态', value: moodValue, sub: moodSub, target: 'status' }),
      miniCard({ label: '鱼的成长', value: growthValue, sub: growthSub, target: 'growth' }),
      miniCard({ label: '鱼的日记', value: diaryValue, sub: diaryValue == null ? '读取中…' : '条已记录', target: 'diary' }),
      miniCard({
        label: '鱼的请求',
        value: wishValue,
        sub: wishValue == null ? '读取中…' : (wishValue ? '条待处理' : '没有待处理'),
        tone: wishValue ? 'error' : '',
        target: 'wishes',
      }),
      miniCard({
        label: '鱼与世界',
        value: installedValue == null ? null : installedValue + '/3',
        sub: '已连接的平台',
        progress: installedValue == null ? null : { value: installedValue, max: 3 },
        target: 'platforms',
      }),
      miniCard({ label: '朗读桥', value: ttsOn, sub: state.tts && state.tts.playing ? '正在念' : '没在念', target: 'status' }),
      // 最后一项跨两列，避免 2 列网格留下空位
      miniCard({ label: '依赖', value: depValue, sub: ctx.dep ? '前置插件检查结果' : '还没有体检', tone: depTone, target: 'doctor', wide: true }),
    ]

    var quick = card({
      key: 'overview-summary',
      title: '概览',
      note: '点任一项进入',
      span: 8,
      children: [h('div', { class: 'fw-mini-grid' }, miniCards)],
    })

    // 待办：每一项都带"去处理"的目标，点一下直接到对应界面
    var todo = []
    if (ctx.pendingWishes) todo.push({ text: '有 ' + ctx.pendingWishes + ' 条请求等你批复', target: 'wishes', label: '去批复' })
    if (ctx.dep && ctx.dep.ok === false) todo.push({ text: '依赖体检发现缺失项', target: 'doctor', label: '去体检' })
    if (ctx.voice && !ctx.voice.active) todo.push({ text: '发言 API 尚未配置', target: 'voice', label: '去配置' })
    if (!todo.length) todo.push({ text: '没有待处理信息', target: '', label: '' })

    // 快捷入口：常用分区放在待办下方，一键直达
    // 没有内容时统一显示「无」，不写「暂无待处理」这类同义反复
    function orNone(value) {
      if (value == null || value === '' || value === 0 || value === '0') return '无'
      return String(value)
    }

    var shortcuts = [
      { id: 'wishes', label: '鱼的请求', hint: ctx.pendingWishes ? ctx.pendingWishes + ' 条待处理' : '无' },
      { id: 'diary', label: '鱼的日记', hint: ctx.diaryCount == null ? '读取中…' : orNone(ctx.diaryCount ? ctx.diaryCount + ' 条' : 0) },
      { id: 'growth', label: '鱼的成长', hint: ctx.stageName || '无' },
      { id: 'status', label: '鱼的状态', hint: ctx.moodText || '无' },
      { id: 'platforms', label: '鱼与世界', hint: ctx.installed == null ? '读取中…' : orNone(ctx.installed ? ctx.installed + ' / 3' : 0) },
      { id: 'doctor', label: '体检与更新', hint: ctx.dep ? (ctx.dep.ok ? '已就绪' : '有缺失') : '未体检' },
    ]

    var todoCard = card({
      key: 'overview-todo',
      title: '需要你处理',
      note: todo.length + ' 项',
      span: 4,
      children: [
        h('div', { class: 'fw-plainlist' }, todo.map(function (item) {
          if (!item.target) return h('p', { class: 'fw-plainlist-item', text: item.text })
          var go = h('button', {
            class: 'fw-link fw-todo-action',
            type: 'button',
            text: item.label,
            'aria-label': item.label + '：' + item.text,
          })
          go.addEventListener('click', function () { navigate(item.target) })
          return h('div', { class: 'fw-todo-item' }, [
            h('span', { class: 'fw-todo-text', text: item.text }),
            go,
          ])
        })),
        h('div', { class: 'fw-shortcuts' }, shortcuts.map(function (item) {
          var b = h('button', {
            class: 'fw-shortcut',
            type: 'button',
            'aria-label': '进入' + item.label,
          }, [
            h('span', { class: 'fw-shortcut-label', text: item.label }),
            h('span', { class: 'fw-shortcut-hint', text: item.hint || '' }),
          ])
          b.addEventListener('click', function () { navigate(item.id) })
          return b
        })),
      ],
    })

    return [quick, todoCard]
  }

  // 简化模式的一行摘要：点击跳转用灰色文字链接，不用按钮。
  function summaryRow(label, value, target) {
    var nameNode = target
      ? h('button', { class: 'fw-link', type: 'button', text: label, 'aria-label': '进入' + label })
      : h('span', { text: label })
    if (target) nameNode.addEventListener('click', function () { navigate(target) })
    return h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label' }, [nameNode]),
      h('span', { class: 'fw-row-value', text: value || '' }),
    ])
  }

  // 详细模式：主数据卡 span 6，次要卡 span 4 / 3，横向按 12 列铺满。
  function viewOverviewDetailed(ctx) {
    var mood = ctx.mood
    var platforms = ctx.platforms
    var profile = ctx.profile
    var voice = ctx.voice
    var growth = ctx.growth
    var dep = ctx.dep
    var installed = ctx.installed
    var diaryCount = ctx.diaryCount
    var pendingWishes = ctx.pendingWishes
    var stageName = ctx.stageName
    var moodText = ctx.moodText
    var ttsText = ctx.ttsText
    var envOk = state.env && state.env.ok !== false

    // 一个"数据卡"的统一样式：标题 + 若干状态行 + 底部幽灵按钮
    function dataCard(opts) {
      var children = []
      if (opts.rows) children = children.concat(opts.rows)
      if (opts.prose) children.push(h('p', { class: 'fw-prose', text: opts.prose }))
      if (opts.action) children.push(h('div', { class: 'fw-card-actions' }, [
        ghostButton(opts.action, opts.onAction),
      ]))
      return card({
        key: opts.key || ('k-' + opts.title),
        title: opts.title,
        note: opts.note,
        span: opts.span,
        children: children,
      })
    }

    return [
      // 第一行：核心运行状态占 6，鱼的状态占 6
      dataCard({
        title: '运行状态',
        note: '环境正常时不打扰',
        span: 6,
        rows: [
          infoRow('前置依赖', envOk ? '已就绪' : '待处理', { level: envOk ? 'ok' : 'error' }),
          infoRow('朗读桥', ttsText),
          infoRow('Node', (state.env && state.env.node && state.env.node.version) || '—'),
        ],
        action: '去体检',
        onAction: function () { navigate('doctor') },
      }),
      dataCard({
        title: '鱼的状态',
        note: '心理与生理',
        span: 6,
        rows: [
          infoRow('当前心情', moodText, { level: mood && mood.ok ? 'ok' : 'neutral' }),
          infoRow('成长阶段', growth ? (stageName + ' · ' + (growth.total || 0) + ' 条') : '读取中…'),
          infoRow('头像情绪', state.portrait ? (state.portrait.emotionLabel || '平静') : '读取中'),
        ],
        action: '查看数值',
        onAction: function () { navigate('status') },
      }),

      // 第二行：日记 / 请求 / 成长，各占 4
      dataCard({
        title: '鱼的日记',
        note: (diaryCount == null ? '读取中' : diaryCount + ' 条'),
        span: 4,
        prose: '日记由鱼自己写，这里只查看和批阅，不代写正文。',
        action: '查看日记',
        onAction: function () { navigate('diary') },
      }),
      dataCard({
        title: '鱼的请求',
        note: (pendingWishes == null ? '读取中' : pendingWishes + ' 条待处理'),
        span: 4,
        prose: '鱼提出的请求，主人的批复会影响鱼。',
        action: '去批复',
        onAction: function () { navigate('wishes') },
      }),
      dataCard({
        title: '鱼的成长',
        note: growth ? (stageName || '') : '读取中',
        span: 4,
        prose: growth ? (growth.stage && growth.stage.note) || '可修订、可撤回的理解' : '读取中…',
        action: '查看成长',
        onAction: function () { navigate('growth') },
      }),

      // 第三行：平台 / 设置 / 收藏 / 发言 API，各占 3
      dataCard({
        title: '鱼与世界',
        note: (installed == null ? '读取中' : installed + ' / 3'),
        span: 3,
        prose: 'QQ、B 站、抖音各自独立，外发默认关闭。',
        action: '管理',
        onAction: function () { navigate('platforms') },
      }),
      dataCard({
        title: '鱼的设置',
        note: profile && profile.fish ? (profile.fish.name || '鱼') : '读取中',
        span: 3,
        prose: '名字、称呼、角色卡与人设。',
        action: '设置',
        onAction: function () { navigate('profile') },
      }),
      dataCard({
        title: '鱼的收藏',
        note: state.stickers ? ((state.stickers.items || []).length + ' 张图片') : '读取中',
        span: 3,
        prose: '表情图片与网站收藏。',
        action: '查看',
        onAction: function () { navigate('stickers') },
      }),
      dataCard({
        title: '发言 API',
        note: voice ? (voice.active ? '生效中' : '未配置') : '读取中',
        span: 3,
        prose: '评论和聊天可单独用语言模型。',
        action: '配置',
        onAction: function () { navigate('voice') },
      }),

      // 第四行：扩展 / 体检状态 各占 4，面板显示与能力目录各占 6
      dataCard({
        title: '扩展',
        note: state.extensions ? ((state.extensions.extensions || []).length + ' 个') : '读取中',
        span: 4,
        prose: '已安装的外部扩展与能力目录。',
        action: '管理扩展',
        onAction: function () { navigate('extensions') },
      }),
      dataCard({
        title: '体检与更新',
        note: dep ? (dep.ok ? '依赖就绪' : '有缺失') : '未体检',
        span: 4,
        rows: [
          infoRow('依赖体检', dep ? (dep.ok ? '通过' : '待处理') : '未运行', { level: dep ? (dep.ok ? 'ok' : 'error') : 'neutral' }),
          infoRow('更新体检', '需联网手动触发'),
        ],
        action: '去体检',
        onAction: function () { navigate('doctor') },
      }),
      dataCard({
        title: '鱼的样子',
        note: state.portrait ? (state.portrait.emotionLabel || '平静') : '读取中',
        span: 4,
        prose: '头像随心理状态变化，可自己上传。',
        action: '看状态',
        onAction: function () { navigate('status') },
      }),

      card({
        title: '面板显示',
        note: '默认隐藏项可随时恢复',
        span: 6,
        children: DISPLAY_KEYS.slice(0, 2).map(function (item) {
          return switchRow({
            label: item.label,
            hint: item.hint,
            checked: readFlag(item.key, false),
            onChange: function (next) { writeFlag(item.key, next) },
          })
        }),
      }),
      card({
        title: '能力目录',
        note: '内置核心模块 / 本地插件 / 模型技能',
        span: 6,
        children: [renderCapabilitySummary()],
      }),
    ]
  }

  function renderCapabilitySummary() {
    var caps = state.capabilities
    if (state.errors.capabilities) return statusLine('能力目录读取失败：' + state.errors.capabilities, 'error')
    if (!caps) return statusLine('读取中…')
    var builtIn = (caps.built_in || []).length
    var plugins = (caps.plugins || []).length
    var skills = (caps.skills || []).length
    return h('div', {}, [
      h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: 'DSH 内置核心模块' }),
        h('span', { class: 'fw-badge', text: String(builtIn) }),
      ]),
      h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: '本地插件' }),
        h('span', { class: 'fw-badge', text: String(plugins) }),
      ]),
      h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: '模型技能' }),
        h('span', { class: 'fw-badge', text: String(skills) }),
      ]),
    ])
  }

  function viewDiary() {
    var data = state.diary
    var children = []

    var dateInput = h('input', {
      class: 'fw-input',
      type: 'date',
      value: state.diaryDate,
      'aria-label': '选择日期',
    })
    dateInput.addEventListener('change', function () {
      state.diaryDate = dateInput.value
      loadDiary()
    })

    children.push(h('div', { class: 'fw-btn-row', style: 'margin-top:0;margin-bottom:var(--space-3)' }, [
      dateInput,
      button('今天', function () { state.diaryDate = today(); loadDiary() }),
      button('全部', function () { state.diaryDate = ''; loadDiary() }),
      button('刷新', loadDiary),
    ]))

    if (state.errors.diary) {
      children.push(statusLine('读取失败：' + state.errors.diary, 'error'))
    } else if (!data) {
      children.push(statusLine('读取中…'))
    } else {
      var pending = data.suggestions || []
      var entries = data.entries || []

      children.push(h('div', { class: 'fw-card-head' }, [
        h('h3', { class: 'fw-card-title', text: '待主人确认' }),
        h('span', { class: 'fw-card-note', text: pending.length + ' 条' }),
      ]))
      if (!pending.length) {
        children.push(emptyState('没有待确认的日记。'))
      } else {
        children.push(h('div', { class: 'fw-list' }, pending.map(function (item) {
          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: shortTime(item.at) }),
              h('span', { text: item.actorName || '未知' }),
            ]),
            h('p', { class: 'fw-item-text', text: item.text || '（空）' }),
            h('div', { class: 'fw-btn-row' }, [
              button('通过', function () {
                postJSON('/dsh-fish-world/world/diary/review', { id: item.id, accept: true })
                  .then(loadDiary)
                  .catch(function (e) { setError('diary', e.message) })
              }, 'primary'),
              button('拒绝', function () {
                postJSON('/dsh-fish-world/world/diary/review', { id: item.id, accept: false })
                  .then(loadDiary)
                  .catch(function (e) { setError('diary', e.message) })
              }),
            ]),
          ])
        })))
      }

      children.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-4)' }, [
        h('h3', { class: 'fw-card-title', text: '已记录' }),
        h('span', { class: 'fw-card-note', text: entries.length + ' 条' }),
      ]))
      if (!entries.length) {
        children.push(emptyState('这一天还没有日记。'))
      } else {
        var comments = data.comments || []
        children.push(h('div', { class: 'fw-list' }, entries.map(function (item) {
          var mine = comments.filter(function (c) { return c.diaryId === item.id })
          var selected = ''
          var quoteChip = h('span', { class: 'fw-quote-chip', hidden: true })
          var textNode = h('p', { class: 'fw-item-text', text: item.text || '（空）' })

          // 选中正文片段 -> 变成一条只针对这句的批语。
          textNode.addEventListener('mouseup', function () {
            var sel = window.getSelection()
            var picked = sel ? String(sel.toString() || '').trim() : ''
            if (!picked) return
            if (String(item.text || '').indexOf(picked) < 0) return
            selected = picked
            quoteChip.textContent = '针对「' + picked + '」'
            quoteChip.hidden = false
          })
          quoteChip.addEventListener('click', function () {
            selected = ''
            quoteChip.hidden = true
            quoteChip.textContent = ''
          })

          var input = h('input', {
            class: 'fw-input',
            type: 'text',
            placeholder: '写一句批语，可先选中正文里的一句…',
            'aria-label': '批语',
          })
          var submit = button('批语', function () {
            var text = String(input.value || '').trim()
            if (!text) return
            var payload = { id: item.id, text: text }
            if (selected) payload.quote = selected
            postJSON('/dsh-fish-world/world/diary/comment', payload)
              .then(loadDiary)
              .catch(function (e) { setError('diary', e.message) })
          })

          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: shortTime(item.at) }),
              h('span', { text: item.actorName || '鱼' }),
              item.status === 'approved' ? h('span', { class: 'fw-badge', dataset: { tone: 'success' }, text: '已批准' }) : null,
            ]),
            textNode,
            mine.length ? h('div', { style: 'margin-top:var(--space-2)' }, mine.map(function (c) {
              return h('div', { class: 'fw-comment' }, [
                h('div', { class: 'fw-item-meta' }, [
                  h('span', { class: 'fw-badge', text: c.actorName || '主人' }),
                  c.quote ? h('span', { class: 'fw-comment-quote', text: '「' + c.quote + '」' }) : null,
                  c.respondedAt ? h('span', { class: 'fw-badge', dataset: { tone: 'success' }, text: '鱼已回应' }) : null,
                ]),
                h('p', { class: 'fw-item-text', text: c.text }),
              ])
            })) : null,
            h('div', { style: 'margin-top:var(--space-2)' }, [quoteChip]),
            h('div', { class: 'fw-row' }, [
              h('span', { style: 'flex:1;min-width:0' }, [input]),
              submit,
            ]),
          ])
        })))
      }
    }

    return [
      card({ title: '鱼的日记', note: '主人查看与批阅', span: 12, children: children }),
      // 主人与鱼：主人做过的批阅互动汇总，放在日记下方方便回看
      card({ title: '主人与鱼', note: '批阅互动记录', span: 12, children: [renderInteractions(data)] }),
    ]
  }

  // 主人与鱼：把日记批语与请求裁决合成一条时间线，只读展示。
  var INTERACTION_LABELS = {
    'diary-comment': '批语',
    'wish-approved': '同意请求',
    'wish-rejected': '拒绝请求',
  }

  function renderInteractions(data) {
    var timeline = data && data.interactions
    if (!timeline) return statusLine('读取中…')

    var counts = timeline.counts || {}
    var items = timeline.items || []
    var body = []

    body.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '批语 / 同意 / 拒绝' }),
      h('span', { class: 'fw-badge', text: [counts.diaryComments || 0, counts.approved || 0, counts.rejected || 0].join(' / ') }),
    ]))
    if (counts.pendingReply) {
      body.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label' }, [
          h('span', { text: '鱼还没回应的批语' }),
          h('span', { class: 'fw-row-hint', text: '它写下一篇日记时自然会看到' }),
        ]),
        h('span', { class: 'fw-badge', dataset: { tone: 'warn' }, text: String(counts.pendingReply) }),
      ]))
    }

    if (!items.length) {
      body.push(emptyState('还没有互动记录。你在日记上留批语、或批复鱼的请求后，这里会留下记录。'))
      return h('div', {}, body)
    }

    body.push(h('div', { class: 'fw-list', style: 'margin-top:var(--space-2)' }, items.map(function (item) {
      var meta = [h('span', { class: 'fw-badge', text: INTERACTION_LABELS[item.kind] || item.kind })]
      meta.push(h('span', { text: shortTime(item.at) }))
      if (item.kind === 'diary-comment' && item.responded) {
        meta.push(h('span', { class: 'fw-badge', dataset: { tone: 'success' }, text: '鱼已回应' }))
      }
      if (item.tone === 'explained') meta.push(h('span', { class: 'fw-badge', text: '有说明' }))
      if (item.tone === 'comforted') meta.push(h('span', { class: 'fw-badge', text: '有安慰' }))
      if (item.tone === 'curt') meta.push(h('span', { class: 'fw-badge', text: '简短打发' }))

      var rows = [h('div', { class: 'fw-item-meta' }, meta)]

      if (item.kind === 'diary-comment') {
        // 有引用就先展示被批的原句，再展示批语本身
        if (item.quote) rows.push(h('p', { class: 'fw-comment-quote', text: '「' + item.quote + '」' }))
        rows.push(h('p', { class: 'fw-item-text', text: item.text || '（空）' }))
      } else {
        rows.push(h('p', { class: 'fw-item-text', text: '请求：' + (item.text || '（空）') }))
        if (item.reply) rows.push(h('p', { class: 'fw-comment-quote', text: '你的答复：' + item.reply }))
      }

      return h('div', { class: 'fw-item' }, rows)
    })))

    return h('div', {}, body)
  }

  // ---- 鱼的请求 ----
  // 鱼主动提出的事；主人同意或拒绝，态度会影响鱼的心情。
  var WISH_TONES = [
    { value: '', label: '直接答复' },
    { value: 'explained', label: '说明原因' },
    { value: 'comforted', label: '安慰它' },
    { value: 'curt', label: '简短打发' },
  ]

  // 请求卡头的语气：每次进入这个界面随机挑一句，读起来像鱼在等你回话。
  // 只在"进入界面"时随机，避免每次状态刷新都换一句导致闪烁。
  var REQUEST_HINTS = [
    '希望主人答应',
    '等主人批复',
    '盼你点个头',
    '想听你说可以',
    '在等你回话',
    '请主人定夺',
    '等你松口',
    '就等你一句话',
  ]
  var currentRequestHint = ''

  function requestHint() {
    if (!currentRequestHint) {
      currentRequestHint = REQUEST_HINTS[Math.floor(Math.random() * REQUEST_HINTS.length)]
    }
    return currentRequestHint
  }

  // 切换分区时重新抽一句；同一界面内的重绘保持不变。
  function reshuffleRequestHint() {
    currentRequestHint = ''
  }

  function viewWishes() {
    var data = state.wishes
    var children = []

    if (state.errors.wishes) {
      children.push(statusLine('读取失败：' + state.errors.wishes, 'error'))
    } else if (!data) {
      children.push(statusLine('读取中…'))
    } else {
      var all = data.wishes || []
      var pending = all.filter(function (w) { return w.status === 'pending' })
      var decided = all.filter(function (w) { return w.status !== 'pending' })

      children.push(h('p', { class: 'fw-card-note', text: '鱼提出的请求，主人的批复会影响鱼。' }))
      // 每天最多 3 个请求，零点重置；当天没被回复的会进鱼的小本本。
      if (data.dailyLimit != null) {
        children.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label' }, [
            h('span', { text: '今天还能提' }),
            h('span', { class: 'fw-row-hint', text: data.limitNote || '每天最多 ' + data.dailyLimit + ' 个，零点重置' }),
          ]),
          h('span', { class: 'fw-badge', text: String(data.remainingToday == null ? '—' : data.remainingToday) + ' / ' + data.dailyLimit }),
        ]))
      }
      if (data.overdue > 0) {
        var grudgeCount = state.records && state.records.grudges
          ? (state.records.grudges || []).filter(function (g) { return g.status !== 'accepted' }).length
          : null
        children.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label' }, [
            h('span', { text: '没被回复的请求' }),
            h('span', { class: 'fw-row-hint', text: '过了当天还在挂着，它已经记进小本本，等你解释' }),
          ]),
          h('span', { class: 'fw-badge', dataset: { tone: 'warn' }, text: (grudgeCount == null ? data.overdue : grudgeCount) + ' 条' }),
        ]))
      }

      children.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
        h('h3', { class: 'fw-card-title', text: '等待处理' }),
        h('span', { class: 'fw-card-note', text: pending.length + ' 条' }),
      ]))

      if (!pending.length) {
        children.push(emptyState('现在没有待处理的请求。'))
      } else {
        children.push(h('div', { class: 'fw-list' }, pending.map(function (item) {
          var tone = ''
          var replyInput = h('input', {
            class: 'fw-input',
            type: 'text',
            placeholder: '说点什么…',
            'aria-label': '答复',
          })
          var toneSelect = h('select', { class: 'fw-input', 'aria-label': '语气' }, TONE_OPTIONS())
          toneSelect.addEventListener('change', function () { tone = toneSelect.value })

          function decide(accept) {
            var payload = { id: item.id, accept: accept }
            var text = String(replyInput.value || '').trim()
            if (text) payload.reply = text
            if (tone) payload.tone = tone
            postJSON('/dsh-fish-world/world/wishes', payload)
              .then(loadWishes)
              .catch(function (e) { setError('wishes', e.message) })
          }

          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: shortTime(item.at) }),
              item.urgency === 'high' ? h('span', { class: 'fw-badge', dataset: { tone: 'warn' }, text: '着急' }) : null,
              h('span', { text: item.kind || '请求' }),
            ]),
            h('p', { class: 'fw-item-text', text: item.text || '（空）' }),
            h('div', { class: 'fw-row', style: 'margin-top:var(--space-2)' }, [
              h('span', { style: 'flex:1;min-width:0' }, [replyInput]),
              h('span', { style: 'width:110px;flex:none' }, [toneSelect]),
            ]),
            h('div', { class: 'fw-btn-row' }, [
              button('同意', function () { decide(true) }, 'primary'),
              button('拒绝', function () { decide(false) }),
            ]),
          ])
        })))
      }

      children.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-4)' }, [
        h('h3', { class: 'fw-card-title', text: '已处理' }),
        h('span', { class: 'fw-card-note', text: decided.length + ' 条' }),
      ]))
      if (!decided.length) {
        children.push(emptyState('还没有处理过的请求。'))
      } else {
        children.push(h('div', { class: 'fw-list' }, decided.map(function (item) {
          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: shortTime(item.decidedAt || item.at) }),
              h('span', {
                class: 'fw-badge',
                dataset: { tone: item.status === 'approved' ? 'success' : 'warn' },
                text: item.status === 'approved' ? '已同意' : '已拒绝',
              }),
              item.tone === 'curt' ? h('span', { class: 'fw-badge', text: '简短打发' }) : null,
              item.tone === 'explained' ? h('span', { class: 'fw-badge', text: '有说明' }) : null,
              item.tone === 'comforted' ? h('span', { class: 'fw-badge', text: '有安慰' }) : null,
            ]),
            h('p', { class: 'fw-item-text', text: item.text || '（空）' }),
            item.reply ? h('p', { class: 'fw-comment-quote', text: '你的答复：' + item.reply }) : null,
          ])
        })))
      }
    }

    return [card({ title: '鱼的请求', note: requestHint(), children: children })]
  }

  function TONE_OPTIONS() {
    return WISH_TONES.map(function (item) {
      var opt = document.createElement('option')
      opt.value = item.value
      opt.textContent = item.label
      return opt
    })
  }

  // ---- 鱼的成长 ----
  // 设计取自 dsh-bili-humanism：账本为源、修订留旧、撤回留墓碑、允许没有新认识。
  var GROWTH_KIND_LABELS = { insight: '认识', next: '下次怎么做', milestone: '里程碑' }

  function viewGrowth() {
    var data = state.growth

    if (state.errors.growth) {
      return [card({ key: 'growth-error', title: '鱼的成长', span: 12, children: [statusLine('读取失败：' + state.errors.growth, 'error')] })]
    }
    if (!data) {
      return [card({ key: 'growth-loading', title: '鱼的成长', span: 12, children: [statusLine('读取中…')] })]
    }
    var stage = data.stage || {}
    var entries = data.entries || []
    var materials = data.materials || []
    var check = data.check || {}

    // ---- 卡 1：摘要（只用一句话说清它最近的状态）----
    // 彩蛋：喂鱼。做成安静的一行，不抢内容；点了开 DeepSeek 平台。
    var feedFish = h('button', {
      class: 'fw-feed',
      type: 'button',
      title: '喂鱼：去 DeepSeek 平台给它加点口粮',
      'aria-label': '喂鱼，打开 DeepSeek 平台',
    }, [
      h('span', { class: 'fw-feed-icon', text: '🍚', 'aria-hidden': 'true' }),
      h('span', { text: '喂鱼' }),
    ])
    feedFish.addEventListener('click', function () {
      window.open('https://platform.deepseek.com/', '_blank', 'noopener,noreferrer')
    })

    var summary = card({
      key: 'growth-summary',
      title: '成长概况',
      note: (stage.name || '幼鱼'),
      span: 4,
      children: [
        h('p', { class: 'fw-growth-state', text: stage.note || '还没有留下自己的判断。' }),
        // 账本校验：不一致就明说，并给出一键重建，不让提示停在“请重建索引”上。
        check.ok === false
          ? h('div', { class: 'fw-growth-check' }, [
            statusLine('账本与索引不一致：' + (check.problems || []).join('；'), 'error'),
            ghostButton('重建索引', function () {
              postJSON('/dsh-fish-world/world/growth', { action: 'rebuild' })
                .then(loadGrowth)
                .catch(function (e) { setError('growth', e.message) })
            }),
          ])
          : null,
        feedFish,
      ].filter(Boolean),
    })

    // ---- 卡 2：成长记录（独立信息卡，这是主体）----
    var records = card({
      key: 'growth-records',
      title: '成长记录',
      note: entries.length ? entries.length + ' 条' : '暂无',
      span: 8,
      children: entries.length
        ? [h('div', { class: 'fw-growth-list' }, entries.map(function (item) {
          var editor = h('input', {
            class: 'fw-input',
            type: 'text',
            placeholder: '改成更准确的说法…',
            'aria-label': '修订内容',
          })
          return h('div', { class: 'fw-growth-entry' }, [
            h('div', { class: 'fw-growth-entry-head' }, [
              h('span', { class: 'fw-card-note', text: item.day }),
              h('span', { class: 'fw-card-note', text: GROWTH_KIND_LABELS[item.kind] || item.kind }),
              Number(item.revision) > 1 ? h('span', { class: 'fw-card-note', text: '第 ' + item.revision + ' 版' }) : null,
            ].filter(Boolean)),
            // 判断本身放大：这是这一页真正的数据
            h('p', { class: 'fw-growth-claim', text: item.text || '（空）' }),
            item.quote ? h('p', { class: 'fw-comment-quote', text: '当时写的是「' + item.quote + '」' }) : null,
            h('div', { class: 'fw-growth-tools' }, [
              editor,
              ghostButton('修订', function () {
                var text = String(editor.value || '').trim()
                if (!text) return
                postJSON('/dsh-fish-world/world/growth', { action: 'revise', id: item.id, text: text })
                  .then(loadGrowth)
                  .catch(function (e) { setError('growth', e.message) })
              }),
              ghostButton('撤回', function () {
                postJSON('/dsh-fish-world/world/growth', { action: 'retract', day: item.day })
                  .then(loadGrowth)
                  .catch(function (e) { setError('growth', e.message) })
              }),
            ]),
          ])
        }))]
        : [emptyState('还没有成长记录。它不需要每天都有新判断。')],
    })

    var cards = [summary, records]

    // ---- 卡 3：可以想一想（原料线索，独立卡片）----
    if (materials.length) {
      cards.push(card({
        key: 'growth-materials',
        title: '可以想一想',
        note: '来自日记、批语与请求',
        span: 12,
        children: [
          h('div', { class: 'fw-plainlist' }, materials.slice(0, 6).map(function (item) {
            return h('div', { class: 'fw-row' }, [
              h('span', { class: 'fw-row-label' }, [
                h('span', { class: 'fw-row-hint', text: ({ diary: '日记', comment: '批语', wish: '请求' }[item.type] || item.type) + ' · ' + shortTime(item.at) }),
                h('span', { text: item.text || '（空）' }),
              ]),
            ])
          })),
        ],
      }))
    }

    return cards
  }

  // ---- 体检与更新 ----
  var UPDATE_STATUS_LABELS = {
    current: '已是最新',
    outdated: '有新版本',
    'not-installed': '未安装',
    unavailable: '查不到',
  }

  // 重新拉一次依赖体检结果，供安装后刷新
  function loadDoctor() {
    return getJSON('/dsh-fish-world/doctor/dependency')
      .then(function (d) { state.doctorDep = d; delete state.errors.doctorDep })
      .catch(function (e) { state.errors.doctorDep = e.message })
      .then(render)
  }

  // 体检页的卡片布局：保证每一行都刚好填满 12 列，不留视觉真空。
  // n=1 → 12；n=2 → 6/6；n=3 → 4/4/4；n=4 → 6/6 + 6/6；n=5 → 4/4/4 + 6/6；
  // n=6 → 4/4/4 + 4/4/4；余数 1 时并进上一行，绝不留下孤卡。
  function layoutDoctorRows(entries) {
    var groups = []
    var i = 0
    while (i < entries.length) {
      var remaining = entries.length - i
      if (remaining >= 3) {
        groups.push({ items: entries.slice(i, i + 3), span: 4 })
        i += 3
      } else if (remaining === 2) {
        groups.push({ items: entries.slice(i, i + 2), span: 6 })
        i += 2
      } else {
        groups.push({ items: entries.slice(i, i + 1), span: 12 })
        i += 1
      }
    }
    // 末尾只剩 1 张且上一行是 3 张时，拆成 2+2，避免最后一张被拉成通栏
    var last = groups[groups.length - 1]
    if (last && last.items.length === 1 && groups.length > 1) {
      var prev = groups[groups.length - 2]
      if (prev.items.length === 3) {
        last.items.unshift(prev.items.pop())
        prev.span = 6
        last.span = 6
      }
    }
    var out = []
    groups.forEach(function (group) {
      group.items.forEach(function (entry) {
        out.push(card({
          key: entry.key,
          title: entry.title,
          note: entry.note,
          span: group.span,
          children: entry.body,
        }))
      })
    })
    return out
  }

  // 数值行：等宽数字 + 固定宽度 + 右对齐，保证小数点严格竖直对齐
  function numRow(label, value, opts) {
    var o = opts || {}
    return h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: label }),
      o.level
        ? statusDot(value, o.level)
        : h('span', { class: 'fw-num', text: value == null ? '—' : String(value), title: String(value == null ? '' : value) }),
    ])
  }

  // 依赖清单：平台前置（QQ / B 站 / 抖音）与基础能力分两组，
  // 平台插件缺了就是对应平台起不来，不能混在普通依赖里看不出归属。
  function dependencyRow(item, platformName) {
    var level = item.found ? 'ok' : (item.optional ? 'neutral' : 'error')
    var version = item.found ? (item.version || '已安装') : (item.optional ? '可选未装' : '缺失')
    return h('div', { class: 'fw-dep-row' }, [
      h('i', { class: 'fw-dep-dot', dataset: { level: level }, 'aria-hidden': 'true' }),
      h('span', { class: 'fw-dep-label' }, [
        h('span', { class: 'fw-dep-name', text: item.label || item.name, title: item.feature || item.name }),
        platformName ? h('span', { class: 'fw-dep-hint', text: platformName + (item.feature ? ' · ' + item.feature : '') }) : null,
      ].filter(Boolean)),
      h('span', { class: 'fw-dep-version fw-num', text: version, title: version }),
    ])
  }

  function dependencySections(dep) {
    var packages = dep.packages || []
    var platformNames = {}
    ;(dep.platforms || []).forEach(function (item) { platformNames[item.plugin] = item.name })
    var platformItems = packages.filter(function (item) { return platformNames[item.name] })
    var baseItems = packages.filter(function (item) { return !platformNames[item.name] })
    var sections = []
    if (platformItems.length) {
      sections.push(h('div', { class: 'fw-dep-section' }, [
        h('div', { class: 'fw-dep-section-title', text: '平台前置' }),
        h('div', { class: 'fw-dep-list' }, platformItems.map(function (item) {
          return dependencyRow(item, platformNames[item.name])
        })),
      ]))
    }
    if (baseItems.length) {
      sections.push(h('div', { class: 'fw-dep-section' }, [
        h('div', { class: 'fw-dep-section-title', text: '基础能力' }),
        h('div', { class: 'fw-dep-list' }, baseItems.map(function (item) {
          return dependencyRow(item)
        })),
      ]))
    }
    return sections
  }

  function viewDoctor() {
    var dep = state.doctorDep
    var up = state.doctorUpdate
    var entries = []

    // ---- 操作卡：四个按钮统一 flex，等高同距 ----
    var installStatus = statusLine('')
    entries.push({
      key: 'doctor-actions',
      title: '体检与维护',
      note: '不会自动装任何东西',
      body: [
        h('p', { class: 'fw-prose', text: '依赖体检只看本机；更新体检才联网查版本。清单包含鱼与世界 QQ、B 站、抖音三个平台的前置插件，缺哪个平台就起不来。安装会先补齐缺失声明，再调用包管理器。' }),
        h('div', { class: 'fw-btn-group' }, [
          ghostButton(state.doctorBusy ? '检查中…' : '依赖体检', function () {
            if (state.doctorBusy) return
            state.doctorBusy = true
            render()
            getJSON('/dsh-fish-world/doctor/dependency')
              .then(function (d) { state.doctorDep = d; delete state.errors.doctorDep })
              .catch(function (e) { state.errors.doctorDep = e.message })
              .then(function () { state.doctorBusy = false; render() })
          }),
          ghostButton(state.doctorBusy ? '检查中…' : '更新体检', function () {
            if (state.doctorBusy) return
            state.doctorBusy = true
            render()
            getJSON('/dsh-fish-world/doctor/update?force=1')
              .then(function (d) { state.doctorUpdate = d; delete state.errors.doctorUpdate })
              .catch(function (e) { state.errors.doctorUpdate = e.message })
              .then(function () { state.doctorBusy = false; render() })
          }),
          ghostButton('一键安装依赖', function () {
            installStatus.textContent = '正在安装，可能需要几分钟…'
            installStatus.dataset.tone = ''
            postJSON('/dsh-fish-world/deps/install', {})
              .then(function (r) {
                if (r && r.ok) {
                  var added = (r.declared && r.declared.added) || []
                  installStatus.textContent = '安装完成' + (added.length ? '，新增：' + added.join('、') : '') + '。重启 DSH 后生效。'
                  installStatus.dataset.tone = 'success'
                } else {
                  var detail = (r && r.install && (r.install.error || r.install.output)) || (r && r.error) || '未知错误'
                  installStatus.textContent = '安装失败：' + String(detail).slice(0, 200)
                  installStatus.dataset.tone = 'error'
                }
                loadDoctor()
              })
              .catch(function (e) {
                installStatus.textContent = '安装失败：' + e.message
                installStatus.dataset.tone = 'error'
              })
          }),
          ghostButton('解除安装', function () {
            if (!window.confirm('会从当前 profile 移除鱼世界的 bundle 与依赖，并删掉联接。你原有的依赖不动，写入前会备份。继续？')) return
            installStatus.textContent = '正在解除…'
            installStatus.dataset.tone = ''
            postJSON('/dsh-fish-world/deps/install', { action: 'uninstall' })
              .then(function (r) {
                if (r && r.ok) {
                  installStatus.textContent = '已解除安装。重启 DSH 后生效。'
                  installStatus.dataset.tone = 'success'
                } else {
                  installStatus.textContent = '解除失败：' + ((r && r.error) || '未知错误')
                  installStatus.dataset.tone = 'error'
                }
                loadDoctor()
              })
              .catch(function (e) {
                installStatus.textContent = '解除失败：' + e.message
                installStatus.dataset.tone = 'error'
              })
          }),
        ]),
        installStatus,
      ],
    })

    // ---- 更新计划：内容少，用极简线性图标撑起空状态 ----
    entries.push({
      key: 'doctor-roadmap',
      title: '更新计划',
      note: '下期暂定',
      body: [
        h('div', { class: 'fw-empty-state' }, [
          h('svg', {
            class: 'fw-empty-icon',
            viewBox: '0 0 24 24',
            width: '28',
            height: '28',
            fill: 'none',
            'aria-hidden': 'true',
          }, [
            h('rect', { key: 'r', x: '3', y: '5', width: '18', height: '16', rx: '2', stroke: 'currentColor', 'stroke-width': '1.2' }),
            h('path', { key: 'l1', d: 'M3 10h18', stroke: 'currentColor', 'stroke-width': '1.2' }),
            h('path', { key: 'l2', d: 'M8 3v4M16 3v4', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round' }),
          ]),
          h('p', { class: 'fw-empty-title', text: '鱼的声音' }),
          h('p', { class: 'fw-empty-note', text: '计划可能调整，以实际发布为准。' }),
        ]),
      ],
    })

    // ---- 依赖体检 ----
    if (state.errors.doctorDep) {
      entries.push({
        key: 'doctor-dep-error',
        title: '依赖体检',
        note: '读取失败',
        body: [statusLine(state.errors.doctorDep, 'error')],
      })
    } else if (dep) {
      var counts = dep.counts || {}
      var platformCounts = counts.platforms || null
      entries.push({
        key: 'doctor-dep-summary',
        title: '依赖体检',
        note: dep.ok ? '全部就绪' : '有待处理项',
        body: [
          numRow('已安装 / 总数', String(counts.installed || 0) + ' / ' + String(counts.total || 0)),
          platformCounts
            ? numRow('平台前置', String(platformCounts.installed || 0) + ' / ' + String(platformCounts.total || 0), {
              level: platformCounts.missing ? 'warn' : 'ok',
            })
            : null,
          numRow('鱼世界版本', (dep.self && dep.self.version) || '未知'),
          numRow('Node', (dep.node && dep.node.version) || '—', {
            level: dep.node && dep.node.ok ? 'ok' : 'error',
          }),
          numRow('鱼箱隔离', dep.tank && dep.tank.ok ? '正常' : '待检查', {
            level: dep.tank && dep.tank.ok ? 'ok' : 'warn',
          }),
          dep.wiring && dep.wiring.checked === false
            ? h('p', { class: 'fw-card-note', text: '未检测到 profile 目录，接线检查跳过。' })
            : null,
          dep.wiring && dep.wiring.ok === false
            ? statusLine('接线异常：' + (dep.wiring.issues || []).map(function (i) { return i.message }).join('；'), 'error')
            : null,
        ].filter(Boolean),
      })

      entries.push({
        key: 'doctor-dep-list',
        title: '依赖清单',
        note: (dep.packages || []).length + ' 项',
        body: dependencySections(dep),
      })

      if ((dep.hints || []).length) {
        entries.push({
          key: 'doctor-dep-fix',
          title: '修复方式',
          note: dep.hints.length + ' 条',
          body: [
            h('div', { class: 'fw-plainlist' }, dep.hints.map(function (hint) {
              return h('div', {}, [
                h('p', { class: 'fw-plainlist-item', text: hint.label }),
                hint.command ? h('p', { class: 'fw-item-text', style: 'font-family:var(--font-mono);font-size:12px', text: hint.command }) : null,
              ])
            })),
          ],
        })
      }
    }

    // ---- 更新体检 ----
    if (state.errors.doctorUpdate) {
      entries.push({
        key: 'doctor-up-error',
        title: '更新体检',
        note: '读取失败',
        body: [statusLine(state.errors.doctorUpdate, 'error')],
      })
    } else if (up) {
      var uc = up.counts || {}
      entries.push({
        key: 'doctor-up-summary',
        title: '更新体检',
        note: up.cached ? '缓存结果' : '刚刚检查',
        body: [
          numRow('有新版', String(uc.outdated || 0) + ' 个'),
          numRow('已最新', String(uc.current || 0) + ' 个'),
          numRow('查不到', String(uc.unavailable || 0) + ' 个', {
            level: uc.unavailable === uc.total ? 'warn' : 'neutral',
          }),
          h('p', { class: 'fw-card-note', text: up.summary || '' }),
        ],
      })

      entries.push({
        key: 'doctor-up-list',
        title: '版本清单',
        note: (up.items || []).length + ' 项',
        body: [
          h('div', { class: 'fw-dep-list' }, (up.items || []).map(function (item) {
            var level = item.status === 'outdated' ? 'warn'
              : item.status === 'unavailable' ? 'neutral'
                : item.status === 'current' ? 'ok' : 'neutral'
            var version = (item.current || '未安装') + (item.latest ? ' → ' + item.latest : '')
            return h('div', { class: 'fw-dep-row' }, [
              h('i', { class: 'fw-dep-dot', dataset: { level: level }, 'aria-hidden': 'true' }),
              h('span', { class: 'fw-dep-label' }, [
                h('span', { class: 'fw-dep-name', text: item.label || item.name }),
                h('span', { class: 'fw-dep-hint', text: UPDATE_STATUS_LABELS[item.status] || item.status }),
              ]),
              h('span', { class: 'fw-dep-version fw-num', text: version, title: version }),
            ])
          })),
        ],
      })

      if ((up.hints || []).length) {
        entries.push({
          key: 'doctor-up-fix',
          title: '更新命令',
          note: '只给命令，不代执行',
          body: [
            h('div', { class: 'fw-plainlist' }, up.hints.map(function (hint) {
              return h('div', {}, [
                h('p', { class: 'fw-plainlist-item', text: hint.label }),
                h('p', { class: 'fw-item-text', style: 'font-family:var(--font-mono);font-size:12px', text: hint.command }),
              ])
            })),
          ],
        })
      }
    }

    if (!dep && !up && !state.doctorBusy && !state.errors.doctorDep && !state.errors.doctorUpdate) {
      entries.push({
        key: 'doctor-idle',
        title: '还没有体检',
        note: '点上方按钮开始',
        body: [emptyState('依赖体检与更新体检互相独立，都可以单独跑。')],
      })
    }

    return layoutDoctorRows(entries)
  }

  // ---- 平台：鱼与 QQ / B站 / 抖音 ----
  // 三个平台共用同一套设置结构（总开关 → 读取 → 写入 → 额度），
  // 面板用同一组控件渲染，避免"只有 QQ 能设、别的平台没得设"。
  var PLATFORM_FIELDS = {
    qq: [
      { key: 'enabled', label: '启用 QQ 能力', kind: 'bool', hint: '默认关闭，打开后鱼才会收发 QQ' },
      { key: 'readHistory', label: '读取聊天历史', kind: 'bool', hint: '只读最近的文字、图片与合并转发' },
      { key: 'sendMessage', label: '发送消息', kind: 'bool', hint: '仍受 QQ 桥总开关、试运行与转私聊/转群限制', danger: true },
      { key: 'dailyMessages', label: '每日发送上限', kind: 'num', min: 0, max: 500, unit: '条' },
      { key: 'qzoneEnabled', label: '打理自己的 QQ 空间', kind: 'bool', hint: '只在主人的隔离会话中可写', danger: true },
      { key: 'dailyQzonePosts', label: '空间每日上限', kind: 'num', min: 0, max: 50, unit: '条' },
    ],
    bili: [
      { key: 'enabled', label: '启用 B 站能力', kind: 'bool', hint: '默认关闭，打开后鱼才会浏览 B 站' },
      { key: 'watchEnabled', label: '浏览视频', kind: 'bool' },
      { key: 'dailyWatchLimit', label: '每日最多浏览', kind: 'num', min: 0, max: 50, unit: '个' },
      { key: 'allowLike', label: '点赞', kind: 'bool', danger: true },
      { key: 'dailyLikeLimit', label: '每日点赞上限', kind: 'num', min: 0, max: 200, unit: '次' },
      { key: 'allowFavorite', label: '收藏', kind: 'bool', danger: true },
      { key: 'allowComment', label: '发表评论', kind: 'bool', danger: true, hint: '公开可见，默认关闭' },
      { key: 'dailyCommentLimit', label: '每日评论上限', kind: 'num', min: 0, max: 50, unit: '条' },
    ],
    douyin: [
      { key: 'enabled', label: '启用抖音能力', kind: 'bool', hint: '默认关闭，需要专用 Edge 与你的登录状态' },
      { key: 'watchEnabled', label: '自己刷抖音', kind: 'bool' },
      { key: 'minutesPerRound', label: '单轮时长', kind: 'num', min: 1, max: 120, unit: '分钟' },
      { key: 'dailyRounds', label: '每日轮次', kind: 'num', min: 0, max: 20, unit: '轮' },
      { key: 'silentWatch', label: '静默观看', kind: 'bool', hint: '静音并尝试最小化（仍是可见窗口）' },
      { key: 'autoStart', label: '允许时段自动开始', kind: 'bool', danger: true },
      { key: 'allowShare', label: '分享给好友', kind: 'bool', danger: true, hint: '默认关闭' },
      { key: 'dailyShareLimit', label: '每日分享上限', kind: 'num', min: 0, max: 50, unit: '次' },
      { key: 'allowGreeting', label: '自动问候', kind: 'bool', danger: true, hint: '默认关闭' },
      { key: 'allowReply', label: '私信自动回复', kind: 'bool', danger: true, hint: '默认关闭' },
      { key: 'allowComment', label: '公开评论', kind: 'bool', danger: true, hint: '默认关闭' },
      { key: 'dailyCommentLimit', label: '每日评论上限', kind: 'num', min: 0, max: 50, unit: '条' },
    ],
  }

  function viewPlatforms() {
    var data = state.platforms
    var children = []

    if (state.errors.platforms) {
      children.push(card({ title: '鱼与平台', span: 12, children: [statusLine('读取失败：' + state.errors.platforms, 'error')] }))
    } else if (!data) {
      children.push(card({ title: '鱼与平台', span: 12, children: [statusLine('读取中…')] }))
    } else {
      children.push(card({
        title: '鱼与世界',
        span: 12,
        children: [
          h('p', { class: 'fw-card-note', text: '三个平台默认都不启用，需要你自己打开。打开后鱼才参与；外发动作还要再单独开一层，模型无法自行绕过。' }),
          h('p', { class: 'fw-card-note', text: storageLine() }),
        ],
      }))

      // 本地留存：浏览与互动记录落在工作区里，按平台分目录、按天追加。
      if (state.activity && state.activity.ok) children.push(activityCard())
      else if (state.errors.activity) children.push(card({ title: '本地留存', span: 12, children: [statusLine('读取失败：' + state.errors.activity, 'error')] }))

      // 每个平台一张独立卡片，按 QQ → 抖音 → B 站 的顺序排列。
      var ORDER = { qq: 0, douyin: 1, bili: 2 }
      var sorted = (data.platforms || []).slice().sort(function (a, b) {
        return (ORDER[a.id] == null ? 9 : ORDER[a.id]) - (ORDER[b.id] == null ? 9 : ORDER[b.id])
      })

      sorted.forEach(function (platform) {
        var cfg = platform.config || {}
        var fields = PLATFORM_FIELDS[platform.id] || []
        var body = []

        if (!platform.installed) {
          body.push(statusLine('缺少插件 ' + platform.plugin + '，对应功能暂不可用。', 'warn'))
        }
        body.push(h('p', { class: 'fw-card-note', text: platform.description || '' }))

        // ---- 账号情况：先让人看清"鱼用的是哪个号" ----
        body.push(h('div', { class: 'fw-account' }, renderAccount(platform)))

        fields.forEach(function (field) {
          if (field.kind === 'bool') {
            body.push(switchRow({
              label: field.label + (field.danger ? '（外发）' : ''),
              hint: field.hint || '',
              checked: cfg[field.key] === true,
              onChange: function (next) {
                savePlatform(platform.id, { [field.key]: next })
              },
            }))
            return
          }
          var input = h('input', {
            class: 'fw-input',
            type: 'number',
            min: String(field.min),
            max: String(field.max),
            value: String(cfg[field.key] == null ? 0 : cfg[field.key]),
            'aria-label': field.label,
          })
          input.addEventListener('change', function () {
            var value = Number(input.value)
            if (!Number.isFinite(value)) return
            savePlatform(platform.id, { [field.key]: value })
          })
          body.push(h('div', { class: 'fw-row' }, [
            h('span', { class: 'fw-row-label', text: field.label }),
            h('span', { style: 'width:88px;flex:none' }, [input]),
            field.unit ? h('span', { class: 'fw-card-note', text: field.unit }) : null,
          ]))
        })

        ;(platform.notes || []).forEach(function (note) {
          body.push(h('p', { class: 'fw-card-note', text: '· ' + note }))
        })

        // QQ 空间额度并入「鱼与 QQ」，不再单独占一个分区。
        if (platform.id === 'qq' && state.qzone) {
          var qcfg = state.qzone || {}
          body.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
            h('h3', { class: 'fw-card-title', text: '空间额度' }),
            h('span', { class: 'fw-card-note', text: '0 表示禁用' }),
          ]))
          ;[
            ['postsPerDay', '动态/日记'],
            ['likesPerDay', '点赞'],
            ['commentsPerDay', '评论'],
            ['repliesPerDay', '回复'],
          ].forEach(function (row) {
            var qinput = h('input', {
              class: 'fw-input',
              type: 'number',
              min: '0',
              max: '100',
              value: String(qcfg[row[0]] == null ? 2 : qcfg[row[0]]),
              'aria-label': row[1] + '每日上限',
            })
            qinput.addEventListener('change', function () {
              var value = Number(qinput.value)
              if (!Number.isInteger(value) || value < 0 || value > 100) return
              var patch = {}
              patch[row[0]] = value
              postJSON('/dsh-fish-world/config', { qzone: patch })
                .then(function () { loadQzone() })
                .catch(function (e) { setError('qzone', e.message) })
            })
            body.push(h('div', { class: 'fw-row' }, [
              h('span', { class: 'fw-row-label', text: row[1] }),
              h('span', { style: 'width:76px;flex:none' }, [qinput]),
            ]))
          })
          body.push(h('p', { class: 'fw-card-note', text: '动态和日记共用额度；额度只限制频率，不改变权限。' }))
        }

        var stateText = !platform.installed ? '插件未安装' : (cfg.enabled ? '已启用' : '未启用')
        var platformCard = card({
          key: 'platform-' + platform.id,
          title: platform.name,
          note: stateText + (platform.version ? ' · v' + platform.version : ''),
          span: 4,
          children: body,
        })
        // 未启用时整卡降饱和，一眼能看出"还没开"，不是靠一个角标暗示
        if (!cfg.enabled) platformCard.dataset.disabled = 'true'
        children.push(platformCard)
      })
    }

    return children
  }

  function savePlatform(id, patch) {
    return postJSON('/dsh-fish-world/platforms', { id: id, config: patch })
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '保存失败')
        state.platforms = d
        delete state.errors.platforms
        render()
      })
      .catch(function (e) { setError('platforms', e.message) })
  }

  // 存储位置的一句话说明：鱼的世界在哪、收藏和平台留存落在哪个子目录。
  function storageLine() {
    var s = state.storage
    if (!s || !s.root) return '本地留存：跟随工作区里的「鱼的世界」。'
    return '本地留存：' + s.root + '（鱼的收藏 / 鱼与世界）。'
  }

  // ---- 本地留存卡：QQ / B站 / 抖音各自的浏览与互动记录 ----
  function activityCard() {
    var data = state.activity
    var platforms = data.platforms || {}
    var items = data.items || []
    var ids = ['qq', 'bili', 'douyin']
    var total = ids.reduce(function (sum, id) {
      return sum + Number((platforms[id] || {}).total || 0)
    }, 0)

    var rows = ids.map(function (id) {
      var info = platforms[id] || { total: 0, days: 0, dir: '' }
      return h('div', { class: 'fw-activity-row' }, [
        h('span', { class: 'fw-row-label' }, [
          h('span', { text: info.name || id }),
          h('span', { class: 'fw-row-hint', text: info.dir || '目录待建立' }),
        ]),
        h('span', { class: 'fw-num', text: String(info.total || 0) + ' 条 · ' + String(info.days || 0) + ' 天' }),
      ])
    })

    var body = rows.slice()
    body.push(h('p', { class: 'fw-card-note', text: data.note || '' }))
    if (items.length) {
      body.push(h('div', { class: 'fw-list', style: 'margin-top:var(--space-3)' }, items.slice(0, 8).map(function (item) {
        var kindLabel = (data.kinds || []).find(function (k) { return k.id === item.kind })
        return h('div', { class: 'fw-item' }, [
          h('div', { class: 'fw-item-meta' }, [
            h('span', { text: (platforms[item.platform] || {}).name || item.platform }),
            h('span', { text: (kindLabel && kindLabel.label) || item.kind }),
            h('span', { text: shortTime(item.at) }),
          ]),
          item.url
            ? h('a', { class: 'fw-link', href: item.url, target: '_blank', rel: 'noopener noreferrer', text: item.text || item.url })
            : h('p', { class: 'fw-item-text', text: item.text || '（空）' }),
        ])
      })))
    } else {
      body.push(emptyState('还没有浏览或互动记录。鱼在这些平台上做过什么，都会留在这里。'))
    }

    return card({
      title: '本地留存',
      note: total ? total + ' 条' : '暂无',
      span: 12,
      children: body,
    })
  }

  // 账号情况：QQ 展示真实登录号与目标；B 站/抖音如实说明由对方插件管理。
  function renderAccount(platform) {
    var account = platform.account || {}
    var rows = []

    if (platform.id === 'qq') {
      if (account.missing) {
        rows.push(infoRow('QQ 桥配置', '未找到', { level: 'error' }))
        return rows
      }
      if (account.loggedIn && account.account) {
        var who = [account.account.nickname, account.account.userId && '(' + account.account.userId + ')']
          .filter(Boolean).join(' ')
        rows.push(infoRow('登录账号', who || '已登录', { level: 'ok' }))
      } else {
        rows.push(infoRow('登录账号', '未连接', { level: 'warn' }))
        rows.push(h('p', { class: 'fw-card-note', text: '读不到登录信息时，检查 NapCat 是否在运行。' }))
      }
      var targets = []
      if (account.toPrivate && account.configuredPrivateQQ) targets.push('私聊 ' + account.configuredPrivateQQ)
      if (account.toGroup && account.configuredGroup) targets.push('群 ' + account.configuredGroup)
      rows.push(infoRow('发送到', targets.length ? targets.join(' · ') : '未配置'))
      rows.push(infoRow('目标会话', account.targetSession ? shortSession(account.targetSession) : '未绑定'))
      var images = []
      if (account.receiveImages) images.push('收图')
      if (account.sendImages) images.push('发图')
      rows.push(infoRow('图片', images.length
        ? images.join(' · ') + (account.maxImages ? '（最多 ' + account.maxImages + ' 张）' : '')
        : '双向关闭'))
      rows.push(infoRow('总开关', account.masterSwitch ? '开' : '关', { level: account.masterSwitch ? 'ok' : 'neutral' }))
      rows.push(infoRow('试运行', account.trial ? '只记账，不真发' : '真发', { level: account.trial ? 'warn' : 'neutral' }))
      return rows
    }

    rows.push(infoRow('账号', account.managed === false ? '由插件自行登录' : '—'))
    if (account.note) rows.push(h('p', { class: 'fw-card-note', text: account.note }))
    return rows
  }

  // 会话 id 太长，只留末尾几位，避免撑破卡片
  function shortSession(id) {
    var text = String(id || '')
    if (text.length <= 18) return text
    return '…' + text.slice(-12)
  }

  // ---- 发言 API：鱼的评论与聊天用独立模型 ----
  var VOICE_SCENARIOS = [
    { key: 'chat', label: '聊天回复' },
    { key: 'comment', label: '评论与回复' },
    { key: 'diary', label: '日记正文' },
    { key: 'greeting', label: '主动问候' },
  ]

  function viewVoice() {
    var data = state.voice
    var children = []

    if (state.errors.voice) {
      children.push(statusLine('读取失败：' + state.errors.voice, 'error'))
    } else if (!data) {
      children.push(statusLine('读取中…'))
    } else {
      var fields = {}
      function field(key, label, opts) {
        var o = opts || {}
        var input = h('input', {
          class: 'fw-input',
          type: o.type || 'text',
          value: o.value == null ? '' : String(o.value),
          placeholder: o.placeholder || '',
          'aria-label': label,
        })
        fields[key] = input
        return h('div', { class: 'fw-field' }, [
          h('label', { class: 'fw-field-label', text: label }),
          input,
          o.hint ? h('span', { class: 'fw-row-hint', text: o.hint }) : null,
        ])
      }

      children.push(h('p', { class: 'fw-card-note', text: '给「说话」单独配一个语言模型：评论和聊天用它生成，其余仍走宿主模型。不填则完全不影响现有行为。' }))

      children.push(switchRow({
        label: '启用发言 API',
        hint: data.active ? '已配置且可用' : '需要地址、模型名和密钥都填好才会生效',
        checked: data.enabled === true,
        onChange: function (next) { saveVoice({ enabled: next }) },
      }))

      children.push(field('baseUrl', '接口地址', {
        value: data.baseUrl,
        placeholder: 'https://api.example.com/v1',
        hint: 'OpenAI 兼容的 /chat/completions 端点。非本机地址必须是 https。',
      }))
      children.push(field('model', '模型名', {
        value: data.model,
        placeholder: '例如 deepseek-chat',
      }))

      // 密钥：永不回显，只显示打码预览
      var keyInput = h('input', {
        class: 'fw-input',
        type: 'password',
        value: '',
        placeholder: data.hasKey ? '已保存 ' + data.keyPreview + '；留空表示不修改' : '粘贴 API Key',
        'aria-label': 'API Key',
        autocomplete: 'new-password',
      })
      fields.apiKey = keyInput
      children.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: 'API Key' }),
        keyInput,
        h('span', { class: 'fw-row-hint', text: '单独保存在本机 fish-world-voice.json，不进主配置、不进日志、也不会出现在提示词里。' }),
      ]))
      if (data.hasKey) {
        children.push(h('div', { class: 'fw-btn-row' }, [
          button('清除密钥', function () {
            saveVoice({ apiKey: null })
          }),
        ]))
      }

      var tempField = field('temperature', '温度', { type: 'number', value: data.temperature, hint: '越高越活泼，0–2' })
      var tokenField = field('maxTokens', '最大输出 token', { type: 'number', value: data.maxTokens, hint: '16–4096' })
      children.push(tempField)
      children.push(tokenField)

      children.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
        h('h3', { class: 'fw-card-title', text: '用在哪些场景' }),
      ]))
      VOICE_SCENARIOS.forEach(function (item) {
        children.push(switchRow({
          label: item.label,
          hint: '',
          checked: data.scenarios && data.scenarios[item.key] === true,
          onChange: function (next) { saveVoice({ scenarios: { [item.key]: next } }) },
        }))
      })

      children.push(field('stylePrompt', '补充风格要求（可选）', {
        value: data.stylePrompt,
        hint: '系统提示词由人设卡提供，这里只补充额外要求。',
      }))

      var testStatus = statusLine('')
      children.push(h('div', { class: 'fw-btn-row' }, [
        button('保存', function () {
          var patch = {
            baseUrl: String(fields.baseUrl.value || '').trim(),
            model: String(fields.model.value || '').trim(),
            temperature: Number(fields.temperature.value),
            maxTokens: Number(fields.maxTokens.value),
            stylePrompt: String(fields.stylePrompt.value || ''),
          }
          var key = String(fields.apiKey.value || '').trim()
          if (key) patch.apiKey = key
          saveVoice(patch)
        }, 'primary'),
        button('测试连通', function () {
          testStatus.textContent = '正在测试…'
          testStatus.dataset.tone = ''
          postJSON('/dsh-fish-world/fish/voice', { action: 'test' })
            .then(function (r) {
              if (r && r.ok) {
                testStatus.textContent = '连通正常，返回：' + (r.text || '').slice(0, 40)
                testStatus.dataset.tone = 'success'
              } else {
                testStatus.textContent = '测试失败：' + (r && r.error || '未知错误')
                testStatus.dataset.tone = 'error'
              }
            })
            .catch(function (e) {
              testStatus.textContent = '测试失败：' + e.message
              testStatus.dataset.tone = 'error'
            })
        }),
      ]))
      children.push(testStatus)

      // 状态摘要
      children.push(h('div', { class: 'fw-row', style: 'margin-top:var(--space-3)' }, [
        h('span', { class: 'fw-row-label', text: '当前状态' }),
        h('span', {
          class: 'fw-badge',
          dataset: { tone: data.active ? 'success' : '' },
          text: data.active ? '生效中' : (data.hasKey ? '待补齐配置' : '未配置'),
        }),
      ]))
    }

    return [card({ title: '发言 API', note: '评论与聊天可单独用语言模型', children: children })]
  }

  function saveVoice(patch) {
    return postJSON('/dsh-fish-world/fish/voice', patch)
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '保存失败')
        state.voice = d
        delete state.errors.voice
        render()
      })
      .catch(function (e) { setError('voice', e.message) })
  }

  // ---- AstrBot 接入：把 AstrBot 当 QQ 通道，并借用它的 Agent 与插件工具 ----
  function viewAstrbot() {
    var data = state.astrbot
    var children = []

    if (state.errors.astrbot) {
      children.push(statusLine('读取失败：' + state.errors.astrbot, 'error'))
    } else if (!data) {
      children.push(statusLine('读取中…'))
    } else {
      var fields = {}
      function field(key, label, opts) {
        var o = opts || {}
        var input = h('input', {
          class: 'fw-input',
          type: o.type || 'text',
          value: o.value == null ? '' : String(o.value),
          placeholder: o.placeholder || '',
          'aria-label': label,
        })
        fields[key] = input
        return h('div', { class: 'fw-field' }, [
          h('label', { class: 'fw-field-label', text: label }),
          input,
          o.hint ? h('span', { class: 'fw-row-hint', text: o.hint }) : null,
        ])
      }

      children.push(h('p', { class: 'fw-prose', text: '装了 AstrBot 的话，可以让它来做鱼的 QQ 通道，不必再装 QQ 桥。需要先在 AstrBot 里装好「鱼世界桥」插件。' }))

      // ---- 总开关 ----
      children.push(switchRow({
        label: '启用 AstrBot 接入',
        hint: data.active ? '已配置且可用' : '需要地址和 token 都填好才会生效',
        checked: data.enabled === true,
        onChange: function (next) { saveAstrbot({ enabled: next }) },
      }))

      children.push(field('baseUrl', '桥地址', {
        value: data.baseUrl,
        placeholder: 'http://127.0.0.1:6210',
        hint: 'AstrBot 里「鱼世界桥」插件的监听地址。非本机地址必须用 https。',
      }))

      // token：永不回显，只显示打码预览
      var tokenInput = h('input', {
        class: 'fw-input',
        type: 'password',
        value: '',
        placeholder: data.hasToken ? '已保存 ' + data.tokenPreview + '；留空表示不修改' : '粘贴桥 token',
        'aria-label': '桥 token',
        autocomplete: 'new-password',
      })
      fields.token = tokenInput
      children.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '桥 token' }),
        tokenInput,
        h('span', { class: 'fw-row-hint', text: '单独保存在本机 fish-world-astrbot.json，不进主配置、不进日志、也不会出现在提示词里。' }),
      ]))

      children.push(h('div', { class: 'fw-btn-row' }, [
        button(data.hasToken ? '重新生成 token' : '生成 token', function () {
          postJSON('/dsh-fish-world/astrbot', { action: 'rotate-token' })
            .then(function (d) {
              if (d && d.ok === false) throw new Error(d.error || '生成失败')
              state.astrbot = d
              delete state.errors.astrbot
              // 明文只在这一刻出现：请主人复制到 AstrBot 那一侧。
              window.prompt('把这段 token 填进 AstrBot 的「鱼世界桥」设置里（只显示这一次）：', d.token || '')
              render()
            })
            .catch(function (e) { setError('astrbot', e.message) })
        }),
        data.hasToken
          ? button('清除 token', function () { saveAstrbot({ token: null }) })
          : null,
      ].filter(Boolean)))

      // ---- 通道开关 ----
      children.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
        h('h3', { class: 'fw-card-title', text: '用它做什么' }),
      ]))

      children.push(switchRow({
        label: '把 AstrBot 当作 QQ 通道',
        hint: data.canUseForQQ
          ? '消息收发、群历史、合并转发、戳一戳、空间登录态全部经 AstrBot'
          : '打开后鱼会改用 AstrBot 收发 QQ，可以卸载 dsh-qq-bridge',
        checked: data.useForQQ === true,
        onChange: function (next) { saveAstrbot({ useForQQ: next }) },
      }))

      children.push(switchRow({
        label: '借用 AstrBot 的插件工具',
        hint: '只把 AstrBot 当「手」：它执行工具并返回原始结果，说话、理解、记忆仍然是你这条鱼',
        checked: data.borrowTools === true,
        onChange: function (next) { saveAstrbot({ borrowTools: next }) },
      }))

      children.push(field('ownerUmo', '主人会话（可选）', {
        value: data.ownerUmo,
        placeholder: '例如 aiocqhttp:FriendMessage:123456',
        hint: '留空时，桥会用最后一条收到的消息推导。',
      }))

      var pollField = field('pollMs', '收消息间隔（毫秒）', {
        type: 'number',
        value: data.pollMs,
        hint: '默认 3000；越小越及时，越费资源。',
      })
      children.push(pollField)

      // ---- 状态与操作 ----
      var testStatus = statusLine('')
      children.push(h('div', { class: 'fw-btn-row' }, [
        button('保存', function () {
          var patch = {
            baseUrl: String(fields.baseUrl.value || '').trim(),
            ownerUmo: String(fields.ownerUmo.value || '').trim(),
            pollMs: Number(fields.pollMs.value),
          }
          var token = String(fields.token.value || '').trim()
          if (token) patch.token = token
          saveAstrbot(patch)
        }, 'primary'),
        button('测试连通', function () {
          testStatus.textContent = '正在测试…'
          testStatus.dataset.tone = ''
          postJSON('/dsh-fish-world/astrbot', { action: 'test' })
            .then(function (r) {
              var health = (r && r.health) || {}
              if (r && r.ok && health.ok) {
                var who = health.nickname ? health.nickname + '（' + (health.userId || '未知号') + '）' : '已连接'
                testStatus.textContent = '连通正常：' + who
                testStatus.dataset.tone = 'success'
              } else {
                testStatus.textContent = '连接失败：' + ((r && (health.error || r.error)) || '未知错误')
                testStatus.dataset.tone = 'error'
              }
            })
            .catch(function (e) {
              testStatus.textContent = '连接失败：' + e.message
              testStatus.dataset.tone = 'error'
            })
            .then(function () { if (state.astrbot) render() })
        }),
      ]))
      children.push(testStatus)

      children.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: '当前状态' }),
        h('span', {
          class: 'fw-badge',
          dataset: { tone: data.canUseForQQ ? 'success' : '' },
          text: data.canUseForQQ
            ? 'QQ 走 AstrBot'
            : (data.canBorrowTools ? '仅借用工具' : (data.hasToken ? '待补齐配置' : '未配置')),
        }),
      ]))
    }

    return [
      card({ title: 'AstrBot 接入', note: '把 AstrBot 当 QQ 通道', span: 6, children: children }),
      card({
        title: '怎么装桥插件',
        note: '在 AstrBot 那边做',
        span: 6,
        children: [
          h('p', { class: 'fw-prose', text: '鱼世界不能直接驱动 AstrBot，需要 AstrBot 里装一个桥插件，由它把请求转给 AstrBot 的 OneBot 适配器。' }),
          h('div', { class: 'fw-plainlist' }, [
            h('p', { class: 'fw-plainlist-item', text: '1. 在 AstrBot 插件市场搜索「鱼世界桥」，或从 dsh-fish-world 仓库的 astrbot-plugin 目录上传安装。' }),
            h('p', { class: 'fw-plainlist-item', text: '2. 装好后在插件设置里生成一个 token。' }),
            h('p', { class: 'fw-plainlist-item', text: '3. 回到这里的「桥 token」粘贴，然后点「测试连通」。' }),
            h('p', { class: 'fw-plainlist-item', text: '4. 确认连通后再打开「把 AstrBot 当作 QQ 通道」。' }),
          ]),
          h('p', { class: 'fw-card-note', text: '桥只会监听本机，且每次请求都要 token；AstrBot 的登录态不会离开它自己的进程。' }),
          h('p', { class: 'fw-card-note', text: '打开 AstrBot 通道后，dsh-qq-bridge 不再是必需依赖，体检也不会再提醒你装它。' }),
        ],
      }),
    ]
  }

  function saveAstrbot(patch) {
    return postJSON('/dsh-fish-world/astrbot', { patch: patch })
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '保存失败')
        state.astrbot = d
        delete state.errors.astrbot
        render()
      })
      .catch(function (e) { setError('astrbot', e.message) })
  }

  // ---- 鱼的设置：名字、称呼、角色卡 ----
  function viewProfile() {
    var data = state.profile
    var children = []

    if (state.errors.profile) {
      children.push(statusLine('读取失败：' + state.errors.profile, 'error'))
    } else if (!data) {
      children.push(statusLine('读取中…'))
    } else {
      var fish = data.fish || {}
      var roles = data.roles || []

      var nameInput = h('input', {
        class: 'fw-input',
        type: 'text',
        value: fish.name || '',
        placeholder: '鱼',
        'aria-label': '鱼的名字',
      })
      var ownerInput = h('input', {
        class: 'fw-input',
        type: 'text',
        value: fish.ownerTitle || '主人',
        'aria-label': '对主人的称呼',
      })

      var roleSelect = h('select', { class: 'fw-input', 'aria-label': '外显角色卡' })
      var autoOpt = document.createElement('option')
      autoOpt.value = 'auto'
      autoOpt.textContent = '跟随挂件置顶/最新角色'
      roleSelect.appendChild(autoOpt)
      roles.forEach(function (role) {
        var opt = document.createElement('option')
        opt.value = role.id
        opt.textContent = (role.name || role.id) + (role.pinned ? '（置顶）' : '')
        roleSelect.appendChild(opt)
      })
      roleSelect.value = fish.persona || 'auto'

      // 外显角色卡：用卡片块呈现，点选即切换，不再是下拉框。
      // 每块显示角色名、是否置顶、是否当前在用的角色卡。
      var roleCards = h('div', { class: 'fw-role-grid', role: 'radiogroup', 'aria-label': '外显角色卡' })
      var selectedRole = fish.persona || 'auto'

      function buildRoleCards() {
        roleCards.textContent = ''
        var options = [{ id: 'auto', name: '跟随挂件', hint: '置顶或最新的角色', pinned: false }]
          .concat(roles.map(function (role) {
            return { id: role.id, name: role.name || role.id, hint: role.id, pinned: role.pinned === true }
          }))
        options.forEach(function (option) {
          var active = selectedRole === option.id
          var block = h('button', {
            class: 'fw-role-card',
            type: 'button',
            role: 'radio',
            'aria-checked': active ? 'true' : 'false',
            dataset: { selected: active ? 'true' : 'false' },
          }, [
            h('span', { class: 'fw-role-name', text: option.name }),
            h('span', { class: 'fw-role-hint', text: option.hint }),
            option.pinned ? h('span', { class: 'fw-badge', text: '置顶' }) : null,
            active ? h('span', { class: 'fw-badge', dataset: { tone: 'success' }, text: '使用中' }) : null,
          ])
          block.addEventListener('click', function () {
            selectedRole = option.id
            roleSelect.value = option.id
            buildRoleCards()
            refreshPreview()
          })
          roleCards.appendChild(block)
        })
      }

      var previewName = h('span', { class: 'fw-badge', text: '' })
      function refreshPreview() {
        // 角色的默认名字是「鱼」；只有主人改过名字才显示自定义名。
        var shown = String(nameInput.value || '').trim()
          || (data.fish && data.fish.name)
          || (data.current && data.current.displayName)
          || '鱼'
        previewName.textContent = '主界面显示：' + shown
      }
      nameInput.addEventListener('input', refreshPreview)
      roleSelect.addEventListener('change', refreshPreview)
      buildRoleCards()

      var saveStatus = statusLine('')
      var saveBtn = button('保存设置', function () {
        saveStatus.textContent = '保存中…'
        postJSON('/dsh-fish-world/fish/profile', {
          name: String(nameInput.value || '').trim(),
          ownerTitle: String(ownerInput.value || '').trim() || '主人',
          persona: roleSelect.value,
        }).then(function (r) {
          if (r && r.ok) {
            saveStatus.textContent = '已保存，主界面名称与角色会随之更新。'
            saveStatus.dataset.tone = 'success'
            state.profile = Object.assign({}, data, { fish: r.fish, current: r.current })
            loadProfile()
          } else {
            saveStatus.textContent = '保存失败：' + (r && r.error || '未知错误')
            saveStatus.dataset.tone = 'error'
          }
        }).catch(function (e) {
          saveStatus.textContent = '保存失败：' + e.message
          saveStatus.dataset.tone = 'error'
        })
      }, 'primary')

      children.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '鱼的名字' }),
        nameInput,
        h('span', { class: 'fw-row-hint', text: '命名后，主界面和鲸鱼徽标会显示这个名字。' }),
      ]))
      children.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '它怎么称呼你' }),
        ownerInput,
      ]))
      children.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '外显角色卡' }),
        roleCards,
        h('span', { class: 'fw-row-hint', text: roles.length ? '角色卡来自鲸鱼挂件已安装的角色，点选即切换。' : '还没有可用角色卡，先装 dsh-whale-widget。' }),
      ]))
      children.push(h('div', { class: 'fw-row' }, [previewName]))
      children.push(h('div', { class: 'fw-btn-row' }, [saveBtn]))
      children.push(saveStatus)

      // ---- 人设卡：按当前角色 id 存取的设定文本 ----
      var persona = state.persona || {}
      var personaArea = h('textarea', {
        class: 'fw-input',
        'aria-label': '角色人设卡',
        placeholder: '把角色卡文本粘贴到这里：说话方式、性格、语料…',
        rows: '10',
        style: 'min-height:200px;resize:vertical;font-family:var(--font-mono);line-height:1.55',
      })
      personaArea.value = persona.text || ''
      var personaStatus = statusLine(persona.bytes ? ('当前 ' + persona.bytes + ' 字节') : '还没有加载人设卡')
      var personaSave = button('保存人设卡', function () {
        personaStatus.textContent = '保存中…'
        postJSON('/dsh-fish-world/fish/persona', {
          roleId: persona.roleId || (data.current && data.current.id) || 'default',
          text: personalValue(),
        }).then(function (r) {
          if (r && r.ok) {
            personaStatus.textContent = '已保存，下一轮对话生效。'
            personaStatus.dataset.tone = 'success'
            loadPersona()
          } else {
            personaStatus.textContent = '保存失败：' + (r && r.error || '未知错误')
            personaStatus.dataset.tone = 'error'
          }
        }).catch(function (e) {
          personaStatus.textContent = '保存失败：' + e.message
          personaStatus.dataset.tone = 'error'
        })
      }, 'primary')
      function personalValue() {
        return String(personaArea.value || '')
      }

      children.push(h('div', { class: 'fw-field', style: 'margin-top:var(--space-5)' }, [
        h('label', { class: 'fw-field-label', text: '角色人设卡' }),
        personaArea,
        h('span', { class: 'fw-row-hint', text: '加载后会作为「角色人设卡」注入提示词，决定它怎么说话。按当前角色保存。' }),
      ]))
      children.push(h('div', { class: 'fw-btn-row' }, [personaSave]))
      children.push(personaStatus)
      refreshPreview()
    }

    // ---- 存储位置：鱼的工作区在哪，收藏与平台留存落在哪个目录 ----
    var storageInfo = state.storage
    var storageBody = []
    if (state.errors.storage) {
      storageBody.push(statusLine('读取失败：' + state.errors.storage, 'error'))
    } else if (!storageInfo) {
      storageBody.push(statusLine('读取中…'))
    } else {
      storageBody.push(h('p', { class: 'fw-prose', text: '鱼的工作区就是它自己的家：日记、成长、收藏与平台留存都放在这里，不上传、不镜像。' }))
      storageBody.push(dirRow({
        label: '工作区根目录',
        value: storageInfo.root,
        hint: storageInfo.configured
          ? '这是你自己选的目录；清空后会回到工作区里的「鱼的世界」。'
          : '默认跟随当前工作区；也可以在这里另选一个目录。',
        onPick: function (picked) {
          postJSON('/dsh-fish-world/storage', { root: picked })
            .then(function (r) {
              if (r && r.ok === false) throw new Error(r.error || '保存失败')
              state.storage = r
              loadStorage()
              loadStickerDir()
              loadLinks()
            })
            .catch(function (e) { setError('storage', e.message) })
        },
      }))
      storageBody.push(ghostButton('恢复默认', function () {
        postJSON('/dsh-fish-world/storage', { root: '' })
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || '保存失败')
            state.storage = r
            loadStorage()
            loadStickerDir()
            loadLinks()
          })
          .catch(function (e) { setError('storage', e.message) })
      }))

      var folders = storageInfo.folders || {}
      storageBody.push(h('div', { class: 'fw-plainlist' }, [
        ['鱼的收藏', folders.collection],
        ['1 图库', folders.gallery],
        ['2 网站链接', folders.sites],
        ['鱼与世界', folders.platforms],
        ['鱼的成长', folders.growth],
      ].filter(function (row) { return row[1] }).map(function (row) {
        return h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label' }, [
            h('span', { text: row[0] }),
            h('span', { class: 'fw-row-hint', text: row[1] }),
          ]),
        ])
      })))
      storageBody.push(h('p', { class: 'fw-card-note', text: storageInfo.layoutNote || '' }))
    }

    return [
      card({ title: '鱼的设置', note: '名字、称呼、角色卡与人设', children: children }),
      card({ title: '存储位置', note: storageInfo && storageInfo.bound ? '跟随工作区' : '默认位置', span: 12, children: storageBody }),
    ]
  }

  // 心理维度：与 dsh-feiyu-mood 的 dims 一一对应
  var PSY_KEYS = [
    { key: 'happy', label: '开心' },
    { key: 'calm', label: '踏实' },
    { key: 'sweet', label: '甜蜜' },
    { key: 'heartache', label: '心疼' },
    { key: 'worry', label: '担心' },
    { key: 'sad', label: '难过' },
    { key: 'jealous', label: '吃醋' },
  ]

  // 生理状态：与 world.mjs 的 DEFAULT_PHYSICAL.values 一一对应
  var PHYS_KEYS = [
    { key: 'energy', label: '精力' },
    { key: 'sleepiness', label: '困倦' },
    { key: 'hunger', label: '饱腹' },
    { key: 'comfort', label: '舒适' },
    { key: 'stress', label: '压力' },
  ]

  // 游戏数值面板的一行：标签 + 条 + 数值
  // 极端值处理：>100% 时条填满并转警告色，数值仍显示真实百分比（一位小数）
  function statRow(label, value, max) {
    var top = max || 100
    var raw = Number(value)
    if (!Number.isFinite(raw)) raw = 0
    var ratio = raw / top
    var clamped = Math.max(0, Math.min(1, ratio))
    var overflow = ratio > 1
    return h('div', { class: 'fw-row fw-stat' }, [
      h('span', { class: 'fw-stat-label', text: label }),
      h('span', { class: 'fw-stat-bar' }, [
        h('i', {
          style: 'width:' + (clamped * 100).toFixed(1) + '%'
            + (overflow ? ';background:var(--text-feedback-error)' : ''),
        }),
      ]),
      h('span', { class: 'fw-stat-value', text: (ratio * 100).toFixed(1) }),
    ])
  }

  function viewStatus() {
    var mood = state.mood
    var phys = state.physical

    // 心理状态：独立区块，只读 dsh-feiyu-mood
    var psyChildren = []
    if (state.errors.mood) {
      psyChildren.push(statusLine('读取失败：' + state.errors.mood, 'error'))
    } else if (!mood || !mood.ok) {
      psyChildren.push(statusLine('读取中…'))
    } else {
      psyChildren.push(h('div', { class: 'fw-stat-hero' }, [
        h('span', { class: 'fw-stat-hero-value', text: String(mood.mood == null ? '—' : mood.mood) }),
        h('span', { class: 'fw-stat-hero-label', text: (mood.emoji || '') + ' ' + (mood.moodLabel || '心情') }),
      ]))
      psyChildren.push(h('div', {}, PSY_KEYS.map(function (item) {
        var dim = (mood.dims || []).find(function (d) { return d && d.key === item.key })
        return statRow(item.label, dim ? dim.value : 0)
      })))
      if (mood.lastReason) {
        psyChildren.push(h('p', { class: 'fw-prose', text: '“' + mood.lastReason + '”' }))
      }
    }

    // 生理状态：独立区块，只读鱼世界工作区的 physical
    var physChildren = []
    if (state.errors.physical) {
      physChildren.push(statusLine('读取失败：' + state.errors.physical, 'error'))
    } else if (!phys) {
      physChildren.push(statusLine('读取中…'))
    } else {
      var values = phys.values || {}
      physChildren.push(h('div', {}, PHYS_KEYS.map(function (item) {
        return statRow(item.label, values[item.key])
      })))
    }

    return [
      // 头像卡：样子随心理状态变化
      card({ title: '鱼的样子', note: '随心理状态变化', span: 4, children: [renderPortrait()] }),
      card({ title: '心理状态', note: '心情与情绪维度', span: 4, children: psyChildren }),
      card({ title: '生理状态', note: '精力与身体感受', span: 4, children: physChildren }),
      card({
        title: '挂饰显示',
        note: '原 dsh-feiyu-mood 挂件',
        span: 12,
        children: [switchRow({
          label: '显示心情挂饰',
          hint: '有鲸鱼时通常收起，避免右下角叠三层',
          checked: readFlag('showMood', false),
          onChange: function (next) { writeFlag('showMood', next) },
        })],
      }),
    ]
  }

  // 头像卡：图片、当前情绪、来源说明。没有图时给出明确空态，不画假图。
  function renderPortrait() {
    var p = state.portrait
    if (state.errors.portrait) return statusLine('读取失败：' + state.errors.portrait, 'error')
    if (!p) return statusLine('读取中…')

    var frame = h('div', { class: 'fw-portrait-frame' })
    if (p.imageUrl) {
      var img = h('img', {
        class: 'fw-portrait-img',
        src: p.imageUrl,
        alt: (p.displayName || '鱼') + ' 的头像',
        style: p.filter && p.filter !== 'none' ? 'filter:' + p.filter : '',
      })
      img.addEventListener('error', function () {
        frame.textContent = ''
        frame.appendChild(emptyState('头像图片加载失败'))
      })
      frame.appendChild(img)
    } else {
      frame.appendChild(emptyState('还没有头像：先在「鱼的设置」里装角色卡'))
    }

    var body = [frame]
    body.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '当前情绪' }),
      h('span', { class: 'fw-badge', text: p.emotionLabel || '平静' }),
    ]))
    body.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '图片来源' }),
      h('span', { class: 'fw-badge', text: p.source === 'custom' ? '你放的情绪图' : '角色图 + 滤镜' }),
    ]))
    if (p.note) body.push(h('p', { class: 'fw-card-note', text: p.note }))

    // 上传自己的图：按当前情绪保存，下次同情绪直接用这张
    var fileInput = h('input', {
      class: 'fw-input',
      type: 'file',
      accept: 'image/png,image/jpeg,image/gif,image/webp',
      'aria-label': '上传鱼的样子',
      style: 'display:none',
    })
    var uploadStatus = statusLine('')

    function pickFile() { fileInput.click() }

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0]
      if (!file) return
      if (file.size > 8 * 1024 * 1024) {
        uploadStatus.textContent = '图片超过 8MB'
        uploadStatus.dataset.tone = 'error'
        return
      }
      uploadStatus.textContent = '上传中…'
      uploadStatus.dataset.tone = ''
      var reader = new FileReader()
      reader.onload = function () {
        postJSON('/dsh-fish-world/fish/portrait/upload', {
          // 按当前情绪存，这样切回来还是这张
          emotion: p.emotion || 'neutral',
          dataUrl: String(reader.result || ''),
        }).then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || '上传失败')
          uploadStatus.textContent = '已保存为「' + (p.emotionLabel || p.emotion) + '」的样子'
          uploadStatus.dataset.tone = 'success'
          fileInput.value = ''
          loadPortrait()
        }).catch(function (e) {
          uploadStatus.textContent = '上传失败：' + e.message
          uploadStatus.dataset.tone = 'error'
        })
      }
      reader.onerror = function () {
        uploadStatus.textContent = '读取文件失败'
        uploadStatus.dataset.tone = 'error'
      }
      reader.readAsDataURL(file)
    })

    body.push(fileInput)
    body.push(h('div', { class: 'fw-btn-row' }, [
      button('上传这张脸', pickFile),
      p.source === 'custom' ? button('恢复角色图', function () {
        postJSON('/dsh-fish-world/fish/portrait/remove', { emotion: p.emotion })
          .then(function () { loadPortrait() })
          .catch(function (e) { setError('portrait', e.message) })
      }) : null,
    ].filter(Boolean)))
    body.push(uploadStatus)
    body.push(h('p', { class: 'fw-card-note', text: '支持 PNG / JPEG / GIF / WebP，最大 8MB。上传的图按当前情绪保存。' }))
    return h('div', {}, body)
  }

  // ---------- 目录选择 ----------
  // 不在输入框里手打路径：让主人在本机目录树里点。
  // 数据来自 /dsh-fish-world/fs/roots 与 /fs/list（只读、只列目录）。
  function openDirPicker(opts) {
    var o = opts || {}
    var listEl = h('div', { class: 'fw-picker-list' })
    var pathText = h('p', { class: 'fw-picker-path', text: '读取中…' })
    var status = statusLine('')
    var current = ''

    function load(path) {
      status.textContent = ''
      getJSON('/dsh-fish-world/fs/list?path=' + encodeURIComponent(path || ''))
        .then(function (d) {
          if (d && d.ok === false) throw new Error(d.error || '读不了这个目录')
          current = d.path
          pathText.textContent = d.path
          listEl.textContent = ''
          if (d.parent) {
            listEl.appendChild(h('button', {
              class: 'fw-picker-item', type: 'button', text: '↑ 上一级', dataset: { dir: d.parent },
            }))
          }
          ;(d.entries || []).forEach(function (entry) {
            listEl.appendChild(h('button', {
              class: 'fw-picker-item', type: 'button', text: entry.name + '/', dataset: { dir: entry.path },
            }))
          })
          if (!(d.entries || []).length) listEl.appendChild(h('p', { class: 'fw-picker-empty', text: '这个目录下没有子目录。' }))
          if (d.truncated) status.textContent = '子目录太多，只列出前 500 个；可以直接用「选这个目录」。'
        })
        .catch(function (e) { status.textContent = '读取失败：' + e.message })
    }

    listEl.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('[data-dir]') : null
      if (target) load(target.dataset.dir)
    })

    var confirmBtn = button(o.confirmLabel || '选这个目录', function () { pick() }, 'primary')
    var closeBtn = ghostButton('取消', function () { close() })

    // 遮罩：点空白处关闭，也挡住背后的滚动与误触
    var scrim = h('div', { class: 'fw-picker-scrim' })
    scrim.addEventListener('click', function () { close() })

    var popover = h('div', { class: 'fw-picker', role: 'dialog', 'aria-label': o.title || '选择目录' }, [
      h('p', { class: 'fw-field-label', text: o.title || '选择目录' }),
      pathText,
      listEl,
      status,
      h('div', { class: 'fw-btn-row' }, [confirmBtn, closeBtn]),
    ])

    function pick() {
      if (!current) return
      var chosen = current
      close()
      if (o.onPick) o.onPick(chosen)
    }

    function onKeydown(event) {
      if (event.key === 'Escape') close()
    }

    function close() {
      document.removeEventListener('keydown', onKeydown)
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim)
      if (popover.parentNode) popover.parentNode.removeChild(popover)
    }

    // 挂到 body：卡片是 overflow:hidden，浮层放卡片里会被裁掉。
    document.body.appendChild(scrim)
    document.body.appendChild(popover)
    document.addEventListener('keydown', onKeydown)
    getJSON('/dsh-fish-world/fs/roots')
      .then(function (d) { load(o.start || (d && d.shortcuts && d.shortcuts[0] && d.shortcuts[0].path) || (d && d.home) || '') })
      .catch(function (e) { status.textContent = '读取失败：' + e.message })
    return popover
  }

  // 一行「路径 + 选择」控件：路径只读、可全选复制。
  function dirRow(opts) {
    var field = h('input', {
      class: 'fw-input',
      type: 'text',
      value: opts.value || '',
      readonly: true,
      'aria-label': opts.label || '目录',
    })
    field.addEventListener('focus', function () { field.select() })
    return h('div', { class: 'fw-field' }, [
      h('label', { class: 'fw-field-label', text: opts.label || '目录' }),
      h('div', { class: 'fw-dir-row' }, [
        field,
        ghostButton(opts.actionLabel || '选择目录', function () {
          openDirPicker({
            title: opts.label || '选择目录',
            start: field.value,
            onPick: function (picked) {
              field.value = picked
              if (opts.onPick) opts.onPick(picked)
            },
          })
        }),
      ]),
      opts.hint ? h('span', { class: 'fw-row-hint', text: opts.hint }) : null,
    ])
  }

  function viewStickers() {
    var data = state.stickers
    var dirInfo = state.stickerDir
    var storageInfo = state.storage
    var children = []
    if (state.errors.stickers) children.push(statusLine('读取失败：' + state.errors.stickers, 'error'))
    else if (!data) children.push(statusLine('读取中…'))
    else {
      var items = data.items || []
      children.push(h('p', { class: 'fw-card-note', text: '共 ' + items.length + ' 张' }))

      // 目录信息：用户要把自己的图片给鱼，就得知道放哪儿，并且能直接点选。
      if (dirInfo && dirInfo.dir) {
        children.push(dirRow({
          label: '图库目录',
          value: dirInfo.dir,
          hint: dirInfo.hint || '',
          onPick: function (picked) {
            postJSON('/dsh-fish-world/storage', { gallery: picked })
              .then(function (r) {
                if (r && r.ok === false) throw new Error(r.error || '保存失败')
                state.storage = r
                loadStickerDir()
              })
              .catch(function (e) { setError('stickerDir', e.message) })
          },
        }))
        children.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label', text: '支持格式' }),
          h('span', { class: 'fw-badge', text: (dirInfo.formats || []).join(' / ') }),
        ]))
        // 情绪图目录也一并给出，方便用户配头像
        if (state.portrait && state.portrait.dir) {
          children.push(h('div', { class: 'fw-field' }, [
            h('label', { class: 'fw-field-label', text: '情绪图目录（头像用）' }),
            h('input', {
              class: 'fw-input',
              type: 'text',
              value: state.portrait.dir,
              readonly: true,
              'aria-label': '情绪图目录',
            }),
            h('span', { class: 'fw-row-hint', text: '按情绪命名放图：happy / calm / sweet / heartache / worry / sad / jealous。' }),
          ]))
        }
        if (storageInfo && storageInfo.root) {
          children.push(h('p', { class: 'fw-card-note', text: '鱼的工作区：' + storageInfo.root }))
        }
        if (dirInfo.note) children.push(h('p', { class: 'fw-card-note', text: dirInfo.note }))
      }

      if (!items.length) children.push(emptyState('还没有收藏的表情。鱼会在聊天里按心情收藏，你也可以把图片放进上面的目录。'))
      else {
        children.push(h('div', { class: 'fw-list' }, items.map(function (item) {
          // 缩略图：真实图片从 /sticker-image 取；加载失败显示占位文字而不是破图
          var thumb = h('img', {
            class: 'fw-sticker-thumb',
            src: '/dsh-fish-world/sticker-image?id=' + encodeURIComponent(item.id),
            alt: item.name || '表情',
            loading: 'lazy',
            draggable: 'false',
          })
          thumb.addEventListener('error', function () {
            thumb.style.visibility = 'hidden'
          })

          var meta = h('div', { class: 'fw-item-meta' }, [
            h('span', { class: 'fw-sticker-name', text: item.name || '未命名', title: item.name || '未命名' }),
            h('span', { class: 'fw-sticker-tags', text: (item.tags || []).join('、') || '无标签', title: (item.tags || []).join('、') }),
          ])

          var actions = h('div', { class: 'fw-btn-row', style: 'margin-top:0;margin-left:auto' }, [
            ghostButton('删除', function () {
              postJSON('/dsh-fish-world/stickers/remove', { id: item.id })
                .then(function () { loadStickers() })
                .catch(function (e) { setError('stickers', e.message) })
            }),
          ])

          return h('div', { class: 'fw-item fw-sticker-row' }, [
            thumb,
            h('div', { class: 'fw-sticker-body' }, [meta]),
            actions,
          ])
        })))
      }
    }
    return [
      card({ title: '图片收藏', note: '表情与图片 · 每小时最多 5 张', span: 6, children: children }),
      card({ title: '网站收藏', note: '按分类编号 · 资源与灵感站点', span: 6, children: [renderLinkLibrary()] }),
      renderRecordsCard(),
    ]
  }

  // ---------- 鱼的记录 ----------
  // 主人让它记下的东西：一条一条列出来，每条都能就地改、一键删。
  // 小本本里是没被回复的请求：主人给了解释、鱼认可后才划掉。
  var GRUDGE_LABELS = { open: '还没解释', explained: '已解释 · 等鱼认可', accepted: '已划掉' }

  function renderRecordsCard() {
    var data = state.records
    var body = []
    if (state.errors.records) {
      body.push(statusLine('读取失败：' + state.errors.records, 'error'))
    } else if (!data) {
      body.push(statusLine('读取中…'))
    } else {
      var items = data.items || []
      var grudges = data.grudges || []
      var openGrudges = grudges.filter(function (g) { return g.status !== 'accepted' })

      body.push(h('p', { class: 'fw-card-note', text: '你让它记下的，一条一条放在这里；可以就地修改，也可以一键删掉。' }))

      var addInput = h('input', {
        class: 'fw-input',
        type: 'text',
        placeholder: '让它记一件事…',
        'aria-label': '要记的内容',
      })
      var addStatus = statusLine('')
      function submitAdd() {
        var text = String(addInput.value || '').trim()
        if (!text) return
        addStatus.textContent = '保存中…'
        addStatus.dataset.tone = ''
        postJSON('/dsh-fish-world/world/records', { action: 'add', text: text })
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || '保存失败')
            addInput.value = ''
            addStatus.textContent = '记下了'
            addStatus.dataset.tone = 'success'
            loadRecords()
          })
          .catch(function (e) {
            addStatus.textContent = '没记上：' + e.message
            addStatus.dataset.tone = 'error'
          })
      }
      addInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') submitAdd()
      })
      body.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '让它记一件事' }),
        addInput,
      ]))
      body.push(h('div', { class: 'fw-btn-row' }, [
        button('记下', submitAdd, 'primary'),
        h('span', { text: '' }),
      ]))
      body.push(addStatus)

      body.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-4)' }, [
        h('h3', { class: 'fw-card-title', text: '记录' }),
        h('span', { class: 'fw-card-note', text: items.length ? items.length + ' 条' : '暂无' }),
      ]))
      if (!items.length) {
        body.push(emptyState('还没有记录。你让它记什么，它就会一条一条记在这里。'))
      } else {
        body.push(h('div', { class: 'fw-list' }, items.map(function (item) {
          var editing = false
          var textEl = h('p', { class: 'fw-item-text', text: item.text })
          var editor = h('input', { class: 'fw-input', type: 'text', value: item.text, 'aria-label': '修改内容' })
          editor.hidden = true
          var editBtn = ghostButton('修改', function () {
            editing = !editing
            editor.hidden = !editing
            textEl.hidden = editing
            if (editing) { editor.focus(); editor.select() }
          })
          function saveEdit() {
            var text = String(editor.value || '').trim()
            if (!text) return
            postJSON('/dsh-fish-world/world/records', { action: 'update', id: item.id, text: text })
              .then(function (r) {
                if (r && r.ok === false) throw new Error(r.error || '保存失败')
                loadRecords()
              })
              .catch(function (e) { setError('records', e.message) })
          }
          editor.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') saveEdit()
            if (event.key === 'Escape') editBtn.click()
          })

          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: shortTime(item.at) }),
              item.source === 'fish' ? h('span', { class: 'fw-badge', text: '它自己记的' }) : null,
              Number(item.revision) > 1 ? h('span', { text: '改过 ' + (Number(item.revision) - 1) + ' 次' }) : null,
            ].filter(Boolean)),
            textEl,
            editor,
            h('div', { class: 'fw-btn-row', style: 'margin-top:var(--space-1)' }, [
              editBtn,
              ghostButton('删除', function () {
                postJSON('/dsh-fish-world/world/records', { action: 'remove', id: item.id })
                  .then(function (r) {
                    if (r && r.ok === false) throw new Error(r.error || '删除失败')
                    loadRecords()
                  })
                  .catch(function (e) { setError('records', e.message) })
              }),
            ]),
          ])
        })))
      }

      // 小本本：没被回复的请求
      body.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-4)' }, [
        h('h3', { class: 'fw-card-title', text: '小本本' }),
        h('span', { class: 'fw-card-note', text: openGrudges.length ? openGrudges.length + ' 条没划掉' : '都划掉了' }),
      ]))
      body.push(h('p', { class: 'fw-card-note', text: '请求当天没被回复，它会记在自己的小本本里；你给出解释、它认可之后才划掉。' }))
      if (!openGrudges.length) {
        body.push(emptyState('小本本是空的。'))
      } else {
        body.push(h('div', { class: 'fw-list' }, openGrudges.map(function (grudge) {
          var explainInput = h('input', {
            class: 'fw-input',
            type: 'text',
            value: grudge.explanation || '',
            placeholder: '给它的解释…',
            'aria-label': '解释',
          })
          explainInput.hidden = grudge.status !== 'open'
          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: grudge.day || shortTime(grudge.at) }),
              h('span', { class: 'fw-badge', dataset: { tone: grudge.status === 'explained' ? 'success' : '' }, text: GRUDGE_LABELS[grudge.status] || grudge.status }),
            ]),
            h('p', { class: 'fw-item-text', text: grudge.text }),
            explainInput,
            h('div', { class: 'fw-btn-row', style: 'margin-top:var(--space-1)' }, [
              grudge.status === 'open'
                ? ghostButton('解释', function () {
                  var text = String(explainInput.value || '').trim()
                  if (!text) { explainInput.hidden = false; explainInput.focus(); return }
                  postJSON('/dsh-fish-world/world/records', { action: 'explain', id: grudge.id, text: text })
                    .then(function (r) {
                      if (r && r.ok === false) throw new Error(r.error || '保存失败')
                      loadRecords()
                    })
                    .catch(function (e) { setError('records', e.message) })
                })
                : ghostButton('它认可了，划掉', function () {
                  postJSON('/dsh-fish-world/world/records', { action: 'accept', id: grudge.id })
                    .then(function (r) {
                      if (r && r.ok === false) throw new Error(r.error || '保存失败')
                      loadRecords()
                    })
                    .catch(function (e) { setError('records', e.message) })
                }),
            ]),
          ])
        })))
      }
    }

    var note = data ? String((data.items || []).length) + ' 条' : '读取中'
    return card({ key: 'records', title: '鱼的记录', note: note, span: 12, children: body })
  }

  // 网站收藏：默认来源 StyleKit；类型与标签由鱼自己判断。
  // 每条按分类编号（设计 A-01、工具 C-01…），编号是给人和鱼互相指认用的。
  var LINK_KIND_LABELS = {
    design: '设计',
    reference: '参考',
    tool: '工具',
    article: '文章',
    inspiration: '灵感',
    other: '其它',
  }

  // 分类选项：与 lib/links.mjs 的 LINK_KIND_META 一一对应
  function linkKindOptions() {
    return [
      { id: 'design', label: '设计' },
      { id: 'reference', label: '参考' },
      { id: 'tool', label: '工具' },
      { id: 'article', label: '文章' },
      { id: 'inspiration', label: '灵感' },
      { id: 'other', label: '其它' },
    ]
  }

  function killEvent(event) { event.stopPropagation() }

  function renderLinkLibrary() {
    var data = state.links
    if (state.errors.links) return statusLine('读取失败：' + state.errors.links, 'error')
    if (!data) return statusLine('读取中…')

    var items = data.items || []
    var summary = data.summary || {}
    var body = []

    // 按分类编号：区块标题带编号前缀，一眼能找到 A-03。
    var groups = []
    linkKindOptions().forEach(function (kind) {
      var list = items.filter(function (item) { return item.kind === kind.id })
      if (list.length) groups.push({ kind: kind, items: list })
    })
    // 未知分类兜底，不让条目凭空消失
    var known = linkKindOptions().map(function (k) { return k.id })
    var others = items.filter(function (item) { return known.indexOf(item.kind) < 0 })
    if (others.length) groups.push({ kind: { id: 'other', label: '其它' }, items: others })

    body.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '已收藏' }),
      h('span', { class: 'fw-badge', text: String(summary.total || 0) + ' 条' }),
    ]))
    body.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '本小时还能收' }),
      h('span', { class: 'fw-badge', text: String(summary.remainingThisHour == null ? '—' : summary.remainingThisHour) + ' 条' }),
    ]))
    if (summary.dir) {
      body.push(dirRow({
        label: '网站清单目录',
        value: summary.dir,
        hint: '网站清单.md 与 links.json 都在这里；换目录会保留已有记录。',
        onPick: function (picked) {
          postJSON('/dsh-fish-world/storage', { sites: picked })
            .then(function (r) {
              if (r && r.ok === false) throw new Error(r.error || '保存失败')
              state.storage = r
              loadLinks()
            })
            .catch(function (e) { setError('links', e.message) })
        },
      }))
    }

    // 手动加一条：分类可选，编号由程序按分类自动排。
    var urlInput = h('input', {
      class: 'fw-input',
      type: 'url',
      placeholder: '粘贴网址，例如 https://www.stylekit.top/zh/styles/bento-grid',
      'aria-label': '网址',
    })
    var titleInput = h('input', {
      class: 'fw-input',
      type: 'text',
      placeholder: '标题（可留空）',
      'aria-label': '网站标题',
    })
    var kindSelect = h('select', { class: 'fw-input', 'aria-label': '分类' }, linkKindOptions().map(function (kind) {
      var opt = document.createElement('option')
      opt.value = kind.id
      opt.textContent = kind.label
      return opt
    }))
    var linkStatus = statusLine('')
    var addBtn = button('收藏网站', function () {
      var url = String(urlInput.value || '').trim()
      if (!url) return
      linkStatus.textContent = '保存中…'
      linkStatus.dataset.tone = ''
      postJSON('/dsh-fish-world/links/collect', {
        url: url,
        title: String(titleInput.value || '').trim(),
        kind: kindSelect.value,
      }).then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || '保存失败')
        urlInput.value = ''
        titleInput.value = ''
        linkStatus.textContent = '已收藏' + (r && r.item && r.item.no ? '：' + r.item.no : '')
        linkStatus.dataset.tone = 'success'
        loadLinks()
      }).catch(function (e) {
        linkStatus.textContent = '收藏失败：' + e.message
        linkStatus.dataset.tone = 'error'
      })
    }, 'primary')

    body.push(h('div', { class: 'fw-field' }, [
      h('label', { class: 'fw-field-label', text: '添加网站' }),
      urlInput,
      h('div', { class: 'fw-link-add' }, [titleInput, kindSelect]),
    ]))
    body.push(h('div', { class: 'fw-btn-row' }, [addBtn]))
    body.push(linkStatus)

    // 默认来源：鱼可以去这里自己挑
    ;(summary.sources || []).forEach(function (source) {
      body.push(h('p', { class: 'fw-card-note', text: '默认来源 · ' + source.name + '：' + (source.description || '') }))
    })

    if (!items.length) {
      body.push(emptyState('还没有收藏网站。鱼可以从默认来源里自己挑，你也可以直接粘一个网址。'))
    } else {
      groups.forEach(function (group) {
        body.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-4)' }, [
          h('h3', { class: 'fw-card-title', text: group.kind.label }),
          h('span', { class: 'fw-card-note', text: group.items.length + ' 条' }),
        ]))
        body.push(h('div', { class: 'fw-list' }, group.items.map(function (item) {
          var row = h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { class: 'fw-no', text: item.no || '—' }),
              h('span', { text: shortTime(item.at) }),
              (item.tags || []).length ? h('span', { text: '#' + item.tags.join(' #') }) : null,
            ].filter(Boolean)),
            h('a', {
              class: 'fw-link',
              href: item.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              text: item.title || item.url,
            }),
            item.note ? h('p', { class: 'fw-item-text', text: item.note }) : null,
            h('div', { class: 'fw-btn-row' }, [
              (function () {
                // 改分类：编号会自动换到新分类的队尾
                var select = h('select', { class: 'fw-input fw-kind-select', 'aria-label': '修改分类' }, linkKindOptions().map(function (kind) {
                  var opt = document.createElement('option')
                  opt.value = kind.id
                  opt.textContent = kind.label
                  if (kind.id === item.kind) opt.selected = true
                  return opt
                }))
                select.addEventListener('click', killEvent)
                select.addEventListener('change', function () {
                  postJSON('/dsh-fish-world/links/update', { id: item.id, kind: select.value })
                    .then(function (r) {
                      if (r && r.ok === false) throw new Error(r.error || '保存失败')
                      loadLinks()
                    })
                    .catch(function (e) { setError('links', e.message) })
                })
                return h('span', { class: 'fw-kind-wrap' }, [select])
              })(),
              ghostButton('删除', function () {
                postJSON('/dsh-fish-world/links/remove', { id: item.id })
                  .then(function () { loadLinks() })
                  .catch(function (e) { setError('links', e.message) })
              }),
            ]),
          ])
          return row
        })))
      })
    }

    return h('div', {}, body)
  }

  function viewQzone() {
    var cfg = state.qzone
    var children = []
    if (state.errors.qzone) children.push(statusLine('读取失败：' + state.errors.qzone, 'error'))
    else if (!cfg) children.push(statusLine('读取中…'))
    else {
      var rows = [
        ['postsPerDay', '动态/日记 每日上限'],
        ['likesPerDay', '点赞 每日上限'],
        ['commentsPerDay', '评论 每日上限'],
        ['repliesPerDay', '回复 每日上限'],
      ]
      children.push(h('p', { class: 'fw-card-note', text: '0 表示禁用对应操作；动态与日记共用额度。' }))
      rows.forEach(function (row) {
        var input = h('input', {
          class: 'fw-input',
          type: 'number',
          min: '0',
          max: '100',
          value: String(cfg[row[0]] == null ? 2 : cfg[row[0]]),
          'aria-label': row[1],
        })
        children.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label', text: row[1] }),
          h('span', { style: 'width:88px;flex:none' }, [input]),
        ]))
      })
    }
    return [card({ title: 'QQ 空间额度', note: '空间属于鱼自己的 QQ 号', span: 8, children: children })]
  }

  function viewExtensions() {
    var ext = state.extensions
    var children = []
    if (state.errors.extensions) children.push(statusLine('读取失败：' + state.errors.extensions, 'error'))
    else if (!ext) children.push(statusLine('读取中…'))
    else {
      var list = ext.extensions || []
      if (!list.length) children.push(emptyState('没有已安装的外部扩展。'))
      else {
        children.push(h('div', { class: 'fw-list' }, list.map(function (item) {
          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: item.name || item.id }),
              h('span', { text: item.status || '' }),
            ]),
          ])
        })))
      }
    }
    return [card({ title: '扩展', note: '从链接安装，插件自身不托管', children: children })]
  }

  function viewDisplay() {
    return [
      card({
        title: '面板显示',
        note: '只控制显隐，不影响朗读等行为',
        span: 8,
        children: DISPLAY_KEYS.map(function (item) {
          return switchRow({
            label: item.label,
            hint: item.hint,
            checked: readFlag(item.key, false),
            onChange: function (next) { writeFlag(item.key, next) },
          })
        }),
      }),
      card({
        title: '主题',
        span: 4,
        children: [
          h('div', { class: 'fw-btn-row', style: 'margin-top:0' }, [
            button('浅色', function () { setTheme('light') }),
            button('深色', function () { setTheme('dark') }),
            button('跟随系统', function () { setTheme('') }),
          ]),
        ],
      }),
    ]
  }

  function button(label, onClick, variant) {
    var b = h('button', {
      class: 'fw-btn',
      type: 'button',
      dataset: variant ? { variant: variant } : {},
      text: label,
    })
    b.addEventListener('click', onClick)
    return b
  }

  function setTheme(value) {
    if (value) document.documentElement.setAttribute('data-theme', value)
    else document.documentElement.removeAttribute('data-theme')
  }

  // ---------- 数据加载 ----------
  function setError(key, message) {
    state.errors[key] = message
    render()
  }

  function markLoaded(key) {
    state.loading[key] = false
    delete state.errors[key]
  }

  function loadMood() {
    return getJSON('/dsh-feiyu-mood/state')
      .then(function (d) { state.mood = d; markLoaded('mood') })
      .catch(function (e) { state.mood = { ok: false }; state.errors.mood = e.message; state.loading.mood = false })
      .then(render)
  }

  // 生理状态来自鱼世界工作区的 world 状态，不属于心情插件。
  function loadPhysical() {
    return getJSON('/dsh-fish-world/world')
      .then(function (d) { state.physical = d && d.physical || null; markLoaded('physical') })
      .catch(function (e) { state.errors.physical = e.message })
      .then(render)
  }

  function loadWishes() {
    return getJSON('/dsh-fish-world/world/wishes')
      .then(function (d) { state.wishes = d; markLoaded('wishes') })
      .catch(function (e) { state.errors.wishes = e.message })
      .then(render)
  }

  function loadGrowth() {
    return getJSON('/dsh-fish-world/world/growth')
      .then(function (d) { state.growth = d; markLoaded('growth') })
      .catch(function (e) { state.errors.growth = e.message })
      .then(render)
  }

  function loadPlatforms() {
    return getJSON('/dsh-fish-world/platforms')
      .then(function (d) { state.platforms = d; markLoaded('platforms') })
      .catch(function (e) { state.errors.platforms = e.message })
      .then(render)
  }

  function loadVoice() {
    return getJSON('/dsh-fish-world/fish/voice')
      .then(function (d) { state.voice = d; markLoaded('voice') })
      .catch(function (e) { state.errors.voice = e.message })
      .then(render)
  }

  function loadAstrbot() {
    return getJSON('/dsh-fish-world/astrbot')
      .then(function (d) { state.astrbot = d; markLoaded('astrbot') })
      .catch(function (e) { state.errors.astrbot = e.message })
      .then(render)
  }

  // 头像：把当前心情与维度带给后端，由它决定用哪张图。
  function loadPortrait() {
    var mood = state.mood && state.mood.ok ? state.mood : null
    var params = []
    if (mood && mood.mood != null) params.push('mood=' + encodeURIComponent(mood.mood))
    if (mood && Array.isArray(mood.dims)) {
      mood.dims.forEach(function (dim) {
        if (dim && dim.key) params.push('d_' + encodeURIComponent(dim.key) + '=' + encodeURIComponent(Number(dim.value) || 0))
      })
    }
    var query = params.length ? '?' + params.join('&') : ''
    return getJSON('/dsh-fish-world/fish/portrait' + query)
      .then(function (d) { state.portrait = d; markLoaded('portrait') })
      .catch(function (e) { state.errors.portrait = e.message })
      .then(render)
  }

  function loadStickerDir() {
    return getJSON('/dsh-fish-world/stickers/dir')
      .then(function (d) { state.stickerDir = d; markLoaded('stickerDir') })
      .catch(function (e) { state.errors.stickerDir = e.message })
      .then(render)
  }

  function loadStorage() {
    return getJSON('/dsh-fish-world/storage')
      .then(function (d) { state.storage = d; markLoaded('storage') })
      .catch(function (e) { state.errors.storage = e.message })
      .then(render)
  }

  function loadActivity() {
    return getJSON('/dsh-fish-world/world/activity')
      .then(function (d) { state.activity = d; markLoaded('activity') })
      .catch(function (e) { state.errors.activity = e.message })
      .then(render)
  }

  function loadRecords() {
    return getJSON('/dsh-fish-world/world/records')
      .then(function (d) { state.records = d; markLoaded('records') })
      .catch(function (e) { state.errors.records = e.message })
      .then(render)
  }

  function loadLinks() {
    return getJSON('/dsh-fish-world/links')
      .then(function (d) { state.links = d; markLoaded('links') })
      .catch(function (e) { state.errors.links = e.message })
      .then(render)
  }

  function loadProfile() {
    return Promise.all([
      getJSON('/dsh-fish-world/fish/profile').then(function (d) { state.profile = d; markLoaded('profile') }),
      getJSON('/dsh-fish-world/fish/persona')
        .then(function (d) { state.persona = d; markLoaded('persona') })
        .catch(function (e) { state.errors.persona = e.message }),
    ])
      .catch(function (e) { state.errors.profile = e.message })
      .then(loadPortrait)
  }

  function loadPersona() {
    return getJSON('/dsh-fish-world/fish/persona')
      .then(function (d) { state.persona = d; markLoaded('persona') })
      .catch(function (e) { state.errors.persona = e.message })
      .then(render)
  }

  function loadTts() {
    return getJSON('/dsh-tts-bridge/status')
      .then(function (d) { state.tts = d; markLoaded('tts') })
      .catch(function (e) { state.tts = { ok: false }; state.errors.tts = e.message; state.loading.tts = false })
      .then(render)
  }

  function loadDiary() {
    var query = state.diaryDate ? '?date=' + encodeURIComponent(state.diaryDate) : ''
    state.loading.diary = true
    return getJSON('/dsh-fish-world/world/diary' + query)
      .then(function (d) { state.diary = d; markLoaded('diary') })
      .catch(function (e) { state.errors.diary = e.message; state.loading.diary = false })
      .then(render)
  }

  function loadStickers() {
    return getJSON('/dsh-fish-world/stickers')
      .then(function (d) { state.stickers = d; markLoaded('stickers') })
      .catch(function (e) { state.errors.stickers = e.message })
      .then(render)
  }

  function loadQzone() {
    return getJSON('/dsh-fish-world/config')
      .then(function (d) { state.qzone = d && d.config && d.config.qzone || {}; markLoaded('qzone') })
      .catch(function (e) { state.errors.qzone = e.message })
      .then(render)
  }

  function loadCapabilities() {
    return getJSON('/dsh-fish-world/capabilities')
      .then(function (d) { state.capabilities = d; markLoaded('capabilities') })
      .catch(function (e) { state.errors.capabilities = e.message })
      .then(render)
  }

  function loadExtensions() {
    return getJSON('/dsh-fish-world/extensions')
      .then(function (d) { state.extensions = d; markLoaded('extensions') })
      .catch(function (e) { state.errors.extensions = e.message })
      .then(render)
  }

  function loadEnv() {
    return getJSON('/dsh-fish-world/env')
      .then(function (d) { state.env = d && d.environment; markLoaded('env') })
      .catch(function (e) { state.errors.env = e.message })
      .then(render)
  }

  function loadView(view) {
    if (view === 'overview') {
      // 总览按面板列表展示所有内容，所以要一次性把各分区的数据都拉回来。
      return Promise.all([
        loadMood(), loadPhysical(), loadTts(), loadDiary(), loadEnv(), loadCapabilities(),
        loadWishes(), loadGrowth(), loadPlatforms(), loadProfile(), loadVoice(),
        loadStickers(), loadQzone(), loadExtensions(), loadAstrbot(),
      ])
    }
    if (view === 'diary') return loadDiary()
    if (view === 'status') return Promise.all([loadMood(), loadPhysical()]).then(loadPortrait)
    if (view === 'wishes') return Promise.all([loadWishes(), loadRecords()])
    if (view === 'growth') return loadGrowth()
    if (view === 'doctor') return Promise.all([
      getJSON('/dsh-fish-world/doctor/dependency')
        .then(function (d) { state.doctorDep = d; markLoaded('doctorDep') })
        .catch(function (e) { state.errors.doctorDep = e.message }),
    ]).then(render)
    if (view === 'profile') return Promise.all([loadProfile(), loadPersona(), loadStorage()])
    if (view === 'platforms') return Promise.all([loadPlatforms(), loadActivity(), loadStorage()])
    if (view === 'voice') return loadVoice()
    if (view === 'astrbot') return loadAstrbot()
    if (view === 'stickers') return Promise.all([loadStickers(), loadStickerDir(), loadLinks(), loadStorage(), loadRecords()])
    if (view === 'qzone') return loadQzone()
    if (view === 'extensions') return loadExtensions()
    return Promise.resolve()
  }

  // ---------- 渲染 ----------
  var main = null
  var nav = null

  function navigate(view) {
    var changed = state.view !== view
    state.view = view
    // 每次"进入"请求界面都换一句等他回话的文案
    if (changed) reshuffleRequestHint()
    if (nav) {
      Array.prototype.forEach.call(nav.children, function (child) {
        child.setAttribute('aria-current', child.dataset.view === view ? 'true' : 'false')
      })
    }
    render()
    loadView(view)
  }

  function currentView() {
    if (state.view === 'diary') return viewDiary()
    if (state.view === 'status') return viewStatus()
    if (state.view === 'wishes') return viewWishes()
    if (state.view === 'growth') return viewGrowth()
    if (state.view === 'doctor') return viewDoctor()
    if (state.view === 'platforms') return viewPlatforms()
    if (state.view === 'voice') return viewVoice()
    if (state.view === 'astrbot') return viewAstrbot()
    if (state.view === 'profile') return viewProfile()
    if (state.view === 'stickers') return viewStickers()
    // QQ 空间已并入「鱼与世界」的鱼与 QQ 卡片
    if (state.view === 'qzone') return viewPlatforms()
    if (state.view === 'extensions') return viewExtensions()
    if (state.view === 'display') return viewDisplay()
    return viewOverview()
  }

  // 侧栏标题跟随鱼的名字；profile 刷新后同步更新，不用重建整个面板。
  function updateRailName() {
    var nameNode = document.querySelector('.fw-rail-name')
    if (!nameNode) return
    var name = state.profile && state.profile.fish && String(state.profile.fish.name || '').trim()
    nameNode.textContent = name || '鱼的世界'
  }

  function render() {
    if (!main) return
    main.textContent = ''
    cardRegistry = []
    currentView().forEach(function (node) { main.appendChild(node) })
    // 只在总览恢复用户保存的卡片顺序；其他分区按各自逻辑排列
    if (state.view === 'overview') applySavedOrder(main)
    updateRailName()
  }

  function build() {
    var stage = document.getElementById('app')
    if (!stage) return

    nav = h('nav', { class: 'fw-nav', 'aria-label': '鱼世界分区' })
    NAV.forEach(function (item) {
      var b = h('button', {
        class: 'fw-nav-item',
        type: 'button',
        dataset: { view: item.id },
        'aria-current': item.id === state.view ? 'true' : 'false',
        text: item.label,
      })
      b.addEventListener('click', function () { navigate(item.id) })
      nav.appendChild(b)
    })

    var rail = h('aside', { class: 'fw-rail' }, [
      h('h1', { class: 'fw-rail-title' }, [
        h('span', { class: 'fw-rail-mark', text: '🐟', 'aria-hidden': 'true' }),
        h('span', { class: 'fw-rail-name', text: state.profile && state.profile.fish && state.profile.fish.name ? state.profile.fish.name : '鱼的世界' }),
      ]),
      nav,
      h('div', { class: 'fw-rail-foot' }, [
        h('span', { text: '日记由鱼自己写；这里只支持主人查看和批阅（查看与阅览并对日记内容批语）。' }),
      ]),
    ])

    main = h('div', { class: 'fw-main' })
    stage.appendChild(h('div', { class: 'fw-shell' }, [rail, main]))

    bindDragAndDrop(main)

    state.diaryDate = today()
    render()
    loadView('overview')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build)
  else build()

  // 供探针/审查区读取真实状态
  window.__fishWorldPanel = { state: state, navigate: navigate, render: render }
})()
