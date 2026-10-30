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

  // 导航按「日常 → 世界 → 配置」分三组：组间留 --space-4，组内 1px。
  // 「鱼的记忆」聚合了知识库 / 图片收藏 / 网站链接 / 图片整理；
  // 原来独立的「鱼之宝库」入口已并入这里，不再保留第二个入口。
  var NAV = [
    { id: 'overview', label: '总览', group: '日常' },
    { id: 'diary', label: '鱼的日记', group: '日常' },
    { id: 'wishes', label: '鱼的请求', group: '日常' },
    { id: 'growth', label: '鱼的成长', group: '日常' },
    { id: 'memory', label: '鱼的记忆', group: '日常' },
    { id: 'status', label: '鱼的状态', group: '世界' },
    { id: 'platforms', label: '鱼与世界', group: '世界' },
    // 整合包挨着「鱼与世界」：一个管外面那些平台，一个管里面这些插件，都是「这条鱼靠什么活着」。
    // 页面里放的是「这里独有的」几张卡（整合包概览 / 重复的能力 / 鱼的家 / 动作清单），
    // 整合范围在「体检与更新」、记忆中枢与时间线在「鱼的记忆」——不跟别的入口重复。
    // 这一项不写 group：跟在「世界」组后面，不另起一个组标题。
    { id: 'hub', label: '鱼的整合包' },
    { id: 'profile', label: '鱼的设定', group: '配置' },
    { id: 'doctor', label: '体检与更新', group: '配置' },
    // 设置类放最后：面板显示、扩展、存储这些是「偶尔来配一次」的，不该占日常入口的位置。
    { id: 'extensions', label: '设置与更多', group: '配置' },
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
    // 这个开关只写本地、不触发重绘，点完页面上什么都不会变——必须自己回一句，
    // 否则就是「点了没反应」（原来的样子）。
    var feedback = statusLine('')
    feedback.hidden = true
    var row = switchRow({
      label: item.label,
      hint: absent ? item.hint + ' · 当前窗口没有这个挂件，开关会保存下来' : item.hint,
      checked: readFlag(item.key, item.defaultOn === true),
      onChange: function (next) {
        writeFlag(item.key, next)
        feedback.hidden = false
        feedback.textContent = absent
          ? (next ? '已保存为「显示」；这个窗口现在没有该挂件，等它出现时按这个设定显示' : '已保存为「隐藏」')
          : (next ? '已打开：挂件现在会显示' : '已关闭：挂件已隐藏')
        feedback.dataset.tone = 'success'
      },
    })
    return h('div', {}, [row, feedback])
  }

  function displayFlagRows() {
    return DISPLAY_KEYS.map(displayFlagRow)
  }

  // 记住上次停在哪个分区：进鱼世界不再每次都跳回总览（主人 2026-10-30）。
  // 只认 NAV 里真实存在的 id —— 旧版本留下的失效 id（比如已经并进记忆页的 stickers）
  // 回落到总览，免得恢复出一个空白页。
  function readPanelView() {
    try {
      var v = localStorage.getItem('dshcp.view')
      if (v && NAV.some(function (n) { return n.id === v })) return v
    } catch (e) {}
    return 'overview'
  }
  function writePanelView(view) {
    try { localStorage.setItem('dshcp.view', String(view || 'overview')) } catch (e) {}
  }

  var state = {
    view: readPanelView(),
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
    // 知识库索引的最近一次操作结果（检查 / 更新 / 重建），就近显示在卡片上
    knowledgeIndexMsg: null,
    knowledgeIndexBusy: false,
    // 图片整理：视觉接口配置、全库整理的结果与忙碌标记
    stickerVision: null,
    stickerVisionMsg: null,
    stickerOrganizeBusy: false,
    // 同步进 QQ 收藏：忙碌标记 + 最近一次结果（写的是主人的 QQ 收藏，只点才跑）
    stickerSyncBusy: false,
    stickerSyncMsg: null,
    // 图片收藏的批量选择：只放内存里的 id（换页清空；图库刷新后按现有条目剔掉已不存在的）。
    stickerSelected: [],
    // 批量条：标签输入（重绘会重建输入框，值要留在 state 里）、最近一次结果、忙碌中的动作、
    // 删除的二次确认（第一次点只把按钮换成确认，不弹窗）。
    stickerBatchTags: '',
    stickerBatchMsg: null,
    stickerBatchBusy: '',
    stickerBatchConfirm: false,
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
    // 角色卡正文编辑层开着没有：重绘时也据此防重入（编辑层挂在 body 上，不在 #app 里）。
    roleEditorOpen: false,
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
    // 空间的运行时状态（今天写过日记没、今天发过没、额度还剩多少）。
    // 与 qzone（配置里的额度）分开存：一个是可以改的设定，一个是刚发生的事实。
    qzoneRuntime: null,
    capabilities: null,
    extensions: null,
    env: null,
    // 整合范围（/hub 的 scope）、记忆账本（/memory）、动作清单（/hub/tools）与
    // 操作时间线（/actions）：都是只读快照，读不到就如实报错，不拿默认值顶上。
    hub: null,
    memoryHub: null,
    hubTools: null,
    actions: null,
    // 动作清单里哪些组是展开的（默认全收起：40 多个动作一口气铺开太长）。
    hubToolsOpen: {},
    // 「刚才这一步」的流水：开关 / 修联接 / 写清单 / 并库，后端给什么就画什么。
    hubRun: null,
    hubAction: null,
    // 修联接 / 写清单的两次确认：第一次点只把按钮换成「确认」，不做弹窗（见 viewHub）。
    selfLinkConfirm: false,
    // 「鱼的家」里「看看里面」按目录记展开状态（重绘后不自己合上）。
    homeOpen: {},
    mergeConfirm: false,
    mergeBusy: false,
    mergeRun: null,
    // 时间线按身份筛（空串 = 全部），以及看最近几天（审计一天一个文件）。
    actionsRole: '',
    actionsDays: 7,
    // 试召回：输入的那句话与上次结果（不持久化，刷新就清）。
    recallQuery: '',
    recallPreview: null,
    briefPreview: null,
    // 养鱼花费（dsh-cost-meter）与鱼主动开口（dsh-speak-up）：两张只读卡的上游数据。
    cost: null,
    speakUp: null,
    // 鱼的风格（dsh-fish-tone）：说话风格的档位与种子，同样只读。
    tone: null,
    // B 站人设同步状态：只读快照（与 platforms 数据合并后展示）。
    biliPersona: null,
    // 「同步人设」按钮的忙标记：一次只允许一个请求在飞。
    biliPersonaBusy: false,
    // 每日记忆摘要状态（记忆页卡片用）。
    memoryDigest: null,
    // 「立即重建」按钮的忙标记。
    memoryDigestBusy: false,
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
        // 事件必须绑成监听器。走 setAttribute 会把函数体当内联事件属性写进 HTML，
        // 浏览器再把它解析成代码 —— 表现是一句「Function statements require a function name」
        // 语法错误（真在「当前角色卡」的 onerror 上踩过），而且内联脚本会被 CSP 拦。
        else if (typeof v === 'function' && /^on[a-z]+$/.test(k)) node.addEventListener(k.slice(2).toLowerCase(), v)
        else node.setAttribute(k, v === true ? '' : String(v))
      })
    }
    ;(children || []).forEach(function (child) {
      if (child == null) return
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    })
    return node
  }

  // SVG 要走 createElementNS；且 SVG 元素的 className 是只读对象，只能用 setAttribute('class')。
  function hSvg(tag, attrs, children) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k]
        if (v == null || v === false) return
        node.setAttribute(k, String(v))
      })
    }
    ;(children || []).forEach(function (child) {
      if (child != null) node.appendChild(child)
    })
    return node
  }

  /** 灰色线性人形占位图：图片加载不出来时用，绝不出原生裂图。 */
  function userIconSvg() {
    return hSvg('svg', {
      class: 'fw-role-current-svg',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    }, [
      hSvg('circle', { cx: '12', cy: '8', r: '3.5' }),
      hSvg('path', { d: 'M5 19.5c1.6-3.2 4-4.8 7-4.8s5.4 1.6 7 4.8' }),
    ])
  }

  // 侧栏图标的形状表：统一 24 视框、1.5 描边、currentColor，CSS 收到 16px。
  // 只用线性图标，不用彩色或双色块（规范 §一.2「线性图标 + 文字」）。
  var NAV_ICON_SHAPES = {
    overview: [
      ['rect', { x: '4', y: '4', width: '7', height: '7', rx: '1.5' }],
      ['rect', { x: '13', y: '4', width: '7', height: '7', rx: '1.5' }],
      ['rect', { x: '4', y: '13', width: '7', height: '7', rx: '1.5' }],
      ['rect', { x: '13', y: '13', width: '7', height: '7', rx: '1.5' }],
    ],
    diary: [
      ['path', { d: 'M7 4h9a2 2 0 0 1 2 2v14H9a2 2 0 0 1-2-2V4Z' }],
      ['path', { d: 'M7 18a2 2 0 0 1 2-2h9' }],
      ['path', { d: 'M11 8h4' }],
    ],
    wishes: [
      ['path', { d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v6A2.5 2.5 0 0 1 17.5 15H10l-4 4v-4H6.5A2.5 2.5 0 0 1 4 12.5Z' }],
    ],
    growth: [
      ['path', { d: 'M4 17l5-5 3.5 3.5L20 8' }],
      ['path', { d: 'M15 8h5v5' }],
    ],
    memory: [
      ['ellipse', { cx: '12', cy: '6', rx: '7', ry: '2.5' }],
      ['path', { d: 'M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6' }],
      ['path', { d: 'M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6' }],
    ],
    status: [
      ['circle', { cx: '12', cy: '12', r: '8' }],
      ['path', { d: 'M9 14c.9 1.2 1.9 1.8 3 1.8s2.1-.6 3-1.8' }],
      ['path', { d: 'M9.5 9.5h.01M14.5 9.5h.01' }],
    ],
    platforms: [
      ['circle', { cx: '12', cy: '12', r: '8' }],
      ['path', { d: 'M4 12h16' }],
      ['path', { d: 'M12 4c2.2 2.4 3.3 5 3.3 8s-1.1 5.6-3.3 8c-2.2-2.4-3.3-5-3.3-8S9.8 6.4 12 4Z' }],
    ],
    hub: [
      ['path', { d: 'M4 7.5 12 4l8 3.5v9L12 20l-8-3.5Z' }],
      ['path', { d: 'M4 7.5 12 11l8-3.5M12 11v9' }],
    ],
    profile: [
      ['circle', { cx: '12', cy: '8.5', r: '3.5' }],
      ['path', { d: 'M5 19.5c1.6-3.2 4-4.8 7-4.8s5.4 1.6 7 4.8' }],
    ],
    doctor: [
      ['path', { d: 'M12 3l7 3v5.5c0 4.3-2.9 7.6-7 9.5-4.1-1.9-7-5.2-7-9.5V6Z' }],
      ['path', { d: 'M9 12l2 2 4-4' }],
    ],
    extensions: [
      ['path', { d: 'M4 7h9M19 7h1M4 17h5M14 17h6' }],
      ['circle', { cx: '16', cy: '7', r: '2' }],
      ['circle', { cx: '11', cy: '17', r: '2' }],
    ],
  }

  function navIcon(id) {
    var shapes = NAV_ICON_SHAPES[id] || []
    return hSvg('svg', {
      class: 'fw-nav-icon',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    }, shapes.map(function (shape) { return hSvg(shape[0], shape[1]) }))
  }

  // 读接口并把后端给的原因拼上：宿主把我们没接住的异常包成「HTTP 400」时，
  // 光显示状态码等于让主人猜。响应体里的 error 才是真话（底线③：出问题时说实话）。
  function readError(r) {
    return r.json()
      .then(function (d) {
        var why = d && (d.error || d.message)
        return new Error(why ? 'HTTP ' + r.status + '：' + why : 'HTTP ' + r.status)
      })
      .catch(function () { return new Error('HTTP ' + r.status) })
  }

  function getJSON(path) {
    return fetch(path, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return readError(r).then(function (e) { throw e })
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

  /** 文件大小给人看的样子：小于 1KB 报字节，免得一堆「0 MB」。 */
  function formatBytes(value) {
    var n = Number(value) || 0
    if (n <= 0) return ''
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  // ---------- 卡片 ----------
  // Bento 卡片：header 固定，body 撑开，按钮靠 margin-top:auto 沉到卡片底部。
  // header 左侧是专属抓手（⠿）：只有它能发起拖拽，正文与按钮保持正常交互。
  function card(opts) {
    var head = h('div', { class: 'fw-card-head' }, [
      // 钉在末尾的卡不给抓手：留着抓手却能拖，松手又弹回去，等于骗人一次
      opts.draggable === false || opts.pinLast ? null : h('span', {
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
    // 钉在分区末尾：说明 / 免责这类收尾内容不该被拖拽顺序或键盘挪走（见 pinLastCards）。
    if (opts.pinLast) node.dataset.pinLast = 'true'
    // 按内容高度排（不跟同行卡拉齐）：内容长短差很多的几列用它，避免大片空白。
    if (opts.naturalHeight) node.dataset.naturalHeight = 'true'
    // 同组卡片连续落下，不插进上面几行的空隙（见 packCards 的注释）。
    if (opts.group) node.dataset.cardGroup = String(opts.group)
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

  /**
   * 骨架屏：加载时占位，形状照着这张卡加载完会长成什么样画（规范 §五.4）。
   * 不用转圈、不闪白，只有极弱的呼吸；读屏用 aria-busy + 一句「正在读取」。
   * kind: 'rows'（默认，几行标题+数值）/ 'stat'（大数值 + 说明 + 几行）。
   */
  function skeleton(kind, rowCount) {
    var nodes = []
    if (kind === 'stat') {
      nodes.push(h('div', { class: 'fw-skel-hero' }))
      nodes.push(h('div', { class: 'fw-skel-line', dataset: { w: '70' } }))
    }
    var rows = rowCount == null ? 3 : rowCount
    for (var i = 0; i < rows; i++) nodes.push(h('div', { class: 'fw-skel-row' }))
    return h('div', {
      class: 'fw-skeleton',
      'aria-busy': 'true',
      'aria-label': '正在读取',
      role: 'status',
    }, nodes)
  }

  // 空状态：统一灰阶文字 + 可选的一行补充说明，不用笑脸或彩色插画。
  // 不给说明时只显示调用方给的那句话（多数卡片本身就是“暂无数据”的语义）。
  function emptyState(text, hint) {
    return h('div', { class: 'fw-empty' }, [
      h('p', { class: 'fw-empty-line', text: text || '暂无数据' }),
      hint ? h('p', { class: 'fw-empty-hint', text: hint }) : null,
    ])
  }

  // 状态指示：6px 灰阶圆点 + 灰阶文字，不用彩色色块。
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

  // 安静按钮：无边框 + 半透明底，hover 只加深背景。用于卡片里的次要操作，
  // 免得一排细边框按钮抢走真正该看的数值。
  function quietButton(label, onClick) {
    var b = h('button', { class: 'fw-btn fw-btn-quiet', type: 'button', text: label })
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
    return h('div', { class: 'fw-row fw-row-switch' }, [
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
    // 平台数量不写死：后端加平台（如微信）后总览跟着变，不用回来改 UI。
    var platformTotal = platforms && platforms.platforms ? platforms.platforms.length : null

    /**
     * 总览开头那一句人话：把台账说成一句能读的。
     *
     * 只说**已经读到**的部分——没读到的（正在加载、接口失败）整个跳过，
     * 不在这一句里塞「读取中」，也不拿 0 冒充「今天没干」。
     */
    var summaryBits = []
    var acts = state.actions
    if (acts && acts.platformsToday) {
      var said = Object.keys(acts.platformsToday).reduce(function (sum, id) {
        return sum + (Number(acts.platformsToday[id].said) || 0)
      }, 0)
      summaryBits.push('今天说了 ' + said + ' 句')
    }
    if (acts && acts.today) {
      summaryBits.push('动过 ' + (acts.today.total || 0) + ' 次手')
      // 日记用「今天写了几篇」（审计里的 diary-write），不要用「日记页当前显示的那一天」——
      // 那个是主人选中的日期，可能是前几天，写成「今天」就是假话。
      var wroteToday = (acts.today.byAction && acts.today.byAction['diary-write']) || 0
      summaryBits.push(wroteToday ? '今天写了 ' + wroteToday + ' 篇日记' : '今天还没写日记')
    }
    if (pendingWishes != null) summaryBits.push(pendingWishes ? '待批请求 ' + pendingWishes + ' 条' : '没有待批请求')
    if (stageName) summaryBits.push('成长阶段「' + stageName + '」')
    var summaryText = summaryBits.length ? summaryBits.join(' · ') : ''

    // 模式切换：极简文本 tabs，仅靠底部下划线区分，不用方块按钮
    // 这张卡固定在最前，不参与拖拽排序
    var modeBar = card({
      draggable: false,
      title: '总览',
      note: detailed ? '详细：每个分区一张卡' : '简化：只显示要点',
      span: 12,
      children: [
        summaryText ? h('p', { class: 'fw-card-note', style: 'margin-bottom:var(--space-3)' }, [summaryText]) : null,
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
        platformTotal: platformTotal, mood: mood, growth: growth, dep: dep,
      })]
    }

    return [modeBar, ...viewOverviewDetailed({
      moodText: moodText, ttsText: ttsText, diaryCount: diaryCount,
      pendingWishes: pendingWishes, stageName: stageName, installed: installed,
      platformTotal: platformTotal,
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

  /** 钉在末尾的卡（说明 / 免责）：任何顺序整理都把它们排到最后。 */
  function pinLastCards(nodes) {
    var isPinned = function (n) { return Boolean(n && n.dataset && n.dataset.pinLast === 'true') }
    var list = [...nodes]
    // 先普通卡、后钉尾卡。反过来写会让「关于」跑到第一位 —— 真踩过，
    // 是靠「旧存档把它放在最前」这条用例发现的。
    return list.filter(function (n) { return !isPinned(n) }).concat(list.filter(isPinned))
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
    // 可拖拽的卡片按保存顺序排，不可拖拽的（如模式切换条）始终在最前，
    // 钉在末尾的（「关于」）排到最后 —— 否则旧存档会把它塞回中间。
    var fixed = placed.filter((node) => !cardOrderKey(node))
    var movable = placed.filter((node) => cardOrderKey(node))
    for (var n of fixed.concat(pinLastCards(movable))) grid.appendChild(n)
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
   * 12 列密集排布：按传入顺序，每张卡放到「能容纳它的最靠上、最靠左」的位置。
   * 放不下的卡被挤到下一排。
   *
   * 但有一条例外：同一组的卡（data-card-group 相同，比如「鱼的设定」三张）**不许
   * 跳回上面几行的空隙里**。曾经把 8 列摘要 + 4 列规则排在第一行后，第三张 4 列卡
   * 顶进了规则卡下方的孔里，于是三张本该并排的卡错开三行，同行等高又把摘要撑到 820px。
   * 现在同组卡只从「这一组第一张的顶部」开始找位置：可以并排、可以换行，但不往回钻。
   */
  function packCards(items, width) {
    var placed = []
    var groupTop = {}
    for (var item of items) {
      var span = Math.max(1, Math.min(12, Number(item.w) || 12))
      var w = cardWidth(width, span)
      var group = item.node && item.node.dataset ? item.node.dataset.cardGroup : ''
      var rows = new Set([0])
      for (var p of placed) rows.add(p.y + p.h + GRID_GAP)
      var minY = group && groupTop[group] != null ? groupTop[group] : 0
      // 开一个新组时，不许钻进「已有卡片之间的空位」：那正是错行的来源。
      // 从「所有已放置卡片的下一行」开始找，保证这一组从完整的一行开头排起。
      if (group && groupTop[group] == null && placed.length) {
        var lowest = placed.reduce(function (m, p) { return Math.max(m, p.y + p.h) }, 0)
        minY = lowest + GRID_GAP
      }
      var spot = null
      for (var y of [...rows].sort(function (a, b) { return a - b })) {
        if (y < minY) continue
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
        spot = { node: item.node, x: 0, y: Math.max(placed.length ? bottom + GRID_GAP : 0, minY), w: w, h: item.h, col: 0, span: span }
      }
      if (group && groupTop[group] == null) groupTop[group] = spot.y
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
      for (var row of group.items) {
        // 标了 data-natural-height 的卡按自己的内容高度排：这几张卡内容长短差得多，
        // 强行拉齐只会给短的那张留出几百像素空白。普通卡仍然同行等高（底边对齐）。
        row.h = row.node && row.node.dataset && row.node.dataset.naturalHeight === 'true' ? row.h : maxH
      }
    }
    return placed
  }

  /** 先排布、再把同行拉到等高，重复到高度稳定（最多 3 轮，避免抖动）。 */
  function layoutCards(items, width) {
    var heights = items.map(function (item) { return item.h })
    // 按内容高度排的卡：它的高度永远用自己量到的值，不跟着同行滚高。
    var natural = items.map(function (item) {
      return Boolean(item.node && item.node.dataset && item.node.dataset.naturalHeight === 'true')
    })
    var layout = equalizeRows(packCards(items, width))
    for (var round = 0; round < 2; round += 1) {
      // 等高后某些行变高，下面的行要按新高度重新排，否则会互相压住
      var next = items.map(function (item, index) {
        var h = layout[index] ? layout[index].h : heights[index]
        // 自然高度卡不继承被撑高的值，否则第二轮会拿 820 当输入，越滚越高。
        if (natural[index]) h = item.h
        return { node: item.node, w: item.w, h: h }
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
    // 卡片是绝对定位的，不占流：容器内部要有一个「内容总长」的撑高，
    // 滚动条才会出现（CSS 里 .fw-main::after 用这个变量）。
    //
    // ⚠️ 这里以前写 grid.style.minHeight = bottom + 'px'：那是「整页滚动」时代的做法
    // （把内容区撑到和内容一样高，让文档滚）。改成右区自己滚之后，那一行会把容器
    // 撑到 2439px、超过固定外壳，容器内部反而没有可滚余量 —— 滚轮滑不动、
    // 下面的卡片看不见（主人 2026-10-27 报的）。现在只写变量，不再改 minHeight。
    //
    // 多留一段底部间距：否则滚到底时最后一行贴着滚动区下沿，看着像被切了。
    // 取容器自己的 padding-bottom，和四周留白（--space-6）保持一致。
    var gap = Number(opts && opts.bottomGap)
    if (!(gap >= 0)) {
      try { gap = parseFloat(getComputedStyle(grid).paddingBottom) || 0 } catch { gap = 0 }
    }
    var contentHeight = bottom + gap
    grid.dataset.scrollHeight = String(Math.round(bottom))
    grid.style.setProperty('--fw-scroll-h', Math.round(contentHeight) + 'px')
    // 关键：清掉历史上被写成内联 minHeight 的值，否则它会盖过 CSS 里的 min-height: 0。
    grid.style.minHeight = ''
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
      // 没有卡片：内容总长归零，占位层收缩，滚动条自然消失。
      grid.style.setProperty('--fw-scroll-h', '0px')
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
    // 落盘时再钉一次：钉末尾的卡（「关于」）不参与「拖到谁后面」，永远收尾。
    for (var card of fixedCards.concat(pinLastCards(movable))) grid.appendChild(card)
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
    for (var card of fixed.concat(pinLastCards(order))) grid.appendChild(card)
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

  // 卡片宽度：优先用主人自己拖出来的跨度（存在 localStorage），没有就用代码里的 span。
  function savedSpans() {
    try {
      var raw = localStorage.getItem('dshcp.cardSpans.' + (state.view || 'overview'))
      var obj = raw ? JSON.parse(raw) : null
      return obj && typeof obj === 'object' ? obj : {}
    } catch (e) { return {} }
  }

  function saveSpan(key, span) {
    if (!key) return
    try {
      var all = savedSpans()
      if (span) all[key] = span
      else delete all[key]
      localStorage.setItem('dshcp.cardSpans.' + (state.view || 'overview'), JSON.stringify(all))
    } catch (e) {}
  }

  function spanOf(node) {
    var key = cardOrderKey(node)
    var custom = key ? savedSpans()[key] : null
    if (custom && custom >= 3 && custom <= 12) return custom
    for (var n = 3; n <= 12; n += 1) {
      if (node.classList.contains('fw-span-' + n)) return n
    }
    return 12
  }

  // 右下角缩放把手：拖动改宽度（按列吸附），最小 3 列、最大 12 列。
  // 只从把手发起，正文的点击与选区不受影响。
  var resizeState = null
  function startResize(node, event) {
    var grid = main
    if (!grid) return
    // 缩放只关心「现在是几列」和「一列多宽」，不需要排布结果。
    // 以前这里靠 slotOf 取位置，render() 之后 layout 为空就直接 return，
    // 表现成「按了没反应」——缩放本来就不该依赖排版数据。
    event.preventDefault()
    event.stopPropagation()
    var unit = colUnit(gridInnerWidth(grid)) + GRID_GAP
    resizeState = {
      node: node,
      key: cardOrderKey(node),
      grid: grid,
      startX: event.clientX,
      startSpan: spanOf(node),
      unit: unit,
      span: spanOf(node),
    }
    node.classList.add('fw-card-resizing')
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', onResizeEnd)
    window.addEventListener('pointercancel', onResizeEnd)
  }

  function onResizeMove(event) {
    if (!resizeState) return
    var steps = Math.round((event.clientX - resizeState.startX) / resizeState.unit)
    var next = Math.max(3, Math.min(12, resizeState.startSpan + steps))
    if (next === resizeState.span) return
    resizeState.span = next
    // 实时给个预览宽度：松手时才重排，避免整页在拖动中抖动
    resizeState.node.style.width = cardWidth(gridInnerWidth(resizeState.grid), next) + 'px'
  }

  function onResizeEnd() {
    if (!resizeState) return
    var state = resizeState
    resizeState = null
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeEnd)
    window.removeEventListener('pointercancel', onResizeEnd)
    state.node.classList.remove('fw-card-resizing')
    saveSpan(state.key, state.span)
    render()
  }

  // 每张可拖的卡右下角挂一个缩放把手（只有存在顺序键的卡才挂，纯展示条不挂）。
  function attachResizeHandles(grid) {
    var nodes = [...grid.children].filter(function (el) { return el.classList && el.classList.contains('fw-card') })
    nodes.forEach(function (node) {
      if (!cardOrderKey(node)) return
      if (node.querySelector(':scope > .fw-resize')) return
      var handle = h('span', {
        class: 'fw-resize',
        role: 'separator',
        tabindex: '0',
        'aria-label': '拖动调整这张卡的宽度（最少 3 列，最多 12 列）',
        title: '拖动调整宽度 · Alt+左右方向键微调',
      })
      // 用 forEach 的形参捕获这张卡：for...of + var 时闭包拿到的是循环变量，曾导致
      // 所有把手都操作最后一张卡（表现为「拖哪张都是别的卡变宽」）。
      handle.addEventListener('pointerdown', function (event) { startResize(node, event) })
      handle.addEventListener('keydown', function (event) {
        if (!event.altKey) return
        var delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!delta) return
        event.preventDefault()
        var next = Math.max(3, Math.min(12, spanOf(node) + delta))
        saveSpan(cardOrderKey(node), next)
        render()
      })
      node.appendChild(handle)
    })
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
  // 同一页内跳到某张卡（按 data-card-key 找）：只滚动，不闪烁、不改布局。
  function jumpToCard(key) {
    var node = document.querySelector('.fw-card[data-card-key="' + key + '"]')
    if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function miniCard(opts) {
    // target 跳到另一个分区；jump 跳到当前页里的某张卡；onClick 自己处理（如切日期）。
    // 三者都是「可点的摘要项」，外观一致。
    var clickable = (typeof opts.target === 'string' && opts.target)
      || (typeof opts.jump === 'string' && opts.jump)
      || typeof opts.onClick === 'function'
    var node = clickable
      ? h('button', {
        class: 'fw-mini fw-mini-link',
        type: 'button',
        'aria-pressed': opts.selected ? 'true' : (opts.value != null && clickable ? 'false' : null),
        'aria-label': opts.label + '：' + (opts.value == null ? '' : opts.value) + (opts.sub ? ' ' + opts.sub : ''),
      })
      : h('div', { class: 'fw-mini' })

    if (opts.selected) node.dataset.selected = 'true'
    if (opts.dim) node.dataset.dim = 'true'
    if (opts.wide) node.style.gridColumn = 'span 2'

    node.appendChild(h('span', { class: 'fw-mini-label', text: opts.label, title: opts.label }))

    var valueRow = h('span', { class: 'fw-mini-value-row' })
    var raw = opts.value == null ? '—' : String(opts.value)
    valueRow.appendChild(h('span', { class: 'fw-mini-value', text: raw, title: raw }))
    // 需要操作时给一个 6px 状态点，不作大面积色块
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
          style: 'width:' + pct.toFixed(1) + '%' + (over ? ';background:var(--feedback-error)' : ''),
        }),
      ])
      if (over) bar.title = '已超出上限：' + (ratio * 100).toFixed(1) + '%'
      node.appendChild(bar)
    }

    if (clickable) {
      node.addEventListener('click', function () {
        // 顺序要紧：onClick 是调用方自己接管的（比如切日期），不能被 navigate 抢走。
        if (typeof opts.onClick === 'function') opts.onClick()
        else if (opts.jump) jumpToCard(opts.jump)
        else navigate(opts.target)
      })
    }
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
        value: installedValue == null ? null : installedValue + '/' + (ctx.platformTotal || 0),
        sub: '已连接的平台',
        progress: installedValue == null || !ctx.platformTotal ? null : { value: installedValue, max: ctx.platformTotal },
        target: 'platforms',
      }),
      // 朗读桥的设置不在「鱼的状态」——它自己的右下角卡片才有「听谁 / 自动朗读 / 收藏」。
      // 这里点到「设置与更多」，那一页写着入口在哪。
      miniCard({ label: '朗读桥', value: ttsOn, sub: state.tts && state.tts.playing ? '正在念' : '没在念', target: 'extensions' }),
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
      { id: 'platforms', label: '鱼与世界', hint: ctx.installed == null ? '读取中…' : orNone(ctx.installed ? ctx.installed + ' / ' + (ctx.platformTotal || 0) : 0) },
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

      // 第三行：平台 / 设置 / 记忆。三张各占 3 时这行只有 9 列，右边留 3 列空洞
      // （排布引擎不会把下一张 4 列的卡塞进 3 列的空位）；改成 4 刚好闭合。
      dataCard({
        title: '鱼与世界',
        note: (installed == null ? '读取中' : installed + ' / ' + (ctx.platformTotal || 0)),
        span: 4,
        prose: 'QQ、微信、B 站、抖音各自独立，外发默认关闭。',
        action: '管理',
        onAction: function () { navigate('platforms') },
      }),
      dataCard({
        title: '鱼的设定',
        note: profile && profile.fish ? (profile.fish.name || '鱼') : '读取中',
        span: 4,
        prose: '名字、称呼、角色卡与人设。',
        action: '设置',
        onAction: function () { navigate('profile') },
      }),
      dataCard({
        title: '鱼的记忆',
        note: state.stickers ? ((state.stickers.items || []).length + ' 张图片') : '读取中',
        span: 4,
        prose: '知识库、图片收藏、网站链接与图片整理。',
        action: '查看',
        onAction: function () { navigate('memory') },
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

    // 日期选择做成「摘要卡」而不是浏览器原生日历：
    // 原生的那个弹出来是系统白底控件，和面板不是一套；而且要点两层才能选到日子。
    // 现在直接把有日记的那几天铺出来，一眼看到哪天有内容、点一下就切过去。
    var entriesAll = (data && data.entries) || []
    var perDay = {}
    entriesAll.forEach(function (item) {
      var day = String(item.at || '').slice(0, 10)
      if (day) perDay[day] = (perDay[day] || 0) + 1
    })
    var days = Object.keys(perDay).sort().reverse()
    var recentDays = days.slice(0, 6)
    if (recentDays.indexOf(today()) < 0) recentDays.unshift(today())
    recentDays = recentDays.slice(0, 6)

    function pickDate(day) {
      state.diaryDate = day
      render()
    }

    children.push(h('div', { class: 'fw-card-head' }, [
      h('h3', { class: 'fw-card-title', text: '看哪一天' }),
      h('span', {
        class: 'fw-card-note',
        text: state.diaryDate
          ? '正在看 ' + state.diaryDate
          : '全部 ' + entriesAll.length + ' 条 · ' + days.length + ' 天',
      }),
    ]))
    children.push(h('div', { class: 'fw-mini-grid fw-mini-grid-dense' },
      recentDays.map(function (day) {
        var active = state.diaryDate === day
        return miniCard({
          label: day === today() ? '今天 · ' + day : day,
          value: String(perDay[day] || 0),
          sub: (perDay[day] || 0) ? '篇日记' : '还没有日记',
          selected: active,
          onClick: function () { pickDate(day) },
        })
      })
        .concat([miniCard({
          label: '全部日期',
          value: String(entriesAll.length),
          sub: days.length + ' 天合计',
          selected: !state.diaryDate,
          onClick: function () { pickDate('') },
        })])
    ))
    if (days.length > recentDays.length) {
      children.push(h('p', { class: 'fw-card-note', text: '只列出最近的几天；更早的日记在「全部日期」里。' }))
    }
    children.push(h('div', { class: 'fw-btn-row' }, [button('刷新', loadDiary)]))

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
      // 统一放在「设置与更多 → 本地存储」里按天浏览。
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

    if (state.errors.growth) {
      return [card({ key: 'growth-error', title: '鱼的成长', span: 12, children: [statusLine('读取失败：' + state.errors.growth, 'error')] })]
    }
    if (!data) {
      return [card({ key: 'growth-loading', title: '鱼的成长', span: 12, children: [skeleton('rows', 3)] })]
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

    // ---- 卡 2：和主人的生活记录（仪表盘）----
    // 数据来自 QQ 留存（lib/activity.mjs 的 withOwnerStats），不另建台账。
    var ownerStats = (state.activity && state.activity.owner) || null
    var lifeBody = []
    if (state.errors.activity) {
      lifeBody.push(statusLine('读取失败：' + state.errors.activity, 'error'))
    } else if (!ownerStats) {
      lifeBody.push(statusLine('读取中…'))
    } else if (!ownerStats.interactions) {
      lifeBody.push(emptyState('还没有和主人说过话。收到第一条消息后，这里会开始记。'))
    } else {
      var peak = ownerStats.peakHour
      lifeBody.push(h('div', { class: 'fw-stat-grid' }, [
        h('div', { class: 'fw-stat' }, [
          h('span', { class: 'fw-stat-value', text: String(ownerStats.interactions) }),
          h('span', { class: 'fw-stat-label', text: '互动次数' }),
        ]),
        h('div', { class: 'fw-stat' }, [
          h('span', { class: 'fw-stat-value', text: String(ownerStats.days) }),
          h('span', { class: 'fw-stat-label', text: '相处天数' }),
        ]),
        h('div', { class: 'fw-stat' }, [
          h('span', { class: 'fw-stat-value', text: String(ownerStats.streak) }),
          h('span', { class: 'fw-stat-label', text: '连续天数' }),
        ]),
        h('div', { class: 'fw-stat' }, [
          h('span', { class: 'fw-stat-value', text: peak == null ? '—' : String(peak).padStart(2, '0') + ':00' }),
          h('span', { class: 'fw-stat-label', text: '常说话的时候' }),
        ]),
      ]))
      lifeBody.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: '你说了 / 她说了' }),
        h('span', { class: 'fw-row-value', text: ownerStats.ownerSaid + ' / ' + ownerStats.fishSaid }),
      ]))
      // 最近 14 天：每根柱子=当天的互动条数，悬停看具体数字
      var recent = (ownerStats.recentDays || []).slice(-14)
      if (recent.length) {
        var maxDay = recent.reduce(function (m, d) { return Math.max(m, d.total) }, 1)
        lifeBody.push(h('div', { class: 'fw-spark', role: 'img', 'aria-label': '最近 ' + recent.length + ' 天的互动次数' },
          recent.map(function (d) {
            var bar = h('i', { style: 'height:' + Math.max(4, Math.round(d.total / maxDay * 100)) + '%' })
            return h('span', { class: 'fw-spark-col', title: d.day + '：' + d.total + ' 次（你 ' + d.owner + ' / 她 ' + d.fish + '）' }, [bar])
          })))
      }
      if (ownerStats.firstAt) {
        lifeBody.push(h('p', { class: 'fw-card-note', text: '从 ' + ownerStats.firstAt.slice(0, 10) + ' 开始记；' + (ownerStats.note || '') }))
      }
    }
    var lifeCard = card({
      key: 'growth-life',
      title: '和主人的生活记录',
      note: ownerStats && ownerStats.interactions ? '一起待了 ' + ownerStats.days + ' 天' : '从第一次聊天开始算',
      span: 8,
      children: lifeBody,
    })

    // ---- 卡 3：成长记录（独立信息卡，这是主体）----
    var records = card({
      key: 'growth-records',
      title: '成长记录',
      note: entries.length ? entries.length + ' 条' : '暂无',
      span: 12,
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

    var cards = [summary, lifeCard, records]

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

    // ---- 卡 4：鱼的记忆已独立成「鱼的记忆」页（知识库 / 收藏 / 链接 / 图片整理），
    // 成长页只留「想明白了什么」，不再重复摆一遍记忆的卡。

    // 「本地存储」不在这页：它是「文件都落在哪、留了些什么」，属于运维，
    // 已搬到「设置与更多」与存储位置放一起。

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
        // 内容长短差很多的卡（比如整合范围）按自己内容收缩，别拉成空壳。
        naturalHeight: entry.naturalHeight === true,
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

  // ---------- 整合范围（/hub 的 scope） ----------
  // 账本按插件分，人关心的是功能。这张卡只回答一句：点名要的东西现在能不能用。
  // 三态固定为「就位 / 缺闸 / 缺件」，只用灰阶圆点 + 文字，不用彩色 emoji（见 ui/AGENTS「状态表达」）。
  var HUB_STATE_WORDS = { ready: '就位', blocked: '缺闸', missing: '缺件' }
  var HUB_STATE_LEVELS = { ready: 'ok', blocked: 'warn', missing: 'error' }
  // 这张卡是只读的：开关（按角色分的清单）、修联接 / 写清单（整合包概览）
  // 都在「鱼的整合包」页，各自的按钮就摆在那一行上（铁律④：能点到的就要看得见）。

  /** 一条操作流水：左侧状态点 + 中间名称与说明。没有装饰，只靠留白分层。 */
  function stepRow(step) {
    return h('div', { class: 'fw-flow-row' }, [
      h('span', { class: 'fw-flow-dot', dataset: { tone: (step && step.tone) || '' }, 'aria-hidden': 'true' }),
      h('span', { class: 'fw-flow-main' }, [
        h('span', { class: 'fw-flow-title', text: (step && step.label) || '' }),
        step && step.detail ? h('span', { class: 'fw-row-hint', text: step.detail }) : null,
      ]),
    ])
  }

  /** 整合范围的卡片正文。读不到就报读不到，不编「全部就位」。 */
  function hubScopeChildren() {
    var body = []
    var hub = state.hub
    if (state.errors.hub) {
      body.push(statusLine('整合范围读取失败：' + state.errors.hub, 'error'))
      body.push(h('p', {
        class: 'fw-row-hint',
        text: '装没装、闸门开没开，只有后端知道；面板不拿默认值顶替。',
      }))
      return body
    }
    if (!hub) {
      body.push(skeleton('rows', 4))
      return body
    }
    var scope = hub.scope
    if (!scope) {
      body.push(emptyState('后端还没给出整合范围。', '这张卡只画它给的东西，不自己猜。'))
      return body
    }
    var counts = scope.counts || {}
    var total = Number(counts.total || 0)
    var ready = Number(counts.ready || 0)
    body.push(numRow('已就位 / 共', String(ready) + ' / ' + String(total), {
      level: total && ready === total ? 'ok' : 'warn',
    }))
    if (counts.blocked) body.push(numRow('缺闸（装了但闸门关着）', String(counts.blocked), { level: 'warn' }))
    if (counts.missing) body.push(numRow('缺件（插件没装）', String(counts.missing), { level: 'error' }))
    // gatesChecked === false：这一轮只数了「装没装」，闸门没核过。
    // 不写这句，「就位」两个字会被读成「已经能用」，那是假读数（底线③）。
    if (scope.gatesChecked === false) {
      body.push(statusLine('未检查闸门：这一栏只核了插件装没装，平台开关与授权没有核过。', 'warn'))
    }
    (scope.groups || []).forEach(function (group) {
      var items = group.items || []
      // 分组列表可展开收起：长列表（≥5 项）默认收起，短列表直接展开——
      // 计数已经写在标题行，收起不丢信息，点一下才看明细。
      var gkey = 'scopeOpen.' + (group.id || group.label || '')
      var gopen = readFlag(gkey, items.length < 5)
      var section = h('div', { class: 'fw-dep-section' })
      var gtoggle = h('button', {
        class: 'fw-disclosure fw-disclosure-compact',
        type: 'button',
        'aria-expanded': gopen ? 'true' : 'false',
      }, [
        h('span', { class: 'fw-disclosure-label', text: group.label || '未分组' }),
        h('span', { class: 'fw-disclosure-meta', text: items.length + ' 项' }),
        h('span', { class: 'fw-disclosure-mark', 'aria-hidden': 'true', text: gopen ? '▾' : '▸' }),
      ])
      gtoggle.addEventListener('click', function () {
        writeFlag(gkey, !gopen)
        render()
      })
      section.appendChild(gtoggle)
      if (gopen) {
        section.appendChild(h('div', { class: 'fw-dep-list' }, items.map(function (item) {
          var itemState = item.state || (item.ready ? 'ready' : 'missing')
          var rows = [infoRow(
            item.label || item.id || '未命名',
            HUB_STATE_WORDS[itemState] || itemState,
            { level: HUB_STATE_LEVELS[itemState] || 'neutral' },
          )]
          // 「就位」只说明接得上；有没有真用过是另一件事——分开写，别让人以为绿点等于在用。
          var used = item.usage
          var usedText = ''
          if (used) {
            usedText = used.total
              ? ' · 用过了：共 ' + used.total + ' 条 / ' + used.days + ' 天有记录' + (used.lastAt ? '，最后 ' + shortTime(used.lastAt) : '')
              : ' · 还没有记录'
          }
          var acts = item.actions || []
          rows.push(h('p', {
            class: 'fw-row-hint',
            text: (item.detail || '') + usedText + (item.note ? ' · ' + item.note : '')
              + (acts.length ? ' · 相关动作：' + acts.join('、') : ''),
          }))
          return h('div', { class: 'fw-scope-item' }, rows)
        })))
      }
      body.push(section)
    })

    // 「缺」的说明一句就够：具体缺哪个插件已经写在各项的 note 里。
    if (counts.missing) {
      body.push(h('p', {
        class: 'fw-card-note',
        text: '「缺件」= 插件没装；「缺闸」= 装了但开关 / 授权关着。要动手去「鱼的整合包」。',
      }))
    }
    return body
  }

  // 体检页：三张卡——依赖检查（本机数值 + 操作）、依赖清单（到底装了什么）、
  // 版本更新（联网查新版）。检查与清单拆开，是因为信息密度完全不同：
  // 数值卡窄，清单卡宽；版本更新还要放「当前 → 最新」的长行，必须通栏。
  function viewDoctor() {
    var dep = state.doctorDep
    var up = state.doctorUpdate
    var entries = []
    // 更新结果里只要有一项 outdated，按钮就切成「一键更新」。
    // 本插件（鱼世界）是 link: 指到仓库的，pnpm 更新不了它（只能 git pull），
    // 所以它单独算一类：只有它过期时不画「一键更新」，画了点了也不会变。
    var upItems = (up && Array.isArray(up.items)) ? up.items : []
    var depOutdated = upItems.filter(function (item) { return item.status === 'outdated' && !item.self }).length
    var selfOutdated = upItems.filter(function (item) { return item.status === 'outdated' && item.self }).length
    var hasUpdates = Boolean(up && up.counts && depOutdated > 0)
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
      quietButton(state.doctorBusy ? '检查中…' : '体检', function () {
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
      depButtons.push(quietButton('一键更新', function () {
        setDepStatus('正在更新，可能需要几分钟…', '')
        postJSON('/dsh-fish-world/deps/install', { updateOutdated: true })
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
    depButtons.push(quietButton('解除安装', function () {
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

    // ---- 依赖检查（A，收起时看到的）与依赖清单（B，展开后才有）合成一张卡 ----
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
    // 收起：只有 A（数值 + 操作）；展开：A 下面接上 B（每个依赖的版本与缺失）。
    // 跟「能力开关」用同一种展开按钮；卡片跨度也跟着走（收起 6 列，展开通栏），免得收起时右边空着。
    // 默认收起：只露数值和操作，清单点开才看。
    // 用新键名：旧的 'depOpen' 记的是两卡合并前的展开态，不该被继承过来。
    var depOpen = readFlag('depListOpen', false)
    var depBody = checkBody.slice()
    // 整行可点：文字靠左、计数与箭头靠右；compact 去掉上方那截沉底间距。
    var depToggle = h('button', {
      class: 'fw-disclosure fw-disclosure-compact',
      type: 'button',
      'aria-expanded': depOpen ? 'true' : 'false',
      'aria-controls': depOpen ? 'fw-depgroup' : null,
    }, [
      h('span', { class: 'fw-disclosure-label', text: depOpen ? '收起依赖清单' : '展开依赖清单' }),
      h('span', { class: 'fw-disclosure-meta', text: dep ? ((dep.packages || []).length + ' 项') : '待检查' }),
      h('span', { class: 'fw-disclosure-mark', 'aria-hidden': 'true', text: depOpen ? '▾' : '▸' }),
    ])
    depToggle.addEventListener('click', function () {
      writeFlag('depListOpen', !depOpen)
      render()
    })
    depBody.push(depToggle)
    if (depOpen) depBody.push(h('div', { class: 'fw-capgroup', id: 'fw-depgroup' }, listBody))
    // 操作区沉底：状态与按钮留在卡片底部，展开行才能紧贴上面的数值。
    depBody.push(h('div', { class: 'fw-card-foot' }, [
      depStatus,
      h('div', { class: 'fw-btn-row' }, depButtons),
    ]))
    entries.push({
      key: 'doctor-dep',
      title: '依赖检查',
      span: depOpen ? 12 : 6,
      note: dep ? (dep.ok ? '全部就绪' : '有待处理项') : (state.doctorBusy ? '检查中' : '未检查'),
      body: depBody,
    })

    // ---- 卡三：版本更新（联网查新版） ----
    var upBody = [
      h('p', { class: 'fw-card-note', text: '联网查每个依赖的最新版本。查到新版就能在这张卡直接一键更新；安装/解除仍在「依赖检查」卡。' }),
    ]
    // 鱼世界自己的版本不是依赖，放在这里跟「当前 → 最新」一起看。
    if (dep) upBody.push(numRow('鱼世界版本', (dep.self && dep.self.version) || '未知'))
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
      quietButton(state.doctorBusy ? '检查中…' : (up ? '重新检查' : '更新检查'), function () {
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
        ? quietButton(state.doctorBusy ? '更新中…' : '一键更新', function () {
          if (state.doctorBusy) return
          state.doctorBusy = true
          state.doctorUpdateMsg = { text: '正在更新，可能需要几分钟…', tone: '' }
          render()
          postJSON('/dsh-fish-world/deps/install', { updateOutdated: true })
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
      // 与「依赖检查」同进同退：收起时两张并排填满 12 列，
      // 展开时各占一行。原来固定 12 列会在依赖检查右边留下一整个空洞。
      span: depOpen ? 12 : 6,
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

    // 体检概览：三项摘要，点一项跳到下面对应的卡（同一页内，不换分区）。
    var upCounts = (up && up.counts) || {}
    var audit = state.doctorStorage && state.doctorStorage.audit
    entries.unshift({
      key: 'doctor-summary',
      title: '体检概览',
      note: '点一项跳到对应卡片',
      span: 12,
      body: [h('div', { class: 'fw-mini-grid fw-mini-grid-auto' }, [
        miniCard({
          label: '依赖',
          value: dep ? (depCounts.installed || 0) + '/' + (depCounts.total || 0) : null,
          sub: dep ? (hasMissing ? '有缺失' : '已就绪') : '未体检',
          tone: dep && hasMissing ? 'warn' : '',
          jump: 'doctor-dep',
        }),
        miniCard({
          label: '可更新',
          // 破折号读起来像坏了：查过就是数字，没查过就直接写状态，不再用 — 占位
          value: up ? String(upCounts.outdated || 0) : '未查',
          dim: up ? Number(upCounts.outdated || 0) === 0 : true,
          sub: up
            ? (hasUpdates ? '有新版' : (selfOutdated ? '本体需 git pull' : '已是最新'))
            : '点下面联网查一次',
          tone: hasUpdates || selfOutdated ? 'warn' : '',
          jump: 'doctor-up',
        }),
        miniCard({
          label: '目录索引',
          value: audit ? (audit.ok ? '正常' : '待处理') : null,
          sub: audit ? '' : '还没检查',
          tone: audit && !audit.ok ? 'warn' : '',
          jump: 'doctor-storage',
        }),
      ])],
    })
    // 整合范围紧跟概览：它回答的是「点名要的那几件事现在能不能用」，
    // 比逐个依赖的版本更接近主人真正关心的问题。12 项分三组，通栏才排得下。
    var hubScope = state.hub && state.hub.scope
    entries.splice(1, 0, {
      key: 'hub-scope',
      title: '整合范围',
      note: hubScope && hubScope.counts
        ? (hubScope.counts.ready || 0) + '/' + (hubScope.counts.total || 0) + ' 项就位'
        : (state.errors.hub ? '读不到' : '读取中…'),
      span: 12,
      naturalHeight: true,
      body: hubScopeChildren(),
    })
    return layoutDoctorRows(entries)
  }

  // 换存储位置：保存后立即建立结构，并刷新审计结果。
  /**
   * 整合包页：把「装了哪些插件、谁和谁在做同一件事」摊开，并让每一个动作都看得见。
   *
   * 这一页只读为主——不装、不卸、不改插件代码。能改的只有两处，都要两次确认、全程不弹窗：
   *  ·「按角色分的清单」上的开关：写宿主自己的加载列表（profile 的 dsh.profile.bundles）；
   *  ·「整合包概览」里的修联接 / 写清单：只动 profile，不删任何目录。
   * 整合范围（点名要的那几件事就位没有）在「体检与更新」页，
   * 记忆账本 / 并库 / 试召回与操作时间线在「鱼的记忆」页——不跟这里重复。
   */
  function viewHub() {
    var hub = state.hub
    var acts = state.actions
    var children = []

    // 开关的结果记进 state：点完会整页重绘，局部节点里的字会没（和保存主人同一个坑）。
    var savedAction = state.hubAction || null
    var hubStatus = statusLine(savedAction ? savedAction.text : '', savedAction ? savedAction.tone : '')
    hubStatus.hidden = !savedAction
    function setHubStatus(text, tone) {
      state.hubAction = text ? { text: text, tone: tone || '' } : null
      hubStatus.textContent = text || ''
      hubStatus.dataset.tone = tone || ''
      hubStatus.hidden = !text
    }

    /**
     * 开/关一个 mod：写的是宿主自己的加载列表（profile 的 bundles），不是面板里的影子状态。
     * 后端把每一步都回给我们（steps），这里原样画出来——不做二次推断。
     */
    function toggleMod(name, next) {
      setHubStatus('正在' + (next ? '启用 ' : '停用 ') + name + '…')
      postJSON('/dsh-fish-world/hub/toggle', { name: name, enabled: next })
        .then(function (r) {
          if (r && r.ok) {
            if (r.report) state.hub = r.report
            var text = name + '：' + (r.note || '已改')
            if (r.warning) text += ' ' + r.warning
            setHubStatus(text, r.warning ? 'warn' : 'success')
            // 每一步都留在这张卡上，点完不会「一闪就没了」。
            if (Array.isArray(r.steps) && r.steps.length) {
              state.hubRun = { name: name, at: new Date().toISOString(), steps: r.steps }
            }
            // 动作清单是按账本算的：插件刚停/启，那一列「能用 / 缺」必须跟着重算，
            // 不然开关都关了，卡片还说这个动作能用。
            loadActions()
            loadHubTools()
          } else {
            setHubStatus('没改成：' + ((r && r.error) || '未知错误'), 'error')
          }
        })
        .catch(function (e) { setHubStatus('没改成：' + e.message, 'error') })
        .then(render)
    }

    /**
     * 修 profile 里那个联接：只动联接、不删目录，写完回读确认。
     * 两下确认（第一次只是把按钮变成「确认」），全程不做弹窗——面板不弹窗是硬规矩。
     */
    function doRelink() {
      state.selfLinkConfirm = false
      setHubStatus('正在把联接改到当前目录…')
      postJSON('/dsh-fish-world/hub/relink', { confirm: true })
        .then(function (r) {
          if (r && r.ok) {
            if (r.report) state.hub = r.report
            setHubStatus(r.note || '联接已改', 'success')
            if (Array.isArray(r.steps) && r.steps.length) {
              state.hubRun = { name: '修联接', at: new Date().toISOString(), steps: r.steps }
            }
          } else {
            setHubStatus('没改成：' + ((r && r.error) || '未知错误'), 'error')
            if (r && Array.isArray(r.steps) && r.steps.length) {
              state.hubRun = { name: '修联接', at: new Date().toISOString(), steps: r.steps }
            }
          }
        })
        .catch(function (e) { setHubStatus('没改成：' + e.message, 'error') })
        .then(render)
    }

    /** 代写 profile 清单（dependencies + bundles）：备份、原子写、回读都在后端做完。 */
    function doDeclare() {
      state.selfLinkConfirm = false
      setHubStatus('正在写 profile 清单…')
      postJSON('/dsh-fish-world/hub/declare', { confirm: true })
        .then(function (r) {
          if (r && r.ok) {
            if (r.report) state.hub = r.report
            setHubStatus(r.note || '已写入清单', 'success')
            if (Array.isArray(r.steps) && r.steps.length) {
              state.hubRun = { name: '写清单', at: new Date().toISOString(), steps: r.steps }
            }
          } else {
            setHubStatus('没写成：' + ((r && r.error) || '未知错误'), 'error')
            if (r && Array.isArray(r.steps) && r.steps.length) {
              state.hubRun = { name: '写清单', at: new Date().toISOString(), steps: r.steps }
            }
          }
        })
        .catch(function (e) { setHubStatus('没写成：' + e.message, 'error') })
        .then(render)
    }

    // ---- 卡一：整合包概览 ----
    var overviewBody = []
    if (state.errors.hub) {
      overviewBody.push(statusLine('账本读取失败：' + state.errors.hub, 'error'))
    } else if (!hub) {
      overviewBody.push(skeleton('rows', 4))
    } else {
      var c = hub.counts || {}
      overviewBody.push(numRow('装着 / 账本里', String(c.installed || 0) + ' / ' + String(c.total || 0)))
      overviewBody.push(numRow('在宿主的加载列表', String(c.listed || 0), {
        level: c.listed === c.installed ? 'ok' : 'warn',
      }))
      overviewBody.push(numRow('重复的能力位', String(c.duplicates || 0), {
        level: c.duplicates ? 'warn' : 'ok',
      }))
      overviewBody.push(numRow('该退役 / 待接管', String(c.retired || 0) + ' / ' + String(c.absorbed || 0)))
      // 新装的包：账本还不认识它，但必须让它露脸——不然「装了个新插件，面板上找不到」。
      var unknown = hub.unknown || []
      if (unknown.length) {
        overviewBody.push(infoRow('账本还不认识的包', unknown.map(function (m) { return m.name }).join('、'), {
          level: 'warn',
        }))
        overviewBody.push(h('p', {
          class: 'fw-row-hint',
          text: '新装的东西会自动出现在这里；弄清它能干什么之后，写进 lib/hub.mjs 的 MODPACK 就有角色了。',
        }))
      }
      // 接线错位必须在这里说：profile 里那份「鱼的世界」如果不是正在跑的这份，
      // 你改了半天的目录根本没人加载，而体检只会丢一句「接线异常」。
      if (hub.selfLink && hub.selfLink.ok === false) {
        overviewBody.push(infoRow('本插件装的是另一份副本', hub.selfLink.missing ? '没装进 profile' : '指向别处', { level: 'warn' }))
        overviewBody.push(h('p', {
          class: 'fw-row-hint',
          text: 'profile 里那份在：' + (hub.selfLink.target || '（没有）')
            + '　正在跑的是：' + (hub.selfLink.expected || '（未知）')
            + '　改错地方的话，重启也不会生效。',
        }))
        // 能报错就该能修：两下确认（第一次只是把按钮变成「确认」），不做弹窗。
        // 「没装」还得分两种：profile 声明过它 → 建联接有意义；没声明 → 建了也不会被加载，
        // 那就别给按钮，直接说要手动加哪两处（改 package.json 不在这个按钮的职责里）。
        var undeclared = hub.selfLink.status === 'missing' && hub.selfLink.declared
          && (!hub.selfLink.declared.dependency || !hub.selfLink.declared.bundle)
        if (undeclared) {
          var need = []
          if (!hub.selfLink.declared.dependency) need.push('dependencies 里加一条 link 记录')
          if (!hub.selfLink.declared.bundle) need.push('dsh.profile.bundles 里加 "dsh-fish-world"')
          overviewBody.push(h('p', {
            class: 'fw-row-hint',
            text: 'profile 还没声明它（' + need.join('；') + '）。也可以让这里代写：',
          }))
          overviewBody.push(h('div', { class: 'fw-card-actions' }, state.selfLinkConfirm
            ? [
              quietButton('确认写入清单（会动 package.json）', function () { doDeclare() }),
              quietButton('取消', function () { state.selfLinkConfirm = false; render() }),
            ]
            : [quietButton('写入 profile 清单', function () { state.selfLinkConfirm = true; render() })]))
          overviewBody.push(h('p', {
            class: 'fw-row-hint',
            text: '写前备份 package.json、写后回读；写完再点「把联接改到当前目录」。重启 DSH 后生效。',
          }))
        } else if (hub.selfLink.status === 'missing' || hub.selfLink.status === 'wrong-target') {
          overviewBody.push(h('div', { class: 'fw-card-actions' }, state.selfLinkConfirm
            ? [
              quietButton('确认改联接（会动 profile）', function () { doRelink() }),
              quietButton('取消', function () { state.selfLinkConfirm = false; render() }),
            ]
            : [quietButton('把联接改到当前目录', function () { state.selfLinkConfirm = true; render() })]))
          overviewBody.push(h('p', {
            class: 'fw-row-hint',
            text: '只动联接，不删任何目录；改完会回读确认，重启 DSH 后生效。',
          }))
        }
      }
      // 结论一句话就够；每一步做了什么挪到下面「刚才这一步」那张卡里，别把概览挤成流水账。
      overviewBody.push(hubStatus)
      overviewBody.push(h('p', {
        class: 'fw-card-note',
        // 三档的意思写在卡片里：光看「借来的手」这四个字，没人知道它跟「要接管的」差在哪。
        text: '接管 = 能力并进鱼的世界，原插件可以退役；借手 = 留着，但由鱼的世界统一调用；不动 = 宿主基础设施，跟养鱼无关。',
      }))
      overviewBody.push(h('p', {
        class: 'fw-card-note',
        text: '开关直接写 profile 的 dsh.profile.bundles（宿主读的那一份），写前备份、写后回读；停用只是移出加载列表，包还在，重启 DSH 生效。',
      }))
    }
    children.push(card({
      key: 'hub-overview',
      title: '整合包',
      note: hub ? 'profile：' + hub.profile : '读取中…',
      span: 12,
      naturalHeight: true,
      children: overviewBody,
    }))

    // ---- 卡一·B：刚才这一步 ----
    // 点一次开关，后端把「找 profile → 备份 → 写 → 回读 → 生效时机」逐条回过来，
    // 这里原样画。单独一张卡：概览那张里摊开五步会把整行撑高。
    var run = state.hubRun
    if (run && (run.steps || []).length) {
      var runBody = [h('p', {
        class: 'fw-card-note',
        text: run.name + ' · ' + shortTime(run.at) + ' · 这几步是后端原话，不是面板推出来的',
      })]
      run.steps.forEach(function (s) { runBody.push(stepRow(s)) })
      children.push(card({
        key: 'hub-run',
        title: '刚才这一步',
        note: run.steps.length + ' 步',
        span: 12,
        naturalHeight: true,
        children: runBody,
      }))
    }

    // ---- 卡二：重复的能力（通栏）----
    // 六组重复项摊开就有二十来行，塞进 6 列会把同一行的卡片挤成一条缝。
    var dupBody = []
    if (!hub) {
      dupBody.push(skeleton('rows', 3))
    } else if (!(hub.duplicates || []).length) {
      dupBody.push(emptyState('没有重复的能力位。', '每个能力只有一个 mod 在做。'))
    } else {
      var roleLabel = {}
      Object.keys(hub.roles || {}).forEach(function (key) { roleLabel[key] = hub.roles[key].label })
      var modByName = {}
      ;(hub.mods || []).forEach(function (mod) { modByName[mod.name] = mod })
      ;(hub.duplicates || []).forEach(function (dup) {
        dupBody.push(h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label', text: dup.label, title: dup.capability }),
          h('span', { class: 'fw-row-value', text: dup.members.length + ' 个' }),
        ]))
        // 每个成员一行，右边写它在整合包里的身份；建议留下的那个写「留」。
        // 已停用的包标出来：它还占着能力位（包在磁盘上），但主人已经把它移出加载列表了。
        dup.members.forEach(function (name) {
          var mod = modByName[name] || {}
          var off = dup.listed && dup.listed[name] === false
          dupBody.push(infoRow(name + (off ? '（已停用）' : ''), name === dup.keep ? '留' : (roleLabel[mod.role] || ''), {
            level: name === dup.keep ? 'ok' : '',
          }))
        })
        // 退役预演：光列「留谁 / 谁该退」不够，得说清停掉会失去什么。
        // 数字来自后端把那个包当成没装重算一遍动作清单，不是面板猜的。
        var adviceGroup = ((hub.advice && hub.advice.groups) || []).filter(function (g) {
          return g.capability === dup.capability
        })[0]
        ;((adviceGroup && adviceGroup.retiring) || []).forEach(function (item) {
          // 必需依赖优先说：它比「清单上看不出影响」严重得多，级别也用 error。
          // 「撑着点名要的东西」次之——「鱼的状态」没 action，清单上一个红点都不会有。
          var lostText = item.requiredBy
            ? '鱼世界的必需依赖'
            : (item.lostCount
              ? '会失去 ' + item.lostCount + ' 个动作'
              : ((item.scopeLost || []).length
                ? '撑着「' + item.scopeLost.map(function (x) { return x.label }).join('、') + '」'
                : (item.reach === 'elsewhere' ? '清单上看不出影响' : '不受影响')))
          dupBody.push(infoRow('停用 ' + item.name, lostText, {
            level: item.requiredBy ? 'error' : (item.lostCount ? 'warn' : ((item.scopeLost || []).length ? 'warn' : '')),
          }))
          if (item.requiredBy) {
            dupBody.push(h('p', {
              class: 'fw-row-hint',
              text: '退了会缺「' + item.requiredBy.feature + '」——鱼世界现在直接靠它；要退先做接管。',
            }))
          }
          if (item.lostCount) {
            dupBody.push(h('p', {
              class: 'fw-row-hint',
              text: '会哑掉：' + item.lost.map(function (x) { return x.name }).slice(0, 6).join('、')
                + (item.lostCount > 6 ? ' 等 ' + item.lostCount + ' 个' : ''),
            }))
          }
        })
      })
    }
    // 只有真出现冲突才给这块卡：修掉「absorbed 被当成重复」的误报后，账本平时是 0 组，
    // 空卡只会占一整行还让人以为出了问题（主人 2026-10-29：「这个卡真的有必要吗」）。
    // 真装了撞能力位的包时它照样会跳出来——冲突是例外，不是常驻内容。
    var hasDuplicates = !!(hub && (hub.duplicates || []).length)
    var hasAdviceNote = !!(hub && hub.advice && hub.advice.note)
    if (hasDuplicates || hasAdviceNote) {
      children.push(card({
        key: 'hub-duplicates',
        title: '重复的能力',
        note: hub ? (hub.duplicates || []).length + ' 组 · 每组建一个「留」' : '',
        span: 12,
        children: dupBody.concat(hub && hub.advice && hub.advice.note
          ? [h('p', { class: 'fw-card-note', text: hub.advice.note })]
          : []),
      }))
    }

    // ---- 卡三：接管 / 退役 / 借手 三段合成一张通栏 ----
    // 三段合成一张卡：三张并排的 4 列卡里，每张只有三五条，读起来要横扫三列才拼得出
    // 「到底哪些该接管、哪些该退」。合成一张通栏、按角色分段，一屏能顺着读下来。
    var groups = [
      { role: 'absorbed', key: 'hub-absorbed', title: '要接管的', note: '能力并进鱼的世界' },
      { role: 'retired', key: 'hub-retired', title: '该退役的', note: '同一件事已经有主' },
      { role: 'borrowed', key: 'hub-borrowed', title: '借来的手', note: '保留，经鱼的世界调用' },
    ]
    var rolesBody = []
    groups.forEach(function (group, index) {
      var list = hub ? (hub.mods || []).filter(function (mod) { return mod.role === group.role }) : []
      rolesBody.push(h('div', {
        class: 'fw-card-head',
        style: index ? 'margin-top:var(--space-4)' : '',
      }, [
        h('h3', { class: 'fw-card-title', text: group.title }),
        h('span', { class: 'fw-card-note', text: group.note + (hub ? ' · ' + list.length + ' 个' : '') }),
      ]))
      if (!hub) {
        rolesBody.push(skeleton('rows', 3))
        return
      }
      if (!list.length) {
        rolesBody.push(h('p', { class: 'fw-row-hint', text: '这一栏是空的。' }))
        return
      }
      list.forEach(function (mod) {
        if (!mod.installed) {
          rolesBody.push(infoRow(mod.name, '未装', { level: 'warn' }))
          if (mod.purpose) rolesBody.push(h('p', { class: 'fw-row-hint', text: mod.purpose }))
          return
        }
        // 开关而不是只读行：面板上的动作必须真的落到插件上（主人 2026-10-28）。
        var hint = [mod.version || '已装', mod.purpose, mod.retireTo ? '→ ' + mod.retireTo : '']
          .filter(Boolean).join(' · ')
        rolesBody.push(switchRow({
          label: mod.name,
          hint: hint,
          checked: mod.listed,
          onChange: function (next) { toggleMod(mod.name, next) },
        }))
      })
    })
    children.push(card({
      key: 'hub-roles',
      title: '按角色分的清单',
      note: hub ? '接管 ' + (hub.counts.absorbed || 0) + ' · 退役 ' + (hub.counts.retired || 0) + ' · 借手 ' + (hub.counts.borrowed || 0) : '',
      span: 12,
      children: rolesBody,
    }))

    // ---- 卡四：今天概览 ----
    // 审计记她自己的动作，平台留存记浏览与收发，两张表合起来才是「今天这条鱼过了什么」。
    // 只报今天，不报总量——总量在「总览」里已经有了，这儿再报一遍就是多余的读数。
    var todayBody = []
    if (!acts) {
      todayBody.push(skeleton('rows', 3))
    } else {
      var t = acts.today || {}
      var plat = acts.platformsToday || {}
      var platIds = Object.keys(plat)
      todayBody.push(h('p', {
        class: 'fw-card-note',
        text: (t.day || '今天') + '：记下的动作 ' + (t.total || 0) + ' 次'
          + (platIds.length ? '；平台上留下 ' + platIds.reduce(function (sum, id) { return sum + (plat[id].today || 0) }, 0) + ' 条记录（含旁听与收发）' : ''),
      }))
      if (!(t.total || 0) && !platIds.length) {
        todayBody.push(emptyState('今天还没动过手。', '写日记、提请求、收表情、发空间、借手都会记在这里。'))
      }
      ;(t.labels || []).forEach(function (row) {
        todayBody.push(infoRow(row.label, String(row.count) + ' 次', { level: 'ok' }))
      })
      if (platIds.length) {
        todayBody.push(h('div', { class: 'fw-mini-grid fw-mini-grid-dense' },
          platIds.map(function (id) {
            var info = plat[id] || {}
            return miniCard({
              label: info.name || id,
              value: String(info.today || 0),
              // 「一共几条」看不出是谁在说：她说的和旁听的完全是两回事。
              sub: (info.said != null ? '说了 ' + info.said + ' · 听 ' + (info.heard || 0) : '今天')
                + ' · 累计 ' + (info.total || 0),
              dim: !(info.today > 0),
            })
          })))
      }
    }
    children.push(card({
      key: 'hub-today',
      title: '今天概览',
      note: acts && acts.today ? acts.today.day : '',
      span: 12,
      naturalHeight: true,
      children: todayBody,
    }))

    // ---- 卡五：鱼的家（目录真实现状）----
    var homeBody = []
    if (!acts) {
      homeBody.push(skeleton('rows', 3))
    } else if (!(acts.home || []).length) {
      homeBody.push(emptyState('还没绑工作区，读不到鱼的家。'))
    } else {
      (acts.home || []).forEach(function (folder) {
        // 只报「在 / 没有」不够用：空目录和有货的目录长得一模一样。
        // 顺带报一层项数、文件数与最近改动（后端数，面板不自己 stat）。
        var bits = []
        if (folder.exists) {
          bits.push('在')
          // 一层里可能有文件也可能只有子目录（宝库就是图库 + 网站链接两个目录）：
          // 报「2 项 · 0 个文件」会让人以为里头是空的。
          if (folder.files > 0) {
            bits.push(folder.entries + ' 项')
            if (folder.bytes) bits.push(formatBytes(folder.bytes))
          } else if (folder.entries > 0) {
            bits.push(folder.entries + ' 个目录')
          } else {
            bits.push('空')
          }
        }
        homeBody.push(infoRow(folder.name, bits.length ? bits.join(' · ') : '没有', {
          level: folder.exists ? 'ok' : 'warn',
        }))
        homeBody.push(h('p', {
          class: 'fw-row-hint',
          text: folder.path + (folder.latestAt ? '　最近改动 ' + shortTime(folder.latestAt) : ''),
        }))
        // 「里面有什么」：最近改动的几条摊开，够认出是不是他在找的那份。
        // 默认收起——六个目录全摊开就成了一堵墙。
        if (folder.exists && Array.isArray(folder.recent) && folder.recent.length) {
          var opened = (state.homeOpen || (state.homeOpen = {}))[folder.name] === true
          homeBody.push(h('div', { class: 'fw-card-actions' }, [
            quietButton(opened ? '收起' : '看看里面', function () {
              state.homeOpen = state.homeOpen || {}
              state.homeOpen[folder.name] = !opened
              render()
            }),
          ]))
          if (opened) {
            folder.recent.forEach(function (item) {
              homeBody.push(infoRow(item.name, item.dir ? '目录' : formatBytes(item.bytes) || '0 B', {
                level: item.dir ? 'neutral' : '',
              }))
              if (item.mtime) {
                homeBody.push(h('p', { class: 'fw-row-hint', text: '改动 ' + shortTime(new Date(item.mtime).toISOString()) }))
              }
            })
          }
        }
      })
    }
    children.push(card({
      key: 'hub-home',
      title: '鱼的家',
      note: '目录真在不在，不猜',
      span: 12,
      naturalHeight: true,
      children: homeBody,
    }))

    // ---- 卡六：鱼手上的动作 ----
    // 账本回答「装了哪些插件」，这张卡回答「她到底能动什么」——两件事不一样。
    var tools = state.hubTools
    var toolBody = []
    if (state.errors.hubTools) {
      toolBody.push(statusLine('读不到动作清单：' + state.errors.hubTools, 'error'))
    } else if (!tools) {
      toolBody.push(skeleton('rows', 4))
    } else {
      var tc = tools.counts || {}
      // 标题与这句必须同一套口径：一个说 30 一个说 43，等于自己跟自己打架。
      toolBody.push(h('p', {
        class: 'fw-card-note',
        text: '共 ' + (tc.total || 0) + ' 个动作 · 核过闸门能用 '
          + ((tc.available || 0) - (tc.unverified || 0))
          + (tc.unverified ? '，待核 ' + tc.unverified : '')
          + (tc.noGate ? '，闸门没过 ' + tc.noGate : '')
          + (tc.noPlugin ? '，缺插件 ' + tc.noPlugin : '')
          + '（只读清单：这里不会替你调任何动作）',
      }))
      // 边界说明：这一页只覆盖 fish_world 一个工具下的动作。
      toolBody.push(h('p', {
        class: 'fw-row-hint',
        text: '这张清单只覆盖 fish_world 这一个工具的动作；bili_*（B 站）、抖音是别的插件注册的独立工具，'
          + 'read_animation 是鱼世界自己另外注册的独立工具（不受这里的闸门判定），read_image 是宿主内置的。',
      }))
      // 鱼世界自己另外注册的独立工具：它们不在上面那 44 条里，但确实是她手上的手。
      if (Array.isArray(tools.ownTools) && tools.ownTools.length) {
        toolBody.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-4)' }, [
          h('h3', { class: 'fw-card-title', text: '另外注册的独立工具' }),
          h('span', { class: 'fw-card-note', text: tools.ownTools.length + ' 个 · 不走 action 枚举' }),
        ]))
        tools.ownTools.forEach(function (tool) {
          toolBody.push(infoRow(tool.name, tool.label || '', { level: 'ok' }))
          var toolHint = [tool.note, tool.source].filter(Boolean).join('　')
          if (toolHint) toolBody.push(h('p', { class: 'fw-row-hint', text: toolHint }))
        })
      }
      ;(tools.groups || []).forEach(function (group) {
        // 40 多个动作一口气铺开，找某一个要滚很久。按组折叠：标题行永远在（带「能用 N/M」），
        // 点开才列出这一组的动作。展开状态记在 state 里，重绘后不会自己合上。
        var openGroups = state.hubToolsOpen || (state.hubToolsOpen = {})
        var isOpen = openGroups[group.id] === true
        toolBody.push(h('div', { class: 'fw-card-head' }, [
          h('h3', { class: 'fw-card-title', text: group.label }),
          h('span', { class: 'fw-card-note', text: (group.note ? group.note + ' · ' : '') + group.available + '/' + group.total }),
          h('span', { class: 'fw-head-action' }, [
            quietButton(isOpen ? '收起' : '展开', function () {
              openGroups[group.id] = !isOpen
              render()
            }),
          ]),
        ]))
        if (!isOpen) return
        group.actions.forEach(function (action) {
          // 三种结果说清楚：能用 / 缺哪个插件 / 闸门没过（为什么没过照抄后端给的原因）。
          var verdict = !action.available
            ? (action.blocked === 'gate' ? '闸门没过' : '缺 ' + action.missing.join('、'))
            : (action.gateUnknown ? '能用（闸门未核）' : '能用')
          toolBody.push(infoRow(action.name, verdict, {
            level: action.available && !action.gateUnknown ? '' : 'warn',
          }))
          var hint = [action.note, action.reason].filter(Boolean).join('　')
          if (hint) toolBody.push(h('p', { class: 'fw-row-hint', text: hint }))
        })
      })
    }
    children.push(card({
      key: 'hub-tools',
      title: '鱼手上的动作',
      // 卡标题只报「已经核过闸门」的数：把未核的混进「可用」里，就成了一个好看的假读数。
      note: tools && tools.counts
        ? ((tools.counts.available || 0) - (tools.counts.unverified || 0)) + ' / ' + tools.counts.total + ' 能用'
          + (tools.counts.unverified ? '（' + tools.counts.unverified + ' 个闸门未核）' : '')
        : '',
      span: 12,
      children: toolBody,
    }))

    return children
  }
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
      { key: 'forwardExpand', label: '展开合并转发的聊天记录', kind: 'bool', hint: '收到聊天记录卡片时把卡片里全部内容摊开（默认开）' },
      { key: 'sendMessage', label: '发送消息', kind: 'bool', hint: '仍受 QQ 桥总开关、试运行与转私聊/转群限制', danger: true },
      { key: 'dailyMessages', label: '每日发送上限', kind: 'num', min: 0, max: 3000, unit: '条', hint: '0 = 不限' },
      { key: 'qzoneEnabled', label: '打理自己的 QQ 空间', kind: 'bool', hint: '只在主人的隔离会话中可写', danger: true },
      // 空间各项额度不在这里：它们真存在 config.qzone.postsPerDay 等字段，
      // 由「QQ 空间」那一栏的额度控件读写。这里再加一行会是改了不生效的假控件。
      {
        key: 'qzoneDailyDiary',
        label: '每天写完日记就发一条空间',
        kind: 'bool',
        danger: true,
        hint: '打开后：当天本机写过日记就提醒她发一条空间日记，并顺便看看别人在她空间的赞与评论。默认关——这是会被真人看见的外发；点赞回评仍受空间额度限制。',
      },
      { key: 'batchEnabled', label: '等他说完再回', kind: 'bool', hint: '同一个人连发几条时合成一件事回，不逐条抢答' },
      { key: 'batchQuietSec', label: '安静多久算说完', kind: 'num', min: 1, max: 120, unit: '秒' },
      { key: 'batchUnfinishedExtraSec', label: '像没说完再多等', kind: 'num', min: 0, max: 120, unit: '秒' },
      { key: 'batchMaxWaitSec', label: '最久等多久先回', kind: 'num', min: 5, max: 600, unit: '秒' },
      { key: 'liveContextCount', label: '开口前摆几句现场', kind: 'num', min: 0, max: 60, unit: '条', hint: '别人的发言当背景，0 = 不摆' },
      { key: 'stickerSubType', label: '表情按哪种形式发', kind: 'num', min: 0, max: 1, hint: '1 = 小表情（可长按收藏），0 = 普通大图' },
      { key: 'autoPokeBack', label: '被戳一下自动戳回去', kind: 'bool', danger: true, hint: '默认关：这是会被真人看见的动作' },
      { key: 'pokeTalk', label: '被戳时说一句话', kind: 'bool', danger: true, hint: '默认关：把「有人戳你」投进会话，让她自己回一句，而不是只回戳' },
    ],
    // 微信：面板只是只读展示 + 闸门。收发、扫码、绑定、人格与行为都在
    // dsh-wechat-plugin 那边（设置 → 微信）。
    // 字段名与后端 PLATFORMS.wechat.defaults 一致（见 lib/platforms.mjs）。
    wechat: [
      { key: 'enabled', label: '启用微信能力', kind: 'bool', hint: '默认关闭，打开后鱼才会通过微信收发' },
      { key: 'readMessages', label: '读取消息', kind: 'bool', hint: '只读 dsh-wechat-plugin 送来的文字与图片' },
      { key: 'sendMessage', label: '发送消息', kind: 'bool', danger: true, hint: '外发，默认关；仍受每日条数与单条字数限制' },
      { key: 'allowGroup', label: '允许群聊', kind: 'bool', hint: '群聊里只在被 @ 或叫到名字时回' },
      { key: 'dailyMessages', label: '每日条数', kind: 'num', min: 0, max: 3000, unit: '条', hint: '0 = 不限' },
      { key: 'maxCharsPerMessage', label: '单条字数', kind: 'num', min: 1, max: 2000, unit: '字', hint: '超出直接拒发并说明原因' },
      { key: 'pollSeconds', label: '轮询间隔', kind: 'num', min: 2, max: 300, unit: '秒', hint: '多久问一次 dsh-wechat-plugin 有没有新消息' },
    ],
    // B 站：这 24 项直接读写 bili-whale 的 $DSH_HOME/bili-whale.config.json（见
    // lib/platforms.mjs 的 BILI_WHALE_FIELDS）。分组只影响展示顺序，不影响存哪儿。
    // enabled / watchEnabled 是鱼世界自己的闸门，不写进插件配置。
    bili: [
      { key: 'enabled', label: '启用 B 站能力', kind: 'bool', group: '监听', hint: '默认关闭，打开后鱼才会浏览 B 站、听评论与私信' },
      { key: 'watchEnabled', label: '浏览视频', kind: 'bool', hint: '允许她去刷视频、看内容' },
      { key: 'listenComment', label: '听评论', kind: 'bool', hint: '别人在她视频下评论时知道（写进 bili-whale 的 listen.comment）' },
      { key: 'listenCommentIntervalSec', label: '多久看一次评论', kind: 'num', min: 10, max: 3600, unit: '秒' },
      {
        key: 'listenScope',
        label: '评论回到什么程度',
        kind: 'select',
        options: [
          { value: 'reply', label: '只回提到她的' },
          { value: 'both', label: '也回评论里的其他人' },
        ],
      },
      { key: 'listenOncePerPerson', label: '同一个人只回一次', kind: 'bool', hint: '关掉后同一个人再说还会接话' },
      { key: 'listenAllDay', label: '全天都听', kind: 'bool', hint: '关掉 = 只在她醒着的时段里听' },
      { key: 'listenDm', label: '听私信', kind: 'bool' },
      { key: 'listenDmIntervalSec', label: '多久看一次私信', kind: 'num', min: 10, max: 3600, unit: '秒' },
      { key: 'listenLive', label: '听直播', kind: 'bool', hint: '进直播间听弹幕；直播间号码在 bili-whale 自己的设置页填' },
      { key: 'shareEnabled', label: '分享值得的视频给主人', kind: 'bool', danger: true, group: '分享', hint: '外发：会拿她的号去评论 / 私信。整个平台没启用时仍会被闸门拦住' },
      {
        key: 'shareVia',
        label: '分享用什么方式',
        kind: 'select',
        options: [
          { value: 'comment', label: '发评论 @ 主人' },
          { value: 'dm', label: '私信主人' },
        ],
      },
      { key: 'shareMinScore', label: '至少多少分才分享', kind: 'num', min: 0, max: 100, unit: '分', hint: '低于这个分数就当「今天没有值得发的」' },
      { key: 'shareAiCommentGuard', label: '评论区像 AI 就别发', kind: 'bool', hint: '评论区 AI 味太重时放弃这条，不硬发' },
      { key: 'shareDaily', label: '每天最多分享', kind: 'num', min: 0, max: 20, unit: '条' },
      { key: 'riskReadDaily', label: '每天读的上限', kind: 'num', min: 0, max: 30000, unit: '次', group: '风控配额', hint: '读得太快容易被风控，这是硬上限' },
      { key: 'riskWriteDaily', label: '每天写的上限', kind: 'num', min: 0, max: 300, unit: '次', hint: '评论 / 私信 / 点赞这类写操作的总量' },
      { key: 'riskMinGapMs', label: '两次写之间至少隔', kind: 'num', min: 100, max: 60000, unit: '毫秒' },
      { key: 'nightMaxVideos', label: '一次醒来最多看', kind: 'num', min: 1, max: 20, unit: '个', group: '作息', hint: '多久醒、每天最多醒几次在 bili-whale 的作息窗口里，不在这页' },
      { key: 'nightSkipChance', label: '这次醒来跳过的概率', kind: 'num', min: 0, max: 1, step: 0.05, hint: '0 = 每次都看，1 = 每次都跳过' },
      { key: 'nightMinGapMin', label: '两次醒来至少隔', kind: 'num', min: 0, max: 240, unit: '分钟' },
      { key: 'personaName', label: '角色名', kind: 'text', group: '人设', hint: '写给模型看的「你是谁」；留空 = 用 bili-whale 自己的默认' },
      { key: 'personaOwnerTitle', label: '怎么称呼主人', kind: 'text', hint: '例如「主人」「你」' },
      { key: 'personaSelfClaim', label: '怎么自称', kind: 'text', hint: '例如「我」「本鱼」' },
      { key: 'ownerMid', label: '主人的 B 站 UID', kind: 'text', group: '主人', hint: '分享时 @ 的人（数字 UID）；只用于白名单查询' },
      { key: 'ownerName', label: '主人的 B 站昵称', kind: 'text', hint: '正文里 @ 的名字；改过昵称要跟着改' },
    ],
    douyin: [
      { key: 'enabled', label: '启用抖音能力', kind: 'bool', hint: '默认关闭，需要专用 Edge 与你的登录状态' },
      { key: 'watchEnabled', label: '自己刷抖音', kind: 'bool' },
      { key: 'silentWatch', label: '静默观看', kind: 'bool', hint: '静音并尝试最小化（仍是可见窗口）' },
      { key: 'watchTopicMode', label: '观看方式', kind: 'select',
        options: [
          { value: 'recommend', label: '自主挑选推荐' },
          { value: 'topic', label: '围绕指定主题' },
        ],
      },
      { key: 'watchTopics', label: '想看的主题', kind: 'textarea', hint: '每行一个；观看方式选「围绕指定主题」时才生效' },
      { key: 'watchExclude', label: '排除的关键词', kind: 'textarea', hint: '每行一个，按作品标题匹配' },
      { key: 'videoWindows', label: '允许观看的时段', kind: 'textarea', hint: '北京时间，每行一段，如 09:00-22:00；全天写 00:00-24:00' },
      { key: 'sessionMinutes', label: '单轮时长', kind: 'num', min: 0, max: 1440, unit: '分钟', hint: '0 = 不限单轮时长' },
      { key: 'autoStart', label: '允许时段自动开始一轮', kind: 'bool', danger: true },
      { key: 'autoStartMaxRequests', label: '自动开始时的请求上限', kind: 'num', min: 1, max: 10000, unit: '次' },
      { key: 'allowGreeting', label: '允许主动问候', kind: 'bool', danger: true, hint: '默认关闭' },
      { key: 'greetingWindows', label: '问候时段', kind: 'textarea', hint: '北京时间，每行一段' },
      { key: 'greetingDailyLimit', label: '每日主动问候上限', kind: 'num', min: 1, max: 2, unit: '次' },
      { key: 'allowComment', label: '允许自主发布评论', kind: 'bool', danger: true, hint: '默认关闭' },
      { key: 'commentDailyLimit', label: '评论每日上限', kind: 'num', min: 1, max: 20, unit: '次' },
      { key: 'commentPerSessionLimit', label: '评论每轮上限', kind: 'num', min: 1, max: 3, unit: '次' },
      { key: 'allowShare', label: '允许自主分享', kind: 'bool', danger: true, hint: '默认关闭；分享对象在抖音插件里勾选' },
      { key: 'shareDailyLimit', label: '分享每日上限', kind: 'num', min: 1, max: 20, unit: '次' },
      { key: 'dailyReplyLimit', label: '私信每日模型请求上限', kind: 'num', min: 1, max: 200, unit: '次', hint: '私信回复的启停在抖音插件里操作' },
      { key: 'interactionsOn', label: '允许好友互动', kind: 'bool', danger: true, hint: '和许可名单里的好友 / 群聊互动（群聊只在被 @ 或叫到昵称时回）；默认关，名单在抖音插件里勾选' },
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
    var targets = cloneTargets(data.targets || [])
    var tab = state.chatTab || 'current'

    // 白名单里「已选好房间」的才算真的在收信；没选的先放着，面板标出来。
    var ready = targets.filter(function (t) { return t.enabled !== false && t.sessionId })
    // 「清空白名单」只在这一块有内容时才给：空名单上放一个清空按钮，点了什么也不会发生。
    var clearButton = targets.length
      ? ghostButton('清空白名单', function () {
        var previous = cloneTargets(targets)
        saveChatTargets([], function () {
          chatUndo('已清空 ' + previous.length + ' 个允许目标，撤销可恢复', previous)
        })
      })
      : null
    body.unshift(chatSectionHead((chat.enabled ? '收信中 · ' : '未启用 · ') + ready.length + ' 个在收信', clearButton))
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
        // 「清空白名单」已经挪到这一块的标题右上角（同一块里，不再挂在列表下方单独一行）。
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

    // 开口档位挪到 qqChatModeSection()：那是窄内容，留在通栏里右边会空一大片。
    return body
  }

  // 「群里怎么开口」单独一节（窄内容，与「发到哪 / 图片」并排用）。
  function qqChatModeSection() {
    var data = state.qqChat
    var config = (data && data.config) || {}
    var body = [h('div', { class: 'fw-card-head', style: 'margin-top:0' }, [
      h('h3', { class: 'fw-card-title', text: '群里怎么开口' }),
    ])]
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

  // QQ 的「聊天」一段：允许名单 / 全部群与好友 / 群里怎么开口。
  // 和「设置」用顶部两个 tab 分开——原来所有东西平铺在一张卡里，一眼看不出哪块是账号、哪块是聊天。
  function qqChatTabSections() {
    var data = state.qqChat
    if (!data && !state.errors.qqChat) return [statusLine('读取中…')]
    return qqChatSections()
  }

  /** 分区小标题：与同卡内的「空间额度」用同一种写法，几块内容一眼分得开。 */
  function chatSectionHead(note, action) {
    return h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
      h('h3', { class: 'fw-card-title', text: '聊天窗口' }),
      note ? h('span', { class: 'fw-card-note', text: note }) : null,
      // 操作贴在这块标题的右上角：清空白名单是「这一块」的兜底动作，
      // 原来挂在列表下方单独一行，和列表分家之后看着像另一件事（主人 2026-10-27：移动到 A 区域内）。
      action ? h('span', { class: 'fw-head-action' }, [action]) : null,
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
      h('p', { class: 'fw-card-note fw-span-full', text: '以 QQ 桥的「私聊 QQ 号 / 目标会话」为准；世界设置和关系表各存一份影子，保存后会自动跟过去。' }),
      // 通栏卡里两列铺开：左边是「现在绑的是什么」，右边是「要改成什么」。
      h('div', { class: 'fw-form-grid' }, [
        h('div', {}, rows),
        h('div', {}, [ownerSessionPicker(data, session.bridge || '')]),
      ]),
      // 会话失效要单独说：三处可能一致，但这个 id 已经被 DSH 清掉了，
      // 表现就是日记/请求/成长全空（2026-10-25 真出过一次）。
      d.sessionAlive === false
        ? statusLine('这个主人会话已经不存在了（DSH 会清理旧会话），换一个再保存。', 'error')
        : null,
      detail.length ? h('p', { class: 'fw-row-hint', text: detail.join('；') }) : null,
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
    }, 'ghost') // 全局只保留「保存信息 / 保存角色」两个主按钮，其余保存都是幽灵（要提回来把这行改回 'primary'）

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

  // 平台顺序：QQ 通栏（卡片里还有聊天窗口子分区），其余各平台按一行排开。
  // 张数不写死：后端 PLATFORMS 加了「微信」这类新平台，这里会自动多一张卡。
  var PLATFORM_ORDER = { qq: 0, wechat: 1, douyin: 2, bili: 3 }

  function orderedPlatforms(list) {
    return (list || []).slice().sort(function (a, b) {
      var x = PLATFORM_ORDER[a.id] == null ? 9 : PLATFORM_ORDER[a.id]
      var y = PLATFORM_ORDER[b.id] == null ? 9 : PLATFORM_ORDER[b.id]
      return x - y
    })
  }

  /**
   * 每行最多 3 张：3 张 → 4/4/4，2 张 → 6/6，1 张 → 12。
   * 先按 3 张切行再算跨度，避免出现 4+4+4 后面拖一张 4 列留下的 8 列空洞。
   */
  function platformSpans(count) {
    var out = []
    var left = count
    while (left > 0) {
      var take = Math.min(3, left)
      for (var i = 0; i < take; i++) out.push(12 / take)
      left -= take
    }
    return out
  }

  function viewPlatforms() {
    var data = state.platforms
    var children = []

    if (state.errors.platforms) {
      children.push(card({ key: 'platforms-error', title: '鱼与平台', span: 12, children: [statusLine('读取失败：' + state.errors.platforms, 'error')] }))
    } else if (!data) {
      children.push(card({ key: 'platforms-loading', title: '鱼与平台', span: 12, children: [skeleton('rows', 3)] }))
    } else {
      var platformList = data.platforms || []
      var ordered = orderedPlatforms(platformList)
      children.push(card({
        key: 'platforms-intro',
        title: '鱼与世界',
        note: '点一项进入对应平台',
        span: 8,
        children: [h('div', { class: 'fw-mini-grid' }, ordered.map(function (p, index, all) {
          var on = (p.config || {}).enabled === true
          return miniCard({
            label: p.name || p.id,
            value: !p.installed ? '未安装' : (on ? '已启用' : '未启用'),
            sub: p.installed ? '插件已装' : '缺插件 ' + (p.plugin || ''),
            tone: !p.installed ? 'warn' : '',
            jump: 'platform-' + p.id,
            // 奇数个时最后一项跨两列，别在 2 列网格里留空位
            wide: index === all.length - 1 && all.length % 2 === 1,
          })
        }).filter(Boolean))],
      }))
      // 右边补一张说明卡：默认关、外发另开一层、存在哪。原来这三句堆在摘要下面，把卡片撑高又空出右边。
      var enabledCount = platformList.filter(function (p) { return (p.config || {}).enabled === true }).length
      children.push(card({
        key: 'platforms-rules',
        title: '规则',
        note: enabledCount + ' / ' + platformList.length + ' 已启用',
        span: 4,
        children: [
          h('p', { class: 'fw-card-note', text: platformList.length + ' 个平台默认都不启用，需要你自己打开。打开后鱼才参与；外发动作还要再单独开一层，模型无法自行绕过。' }),
          h('p', { class: 'fw-card-note', text: storageLine() }),
        ],
      }))

      // 主人绑定不在这里：它是「设定」，在「鱼的设定」里改（可选会话、能保存）。
      // 这里曾经放一张只读的「主人绑定」卡，看得见却改不了，还和设定页各说一遍。

      // 每个平台一张独立卡片，按 QQ → 微信 → 抖音 → B 站 排列。
      // QQ 通栏（里面有聊天窗口子分区），其余按每行最多 3 张分配跨度。
      var others = ordered.filter(function (p) { return p.id !== 'qq' })
      var spans = platformSpans(others.length)
      var platformSpanById = {}
      others.forEach(function (p, i) { platformSpanById[p.id] = spans[i] })

      ordered.forEach(function (platform) {
        var cfg = platform.config || {}
        var fields = PLATFORM_FIELDS[platform.id] || []
        var body = []

        if (!platform.installed) {
          body.push(statusLine('缺少插件 ' + platform.plugin + '，对应功能暂不可用。', 'warn'))
        }
        if (platform.syncError) {
          body.push(statusLine('读不到插件的当前设置：' + platform.syncError + '。下面是上次读到的值，改了也可能没生效。', 'warn'))
        }
        body.push(h('p', { class: 'fw-card-note', text: platform.description || '' }))
        // 微信只做只读展示 + 闸门：收发、扫码、绑定都在 dsh-wechat-plugin 那边，
        // 不写清楚会被当成「面板自己能连微信」。
        if (platform.id === 'wechat') {
          body.push(h('p', {
            class: 'fw-card-note',
            text: '微信收发、扫码与人格由 dsh-wechat-plugin 负责（设置 → 微信）；这里只读展示，并保留鱼世界自己的读 / 发闸门。',
          }))
        }

        // ---- 账号情况：先让人看清"鱼用的是哪个号" ----
        // 这里面的「总开关 / 试运行」是 QQ 桥自己的闸门，与下面的能力开关不是一回事。
        body.push(h('div', { class: 'fw-account' }, renderAccount(platform)))
        // AstrBot 接入归到 QQ 名下：它决定 QQ 从哪条通道收发，所以入口放在账号情况后面。
        if (platform.id === 'qq') body.push(astrbotEntry())
        // QQ 分三个 tab：设置（能不能收发、发多少）、聊天（跟谁聊、怎么聊、读什么）、
        // QQ 空间（打理自己的空间：额度与每天日记发一条）。
        // 主人 2026-10-27：「设置 / 聊天 / qq 空间这样子排列，把 qq 空间内容单独拿出来；
        // 群聊和私聊的设置都在聊天设置内」。
        var QQ_TABS = ['settings', 'chat', 'qzone']
        var qqTab = platform.id === 'qq' && QQ_TABS.indexOf(state.qqTab) >= 0 ? state.qqTab : 'settings'
        if (platform.id === 'qq') {
          body.push(h('div', { class: 'fw-tabs', role: 'tablist', style: 'margin-top:var(--space-3)' }, [
            tabItem('设置', qqTab === 'settings', function () { state.qqTab = 'settings'; render() }),
            tabItem('聊天', qqTab === 'chat', function () {
              state.qqTab = 'chat'
              if (!state.qqChat) loadQQChat()
              render()
            }),
            tabItem('QQ 空间', qqTab === 'qzone', function () {
              state.qqTab = 'qzone'
              if (!state.qzone) loadQzone()
              loadQzoneRuntime()
              render()
            }),
          ]))
        }

        // 细化区（展开 / 收起）只放「当前 tab」的东西。
        // 聊天栏 = 跟谁聊 + 怎么聊：发到哪个群 / 私聊、群号、图片读写、允许名单、
        // 开口档位、攒批节奏、被戳反应、群公告、读历史与抽帧（决定「看得到什么」）。
        // 空间栏 = 空间开关、每天日记发一条、各项额度。剩下的（启用能力、发消息、
        // 每日上限、拉起协议端）才是设置。
        var CHAT_FIELD_KEYS = {
          readHistory: true, videoFrames: true, forwardExpand: true, groupNotice: true,
          batchEnabled: true, batchQuietSec: true, batchUnfinishedExtraSec: true, batchMaxWaitSec: true,
          liveContextCount: true, stickerSubType: true,
          autoPokeBack: true, pokeTalk: true,
        }
        var QZONE_FIELD_KEYS = { qzoneEnabled: true, qzoneDailyDiary: true }
        var tabFields = platform.id === 'qq'
          ? fields.filter(function (field) {
            var tab = QZONE_FIELD_KEYS[field.key] ? 'qzone' : (CHAT_FIELD_KEYS[field.key] ? 'chat' : 'settings')
            return tab === qqTab
          })
          : fields
        // 计数按这一栏自己的字段算，别把另一栏的开关算进来。
        var boolFields = tabFields.filter(function (field) { return field.kind === 'bool' })
        var onCount = boolFields.filter(function (field) { return cfg[field.key] === true }).length
        var groupId = 'fw-capgroup-' + platform.id
        // 文案跟当前 tab 走：「展开设置 / 收起设置」「展开聊天 / 收起聊天」「展开 QQ 空间 / 收起 QQ 空间」。
        var detailLabel = qqTab === 'chat' ? '聊天' : (qqTab === 'qzone' ? ' QQ 空间' : '设置')
        var openKey = platform.id === 'qq' ? ('detailOpen.qq.' + qqTab) : ('capOpen.' + platform.id)
        var open = readFlag(openKey, false)
        var toggle = h('button', {
          class: 'fw-disclosure',
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': open ? groupId : null,
        }, [
          h('span', { class: 'fw-disclosure-label', text: open ? '收起' + detailLabel : '展开' + detailLabel }),
          h('span', {
            class: 'fw-disclosure-meta',
            text: platform.id === 'qq' && qqTab === 'chat'
              ? ((state.qqChat && state.qqChat.targets ? state.qqChat.targets.length : 0) + ' 个允许目标')
              : '已开 ' + onCount + ' / ' + boolFields.length + ' 项',
          }),
          h('span', { class: 'fw-disclosure-mark', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
        ])
        toggle.addEventListener('click', function () {
          writeFlag(openKey, !open)
          render()
        })
        body.push(toggle)

        // 分组小标题：字段上写了 group 就在第一次出现时插一行，跨满整行。
        // B 站按「监听 / 分享 / 风控 / 作息 / 人设 / 主人」分组（它的项来自上游插件）；
        // 微信现在只有闸门字段，没有需要分组的项。
        function fieldGroupHead(name) {
          return h('div', { class: 'fw-card-head', style: 'grid-column:1 / -1;margin-top:var(--space-3)' }, [
            h('h3', { class: 'fw-card-title', text: name }),
          ])
        }

        function renderFields(list) {
          var out = []
          var lastGroup = ''
          list.forEach(function (field) {
            if (field.group && field.group !== lastGroup) {
              lastGroup = field.group
              out.push(fieldGroupHead(field.group))
            }
            out.push(renderField(field))
          })
          return out
        }

        function renderField(field) {
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
          if (field.kind === 'text' || field.kind === 'textarea') {
            // 文本与多行：整行跨两列（多行提示词要宽度），留空的含义写在 hint 里。
            var textControl = field.kind === 'textarea'
              ? h('textarea', { class: 'fw-input fw-textarea', rows: '3', 'aria-label': field.label })
              : h('input', { class: 'fw-input', type: 'text', maxlength: '4000', 'aria-label': field.label })
            textControl.value = cfg[field.key] == null ? '' : String(cfg[field.key])
            textControl.addEventListener('change', function () {
              savePlatform(platform.id, { [field.key]: textControl.value })
            })
            return h('div', { class: 'fw-row fw-row-wide' }, [
              h('span', { class: 'fw-row-label', text: field.label }),
              field.hint ? h('span', { class: 'fw-row-hint', text: field.hint }) : null,
              h('div', { class: 'fw-row-control' }, [textControl]),
            ])
          }
          var input = h('input', {
            class: 'fw-input',
            type: 'number',
            min: String(field.min),
            max: String(field.max),
            // 小数字段（概率）要给 step，否则一按上下键就从 0.3 跳成 0 或 1。
            step: field.step == null ? null : String(field.step),
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
        }

        // 展开 / 收起只决定这一组看不看得见，不改动任何能力本身，
        // 所以不能用开关的形状（拨它就等于关掉了什么？）——做成一行展开/收起。

        var groupChildren = []
        if (open) {
          // 一节内容装进一个 .fw-part：节内单列、节与节之间由外层网格分栏。
          // 原来是把所有行平铺进同一个两列网格，于是会话列表被挤成三行，
          // 还和右边无关的开关交错（主人 2026-10-27：布局再优化下）。
          // mode：'' 半栏单列 / 'full' 通栏单列 / 'cols' 通栏节内两列（开关特别多的节）。
          function pushPart(nodes, mode) {
            if (!nodes.length) return
            var first = true
            nodes.forEach(function (piece) {
              // 节内第一个小标题贴顶，其余留上边距（原来的 margin-top 写在 head 上）
              if (first && piece.className && piece.className.indexOf('fw-card-head') >= 0) piece.style.marginTop = '0'
              if (first) first = false
            })
            var cls = mode === 'full' ? 'fw-part fw-part-full'
              : mode === 'cols' ? 'fw-part fw-part-full fw-part-cols' : 'fw-part'
            groupChildren.push(h('div', { class: cls }, nodes))
          }
          // 聊天栏：跟谁聊（允许名单，通栏）+ 发到哪 / 群号 / 图片。
          if (platform.id === 'qq' && qqTab === 'chat') {
            pushPart(qqChatTabSections(), 'full')
            // 「群里怎么开口」和「读取聊天历史」都是窄内容：并排各占半栏时，
            // 左边那半只有 112px 高，紧挨着的「发送到」有 392px，下方会空出一大块
            // （主人 2026-10-27：下方空白太多）。堆进同一列，右侧整列交给「发送到」。
            groupChildren.push(h('div', { class: 'fw-part fw-stack' }, [
              h('div', { class: 'fw-stack-item' }, qqChatModeSection()),
              h('div', { class: 'fw-stack-item' }, renderFields(tabFields)),
            ]))
            pushPart(renderChatBridgeDetail(platform))
          }
          // 设置栏：只留桥的闸门（试运行），账号级开关都在这一栏的字段里。
          if (platform.id === 'qq' && qqTab === 'settings') pushPart(renderTrialRow(platform))
          // 空间栏：今天的状态一节，额度一节。
          if (platform.id === 'qq' && qqTab === 'qzone') pushPart(qzoneRuntimeRows(), 'full')
          // 聊天栏的字段已经在上面并进左列了，这里不要再排一次。
          if (!(platform.id === 'qq' && qqTab === 'chat')) pushPart(renderFields(tabFields), 'cols')

          // 平台级说明讲的是「发送额度 / 能跟谁聊」，属于设置与聊天两栏；
          // 空间栏里再写一遍就成了无关噪音（主人 2026-10-27 要求空间栏只放空间的事）。
          if (!(platform.id === 'qq' && qqTab === 'qzone') && (platform.notes || []).length) {
            pushPart(platform.notes.map(function (note) {
              return h('p', { class: 'fw-card-note', text: '· ' + note })
            }), 'full')
          }

          // 空间额度挪进「QQ 空间」栏：它和空间开关是同一件事，不该留在设置栏里。
          if (platform.id === 'qq' && qqTab === 'qzone' && state.qzone) {
            var qcfg = state.qzone || {}
            var qnodes = [h('div', { class: 'fw-card-head', style: 'margin-top:0' }, [
              h('h3', { class: 'fw-card-title', text: '空间额度' }),
              h('span', { class: 'fw-card-note', text: '0 表示禁用' }),
            ])]
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
              qnodes.push(h('div', { class: 'fw-row' }, [
                h('span', { class: 'fw-row-label', text: row[1] }),
                h('span', { style: 'width:76px;flex:none' }, [qinput]),
              ]))
            })
            qnodes.push(h('p', { class: 'fw-card-note', text: '动态和日记共用额度；额度只限制频率，不改变权限。' }))
            pushPart(qnodes, 'cols')
          }
        }
        // 分组容器只在展开时存在：收起时这一整块不在 DOM 里，卡片就只剩账号情况与一行按钮。
        if (open) body.push(h('div', { class: 'fw-capgroup', id: groupId }, groupChildren))

        var stateText = !platform.installed ? '插件未安装' : (cfg.enabled ? '已启用' : '未启用')
        var platformCard = card({
          key: 'platform-' + platform.id,
          title: platform.name,
          note: stateText + (platform.version ? ' · v' + platform.version : ''),
          span: platform.id === 'qq' ? 12 : (platformSpanById[platform.id] || 4),
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
      return card({ key: 'activity', title: '本地存储', note: '读取中', span: 12, children: [skeleton('stat', 3)] })
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

  // 账号情况（顶层）：只留登录状态、主人 QQ、总开关。
  // 发送到 / 图片在「聊天」栏（renderChatBridgeDetail），试运行在「设置」栏（renderTrialRow）。
  // 微信账号区：只读展示 dsh-wechat-plugin 的现状（插件 / 状态接口 / 通道 / 绑定 / 连接）。
  // 鱼世界不代管人格、不代持凭据、不实现协议；收发、扫码、绑定都在「设置 → 微信」。
  // 读不到就按后端给的 note 说清楚；未安装时直接给安装命令，别让人自己猜去哪装。
  function wechatAccountRows(platform, account) {
    var a = account || {}
    var rows = []
    var installed = a.installed === true
    var reachable = a.reachable
    var enabled = a.enabled
    var connected = a.connected
    var bound = Array.isArray(a.accounts) ? a.accounts : []

    rows.push(infoRow('插件', installed ? 'dsh-wechat-plugin' + (a.version ? ' ' + a.version : '') : '未安装',
      { level: installed ? 'ok' : 'warn' }))
    rows.push(infoRow('状态接口',
      reachable === true ? '可达' : (reachable === false ? '连不上' : '还没检查'),
      reachable === true ? { level: 'ok' } : (reachable === false ? { level: 'warn' } : { level: 'neutral' })))
    rows.push(infoRow('通道',
      enabled === true ? '已启用' : (enabled === false ? '已停用' : '未知'),
      enabled === true ? { level: 'ok' } : { level: 'neutral' }))
    rows.push(infoRow('绑定账号',
      bound.length ? bound.length + ' 个' : (installed ? '还没有绑定账号' : '—'),
      bound.length ? { level: 'ok' } : { level: 'neutral' }))
    // 有名字就列出来（虚拟号 / 昵称由插件给，鱼世界不改）；太长靠 row-value 的省略 + title。
    var names = bound.map(function (item) { return item && item.name }).filter(Boolean).join('、')
    if (names) rows.push(infoRow('账号', names))
    rows.push(infoRow('连接',
      connected === true ? '已连接' : (connected === false ? '未连接' : '未知'),
      connected === true ? { level: 'ok' } : (connected === false ? { level: 'warn' } : { level: 'neutral' })))
    if (a.lastError) rows.push(infoRow('最近错误', a.lastError, { level: 'warn' }))
    if (installed && a.note) rows.push(h('p', { class: 'fw-card-note', text: a.note }))

    // 明确入口：这一页只读，别让人以为面板能扫码或开关通道。
    rows.push(h('p', {
      class: 'fw-card-note',
      style: 'margin-top:var(--space-3)',
      text: '状态 / 扫码 / 绑定都在「设置 → 微信」里改；这里只读。',
    }))

    if (!installed) {
      rows.push(h('p', { class: 'fw-card-note', text: '安装：dsh plugin --profile desktop add dsh-wechat-plugin' }))
      rows.push(h('p', { class: 'fw-card-note', text: '装完重启 DSH，再回到这一页看状态。' }))
    }
    return rows
  }

  /**
   * B 站人设同步行：显示当前同步状态 + 一个「同步人设」按钮。
   * 状态由后端 biliPersonaSync.status() 现算（经 /platforms 一起带回来）：
   *  · null       = 没接上（模块不可用），如实写；
   *  · installed=false = 没装 dsh-bili-whale，无从同步；
   *  · sameAsCurrent   = 已同步（带多久之前）；
   *  · 其余       = 不同步，说明原因。
   */
  function biliPersonaRows(persona) {
    var rows = []
    var label = '人设（B 站）'
    if (!persona) {
      rows.push(infoRow(label, '状态未知（模块不可用）', { level: 'warn' }))
      return rows
    }
    if (!persona.installed) {
      rows.push(infoRow(label, '未同步：' + '未安装 dsh-bili-whale', { level: 'neutral' }))
      return rows
    }
    if (persona.sameAsCurrent) {
      rows.push(infoRow(label, '已同步（' + (persona.syncedAt ? shortTime(persona.syncedAt) : '刚刚') + '）', { level: 'ok' }))
    } else if (!persona.syncedAt) {
      rows.push(infoRow(label, '未同步', { level: 'warn' }))
    } else {
      rows.push(infoRow(label, '不同步：人设改过还没跟过去', { level: 'warn' }))
    }
    var busy = state.biliPersonaBusy === true
    rows.push(h('div', { class: 'fw-btn-row', style: 'margin-top:var(--space-2)' }, [
      ghostButton(busy ? '同步中…' : '同步人设', function () {
        if (state.biliPersonaBusy) return
        state.biliPersonaBusy = true
        render()
        postJSON('/dsh-fish-world/bili-persona', {})
          .then(function (r) {
            state.biliPersonaBusy = false
            if (r && r.ok === false) throw new Error(r.error || '同步失败')
            return loadPlatforms()
          })
          .catch(function (e) {
            state.biliPersonaBusy = false
            setError('platforms', '同步 B 站人设失败：' + e.message)
            render()
          })
      }),
    ]))
    return rows
  }

  function renderAccount(platform) {
    var account = platform.account || {}
    var rows = []

    // 微信：账号区只读展示 dsh-wechat-plugin，不走「由插件自行登录」那条通用文案。
    if (platform.id === 'wechat') return wechatAccountRows(platform, account)

    if (platform.id !== 'qq') {
      // B 站：账号来自 bili-whale 自己写下的 self（昵称 + mid），有就如实显示，没有就只说「还没登录」。
      // 模型 / 等级这类它没写进配置的东西不显示，不编造。
      if (account.loggedIn && account.account) {
        var biliWho = [account.account.nickname, account.account.userId && '(' + account.account.userId + ')']
          .filter(Boolean).join(' ')
        rows.push(infoRow('登录账号', biliWho || '已登录', { level: 'ok' }))
        if (account.source) rows.push(infoRow('账号来源', account.source))
      } else {
        rows.push(infoRow('账号', account.managed === false ? '由插件自行登录' : '—'))
      }
      // B 站人设同步：她在这边的人设卡有没有跟到 bili-whale 那边（同一份人格的最后一块）。
      // 返回的是**一组行**，要展开进去（当成单个子节点塞进 h() 会炸 appendChild）。
      if (platform.id === 'bili') rows.push.apply(rows, biliPersonaRows(account.persona))
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
          // 主人改了，「鱼的主人」卡和「鱼与 QQ」里的账号、聊天窗口都要跟着变，一次刷全。
          loadProfile()
          loadPlatforms()
          loadQQChat()
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

  // 聊天栏里的桥细项：发到哪、群号、目标会话、图片。
  // 这些原本堆在「设置」下，但「发到哪个群 / 私聊、收不收图」就是聊天本身的事，
  // 主人 2026-10-27 要求「群聊和私聊的设置都在聊天设置内」。
  function renderChatBridgeDetail(platform) {
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
    // 群目标不在这里配了：上面「聊天窗口」的允许名单就是干这个的（chats.json，可授权多个群/好友），
    // 桥自带的「转群 + 群号」是旧的单目标机制，和名单功能重复（主人 2026-10-29 指出）。
    // 面板只保留名单这一个入口；桥配置文件里的转群仍然有效，只是不再给第二个开关。
    rows.push(h('p', {
      class: 'fw-row-hint',
      text: '群 / 好友去上面「聊天窗口」授权（可多个）；这里只管桥自己那条私聊。',
    }))
    // 目标会话不用在这里重复显示：它由「鱼的设定 → 主人」改，两处看一个值才不会各说各话（主人 2026-10-29）。

    var images = []
    if (account.receiveImages) images.push('收图')
    if (account.sendImages) images.push('发图')
    rows.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
      h('h3', { class: 'fw-card-title', text: '图片' }),
      h('span', { class: 'fw-card-note', text: images.length ? images.join(' · ') + (account.maxImages ? '（最多 ' + account.maxImages + ' 张）' : '') : '双向关闭' }),
    ]))
    rows.push(bridgeToggle('收图', '别人发来的图存下来', '收图', account.receiveImages))
    rows.push(bridgeToggle('发图', '允许鱼发图给 QQ', '发图', account.sendImages))
    return rows
  }

  // 设置栏里的桥闸门：试运行（拨下去只记账、不真发）。
  function renderTrialRow(platform) {
    var account = platform.account || {}
    if (platform.id !== 'qq' || account.missing) return []
    return [bridgeSwitchRow('试运行', '试运行', account.trial, '只记账，不真发')]
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

  // 通用的内容抽屉：背景列表保留，内容由 build() 生成，render() 后自动重建。
  // 抽屉里有表单（端口、token、工具开关），所以不做蒙层关闭，只认「关闭」按钮和 Esc。
  var drawerRebuild = null

  function openDrawer(title, build) {
    if (closeActiveDrawer) closeActiveDrawer()
    var scrim = h('div', { class: 'fw-drawer-scrim' })
    var bodyBox = h('div', { class: 'fw-drawer-body' })
    function fill() {
      bodyBox.textContent = ''
      build().forEach(function (node) { bodyBox.appendChild(node) })
    }
    var drawer = h('div', { class: 'fw-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      h('div', { class: 'fw-drawer-head' }, [
        h('h3', { class: 'fw-card-title', text: title }),
        ghostButton('关闭', function () { close() }),
      ]),
      bodyBox,
    ])

    function onKeydown(event) {
      if (event.key === 'Escape') close()
    }

    function close() {
      document.removeEventListener('keydown', onKeydown)
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim)
      if (drawer.parentNode) drawer.parentNode.removeChild(drawer)
      if (closeActiveDrawer === close) closeActiveDrawer = null
      drawerRebuild = null
    }

    document.body.appendChild(scrim)
    document.body.appendChild(drawer)
    document.addEventListener('keydown', onKeydown)
    closeActiveDrawer = close
    drawerRebuild = fill
    fill()
  }

  // AstrBot 接入并入 QQ：卡片里只留一行摘要 + 入口，细节全在抽屉里。
  function openAstrbotDrawer() {
    openDrawer('AstrBot 接入', viewAstrbot)
    Promise.all([loadAstrbot(), loadQQAgent()])
  }

  function astrbotEntry() {
    var data = state.astrbot
    var text = !data ? '读取中…' : (data.transport === 'astrbot' ? '经由 AstrBot' : '直连协议端')
    return h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: 'AstrBot 接入' }),
      h('span', { class: 'fw-row-value', text: text }),
      ghostButton('打开', function () { openAstrbotDrawer() }),
    ])
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

    // ---- 通道：直连 / 经由 AstrBot 二选一，做成切换，不再并排两张卡 ----
    var snowStatus = statusLine('')
    var transportTab = h('div', { class: 'fw-tabs', role: 'tablist', 'aria-label': 'QQ 走哪条通道' }, [
      tabItem('直连协议端', !viaBot, function () { if (viaBot && !busy) switchTo('snowluma', snowStatus) }),
      tabItem('经由 AstrBot', viaBot, function () { if (!viaBot && !busy && data && data.active) switchTo('astrbot', snowStatus) }),
    ])
    var snowCard = {
      key: 'astrbot-snowluma',
      title: 'SnowLuma 直连',
      note: viaBot ? '未使用' : '当前在用',
      span: 6,
      children: [
        // switchTo 会 render()，状态行要在重建后仍显示，所以先放一个持久的状态位
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
    }

    // ---- 经由 AstrBot：只在切到这个通道时显示 ----
    var botBody = []
    if (!viaBot) {
      botBody.push(h('p', { class: 'fw-card-note', text: '还没切到这条路。上面的切换只改「走哪条通道」；先「一键接入」连通，再切过来。' }))
    } else if (blocked) {
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

    var botCard = {
      key: 'astrbot',
      title: '经由 AstrBot',
      note: viaBot ? '当前在用' : '备选走法',
      span: 6,
      children: botBody,
    }

    // 两个通道合成一张卡：顶部切换决定「QQ 从哪条路收发」，下面只显示当前那条。
    var channelCard = card({
      key: 'astrbot-channel',
      title: 'QQ 通道',
      note: viaBot ? '经由 AstrBot' : '直连协议端',
      span: 12,
      children: [
        transportTab,
        h('div', { class: 'fw-card-body' }, viaBot ? botCard.children : snowCard.children),
      ],
    })

    return [
      channelCard,
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
    var infoChildren = []
    var roleChildren = []
    var ownerChildren = []
    // 人设编辑（预设 + 长文本框）单独一张通栏卡：编辑长文本要整行宽度，
    // 也不再把这列撑高、在并排的另两张旁边空一大片。
    var personaChildren = []

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

      // 角色卡的增删改：全部走 /fish/roles，成功后重读 profile 让面板立即反映。
      function roleAction(body, statusText) {
        return postJSON('/dsh-fish-world/fish/roles', body)
          .then(function (r) {
            if (!r || r.ok === false) throw new Error((r && r.error) || '操作失败')
            delete state.errors.profile
            return loadProfile()
          })
          .catch(function (e) {
            state.errors.profile = (statusText || '角色操作') + '失败：' + e.message
            render()
          })
      }

      function buildRoleCards() {
        roleCards.textContent = ''
        var options = [{ id: 'auto', name: '跟随挂件', hint: '置顶或最新的角色', pinned: false }]
          .concat(roles.map(function (role) {
            return { id: role.id, name: role.name || role.id, hint: role.id, pinned: role.pinned === true, real: true }
          }))
        options.forEach(function (option) {
          var active = selectedRole === option.id
          var block = h('div', {
            class: 'fw-role-card',
            dataset: { selected: active ? 'true' : 'false' },
          }, [
            h('button', {
              class: 'fw-role-pick',
              type: 'button',
              role: 'radio',
              'aria-checked': active ? 'true' : 'false',
              title: '选这个角色卡',
            }, [
              h('span', { class: 'fw-role-name', text: option.name }),
              h('span', { class: 'fw-role-hint', text: option.hint }),
              option.pinned ? h('span', { class: 'fw-badge', text: '置顶' }) : null,
              active ? h('span', { class: 'fw-badge', dataset: { tone: 'success' }, text: '使用中' }) : null,
            ]),
            // 真实角色才有这些操作：「跟随挂件」是虚拟项，不能删也不能换图。
            option.real ? h('div', { class: 'fw-role-actions' }, [
              ghostButton('编辑', function () { openRoleEditor(option) }),
              ghostButton('换图', function () { pickRoleImage(option.id) }),
              ghostButton(option.pinned ? '取消置顶' : '置顶', function () {
                roleAction({ action: 'pin', id: option.id, pinned: !option.pinned }, '置顶')
              }),
              ghostButton('删除', function () {
                if (!window.confirm('删除角色卡「' + option.name + '」？它的图和设定会一起删掉，找不回来。')) return
                roleAction({ action: 'remove', id: option.id }, '删除')
              }),
            ]) : null,
          ])
          block.querySelector('.fw-role-pick').addEventListener('click', function () {
            selectedRole = option.id
            roleSelect.value = option.id
            buildRoleCards()
            refreshPreview()
          })
          roleCards.appendChild(block)
        })
      }

      // ---- 编辑角色卡正文：卡上直接改这张卡的人设卡 ----
      // 以前只有下面整栏那张「角色人设卡」，而且固定读写「当前角色」——
      // 站在某张卡前面想改它的内容，根本找不到入口（主人 2026-10-27 反馈）。
      // 这里给每张真卡配一个编辑层：按这张卡的 id 取/存人设文本，不动「当前在用」
      // 这件事 —— 编辑不等于启用，切角色还是走「保存角色」。
      function byteSize(text) {
        try { return new TextEncoder().encode(String(text || '')).length } catch { return String(text || '').length }
      }

      function openRoleEditor(role) {
        if (state.roleEditorOpen) return
        state.roleEditorOpen = true
        var roleId = String(role.id)
        var usedId = fish.persona && fish.persona !== 'auto'
          ? String(fish.persona)
          : String((data.current && data.current.id) || 'default')
        var title = h('div', {
          class: 'fw-role-editor-title',
          text: '编辑「' + (role.name || roleId) + '」的人设卡',
        })
        var meta = h('div', { class: 'fw-role-editor-meta', text: '读取中…' })
        var area = h('textarea', {
          class: 'fw-input fw-role-editor-area',
          'aria-label': '角色人设卡正文',
          placeholder: '这张角色卡的人设文本：说话方式、性格、语料…',
          spellcheck: 'false',
        })
        area.disabled = true
        var status = statusLine('')
        var saving = false
        var closeBtn = ghostButton('关闭', function () { close() })
        var saveBtn = button('保存', function () { save() }, 'primary')
        saveBtn.disabled = true
        var layer = h('div', {
          class: 'fw-role-editor-layer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '编辑角色卡',
        }, [
          h('div', { class: 'fw-role-editor' }, [
            title,
            meta,
            area,
            h('div', { class: 'fw-role-editor-actions' }, [status, closeBtn, saveBtn]),
          ]),
        ])

        function markMeta() {
          var bytes = byteSize(area.value)
          meta.textContent = bytes + ' 字节 · ' + (roleId === usedId
            ? '当前正在用这张卡，保存后下一轮生效'
            : '这张卡还没启用，切过去才生效')
        }

        function close() {
          document.removeEventListener('keydown', onKey)
          document.documentElement.style.overflow = ''
          state.roleEditorOpen = false
          layer.remove()
        }

        function onKey(event) {
          if (event.key === 'Escape') close()
        }

        function save() {
          if (saving) return
          var text = String(area.value || '')
          if (!text.trim()) {
            status.textContent = '人设卡不能是空的'
            status.dataset.tone = 'error'
            return
          }
          saving = true
          status.textContent = '保存中…'
          status.dataset.tone = ''
          postJSON('/dsh-fish-world/fish/persona', { roleId: roleId, text: text }).then(function (r) {
            if (!r || r.ok === false) throw new Error((r && r.error) || '保存失败')
            status.textContent = '已保存，' + (roleId === usedId ? '下一轮对话生效' : '切到这张卡后生效')
            status.dataset.tone = 'success'
            markMeta()
            // 整栏那张「角色人设卡」若正显示同一张，跟着改，免得两处看到两份内容。
            if (personaArea && persona.roleId && String(persona.roleId) === roleId) {
              personaArea.value = text
              personaStatus.textContent = '当前 ' + byteSize(text) + ' 字节'
              personaStatus.dataset.tone = 'success'
            }
            state.persona = Object.assign({}, state.persona || {}, {
              roleId: roleId,
              text: text,
              bytes: byteSize(text),
            })
          }, function (e) {
            status.textContent = '保存失败：' + e.message
            status.dataset.tone = 'error'
          }).then(function () { saving = false })
        }

        getJSON('/dsh-fish-world/fish/persona?role=' + encodeURIComponent(roleId)).then(function (d) {
          if (!d || d.ok === false) throw new Error((d && d.error) || '读取失败')
          area.value = d.text || ''
          area.disabled = false
          saveBtn.disabled = false
          markMeta()
          area.focus()
          area.scrollTop = 0
        }, function (e) {
          meta.textContent = '读取失败：' + e.message + '（关掉重开一次）'
        })

        layer.addEventListener('click', function (event) {
          if (event.target === layer) close()
        })
        document.addEventListener('keydown', onKey)
        document.documentElement.style.overflow = 'hidden'
        document.body.appendChild(layer)
      }

      // 换图：选本地图片 → 读成 dataUrl → 交给后端存（格式按文件头判定）。
      function pickRoleImage(id) {
        var input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/png,image/jpeg,image/gif,image/webp'
        input.style.display = 'none'
        input.addEventListener('change', function () {
          var file = input.files && input.files[0]
          if (!file) return
          var reader = new FileReader()
          reader.onload = function () {
            roleAction({ action: 'image', id: id, dataUrl: String(reader.result || '') }, '换图')
          }
          reader.onerror = function () {
            state.errors.profile = '读取图片失败'
            render()
          }
          reader.readAsDataURL(file)
          document.body.removeChild(input)
        })
        document.body.appendChild(input)
        input.click()
      }

      // 新建角色卡：一行输入组，输入框吃掉剩余宽度、按钮与它等高（原生的 flex:1 包法
      // 会让输入框和按钮一高一矮，看起来像没对齐）。
      var newRoleName = h('input', {
        class: 'fw-input',
        type: 'text',
        placeholder: '新角色卡的名字',
        'aria-label': '新角色卡的名字',
      })
      var createRoleBtn = ghostButton('新建角色卡', function () {
        var name = String(newRoleName.value || '').trim()
        if (!name) {
          state.errors.profile = '先给新角色卡起个名字'
          render()
          return
        }
        newRoleName.value = ''
        roleAction({ action: 'create', name: name }, '新建角色卡')
      })

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

      // 信息与角色各存各的：只提交自己这一卡的字段，别的卡不被顺手覆盖。
      function saveProfile(patch, status, okText) {
        status.textContent = '保存中…'
        postJSON('/dsh-fish-world/fish/profile', patch).then(function (r) {
          if (r && r.ok) {
            status.textContent = okText
            status.dataset.tone = 'success'
            state.profile = Object.assign({}, data, { fish: r.fish, current: r.current })
            loadProfile()
          } else {
            status.textContent = '保存失败：' + (r && r.error || '未知错误')
            status.dataset.tone = 'error'
          }
        }).catch(function (e) {
          status.textContent = '保存失败：' + e.message
          status.dataset.tone = 'error'
        })
      }

      var saveStatus = statusLine('')
      var saveBtn = button('保存信息', function () {
        saveProfile({
          name: String(nameInput.value || '').trim(),
          ownerTitle: String(ownerInput.value || '').trim() || '主人',
        }, saveStatus, '已保存，主界面名称与称呼会随之更新。')
      }, 'primary')

      var roleStatus = statusLine('')
      var roleSaveBtn = button('保存角色', function () {
        saveProfile({ persona: selectedRole }, roleStatus, '已保存，主界面的角色会随之更新。')
      }, 'primary')

      // 三张卡：鱼的信息（名字、称呼）、鱼的角色（外显角色卡）、鱼的主人（主人 QQ + 会话）。
      // 卡宽了，字段两列并排，别一列堆着又高又空。
      infoChildren.push(h('div', { class: 'fw-form-grid' }, [
        h('div', { class: 'fw-field' }, [
          h('label', { class: 'fw-field-label', text: '鱼的名字' }),
          nameInput,
          h('span', { class: 'fw-row-hint', text: '改完之后，面板与提示词里都用这个名字。' }),
        ]),
        h('div', { class: 'fw-field' }, [
          h('label', { class: 'fw-field-label', text: '它怎么称呼你' }),
          ownerInput,
        ]),
        h('div', { class: 'fw-row fw-span-full' }, [previewName]),
        h('div', { class: 'fw-btn-row fw-span-full' }, [saveBtn]),
        h('div', { class: 'fw-span-full' }, [saveStatus]),
      ]))

      roleChildren.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '外显角色卡' }),
        roleCards,
        h('span', { class: 'fw-row-hint', text: roles.length ? '点一张选中，再点「保存角色」生效；编辑 / 换图 / 置顶 / 删除在旁边。' : '还没有角色卡：在下面起个名字就能建一张。' }),
      ]))
      roleChildren.push(h('div', { class: 'fw-row fw-input-group' }, [
        newRoleName,
        createRoleBtn,
      ]))
      roleChildren.push(h('div', { class: 'fw-btn-row' }, [roleSaveBtn]))
      roleChildren.push(roleStatus)

      // ---- 当前角色卡：现在实际在用的是哪一张（图 + 名字 + 置顶标记） ----
      var currentRole = data.current || null
      var currentDetail = currentRole
        ? (roles.find(function (r) { return r.id === currentRole.id }) || {})
        : {}
      var usedRoleId = fish.persona && fish.persona !== 'auto' ? fish.persona : (currentRole && currentRole.id) || 'default'
      // 没图的角色请求会 404：换成内联灰色线性人形，不显示、也不隐藏成空缺（禁原生裂图）。
      var roleImg = h('img', {
        class: 'fw-role-current-img',
        src: '/dsh-fish-world/role-image?id=' + encodeURIComponent(usedRoleId),
        alt: '',
      })
      roleImg.addEventListener('error', function () {
        if (!roleImg.parentNode) return
        roleImg.parentNode.replaceChild(userIconSvg(), roleImg)
      })
      var currentBox = h('div', { class: 'fw-role-current' }, [
        roleImg,
        h('div', { class: 'fw-role-current-meta' }, [
          h('span', { class: 'fw-role-current-name', text: (currentRole && (currentRole.displayName || currentRole.name)) || usedRoleId }),
          h('span', { class: 'fw-role-current-hint', text: fish.persona && fish.persona !== 'auto' ? '手动指定 · ' + usedRoleId : '跟随挂件 · ' + usedRoleId }),
          currentDetail.pinned || (currentRole && currentRole.pinned) ? h('span', { class: 'fw-badge', text: '置顶' }) : null,
        ]),
      ])
      infoChildren.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '当前角色卡' }),
        currentBox,
      ]))

      // ---- 鱼的主人：谁是你的主人、它的数据放进哪一间会话（保存后同步到「鱼与 QQ」） ----
      ownerChildren = ownerBindingBody(data)

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
      }, 'ghost') // 主按钮只留给「保存信息 / 保存角色」，同一张卡里第三个保存降级为幽灵
      function personalValue() {
        return String(personaArea.value || '')
      }

      // ---- 内置预设：点一下把正文填进输入框，保存后才生效 ----
      var presets = persona.presets || []
      var presetHint = h('p', {
        class: 'fw-card-note',
        text: presets.length ? '内置预设：点一下填进下面，保存后才生效。' : '没有内置预设。',
      })
      personaChildren.push(h('div', { class: 'fw-field' }, [
        h('label', { class: 'fw-field-label', text: '预设角色卡' }),
        presetHint,
      ]))
      if (presets.length) {
        personaChildren.push(h('div', { class: 'fw-btn-row' }, presets.map(function (p) {
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

      personaChildren.push(h('div', { class: 'fw-field', style: 'margin-top:var(--space-4)' }, [
        h('label', { class: 'fw-field-label', text: '角色人设卡' }),
        personaArea,
        h('span', { class: 'fw-row-hint', text: '加载后会作为「角色人设卡」注入提示词，决定它怎么说话。按当前角色保存。' }),
      ]))
      personaChildren.push(h('div', { class: 'fw-btn-row' }, [personaSave]))
      personaChildren.push(personaStatus)
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

    var profileCards = (state.errors.profile || !data)
      ? [card({ key: 'fish-info', title: '鱼的信息', note: '名字与称呼', span: 4, children: children })]
      : [
        // 概览：三张卡各一项摘要，点一下跳到下面那张（同一页内）。
        card({
          key: 'fish-summary',
          title: '鱼的设定',
          note: '点一项跳到对应卡片',
          span: 8,
          children: [h('div', { class: 'fw-mini-grid' }, [
            miniCard({
              label: '名字与称呼',
              value: String(fish.name || '').trim() || '鱼',
              sub: '称呼：' + (String(fish.ownerTitle || '').trim() || '主人'),
              jump: 'fish-info',
            }),
            miniCard({
              label: '角色卡',
              value: (currentRole && (currentRole.displayName || currentRole.name)) || usedRoleId,
              sub: fish.persona && fish.persona !== 'auto' ? '手动指定' : '跟随挂件',
              jump: 'fish-role',
            }),
            miniCard({
              label: '主人',
              value: (data.owner && data.owner.qq && data.owner.qq.bridge) || '还没填',
              sub: (data.owner && data.owner.session && data.owner.session.bridge) ? '会话已绑' : '会话未绑',
              tone: data.owner && data.owner.qqAgree === false ? 'warn' : '',
              jump: 'fish-owner',
            }),
          ])],
        }),
        // 右边说明卡：这三件事分别影响什么，不用滑到下面才知道。
        card({
          key: 'fish-rules',
          title: '规则',
          note: '改完要点保存',
          span: 4,
          children: [
            h('p', { class: 'fw-card-note', text: '名字与称呼改了，面板和提示词一起换；角色卡按当前角色保存，下一轮对话生效。' }),
            h('p', { class: 'fw-card-note', text: '主人以 QQ 桥的「私聊 QQ 号 / 目标会话」为准，保存后会同步到「鱼与 QQ」。' }),
          ],
        }),
        // 横放：鱼的信息 + 鱼的角色 并排各 6 列（同行等高），鱼的主人通栏、字段两列铺开。
        // 以前三张 4 列并排、各按内容高度排，短的那两张旁边就空出一大片（主人 2026-10-27 截图）。
        // 这里不用 group：A/B 并排、C 通栏，本来就是自然的一行梯队，编组反而会把 C 顶到前面。
        card({ key: 'fish-info', title: '鱼的信息', note: '名字与称呼', span: 6, children: infoChildren }),
        card({ key: 'fish-role', title: '鱼的角色', note: '外显角色卡', span: 6, children: roleChildren }),
        card({ key: 'fish-owner', title: '鱼的主人', note: '主人 QQ 与主人会话', span: 12, children: ownerChildren }),
      ]
    // 人设编辑：整行宽，编辑长文本不用在小列里挤。
    if (personaChildren.length) {
      profileCards.push(card({
        key: 'fish-persona',
        title: '角色人设卡',
        note: (state.persona && state.persona.bytes) ? state.persona.bytes + ' 字节' : '按当前角色保存',
        span: 12,
        children: personaChildren,
      }))
    }
    return profileCards.concat([
      card({ key: 'storage', title: '存储位置', note: storageInfo && storageInfo.bound ? '跟随工作区' : '默认位置', span: 12, children: storageBody }),
    ])
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
            + (overflow ? ';background:var(--feedback-error)' : ''),
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
    // 知识库 = 你写的内容（谁认得哪些梗/外观/约定），索引 = 用它算出来的向量缓存。
    // 两者不是一回事：索引可以随便重建，知识库要你自己写。卡片上把这句话说清楚。
    body.push(h('p', { class: 'fw-card-note', text: '知识库是你写的内容（梗、外观、约定）；索引是机器按这些内容算出的快速查找表，删了能重建，内容本身不在这里改。' }))
    body.push(infoRow('条目', k.items == null ? '—' : String(k.items) + ' 条'))
    // 位置只写相对目录：绝对路径在「鱼的设定 → 存储位置」已经写过一次。
    body.push(infoRow('位置', k.folder ? relPath(k.folder, state.storage && state.storage.root) : '—'))
    body.push(infoRow('索引', k.index
      ? (k.index.model || '未知模型') + ' · ' + (k.index.dim || 0) + ' 维' + (k.indexFresh ? ' · 最新' : ' · 要重建')
      : '还没有'))
    if (!k.indexFresh && k.indexWhy) body.push(statusLine(k.indexWhy))

    // 一条内容都没有时，「建立索引」无从下手：先说清楚要先做什么，
    // 别让人对着一个按了没反应的按钮猜。
    var emptyKb = !k.items
    if (emptyKb) {
      body.push(statusLine('知识库还是空的：先往记忆目录里写 知识库.json 或 知识库.md，再来建索引。', 'warn'))
    }

    var cfg = k.config || {}
    var mode = cfg.mode || 'off'

    // 所有知识库设置都从这里落盘，失败就留在卡片上，不静默吞掉。
    function saveKnowledge(patch) {
      return postJSON('/dsh-fish-world/world/knowledge', patch)
        .then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || '保存失败')
          delete state.errors.knowledge
          return loadKnowledge()
        })
        .catch(function (e) { state.errors.knowledge = e.message; render() })
    }

    function textRow(label, value, placeholder, onSave) {
      var input = h('input', { class: 'fw-input', type: 'text', value: value, placeholder: placeholder, 'aria-label': label })
      input.addEventListener('change', function () { onSave(input.value.trim()) })
      return h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: label }),
        h('span', { style: 'width:240px;flex:none' }, [input]),
      ])
    }

    // 后端选择：选哪个，下面只显示那个的参数。enabled 跟着后端走，不再有单独的开关。
    var modeSelect = h('select', { class: 'fw-input', 'aria-label': '向量后端' }, [
      h('option', { value: 'off', selected: mode === 'off', text: '关闭（只按字面匹配）' }),
      h('option', { value: 'local', selected: mode === 'local', text: '本机小模型（' + (cfg.localModel || 'bge-small-zh') + '）' }),
      h('option', { value: 'openai', selected: mode === 'openai', text: '远程（OpenAI 兼容接口）' }),
      h('option', { value: 'file', selected: mode === 'file', text: '向量文件（预先算好的）' }),
    ])
    modeSelect.addEventListener('change', function () {
      saveKnowledge({ mode: modeSelect.value, enabled: modeSelect.value !== 'off' })
    })
    body.push(h('div', { class: 'fw-row' }, [
      h('span', { class: 'fw-row-label', text: '向量后端' }),
      h('span', { style: 'width:240px;flex:none' }, [modeSelect]),
    ]))
    var modeHints = {
      off: '关着就只按字面匹配，不用向量。',
      local: '在本机用小模型算相似度，不联网、不要 key。第一次使用会下载约 24MB 模型，之后离线可用。',
      openai: '调用一个 OpenAI 兼容的 /embeddings 接口。本机地址直接用；非本机地址必须是 https。',
      file: '读取一份预先算好的向量文件（填绝对路径）。',
    }
    body.push(h('p', { class: 'fw-card-note', text: modeHints[mode] || '' }))

    if (mode === 'openai') {
      body.push(textRow('接口地址', cfg.baseUrl || '', 'http://127.0.0.1:8080/v1', function (v) { saveKnowledge({ baseUrl: v }) }))
      body.push(textRow('模型名', cfg.model || '', 'bge-m3 / text-embedding-3-small', function (v) { saveKnowledge({ model: v }) }))
      // key 只显示「已保存 / 未设置」，不回显内容；留空保存 = 不改。
      var keyInput = h('input', {
        class: 'fw-input',
        type: 'password',
        autocomplete: 'off',
        placeholder: k.hasKey ? '已保存（留空不改）' : '未设置，填入后保存',
        'aria-label': 'API key',
      })
      keyInput.addEventListener('change', function () {
        var value = keyInput.value.trim()
        if (value) saveKnowledge({ apiKey: value })
      })
      var keyRow = [
        h('span', { class: 'fw-row-label', text: 'API key' }),
        h('span', { style: 'width:240px;flex:none' }, [keyInput]),
      ]
      if (k.hasKey) keyRow.push(ghostButton('清除 key', function () { saveKnowledge({ apiKey: null }) }))
      body.push(h('div', { class: 'fw-row' }, keyRow))
    }

    if (mode === 'file') {
      body.push(textRow('向量文件', cfg.vectorsFile || '', 'D:\\…\\vectors.json', function (v) { saveKnowledge({ vectorsFile: v }) }))
    }

    // 配置上的问题直接列在卡片上（比如「开着但没选后端」「远程缺 key」）。
    ;(k.problems || []).forEach(function (text) { body.push(statusLine(text, 'warn')) })
    if (mode !== 'off' && !(k.problems || []).length) body.push(statusLine('后端已就绪', 'success'))
    // 索引三个动作：检查（只读，不建）→ 更新（按需，新的就不动）→ 重建（强制重算）。
    // 以前只有一个「重建索引」，想确认状态也只能硬建一遍，既慢又没必要。
    // 建索引可能跑几十秒（本机模型首次还要下模型），所以：按钮期间禁用 + 写明正在做什么，
    // 结果（成功/失败）留在卡片上，不会「点了没反应」。
    var indexStatus = state.knowledgeIndexMsg || null
    var indexBusy = Boolean(state.knowledgeIndexBusy)
    body.push(h('div', { class: 'fw-card-head', style: 'margin-top:var(--space-3)' }, [
      h('h3', { class: 'fw-card-title', text: '索引' }),
      h('span', { class: 'fw-card-note', text: '只影响向量档，字面档不需要' }),
    ]))
    function indexAction(action, busyText) {
      if (state.knowledgeIndexBusy) return
      state.knowledgeIndexBusy = true
      state.knowledgeIndexMsg = { text: busyText, tone: '' }
      render()
      return postJSON('/dsh-fish-world/world/knowledge', { action: action })
        .then(function (r) {
          if (!r || r.ok === false) throw new Error((r && r.error) || '操作失败')
          var text
          if (action === 'check') text = r.fresh ? '索引是最新的，不用重建。' : ('需要重建：' + (r.reason || '原因未知'))
          else if (action === 'update') text = r.rebuilt ? '索引已更新。' : '索引本来就是最新的，没有重建。'
          else text = '已重建索引：' + ((r.items != null) ? r.items + ' 条' : '完成')
          state.knowledgeIndexMsg = { text: text, tone: (action === 'check' && r.fresh === false) ? 'warn' : 'success' }
          return loadKnowledge()
        })
        .catch(function (e) {
          state.knowledgeIndexMsg = { text: '操作失败：' + e.message, tone: 'error' }
        })
        .then(function () {
          state.knowledgeIndexBusy = false
          render()
        })
    }
    var indexButtons = [
      ['检查索引', 'check', '正在检查索引…'],
      ['更新索引', 'update', '正在更新索引，可能要一会儿…'],
      ['重建索引', 'rebuild', '正在重建索引，可能要一会儿…'],
    ].map(function (item) {
      var b = ghostButton(indexBusy ? item[0] + '（进行中）' : item[0], function () {
        indexAction(item[1], item[2])
      })
      if (indexBusy) b.disabled = true
      return b
    })
    body.push(h('div', { class: 'fw-btn-row', style: 'margin-top:0' }, indexButtons))
    if (indexBusy) body.push(statusLine((indexStatus && indexStatus.text) || '正在处理…'))
    else if (indexStatus) body.push(statusLine(indexStatus.text, indexStatus.tone))

    return body
  }

  /**
   * 「图片整理」卡的正文（视觉接口配置 + 全库整理）。
   * 这段原来长在知识库卡片尾部；「鱼的记忆」页把四块拆成四张卡，
   * 所以抽成独立函数，知识库卡只留知识库本身（装配见 viewMemory）。
   */
  function stickerVisionChildren() {
    var body = []
    var vis = state.stickerVision
    var visMsg = state.stickerVisionMsg || null
    var organizeBusy = Boolean(state.stickerOrganizeBusy)
    // 卡片标题已经叫「图片整理」，正文里不再重复一个小标题
    if (state.errors.stickerVision) {
      body.push(statusLine('读取失败：' + state.errors.stickerVision, 'error'))
    } else if (!vis) {
      body.push(statusLine('读取中…'))
    } else {
      body.push(h('p', {
        class: 'fw-card-note',
        text: '用一个兼容 OpenAI 的视觉接口看图。没配好时收藏照旧只存图，不会动任何数据。',
      }))
      body.push(infoRow('接口', vis.config && vis.config.baseUrl ? vis.config.baseUrl : '还没填'))
      body.push(infoRow('模型', vis.config && vis.config.model ? vis.config.model : '还没填'))
      body.push(infoRow('密钥', vis.hasKey ? ('已保存' + (vis.keySource === 'env' ? '（环境变量）' : '')) : '还没填'))
      body.push(statusLine(vis.ready ? '整理可用' : ('还不能整理：' + (vis.reason || '未就绪')), vis.ready ? 'success' : 'warn'))

      // 三个输入：地址 / 模型 / 密钥。密钥只写不读，接口永远不回明文。
      function visionSave(patch, apiKey) {
        var payload = { patch: patch }
        if (apiKey !== undefined) payload.apiKey = apiKey
        return postJSON('/dsh-fish-world/stickers/vision', payload)
          .then(function (r) {
            if (r && r.ok === false) throw new Error(r.error || '保存失败')
            state.stickerVision = r
            delete state.errors.stickerVision
            render()
          })
          .catch(function (e) { state.errors.stickerVision = e.message; render() })
      }
      function visionInput(label, key, value, placeholder, secret) {
        var input = h('input', {
          class: 'fw-input',
          type: secret ? 'password' : 'text',
          value: secret ? '' : (value || ''),
          placeholder: placeholder,
          'aria-label': label,
          autocomplete: 'off',
        })
        input.addEventListener('change', function () {
          var text = input.value.trim()
          if (secret) {
            if (!text) return
            visionSave({}, text).then(function () { input.value = '' })
            return
          }
          var patch = {}
          patch[key] = text
          visionSave(patch)
        })
        return h('div', { class: 'fw-row' }, [
          h('span', { class: 'fw-row-label', text: label }),
          h('span', { style: 'width:240px;flex:none' }, [input]),
        ])
      }
      body.push(visionInput('接口地址', 'baseUrl', vis.config && vis.config.baseUrl, 'https://…/v1', false))
      body.push(visionInput('模型名', 'model', vis.config && vis.config.model, '支持图片输入的模型', false))
      body.push(visionInput('API key', 'apiKey', '', vis.hasKey ? '已保存（留空不改）' : '粘贴后回车保存', true))

      // 开关：iOS 药丸形，只有开着才真的整理。
      var visSwitch = h('input', {
        type: 'checkbox',
        class: 'fw-switch-input',
        'aria-label': '启用图片整理',
      })
      visSwitch.checked = Boolean(vis.config && vis.config.enabled)
      visSwitch.addEventListener('change', function () {
        visionSave({ enabled: visSwitch.checked })
      })
      body.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label', text: '启用整理' }),
        h('label', { class: 'fw-switch' }, [visSwitch, h('span', { class: 'fw-switch-track' })]),
      ]))

      // 全库整理：一次把所有图跑一遍，结果留一句话在卡片上。
      var allBtn = ghostButton(organizeBusy ? '正在整理全部…' : '整理全部图片', function () {
        if (state.stickerOrganizeBusy) return
        state.stickerOrganizeBusy = true
        state.stickerVisionMsg = { text: '正在整理全部图片，可能要一会儿…', tone: '' }
        render()
        postJSON('/dsh-fish-world/stickers/organize-all', {})
          .then(function (r) {
            if (!r || r.ok === false) throw new Error((r && r.error) || '整理失败')
            state.stickerVisionMsg = {
              text: '整理完成：成功 ' + r.done + ' 张' + (r.failed ? ('，失败 ' + r.failed + ' 张') : '') + '（共 ' + r.total + ' 张）',
              tone: r.failed ? 'warn' : 'success',
            }
            return loadStickers()
          })
          .catch(function (e) {
            state.stickerVisionMsg = { text: '整理失败：' + e.message, tone: 'error' }
          })
          .then(function () {
            state.stickerOrganizeBusy = false
            render()
          })
      })
      if (organizeBusy || !vis.ready) allBtn.disabled = true
      body.push(h('div', { class: 'fw-btn-row', style: 'margin-top:var(--space-3)' }, [allBtn]))
      if (visMsg) body.push(statusLine(visMsg.text, visMsg.tone))
    }
    return body
  }

  // ---------- 养鱼花费（dsh-cost-meter 的只读裁剪） ----------
  // 后端只给 today / month / total 三个聚合桶 + byModel 前 5，面板照抄，不自己算。
  // 金额是上游的计价单位，面板不做汇率换算，所以不额外加币种符号。
  function moneyText(value) {
    var n = Number(value)
    if (!Number.isFinite(n)) return '—'
    return n.toFixed(2)
  }

  function costChildren() {
    var body = []
    var data = state.cost
    if (state.errors.cost) {
      body.push(statusLine('读取失败：' + state.errors.cost, 'error'))
      return body
    }
    if (!data) {
      body.push(skeleton('stat', 3))
      return body
    }
    // ok:false = 上游没装或读数失败。照它说的写，绝不画一串 0 冒充「今天没花钱」（底线③）。
    if (data.ok === false) {
      body.push(statusLine(data.error || '养鱼花费读不到', 'warn'))
      body.push(h('p', {
        class: 'fw-row-hint',
        text: '这张卡只读 dsh-cost-meter 的数；没装它就没有数字可显示。',
      }))
      return body
    }
    var cost = data.cost || {}
    var today = cost.today || {}
    var month = cost.month || {}
    var total = cost.total || {}
    var withCalls = function (bucket) {
      var calls = Number(bucket.calls || 0)
      return moneyText(bucket.cost) + (calls ? ' · ' + calls + ' 次' : '')
    }
    body.push(numRow('今日花费', withCalls(today)))
    body.push(numRow('本月花费', withCalls(month)))
    body.push(numRow('累计花费', withCalls(total)))

    var models = Array.isArray(cost.byModel) ? cost.byModel.slice(0, 5) : []
    if (models.length) {
      body.push(h('div', { class: 'fw-divider' }))
      body.push(h('p', { class: 'fw-field-label', text: '按模型（花费前 5）' }))
      models.forEach(function (item) {
        body.push(infoRow(
          String(item.model || '未命名模型'),
          moneyText(item.cost) + (Number(item.calls || 0) ? ' · ' + item.calls + ' 次' : ''),
        ))
      })
    } else {
      body.push(h('p', { class: 'fw-row-hint', text: '还没有按模型的调用记录。' }))
    }
    body.push(h('p', {
      class: 'fw-card-note',
      text: '数字照抄 dsh-cost-meter，面板不做换算；它没装时这里只写「未安装」。',
    }))
    return body
  }

  // ---------- 鱼主动开口（dsh-speak-up 的只读配置） ----------
  // 配置里有没有这个键：没有就不画那一行，不拿 undefined 顶上去（底线③）。
  function speakUpHas(cfg, key) {
    return Object.prototype.hasOwnProperty.call(cfg, key)
  }

  function speakUpChildren() {
    var body = []
    var data = state.speakUp
    if (state.errors.speakUp) {
      body.push(statusLine('读取失败：' + state.errors.speakUp, 'error'))
      return body
    }
    if (!data) {
      body.push(skeleton('rows', 4))
      return body
    }
    if (data.installed === false || data.ok === false) {
      body.push(statusLine(data.error || '未安装 dsh-speak-up', 'warn'))
      body.push(h('p', {
        class: 'fw-row-hint',
        text: '装上 dsh-speak-up 之后，这里会显示它的开关、间隔与安静时段。',
      }))
      return body
    }
    var cfg = data.config || {}
    var master = cfg['总开关'] === true
    var trial = cfg['试运行'] === true
    body.push(infoRow('总开关', master ? '开' : '关', { level: master ? 'ok' : 'neutral' }))
    body.push(infoRow('试运行', trial ? '是（只记不发）' : '否'))
    if (speakUpHas(cfg, '间隔分钟')) body.push(infoRow('最短间隔', String(cfg['间隔分钟']) + ' 分钟'))
    if (Array.isArray(cfg['目标会话'])) {
      var targets = cfg['目标会话']
      body.push(infoRow('目标会话', targets.length ? targets.length + ' 个' : '没有设置', {
        level: targets.length ? '' : 'warn',
      }))
      if (targets.length) {
        body.push(h('p', {
          class: 'fw-row-hint',
          text: targets.slice(0, 4).map(function (id) { return String(id) }).join('、')
            + (targets.length > 4 ? ' 等 ' + targets.length + ' 个' : ''),
        }))
      }
    }
    if (speakUpHas(cfg, '安静起') && speakUpHas(cfg, '安静止')) {
      body.push(infoRow('安静时段', String(cfg['安静起']) + ' — ' + String(cfg['安静止'])))
    }
    body.push(h('p', {
      class: 'fw-card-note',
      text: '主动搭话走 DSH 自己的回合；要推到 QQ，得在 QQ 桥那一侧打开外发。',
    }))
    return body
  }

  // ---------- 鱼的风格（dsh-fish-tone 的只读状态） ----------
  // 档位是上游的值（off / light / normal / max），这里只翻成中文；认不出的原样显示，
  // 不替上游猜一个「标准」出来（底线③）。
  var TONE_LEVEL_LABELS = { off: '关闭', light: '轻', normal: '标准', max: '强' }
  function toneLevel(value) {
    if (value == null || value === '') return '—'
    return TONE_LEVEL_LABELS[value] || String(value)
  }

  function toneChildren() {
    var body = []
    var data = state.tone
    if (state.errors.tone) {
      body.push(statusLine('读取失败：' + state.errors.tone, 'error'))
      return body
    }
    if (!data) {
      body.push(skeleton('rows', 5))
      return body
    }
    // 未安装 / 配置读不出来：照它说的写，不画一串默认值冒充「读到了」。
    if (data.installed === false || data.ok === false) {
      body.push(statusLine(data.error || '未安装 dsh-fish-tone', 'warn'))
      body.push(h('p', {
        class: 'fw-row-hint',
        text: '装上 dsh-fish-tone 之后，这里会显示它的强度、种子与标记密度。',
      }))
      return body
    }
    var on = data.enabled === true
    body.push(infoRow('启用', on ? '是' : '否', { level: on ? 'ok' : 'warn' }))
    body.push(infoRow('强度', toneLevel(data.strength)))
    body.push(infoRow('种子', String(data.seed)))
    body.push(infoRow('语法整理', data.grammar === true ? '开' : '关'))
    body.push(infoRow('标记密度', toneLevel(data.marks)))
    // 上游没有 config.json 时就是用默认值跑：把这件事说出来，别让人以为面板读错了。
    if (data.configExists === false) {
      body.push(h('p', { class: 'fw-row-hint', text: '还没有 config.json，上面是 dsh-fish-tone 的默认值。' }))
    }
    body.push(h('p', {
      class: 'fw-card-note',
      text: data.note || '设置在 dsh-fish-tone 自己的页面里改；鱼世界只读显示。',
    }))
    return body
  }

  function viewStatus() {
    var mood = state.mood

    // 鱼的心情：只读 dsh-feiyu-mood 的 /state。
    // 维度、标签、档位名、理由全部用它返回的数据，这边不再自己定义一套。
    //
    // dsh-feiyu-mood 0.6.0/0.7.0 起支持「一份心情绑多个会话」「整个工作区共用一份」
    // （/state 多返回 slots / multi / mode）。面板必须跟上，否则第二份心情在鱼世界里
    // 完全看不见 —— 主人只看到最近在聊的那一份，会以为心情串了或丢了。
    var moodChildren = []
    if (state.errors.mood) {
      moodChildren.push(statusLine('读取失败：' + state.errors.mood, 'error'))
    } else if (!mood || !mood.ok) {
      moodChildren.push(skeleton('stat', 4))
    } else {
      var slots = Array.isArray(mood.slots) ? mood.slots : []
      var moodKey = state.moodKey || mood.key || ''
      // 多份时才画切换；只有一份时界面和以前一模一样（上游 0.5.0 的原话就是「老配置不用改」）。
      if (mood.multi && slots.length > 1) {
        moodChildren.push(h('p', {
          class: 'fw-row-hint',
          text: '有 ' + slots.length + ' 份心情，各自记各自的时间线。切一份只是换个看法，不影响判断。',
        }))
        moodChildren.push(h('div', { class: 'fw-tabs', role: 'tablist' }, slots.map(function (slot) {
          var label = String(slot.label || slot.id || '未命名')
          return tabItem(label, moodKey === slot.id, function () {
            state.moodKey = slot.id
            loadMood()
          })
        })))
      }
      // 工作区模式下每一份覆盖的是整个工作区，不说清楚会让人以为「绑错了会话」。
      if (mood.mode === 'workspace') moodChildren.push(statusLine('按工作区共用：这个工作区里新开的会话自动归这一份', 'warn'))
      if (mood.label && mood.multi) moodChildren.push(statusLine('这一份：' + mood.label, ''))
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
      // 第三行 4+4+4 闭合到 12：两张新卡（花费 / 主动开口）按规范都占 4 列，
      // 挂饰开关于是从通栏收到 4 列 —— 它只有一行开关，通栏摆着本来也是空壳。
      // 三张卡内容长短差得多，都用 naturalHeight 按内容收缩。
      card({
        key: 'status-cost',
        title: '养鱼花费',
        note: state.cost && state.cost.ok === false ? '未安装' : '读数来自 dsh-cost-meter',
        span: 4,
        naturalHeight: true,
        children: costChildren(),
      }),
      card({
        key: 'status-speak-up',
        title: '鱼主动开口',
        note: state.speakUp && state.speakUp.installed === false ? '未安装' : '读数来自 dsh-speak-up',
        span: 4,
        naturalHeight: true,
        children: speakUpChildren(),
      }),
      card({
        key: 'status-mood-badge',
        title: '挂饰显示',
        note: '原 dsh-feiyu-mood 挂件',
        span: 4,
        naturalHeight: true,
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

  /**
   * 「图片收藏」卡的正文：额度、图库位置、缩略图网格。
   * 原来 viewStickers 一次出两张卡（网站 + 图片）；网站那半已抽成 renderLinkLibrary，
   * 这里只返回图片这一块的正文节点，由 viewMemory 装进卡片。
   */
  function galleryChildren() {
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

      // 同步到 QQ 收藏：状态 + 按钮。写的是主人 QQ 账号的收藏，只由这个按钮显式触发
      //（后端绝不自动、绝不后台批量）；没同步的表情不受影响，照旧按图片发。
      var syncedCount = items.filter(function (item) { return item.emojiId }).length
      var syncBtn = h('button', {
        class: 'fw-btn fw-btn-ghost',
        type: 'button',
        text: state.stickerSyncBusy ? '同步中…' : '同步到 QQ 收藏',
        title: '把还没同步的图片逐张加入这个 QQ 账号的收藏（只在点的时候跑，不会自动）',
      })
      if (state.stickerSyncBusy) syncBtn.disabled = true
      syncBtn.addEventListener('click', function () {
        if (state.stickerSyncBusy) return
        state.stickerSyncBusy = true
        state.stickerSyncMsg = { text: '正在同步，逐张上传，可能要一会儿…', tone: '' }
        render()
        postJSON('/dsh-fish-world/sticker-sync', {})
          .then(function (r) {
            if (r && r.ok === false) {
              var errs = (r.errors || []).map(function (e) { return (e.name || e.id || '') + '：' + e.error }).filter(Boolean)
              throw new Error(errs[0] || r.error || '同步失败')
            }
            state.stickerSyncMsg = {
              text: '已同步 ' + (r.added || 0) + ' 张到 QQ 收藏' + (r.failed ? '，失败 ' + r.failed + ' 张' : ''),
              tone: r.failed ? 'warn' : 'success',
            }
            return loadStickers()
          })
          .catch(function (e) { state.stickerSyncMsg = { text: '同步失败：' + e.message, tone: 'error' } })
          .then(function () { state.stickerSyncBusy = false; render() })
      })
      children.push(h('div', { class: 'fw-row' }, [
        h('span', { class: 'fw-row-label' }, [
          h('span', { text: 'QQ 收藏' }),
          h('span', { class: 'fw-row-hint', text: '已同步 ' + syncedCount + ' 张到 QQ 收藏' }),
        ]),
        syncBtn,
      ]))
      if (state.stickerSyncMsg) children.push(statusLine(state.stickerSyncMsg.text, state.stickerSyncMsg.tone))
      // 优先开关：关掉后同步过的表情也一律按老图片路径发（现状可随时退回）。
      children.push(switchRow({
        label: '优先用收藏表情发',
        hint: '开着时同步过的表情走 QQ 收藏表情（小、可长按再收）；关掉一律按图片发。',
        checked: !(data.summary && data.summary.useCustomFace === false),
        onChange: function (next) {
          postJSON('/dsh-fish-world/config', { stickers: { useCustomFace: next } })
            .then(function (r) {
              if (r && r.ok === false) throw new Error(r.error || '保存失败')
              return loadStickers()
            })
            .catch(function (e) { state.stickerSyncMsg = { text: '设置保存失败：' + e.message, tone: 'error' }; render() })
        },
      }))

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
        // 批量选择只存在内存里：图库刷新后先按现有条目剔一遍，
        // 免得「选了但已经被删掉」的 id 混进批量请求（会平白多一条失败）。
        var knownIds = {}
        items.forEach(function (item) { knownIds[item.id] = true })
        state.stickerSelected = (state.stickerSelected || []).filter(function (id) { return knownIds[id] })

        var figures = []
        // 选中集合的唯一出口：读写都过这几个小函数，别处不要自己拼数组。
        var pickedIds = function () { return state.stickerSelected || [] }
        var isPicked = function (id) { return pickedIds().indexOf(id) >= 0 }
        var setPicked = function (id, on) {
          var next = pickedIds().filter(function (other) { return other !== id })
          if (on) next.push(id)
          state.stickerSelected = next
          // 换了选择就撤掉删除确认：不能让人选完 A 再勾 B，一点就把 B 删了。
          state.stickerBatchConfirm = false
          syncSelection()
        }
        var pickAll = function (on) {
          state.stickerSelected = on ? items.map(function (item) { return item.id }) : []
          state.stickerBatchConfirm = false
          syncSelection()
        }

        // 失败时说清「哪一张、为什么」，不笼统写「操作完成」。
        var failedHint = function (list) {
          if (!Array.isArray(list) || !list.length) return ''
          var first = list[0] || {}
          var who = first.name || first.id || ''
          return '（' + (who ? who + '：' : '') + (first.error || '失败') + (list.length > 1 ? ' 等 ' + list.length + ' 张' : '') + '）'
        }
        var batchResultText = function (action, r, tags) {
          if (action === 'tags') {
            var updated = Number(r.updated) || 0
            var badTags = failedHint(r.failed)
            return {
              text: '已给 ' + updated + ' 张追加标签' + (tags.length ? '「' + tags.join('、') + '」' : '') + (badTags ? '；失败 ' + badTags : ''),
              tone: (r.failed && r.failed.length) ? 'warn' : 'success',
            }
          }
          if (action === 'organize') {
            // 后端说「没开始」（比如视觉整理未接入）：如实照搬它的原因，不显示成「成功 0 张」。
            if (r.ok === false && !(Number(r.done) > 0) && r.error) return { text: '批量整理没有开始：' + r.error, tone: 'error' }
            var done = Number(r.done) || 0
            var failedCount = Number(r.failed) || 0
            var badRows = (r.results || []).filter(function (row) { return !row.ok })
            return {
              text: '整理完成：成功 ' + done + ' 张' + (failedCount ? '，失败 ' + failedCount + ' 张' + failedHint(badRows) : '') + '（共 ' + (Number(r.total) || 0) + ' 张）',
              tone: failedCount ? 'warn' : 'success',
            }
          }
          var removed = Number(r.removed) || 0
          var badRemove = failedHint(r.failed)
          return {
            text: '已删除 ' + removed + ' 张' + (badRemove ? '；没删掉的 ' + badRemove : ''),
            tone: (r.failed && r.failed.length) ? 'warn' : 'success',
          }
        }

        // 批量提交：打标签 / 整理 / 删除共用一条路由。一次只跑一件，别让两次改索引交叠。
        var runBatch = function (action, extra) {
          if (state.stickerBatchBusy) return
          var ids = pickedIds().slice()
          if (!ids.length) return
          var tags = (extra && Array.isArray(extra.tags)) ? extra.tags : []
          state.stickerBatchConfirm = false
          state.stickerBatchBusy = action
          state.stickerBatchMsg = {
            text: action === 'tags' ? ('正在给 ' + ids.length + ' 张追加标签…')
              : (action === 'organize' ? ('正在逐张整理 ' + ids.length + ' 张，可能要一会儿…') : ('正在删除 ' + ids.length + ' 张…')),
            tone: '',
          }
          render()
          var body = { action: action, ids: ids }
          if (extra) Object.keys(extra).forEach(function (key) { body[key] = extra[key] })
          postJSON('/dsh-fish-world/stickers/batch', body)
            .then(function (r) {
              state.stickerBatchBusy = ''
              if (!r || r.ok === undefined) throw new Error('后端没有回话')
              state.stickerBatchMsg = batchResultText(action, r, tags)
              // 标签输入用完就清空；选中列表保留（整理完想接着删不必重选），
              // 真被删掉的 id 会在下次渲染时按图库现有条目剔掉。
              if (action === 'tags') state.stickerBatchTags = ''
              return loadStickers()
            })
            .catch(function (e) {
              state.stickerBatchBusy = ''
              state.stickerBatchMsg = { text: '批量操作没有完成：' + e.message, tone: 'error' }
              render()
            })
        }

        // 批量操作条：选中 ≥1 张才出现。只用 inset 底 + 发丝边框和既有 token，
        // 不新增彩色、不位移，也不改网格尺寸（16px 内边距、与网格同一套间距）。
        var batchBar = function (ids) {
          var busy = state.stickerBatchBusy
          var vis = state.stickerVision
          var input = h('input', {
            class: 'fw-input',
            type: 'text',
            placeholder: '要追加的标签，逗号或空格分隔',
            'aria-label': '要追加到选中图片的标签',
            value: state.stickerBatchTags || '',
          })
          input.addEventListener('input', function () { state.stickerBatchTags = input.value })
          var addTags = function () {
            var tags = String(state.stickerBatchTags || '').split(/[,，、\s]+/).filter(Boolean)
            if (!tags.length) {
              state.stickerBatchMsg = { text: '先填要加的标签（逗号或空格分隔），再点追加', tone: 'warn' }
              syncSelection()
              return
            }
            runBatch('tags', { tags: tags })
          }
          input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { event.preventDefault(); addTags() }
          })
          var addBtn = quietButton(busy === 'tags' ? '追加中…' : '追加标签', addTags)

          // 视觉整理没接入就不放一个点了没用的灰按钮：如实说明缺什么、去哪儿配。
          var organizeBtn = null
          var organizeHint = ''
          if (vis && vis.ready) {
            organizeBtn = quietButton(busy === 'organize' ? '整理中…' : '批量整理', function () { runBatch('organize') })
          } else if (vis) {
            organizeHint = '批量整理暂不可用：' + (vis.reason || '视觉整理未就绪') + '（在「图片整理」卡里配好后可用）'
          } else {
            organizeHint = '批量整理暂不可用：还在读取视觉整理的状态…'
          }

          // 删除走两步：第一次点只换成「确认删除」，并说明后果；再点才真删。
          var removeBtn = state.stickerBatchConfirm
            ? quietButton('确认删除 ' + ids.length + ' 张', function () { runBatch('remove') })
            : quietButton('批量删除', function () {
              state.stickerBatchConfirm = true
              syncSelection()
            })

          // 忙碌时禁用自己的按钮（只是防连点，按钮上的字同时会变成「…中」）。
          if (busy) {
            ;[addBtn, organizeBtn, removeBtn].forEach(function (button) { if (button) button.disabled = true })
          }
          return h('div', { class: 'fw-gallery-batch' }, [
            h('div', { class: 'fw-gallery-batch-tags' }, [input, addBtn]),
            h('div', { class: 'fw-btn-row' }, [organizeBtn, removeBtn]),
            organizeHint ? h('p', { class: 'fw-row-hint', text: organizeHint }) : null,
            state.stickerBatchConfirm
              ? h('p', { class: 'fw-row-hint', text: '将删除 ' + ids.length + ' 张图，不可恢复。确认后立即从磁盘删掉。' })
              : null,
          ])
        }

        var syncPickBar = function () {
          var ids = pickedIds()
          pickBar.textContent = ''
          var allPicked = items.length > 0 && ids.length === items.length
          pickBar.appendChild(h('div', { class: 'fw-row fw-gallery-pick-head' }, [
            h('span', { class: 'fw-row-label' }, [
              h('span', { text: '批量选择' }),
              h('span', {
                class: 'fw-row-hint',
                text: ids.length ? ('已选 ' + ids.length + ' 张') : '勾图左上角的框，可一次打标签 / 整理 / 删除',
              }),
            ]),
            h('div', { class: 'fw-btn-row' }, [
              quietButton(allPicked ? '取消全选' : '全选', function () { pickAll(!allPicked) }),
              ids.length ? quietButton('清除选择', function () { pickAll(false) }) : null,
            ]),
          ]))
          if (ids.length) pickBar.appendChild(batchBar(ids))
          if (state.stickerBatchMsg) pickBar.appendChild(statusLine(state.stickerBatchMsg.text, state.stickerBatchMsg.tone))
        }

        // 只刷「选中态 + 批量条」，不整页重绘：一百多张缩略图整页重绘会把图全部重新拉一遍。
        var syncSelection = function () {
          figures.forEach(function (row) {
            var on = isPicked(row.id)
            if (row.node.dataset) row.node.dataset.selected = on ? 'true' : 'false'
            if (row.box) row.box.checked = on
          })
          syncPickBar()
          // 批量条让卡片长高了一截，而卡片是绝对定位 + overflow:hidden：
          // 不重量一次下半截会被裁掉。这里只重量重排，不重绘（缩略图不会被重新下载）。
          if (main) scheduleRelayout(main, { animate: false })
        }

        var pickBar = h('div', { class: 'fw-gallery-pickbar' })
        // 图库是这一页内容最多的一块：用缩略图网格铺开，卡片按内容自然长高。
        // 图片还没加载 / 加载失败时，缩略图位置保留同样大小的灰底占位，
        // 不会因为“现在没图”就把卡片压扁。
        var grid = h('div', { class: 'fw-gallery-grid' }, items.map(function (item) {
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
          // 单张整理：让视觉模型看这一张，补名字 / 标签 / 说明。
          // 正在整理时禁用自己，避免连点打出多次请求。
          var organizeBtn = h('button', {
            class: 'fw-btn fw-btn-ghost fw-gallery-organize',
            type: 'button',
            text: item.organized ? '重新整理' : '整理',
            title: '看图整理「' + label + '」',
            'aria-label': '整理「' + label + '」',
          })
          organizeBtn.addEventListener('click', function () {
            if (organizeBtn.disabled) return
            organizeBtn.disabled = true
            var previous = organizeBtn.textContent
            organizeBtn.textContent = '整理中…'
            postJSON('/dsh-fish-world/stickers/organize', { id: item.id })
              .then(function (r) {
                if (r && r.ok === false) throw new Error(r.error || '整理失败')
                return loadStickers()
              })
              .catch(function (e) {
                organizeBtn.textContent = previous
                setError('stickers', e.message)
              })
              .finally(function () { organizeBtn.disabled = false })
          })
          // 左上角选择框：复用角标那套绝对定位几何（32px 热区里放 14px 方块）。
          // 点框只选框；画框其余地方不拦，图还是那张图。
          var box = h('input', {
            type: 'checkbox',
            class: 'fw-gallery-check',
            'aria-label': '选择「' + label + '」',
            title: '选择「' + label + '」',
          })
          box.checked = isPicked(item.id)
          box.addEventListener('change', function () { setPicked(item.id, box.checked) })
          var picker = h('label', { class: 'fw-gallery-pick', title: '选择「' + label + '」' }, [box])
          // 动图角标：哪张是 GIF / 动图 WebP 一眼看得出，不用点开才知道。
          var animatedBadge = item.animated
            ? h('span', { class: 'fw-gallery-anim', text: '动图', title: '动图（GIF / 动图 WebP）' })
            : null
          // 已同步角标：「同步没同步」是信息不是操作，常驻左下角（复用动图角标样式，换个角）。
          var favBadge = item.emojiId
            ? h('span', { class: 'fw-gallery-anim fw-gallery-fav', text: '已收藏', title: '已同步到 QQ 收藏，发送时走收藏表情' })
            : null
          var figure = h('figure', {
            class: 'fw-gallery-item',
            dataset: { sticker: item.id, selected: isPicked(item.id) ? 'true' : 'false' },
          }, [
            h('div', { class: 'fw-gallery-frame' }, [img, animatedBadge, favBadge, picker, delBtn, organizeBtn]),
            h('figcaption', { class: 'fw-gallery-meta' }, [
              h('span', { class: 'fw-sticker-name', text: label, title: label }),
              h('span', { class: 'fw-sticker-tags', text: tags, title: tags }),
            ]),
          ])
          figures.push({ id: item.id, node: figure, box: box })
          return figure
        }))
        children.push(pickBar)
        children.push(grid)
        syncPickBar()
      }
    }
    return children
  }

  // ---------- 记忆中枢：账本 / 并库草稿 / 试召回 / 记忆便签 ----------
  // 账本把三处记忆读成一张表（会话库 / 群友 / 知识库）；并库是它上面的写操作；
  // 召回与便签问的是「她会想起什么」，用的是注入提示词的同一份 recall()。
  // 两条都只在真有内容时画（空库不假装有），结果一律 pre-wrap 原样显示。

  /** 召回预览：后端回逐条 picked（每条带来源 / 相关度 / 鲜活），逐条摊开。 */
  function recallPreviewNodes(preview) {
    var out = []
    if (!preview) return out
    if (typeof preview === 'string') {
      out.push(h('p', { class: 'fw-row-hint fw-prewrap', text: preview }))
      return out
    }
    var picked = Array.isArray(preview.picked) ? preview.picked : []
    if (!picked.length) {
      out.push(emptyState('这句什么都没想起来。', '换个说法试试；库里确实没有也会这样。'))
      return out
    }
    out.push(h('p', {
      class: 'fw-card-note',
      text: '「' + (preview.query || '（空）') + '」→ 想起 ' + picked.length + ' 条（共 ' + (preview.total == null ? '—' : preview.total) + ' 条候选）',
    }))
    picked.forEach(function (item) {
      out.push(infoRow(item.source === 'knowledge' ? '知识库' : (item.source === 'persons' ? '群友记忆' : '会话记忆'), item.text, { level: '' }))
      out.push(h('p', {
        class: 'fw-row-hint',
        text: [item.person ? '关于 ' + item.person : '', item.at ? shortTime(item.at) : '', '相关度 ' + item.score, '鲜活 ' + item.activation]
          .filter(Boolean).join(' · '),
      }))
    })
    return out
  }

  /**
   * 记忆中枢的正文：账本 → 并库草稿（写操作，两次确认）→ 试召回 / 记忆便签。
   * 结果与状态全部记在 state 上：点完会整页重绘，只写在局部节点上的字会被冲掉。
   */
  function memoryHubChildren() {
    var memBody = []
    var mem = state.memoryHub
    // 「应用草稿」的忙标记：一次点击只允许一次写入，别让人连点两下写出两遍。
    var mergeBusy = state.mergeBusy === true

    /**
     * 应用并库草稿：后端真写知识库，并把每一步回传（备份 → 逐条写入 → 回读 → 索引 → 回滚）。
     * 撞车与重复的条目后端不会碰，所以这里不存在「悄悄覆盖主人说过的话」那种事。
     */
    function applyMerge() {
      if (mergeBusy) return
      mergeBusy = true
      state.mergeBusy = true
      state.mergeRun = { at: new Date().toISOString(), note: '正在并…', tone: '', steps: [] }
      render()
      postJSON('/dsh-fish-world/memory/merge', { apply: true })
        .then(function (r) {
          mergeBusy = false
          state.mergeBusy = false
          if (r && r.ok) {
            if (r.ledger) state.memoryHub = r.ledger
            state.mergeRun = {
              at: new Date().toISOString(),
              note: r.note || '并完了',
              tone: r.changed ? 'success' : '',
              // 真并了才给「更新索引」按钮：没并成、或本来就没东西可并，那一步是多余动作。
              changed: r.changed === true,
              steps: r.steps || [],
            }
            loadActions()
          } else {
            state.mergeRun = {
              at: new Date().toISOString(),
              note: '没并成：' + ((r && r.error) || '未知错误') + ((r && r.backup) ? '（备份：' + r.backup + '）' : ''),
              tone: 'error',
              steps: (r && r.steps) || [],
            }
          }
        })
        .catch(function (e) {
          mergeBusy = false
          state.mergeBusy = false
          state.mergeRun = { at: new Date().toISOString(), note: '没并成：' + e.message, tone: 'error', steps: [] }
        })
        .then(render)
    }

    if (state.errors.memoryHub) {
      memBody.push(statusLine('记忆账本读取失败：' + state.errors.memoryHub, 'error'))
    } else if (!mem) {
      memBody.push(skeleton('rows', 3))
    } else {
      (mem.sources || []).forEach(function (source) {
        memBody.push(numRow(source.label, String(source.count || 0), {
          level: source.exists ? '' : 'warn',
        }))
        memBody.push(h('p', { class: 'fw-row-hint', text: source.note || '' }))
        // 会话库按会话摊开：只报一个总数看不出「为什么换个窗口就想不起来」。
        // 每行一个会话（短 id）、几条、其中几条是长期事实、最后一次写入。
        if (source.kind === 'sessions' && Array.isArray(source.detail) && source.detail.length) {
          source.detail
            .slice()
            .sort(function (a, b) { return Number(b.latest || 0) - Number(a.latest || 0) })
            .slice(0, 8)
            .forEach(function (row) {
              memBody.push(infoRow(
                '会话 ' + String(row.id || '').slice(0, 8),
                String(row.total || 0) + ' 条' + (row.stable ? ' · 长期 ' + row.stable : ''),
                { level: row.total ? '' : 'warn' }
              ))
              if (row.latest) memBody.push(h('p', { class: 'fw-row-hint', text: '最后写入 ' + shortTime(new Date(Number(row.latest)).toISOString()) }))
            })
          if (source.detail.length > 8) {
            memBody.push(h('p', { class: 'fw-row-hint', text: '还有 ' + (source.detail.length - 8) + ' 个会话没列出。' }))
          }
        }
      })
      ;(mem.warnings || []).forEach(function (text) {
        memBody.push(statusLine(text, 'warn'))
      })
      // 衣柜 = 跟主人聊天时真正会被想起来的那一份（dsh-fish-memory 的会话库）。
      // 群友印象现在也往里写，所以要让人看得见它接没接上、写进去几条。
      var wardrobe = mem.wardrobe
      if (wardrobe) {
        memBody.push(numRow('衣柜（会话库）', wardrobe.available ? String(wardrobe.count) + ' 条' : '没接上', {
          level: wardrobe.available ? 'ok' : 'warn',
        }))
        memBody.push(h('p', {
          class: 'fw-row-hint',
          text: wardrobe.available
            ? '其中鱼的世界补进去的 ' + String(wardrobe.fromUs || 0) + ' 条 · 最近写入 ' + shortTime(wardrobe.latestAt)
            : 'dsh-fish-memory 还没建过会话库；群友印象目前只落在按人的那份里。',
        }))
      }
      memBody.push(h('p', {
        class: 'fw-card-note',
        text: wardrobe && wardrobe.available
          ? '群友印象现在是两边同时写：按人的那份给群聊用，衣柜那份给跟主人聊天时用。'
          : '这一栏只把几处记忆读成一张表；要真让「不同平台是同一条鱼」，得先把衣柜接上。',
      }))

      // ---- 合并记忆：只读草稿 → 主人点头才动知识库 ----
      // 草稿只说「能并几条」，一条都没改。要动数据得主人点头（两下确认，不弹窗）。
      var merge = mem.merge
      if (merge && merge.counts) {
        memBody.push(h('div', { class: 'fw-divider' }))
        memBody.push(h('p', { class: 'fw-field-label', text: '合并记忆' }))
        memBody.push(numRow('衣柜里可并进知识库', String(merge.counts.new || 0) + ' 条', {
          level: merge.counts.new ? 'warn' : 'ok',
        }))
        memBody.push(h('p', {
          class: 'fw-row-hint',
          text: merge.note || '',
        }))
        // 说清这一步不会动原文件：不写这句，人会以为「并库 = 把会话库搬走」而不敢点。
        if (merge.sessions && merge.sessions.length) {
          memBody.push(h('p', {
            class: 'fw-row-hint',
            text: '草稿覆盖 ' + merge.sessions.length + ' 个会话（' + merge.sessions.join('、') + '）；'
              + '并进知识库不会改那些会话文件——dsh-fish-memory 还在用它们，这一步是让 know 与回忆也能查到老碎片。',
          }))
        }
        // 撞车那几条要摊开：自动覆盖等于替主人改她说过的话。两边原文都给，才比得出来。
        ;(merge.candidates || []).filter(function (item) { return item.state === 'near' }).forEach(function (item) {
          memBody.push(infoRow('说法撞车', item.matched || '', { level: 'warn' }))
          memBody.push(h('p', {
            class: 'fw-row-hint',
            text: '衣柜里' + (item.from ? '（会话 ' + item.from + '）' : '') + '：' + item.text,
          }))
          if (item.matchedText) memBody.push(h('p', { class: 'fw-row-hint', text: '知识库里：' + item.matchedText }))
          // 点「应用草稿」会怎么处置它——当场说清，别等人点完才发现被跳过。
          if (item.actionNote) memBody.push(h('p', { class: 'fw-row-hint', text: item.actionNote }))
        })
        // 已被知识库覆盖的那几条也列一下（只列名字，不重复整段）：
        // 「0 条重复不并」这种数字看不出到底哪几条被跳过了，人会觉得漏了东西。
        var dups = (merge.candidates || []).filter(function (item) { return item.state === 'dup' })
        if (dups.length) {
          memBody.push(infoRow('知识库已有（不并）', String(dups.length) + ' 条', { level: 'ok' }))
          memBody.push(h('p', {
            class: 'fw-row-hint',
            text: dups.slice(0, 6).map(function (item) { return item.matched || (item.text || '').slice(0, 12) }).join('、')
              + (dups.length > 6 ? ' 等 ' + dups.length + ' 条' : ''),
          }))
        }

        // 应用草稿：真写知识库。按钮就近放在草稿下面，别让人翻到别的分区去找执行口。
        var mergeStatus = state.mergeRun || null
        var mergeButtons = [
          quietButton(mergeBusy ? '正在并…' : '应用草稿（只并新条目）', function () {
            if (state.mergeConfirm) {
              applyMerge()
              return
            }
            // 二次确认：第一次点只把按钮换成「确认」，不做弹窗（面板不弹窗是硬规矩）。
            state.mergeConfirm = true
            render()
          }),
        ]
        if (state.mergeConfirm) {
          mergeButtons.push(quietButton('取消', function () {
            state.mergeConfirm = false
            render()
          }))
        }
        // 并完就顺手把向量索引更新掉：并库会把索引放旧，还要人自己跑去「知识库」卡点一次，
        // 中间隔一步就会忘——「并进去了但搜不到」正是这么来的。
        if (mergeStatus && mergeStatus.changed) {
          mergeButtons.push(quietButton('更新知识库索引', function () {
            if (mergeBusy) return
            mergeBusy = true
            state.mergeBusy = true
            postJSON('/dsh-fish-world/world/knowledge', { action: 'update' })
              .then(function (r) {
                mergeBusy = false
                state.mergeBusy = false
                state.mergeRun = Object.assign({}, mergeStatus, {
                  note: r && r.ok
                    ? (r.rebuilt ? '索引已重建' : '索引本来就是最新的')
                    : '索引没更新成：' + ((r && r.error) || '未知错误'),
                  tone: r && r.ok ? 'success' : 'error',
                })
              })
              .catch(function (e) {
                mergeBusy = false
                state.mergeBusy = false
                state.mergeRun = Object.assign({}, mergeStatus, { note: '索引没更新成：' + e.message, tone: 'error' })
              })
              .then(render)
          }))
        }
        memBody.push(h('div', { class: 'fw-card-actions' }, mergeButtons))
        if (state.mergeConfirm) {
          memBody.push(statusLine('再点一次「应用草稿」就真的写知识库；点「取消」收手。', 'warn'))
        }
        if (mergeStatus) {
          memBody.push(statusLine(
            (mergeStatus.note || '') + (mergeStatus.at ? ' · ' + shortTime(mergeStatus.at) : ''),
            mergeStatus.tone || ''
          ))
          ;(mergeStatus.steps || []).forEach(function (s) { memBody.push(stepRow(s)) })
        }
      }
    }

    // ---- 试召回 / 记忆便签 ----
    // 问一句，看会想起哪几条。用的是真正注入提示词的同一个 recall()，
    // 所以「跨会话召回有没有生效」不用等重启就能看见。
    var recallInput = h('input', {
      class: 'fw-input',
      type: 'text',
      placeholder: '试一句，比如「死鱼眼那个表情怎么用」',
      'aria-label': '试一句查询',
      value: state.recallQuery || '',
    })
    memBody.push(h('div', { class: 'fw-field' }, [
      h('label', { class: 'fw-field-label', text: '试一下她会想起什么' }),
      recallInput,
    ]))
    memBody.push(h('div', { class: 'fw-card-actions' }, [
      quietButton('预览召回', function () {
        state.recallQuery = recallInput.value || ''
        state.briefPreview = null
        loadRecall(state.recallQuery)
      }),
      // 同一批记忆，换成真正写进提示词的样子（排版与注入是同一份实现）。
      quietButton('看看会怎么写进提示词', function () {
        state.recallQuery = recallInput.value || ''
        state.recallPreview = null
        loadBrief(state.recallQuery)
      }),
    ]))
    memBody.push(h('p', {
      class: 'fw-row-hint',
      text: '「看记忆便签」就是把同一批记忆换成真正写进提示词的样子；上面两个按钮问的是同一句。',
    }))
    if (state.errors.brief) {
      memBody.push(statusLine('读不到记忆便签：' + state.errors.brief, 'error'))
    } else if (state.briefPreview) {
      memBody.push(h('p', { class: 'fw-card-note', text: '提示词里那一段（共 ' + state.briefPreview.count + ' 条）：' }))
      if (!state.briefPreview.text) {
        memBody.push(emptyState('这段现在是空的。', '没有想起东西时，提示词里就不会有这一节。'))
      } else {
        memBody.push(h('p', { class: 'fw-row-hint fw-prewrap', text: state.briefPreview.text }))
      }
    }
    if (state.errors.recall) {
      memBody.push(statusLine('预览召回失败：' + state.errors.recall, 'error'))
    } else if (state.recallPreview) {
      recallPreviewNodes(state.recallPreview).forEach(function (node) { memBody.push(node) })
    }
    return memBody
  }

  // ---------- 操作时间线（/actions） ----------
  // 谁在什么时候动了什么手：鱼写日记、提请求、改开关都在这里。
  // 每条只占一行（时间 + 谁 + 动作 + 关联 id），超长省略并带 title ——
  // 几十条摊开时，一条换两行就能把卡片撑成一堵墙。
  var ROLE_FILTERS = [
    { id: '', label: '全部' },
    { id: 'fish', label: '鱼自己' },
    { id: 'owner', label: '主人' },
    { id: 'trusted', label: '信任者' },
  ]
  var ACTION_ROLE_WORDS = { fish: '鱼', owner: '主人', trusted: '信任者' }
  var DAY_FILTERS = [7, 30, 90]

  function actionsChildren() {
    var acts = state.actions
    var body = []
    body.push(h('div', { class: 'fw-card-actions' }, ROLE_FILTERS.map(function (item) {
      return quietButton((state.actionsRole === item.id ? '· ' : '') + item.label, function () {
        if (state.actionsRole === item.id) return
        state.actionsRole = item.id
        loadActions()
      })
    })))
    body.push(h('div', { class: 'fw-card-actions' }, DAY_FILTERS.map(function (days) {
      return quietButton((Number(state.actionsDays) === days ? '· ' : '') + '最近 ' + days + ' 天', function () {
        if (Number(state.actionsDays) === days) return
        state.actionsDays = days
        loadActions()
      })
    })))

    if (state.errors.actions) {
      body.push(statusLine('读不到操作记录：' + state.errors.actions, 'error'))
    } else if (!acts) {
      body.push(skeleton('rows', 4))
    } else if (!(acts.items || []).length) {
      body.push(emptyState('暂无数据', '鱼写日记、提请求、改开关都会落在这里。'))
    } else {
      var items = acts.items || []
      body.push(h('p', {
        class: 'fw-card-note',
        text: '共 ' + (acts.total == null ? items.length : acts.total) + ' 条'
          + ((acts.days || []).length ? ' · 读过 ' + acts.days.length + ' 天' : ''),
      }))
      items.forEach(function (item) {
        var who = item.roleLabel || ACTION_ROLE_WORDS[item.role] || item.role || ''
        // 关联 id 只留前 12 位：完整 id 在这个宽度里也读不完，title 里有全文。
        var ref = item.recordId || item.record || item.id || item.ref || ''
        var title = String(item.label || '（没有动作名）')
        var meta = [shortTime(item.at), who, ref ? '关联 ' + String(ref) : (item.text || '')]
          .filter(Boolean).join(' · ')
        body.push(h('div', { class: 'fw-flow-row fw-flow-oneline' }, [
          h('span', { class: 'fw-flow-dot', dataset: { tone: '' }, 'aria-hidden': 'true' }),
          h('span', { class: 'fw-flow-main' }, [
            h('span', { class: 'fw-flow-title', text: title, title: title }),
            h('span', { class: 'fw-row-hint', text: meta, title: meta }),
          ]),
        ]))
      })
      body.push(h('p', {
        class: 'fw-card-note',
        text: '来源：安全与审计/<日期>.jsonl，只读；这一页不往里写。',
      }))
    }
    return body
  }

  // ---- 每日记忆摘要 ----
  /**
   * 每日记忆摘要卡：她今天带进提示词的那份压缩记忆。
   * 显示 条数 / 字数 / 来源（会话文件·印象）/ 更新时间 / 下次更新；
   * 「立即重建」真调 POST /memory-digest，开关也是同一条路由（body.enabled）。
   */
  function memoryDigestChildren() {
    var body = []
    var data = state.memoryDigest
    function rebuild() {
      state.memoryDigestBusy = true
      render()
      postJSON('/dsh-fish-world/memory-digest', { force: true })
        .then(function (r) {
          state.memoryDigestBusy = false
          if (r && r.ok === false) throw new Error(r.error || '重建失败')
          return loadMemoryDigest()
        })
        .catch(function (e) {
          state.memoryDigestBusy = false
          state.errors.memoryDigest = e.message
          render()
        })
    }

    if (state.errors.memoryDigest) {
      body.push(statusLine('读取失败：' + state.errors.memoryDigest, 'error'))
    } else if (!data) {
      body.push(skeleton('rows', 3))
    } else {
      var sources = data.sources || {}
      body.push(numRow('今天带了', String(data.lines || 0) + ' 条', {
        level: data.cached ? 'ok' : 'warn',
      }))
      body.push(infoRow('字数', String(data.textLength || 0) + ' 字'))
      body.push(infoRow('来源', (sources.sessionFiles || 0) + ' 个会话文件 · ' + (sources.persons || 0) + ' 条印象'))
      body.push(infoRow('更新时间', data.updatedAt ? shortTime(data.updatedAt) : '还没有'))
      body.push(h('p', { class: 'fw-row-hint', text: '下次更新：' + (data.nextRebuild || '日期变化或手动触发') + '。摘要一天只算一次，所有平台共用同一段。' }))
      if (sources.skippedFiles) {
        body.push(h('p', { class: 'fw-row-hint', text: '有 ' + sources.skippedFiles + ' 个会话文件读不出来，已跳过。' }))
      }
      body.push(h('div', { class: 'fw-btn-row', style: 'margin-top:var(--space-3)' }, [
        ghostButton(state.memoryDigestBusy ? '重建中…' : '立即重建', rebuild),
      ]))
      body.push(switchRow({
        label: '进所有平台的提示词',
        hint: '关掉后 systemPrompt 里不再出现这段摘要（已有的缓存保留）。',
        checked: data.enabled !== false,
        onChange: function (next) {
          postJSON('/dsh-fish-world/memory-digest', { enabled: next })
            .then(function (r) {
              if (r && r.ok === false) throw new Error(r.error || '保存失败')
              return loadMemoryDigest()
            })
            .catch(function (e) { state.errors.memoryDigest = e.message; render() })
        },
      }))
    }
    return body
  }

  // ---- 鱼的记忆 ----
  /**
   * 鱼的记忆：知识库 / 图片收藏 / 网站链接 / 图片整理，四张卡两行。
   * 只做装配——正文仍由 knowledgeChildren / galleryChildren / renderLinkLibrary /
   * stickerVisionChildren 生成，不在这里复制业务逻辑。
   * 跨度 6+6 每行闭合到 12；四块内容长短差很多，用 naturalHeight 让矮卡按内容收缩。
   */
  function viewMemory() {
    return [
      card({
        key: 'memory-knowledge',
        title: '知识库',
        note: '梗、外观、约定 —— 你写的内容，索引可重建',
        span: 6,
        naturalHeight: true,
        children: knowledgeChildren(),
      }),
      card({
        key: 'memory-gallery',
        title: '图片收藏',
        note: '表情与图片 · 每小时最多 5 张',
        span: 6,
        naturalHeight: true,
        children: galleryChildren(),
      }),
      card({
        key: 'memory-links',
        title: '网站链接',
        note: '按分类编号 · 资源与灵感站点',
        span: 6,
        naturalHeight: true,
        children: [renderLinkLibrary()],
      }),
      card({
        key: 'memory-organize',
        title: '图片整理',
        note: '看图补名字 / 标签 / 说明',
        span: 6,
        naturalHeight: true,
        children: stickerVisionChildren(),
      }),
      // 记忆中枢、每日记忆摘要与操作时间线：6+6 闭合到 12，时间线通栏收尾。
      // 中枢问「她会想起什么」，摘要答「今天她带着哪份压缩记忆」，时间线答「她最近动过什么手」。
      card({
        key: 'memory-hub',
        title: '记忆中枢',
        note: '试召回 · 记忆便签 · 合并',
        span: 6,
        naturalHeight: true,
        children: memoryHubChildren(),
      }),
      card({
        key: 'memory-digest',
        title: '每日记忆摘要',
        note: state.memoryDigest && state.memoryDigest.cached
          ? (state.memoryDigest.lines || 0) + ' 条 · ' + (state.memoryDigest.textLength || 0) + ' 字'
          : '按天压缩的全局记忆',
        span: 6,
        naturalHeight: true,
        children: memoryDigestChildren(),
      }),
      card({
        key: 'memory-actions',
        title: '操作时间线',
        note: state.actions ? (state.actions.total == null ? '' : state.actions.total + ' 条') : '',
        // 通栏：这一行只剩它自己（6+6 已被上一行占满），span 12 才能把 12 列闭合。
        span: 12,
        naturalHeight: true,
        children: actionsChildren(),
      }),
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

  // 朗读桥的一句话现状：能读到状态就说状态，读不到就说读不到（不编数字）。
  function ttsGuideNote() {
    var tts = state.tts
    if (state.errors.tts) return '读不到朗读桥'
    if (!tts || !tts.ok) return '朗读桥没在运行'
    return tts.auto ? '自动朗读：开' : '自动朗读：关'
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
          // 当前选中的那个前面加「·」：点完看不出现在是哪个，等于让人靠记忆。
          h('div', { class: 'fw-btn-row', style: 'margin-top:0' }, [
            quietButton((currentTheme() === 'light' ? '· ' : '') + '浅色', function () { setTheme('light') }),
            quietButton((currentTheme() === 'dark' ? '· ' : '') + '深色', function () { setTheme('dark') }),
            quietButton((currentTheme() === '' ? '· ' : '') + '跟随系统', function () { setTheme('') }),
          ]),
          h('p', {
            class: 'fw-row-hint',
            text: '选择会记住；「跟随系统」跟着系统的浅色/深色走（存在 dshcp.theme）。',
          }),
        ],
      }),
      // 朗读桥的设置不在我们这边：它的「听谁 / 自动朗读 / 收藏」都在它自己的右下角卡片里。
      // 这里如实说明入口在哪，不假装我们能改它。
      // 这张和下面「鱼的风格」都是「另一个插件的设置在哪」：8+4 同一行，跨度闭合到 12。
      card({
        key: 'tts-guide',
        title: '朗读桥在哪里设置',
        note: ttsGuideNote(),
        span: 8,
        children: [
          h('p', { class: 'fw-card-note', text: '朗读桥是另一个插件（dsh-tts-bridge）。鱼的世界只能看它的状态、开关它那张小卡片的显隐，改不了它的设置。' }),
          h('div', { class: 'fw-plainlist' }, [
            h('p', { class: 'fw-plainlist-item', text: '管「听哪些会话」「自动朗读」：右键点右下角「🐳 朗读桥」小卡片上的「听谁」；按住状态行 0.6 秒切换自动朗读。' }),
            h('p', { class: 'fw-plainlist-item', text: '它的设置与收藏存在 <DSH_HOME>/.dsh/tts-bridge.json。' }),
            h('p', { class: 'fw-plainlist-item', text: '没看到那张小卡片：说明朗读桥没在跑，重启 DSH；还没装就去插件市场搜「朗读桥」。' }),
          ]),
        ],
      }),
      // 说话风格同理：规则与设置都在 dsh-fish-tone 自己那边，这里只读它现在哪一档。
      card({
        key: 'tone',
        title: '鱼的风格',
        note: state.tone && state.tone.installed === false ? '未安装' : '读数来自 dsh-fish-tone',
        span: 4,
        children: toneChildren(),
      }),
      // 「本地存储」与上面几张同属运维：文件落在哪、留了什么。
      // 它原来在「鱼的成长」页，但那里讲的是「鱼想明白了什么」，不是磁盘。
      activityCard(),
      // 这两句原来挂在侧栏底部，每一页都看得到；它们只和「鱼的日记」与项目本身有关。
      // 放在本页最后（主人 2026-10-27：「关于的卡片置底」）——它是收尾说明，不该插在运维内容中间。
      card({
        key: 'about',
        title: '关于',
        note: '日记与本项目的说明',
        span: 12,
        pinLast: true,
        children: [
          h('p', { class: 'fw-card-note', text: '日记由鱼自己写；这里只支持主人查看和批阅（查看与阅览并对日记内容批语）。' }),
          h('p', { class: 'fw-card-note', text: '请注意，本项目为 AI 许愿产物。' }),
        ],
      }),
    ]
  }

  function button(label, onClick, variant) {
    // 主按钮带上类名 fw-btn-primary：只靠 data-variant 选，读代码时看不出层级。
    var b = h('button', {
      class: 'fw-btn' + (variant === 'primary' ? ' fw-btn-primary' : ' fw-btn-ghost'),
      type: 'button',
      dataset: variant ? { variant: variant } : {},
      text: label,
    })
    b.addEventListener('click', onClick)
    return b
  }

  function setTheme(value) {
    // 存的键跟其它面板开关同一个前缀；空串 = 跟随系统（把这个键删掉）。
    try {
      if (value) localStorage.setItem('dshcp.theme', value)
      else localStorage.removeItem('dshcp.theme')
    } catch (e) {}
    applyTheme(value)
    render()
  }

  /** 把主题落到 <html> 上。value 空 = 跟随系统（去掉属性，交给 prefers-color-scheme）。 */
  function applyTheme(value) {
    if (value) document.documentElement.setAttribute('data-theme', value)
    else document.documentElement.removeAttribute('data-theme')
  }

  /** 启动时把上次选的主题接回来：原来只 setAttribute 不落盘，刷新一下选择就没了。 */
  function restoreTheme() {
    var saved = ''
    try {
      saved = localStorage.getItem('dshcp.theme') || ''
    } catch (e) {
      saved = ''
    }
    if (saved === 'light' || saved === 'dark') applyTheme(saved)
    return saved
  }

  function currentTheme() {
    try {
      var saved = localStorage.getItem('dshcp.theme') || ''
      return saved === 'light' || saved === 'dark' ? saved : ''
    } catch (e) {
      return ''
    }
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
    // dsh-feiyu-mood 0.6.0+ 支持多份心情：?key=<份 id> 指定看哪一份。
    // 不传就返回「最近在聊的那一份」。切换时把选中的份记在 state.moodKey 里，
    // 重新拉一次再重画 —— 别在前端自己挑数据，真源在上游。
    var q = state.moodKey ? '?key=' + encodeURIComponent(state.moodKey) : ''
    return getJSON('/dsh-feiyu-mood/state' + q)
      .then(function (d) {
        state.mood = d
        // 上游可能把我们指的份换成了它自己解析出来的那份（老界面传会话 id 也认），以它回的 key 为准。
        if (d && d.key) state.moodKey = d.key
        markLoaded('mood')
      })
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

  // 空间额度各桶的中文名：面板与后端 quotaKind 同名（post / like / comment / reply）。
  var QZONE_USAGE_LABELS = { post: '发帖', like: '点赞', comment: '评论', reply: '回复' }

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

  // 图片整理的视觉接口配置：读一次就够，改动后由保存动作再拉。
  function loadStickerVision() {
    return getJSON('/dsh-fish-world/stickers/vision')
      .then(function (d) { state.stickerVision = d; markLoaded('stickerVision') })
      .catch(function (e) { state.errors.stickerVision = e.message })
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

  function loadQzoneRuntime() {
    return getJSON('/dsh-fish-world/qzone/status')
      .then(function (d) { state.qzoneRuntime = d; markLoaded('qzoneRuntime') })
      .catch(function (e) { state.errors.qzoneRuntime = e.message })
      .then(render)
  }

  // 空间栏顶部的运行时事实：不靠主人回忆「她今天到底发过没有」。
  function qzoneRuntimeRows() {
    var s = state.qzoneRuntime
    var rows = []
    if (state.errors.qzoneRuntime) rows.push(statusLine('读取失败：' + state.errors.qzoneRuntime, 'error'))
    else if (!s) rows.push(statusLine('读取中…'))
    else if (s.ok === false) rows.push(statusLine(s.error || '空间状态读不到', 'error'))
    else {
      rows.push(infoRow('今天本机日记', s.diaryToday === true ? '写过' : (s.diaryToday === false ? '还没写' : '读不到（世界未绑定）')))
      rows.push(infoRow('今天空间日记', s.diaryPostedToday === true ? '已发过一条' : '还没发', { level: s.diaryPostedToday === true ? 'ok' : 'neutral' }))
      var usage = (s.usage && s.usage.byKind) || {}
      rows.push(infoRow('今日剩余额度', ['post', 'like', 'comment', 'reply'].map(function (k) {
        var item = usage[k] || {}
        return QZONE_USAGE_LABELS[k] + ' ' + (item.remaining == null ? '—' : item.remaining) + (item.limit ? '/' + item.limit : '')
      }).join(' · ')))
      if (s.diaryDueReason) rows.push(statusLine(s.diaryDueReason))
    }
    return rows
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

  // ---------- 整合范围 / 记忆 / 时间线 / 花费 / 主动开口 ----------
  // 全部只读，读失败就把原因记进 state.errors（卡片上如实写），不退回默认值。

  function loadHub() {
    return getJSON('/dsh-fish-world/hub')
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.hub = d
        delete state.errors.hub
        markLoaded('hub')
      })
      .catch(function (e) { state.errors.hub = e.message })
      .then(render)
  }

  /** 操作时间线：按身份与天数筛，参数与后端路由一致。 */
  function loadActions() {
    var role = state.actionsRole || ''
    var days = Number(state.actionsDays) > 0 ? Number(state.actionsDays) : 7
    return getJSON('/dsh-fish-world/actions?days=' + days + (role ? '&role=' + encodeURIComponent(role) : ''))
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.actions = d
        delete state.errors.actions
        markLoaded('actions')
      })
      .catch(function (e) { state.errors.actions = e.message })
      .then(render)
  }

  /**
   * 试召回：问一句，看会想起哪几条。
   * 后端把预览放在 recallPreview 里（也可能直接给一句 recall / 一段 text），
   * 这里连响应一起留在 state，画的时候再按实际形状取（见 recallPreviewNodes）。
   */
  function loadRecall(query) {
    var q = String(query || '').trim()
    delete state.errors.recall
    return getJSON('/dsh-fish-world/memory?recall=' + encodeURIComponent(q))
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.recallPreview = (d && (d.recallPreview || d.recall)) || null
      })
      .catch(function (e) { state.errors.recall = e.message })
      .then(render)
  }

  /** 记忆便签：同一批记忆换成真正写进提示词的样子。 */
  function loadBrief(query) {
    var q = String(query || '').trim()
    delete state.errors.brief
    return getJSON('/dsh-fish-world/memory?brief=1&recall=' + encodeURIComponent(q))
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.briefPreview = (d && (d.briefPreview || d.brief)) || null
      })
      .catch(function (e) { state.errors.brief = e.message })
      .then(render)
  }

  /** 养鱼花费：后端已经把上游 state 裁成三档 + 前 5 个模型。 */
  function loadCost() {
    return getJSON('/dsh-fish-world/cost')
      .then(function (d) {
        state.cost = d
        delete state.errors.cost
        markLoaded('cost')
      })
      .catch(function (e) { state.errors.cost = e.message })
      .then(render)
  }

  /** 记忆账本（/memory）：三处记忆读成一张表，另有并库草稿与召回预览的入口。 */
  function loadMemoryHub() {
    return getJSON('/dsh-fish-world/memory')
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.memoryHub = d
        markLoaded('memoryHub')
      })
      .catch(function (e) { state.errors.memoryHub = e.message })
      .then(render)
  }

  /** 每日记忆摘要（/memory-digest）：状态 + 重建 + 开关。 */
  function loadMemoryDigest() {
    return getJSON('/dsh-fish-world/memory-digest')
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.memoryDigest = d
        delete state.errors.memoryDigest
        markLoaded('memoryDigest')
      })
      .catch(function (e) { state.errors.memoryDigest = e.message })
      .then(render)
  }

  /** 鱼手上的动作清单：跟账本对过一遍，标出哪些背后缺插件。 */
  function loadHubTools() {
    return getJSON('/dsh-fish-world/hub/tools')
      .then(function (d) {
        if (d && d.ok === false) throw new Error(d.error || '读取失败')
        state.hubTools = d
        markLoaded('hubTools')
      })
      .catch(function (e) { state.errors.hubTools = e.message })
      .then(render)
  }

  /** 鱼主动开口：只读 dsh-speak-up 的配置（面板不写那个文件）。 */
  function loadSpeakUp() {
    return getJSON('/dsh-fish-world/speak-up')
      .then(function (d) {
        state.speakUp = d
        delete state.errors.speakUp
        markLoaded('speakUp')
      })
      .catch(function (e) { state.errors.speakUp = e.message })
      .then(render)
  }

  /** 鱼的风格：只读 dsh-fish-tone 的档位（面板不写它的配置）。 */
  function loadTone() {
    return getJSON('/dsh-fish-world/tone')
      .then(function (d) {
        state.tone = d
        delete state.errors.tone
        markLoaded('tone')
      })
      .catch(function (e) { state.errors.tone = e.message })
      .then(render)
  }

  function loadView(view) {
    if (view === 'overview') {
      // 总览按面板列表展示所有内容，所以要一次性把各分区的数据都拉回来。
      // loadActions 放最后：总览开头那句人话要用今天的动作计数。
      return Promise.all([
        loadMood(), loadTts(), loadDiary(), loadEnv(), loadCapabilities(),
        loadWishes(), loadGrowth(), loadPlatforms(), loadProfile(),
        loadStickers(), loadQzone(), loadExtensions(), loadAstrbot(), loadQQAgent(),
        loadActions(),
      ])
    }
    if (view === 'diary') return loadDiary()
    // 状态页两张新卡：养鱼花费 + 鱼主动开口（各读一条只读路由）。
    if (view === 'status') return Promise.all([loadMood().then(loadPortrait), loadCost(), loadSpeakUp()])
    if (view === 'wishes') return Promise.all([loadWishes(), loadRecords(), loadStickerWishes()])
    if (view === 'growth') return Promise.all([loadGrowth(), loadActivity()])
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
      // 整合范围卡也在这页：要 /hub 的 scope。
      loadHub(),
    ]).then(render)
    if (view === 'profile') return Promise.all([loadProfile(), loadPersona(), loadStorage()])
    // qzoneRuntime 也要一起读：空间栏要说清「今天写过日记没、发过没、额度还剩多少」。
    if (view === 'platforms') return Promise.all([loadPlatforms(), loadAstrbot(), loadActivity(), loadStorage(), loadQQChat(), loadQzoneRuntime()])
    // 鱼的记忆：知识库 + 图片整理 + 图片收藏 + 网站链接，四块各读一次；
    // 再加记忆中枢（记忆账本 / 并库 / 试召回）与操作时间线（审计）。
    if (view === 'memory') return Promise.all([loadKnowledge(), loadStickerVision(), loadStickers(), loadStickerDir(), loadLinks(), loadStorage(), loadMemoryHub(), loadMemoryDigest(), loadActions()])
    if (view === 'stickers') return Promise.all([loadKnowledge(), loadStickerVision(), loadStickers(), loadStickerDir(), loadLinks(), loadStorage(), loadMemoryDigest()])
    // 整合包页：插件账本 + 记忆账本 + 操作时间线 + 鱼手上的动作清单。
    if (view === 'hub') return Promise.all([loadHub(), loadMemoryHub(), loadActions(), loadHubTools()])
    if (view === 'qzone') return loadQzone()
    // 设置与更多里也有「本地存储」卡：留存与请求历史都要读。
    // 「朗读桥在哪里设置」那张卡要读它的状态，所以这一页也拉一次 tts。
    // 「鱼的风格」要读 dsh-fish-tone 的档位，同一页一起拉。
    if (view === 'extensions') return Promise.all([loadExtensions(), loadActivity(), loadWishes(), loadTts(), loadTone()])
    return Promise.resolve()
  }

  // ---------- 渲染 ----------
  var main = null
  var nav = null

  function navigate(view) {
    var changed = state.view !== view
    state.view = view
    // 记住这一页：下次进鱼世界直接从这儿开始，不再每次回到总览。
    writePanelView(view)
    // 批量选择只属于「鱼的记忆」这一屏：换页就清空，免得回来时对着看不见的勾选删图。
    if (changed) {
      state.stickerSelected = []
      state.stickerBatchMsg = null
      state.stickerBatchConfirm = false
      state.stickerBatchBusy = ''
    }
    // 每次「进入」分区都重抽一次卡片上的鱼话；同一屏内重绘不换字
    if (changed) reshuffleFishLines()
    if (nav) {
      Array.prototype.forEach.call(nav.children, function (child) {
        // 组标题没有 dataset.view，跳过，免得给它盖上 aria-current="false"
        if (!child.dataset || !child.dataset.view) return
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
    if (state.view === 'profile') return viewProfile()
    if (state.view === 'memory') return viewMemory()
    // 兼容旧的 stickers 入口（历史存档 / 旧链接点到它时仍落到记忆页）
    if (state.view === 'stickers') return viewMemory()
    // 整合包：插件账本 + 谁在做同一件事（整合范围与记忆中枢在别的页）
    if (state.view === 'hub') return viewHub()
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
    // 缩放把手要在量高度之前挂上：它是卡片的一部分，免得量完再挂多出一截。
    attachResizeHandles(main)
    // 位置由数据算：先量高度再排布，卡片绝对定位，刷新后就是设计好的 Bento 布局
    relayout(main, { animate: false })
    updateRailName()
    // 打开着的抽屉（比如 AstrBot 接入）也要跟着刷新，否则操作完还显示旧状态。
    if (drawerRebuild) drawerRebuild()
  }

  function build() {
    var stage = document.getElementById('app')
    if (!stage) return

    nav = h('nav', { class: 'fw-nav', 'aria-label': '鱼世界分区' })
    var lastGroup = ''
    NAV.forEach(function (item) {
      // 组标题只做视觉分组，不是可点项，也不参与 aria-current
      if (item.group && item.group !== lastGroup) {
        nav.appendChild(h('span', { class: 'fw-nav-group', text: item.group }))
        lastGroup = item.group
      }
      var b = h('button', {
        class: 'fw-nav-item',
        type: 'button',
        dataset: { view: item.id },
        'aria-current': item.id === state.view ? 'true' : 'false',
        title: item.label,
      }, [navIcon(item.id), item.label])
      b.addEventListener('click', function () { navigate(item.id) })
      nav.appendChild(b)
    })

    var rail = h('aside', { class: 'fw-rail' }, [
      h('h1', { class: 'fw-rail-title' }, [
        h('span', { class: 'fw-rail-mark', text: '🐟', 'aria-hidden': 'true' }),
        h('span', { class: 'fw-rail-name', text: state.profile && state.profile.fish && state.profile.fish.name ? state.profile.fish.name : '鱼的世界' }),
      ]),
      nav,
    ])

    main = h('div', { class: 'fw-main' })
    // 设置页 iframe 自带外框留白，内容区留白收紧一点即可
    if (SETTINGS_MODE) main.dataset.compact = 'true'
    stage.appendChild(h('div', { class: 'fw-shell' }, [rail, main]))

    bindDragAndDrop(main)

    // 默认「全部日期」：直接看到所有日记，而不是先碰上一个空的“今天”
    state.diaryDate = ''
    restoreTheme()
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
