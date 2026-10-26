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
    { id: 'profile', label: '鱼的设定' },
    { id: 'platforms', label: '鱼与世界' },
    // 收藏放在设置与世界之后：日常更常点的是前面几项
    { id: 'stickers', label: '鱼之宝库' },
    { id: 'astrbot', label: 'AstrBot 接入' },
    // 扩展与设置靠后（倒数第二），「面板显示」已并入这一页
    { id: 'extensions', label: '扩展与设置' },
    { id: 'doctor', label: '体检与更新' },
  ]

  // 面板有两种加载方式：主界面注入（floating）与 DSH 设置页 iframe（settings）。
  // 两种都允许拖拽；settings 模式下 iframe 自带外框留白，内容区留白相应收一点。
  var SETTINGS_MODE = window.__DSH_FISH_WORLD_SETTINGS_MODE__ === true

  // 总览的详略：简化为紧凑摘要，详细为每分区一张卡。默认简化，避免一屏挤满。
  function overviewDetailed() {
    return readFlag('overviewDetail', false)
  }
  function setOverviewDetailFlag(value) {
    writeFlag('overviewDetail', value === true)
  }

  // 面板显示开关：与 DSH 内嵌面板共用同一组 localStorage key。
  var DISPLAY_KEYS = [
    { key: 'showTts', label: '朗读桥卡（默认关闭）', hint: '只控制卡片显隐，不会开启自动朗读', defaultOn: false },
    { key: 'showMood', label: '心情挂饰', hint: '原 dsh-feiyu-mood 挂件是否显示', defaultOn: false },
  ]

  // 这两个开关管的是宿主页面上的挂件——由 dsh-feiyu-mood、dsh-tts-bridge
  // 两个插件渲染，不是面板自己的组件。宿主没装那个挂件时，切换当然看不见变化，
  // 所以先探测，再把实情写在开关下面，而不是留一个「点了没用」的开关。
  //
  // 朗读桥不能用 z-index 认：鱼世界自己的面板是 2147483002，字符串里同样含
  // 2147483000，按数字找会把自己认成朗读桥卡。改成按内容认（卡片标题写着「朗读桥」）。
  var DISPLAY_TARGETS = {
    showTts: '__tts_by_text__',
    showMood: '.fm-widget',
  }

  // 设置页是 iframe：挂件长在父窗口的文档里，只查自己这篇永远查不到 ——
  // 明明朗读桥卡就在右下角，开关下面却写「当前窗口没有这个挂件」。
  function hostDocuments() {
    var docs = [document]
    try {
      if (window.parent && window.parent !== window && window.parent.document) docs.push(window.parent.document)
    } catch (e) {}
    return docs
  }

  function displayTargetPresent(key) {
    var docs = hostDocuments()
    for (var i = 0; i < docs.length; i++) {
      if (key === 'showTts') {
        if (findTtsCardsIn(docs[i]).length > 0) return true
        continue
      }
      var selector = DISPLAY_TARGETS[key]
      if (!selector) return true
      try {
        if (docs[i].querySelector(selector) !== null) return true
      } catch (e) {
        return true
      }
    }
    return false
  }

  // 开关必须有人执行，否则就是「点了没反应」。
  // 真实教训（主人 2026-10-26「朗读桥的面板关不掉」）：探测函数与执行函数分在两个文件，
  // 面板实际加载的是 ui/panel.js（panelSource 优先取 ui/），而隐藏动作只写在
  // lib/panel.js（兜底那份）里 —— 于是这边拨开关，没人去改卡片的 display。
  // 现在由注入的这一份自己执行：进页面执行一次、之后周期性兜底、
  // 并在开关变化时立刻执行（同文档里 storage 事件与 BroadcastChannel 都收不到自己，
  // 所以还要接 dshcp:flag）。
  function applyDisplayFlags() {
    try {
      var showTts = readFlag('showTts', false)
      var showMood = readFlag('showMood', false)
      var docs = hostDocuments()
      for (var d = 0; d < docs.length; d++) {
        var doc = docs[d]
        var tts = findTtsCardsIn(doc)
        for (var i = 0; i < tts.length; i++) {
          tts[i].style.display = showTts ? '' : 'none'
        }
        var moods = doc.querySelectorAll('.fm-widget')
        for (var j = 0; j < moods.length; j++) {
          moods[j].style.display = showMood ? '' : 'none'
        }
      }
    } catch (e) {}
  }

  function watchDisplayFlags() {
    var handler = function () { applyDisplayFlags() }
    try { window.addEventListener('dshcp:flag', handler) } catch (e) {}
    try {
      window.addEventListener('storage', function (e) {
        if (e.key && e.key.indexOf('dshcp.') === 0) handler()
      })
    } catch (e) {}
    try {
      var channel = new BroadcastChannel('dshcp.sync')
      channel.onmessage = function (e) { if (e.data && e.data.key) handler() }
    } catch (e) {}
    // 挂件可能在我们之后才渲染：2 秒兜底一次（不监听 DOM，避免和大列表互相拖慢）。
    setInterval(handler, 2000)
    handler()
  }

  /** 朗读桥卡：position:fixed 且自身文字里有「朗读桥」。与 lib/panel.js 同一口径。 */
  function findTtsCardsIn(doc) {
    var out = []
    try {
      var divs = doc.querySelectorAll('div[style]')
      for (var i = 0; i < divs.length; i++) {
        var node = divs[i]
        var style = node.getAttribute('style') || ''
        if (style.indexOf('fixed') === -1) continue
        if (String(node.textContent || '').indexOf('朗读桥') === -1) continue
        out.push(node)
      }
    } catch (e) {}
    return out
  }

  function findTtsCards() {
    return findTtsCardsIn(document)
  }

  // 一行开关 + 一句实情：挂件在就只留原来那句说明，挂件不在就补一句为什么点了没反应。
  function displayFlagRow(item) {
    var absent = !displayTargetPresent(item.key)
    return switchRow({
      label: item.label,
      hint: absent ? item.hint + ' · 当前窗口没有这个挂件，开关会保存下来' : item.hint,
      checked: readFlag(item.key, item.defaultOn === true),
      onChange: function (next) { writeFlag(item.key, next) },
    })
  }

  function displayFlagRows() {
    return DISPLAY_KEYS.map(displayFlagRow)
  }

  var state = {
    view: 'overview',
    loading: {},
    errors: {},
    mood: null,
    wishes: null,
    // 请求历史按天看：空字符串 = 全部日期。
    wishDate: '',
    stickerWishes: null,
    growth: null,
    platforms: null,
    astrbot: null,
    qqagent: null,
    astrbotBusy: false,
    astrbotConnect: null,
    portrait: null,
    stickerDir: null,
    storage: null,
    activity: null,
    records: null,
    knowledge: null,
    links: null,
    doctorDep: null,
    doctorUpdate: null,
    doctorBusy: false,
    // 「更新检查」卡里一键更新的结果（就近显示，不必滑到依赖检查卡去看）
    doctorUpdateMsg: null,
    doctorStorage: null,
    doctorStorageBusy: false,
    profile: null,
    persona: null,
    tts: null,
    qqChat: null,
    chatTab: 'current',
    chatBook: null,
    chatBookLoading: false,
    chatUndo: null,
    // 保存失败时暂存「本想存的那一份」，供「重试保存」用（见 saveChatTargets）。
    chatPending: null,
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
      // 前缀窗口里 storage 事件不会回到自己，BroadcastChannel 也收不到自己发的消息，
      // 所以再派发一个同文档事件，挂件立即生效，不必等 2 秒兜底。
      try { window.dispatchEvent(new CustomEvent('dshcp:flag', { detail: { key: key } })) } catch (e) {}
      try { new BroadcastChannel('dshcp.sync').postMessage({ key: key }) } catch (e) {}
    } catch (e) {}
  }

  function today() {
    var d = new Date()
    var m = String(d.getMonth() + 1).padStart(2, '0')
    var day = String(d.getDate()).padStart(2, '0')
    return d.getFullYear() + '-' + m + '-' + day
  }

  // 会话没有标题时只显示「未命名会话」，一串 id 尾巴认不出是谁；带上创建日期至少能对上时间。
  function sessionDay(ms) {
    var n = Number(ms)
    if (!n) return ''
    var d = new Date(n)
    var pad = function (x) { return String(x).padStart(2, '0') }
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  /** 会话在一行里怎么称呼：有标题用标题，没有就带创建时间；不在本工作区的标出来。 */
  function sessionLabel(row) {
    var r = row || {}
    var text = r.title || ('未命名会话' + (r.createdAt ? ' · ' + sessionDay(r.createdAt) : ''))
    if (r.inWorkspace === false) text += '（不在本工作区）'
    return text
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
        'aria-describedby': 'fw-grip-tip-text',
        title: '按住拖动调整位置 · Alt+方向键移动',
        dataset: { cardGrip: String(opts.key || opts.title || '') },
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
    // 内容过长的卡默认只露前面一截，底部给一条「展开全部」——
    // 不预先折叠所有卡（那会让人误以为没内容），只在真的超出时才出现。
    // 折叠状态按卡片 key 记住，刷新后保持。
    if (opts.collapsible !== false && opts.key) {
      attachCollapse(node, body, String(opts.key), opts.collapsedHeight)
    }
    return node
  }

  /**
   * 给一张卡加上「内容过长时折叠」。判定放在渲染之后：量出真实高度再决定，
   * 短内容不会凭空多出一个按钮。展开/收起记在 dshcp.cardOpen.<key>。
   */
  function attachCollapse(node, body, key, collapsedHeight) {
    var limit = Number(collapsedHeight) || 320
    var open = readFlag('cardOpen.' + key, false)
    var bar = h('div', { class: 'fw-collapse-bar' })
    var btn = h('button', { class: 'fw-collapse-btn', type: 'button' })
    bar.appendChild(btn)
    node.appendChild(bar)

    function apply() {
      // 先量自然高度：临时解除限制，读 scrollHeight 再决定要不要折叠。
      node.classList.remove('fw-collapsed')
      body.style.maxHeight = ''
      var natural = body.scrollHeight
      var need = natural > limit + 40
      if (!need) {
        bar.hidden = true
        node.classList.remove('fw-collapsed')
        btn.setAttribute('aria-expanded', 'true')
        return
      }
      bar.hidden = false
      btn.setAttribute('aria-expanded', open ? 'true' : 'false')
      btn.textContent = open ? '收起' : '展开全部（还有 ' + Math.max(0, Math.round(natural - limit)) + 'px）'
      node.classList.toggle('fw-collapsed', !open)
      body.style.maxHeight = open ? '' : limit + 'px'
    }

    btn.addEventListener('click', function () {
      open = !open
      writeFlag('cardOpen.' + key, open)
      apply()
    })
    // 布局是绝对定位 + 手算高度，量完要请外层重新排一次。
    apply()
    node.__fwCollapse = apply
  }

  function statusLine(text, tone) {
    return h('p', { class: 'fw-status', dataset: { tone: tone || '' }, text: text || '' })
  }

  // 空状态：统一灰阶文字 + 可选的一行补充说明，不用笑脸或彩色插画。
  // 不给说明时只显示调用方给的那句话（多数卡片本身就是“暂无数据”的语义）。
  function emptyState(text, hint) {
    return h('div', { class: 'fw-empty' }, [
      h('p', { class: 'fw-empty-line', text: text || '暂无数据' }),
      hint ? h('p', { class: 'fw-empty-hint', text: hint }) : null,
    ])
  }

  // 状态指示：4px 灰阶圆点 + 灰阶文字，不用彩色色块。
  function statusDot(text, level) {
    return h('span', { class: 'fw-dot-status', dataset: { level: level || 'neutral' } }, [
      h('i', { class: 'fw-dot', 'aria-hidden': 'true' }),
      h('span', { text: text || '' }),
    ])
  }

  // 状态行：左侧标题，右侧状态（严格两端对齐，无边框无底纹）。
  // 超长值不换行：单行省略 + title，避免撑高卡片破坏网格。
  function infoRow(label, value, opts) {
    var o = opts || {}
    var text = value == null ? '' : String(value)
    var valueNode = o.level
      ? statusDot(text, o.level)
      : h('span', { class: 'fw-row-value', text: text, title: text })
    return h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: label, title: label }),
      valueNode,
    ])
  }

  // 幽灵按钮：透明底 + 极细边框 + 次级文字色。禁止纯白底。
  function ghostButton(label, onClick) {
    var b = h('button', { class: 'fw-btn fw-btn-ghost', type: 'button', text: label })
    b.addEventListener('click', onClick)
    return b
  }

  /**
   * 复制到剪贴板。
   *
   * 面板可能跑在 http://127.0.0.1 上，navigator.clipboard 在安全上下文外不可用，
   * 所以必须有 execCommand 兜底；两条都失败时把文本显示出来让人手动选，
   * 而不是静默失败让人以为"复制了"。
   */
  function copyText(text, onDone) {
    var value = String(text == null ? '' : text)
    if (!value) { if (onDone) onDone(false); return }
    var finish = function (ok) { if (onDone) onDone(ok) }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(function () { finish(true) }, function () { finish(legacyCopy(value)) })
      return
    }
    finish(legacyCopy(value))
  }

  function legacyCopy(value) {
    try {
      var ta = h('textarea', { class: 'fw-copy-fallback', 'aria-hidden': 'true' })
      ta.value = value
      document.body.appendChild(ta)
      ta.select()
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) { ok = false }
      document.body.removeChild(ta)
      return ok
    } catch (e) {
      return false
    }
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
        detailed ? null : h('p', { class: 'fw-card-note fw-note-end', style: 'margin-top:var(--space-3)' },
          ['需要逐项操作时切到「详细」，或直接点左侧导航进入对应分区。']),
      ],
    })

    if (!detailed) {
      return [modeBar, ...viewOverviewCompact({
        moodText: moodText, ttsText: ttsText, diaryCount: diaryCount,
        pendingWishes: pendingWishes, stageName: stageName, installed: installed,
        mood: mood, growth: growth, dep: dep,
      })]
    }

    return [modeBar, ...viewOverviewDetailed({
      moodText: moodText, ttsText: ttsText, diaryCount: diaryCount,
      pendingWishes: pendingWishes, stageName: stageName, installed: installed,
      mood: mood, growth: growth, platforms: platforms, profile: profile, dep: dep,
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
  // 抓手按下后先观察：移动超过阈值才算拖拽，单击不触发重排。
  var grabState = null
  // 抓手提示：一个全局浮层，跟着当前悬停/聚焦的抓手显示，避免每张卡各建一个节点。
  var gripTip = null

  function gripTipNode() {
    if (gripTip && gripTip.isConnected) return gripTip
    gripTip = h('div', {
      class: 'fw-grip-tip',
      id: 'fw-grip-tip-text',
      role: 'status',
      text: '按住拖动调整位置 · Alt+方向键移动',
    })
    return gripTip
  }

  function showGripTip(grid, grip) {
    var node = gripTipNode()
    // 挂在 body 上、贴着抓手下方显示：不占网格，也不会压住卡片标题与正文
    if (node.parentNode !== document.body) document.body.appendChild(node)
    var rect = grip.getBoundingClientRect()
    node.style.left = Math.round(rect.left) + 'px'
    node.style.top = Math.round(rect.bottom + 6) + 'px'
    node.dataset.open = 'true'
    node.dataset.for = grip.dataset.cardGrip || ''
  }

  function hideGripTip() {
    if (gripTip && gripTip.parentNode) gripTip.dataset.open = 'false'
  }

  function registerCard(node) {
    cardRegistry.push(node)
  }

  function cardOrderKey(node) {
    return node && node.dataset ? node.dataset.cardKey : ''
  }

  /** 参与重排的卡片：有 key 的才动，模式切换条这类固定的始终排在最前。 */
  function movableCards(grid) {
    return [...grid.children].filter((el) => el.classList && el.classList.contains('fw-card') && cardOrderKey(el))
  }

  /** 网格里的全部卡片（含不可拖的固定条）。排版必须照顾到每一张，
      否则没有 key 的卡片拿不到 left/top，绝对定位下会叠到左上角。 */
  function allCards(grid) {
    return [...grid.children].filter((el) => el.classList && el.classList.contains('fw-card'))
  }

  function cardByKey(grid, key) {
    if (!key) return null
    return [...grid.children].find((el) => el.classList && el.classList.contains('fw-card') && cardOrderKey(el) === key) || null
  }

  function readOrder(grid) {
    return movableCards(grid).map(cardOrderKey)
  }

  // 每个分区各自保存一份顺序：在日记页拖动不会打乱收藏页。
  function orderKey() {
    return 'dshcp.cardOrder.' + (state.view || 'overview')
  }

  function persistOrder(grid) {
    try {
      localStorage.setItem(orderKey(), JSON.stringify(readOrder(grid)))
    } catch (e) {}
  }

  function savedOrder() {
    try {
      var raw = localStorage.getItem(orderKey())
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
    var savedKeys = order.filter((key) => byKey.has(key))
    // 存档里有、页面上已经没有的卡（被拆掉 / 改名了）说明这份顺序过期了。
    // 这时把整个存档作废、回到代码里的默认顺序：否则新加的卡会被挤到末尾，
    // 「SnowLuma 直连」就会莫名其妙排到「经由 AstrBot」后面（真出现过）。
    var stale = order.length !== savedKeys.length
    if (stale) {
      try { localStorage.removeItem(orderKey()) } catch (e) {}
    }
    var placed = []
    for (var key of savedKeys) {
      var node = byKey.get(key)
      if (node && placed.indexOf(node) < 0) placed.push(node)
    }
    // 顺序里没提到的卡（本次新加的）保持代码里的位置：插到「它原本紧挨着的上一张卡」后面，
    // 而不是一律甩到末尾。
    var unresolved = nodes.filter((node) => placed.indexOf(node) < 0)
    if (!stale && unresolved.length) {
      for (var pending of unresolved) {
        var prev = null
        for (var i = nodes.indexOf(pending) - 1; i >= 0; i -= 1) {
          if (placed.indexOf(nodes[i]) >= 0) { prev = nodes[i]; break }
        }
        var at = prev ? placed.indexOf(prev) + 1 : 0
        placed.splice(at, 0, pending)
      }
    } else {
      for (var rest of unresolved) placed.push(rest)
    }
    // 可拖拽的卡片按保存顺序排，不可拖拽的（如模式切换条）始终在最前
    var fixed = placed.filter((node) => !cardOrderKey(node))
    var movable = placed.filter((node) => cardOrderKey(node))
    for (var n of fixed.concat(movable)) grid.appendChild(n)
  }

  // ---------- 网格引擎（数据驱动，等价 react-grid-layout） ----------
  // 为什么不用 CSS Grid 自动排版：拖动时卡片一旦脱离文档流，grid 行高就会重算，
  // 出现高度塌陷、空洞、卡片消失。这里改成手算位置：每张卡有 { x, y, w, h }，
  // 位置由数据决定、卡片绝对定位，拖动只改数据不动结构，网格永远不会崩。
  //  - 12 列；列宽按容器宽度实时算，随窗口缩放自适应
  //  - compactType: vertical —— 每张卡吸附到放得下的最靠上位置，中间不留断层
  //  - 允许挤压（preventCollision: false）—— 后来的卡自然被推下去
  var GRID_GAP = 16
  var gridState = { drag: null, placeholder: null, layout: null, raf: 0, width: 0 }

  function gridInnerWidth(grid) {
    var style = window.getComputedStyle(grid)
    var padL = parseFloat(style.paddingLeft) || 0
    var padR = parseFloat(style.paddingRight) || 0
    return Math.max(0, grid.clientWidth - padL - padR)
  }

  function colUnit(width) {
    return (width - GRID_GAP * 11) / 12
  }

  function cardWidth(width, span) {
    return span * colUnit(width) + (span - 1) * GRID_GAP
  }

  function colOffset(width, col) {
    return col * (colUnit(width) + GRID_GAP)
  }

  /** 窄屏一律通栏：12 列在窄窗口里放不下两张并排的卡。 */
  function effectiveSpan(node, width) {
    // 560px 以下（手机/窄侧栏）不再分栏；再宽就按卡片声明的跨度
    return width < 560 ? 12 : spanOf(node)
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5
      && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5
  }

  /**
   * 12 列密集排布：按传入顺序，每张卡放到“能容纳它的最靠上、最靠左”的位置。
   * 即 react-grid-layout 的 compactType="vertical"：卡片总往上贴、不留断层，
   * 放不下的卡被挤到下一排。
   */
  function packCards(items, width) {
    var placed = []
    for (var item of items) {
      var span = Math.max(1, Math.min(12, Number(item.w) || 12))
      var w = cardWidth(width, span)
      var rows = new Set([0])
      for (var p of placed) rows.add(p.y + p.h + GRID_GAP)
      var spot = null
      for (var y of [...rows].sort(function (a, b) { return a - b })) {
        for (var col = 0; col + span <= 12; col += 1) {
          var rect = { x: colOffset(width, col), y: y, w: w, h: item.h }
          var clash = false
          for (var q of placed) {
            if (rectsOverlap(rect, q)) { clash = true; break }
          }
          if (clash) continue
          spot = { node: item.node, x: rect.x, y: rect.y, w: w, h: item.h, col: col, span: span }
          break
        }
        if (spot) break
      }
      if (!spot) {
        // 兜底：真放不下就排到最底下，绝不丢卡片
        var bottom = placed.reduce(function (m, p) { return Math.max(m, p.y + p.h) }, 0)
        spot = { node: item.node, x: 0, y: placed.length ? bottom + GRID_GAP : 0, w: w, h: item.h, col: 0, span: span }
      }
      placed.push(spot)
    }
    return placed
  }

  /**
   * 同行等高：把 y 区间重叠的卡片视为同一行，取其中最高的作为整行高度。
   * 这样「成长概况 + 成长记录」并排时底边对齐（等价 CSS Grid 的 align-items: stretch），
   * 但不会像 Grid 那样在拖动时重算行高导致塌陷。
   */
  function equalizeRows(placed) {
    var groups = []
    for (var p of placed.slice().sort(function (a, b) { return a.y - b.y })) {
      var hit = null
      for (var g of groups) {
        if (p.y < g.bottom && g.top < p.y + p.h) { hit = g; break }
      }
      if (hit) {
        hit.items.push(p)
        hit.top = Math.min(hit.top, p.y)
        hit.bottom = Math.max(hit.bottom, p.y + p.h)
      } else {
        groups.push({ top: p.y, bottom: p.y + p.h, items: [p] })
      }
    }
    for (var group of groups) {
      var maxH = 0
      for (var item of group.items) maxH = Math.max(maxH, item.h)
      for (var row of group.items) row.h = maxH
    }
    return placed
  }

  /** 先排布、再把同行拉到等高，重复到高度稳定（最多 3 轮，避免抖动）。 */
  function layoutCards(items, width) {
    var heights = items.map(function (item) { return item.h })
    var layout = equalizeRows(packCards(items, width))
    for (var round = 0; round < 2; round += 1) {
      // 等高后某些行变高，下面的行要按新高度重新排，否则会互相压住
      var next = items.map(function (item, index) {
        return { node: item.node, w: item.w, h: layout[index] ? layout[index].h : heights[index] }
      })
      var changed = next.some(function (item, index) { return Math.abs(item.h - heights[index]) > 0.5 })
      heights = next.map(function (item) { return item.h })
      if (!changed) break
      layout = equalizeRows(packCards(next, width))
    }
    return layout
  }

  /** 量高度：先按跨度定宽度并强制重排，再读自然高度——内容不会被裁掉。 */
  function measureCards(grid, nodes) {
    var width = gridInnerWidth(grid)
    // 第一遍：把所有卡的宽度写死，让换行结果稳定下来（否则高度会按旧宽度算）
    var spans = new Map()
    for (var node of nodes) {
      var span = effectiveSpan(node, width)
      spans.set(node, span)
      node.style.position = 'absolute'
      node.style.width = cardWidth(width, span) + 'px'
      node.style.height = ''
    }
    void grid.offsetWidth
    // 第二遍：现在读到的才是这套宽度下的真实高度
    var items = []
    for (var item of nodes) {
      items.push({ node: item, w: spans.get(item), h: Math.max(1, item.offsetHeight) })
    }
    return { width: width, items: items }
  }

  function applyLayout(grid, layout, opts) {
    var animate = Boolean(opts && opts.animate)
    var skip = opts && opts.skip
    for (var spot of layout) {
      var node = spot.node
      if (!node || node === skip) continue
      node.style.transition = animate ? 'top 160ms ease-out, left 160ms ease-out, height 160ms ease-out' : 'none'
      node.style.left = spot.x + 'px'
      node.style.top = spot.y + 'px'
      node.style.width = spot.w + 'px'
      // 同行等高：显式给高度，卡片内容在内部自己排（body 撑满）
      node.style.height = spot.h + 'px'
    }
    var bottom = layout.reduce(function (m, p) { return Math.max(m, p.y + p.h) }, 0)
    grid.style.minHeight = bottom + 'px'
  }

  function slotOf(layout, node) {
    if (!layout) return null
    for (var spot of layout) if (spot.node === node) return spot
    return null
  }

  /** 重新量高度并排布；animate=true 时其它卡片平滑让位（160ms ease-out）。
      注意：不可拖的固定卡（模式切换条）也要参与排版，占住它在最上方的整行。 */
  function relayout(grid, opts) {
    grid = grid || main
    if (!grid) return
    var nodes = allCards(grid)
    if (!nodes.length) {
      grid.style.minHeight = ''
      gridState.layout = null
      return
    }
    var measured = measureCards(grid, nodes)
    var layout = layoutCards(measured.items, measured.width)
    applyLayout(grid, layout, opts)
    gridState.layout = layout
    gridState.width = measured.width
  }

  function scheduleRelayout(grid, opts) {
    if (gridState.raf) window.cancelAnimationFrame(gridState.raf)
    gridState.raf = window.requestAnimationFrame(function () {
      gridState.raf = 0
      relayout(grid, opts)
    })
  }

  // ---------- 拖拽（位置驱动，不交换 DOM） ----------
  function startCardDrag(state, event) {
    var grid = state.grid
    var node = state.node
    if (!gridState.layout) relayout(grid)
    var spot = slotOf(gridState.layout, node)
    if (!spot) return

    hideGripTip()
    var placeholder = h('div', { class: 'fw-card-placeholder' })
    placeholder.style.width = spot.w + 'px'
    placeholder.style.height = spot.h + 'px'
    placeholder.style.left = spot.x + 'px'
    placeholder.style.top = spot.y + 'px'

    node.classList.add('fw-card-dragging')
    node.style.transition = 'none'
    node.style.transform = ''
    node.style.zIndex = '50'
    grid.appendChild(placeholder)

    gridState.placeholder = placeholder
    gridState.drag = {
      grid: grid,
      node: node,
      // 不可拖的固定卡（模式切换条）始终排在最前，拖拽时也要一起参与排版
      fixed: allCards(grid).filter(function (card) { return !cardOrderKey(card) }),
      order: movableCards(grid).filter(function (card) { return card !== node }),
      pendingOrder: null,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    }
    window.addEventListener('pointermove', onCardDragMove)
    window.addEventListener('pointerup', onCardDragEnd)
    window.addEventListener('pointercancel', onCardDragEnd)
  }

  function onCardDragMove(event) {
    var drag = gridState.drag
    if (!drag) return
    var dx = event.clientX - drag.startX
    var dy = event.clientY - drag.startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
    // 被拖的卡只跟随指针（transform），不参与这一轮排版计算
    drag.node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'

    // 插入位置：离指针最近的那张卡，按指针在它左/右半边决定插前插后
    var target = null
    var best = Infinity
    for (var card of drag.order) {
      var rect = card.getBoundingClientRect()
      var distance = Math.hypot(
        event.clientX - (rect.left + rect.width / 2),
        event.clientY - (rect.top + rect.height / 2),
      )
      if (distance < best) { best = distance; target = card }
    }

    var order = drag.order.slice()
    if (target) {
      var tr = target.getBoundingClientRect()
      var at = order.indexOf(target) + (event.clientX > tr.left + tr.width / 2 ? 1 : 0)
      order.splice(at, 0, drag.node)
    } else {
      order.push(drag.node)
    }
    // 固定卡（模式切换条）永远在最前，不参与可拖卡的插入顺序
    var full = drag.fixed.concat(order)

    var measured = measureCards(drag.grid, full)
    var layout = layoutCards(measured.items, measured.width)
    // 其它卡片平滑让位；被拖的卡保持跟随指针
    applyLayout(drag.grid, layout, { animate: true, skip: drag.node })
    gridState.layout = layout
    drag.pendingOrder = order
    drag.order = order.filter(function (card) { return card !== drag.node })

    // 占位符停在“松手会落到”的位置，尺寸与被拖卡片一致
    var slot = slotOf(layout, drag.node)
    var placeholder = gridState.placeholder
    if (slot && placeholder) {
      placeholder.style.width = slot.w + 'px'
      placeholder.style.height = slot.h + 'px'
      placeholder.style.left = slot.x + 'px'
      placeholder.style.top = slot.y + 'px'
    }
  }

  function onCardDragEnd() {
    var drag = gridState.drag
    if (!drag) return
    gridState.drag = null
    window.removeEventListener('pointermove', onCardDragMove)
    window.removeEventListener('pointerup', onCardDragEnd)
    window.removeEventListener('pointercancel', onCardDragEnd)

    var grid = drag.grid
    var node = drag.node
    var placeholder = gridState.placeholder
    gridState.placeholder = null
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder)

    node.classList.remove('fw-card-dragging')
    node.style.transform = ''
    node.style.transition = 'none'
    node.style.zIndex = ''

    // 只是点了一下抓手（没拖动）：保持原顺序
    if (!drag.moved) {
      relayout(grid, { animate: false })
      return
    }

    // 落地：DOM 顺序按刚才算好的新顺序写一遍，再瞬间吸附（无弹簧/惯性）。
    // 固定卡片（无 key，如模式切换条）必须始终排在最前，否则会被 append 到后面去。
    var fixedCards = drag.fixed && drag.fixed.length
      ? drag.fixed
      : [...grid.children].filter(function (el) {
        return el.classList && el.classList.contains('fw-card') && !cardOrderKey(el)
      })
    var movable = drag.pendingOrder || movableCards(grid)
    for (var card of fixedCards.concat(movable)) grid.appendChild(card)
    relayout(grid, { animate: false })
    persistOrder(grid)
  }

  /** 键盘重排：抓手 Tab 聚焦后 Alt + 方向键，与拖拽共用同一套排布。 */
  function moveCardByKeyboard(grid, node, delta) {
    var order = movableCards(grid).slice()
    var from = order.indexOf(node)
    if (from < 0) return
    var to = Math.max(0, Math.min(order.length - 1, from + delta))
    if (to === from) return
    order.splice(to, 0, order.splice(from, 1)[0])
    // 固定卡片同样要留在最前。
    var fixed = [...grid.children].filter(function (el) {
      return el.classList && el.classList.contains('fw-card') && !cardOrderKey(el)
    })
    for (var card of fixed.concat(order)) grid.appendChild(card)
    relayout(grid, { animate: true })
    persistOrder(grid)
  }

  function canDrag() {
    // 设置页（iframe）里也允许拖拽：主人在 DSH 里看到的正是这个页面。
    // 只有显式声明为不可拖（例如嵌入预览探针）时才关掉。
    // SETTINGS_MODE 只影响布局留白，不再影响交互。
    return window.__DSH_FISH_WORLD_NO_DRAG__ !== true
  }

  function bindDragAndDrop(grid) {
    // 抓手提示：只在悬停/聚焦抓手时出现；离开就收起。
    grid.addEventListener('pointerover', function (event) {
      var grip = event.target.closest && event.target.closest('.fw-grip')
      if (grip && grid.contains(grip)) showGripTip(grid, grip)
    })
    grid.addEventListener('pointerout', function (event) {
      var grip = event.target.closest && event.target.closest('.fw-grip')
      if (!grip) return
      var next = event.relatedTarget
      if (next && grip.contains(next)) return
      hideGripTip()
    })
    grid.addEventListener('focusin', function (event) {
      var grip = event.target.closest && event.target.closest('.fw-grip')
      if (grip) showGripTip(grid, grip)
      else hideGripTip()
    })
    grid.addEventListener('focusout', function () {
      hideGripTip()
    })

    // 只有抓手能发起拖拽：按下后移动超过 5px 才开始，单击不重排
    grid.addEventListener('pointerdown', function (event) {
      if (!canDrag() || event.button !== 0) return
      var grip = event.target.closest && event.target.closest('.fw-grip')
      if (!grip) return
      var node = grip.closest('.fw-card')
      if (!node || !cardOrderKey(node)) return

      event.preventDefault()
      grabState = {
        grid: grid,
        node: node,
        grip: grip,
        startX: event.clientX,
        startY: event.clientY,
      }
      window.addEventListener('pointermove', onGrabMove)
      window.addEventListener('pointerup', cancelGrab)
      window.addEventListener('pointercancel', cancelGrab)
      window.addEventListener('blur', cancelGrab)
    })

    grid.addEventListener('keydown', function (event) {
      if (!canDrag()) return
      var grip = event.target.closest && event.target.closest('.fw-grip')
      if (!grip || !event.altKey) return
      var node = grip.closest('.fw-card')
      if (!node) return
      var delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0
      if (!delta) return
      event.preventDefault()
      moveCardByKeyboard(grid, node, delta)
      var nextGrip = node.querySelector('.fw-grip')
      if (nextGrip) nextGrip.focus()
    })

    // 窗口尺寸变化：列宽变了，重新排布（高度也跟着重量）
    window.addEventListener('resize', function () {
      if (gridState.drag) return
      var width = gridInnerWidth(grid)
      if (Math.abs(width - gridState.width) < 1) return
      scheduleRelayout(grid, { animate: false })
    })
  }

  function spanOf(node) {
    for (var n = 3; n <= 12; n += 1) {
      if (node.classList.contains('fw-span-' + n)) return n
    }
    return 12
  }

  // 按下抓手后先观察：移动超过 5px 才进入拖拽，单击不重排。
  function onGrabMove(event) {
    if (!grabState) return
    var dx = event.clientX - grabState.startX
    var dy = event.clientY - grabState.startY
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return
    var state = grabState
    cancelGrab()
    startCardDrag(state, event)
  }

  function cancelGrab() {
    if (!grabState) return
    grabState = null
    window.removeEventListener('pointermove', onGrabMove)
    window.removeEventListener('pointerup', cancelGrab)
    window.removeEventListener('pointercancel', cancelGrab)
    window.removeEventListener('blur', cancelGrab)
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
    if (ctx.dep && ctx.dep.ok === false) todo.push({ text: '体检发现缺失项', target: 'doctor', label: '去体检' })
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
        note: '心情与情绪维度',
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
        prose: fishLine('wishes'),
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

      // 第三行：平台 / 设置 / 收藏，各占 3 或 4
      dataCard({
        title: '鱼与世界',
        note: (installed == null ? '读取中' : installed + ' / 3'),
        span: 3,
        prose: 'QQ、B 站、抖音各自独立，外发默认关闭。',
        action: '管理',
        onAction: function () { navigate('platforms') },
      }),
      dataCard({
        title: '鱼的设定',
        note: profile && profile.fish ? (profile.fish.name || '鱼') : '读取中',
        span: 3,
        prose: '名字、称呼、角色卡与人设。',
        action: '设置',
        onAction: function () { navigate('profile') },
      }),
      dataCard({
        title: '鱼之宝库',
        note: state.stickers ? ((state.stickers.items || []).length + ' 张图片') : '读取中',
        span: 3,
        prose: '表情图片与网站收藏。',
        action: '查看',
        onAction: function () { navigate('stickers') },
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
          infoRow('体检', dep ? (dep.ok ? '通过' : '待处理') : '未运行', { level: dep ? (dep.ok ? 'ok' : 'error') : 'neutral' }),
          infoRow('更新检查', '需联网手动触发'),
        ],
        action: '去体检',
        onAction: function () { navigate('doctor') },
      }),
      dataCard({
        title: '鱼的样子',
        note: state.portrait ? (state.portrait.emotionLabel || '平静') : '读取中',
        span: 4,
        prose: '头像随心情变化，可自己上传。',
        action: '看状态',
        onAction: function () { navigate('status') },
      }),

      card({
        key: 'display-flags',
        title: '面板显示',
        note: '默认隐藏项可随时恢复',
        span: 6,
        children: displayFlagRows(),
      }),
      card({
        key: 'capability-summary',
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
      // 日期筛选在前端做：路由按精确路径匹配，带查询串会 400
      if (state.diaryDate) {
        entries = entries.filter(function (item) { return String(item.at || '').slice(0, 10) === state.diaryDate })
      }

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
      card({ key: 'diary', title: '鱼的日记', note: '主人查看与批阅', span: 12, children: children }),
      // 主人与鱼：主人做过的批阅互动汇总，放在日记下方方便回看
      card({ key: 'diary-interactions', title: '主人与鱼', note: '批阅互动记录', span: 12, children: [renderInteractions(data)] }),
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

  // 卡片上的小字：不写说明书，写「鱼此刻会说的那一句」。
  //
  // 规则：≤18 字、第一人称、随当前状态与情绪抽；只在「进入分区」时重抽一次，
  // 同一界面内重绘保持同一句，否则每次刷新换字会闪。要写清操作方法的说明，
  // 放进行内的 hint 或字段标签，不占用这一句。
  var FISH_LINES = {
    // 请求：鱼在等主人回话
    wishes: [
      '希望主人答应',
      '等主人批复',
      '盼你点个头',
      '想听你说可以',
      '在等你回话',
      '求求主人了',
      '真的想要嘛',
      '就等你一句话',
    ],
    // 请求页里「鱼想收藏」的空态：没在要东西，但还惦记着
    wishesEmpty: [
      '今天还没捞到好货',
      '暂时没想要的图',
      '还没看到想收的',
      '先不闹，等有喜欢的',
      '图库空着有点寂寞',
    ],
    // 头像卡：按当前情绪说一句，让「样子」和「心情」是同一件事
    portrait: {
      happy: ['今天心情很好', '想蹦一下', '笑到藏不住'],
      calm: ['平静的样子', '今天挺安稳', '就这样待着'],
      sweet: ['有点想你', '说话想带糖', '心里甜甜的'],
      heartache: ['心口有点疼', '有点难受', '想被你问问'],
      worry: ['有点不踏实', '你在吗', '心里悬着'],
      sad: ['情绪有点低', '想安静会儿', '有点想哭'],
      jealous: ['有点吃醋了', '刚才那句不是我吧', '哼，不理你'],
    },
  }

  // portrait.mjs 除了情绪 key 还会给五档（great/good/ok/low/bad）与 neutral。
  // 不映射的话「情绪很低」会被当成平静，那句小字就成了假话。
  var FISH_MOOD_ALIAS = {
    great: 'happy', good: 'happy', ok: 'calm', low: 'sad', bad: 'sad', neutral: 'calm',
  }

  // 已抽中的句子：按 key 缓存，进入分区时整表重抽。
  // lastFishPick 单独记录上一次抽到哪句，避免连点两次随机出同一句看着像没动。
  var currentFishLines = {}
  var lastFishPick = {}

  /** 抽一句鱼的话。pool 里可以是数组，也可以是「情绪 → 数组」的表。 */
  function fishLine(key, mood) {
    var cacheKey = mood ? key + ':' + mood : key
    if (currentFishLines[cacheKey]) return currentFishLines[cacheKey]
    var pool = FISH_LINES[key] || []
    if (pool && !Array.isArray(pool)) {
      var emotion = FISH_MOOD_ALIAS[mood] || mood
      pool = pool[emotion] || pool.calm || []
    }
    if (!pool.length) return ''
    // 同一分区里连着抽到同一句会看起来「没随机」，所以避开上一次的结果。
    var pick = pool[Math.floor(Math.random() * pool.length)]
    if (pool.length > 1) {
      let guard = 0
      while (pick === lastFishPick[cacheKey] && guard < 4) {
        pick = pool[Math.floor(Math.random() * pool.length)]
        guard += 1
      }
    }
    lastFishPick[cacheKey] = pick
    currentFishLines[cacheKey] = pick
    return pick
  }

  /** 进入分区时重新抽；同一屏内的重绘不换字。 */
  function reshuffleFishLines() {
    currentFishLines = {}
  }

  // ---- 鱼想收藏：鱼挑中的图，主人点头才进库 ----
  function loadStickerWishes() {
    return getJSON('/dsh-fish-world/world/sticker-wishes')
      .then(function (d) {
        state.stickerWishes = d
        // 成功后要把上一次的错误清掉，否则修好了界面还在报旧错。
        delete state.errors.stickerWishes
      })
      .catch(function (e) { state.errors.stickerWishes = e.message })
      // 少了这一句，卡片会永远停在「读取中…」，直到别处碰巧触发重绘。
      .then(render)
  }

  function renderStickerWishesCard() {
    var data = state.stickerWishes
    var body = []
    if (state.errors.stickerWishes) {
      body.push(statusLine('读取失败：' + state.errors.stickerWishes, 'error'))
    } else if (!data) {
      body.push(statusLine('读取中…'))
    } else {
      var items = data.items || []
      if (!items.length) {
        body.push(emptyState(fishLine('wishesEmpty') || '现在没有想收的图。'))
      } else {
        body.push(h('div', { class: 'fw-gallery-grid' }, items.map(function (item) {
          var img = h('img', {
            class: 'fw-gallery-img',
            src: '/dsh-fish-world/sticker-wish-image?id=' + encodeURIComponent(item.id),
            alt: item.name || '想收的图',
            loading: 'lazy',
          })
          img.addEventListener('error', function () { img.hidden = true })

          function decide(accept) {
            postJSON('/dsh-fish-world/world/sticker-wishes', { id: item.id, accept: accept })
              .then(function () { return Promise.all([loadStickerWishes(), loadStickers()]) })
              .catch(function (e) { setError('stickerWishes', e.message) })
          }

          return h('figure', { class: 'fw-gallery-item' }, [
            h('div', { class: 'fw-gallery-frame' }, [img]),
            h('figcaption', { class: 'fw-gallery-meta' }, [
              h('span', { class: 'fw-sticker-name', text: item.name || '未命名', title: item.name || '未命名' }),
              h('span', { class: 'fw-sticker-tags', text: item.reason || '', title: item.reason || '' }),
            ]),
            h('div', { class: 'fw-btn-row' }, [
              button('收下', function () { decide(true) }, 'primary'),
              button('不要', function () { decide(false) }),
            ]),
          ])
        })))
      }
    }
    return card({ key: 'sticker-wishes', title: '鱼想收藏', note: '我挑中的图，你点头才进库', span: 6, children: body })
  }

  // 请求的类别是自由文本（鱼想提什么就提什么），这里只把常见的翻成人话；
  // 不认识的照原样显示 —— 别把鱼的话吞掉。
  var WISH_KIND_LABELS = { wish: '请求', persona: '想改自己的设定', collect: '想收的东西', habit: '想改的相处方式' }
  function wishKindLabel(kind) {
    var raw = String(kind || '').trim()
    if (!raw) return '请求'
    return WISH_KIND_LABELS[raw] || raw
  }
  // 想改人设的请求：面板给个直达「鱼的设定」的入口。人设不会被自动改 ——
  // 那一步只能主人自己动手，请求只是把"想变成什么样"写下来。
  // 只认 kind，不扫正文：「设定 / 角色卡」这类词在别的请求里太常见（比如「想改一下回复的设定」），
  // 扫正文会让不相干的请求平白多一句提示和一个按钮。宁可偶尔少个按钮 —— 鱼要这条就在 kind 里写 persona。
  var PERSONA_KINDS = ['persona', '人设', '设定', '角色卡']
  function isPersonaWish(item) {
    var kind = String((item && item.kind) || '').trim().toLowerCase()
    return PERSONA_KINDS.indexOf(kind) >= 0
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

      // 小字留给鱼的那一句（卡片头部 note）；「批复会影响鱼」这类操作说明
      // 挪到下面那行的 hint 里，不占小字的位置，也不再和鱼的话重复。
      // 每天最多 3 个请求，零点重置；当天没被回复的会进鱼的小本本。
      if (data.dailyLimit != null) {
        children.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label' }, [
            h('span', { text: '今天还能提' }),
            h('span', {
              class: 'fw-row-hint',
              // limitNote 自己带句号，直接拼会成「…。；你的…」，先剥掉再连。
              text: String(data.limitNote || '每天最多 ' + data.dailyLimit + ' 个，零点重置')
                .replace(/[。；;]\s*$/, '') + '；你的批复会影响鱼。',
            }),
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

      // 按天归档的历史不在这一页：它和平台留存同属「留了什么」，
      // 统一放在「扩展与设置 → 本地存储」里按天浏览。
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
              h('span', { text: wishKindLabel(item.kind) }),
            ]),
            h('p', { class: 'fw-item-text', text: item.text || '（空）' }),
            h('div', { class: 'fw-row', style: 'margin-top:var(--space-2)' }, [
              h('span', { style: 'flex:1;min-width:0' }, [replyInput]),
              h('span', { style: 'width:110px;flex:none' }, [toneSelect]),
            ]),
            isPersonaWish(item)
              ? h('p', { class: 'fw-row-hint', text: '人设得你自己在「鱼的设定」里改；这条请求只是把想变成什么样写下来了。' })
              : null,
            h('div', { class: 'fw-btn-row' }, [
              button('同意', function () { decide(true) }, 'primary'),
              button('拒绝', function () { decide(false) }),
              isPersonaWish(item) ? button('去改人设', function () { navigate('profile') }) : null,
            ].filter(Boolean)),
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

    // 这一页四张卡的内容量差得很远：请求卡有「今天还能提 + 待处理 + 已处理」三段，
    // 收藏卡经常只有一句空态。并排就得等高，空的那张会被拉到六七百像素、留一大片空白。
    // 所以按内容分两层：请求与记录各自成行（它们会长），收藏与小本本放在同一行
    // （两者都短，等高不吃亏）。跨度用 12 / 12 / 6 / 6，不硬凑成 6/6/6/12。
    return [
      card({ key: 'wishes', title: '鱼的请求', note: fishLine('wishes'), span: 12, children: children }),
      renderRecordsCard(),
      renderStickerWishesCard(),
      renderGrudgeCard(),
    ]
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

    // 记忆卡不跟着成长读数的成败走：成长那半边挂了，记忆照样能管。
    var memoryCard = card({
      key: 'growth-memory',
      title: '鱼的记忆',
      note: '梗、角色、外观、约定——她认得的和记得的',
      span: 12,
      children: knowledgeChildren(),
    })

    if (state.errors.growth) {
      return [card({ key: 'growth-error', title: '鱼的成长', span: 12, children: [statusLine('读取失败：' + state.errors.growth, 'error')] }), memoryCard]
    }
    if (!data) {
      return [card({ key: 'growth-loading', title: '鱼的成长', span: 12, children: [statusLine('读取中…')] }), memoryCard]
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

    // ---- 卡 4：鱼的记忆（知识库 + 外观设定 + 向量档）----
    // 成长是「想明白了什么」，记忆是「认得了什么」，两者都是越攒越多的东西，放同一页才顺。
    cards.push(memoryCard)

    // 「本地存储」不在这页：它是「文件都落在哪、留了些什么」，属于运维，
    // 已搬到「扩展与设置」与存储位置放一起。

    return cards
  }

  // ---- 体检与更新 ----
  var UPDATE_STATUS_LABELS = {
    current: '已是最新',
    outdated: '有新版本',
    'not-installed': '未安装',
    unavailable: '查不到',
  }

  // 重新拉一次体检结果，供安装后刷新
  function loadDoctor() {
    return getJSON('/dsh-fish-world/doctor/dependency')
      .then(function (d) { state.doctorDep = d; delete state.errors.doctorDep })
      .catch(function (e) { state.errors.doctorDep = e.message })
      .then(render)
  }

  // 体检页的卡片布局：保证每一行都刚好填满 12 列，不留视觉真空。
  // n=1 → 12；n=2 → 6/6；n=3 → 4/4/4；n=4 → 6/6 + 6/6；n=5 → 4/4/4 + 6/6；
  // n=6 → 4/4/4 + 4/4/4；余数 1 时并进上一行，绝不留下孤卡。
  // 体检页布局：按每张卡自己声明的 span 排，不再盲目三等分。
  // 没有声明跨度的卡片才按剩余数量兜底分配，保证每行刚好填满 12 列。
  function layoutDoctorRows(entries) {
    var out = []
    entries.forEach(function (entry) {
      out.push(card({
        key: entry.key,
        title: entry.title,
        note: entry.note,
        span: entry.span || 12,
        children: entry.body,
      }))
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

  // 体检页：三张卡——依赖检查（本机数值 + 操作）、依赖清单（到底装了什么）、
  // 版本更新（联网查新版）。检查与清单拆开，是因为信息密度完全不同：
  // 数值卡窄，清单卡宽；版本更新还要放「当前 → 最新」的长行，必须通栏。
  function viewDoctor() {
    var dep = state.doctorDep
    var up = state.doctorUpdate
    var entries = []
    // 更新结果里只要有一项 outdated，按钮就切成「一键更新」
    var hasUpdates = Boolean(up && up.counts && Number(up.counts.outdated) > 0)
    // 缺必需依赖 → 一键安装依赖；只剩可选依赖（抖音 / 朗读桥）没装 →
    // 按钮改叫「安装可选依赖」，并显式带上 includeOptional，免得点了什么也没发生。
    var depCounts = (dep && dep.counts) || {}
    var requiredMissing = Number(depCounts.missing || 0)
    var optionalMissing = Number(depCounts.optionalMissing || 0)
    var hasMissing = requiredMissing > 0 || optionalMissing > 0
    var onlyOptionalMissing = requiredMissing === 0 && optionalMissing > 0

    var savedAction = state.doctorAction || null
    var depStatus = statusLine(savedAction ? savedAction.text : '', savedAction ? savedAction.tone : '')
    // 安装/更新/解除完成后要重新拉一次结果，但 render() 会重建卡片、把状态行清空。
    // 所以把最后一条结果记进 state，重建后照样显示——不然「更新完成」一闪就没了。
    function setDepStatus(text, tone) {
      state.doctorAction = text ? { text: text, tone: tone || '' } : null
      depStatus.textContent = text || ''
      depStatus.dataset.tone = tone || ''
    }

    // ---- 卡一：依赖检查（只看本机，不联网） ----
    var checkBody = [
      h('p', { class: 'fw-card-note', text: '只看本机：装了没、Node 版本、鱼箱隔离。安装 / 更新 / 解除都在这一张卡里。' }),
    ]
    if (state.errors.doctorDep) {
      checkBody.push(statusLine('读取失败：' + state.errors.doctorDep, 'error'))
    } else if (dep) {
      var counts = dep.counts || {}
      var platformCounts = counts.platforms || null
      checkBody.push(numRow('依赖已安装 / 总数', String(counts.installed || 0) + ' / ' + String(counts.total || 0)))
      if (platformCounts) {
        checkBody.push(numRow('平台前置', String(platformCounts.installed || 0) + ' / ' + String(platformCounts.total || 0), {
          level: platformCounts.missing ? 'warn' : 'ok',
        }))
      }
      checkBody.push(numRow('鱼世界版本', (dep.self && dep.self.version) || '未知'))
      checkBody.push(numRow('Node', (dep.node && dep.node.version) || '—', {
        level: dep.node && dep.node.ok ? 'ok' : 'error',
      }))
      checkBody.push(numRow('鱼箱隔离', dep.tank && dep.tank.ok ? '正常' : '待检查', {
        level: dep.tank && dep.tank.ok ? 'ok' : 'warn',
      }))
      if (dep.wiring && dep.wiring.checked === false) {
        checkBody.push(h('p', { class: 'fw-card-note', text: '未检测到 profile 目录，接线检查跳过。' }))
      }
      if (dep.wiring && dep.wiring.ok === false) {
        checkBody.push(statusLine('接线异常：' + (dep.wiring.issues || []).map(function (i) { return i.message }).join('；'), 'error'))
      }
    } else if (state.doctorBusy) {
      checkBody.push(statusLine('检查中…'))
    } else {
      checkBody.push(emptyState('还没检查过本机依赖。'))
    }

    // 操作：体检 / 补装 / 解除安装。解除安装不可逆，仍然两步确认。
    var depButtons = [
      ghostButton(state.doctorBusy ? '检查中…' : '体检', function () {
        if (state.doctorBusy) return
        setDepStatus('')
        state.doctorBusy = true
        render()
        getJSON('/dsh-fish-world/doctor/dependency')
          .then(function (d) { state.doctorDep = d; delete state.errors.doctorDep })
          .catch(function (e) { state.errors.doctorDep = e.message })
          .then(function () { state.doctorBusy = false; render() })
      }),
    ]
    if (hasMissing) {
      depButtons.push(ghostButton(onlyOptionalMissing ? '安装可选依赖' : '一键安装依赖', function () {
        setDepStatus('正在安装，可能需要几分钟…', '')
        postJSON('/dsh-fish-world/deps/install', { includeOptional: onlyOptionalMissing })
          .then(function (r) {
            if (r && r.ok) {
              var added = (r.declared && r.declared.added) || []
              setDepStatus('安装完成' + (added.length ? '，新增：' + added.join('、') : '') + '。重启 DSH 后生效。', 'success')
            } else {
              var detail = (r && r.install && (r.install.error || r.install.output)) || (r && r.error) || '未知错误'
              setDepStatus('安装失败：' + String(detail).slice(0, 200), 'error')
            }
            loadDoctor()
          })
          .catch(function (e) {
            setDepStatus('安装失败：' + e.message, 'error')
          })
      }))
    }
    if (hasUpdates) {
      depButtons.push(ghostButton('一键更新', function () {
        setDepStatus('正在更新，可能需要几分钟…', '')
        postJSON('/dsh-fish-world/deps/install', {})
          .then(function (r) {
            if (r && r.ok) {
              setDepStatus('更新完成。重启 DSH 后生效。', 'success')
            } else {
              var detail = (r && r.install && (r.install.error || r.install.output)) || (r && r.error) || '未知错误'
              setDepStatus('更新失败：' + String(detail).slice(0, 200), 'error')
            }
            loadDoctor()
          })
          .catch(function (e) {
            setDepStatus('更新失败：' + e.message, 'error')
          })
      }))
    }
    depButtons.push(ghostButton('解除安装', function () {
      // 不可逆操作：两步确认。先弹窗说明后果，再要求手动输入「解除」二字。
      var first = window.confirm(
        '解除安装会做这些事：\n'
        + '· 从当前 profile 的 bundles 里移除 dsh-fish-world\n'
        + '· 删掉 node_modules 里指向本插件的联接\n'
        + '· 清理本插件声明的依赖（你自己的依赖不动）\n'
        + '写入前会自动备份 profile 的 package.json。\n\n'
        + '确定要解除吗？',
      )
      if (!first) return
      var typed = window.prompt('最后的确认：请输入「解除」两个字，确认后立即执行。', '')
      if (typed == null) return
      if (String(typed).trim() !== '解除') {
        setDepStatus('已取消：输入的不是「解除」。', '')
        return
      }
      setDepStatus('正在解除…', '')
      postJSON('/dsh-fish-world/deps/install', { action: 'uninstall' })
        .then(function (r) {
          if (r && r.ok) {
            setDepStatus('已解除安装。重启 DSH 后生效。', 'success')
          } else {
            setDepStatus('解除失败：' + ((r && r.error) || '未知错误'), 'error')
          }
          loadDoctor()
        })
        .catch(function (e) {
          setDepStatus('解除失败：' + e.message, 'error')
        })
    }))

    checkBody.push(h('div', { class: 'fw-card-foot' }, [
      depStatus,
      h('div', { class: 'fw-btn-row' }, depButtons),
    ]))
    entries.push({
      key: 'doctor-dep-check',
      title: '依赖检查',
      span: 5,
      note: dep ? (dep.ok ? '全部就绪' : '有待处理项') : (state.doctorBusy ? '检查中' : '未检查'),
      body: checkBody,
    })

    // ---- 卡二：依赖清单（体检结果的展开，装了什么、缺什么） ----
    var listBody = [
      h('p', { class: 'fw-card-note', text: '平台前置缺一个，对应平台就起不来；基础能力可以后补。' }),
    ]
    if (state.errors.doctorDep) {
      listBody.push(emptyState('依赖读不到，清单先空着。'))
    } else if (dep) {
      var sections = dependencySections(dep)
      if (sections.length) {
        listBody = listBody.concat(sections)
      } else {
        listBody.push(emptyState('没有需要检查的依赖。'))
      }
      // 修复方式：只在真有问题时出现，跟着清单走（它修的就是清单里的项）
      if ((dep.hints || []).length) {
        listBody.push(h('div', { class: 'fw-divider' }))
        listBody.push(h('p', { class: 'fw-field-label', text: '修复方式' }))
        listBody.push(h('div', { class: 'fw-plainlist' }, dep.hints.map(function (hint) {
          return h('div', {}, [
            h('p', { class: 'fw-plainlist-item', text: hint.label }),
            hint.command ? h('p', { class: 'fw-item-text', style: 'font-family:var(--font-mono);font-size:12px', text: hint.command }) : null,
          ])
        })))
      }
    } else {
      listBody.push(emptyState('体检之后，这里会列出每个依赖的版本。'))
    }
    entries.push({
      key: 'doctor-dep-list',
      title: '依赖清单',
      span: 7,
      note: dep ? ((dep.packages || []).length + ' 项') : '待检查',
      body: listBody,
    })

    // ---- 卡三：版本更新（联网查新版） ----
    var upBody = [
      h('p', { class: 'fw-card-note', text: '联网查每个依赖的最新版本。查到新版就能在这张卡直接一键更新；安装/解除仍在「依赖检查」卡。' }),
    ]
    if (state.errors.doctorUpdate) {
      upBody.push(statusLine('读取失败：' + state.errors.doctorUpdate, 'error'))
    } else if (up) {
      var uc = up.counts || {}
      upBody.push(numRow('有新版', String(uc.outdated || 0) + ' 个'))
      upBody.push(numRow('已最新', String(uc.current || 0) + ' 个'))
      upBody.push(numRow('查不到', String(uc.unavailable || 0) + ' 个', {
        level: uc.unavailable === uc.total ? 'warn' : 'neutral',
      }))
      if (up.summary) upBody.push(h('p', { class: 'fw-card-note', text: up.summary }))
    } else if (state.doctorBusy) {
      upBody.push(statusLine('检查中…'))
    } else {
      upBody.push(emptyState('还没联网查过版本。'))
    }

    upBody.push(h('div', { class: 'fw-btn-row' }, [
      ghostButton(state.doctorBusy ? '检查中…' : (up ? '重新检查' : '更新检查'), function () {
        if (state.doctorBusy) return
        state.doctorBusy = true
        render()
        getJSON('/dsh-fish-world/doctor/update?force=1')
          .then(function (d) { state.doctorUpdate = d; delete state.errors.doctorUpdate })
          .catch(function (e) { state.errors.doctorUpdate = e.message })
          .then(function () { state.doctorBusy = false; render() })
      }),
      // 一键更新：查到新版后就在这儿直接装，不必再去「依赖检查」卡找。
      // 主体动作与那张卡里的是同一个接口（POST /deps/install），所以行为一致、
      // 不会出现两张卡各装一半；状态行也报在这一张，就近看见结果。
      // 没有新版时不画这个按钮 —— 没东西可更新还留个按钮，点下去会像是没反应。
      up && hasUpdates
        ? ghostButton(state.doctorBusy ? '更新中…' : '一键更新', function () {
          if (state.doctorBusy) return
          state.doctorBusy = true
          state.doctorUpdateMsg = { text: '正在更新，可能需要几分钟…', tone: '' }
          render()
          postJSON('/dsh-fish-world/deps/install', {})
            .then(function (r) {
              var ok = r && r.ok
              var detail = (r && r.install && (r.install.error || r.install.output)) || (r && r.error) || '未知错误'
              state.doctorUpdateMsg = {
                text: ok ? '更新完成。重启 DSH 后生效。' : ('更新失败：' + String(detail).slice(0, 200)),
                tone: ok ? 'success' : 'error',
              }
            })
            .catch(function (e) {
              state.doctorUpdateMsg = { text: '更新失败：' + e.message, tone: 'error' }
            })
            .then(function () {
              state.doctorBusy = false
              // 更新完重新联网查一次，把「有新版」清掉，别让旧数字留在卡上
              return getJSON('/dsh-fish-world/doctor/update?force=1')
                .then(function (d) { state.doctorUpdate = d })
                .catch(function () {})
            })
            .then(function () { render() })
        })
        : null,
    ].filter(Boolean)))

    if (state.doctorUpdateMsg) {
      upBody.push(statusLine(state.doctorUpdateMsg.text, state.doctorUpdateMsg.tone))
    }

    if (up) {
      upBody.push(h('div', { class: 'fw-divider' }))
      upBody.push(h('div', { class: 'fw-dep-list' }, (up.items || []).map(function (item) {
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
      })))
      // 更新命令：只在有新版时给，只给命令不代执行
      if ((up.hints || []).length) {
        upBody.push(h('div', { class: 'fw-divider' }))
        upBody.push(h('p', { class: 'fw-field-label', text: '更新命令（只给命令，不代执行）' }))
        upBody.push(h('div', { class: 'fw-plainlist' }, up.hints.map(function (hint) {
          return h('div', {}, [
            h('p', { class: 'fw-plainlist-item', text: hint.label }),
            h('p', { class: 'fw-item-text', style: 'font-family:var(--font-mono);font-size:12px', text: hint.command }),
          ])
        })))
      }
    }

    entries.push({
      key: 'doctor-up',
      title: '版本更新',
      span: 12,
      note: up ? (up.cached ? '缓存结果' : '刚刚检查') : '联网查版本',
      body: upBody,
    })

    // ---- 目录索引：目录在不在、能不能写、索引是否完好 ----
    var storageState = state.doctorStorage
    var audit = storageState && storageState.audit ? storageState.audit : null
    var growthState = storageState && storageState.growth ? storageState.growth : null
    var dirBody = []
    var dirStatus = statusLine('')

    if (!audit) {
      if (state.errors.doctorStorage) dirBody.push(statusLine('读取失败：' + state.errors.doctorStorage, 'error'))
      dirBody.push(h('p', { class: 'fw-card-note', text: '检查工作区里的目录与索引文件。第一次使用会自动建立；位置可以改。' }))
      dirBody.push(state.doctorStorageBusy ? statusLine('检查中…') : emptyState('还没检查过目录。'))
    } else {
      dirBody.push(dirRow({
        label: '存储位置',
        value: audit.root,
        hint: audit.configured
          ? '这是你自己选的目录；清空会回到工作区里的「鱼的世界」。'
          : '默认跟随当前工作区，也可以另选一个目录。',
        onPick: function (picked) { saveDoctorRoot(picked, dirStatus) },
      }))

      dirBody.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: '目录状态' }),
        statusDot(
          audit.ok ? '正常' : '待处理',
          audit.ok ? 'ok' : 'warn',
        ),
      ]))

      dirBody.push(h('div', { class: 'fw-dep-list' }, audit.dirs.map(function (dir) {
        var level = !dir.exists ? 'error' : (dir.writable ? 'ok' : 'warn')
        var value = !dir.exists ? '缺失' : (dir.writable ? '可写' : '只读')
        return h('div', { class: 'fw-dep-row' }, [
          h('i', { class: 'fw-dep-dot', dataset: { level: level }, 'aria-hidden': 'true' }),
          h('span', { class: 'fw-dep-label' }, [
            h('span', { class: 'fw-dep-name', text: dir.label }),
            h('span', { class: 'fw-dep-hint', text: dir.path, title: dir.path }),
          ]),
          h('span', { class: 'fw-dep-version fw-num', text: value, title: value }),
        ])
      })))

      dirBody.push(h('div', { class: 'fw-divider' }))
      dirBody.push(h('p', { class: 'fw-field-label', text: '索引文件' }))
      dirBody.push(h('div', { class: 'fw-dep-list' }, audit.indexes.map(function (index) {
        var level = !index.valid ? 'error' : (index.exists ? 'ok' : 'neutral')
        var value = !index.valid ? '损坏' : (index.exists ? index.count + ' 条' : '未建立')
        return h('div', { class: 'fw-dep-row' }, [
          h('i', { class: 'fw-dep-dot', dataset: { level: level }, 'aria-hidden': 'true' }),
          h('span', { class: 'fw-dep-label' }, [
            h('span', { class: 'fw-dep-name', text: index.label }),
            h('span', { class: 'fw-dep-hint', text: index.path, title: index.path }),
          ]),
          h('span', { class: 'fw-dep-version fw-num', text: value, title: value }),
        ])
      })))

      if (growthState) {
        dirBody.push(numRow('成长索引', growthState.ok ? '与账本一致' : '需要重建', {
          level: growthState.ok ? 'ok' : 'warn',
        }))
      }

      for (var i = 0; i < (audit.problems || []).length; i += 1) {
        var problem = audit.problems[i]
        dirBody.push(statusLine(problem.text, problem.level === 'error' ? 'error' : ''))
      }
    }

    dirBody.push(h('div', { class: 'fw-btn-row' }, [
      ghostButton(state.doctorStorageBusy ? '检查中…' : '检查目录', function () {
        loadDoctorStorage()
      }),
      ghostButton('建立或修复', function () {
        dirStatus.textContent = '正在建立…'
        dirStatus.dataset.tone = ''
        postJSON('/dsh-fish-world/doctor/storage', { action: 'repair' })
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || '建立失败')
            state.doctorStorage = r
            var bits = []
            if ((r.created || []).length) bits.push('新建 ' + r.created.length + ' 个目录')
            if (r.rebuilt) bits.push('重建成长索引')
            dirStatus.textContent = bits.length ? bits.join('，') + '。' : '目录已就绪，无需改动。'
            dirStatus.dataset.tone = 'success'
            render()
          })
          .catch(function (e) {
            dirStatus.textContent = '建立失败：' + e.message
            dirStatus.dataset.tone = 'error'
          })
      }),
      ghostButton('恢复默认', function () {
        saveDoctorRoot('', dirStatus)
      }),
    ]))
    dirBody.push(dirStatus)

    entries.push({
      key: 'doctor-storage',
      title: '目录索引',
      span: 12,
      note: audit ? (audit.ok ? '目录与索引就绪' : '有待处理项') : '检查目录与索引',
      body: dirBody,
    })

    return layoutDoctorRows(entries)
  }

  // 换存储位置：保存后立即建立结构，并刷新审计结果。
  function saveDoctorRoot(picked, statusNode) {
    if (statusNode) {
      statusNode.textContent = '正在切换…'
      statusNode.dataset.tone = ''
    }
    return postJSON('/dsh-fish-world/doctor/storage', { root: picked })
      .then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || '保存失败')
        state.doctorStorage = r
        if (statusNode) {
          statusNode.textContent = '已切换到：' + ((r.audit && r.audit.root) || picked || '默认位置')
          statusNode.dataset.tone = 'success'
        }
        render()
        loadStorage()
        loadStickerDir()
        loadLinks()
      })
      .catch(function (e) {
        if (statusNode) {
          statusNode.textContent = '切换失败：' + e.message
          statusNode.dataset.tone = 'error'
        }
      })
  }

  function loadDoctorStorage() {
    state.doctorStorageBusy = true
    render()
    return getJSON('/dsh-fish-world/doctor/storage')
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '检查失败')
        state.doctorStorage = d
        delete state.errors.doctorStorage
      })
      .catch(function (e) { state.errors.doctorStorage = e.message })
      .then(function () { state.doctorStorageBusy = false; render() })
  }
  // ---- 平台：鱼与 QQ / B站 / 抖音 ----
  // 三个平台共用同一套设置结构（总开关 → 读取 → 写入 → 额度），
  // 面板用同一组控件渲染，避免"只有 QQ 能设、别的平台没得设"。
  var PLATFORM_FIELDS = {
    qq: [
      { key: 'enabled', label: '启用 QQ 能力', kind: 'bool', hint: '默认关闭，打开后鱼才会收发 QQ' },
      { key: 'readHistory', label: '读取聊天历史', kind: 'bool', hint: '只读最近的文字、图片与合并转发' },
      { key: 'superviseProtocol', label: '启动时自动拉起协议端', kind: 'bool', hint: '只在直连 SnowLuma 时生效：启动那一下探一次，没在跑就拉起来（不做周期轮询）' },
      { key: 'groupNotice', label: '收群公告', kind: 'bool', hint: '群里发公告时告诉你一句（默认关）' },
      { key: 'videoFrames', label: '视频抽帧看图', kind: 'bool', hint: '收到视频时抽 6 帧拼成一张图（要本机有 ffmpeg，默认关）' },
      { key: 'forwardExpand', label: '展开合并转发的聊天记录', kind: 'bool', hint: '收到聊天记录卡片时把原文摊开（前 20 条，默认关）' },
      { key: 'sendMessage', label: '发送消息', kind: 'bool', hint: '仍受 QQ 桥总开关、试运行与转私聊/转群限制', danger: true },
      { key: 'dailyMessages', label: '每日发送上限', kind: 'num', min: 0, max: 3000, unit: '条', hint: '0 = 不限' },
      { key: 'qzoneEnabled', label: '打理自己的 QQ 空间', kind: 'bool', hint: '只在主人的隔离会话中可写', danger: true },
      // 空间的各项额度不在这里：它们真存在 config.qzone.postsPerDay 等字段，
      // 由下方「空间额度」那一排控件读写。这里再加一行会是改了不生效的假控件。
      { key: 'batchEnabled', label: '等他说完再回', kind: 'bool', hint: '同一个人连发几条时合成一件事回，不逐条抢答' },
      { key: 'batchQuietSec', label: '安静多久算说完', kind: 'num', min: 1, max: 120, unit: '秒' },
      { key: 'batchUnfinishedExtraSec', label: '像没说完再多等', kind: 'num', min: 0, max: 120, unit: '秒' },
      { key: 'batchMaxWaitSec', label: '最久等多久先回', kind: 'num', min: 5, max: 600, unit: '秒' },
      { key: 'liveContextCount', label: '开口前摆几句现场', kind: 'num', min: 0, max: 20, unit: '条', hint: '别人的发言当背景，0 = 不摆' },
      { key: 'stickerSubType', label: '表情按哪种形式发', kind: 'num', min: 0, max: 1, hint: '1 = 小表情（可长按收藏），0 = 普通大图' },
      { key: 'autoPokeBack', label: '被戳一下自动戳回去', kind: 'bool', danger: true, hint: '默认关：这是会被真人看见的动作' },
      { key: 'pokeTalk', label: '被戳时说一句话', kind: 'bool', danger: true, hint: '默认关：把「有人戳你」投进会话，让她自己回一句，而不是只回戳' },
    ],
    bili: [
      { key: 'enabled', label: '启用 B 站能力', kind: 'bool', hint: '默认关闭，打开后鱼才会浏览 B 站' },
      { key: 'watchEnabled', label: '浏览视频', kind: 'bool' },
      {
        key: 'watchMode',
        label: '什么时候去看',
        kind: 'select',
        hint: '决定 B 站内容什么时候进她眼里',
        options: [
          { value: 'daily', label: '每天自己去看' },
          { value: 'on-request', label: '主人叫了才去' },
          { value: 'self', label: '自己想起就去' },
        ],
      },
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

  // ---------- 鱼与 QQ 的聊天窗口（多群 / 多好友） ----------
  //
  // 授权表只有一份，落在 world 的 chats.json：一个 QQ 会话（群或好友）↔ 一个 DSH 房间。
  // 群不是「人」，所以不复用关系表；面板也不另存一套名单。
  // 五档：从「只在被叫到时才开口」到「每句都参与」。档位越高越吵、越费 token。
  var CHAT_MODES = [
    { key: 'shy', label: '社恐', hint: '被明确提到或 @ 才会参与，其他一律旁听' },
    { key: 'quiet', label: '安静', hint: '偶尔参与：没叫她时大约每 6 句接一次' },
    { key: 'normal', label: '正常', hint: '正常参与：没叫她时大约每 3 句接一次' },
    { key: 'active', label: '活跃', hint: '积极主动：没叫她时大约每 2 句就参与' },
    { key: 'frenzy', label: '狂热', hint: '全部参与：群里每句话都会接（最吵，也最费 token）' },
  ]

  // 旧三档的值（mention / always / never）还可能在配置里：面板要能对上五档。
  var CHAT_MODE_LEGACY = { mention: 'shy', always: 'normal', never: 'shy' }

  function chatModeOf(value) {
    var raw = String(value == null ? '' : value)
    var hit = CHAT_MODES.some(function (m) { return m.key === raw })
    if (hit) return raw
    return CHAT_MODE_LEGACY[raw] || 'shy'
  }

  function chatTargetId(target) {
    return String(target.chatKey || '')
  }

  function cloneTargets(list) {
    return (list || []).map(function (item) {
      return {
        chatKey: item.chatKey, kind: item.kind, id: item.id,
        name: item.name || '', sessionId: item.sessionId || '', enabled: item.enabled !== false,
      }
    })
  }

  // 表单抽屉的草稿：存 localStorage，关窗口 / 刷新都能接着填。
  var CHAT_DRAFT_KEY = 'dshcp.chatDraft'
  function saveChatDraft(draft) {
    try { localStorage.setItem(CHAT_DRAFT_KEY, JSON.stringify(draft)) } catch (e) {}
  }
  function readChatDraft() {
    try { return JSON.parse(localStorage.getItem(CHAT_DRAFT_KEY) || 'null') } catch (e) { return null }
  }
  function clearChatDraft() {
    try { localStorage.removeItem(CHAT_DRAFT_KEY) } catch (e) {}
  }

  /** 会话下拉：主人从「自己已有的会话」里挑，不手填 id。 */
  function sessionSelect(sessions, value) {
    var sel = h('select', { class: 'fw-input', 'aria-label': '投进的 DSH 会话' })
    var blank = h('option')
    blank.value = ''
    blank.textContent = '（还没选房间）'
    sel.appendChild(blank)
    ;(sessions || []).forEach(function (item) {
      var opt = h('option')
      opt.value = item.id
      opt.textContent = item.title ? item.title + ' · ' + shortSession(item.id) : shortSession(item.id)
      sel.appendChild(opt)
    })
    // 已绑定的房间可能已经不在会话列表里（归档了）：补一项，别把原值偷偷改掉。
    if (value && !(sessions || []).some(function (item) { return item.id === value })) {
      var kept = h('option')
      kept.value = value
      kept.textContent = '已归档 · ' + shortSession(value)
      sel.appendChild(kept)
    }
    sel.value = value || ''
    return sel
  }

  /** 保存整张白名单。失败时保留原状态并如实报错，不做「看起来成功了」的乐观更新。 */
  function saveChatTargets(list, onDone) {
    // 失败时把「本想保存的那一份」记下来，好让面板上的「重试保存」写的是它，
    // 而不是退回上次读到的旧名单（那等于点了重试却什么都没改）。
    state.chatPending = cloneTargets(list)
    return postJSON('/dsh-fish-world/qq/chat', { action: 'save', targets: list })
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '保存失败')
        state.qqChat = d
        state.chatPending = null
        delete state.errors.qqChat
        if (onDone) onDone(d)
        render()
      })
      .catch(function (e) { setError('qqChat', e.message) })
  }

  /** 可撤销的删除条：先删、给一条撤销，而不是拦一道二次确认。 */
  function chatUndo(label, previous) {
    state.chatUndo = { label: label, previous: previous }
    render()
  }

  function renderChatUndo() {
    var undo = state.chatUndo
    if (!undo) return null
    return h('div', { class: 'fw-undo-bar' }, [
      h('span', { class: 'fw-undo-text', text: undo.label }),
      ghostButton('撤销', function () {
        state.chatUndo = null
        saveChatTargets(undo.previous)
      }),
      ghostButton('知道了', function () {
        state.chatUndo = null
        render()
      }),
    ])
  }

  // 当前打开的抽屉的关闭函数：用于「同一时刻只允许一个抽屉」。
  var closeActiveDrawer = null

  /** 打开抽屉：给一个群 / 好友挑房间。列表在背景里保持可见，焦点不丢。 */
  function openRoomDrawer(opts) {
    var o = opts || {}
    // 连点两次「加进聊天」会叠出两层抽屉，Esc 得按两下才关得掉。
    // 打开前先把上一个清掉，保证同一时刻只有一个抽屉。
    if (closeActiveDrawer) closeActiveDrawer()
    var listEl = h('div', { class: 'fw-drawer-list' })
    var status = statusLine('')
    var picked = o.sessionId || ''
    var draft = { chatKey: o.chatKey, sessionId: picked }
    var restored = readChatDraft()
    if (restored && restored.chatKey === o.chatKey && !picked) {
      picked = restored.sessionId || ''
      draft.sessionId = picked
      status.textContent = '已恢复上次没填完的选择。'
    }

    var sessions = (state.qqChat && state.qqChat.sessions) || []
    function paint() {
      listEl.textContent = ''
      if (!sessions.length) {
        listEl.appendChild(h('p', { class: 'fw-picker-empty', text: 'DSH 里还没有可投的会话；先开一个房间再回来。' }))
        return
      }
      sessions.forEach(function (item) {
        var active = item.id === picked
        var row = h('button', {
          class: 'fw-drawer-item', type: 'button',
          dataset: { session: item.id },
          'aria-pressed': active ? 'true' : 'false',
        }, [
          h('span', { class: 'fw-drawer-title', text: item.title || ('未命名会话' + (item.createdAt ? ' · ' + sessionDay(item.createdAt) : '')) }),
          h('span', { class: 'fw-drawer-meta', text: shortSession(item.id) }),
          active ? h('span', { class: 'fw-badge', dataset: { tone: 'success' }, text: '当前' }) : null,
        ])
        listEl.appendChild(row)
      })
    }
    paint()

    listEl.addEventListener('click', function (event) {
      var node = event.target && event.target.closest ? event.target.closest('[data-session]') : null
      if (!node) return
      picked = node.dataset.session
      draft.sessionId = picked
      saveChatDraft(draft)   // 选一下就存，不怕手滑关掉
      paint()
      status.textContent = ''
    })

    var okBtn = button('绑定这个房间', function () { apply() }, 'primary')
    var cancelBtn = ghostButton('取消', function () { close() })
    var scrim = h('div', { class: 'fw-drawer-scrim' })
    // 表单抽屉不点蒙层关闭：手一滑就把主人挑好的选择弄没了。
    // 要关请用「取消」或 Esc（取消会保留草稿，下次进来接着填）。
    scrim.addEventListener('click', function () { status.textContent = '要关闭请点「取消」或按 Esc。' })

    var drawer = h('div', { class: 'fw-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || '选择投进的会话' }, [
      h('div', { class: 'fw-drawer-head' }, [
        h('h3', { class: 'fw-card-title', text: o.title || '选择投进的会话' }),
        h('span', { class: 'fw-card-note', text: o.chatKey || '' }),
      ]),
      h('p', { class: 'fw-card-note', text: '只列你自己工作区里的会话。没想要的房间，先在 DSH 开一个再回来。' }),
      listEl,
      status,
      h('div', { class: 'fw-drawer-foot' }, [okBtn, cancelBtn]),
    ])

    function apply() {
      if (!picked) {
        status.textContent = '先选一个房间。'
        return
      }
      close()
      clearChatDraft()
      if (o.onPick) o.onPick(picked)
    }

    function onKeydown(event) {
      if (event.key === 'Escape') close()
    }

    function close() {
      document.removeEventListener('keydown', onKeydown)
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim)
      if (drawer.parentNode) drawer.parentNode.removeChild(drawer)
      if (closeActiveDrawer === close) closeActiveDrawer = null
    }

    document.body.appendChild(scrim)
    document.body.appendChild(drawer)
    document.addEventListener('keydown', onKeydown)
    closeActiveDrawer = close
    okBtn.focus()
    return drawer
  }

  /** 「全部群与好友」：拉一次协议端的名单，勾一个就绑房间。 */
  function loadChatBook() {
    state.chatBookLoading = true
    render()
    return postJSON('/dsh-fish-world/qq/chat', { action: 'targets' })
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.chatBook = d
        state.chatBookLoading = false
        delete state.errors.chatBook
      })
      .catch(function (e) {
        state.chatBookLoading = false
        state.errors.chatBook = e.message
      })
      .then(render)
  }

  /**
   * 「聊天窗口」是「鱼与 QQ」卡里的一个分区，不是独立卡片：
   * 两边说的都是 QQ 这一侧的事，拆成两张卡会让人以为它们是两套东西。
   * 所以这里只返回要插进那张卡的节点，由 viewPlatforms 拼进「鱼与 QQ」。
   */
  function qqChatSections() {
    var data = state.qqChat
    var body = []
    // 出错必须给条退路：重试一次，或者清掉这份名单从头再来。
    // 原先只显示一行红字，既不能重试也没有重置入口，等于卡死在错误状态里。
    // 注意区分两种错：**读不到**（没有任何数据，只能整块替换）与
    // **写失败**（名单已经读到了，不该把列表藏起来 —— 那样连重试都不知道该点哪）。
    if (state.errors.qqChat && !data) {
      return [
        chatSectionHead('读取失败'),
        statusLine(state.errors.qqChat, 'error'),
        h('div', { class: 'fw-btn-row' }, [
          button('重试', function () { delete state.errors.qqChat; loadQQChat() }, 'primary'),
          ghostButton('清空白名单', function () {
            postJSON('/dsh-fish-world/qq/chat', { action: 'reset' })
              .then(function (d) {
                if (d && d.ok === false) throw new Error(d.error || '清空失败')
                state.qqChat = d
                delete state.errors.qqChat
                render()
              })
              .catch(function (e) { setError('qqChat', e.message) })
          }),
        ]),
      ]
    }
    if (!data) {
      return [chatSectionHead('读取中'), statusLine('读取中…')]
    }

    var chat = data.chat || {}
    var config = data.config || {}
    var targets = cloneTargets(data.targets || [])
    var tab = state.chatTab || 'current'

    // 白名单里「已选好房间」的才算真的在收信；没选的先放着，面板标出来。
    var ready = targets.filter(function (t) { return t.enabled !== false && t.sessionId })
    body.unshift(chatSectionHead((chat.enabled ? '收信中 · ' : '未启用 · ') + ready.length + ' 个在收信'))
    if (state.errors.qqChat) {
      body.push(statusLine('保存失败：' + state.errors.qqChat + '（名单还是上次读到的样子）', 'error'))
      body.push(h('div', { class: 'fw-btn-row' }, [
        button('重试保存', function () {
          // 重试 = 把「刚才没存上的那一份」再写一次；失败就再报，不假装成功。
          var pending = state.chatPending || cloneTargets(targets)
          delete state.errors.qqChat
          saveChatTargets(pending)
        }, 'primary'),
        ghostButton('重新读取', function () { delete state.errors.qqChat; state.chatPending = null; loadQQChat() }),
      ]))
    }
    body.push(h('p', { class: 'fw-card-note', text: '这是允许名单：哪些群 / 好友里鱼可以说话。先允许，再给每个目标选一个你自己的会话房间；没选房间的不会收信。' }))

    // 顶部 tabs：允许名单 / 全部群与好友。只靠下划线区分选中，不做方块按钮。
    body.push(h('div', { class: 'fw-tabs', role: 'tablist' }, [
      tabItem('允许名单', tab === 'current', function () { state.chatTab = 'current'; render() }),
      tabItem('全部群与好友', tab === 'all', function () {
        state.chatTab = 'all'
        if (!state.chatBook && !state.chatBookLoading) loadChatBook()
        render()
      }),
    ]))

    if (tab === 'current') {
      if (!targets.length) {
        body.push(h('div', { class: 'fw-empty-state' }, [
          h('p', { class: 'fw-empty-title', text: '白名单是空的' }),
          h('p', { class: 'fw-empty-note', text: '切到「全部群与好友」，点「加进白名单」就行；房间可以之后再选。' }),
        ]))
      } else {
        targets.forEach(function (item) {
          var sel = sessionSelect(data.sessions || [], item.sessionId)
          sel.addEventListener('change', function () {
            var next = cloneTargets(targets).map(function (row) {
              return row.chatKey === item.chatKey ? Object.assign({}, row, { sessionId: sel.value }) : row
            })
            saveChatTargets(next)
          })
          var unbound = !item.sessionId
          var row = h('div', { class: 'fw-chat-row' }, [
            h('div', { class: 'fw-chat-main' }, [
              h('span', { class: 'fw-chat-name', text: item.name || (item.kind === 'group' ? '群 ' + item.id : '好友 ' + item.id) }),
              h('span', { class: 'fw-chat-key' }, [
                h('span', { text: item.chatKey }),
                unbound ? h('span', { class: 'fw-badge', dataset: { tone: 'warn' }, text: '还没选房间 · 不收信' }) : null,
              ]),
            ]),
            h('span', { class: 'fw-chat-room' }, [sel]),
            h('span', { class: 'fw-chat-actions' }, [
              ghostButton(item.enabled === false ? '启用' : '停用', function () {
                var next = cloneTargets(targets).map(function (row) {
                  return row.chatKey === item.chatKey ? Object.assign({}, row, { enabled: row.enabled === false }) : row
                })
                saveChatTargets(next)
              }),
              ghostButton('移出', function () {
                var previous = cloneTargets(targets)
                var next = previous.filter(function (row) { return row.chatKey !== item.chatKey })
                saveChatTargets(next, function () {
                  chatUndo('已移出 ' + (item.name || item.chatKey) + '，撤销可恢复', previous)
                })
              }),
            ]),
          ])
          body.push(row)
        })
        // 出错卡住时要有条退路：清空白名单、从头再来，不用改文件。
        body.push(h('div', { class: 'fw-btn-row' }, [
          ghostButton('清空白名单', function () {
            var previous = cloneTargets(targets)
            saveChatTargets([], function () {
              chatUndo('已清空 ' + previous.length + ' 个允许目标，撤销可恢复', previous)
            })
          }),
        ]))
      }
      // 撤销条放在「空 / 非空」之外：清空之后列表本来就是空的，
      // 若把它留在非空分支里，那句「撤销可恢复」就是空话（点了没有撤销入口）。
      var undoBar = renderChatUndo()
      if (undoBar) body.push(undoBar)
    } else {
      var book = state.chatBook
      if (state.chatBookLoading) body.push(statusLine('正在问协议端要名单…'))
      else if (state.errors.chatBook) {
        body.push(statusLine('读取失败：' + state.errors.chatBook + '（协议端在运行吗？）', 'error'))
        // 名单读不到时给个重试：协议端可能只是还没起来。
        body.push(h('div', { class: 'fw-btn-row' }, [
          button('重试', function () {
            state.chatBook = null
            delete state.errors.chatBook
            loadChatBook()
          }, 'primary'),
        ]))
      }
      else if (!book) body.push(statusLine('读取中…'))
      else {
        var errors = book.errors || {}
        if (errors.groups || errors.friends) {
          body.push(statusLine('部分名单没读到：' + [errors.groups && '群 ' + errors.groups, errors.friends && '好友 ' + errors.friends].filter(Boolean).join('；'), 'warn'))
        }
        var groups = book.groups || []
        var friends = book.friends || []
        if (!groups.length && !friends.length) {
          body.push(emptyState('协议端没返回任何群或好友。'))
        }
        function addRow(kind, id, name, meta) {
          var chatKey = kind + ':' + id
          var existing = targets.find(function (row) { return row.chatKey === chatKey })
          var rowEl = h('div', { class: 'fw-chat-row' }, [
            h('div', { class: 'fw-chat-main' }, [
              h('span', { class: 'fw-chat-name', text: name || (kind === 'group' ? '群 ' + id : '好友 ' + id) }),
              h('span', { class: 'fw-chat-key', text: chatKey + (meta ? ' · ' + meta : '') }),
            ]),
            h('span', { class: 'fw-chat-actions' }, [
              existing
                ? h('span', { class: 'fw-badge', dataset: { tone: existing.sessionId ? 'success' : 'warn' },
                  text: existing.sessionId ? '已在白名单' : '已允许 · 待选房间' })
                : ghostButton('加进白名单', function () {
                  // 加白名单就是加白名单：直接进名单，房间之后在「允许名单」里选。
                  // 原先强制先挑房间，等于把两件事绑在一起，第一次勾选就卡住。
                  var next = cloneTargets(targets).concat([{
                    chatKey: chatKey, kind: kind, id: String(id), name: name || '', sessionId: '', enabled: true,
                  }])
                  saveChatTargets(next)
                }),
            ]),
          ])
          body.push(rowEl)
        }
        if (groups.length) body.push(h('p', { class: 'fw-field-label', text: '群聊' }))
        groups.slice(0, 40).forEach(function (item) {
          addRow('group', item.id, item.name, item.members ? item.members + ' 人' : '')
        })
        if (friends.length) body.push(h('p', { class: 'fw-field-label', text: '好友' }))
        friends.slice(0, 40).forEach(function (item) {
          addRow('private', item.id, item.name || item.remark, '')
        })
      }
    }

    // 开口档位：属于「怎么聊」，不进授权表，单独存平台配置。
    body.push(h('p', { class: 'fw-field-label', text: '群里怎么开口' }))
    var currentMode = chatModeOf(config.groupReplyMode)
    body.push(h('div', { class: 'fw-tabs', role: 'tablist' }, CHAT_MODES.map(function (mode) {
      return tabItem(mode.label, currentMode === mode.key, function () {
        postJSON('/dsh-fish-world/qq/chat', { action: 'mode', groupReplyMode: mode.key })
          .then(function (d) { state.qqChat = d; render() })
          .catch(function (e) { setError('qqChat', e.message) })
      })
    })))
    var modeHint = (CHAT_MODES.find(function (m) { return m.key === currentMode }) || CHAT_MODES[0]).hint
    body.push(h('p', { class: 'fw-row-hint', text: modeHint }))

    return body
  }

  /** 分区小标题：与同卡内的「空间额度」用同一种写法，几块内容一眼分得开。 */
  function chatSectionHead(note) {
    return h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
      h('h3', { class: 'fw-card-title', text: '聊天窗口' }),
      note ? h('span', { class: 'fw-card-note', text: note }) : null,
    ])
  }

  // 「主人 QQ / 主人会话」在三处各存一份：桥是真源，世界设置与关系表是它的影子。
  // 这段是**设定页**里那一段的内容：主人在这里选会话、改号并保存；
  // 三处对不上或会话已经失效时，把原值全部摊开，别让人自己去翻三个文件。
  function ownerBindingBody(data) {
    var d = data && data.owner
    if (!d) {
      return [
        statusLine('读不到主人绑定：鱼的世界还没绑上工作区（先选一个主人会话试试）。'),
        ownerSessionPicker(data, ''),
      ]
    }
    var qq = d.qq || {}
    var session = d.session || {}
    var rows = [
      infoRow('主人 QQ', qq.bridge || '（桥里没填）', { level: d.qqAgree ? 'ok' : 'warn' }),
      infoRow('主人会话', shortSession(session.bridge || '') || '（桥里没填）', { level: d.sessionAgree ? 'ok' : 'warn' }),
    ]
    var detail = []
    if (!d.qqAgree) {
      detail.push('QQ 号对不上：桥 ' + (qq.bridge || '空') + ' / 世界设置 ' + (qq.config || '空') + ' / 关系表 ' + (qq.relation || '空'))
    }
    if (!d.sessionAgree) {
      detail.push('主人会话对不上：桥 ' + (session.bridge ? shortSession(session.bridge) : '空') + ' / 世界设置 ' + (session.config ? shortSession(session.config) : '空') + ' / 关系表 ' + (session.relation ? shortSession(session.relation) : '空'))
    }
    return [
      h('p', { class: 'fw-card-note', text: '以 QQ 桥的「私聊 QQ 号 / 目标会话」为准；世界设置和关系表各存一份影子，保存后会自动跟过去。' }),
      h('div', {}, rows),
      // 会话失效要单独说：三处可能一致，但这个 id 已经被 DSH 清掉了，
      // 表现就是日记/请求/成长全空（2026-10-25 真出过一次）。
      d.sessionAlive === false
        ? statusLine('这个主人会话已经不存在了（DSH 会清理旧会话），换一个再保存。', 'error')
        : null,
      detail.length ? h('p', { class: 'fw-row-hint', text: detail.join('；') }) : null,
      ownerSessionPicker(data, session.bridge || ''),
    ].filter(Boolean)
  }

  /**
   * 主人绑定这一段：选会话 + 改主人 QQ，一次保存。
   * 会话从宿主现有会话里挑（不手填 id）；桥里那个已经失效时也照样能挑到别的。
   */
  function ownerSessionPicker(data, current) {
    var list = (data && data.sessions) || []
    var sel = h('select', { class: 'fw-input', 'aria-label': '主人会话' })
    var blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '（还没绑）'
    sel.appendChild(blank)
    var has = false
    list.forEach(function (row) {
      var opt = document.createElement('option')
      opt.value = row.id
      opt.textContent = sessionLabel(row)
      sel.appendChild(opt)
      if (row.id === current) has = true
    })
    // 桥里的 id 不在清单里（已被清理）：保留一项，让主人看得见现在绑的是什么，
    // 而不是悄悄显示成「还没绑」。
    if (current && !has) {
      var stale = document.createElement('option')
      stale.value = current
      stale.textContent = shortSession(current) + ' · 已失效'
      sel.appendChild(stale)
    }
    sel.value = current || ''

    var qqInput = h('input', {
      class: 'fw-input',
      type: 'text',
      value: (data && data.owner && data.owner.qq && data.owner.qq.bridge) || '',
      placeholder: '你的 QQ 号',
      'aria-label': '主人 QQ 号',
      inputmode: 'numeric',
    })
    var status = statusLine('')
    var save = button('保存主人', function () {
      status.textContent = '保存中…'
      status.dataset.tone = ''
      postJSON('/dsh-fish-world/fish/profile', {
        ownerQQ: String(qqInput.value || '').trim(),
        ownerSession: sel.value || '',
      }).then(function (r) {
        if (!r || r.ok === false) throw new Error((r && r.error) || '保存失败')
        // 用服务端回来的那份覆盖本地，再整体重读一次：会话与白名单都可能跟着变。
        state.profile = Object.assign({}, state.profile || {}, { owner: r.owner, sessions: r.sessions || (state.profile || {}).sessions })
        status.textContent = '已保存，世界设置与关系表已跟着对齐。'
        status.dataset.tone = 'success'
        loadProfile()
        loadPlatforms()
        loadQQChat()
      }).catch(function (e) {
        status.textContent = '保存失败：' + e.message
        status.dataset.tone = 'error'
      })
    }, 'primary')

    return h('div', { class: 'fw-field', style: 'margin-top:var(--space-4)' }, [
      h('label', { class: 'fw-field-label', text: '主人会话' }),
      sel,
      h('span', { class: 'fw-row-hint', text: list.length ? '日记、请求、成长都写进这位主人的会话工作区；只在鱼世界绑不上时才需要换。' : '宿主里还没有可选的会话。' }),
      h('label', { class: 'fw-field-label', style: 'margin-top:var(--space-4)', text: '主人 QQ 号' }),
      qqInput,
      h('span', { class: 'fw-row-hint', text: '主人自己的私聊由 QQ 桥直接负责；白名单里的私聊只放别人。' }),
      h('div', { class: 'fw-btn-row' }, [save]),
      status,
    ])
  }

  function viewPlatforms() {
    var data = state.platforms
    var children = []

    if (state.errors.platforms) {
      children.push(card({ key: 'platforms-error', title: '鱼与平台', span: 12, children: [statusLine('读取失败：' + state.errors.platforms, 'error')] }))
    } else if (!data) {
      children.push(card({ key: 'platforms-loading', title: '鱼与平台', span: 12, children: [statusLine('读取中…')] }))
    } else {
      children.push(card({
        key: 'platforms-intro',
        title: '鱼与世界',
        span: 12,
        children: [
          h('p', { class: 'fw-card-note', text: '三个平台默认都不启用，需要你自己打开。打开后鱼才参与；外发动作还要再单独开一层，模型无法自行绕过。' }),
          h('p', { class: 'fw-card-note', text: storageLine() }),
        ],
      }))

      // 主人绑定不在这里：它是「设定」，在「鱼的设定」里改（可选会话、能保存）。
      // 这里曾经放一张只读的「主人绑定」卡，看得见却改不了，还和设定页各说一遍。

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
        // 这里面的「总开关 / 试运行」是 QQ 桥自己的闸门，与下面的能力开关不是一回事。
        body.push(h('div', { class: 'fw-account' }, renderAccount(platform)))

        // 折叠状态：默认折起，只留账号情况 + 一行状态 + 「能力开关」。
        var open = readFlag('capOpen.' + platform.id, false)

        function renderFields(list) {
          return list.map(function (field) {
            if (field.kind === 'bool') {
              return switchRow({
                label: field.label + (field.danger ? '（外发）' : ''),
                hint: field.hint || '',
                checked: cfg[field.key] === true,
                onChange: function (next) {
                  savePlatform(platform.id, { [field.key]: next })
                },
              })
            }
            if (field.kind === 'select') {
              var picker = h('select', { class: 'fw-input', 'aria-label': field.label }, (field.options || []).map(function (option) {
                return h('option', { value: option.value, selected: cfg[field.key] === option.value, text: option.label })
              }))
              picker.addEventListener('change', function () {
                savePlatform(platform.id, { [field.key]: picker.value })
              })
              return h('div', { class: 'fw-row' }, [
                h('span', { class: 'fw-row-label', text: field.label }),
                h('span', { style: 'width:150px;flex:none' }, [picker]),
                field.hint ? h('span', { class: 'fw-card-note', text: field.hint }) : null,
              ])
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
            return h('div', { class: 'fw-row' }, [
              h('span', { class: 'fw-row-label', text: field.label }),
              h('span', { style: 'width:88px;flex:none' }, [input]),
              field.unit ? h('span', { class: 'fw-card-note', text: field.unit }) : null,
            ])
          })
        }

        // 「能力开关」只决定这一组看不看得见，不改动任何能力本身，
        // 所以不能用开关的形状（拨它就等于关掉了什么？）——做成一行展开/收起。
        // 逐项开关、限制说明、空间额度都收进去：一张卡铺十几行很难扫读，
        // 而这些又很少天天改；已开几项直接并在本行右侧，不另占一行。
        var boolFields = fields.filter(function (field) { return field.kind === 'bool' })
        var onCount = boolFields.filter(function (field) { return cfg[field.key] === true }).length
        var groupId = 'fw-capgroup-' + platform.id
        var toggle = h('button', {
          class: 'fw-disclosure',
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': open ? groupId : null,
        }, [
          h('span', { class: 'fw-disclosure-label', text: open ? '收起能力开关' : '展开能力开关' }),
          h('span', { class: 'fw-disclosure-meta', text: '已开 ' + onCount + ' / ' + boolFields.length + ' 项' }),
          h('span', { class: 'fw-disclosure-mark', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
        ])
        toggle.addEventListener('click', function () {
          writeFlag('capOpen.' + platform.id, !open)
          render()
        })
        body.push(toggle)

        var groupChildren = []
        if (open) {
          if (platform.id === 'qq') groupChildren.push.apply(groupChildren, renderAccountDetail(platform))
          groupChildren.push.apply(groupChildren, renderFields(fields))

          ;(platform.notes || []).forEach(function (note) {
            groupChildren.push(h('p', { class: 'fw-card-note', text: '· ' + note }))
          })

          // QQ 空间额度并入「鱼与 QQ」，不再单独占一个分区。
          if (platform.id === 'qq' && state.qzone) {
            var qcfg = state.qzone || {}
            groupChildren.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
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
              groupChildren.push(h('div', { class: 'fw-row' }, [
                h('span', { class: 'fw-row-label', text: row[1] }),
                h('span', { style: 'width:76px;flex:none' }, [qinput]),
              ]))
            })
            groupChildren.push(h('p', { class: 'fw-card-note', text: '动态和日记共用额度；额度只限制频率，不改变权限。' }))
          }
        }
        // 分组容器只在展开时存在：收起时这一整块（逐项开关 + 限制说明 + 空间额度）
        // 不在 DOM 里，卡片就只剩账号情况与这一行，扫读成本低得多。
        if (open) body.push(h('div', { class: 'fw-capgroup', id: groupId }, groupChildren))

        // 「聊天窗口」并进「鱼与 QQ」：都是 QQ 这一侧的内容，不单独占一张卡。
        // 它比另外两个平台的设置宽得多（一列群 / 好友 + 房间下拉），所以 QQ 占通栏，
        // 剩下两个平台各占 6 列，这一行仍然刚好填满 12 列。
        if (platform.id === 'qq') {
          body.push(h('div', { class: 'fw-divider' }))
          body = body.concat(qqChatSections())
        }

        var stateText = !platform.installed ? '插件未安装' : (cfg.enabled ? '已启用' : '未启用')
        var platformCard = card({
          key: 'platform-' + platform.id,
          title: platform.name,
          note: stateText + (platform.version ? ' · v' + platform.version : ''),
          span: platform.id === 'qq' ? 12 : 6,
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
  // 完整路径只在「鱼的设定 → 存储位置」写一次。别处一律只说「在哪个子目录」，
  // 否则同一串 C:\Users\... 会在五个卡片里各出现一遍，既吵又容易改一处漏一处。
  function storageLine() {
    return '所有文件都在你的工作区里；完整路径见「鱼的设定 → 存储位置」。'
  }

  /** 把绝对路径折成「相对根目录」的短标签，给别处的行内提示用。 */
  function relPath(full, root) {
    var abs = String(full || '')
    var base = String(root || '')
    if (!abs) return ''
    if (base && abs.indexOf(base) === 0) {
      var rest = abs.slice(base.length).replace(/^[\\/]+/, '')
      return rest ? rest.replace(/\\/g, '/') : '（根目录）'
    }
    // 根目录不同（比如单独指定了图库）：只留最后两段，够认出是哪就行。
    var parts = abs.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts.slice(-2).join('/') || abs
  }

  // ---- 本地留存卡：QQ / B站 / 抖音各自的浏览与互动记录 ----
  function activityCard() {
    var data = state.activity
    // 这一张现在挂在「鱼的成长」页上，而那个分区未必预先加载过留存数据；
    // 不兜住就会在 data.platforms 上抛错，整页都渲染不出来。
    if (state.errors.activity) {
      return card({ key: 'activity', title: '本地存储', note: '读取失败', span: 12, children: [statusLine('读取失败：' + state.errors.activity, 'error')] })
    }
    if (!data || !data.ok) {
      return card({ key: 'activity', title: '本地存储', note: '读取中', span: 12, children: [statusLine('读取中…')] })
    }
    var platforms = data.platforms || {}
    var items = data.items || []
    var ids = ['qq', 'bili', 'douyin']
    var total = ids.reduce(function (sum, id) {
      return sum + Number((platforms[id] || {}).total || 0)
    }, 0)

    var rows = ids.map(function (id) {
      var info = platforms[id] || { total: 0, days: 0, dir: '' }
      // 只显示相对位置（鱼与世界/QQ），整条绝对路径留给「鱼的设定 → 存储位置」。
      var where = info.dir ? relPath(info.dir, state.storage && state.storage.root) : '目录待建立'
      return h('div', { class: 'fw-activity-row' }, [
        h('span', { class: 'fw-row-label' }, [
          h('span', { text: info.name || id }),
          h('span', { class: 'fw-row-hint', text: where }),
        ]),
        h('span', { class: 'fw-num', text: String(info.total || 0) + ' 条 · ' + String(info.days || 0) + ' 天' }),
      ])
    })

    var body = rows.slice()
    body.push(h('p', { class: 'fw-card-note', text: data.note || '' }))

    // 请求历史也归在这里：它和平台留存是同一类东西（「鱼做过什么」的流水），
    // 每天一个文件、裁决写回原行。分两段：
    //   ① 按天汇总（哪天有几条，文件名一并写出来，方便直接去目录翻）
    //   ② 选了某一天就展开那天的条目与裁决结果
    var wishDays = (state.wishes && state.wishes.days) || []
    if (wishDays.length) {
      var wishTotal = wishDays.reduce(function (s, d) { return s + Number(d.count || 0) }, 0)
      body.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
        h('h3', { class: 'fw-card-title', text: '鱼的请求' }),
        h('span', { class: 'fw-card-note', text: wishTotal + ' 条 · ' + wishDays.length + ' 天' }),
      ]))

      var daySel = h('select', { class: 'fw-input', 'aria-label': '按日期查看请求历史' })
      var allOpt = h('option')
      allOpt.value = ''
      allOpt.textContent = '全部日期'
      daySel.appendChild(allOpt)
      wishDays.forEach(function (d) {
        var opt = h('option')
        opt.value = d.day
        opt.textContent = d.day + '（' + d.count + ' 条）'
        daySel.appendChild(opt)
      })
      daySel.value = state.wishDate || ''
      daySel.addEventListener('change', function () {
        state.wishDate = daySel.value
        loadWishes()
      })

      body.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label' }, [
          h('span', { text: '按天归档' }),
          h('span', { class: 'fw-row-hint', text: '每天一个文件，裁决写回原行，不覆盖旧记录' }),
        ]),
        h('span', { style: 'width:170px;flex:none' }, [daySel]),
      ]))

      if (!state.wishDate) {
        body.push(h('div', { class: 'fw-plainlist' }, wishDays.slice(0, 12).map(function (d) {
          return h('div', { class: 'fw-row' }, [
            h('span', { class: 'fw-row-label' }, [
              h('span', { text: d.day }),
              h('span', { class: 'fw-row-hint', text: '鱼的请求/' + d.day + '.jsonl' }),
            ]),
            h('span', { class: 'fw-num', text: String(d.count || 0) + ' 条' }),
          ])
        })))
      } else {
        var dayRows = (state.wishes.wishes || [])
        body.push(h('p', { class: 'fw-field-label', text: state.wishDate + ' 的请求' }))
        if (!dayRows.length) body.push(emptyState('这一天没有记录。'))
        else {
          body.push(h('div', { class: 'fw-list' }, dayRows.map(function (item) {
            var verdict = item.status === 'approved' ? '已同意' : item.status === 'rejected' ? '已拒绝' : '待处理'
            return h('div', { class: 'fw-item' }, [
              h('div', { class: 'fw-item-meta' }, [
                h('span', { text: shortTime(item.at) }),
                h('span', {
                  class: 'fw-badge',
                  dataset: { tone: item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'warn' : '' },
                  text: verdict,
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
    }

    if (items.length) {
      body.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
        h('h3', { class: 'fw-card-title', text: '平台往来' }),
      ]))
      body.push(h('div', { class: 'fw-list' }, items.slice(0, 8).map(function (item) {
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
      key: 'activity',
      title: '本地存储',
      note: total ? total + ' 条' : '暂无',
      span: 12,
      children: body,
    })
  }

  // 账号情况（顶层）：只留登录状态、主人 QQ、总开关。发送到 / 图片 / 试运行等细项在展开区，见 renderAccountDetail。
  function renderAccount(platform) {
    var account = platform.account || {}
    var rows = []

    if (platform.id !== 'qq') {
      rows.push(infoRow('账号', account.managed === false ? '由插件自行登录' : '—'))
      if (account.note) rows.push(h('p', { class: 'fw-card-note', text: account.note }))
      return rows
    }
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
      rows.push(h('p', { class: 'fw-card-note', text: '点这个按钮打开协议端页面去登录；没在跑的话会先拉起来。' }))
      rows.push(h('div', { class: 'fw-btn-row' }, [
        ghostButton('打开协议端', function () {
          postJSON('/dsh-fish-world/protocol', {}).then(function (r) {
            var result = (r && r.result) || {}
            var url = (r && r.webui) || 'http://127.0.0.1:5099'
            if (result.ok === false && !result.alreadyRunning) {
              window.alert('启动失败：' + (result.error || '未知原因') + '\n\n如果已经有协议端在跑，直接去页面登录就行。')
            }
            window.open(url, '_blank')
            setTimeout(function () { location.reload() }, 1200)
          }).catch(function (e) {
            window.alert('失败：' + e.message)
          })
        }),
      ]))
    }

    rows.push(ownerRow(account))
    rows.push(bridgeSwitchRow('总开关', '总开关', account.masterSwitch, '关掉后谁都不能收发'))
    return rows
  }

  // 主人 QQ：真源是 QQ 桥的私聊号，经 fish/profile 写入（与「鱼的设定 → 主人」同一条路）。
  // 目标会话原样带回去，免得这里一改就把会话清掉。
  function ownerRow(account) {
    var input = h('input', {
      class: 'fw-input',
      type: 'text',
      inputmode: 'numeric',
      placeholder: '主人的 QQ 号',
      value: String(account.configuredPrivateQQ || ''),
      'aria-label': '主人 QQ 号',
    })
    var save = ghostButton('确定', function () {
      var qq = String(input.value || '').trim()
      if (!/^\d{5,12}$/.test(qq)) {
        setError('platforms', 'QQ 号要是 5 到 12 位数字')
        return
      }
      var body = { ownerQQ: qq }
      if (account.targetSession) body.ownerSession = account.targetSession
      postJSON('/dsh-fish-world/fish/profile', body)
        .then(function (r) {
          if (!r || r.ok === false) throw new Error((r && r.error) || '保存失败')
          delete state.errors.platforms
          loadProfile()
          loadPlatforms()
        })
        .catch(function (e) { setError('platforms', e.message) })
    })
    return h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '主人 QQ' }),
      h('span', { style: 'width:140px;flex:none' }, [input]),
      save,
    ])
  }

  // 桥的写入：每次只改一个键，走后台白名单（lib/qq.mjs），其它字段原样保留。
  function bridgeSave(body) {
    return postJSON('/dsh-fish-world/platforms', body)
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '保存失败')
        state.platforms = d
        delete state.errors.platforms
        render()
      })
      .catch(function (e) { setError('platforms', e.message) })
  }

  function bridgeSwitchRow(label, name, checked, hint) {
    return switchRow({
      label: label,
      hint: hint || '',
      checked: checked === true,
      onChange: function (next) { bridgeSave({ action: 'bridge-switch', name: name, value: next }) },
    })
  }

  function bridgeToggle(label, hint, name, checked) {
    return switchRow({
      label: label,
      hint: hint || '',
      checked: checked === true,
      onChange: function (next) { bridgeSave({ action: 'bridge-field', name: name, value: next }) },
    })
  }

  // 展开区里的 QQ 细项：发到哪、群号、目标会话、图片、试运行。
  function renderAccountDetail(platform) {
    var account = platform.account || {}
    var rows = []
    if (platform.id !== 'qq' || account.missing) return rows

    var targets = []
    if (account.toPrivate && account.configuredPrivateQQ) targets.push('私聊 ' + account.configuredPrivateQQ)
    if (account.toGroup && account.configuredGroup) targets.push('群 ' + account.configuredGroup)

    rows.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
      h('h3', { class: 'fw-card-title', text: '发送到' }),
      h('span', { class: 'fw-card-note', text: targets.length ? targets.join(' · ') : '未配置' }),
    ]))
    rows.push(bridgeToggle('发到主人私聊', '私聊号就是上面的主人 QQ', '转私聊', account.toPrivate))
    rows.push(bridgeToggle('发到群', account.configuredGroup ? '群 ' + account.configuredGroup : '先在下面填群号', '转群', account.toGroup))

    var groupInput = h('input', {
      class: 'fw-input',
      type: 'text',
      inputmode: 'numeric',
      placeholder: '群号（只填数字）',
      value: String(account.configuredGroup || ''),
      'aria-label': '群号',
    })
    groupInput.addEventListener('change', function () {
      bridgeSave({ action: 'bridge-field', name: '群号', value: groupInput.value })
    })
    rows.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '群号' }),
      h('span', { style: 'width:140px;flex:none' }, [groupInput]),
    ]))

    // 目标会话：主人会话由「鱼的设定 → 主人」改，这里只显示当前值。
    rows.push(infoRow('目标会话', account.targetSession ? shortSession(account.targetSession) : '未绑定'))

    var images = []
    if (account.receiveImages) images.push('收图')
    if (account.sendImages) images.push('发图')
    rows.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
      h('h3', { class: 'fw-card-title', text: '图片' }),
      h('span', { class: 'fw-card-note', text: images.length ? images.join(' · ') + (account.maxImages ? '（最多 ' + account.maxImages + ' 张）' : '') : '双向关闭' }),
    ]))
    rows.push(bridgeToggle('收图', '别人发来的图存下来', '收图', account.receiveImages))
    rows.push(bridgeToggle('发图', '允许鱼发图给 QQ', '发图', account.sendImages))

    rows.push(bridgeSwitchRow('试运行', '试运行', account.trial, '只记账，不真发'))
    return rows
  }

  // 会话 id 太长，只留末尾几位，避免撑破卡片
  function shortSession(id) {
    var text = String(id || '')
    if (text.length <= 18) return text
    return '…' + text.slice(-12)
  }

  // ---- AstrBot 接入：把 AstrBot 当 QQ 通道，并借用它的插件工具 ----
  // ---- AstrBot 接入 ----
  //
  // 一条线二选一：直连协议端 SnowLuma，或者经由 AstrBot。这两件事本来就不该挤在
  // 同一张卡里（一张卡上五六个开关，谁管谁说不清），所以拆成两张各自独立的卡，
  // 每张卡只说一种走法「现在通不通、还差什么、点哪个按钮」。
  /** 借手 · QQ Agent：QQ-agent 有自己的插件系统，DSH 读不了它的插件包，只能通过配套插件借工具。 */
  function qqAgentCard() {
    var d = state.qqagent
    var body = []
    if (state.errors.qqagent) {
      body.push(statusLine('读取失败：' + state.errors.qqagent, 'error'))
    } else if (!d) {
      body.push(statusLine('读取中…'))
    } else {
      body.push(h('p', { class: 'fw-prose', text: 'QQ-agent 用自己的加载器读插件，DSH 读不了；这条通道只借它的工具，理解和说话仍然是这条鱼。装上配套插件 fishworld-borrow 就能接。' }))
      body.push(h('p', { class: 'fw-card-note', text: '⚠️ 只当工具源：QQ-agent 那边的群/私聊白名单要清空（或干脆不连协议端），别让它也回话，否则同一个号两边抢话。' }))
      body.push(infoRow('状态', d.active ? '通道开着' : (d.hasToken ? '有 token，通道关着' : '还没配 token')))
      var urlInput = h('input', { class: 'fw-input', type: 'text', value: d.baseUrl || '', 'aria-label': 'QQ Agent 桥地址' })
      var tokenInput = h('input', { class: 'fw-input', type: 'password', placeholder: d.hasToken ? '已保存 ' + d.tokenPreview : '粘贴配套插件给的 token', 'aria-label': 'QQ Agent 桥 token' })
      var resultLine = statusLine('')
      function save(patch) {
        postJSON('/dsh-fish-world/qqagent', patch)
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || '保存失败')
            return loadQQAgent()
          })
          .catch(function (e) { state.errors.qqagent = e.message; render() })
      }
      body.push(h('div', { class: 'fw-field' }, [h('label', { class: 'fw-field-label', text: '地址' }), urlInput]))
      body.push(h('div', { class: 'fw-field' }, [h('label', { class: 'fw-field-label', text: 'token' }), tokenInput]))
      body.push(h('div', { class: 'fw-row' }, [
        ghostButton('保存', function () { save({ baseUrl: urlInput.value, token: tokenInput.value }) }),
        ghostButton('生成 token', function () {
          postJSON('/dsh-fish-world/qqagent', { action: 'rotate-token' })
            .then(function (r) {
              if (r && r.token) { tokenInput.value = r.token; resultLine.textContent = '已生成，复制到配套插件的 FISHWORLD_BRIDGE_TOKEN'; resultLine.dataset.tone = 'success' } else { throw new Error(r && r.error ? r.error : '生成失败') }
              return loadQQAgent()
            })
            .catch(function (e) { resultLine.textContent = e.message; resultLine.dataset.tone = 'error' })
        }),
        ghostButton('试连', function () {
          resultLine.textContent = '正在试…'
          resultLine.dataset.tone = ''
          postJSON('/dsh-fish-world/qqagent', { action: 'test' })
            .then(function (r) {
              if (r && r.health && r.health.ok) {
                var n = Array.isArray(r.tools) ? r.tools.length : 0
                resultLine.textContent = '连通了，QQ-agent 里有 ' + n + ' 个工具可借'
                resultLine.dataset.tone = 'success'
              } else {
                resultLine.textContent = '连不上：' + ((r && r.health && r.health.error) || (r && r.error) || '未知原因')
                resultLine.dataset.tone = 'error'
              }
            })
            .catch(function (e) { resultLine.textContent = e.message; resultLine.dataset.tone = 'error' })
        }),
      ]))
      body.push(resultLine)
      body.push(switchRow({
        label: '允许借手',
        hint: '打开后鱼才能调 QQ-agent 的工具（工具执行在那边，说话仍在这边）',
        checked: d.enabled === true,
        onChange: function (next) { save({ enabled: next }) },
      }))
    }
    // 与「走 AstrBot 只需要装一个插件」同排：两张都是「另一侧要做什么」。
    return card({ key: 'qqagent', title: '借手 · QQ Agent', note: '借它的插件工具，不借它的嘴', span: 6, children: body })
  }

  function viewAstrbot() {
    var data = state.astrbot
    var viaBot = Boolean(data && data.transport === 'astrbot')
    var blocked = Boolean(state.errors.astrbot)
    var busy = state.astrbotBusy

    // 切换通道：失败要当场说出来。原先只把错误写进 state 再重绘，
    // 而重绘会把卡片里那行状态清掉，看起来就像「点了没反应」。
    function switchTo(mode, statusNode) {
      if (!statusNode) return
      statusNode.dataset.tone = ''
      statusNode.textContent = mode === 'astrbot' ? '正在切到 AstrBot…' : '正在切到直连…'
      postJSON('/dsh-fish-world/astrbot', { transport: mode })
        .then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || '切换失败')
          state.astrbot = r
          delete state.errors.astrbot
          statusNode.textContent = ''
          render()
        })
        .catch(function (e) {
          statusNode.dataset.tone = 'error'
          statusNode.textContent = '切不过去：' + e.message
        })
    }

    // ---- 卡一：直连协议端 SnowLuma ----
    var snowStatus = statusLine('')
    var snowCard = card({
      key: 'astrbot-snowluma',
      title: 'SnowLuma 直连',
      note: viaBot ? '未使用' : '当前在用',
      span: 6,
      children: [
        h('p', { class: 'fw-card-note', text: '鱼直接通过协议端的 OneBot HTTP 收发消息，不经过 AstrBot。这是默认走法。' }),
        blocked
          ? statusLine('读取失败：' + state.errors.astrbot, 'error')
          : h('div', { class: 'fw-row' }, [
            h('span', { class: 'fw-row-label' }, [
              h('span', { text: '状态' }),
              h('span', { class: 'fw-row-hint', text: '端口 3000 · 由 dsh-qq-bridge 或 AstrBot 的桥插件以外的协议端直连' }),
            ]),
            h('span', {
              class: 'fw-badge',
              dataset: { tone: viaBot ? '' : 'success' },
              text: viaBot ? '已让给 AstrBot' : '直连中',
            }),
          ]),
        h('div', { class: 'fw-btn-row' }, [
          viaBot
            ? button('切回直连', function () { switchTo('snowluma', snowStatus) }, 'primary')
            : button('正在用这条路', function () {}, 'primary'),
        ]),
        snowStatus,
      ],
    })

    // ---- 卡二：经由 AstrBot ----
    var botBody = []
    if (blocked) {
      botBody.push(statusLine('读取失败：' + state.errors.astrbot, 'error'))
    } else if (!data) {
      botBody.push(statusLine('读取中…'))
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

      botBody.push(h('p', { class: 'fw-card-note', text: '已经装了 AstrBot 的话，可以不用再配一套协议端：把 QQ 交给它，鱼只管说话。' }))

      // 一键接入：探测 → 生成 token → 验证。token 只显示这一次。
      var connectStatus = statusLine('')
      var connectBox = h('div', { class: 'fw-connect' })
      var connectTokenRow = null

      function setConnect(result) {
        connectBox.textContent = ''
        if (connectTokenRow) connectTokenRow.textContent = ''
        if (!result) {
          connectBox.appendChild(h('p', { class: 'fw-card-note', text: '还没试过。点下面的按钮，剩下的我来做。' }))
          return
        }
        connectBox.appendChild(h('p', { class: 'fw-connect-step', text: result.step }))
        if (result.account) connectBox.appendChild(h('p', { class: 'fw-card-note', text: 'AstrBot 登录的账号：' + result.account }))
        if (result.next) connectBox.appendChild(h('p', { class: 'fw-connect-next', text: '下一步：' + result.next }))
        if (result.token) {
          connectBox.appendChild(h('p', { class: 'fw-card-note', text: 'token（只显示这一次，复制走贴到 AstrBot 的桥插件配置里）' }))
          connectTokenRow = h('div', { class: 'fw-btn-row' }, [
            h('input', { class: 'fw-input', type: 'text', value: result.token, readonly: true, 'aria-label': '桥 token' }),
            button('复制 token', function () {
              copyText(result.token, function (ok) {
                connectStatus.textContent = ok ? '已复制，去 AstrBot 的桥插件设置里粘贴即可。' : '浏览器不让复制，请手动选中上面这行复制。'
                connectStatus.dataset.tone = ok ? 'success' : ''
              })
            }),
          ])
          connectBox.appendChild(connectTokenRow)
        }
        if ((result.tried || []).length && result.status === 'not-found') {
          connectBox.appendChild(h('p', {
            class: 'fw-card-note',
            text: '试过这些地址：' + result.tried.map(function (t) { return t.base }).join('、'),
          }))
        }
      }

      setConnect(state.astrbotConnect || (data.active ? {
        status: 'connected',
        step: '已接入：' + (data.baseUrl || ''),
        next: data.canUseForQQ
          ? 'QQ 正在走 AstrBot。想切回去，用左边那张卡。'
          : '点下面「切到 AstrBot」让鱼改用 AstrBot 收发 QQ。',
      } : null))

      botBody.push(connectBox)
      var viaStatus = statusLine('')

      function doConnect() {
        if (busy) return
        state.astrbotBusy = true
        connectStatus.dataset.tone = ''
        connectStatus.textContent = '正在生成 token 并探测本机…'
        render()
        postJSON('/dsh-fish-world/astrbot', { action: 'connect' })
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || '接入失败')
            state.astrbot = r
            state.astrbotConnect = r.connect || null
            delete state.errors.astrbot
          })
          .catch(function (e) { state.errors.astrbot = e.message })
          .then(function () { state.astrbotBusy = false; render() })
      }

      // 连通状态：先让人看清走到哪一步，再给唯一的那个主操作。
      botBody.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label' }, [
          h('span', { text: '连通' }),
          h('span', { class: 'fw-row-hint', text: data.baseUrl || '地址未填' }),
        ]),
        h('span', {
          class: 'fw-badge',
          dataset: { tone: data.canUseForQQ ? 'success' : '' },
          text: data.canUseForQQ ? 'QQ 走 AstrBot' : (data.active ? '已连通' : (data.hasToken ? '未连通' : '还没接入')),
        }),
      ]))

      // 这张卡只放一个主操作：没连通时是「一键接入」，连通后它变成「切到 AstrBot」。
      // 两个按钮并排摆着，人会不知道该点哪个。
      var canSwitch = data.active === true
      var primaryBtn = canSwitch
        ? button(viaBot ? '正在用这条路' : '切到 AstrBot', function () {
          if (!viaBot) switchTo('astrbot', viaStatus)
        }, 'primary')
        : button(busy ? '正在接入…' : (state.astrbotConnect ? '重新探测' : '一键接入'), doConnect, 'primary')
      botBody.push(h('div', { class: 'fw-btn-row' }, [primaryBtn]))
      botBody.push(viaStatus)
      botBody.push(connectStatus)

      // 借用工具与手动配置：都收进这一张卡，默认折起。
      botBody.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
        h('h3', { class: 'fw-card-title', text: '走 AstrBot 时还能做什么' }),
      ]))
      botBody.push(switchRow({
        label: '借用 AstrBot 的插件工具',
        hint: '只借「手」不借「嘴」：AstrBot 执行工具返回原始结果，说话仍然是你这条鱼',
        checked: data.borrowTools === true,
        onChange: function (next) { saveAstrbot({ borrowTools: next }) },
      }))

      var advanced = h('details', { class: 'fw-details' }, [
        h('summary', { text: '手动配置（桥不在本机时）' }),
        switchRow({
          label: '启用 AstrBot 接入',
          hint: '关掉后这张卡里的开关都不起作用；一键接入成功会自动打开',
          checked: data.enabled === true,
          onChange: function (next) { saveAstrbot({ enabled: next }) },
        }),
        field('baseUrl', '桥地址', {
          value: data.baseUrl,
          placeholder: 'http://127.0.0.1:6210',
          hint: '一键接入会自动探测；手动改时非本机地址必须用 https。',
        }),
        field('ownerUmo', '主人会话（可选）', {
          value: data.ownerUmo,
          placeholder: '例如 aiocqhttp:FriendMessage:123456',
          hint: '留空时，桥会用最后一条收到的消息推导。',
        }),
        field('pollMs', '收消息间隔（毫秒）', {
          type: 'number',
          value: data.pollMs,
          hint: '默认 3000；越小越及时，越费资源。',
        }),
        h('div', { class: 'fw-btn-row' }, [
          button('保存', function () {
            saveAstrbot({
              baseUrl: String(fields.baseUrl.value || '').trim(),
              ownerUmo: String(fields.ownerUmo.value || '').trim(),
              pollMs: Number(fields.pollMs.value),
            })
          }, 'primary'),
          data.hasToken ? button('清除 token', function () { saveAstrbot({ token: null }) }) : null,
        ].filter(Boolean)),
      ])
      if (state.astrbotConnect && state.astrbotConnect.status === 'token-mismatch') advanced.open = true
      botBody.push(advanced)
    }

    var botCard = card({
      key: 'astrbot',
      title: '经由 AstrBot',
      note: viaBot ? '当前在用' : '备选走法',
      span: 6,
      children: botBody,
    })

    return [
      snowCard,
      botCard,
      // 下面两张都是「另一侧要做什么」：一张说 AstrBot 装插件，一张说 QQ Agent 借工具。
      // 各占 6 列并排，别让其中一张单独占一行、右边空出半屏。
      card({
        key: 'astrbot-bridge-guide',
        title: '走 AstrBot 只需要装一个插件',
        note: '在 AstrBot 那边',
        span: 6,
        children: [
          h('p', { class: 'fw-prose', text: '在 AstrBot 里装好「鱼世界桥」插件，其余全部由「一键接入」完成。' }),
          h('div', { class: 'fw-plainlist' }, [
            h('p', { class: 'fw-plainlist-item', text: '在 AstrBot 插件市场搜索「鱼世界桥」安装（或从 github.com/1838601405/astrbot_plugin_fishworld_bridge 上传安装）。' }),
            h('p', { class: 'fw-plainlist-item', text: '装好重载插件，然后回到「经由 AstrBot」卡上点「一键接入」。' }),
          ]),
          h('p', { class: 'fw-card-note', text: '一键接入会自动生成 token、探测本机端口、验证连通。只有 token 对不上时才需要你复制一次，贴到 AstrBot 的桥插件配置里。' }),
          h('p', { class: 'fw-card-note', text: '桥只会监听本机，且每次请求都要 token；AstrBot 的登录态不会离开它自己的进程。' }),
          h('p', { class: 'fw-card-note', text: '切到 AstrBot 后，dsh-qq-bridge 不再是必需依赖，体检也不会再提醒你装它。' }),
        ],
      }),
      qqAgentCard(),
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

  // ---- 鱼的设定：名字、称呼、角色卡 ----
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
        h('span', { class: 'fw-row-hint', text: '改完之后，面板与提示词里都用这个名字。' }),
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

      // ---- 主人：谁是你的主人、它的数据放进哪一间会话 ----
      // 这两样以前只在「鱼与世界」里**只读**显示三处绑定，改不了；
      // 而「鱼怎么称呼你」放在这里。主人的事应当和称呼放在一起，都是「设定」。
      children.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-6)' }, [
        h('h3', { class: 'fw-card-title', text: '主人' }),
      ]))
      children = children.concat(ownerBindingBody(data))

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

      // ---- 内置预设：点一下把正文填进输入框，保存后才生效 ----
      var presets = persona.presets || []
      var presetHint = h('p', {
        class: 'fw-card-note',
        text: presets.length ? '内置预设：点一下填进下面，保存后才生效。' : '没有内置预设。',
      })
      children.push(h('div', { class: 'fw-field', style: 'margin-top:var(--space-5)' }, [
        h('label', { class: 'fw-field-label', text: '预设角色卡' }),
        presetHint,
      ]))
      if (presets.length) {
        children.push(h('div', { class: 'fw-btn-row' }, presets.map(function (p) {
          var label = p.name + (p.subtitle ? '（' + p.subtitle + '）' : '')
          return button(label, function () {
            presetHint.textContent = '正在载入「' + p.name + '」…'
            getJSON('/dsh-fish-world/fish/persona?preset=' + encodeURIComponent(p.id))
              .then(function (d) {
                if (!d || d.ok === false) throw new Error((d && d.error) || '读取失败')
                personaArea.value = d.text || ''
                personaArea.scrollTop = 0
                presetHint.textContent = '已载入「' + p.name + '」（' + (d.bytes || 0) + ' 字节），点下面的保存才会生效。'
              })
              .catch(function (e) { presetHint.textContent = '载入失败：' + e.message })
          })
        })))
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

      // 目录到底建了没：不建也能跑（首次写入时才创建），但主人常常想知道"东西在哪"。
      storageBody.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: '目录结构' }),
        statusDot(
          storageInfo.exists ? '已建立' : '尚未建立',
          storageInfo.exists ? 'ok' : 'neutral',
        ),
      ]))

      storageBody.push(h('div', { class: 'fw-btn-row' }, [
        ghostButton(storageInfo.exists ? '重新建立目录' : '一键建立目录', function () {
          state.storageNotice = { tone: '', text: '正在建立…' }
          render()
          postJSON('/dsh-fish-world/storage', { action: 'mkdir' })
            .then(function (r) {
              if (r && r.ok === false) throw new Error(r.error || '建立失败')
              state.storage = r
              state.storageNotice = { tone: 'success', text: '已建立：' + (r.root || '') }
              loadStickerDir()
              loadLinks()
              render()
            })
            .catch(function (e) {
              state.storageNotice = { tone: 'error', text: '建立失败：' + e.message }
              render()
            })
        }),
        ghostButton('恢复默认', function () {
          postJSON('/dsh-fish-world/storage', { root: '' })
            .then(function (r) {
              if (r && r.ok === false) throw new Error(r.error || '保存失败')
              state.storage = r
              state.storageNotice = null
              loadStorage()
              loadStickerDir()
              loadLinks()
            })
            .catch(function (e) { setError('storage', e.message) })
        }),
      ]))
      if (state.storageNotice) {
        storageBody.push(statusLine(state.storageNotice.text, state.storageNotice.tone))
      }

      var folders = storageInfo.folders || {}
      storageBody.push(h('div', { class: 'fw-plainlist' }, [
        ['鱼之宝库', folders.collection],
        ['图库', folders.gallery],
        ['网站链接', folders.sites],
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
      card({ key: 'profile', title: '鱼的设定', note: '名字、称呼、主人、角色卡与人设', children: children }),
      card({ key: 'storage', title: '存储位置', note: storageInfo && storageInfo.bound ? '跟随工作区' : '默认位置', span: 12, children: storageBody }),
    ]
  }

  // 心情维度不在这里另列一份表：dsh-feiyu-mood 的 /state 已经把 dims
  // 连同中文标签一起给出来（key / label / value），这里直接照它渲染。
  // 自己维护列表就会和上游漂移——上游改了名字或加了一维，这边会悄悄少一栏。

  // 游戏数值面板的一行：标签 + 条 + 数值
  // 极端值处理：>100% 时条填满并转警告色，数值仍显示真实百分比（一位小数）
   function statRow(label, value, max) {
    var top = max || 100
    var raw = Number(value)
    if (!Number.isFinite(raw)) raw = 0
    var ratio = raw / top
    var clamped = Math.max(0, Math.min(1, ratio))
    var overflow = ratio > 1
    // 数值保留一位小数并始终带 %，等宽数字保证小数点竖直对齐；
    // 溢出时条形填满并转错误色，不会突破容器。
    var shown = (ratio * 100).toFixed(1) + '%'
    return h('div', { class: 'fw-row fw-stat' }, [
      h('span', { class: 'fw-stat-label', text: label, title: label }),
      h('span', { class: 'fw-stat-bar', title: shown }, [
        h('i', {
          style: 'width:' + (clamped * 100).toFixed(1) + '%'
            + (overflow ? ';background:var(--text-feedback-error)' : ''),
        }),
      ]),
      h('span', { class: 'fw-stat-value', text: shown, title: shown }),
    ])
  }

  /** 鱼的记忆：记忆目录里有哪几份、几条，向量档开没开、索引新不新。 */
  function knowledgeChildren() {
    var k = state.knowledge
    var body = []
    if (state.errors.knowledge) {
      body.push(statusLine('读取失败：' + state.errors.knowledge, 'error'))
      return body
    }
    if (!k) {
      body.push(statusLine('读取中…'))
      return body
    }
    if (k.ok === false && k.error) body.push(statusLine(k.error, 'error'))

    var files = Array.isArray(k.files) ? k.files : []
    if (files.length) {
      body.push(h('div', { class: 'fw-plainlist' }, files.map(function (file) {
        return h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label', text: file.name }),
          h('span', {
            class: 'fw-row-value',
            text: file.exists ? (Math.max(1, Math.round(Number(file.bytes || 0) / 1024)) + ' KB') : '还没有',
            title: file.exists && file.mtime ? new Date(file.mtime).toLocaleString() : '',
          }),
        ])
      })))
    }
    body.push(infoRow('条目', k.items == null ? '—' : String(k.items) + ' 条'))
    // 位置只写相对目录：绝对路径在「鱼的设定 → 存储位置」已经写过一次。
    // 索引本身也不用另立文件说明——下面的「重建索引」按当前内容直接重算，
    // 位置固定跟着记忆目录走，不需要主人记住它在哪。
    body.push(infoRow('位置', k.folder ? relPath(k.folder, state.storage && state.storage.root) : '—'))
    body.push(infoRow('索引', k.index
      ? (k.index.model || '未知模型') + ' · ' + (k.index.dim || 0) + ' 维' + (k.indexFresh ? ' · 最新' : ' · 要重建')
      : '还没有'))
    if (!k.indexFresh && k.indexWhy) body.push(statusLine(k.indexWhy))

    var cfg = k.config || {}
    body.push(switchRow({
      label: '用向量档（本机小模型）',
      hint: '默认关：关着只按字面匹配；开着用 ' + (cfg.localModel || 'bge-small-zh') + ' 算相似度',
      checked: cfg.enabled === true,
      onChange: function (next) {
        postJSON('/dsh-fish-world/world/knowledge', { enabled: next })
          .then(function () { return loadKnowledge() })
          .catch(function (e) { state.errors.knowledge = e.message; render() })
      },
    }))
    body.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '索引维护' }),
      ghostButton('重建索引', function () {
        postJSON('/dsh-fish-world/world/knowledge', { rebuild: true })
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || '重建失败')
            return loadKnowledge()
          })
          .catch(function (e) { state.errors.knowledge = e.message; render() })
      }),
    ]))
    return body
  }

  function viewStatus() {
    var mood = state.mood

    // 鱼的心情：只读 dsh-feiyu-mood 的 /state。
    // 维度、标签、档位名、理由全部用它返回的数据，这边不再自己定义一套。
    var moodChildren = []
    if (state.errors.mood) {
      moodChildren.push(statusLine('读取失败：' + state.errors.mood, 'error'))
    } else if (!mood || !mood.ok) {
      moodChildren.push(statusLine('读取中…'))
    } else {
      moodChildren.push(h('div', { class: 'fw-stat-hero' }, [
        h('span', { class: 'fw-stat-hero-value', text: String(mood.mood == null ? '—' : mood.mood) }),
        h('span', { class: 'fw-stat-hero-label', text: (mood.emoji || '') + ' ' + (mood.moodLabel || '心情') }),
      ]))
      moodChildren.push(h('div', {}, (mood.dims || []).map(function (dim) {
        return statRow(dim.label || dim.key, dim.value)
      })))
      if (mood.lastReason) {
        moodChildren.push(h('p', { class: 'fw-prose', text: '“' + mood.lastReason + '”' }))
      }
    }

    return [
      // 头像卡：样子随心情变化
      card({
        key: 'status-portrait',
        title: '鱼的样子',
        note: fishLine('portrait', (state.portrait && state.portrait.emotion) || '') || '随心情变化',
        span: 4,
        children: [renderPortrait()],
      }),
      card({ key: 'status-mood', title: '鱼的心情', note: '读数来自 dsh-feiyu-mood', span: 8, children: moodChildren }),
      card({
        key: 'status-mood-badge',
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
      frame.appendChild(emptyState('还没有头像：先在「鱼的设定」里装角色卡'))
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
    // 这一行小字是「鱼此刻说的一句」，不是使用说明：按当前情绪抽一句 ≤18 字的话。
    // 「把情绪图放进哪个目录」那种操作方法，写在下方情绪图目录字段的 hint 里。
    body.push(h('p', { class: 'fw-card-note', text: fishLine('portrait', p.emotion) || p.note || '' }))

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
      children.push(h('div', { class: 'fw-gallery-stats' }, [
        h('span', { class: 'fw-badge', text: '共 ' + items.length + ' 张' }),
        h('span', { class: 'fw-card-note', text: '悬停格子显示删除；名称与标签过长会截断' }),
      ]))

      // 图库放哪：只写相对位置 + 一句「去存储位置改」，不再重复整条绝对路径。
      // 换目录仍然可以就地换 —— 这是这张卡自己的事，不用跑去另一页。
      if (dirInfo && dirInfo.dir) {
        children.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label' }, [
            h('span', { text: '图库位置' }),
            h('span', { class: 'fw-row-hint', text: relPath(dirInfo.dir, state.storage && state.storage.root) }),
          ]),
          ghostButton('换目录', function () {
            openDirPicker({
              title: '选择图库目录',
              start: dirInfo.dir,
              onPick: function (picked) {
                postJSON('/dsh-fish-world/storage', { gallery: picked })
                  .then(function (r) {
                    if (r && r.ok === false) throw new Error(r.error || '保存失败')
                    state.storage = r
                    loadStickerDir()
                  })
                  .catch(function (e) { setError('stickerDir', e.message) })
              },
            })
          }),
        ]))
        children.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label', text: '支持格式' }),
          h('span', { class: 'fw-badge', text: (dirInfo.formats || []).join(' / ') }),
        ]))
        // 情绪图目录也只在存储位置显示完整路径，这里给一句命名规则就够。
        if (state.portrait && state.portrait.dir) {
          children.push(h('div', { class: 'fw-row' }, [
            h('span', { class: 'fw-row-label' }, [
              h('span', { text: '情绪图（头像用）' }),
              h('span', { class: 'fw-row-hint', text: '按情绪命名放图：happy / calm / sweet / heartache / worry / sad / jealous' }),
            ]),
            h('span', { class: 'fw-badge', text: relPath(state.portrait.dir, state.storage && state.storage.root) }),
          ]))
        }
        if (storageInfo && storageInfo.root) {
          children.push(h('p', { class: 'fw-card-note', text: '鱼的工作区：' + storageInfo.root }))
        }
        if (dirInfo.note) children.push(h('p', { class: 'fw-card-note', text: dirInfo.note }))
      }

      if (!items.length) children.push(emptyState('还没有收藏的表情。鱼会在聊天里按心情收藏，你也可以把图片放进上面的目录。'))
      else {
        // 图库是这一页内容最多的一块：用缩略图网格铺开，卡片按内容自然长高。
        // 图片还没加载 / 加载失败时，缩略图位置保留同样大小的灰底占位，
        // 不会因为“现在没图”就把卡片压扁。
        children.push(h('div', { class: 'fw-gallery-grid' }, items.map(function (item) {
          var img = h('img', {
            class: 'fw-gallery-img',
            src: '/dsh-fish-world/sticker-image?id=' + encodeURIComponent(item.id),
            alt: item.name || '表情',
            loading: 'lazy',
            draggable: 'false',
            title: item.name || '未命名',
          })
          // 加载失败就隐藏图片，留下同一尺寸的占位方块（不是破图）
          img.addEventListener('error', function () { img.hidden = true })

          var tags = (item.tags || []).join('、') || '无标签'
          var label = item.name || '未命名'
          var delBtn = h('button', {
            class: 'fw-btn fw-btn-ghost fw-gallery-del',
            type: 'button',
            text: '删除',
            title: '删除「' + label + '」',
            'aria-label': '删除「' + label + '」',
          })
          delBtn.addEventListener('click', function () {
            postJSON('/dsh-fish-world/stickers/remove', { id: item.id })
              .then(function () { loadStickers() })
              .catch(function (e) { setError('stickers', e.message) })
          })
          return h('figure', { class: 'fw-gallery-item' }, [
            h('div', { class: 'fw-gallery-frame' }, [img, delBtn]),
            h('figcaption', { class: 'fw-gallery-meta' }, [
              h('span', { class: 'fw-sticker-name', text: label, title: label }),
              h('span', { class: 'fw-sticker-tags', text: tags, title: tags }),
            ]),
          ])
        })))
      }
    }
    return [
      // 便当盒跨度按内容量分：图库是这一页的主体（100+ 张缩略图），吃 8 列；
      // 网站条目少、表单可竖排，给 4 列，两块内边距与圆角保持完全一致。
      card({ key: 'collection-sites', title: '网站收藏', note: '按分类编号 · 资源与灵感站点', span: 4, children: [renderLinkLibrary()] }),
      card({ key: 'collection-gallery', title: '图片收藏', note: '表情与图片 · 每小时最多 5 张', span: 8, children: children }),
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
      body.push(h('div', { class: 'fw-btn-row' }, [button('记下', submitAdd, 'primary')]))
      body.push(addStatus)

      if (!items.length) {
        body.push(emptyState('还没有记录。你让它记什么，它就会一条一条记在这里。'))
      } else {
        body.push(h('div', { class: 'fw-list', style: 'margin-top:var(--space-3)' }, items.map(function (item) {
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
    }

    var note = data ? String((data.items || []).length) + ' 条' : '读取中'
    return card({ key: 'records', title: '鱼的记录', note: note, span: 6, children: body })
  }

  // ---------- 小本本（独立卡片）----------
  // 没被回复的请求会记在这里。布局与「鱼的请求 / 鱼的记录」保持一致：
  // 卡片头（标题 + 计数）→ 一句说明 → 列表；每条只有 元信息 → 请求原文 → 说明/解释 → 操作行，
  // 不再把「为什么记」和解释堆成两段灰字。
  function renderGrudgeCard() {
    var data = state.records
    var body = []
    if (state.errors.records) {
      body.push(statusLine('读取失败：' + state.errors.records, 'error'))
    } else if (!data) {
      body.push(statusLine('读取中…'))
    } else {
      var open = (data.grudges || []).filter(function (g) { return g.status !== 'accepted' })
      body.push(h('div', { class: 'fw-card-head' }, [
        h('h3', { class: 'fw-card-title', text: '待解释' }),
        h('span', { class: 'fw-card-note', text: open.length + ' 条' }),
      ]))
      body.push(h('p', { class: 'fw-card-note', text: '请求当天没被回复，它会记在这里；你给出解释、它认可后才划掉。' }))
      if (!open.length) {
        body.push(emptyState('小本本是空的，说明请求都有回应。'))
      } else {
        body.push(h('div', { class: 'fw-list' }, open.map(function (grudge) {
          var explainInput = h('input', {
            class: 'fw-input',
            type: 'text',
            value: grudge.explanation || '',
            placeholder: '给它的解释…',
            'aria-label': '解释',
          })
          explainInput.hidden = grudge.status !== 'open'
          var why = grudge.why || '这个请求当天没等到你的答复，鱼就记下了。'
          return h('div', { class: 'fw-item' }, [
            h('div', { class: 'fw-item-meta' }, [
              h('span', { text: grudge.day || shortTime(grudge.at) }),
              h('span', {
                class: 'fw-badge',
                dataset: { tone: grudge.status === 'explained' ? 'success' : '' },
                text: GRUDGE_LABELS[grudge.status] || grudge.status,
              }),
            ]),
            h('p', { class: 'fw-item-text fw-clamp-2', text: grudge.text }),
            h('p', { class: 'fw-row-hint fw-clamp-1', text: grudge.status === 'explained'
              ? '你的解释：' + (grudge.explanation || '（空）')
              : why, title: grudge.status === 'explained' ? grudge.explanation : why }),
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

    // 与「鱼的请求 / 鱼的记录」共用同一套卡片层级，只是分成两列放：
    // 左列 请求原文 + 为什么被记，右列 解释输入 + 操作。
    var openCount = data ? (data.grudges || []).filter(function (g) { return g.status !== 'accepted' }).length : 0
    return card({
      key: 'grudges',
      title: '小本本',
      note: data ? String(openCount) + ' 条' : '读取中',
      span: 12,
      children: body,
    })
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
    // 同样只写相对位置；完整路径统一在「鱼的设定 → 存储位置」。
    if (summary.dir) {
      body.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label' }, [
          h('span', { text: '清单位置' }),
          h('span', { class: 'fw-row-hint', text: relPath(summary.dir, state.storage && state.storage.root) + '（网站清单.md / links.json）' }),
        ]),
        ghostButton('换目录', function () {
          openDirPicker({
            title: '选择网站清单目录',
            start: summary.dir,
            onPick: function (picked) {
              postJSON('/dsh-fish-world/storage', { sites: picked })
                .then(function (r) {
                  if (r && r.ok === false) throw new Error(r.error || '保存失败')
                  state.storage = r
                  loadLinks()
                })
                .catch(function (e) { setError('links', e.message) })
            },
          })
        }),
      ]))
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
    return [card({ key: 'qzone', title: 'QQ 空间额度', note: '空间属于鱼自己的 QQ 号', span: 8, children: children })]
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
    return [
      card({ key: 'extensions', title: '扩展', note: '从链接安装，插件自身不托管', span: 6, children: children }),
      // 「面板显示」原为独立分区，现并入本页，作为一张卡
      card({
        key: 'display-flags',
        title: '面板显示',
        note: '只控制显隐，不影响朗读等行为',
        span: 6,
        children: displayFlagRows(),
      }),
      card({
        key: 'theme',
        title: '主题',
        note: '只影响面板配色',
        span: 12,
        children: [
          h('div', { class: 'fw-btn-row', style: 'margin-top:0' }, [
            button('浅色', function () { setTheme('light') }),
            button('深色', function () { setTheme('dark') }),
            button('跟随系统', function () { setTheme('') }),
          ]),
        ],
      }),
      // 「本地存储」与上面几张同属运维：文件落在哪、留了什么。
      // 它原来在「鱼的成长」页，但那里讲的是「鱼想明白了什么」，不是磁盘。
      activityCard(),
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

  function loadWishes() {
    // 选了日期就只读那一天的历史；不选读全部。
    var q = state.wishDate ? '?date=' + encodeURIComponent(state.wishDate) : ''
    return getJSON('/dsh-fish-world/world/wishes' + q)
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
  function switchTransport(mode) {
    postJSON('/dsh-fish-world/astrbot', { transport: mode })
      .then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || '切换失败')
        if (state.errors) delete state.errors.astrbot
        return loadAstrbot()
      })
      .catch(function (e) { state.errors.astrbot = e.message; render() })
  }

  function loadQQAgent() {
    return getJSON('/dsh-fish-world/qqagent')
      .then(function (d) { state.qqagent = d; markLoaded('qqagent') })
      .catch(function (e) { state.errors.qqagent = e.message })
      .then(render)
  }

  function loadAstrbot() {
    return getJSON('/dsh-fish-world/astrbot')
      .then(function (d) { state.astrbot = d; markLoaded('astrbot') })
      .catch(function (e) { state.errors.astrbot = e.message })
      .then(render)
  }

  // 聊天窗口：授权表 + 可绑定的会话 + 收信状态，一次读回来。
  function loadQQChat() {
    return getJSON('/dsh-fish-world/qq/chat')
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.qqChat = d
        delete state.errors.qqChat
        markLoaded('qqChat')
      })
      .catch(function (e) { state.errors.qqChat = e.message })
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

  function loadKnowledge() {
    return getJSON('/dsh-fish-world/world/knowledge')
      .then(function (d) { state.knowledge = d; markLoaded('knowledge') })
      .catch(function (e) { state.errors.knowledge = e.message })
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
    // 不带查询串：宿主的路由是按精确路径匹配的，带 ?date= 会匹配不上（表现为 HTTP 400）。
    // 日期筛选放在前端做，拿到的永远是全量再按天过滤。
    state.loading.diary = true
    return getJSON('/dsh-fish-world/world/diary')
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
        loadMood(), loadTts(), loadDiary(), loadEnv(), loadCapabilities(),
        loadWishes(), loadGrowth(), loadPlatforms(), loadProfile(),
        loadStickers(), loadQzone(), loadExtensions(), loadAstrbot(), loadQQAgent(),
      ])
    }
    if (view === 'diary') return loadDiary()
    if (view === 'status') return loadMood().then(loadPortrait)
    if (view === 'wishes') return Promise.all([loadWishes(), loadRecords(), loadStickerWishes()])
    if (view === 'growth') return Promise.all([loadGrowth(), loadKnowledge(), loadActivity()])
    if (view === 'doctor') return Promise.all([
      getJSON('/dsh-fish-world/doctor/dependency')
        .then(function (d) { state.doctorDep = d; markLoaded('doctorDep') })
        .catch(function (e) { state.errors.doctorDep = e.message }),
      getJSON('/dsh-fish-world/doctor/storage')
        .then(function (d) {
          if (d && d.ok === false) throw new Error(d.error || '检查失败')
          state.doctorStorage = d
        })
        .catch(function (e) { state.errors.doctorStorage = e.message }),
    ]).then(render)
    if (view === 'profile') return Promise.all([loadProfile(), loadPersona(), loadStorage()])
    if (view === 'platforms') return Promise.all([loadPlatforms(), loadActivity(), loadStorage(), loadQQChat()])
    if (view === 'astrbot') return Promise.all([loadAstrbot(), loadQQAgent()])
    if (view === 'stickers') return Promise.all([loadStickers(), loadStickerDir(), loadLinks(), loadStorage(), loadRecords()])
    if (view === 'qzone') return loadQzone()
    // 扩展与设置里也有「本地存储」卡：留存与请求历史都要读。
    if (view === 'extensions') return Promise.all([loadExtensions(), loadActivity(), loadWishes()])
    return Promise.resolve()
  }

  // ---------- 渲染 ----------
  var main = null
  var nav = null

  function navigate(view) {
    var changed = state.view !== view
    state.view = view
    // 每次「进入」分区都重抽一次卡片上的鱼话；同一屏内重绘不换字
    if (changed) reshuffleFishLines()
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
    if (state.view === 'astrbot') return viewAstrbot()
    if (state.view === 'profile') return viewProfile()
    if (state.view === 'stickers') return viewStickers()
    // QQ 空间已并入「鱼与世界」的鱼与 QQ 卡片
    if (state.view === 'qzone') return viewPlatforms()
    if (state.view === 'extensions') return viewExtensions()
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
    gridState.layout = null
    currentView().forEach(function (node) { main.appendChild(node) })
    // 每个分区都恢复用户保存的顺序：拖拽在哪个页面做的，刷新后还在原处。
    applySavedOrder(main)
    // 位置由数据算：先量高度再排布，卡片绝对定位，刷新后就是设计好的 Bento 布局
    relayout(main, { animate: false })
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
        h('span', { text: '请注意，本项目为 AI 许愿产物。' }),
      ]),
    ])

    main = h('div', { class: 'fw-main' })
    // 设置页 iframe 自带外框留白，内容区留白收紧一点即可
    if (SETTINGS_MODE) main.dataset.compact = 'true'
    stage.appendChild(h('div', { class: 'fw-shell' }, [rail, main]))

    bindDragAndDrop(main)

    // 默认「全部日期」：直接看到所有日记，而不是先碰上一个空的“今天”
    state.diaryDate = ''
    render()
    loadView('overview')
    // 开关要真的作用到宿主挂件上（否则就是「点了没反应」）
    watchDisplayFlags()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build)
  else build()

  // 供探针/审查区读取真实状态
  window.__fishWorldPanel = { state: state, navigate: navigate, render: render }
})()
