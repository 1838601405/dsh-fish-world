// dsh-fish-world 面板 —— Harness 设置页「鱼的世界」与主界面右侧面板共用同一份 UI。
;(function () {
  'use strict'
  if (window.__dshcpInited) return
  window.__dshcpInited = true
  var SETTINGS_MODE = window.__DSH_FISH_WORLD_SETTINGS_MODE__ === true
  var FLOATING_MODE = window.__DSH_FISH_WORLD_FLOATING_MODE__ === true

  var LS = 'dshcp.'
  function lsGet(k, dflt) { try { var v = localStorage.getItem(LS + k); return v == null ? dflt : v === '1' } catch (e) { return dflt } }
  function lsSet(k, v) { try { localStorage.setItem(LS + k, v ? '1' : '0'); sync(k) } catch (e) {} }
  function lsGetRaw(k, dflt) { try { var v = localStorage.getItem(LS + k); return v == null ? dflt : v } catch (e) { return dflt } }
  function lsSetRaw(k, v) { try { localStorage.setItem(LS + k, String(v)); sync(k) } catch (e) {} }
  function lsNumber(k, dflt, min, max) {
    var n = Number(lsGetRaw(k, ''))
    if (!Number.isFinite(n) || n < min) return dflt
    return Math.min(n, max)
  }

  // 同一源的多窗口/多 iframe 需要实时同步开关，否则在 Harness 设置页改 showTts
  // 不会立刻影响主界面；通过 BroadcastChannel + storage 事件双保险。
  var broadcast = null
  try { broadcast = new BroadcastChannel('dshcp.sync') } catch (e) {}
  function sync(key) {
    try {
      if (broadcast) broadcast.postMessage({ key: key })
      window.dispatchEvent(new StorageEvent('storage', { key: LS + key }))
    } catch (e) {}
  }
  function onStorageSync(handler) {
    window.addEventListener('storage', function (e) { if (e.key && e.key.indexOf(LS) === 0) handler(e.key.slice(LS.length)) })
    if (broadcast) broadcast.onmessage = function (e) { if (e.data && e.data.key) handler(e.data.key) }
  }

  var SHOW_MOOD = lsGet('showMood', false)
  var SHOW_TTS = lsGet('showTts', false)
  // 「设置 → 鱼的世界」入口不再可隐藏：它是恢复其它挂件的唯一入口，隐藏它会让
  // 用户无法再打开本页。旧版本写入的 dshcp.showSettings='0' 在这里纠正回来。
  if (lsGetRaw('showSettings', '') === '0') lsSet('showSettings', true)
  // 原来这里有一段 migrationWhaleVisible：把被旧版误藏的鲸鱼恢复出来。
  // 解耦后我们根本不碰鲸鱼，这段只剩一个有害副作用 —— 用户手动打开过的
  // 心情挂饰会被它强制关掉一次。已删除；showMood 的默认值本来就是 false。

  var DIM_COLORS = {
    happy: '#5ddc8a', calm: '#7aaadc', sweet: '#e28fc0',
    heartache: '#e0b070', worry: '#e8a25b', sad: '#7a96c8', jealous: '#c88fdc'
  }
  var DIM_KEYS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']
  var DIM_LABELS = { happy: '开心', calm: '踏实', sweet: '甜蜜', heartache: '心疼', worry: '担心', sad: '难过', jealous: '吃醋' }

  var CSS = [
    '.dshcp-root{display:none;position:fixed;z-index:2147483002;width:340px;max-width:calc(100vw - 24px);max-height:72vh;overflow:auto;',
    'background:rgba(22,23,28,.96);color:#e8e8ea;border:1px solid rgba(128,128,128,.28);border-radius:14px;',
    'box-shadow:0 8px 30px rgba(0,0,0,.5);padding:12px;font:13px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'user-select:none;cursor:grab;transition:opacity .15s}',
    '.dshcp-root.dshcp-open{display:block}',
    '.dshcp-root.dshcp-drag{cursor:grabbing;transition:none}',
    '.dshcp-resize{position:fixed;z-index:2147483004;width:16px;height:16px;cursor:nwse-resize;touch-action:none;display:none}',
    '.dshcp-resize::after{content:"";position:absolute;right:4px;bottom:4px;width:8px;height:8px;border-right:2px solid #8a93a0;border-bottom:2px solid #8a93a0;border-radius:0 0 3px 0}',
    '.dshcp-resize-left{cursor:nesw-resize}',
    '.dshcp-resize-left::after{right:auto;left:4px;border-right:0;border-left:2px solid #8a93a0;border-radius:0 0 0 3px}',
    '.dshcp-resize:hover::after{border-color:#c9cdd3}',
    '.dshcp-launcher{display:grid;place-items:center;touch-action:none;cursor:grab}',
    '.dshcp-launcher.dshcp-drag{cursor:grabbing}',
    '.dshcp-launcher-open{opacity:.85}',
    '.dshcp-head{display:flex;align-items:center;gap:10px;font-weight:700;color:#c9d6ff}',
    '.dshcp-title{font-size:13px}',
    '.dshcp-env{display:none;margin-top:8px;padding:8px 10px;border:1px solid rgba(232,162,91,.5);border-left:3px solid #e8a25b;',
    'border-radius:9px;background:rgba(232,162,91,.14);color:#f4e7d6;font-size:13px;line-height:1.5;cursor:auto}',
    '.dshcp-env.dshcp-open{display:block}',
    '.dshcp-env-title{font-weight:700;color:#f7dcb4}',
    '.dshcp-env-body{margin-top:4px;white-space:pre-wrap;word-break:break-word}',
    '.dshcp-env-fix{margin-top:6px;color:#d7dde6;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all}',
    '.dshcp-env-actions{display:flex;align-items:center;gap:8px;margin-top:8px}',
    '.dshcp-env-note{color:#b9c0c9;font-size:12px}',
    '.dshcp-close{margin-left:auto;border:0;background:transparent;color:#aeb4bd;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px}',
    '.dshcp-close:hover{color:#fff}',
    'border-radius:999px;background:rgba(20,22,30,.84);color:#f5f6fa;font:600 12px/1.4 system-ui,"Microsoft YaHei",sans-serif;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.28)}',
    '.dshcp-score{font-size:19px;font-weight:800;line-height:1.1}',
    '.dshcp-sub{font-size:11.5px;color:#9aa0a6;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dshcp-wait{margin-top:8px;padding:7px 9px;border-radius:9px;background:rgba(232,162,91,.16);border-left:3px solid #e8a25b;',
    'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none}',
    '.dshcp-sec{margin-top:8px;border-top:1px solid rgba(128,128,128,.16)}',
    '.dshcp-sech{display:flex;align-items:center;gap:6px;padding:7px 2px;cursor:pointer;font-weight:600;color:#c9cdd3}',
    '.dshcp-sech:hover{color:#fff}',
    '.dshcp-caret{transition:transform .15s;color:#8a93a0;font-size:10px}',
    '.dshcp-sec.dshcp-open .dshcp-caret{transform:rotate(90deg)}',
    '.dshcp-secb{display:none;padding:2px 2px 8px}',
    '.dshcp-sec.dshcp-open .dshcp-secb{display:block}',
    '.dshcp-row{display:flex;align-items:center;gap:8px;margin:4px 0}',
    '.dshcp-rowlabel{width:34px;flex:none;color:#9aa0a6;font-size:11px}',
    '.dshcp-bar{flex:1;height:7px;border-radius:4px;background:rgba(128,128,128,.2);overflow:hidden}',
    '.dshcp-bar i{display:block;height:100%}',
    '.dshcp-val{width:26px;text-align:right;color:#9aa0a6;font-size:11px;flex:none}',
    '.dshcp-btn{display:inline-block;margin:3px 6px 3px 0;padding:3px 9px;border-radius:7px;background:rgba(255,255,255,.13);',
    'color:#e8e8e8;cursor:pointer;font-size:11.5px;white-space:nowrap}',
    '.dshcp-btn:hover{background:rgba(255,255,255,.2)}',
    '.dshcp-btn.dshcp-on{background:rgba(93,220,138,.22);border:1px solid rgba(93,220,138,.5)}',
    '.dshcp-btn.dshcp-off{opacity:.6}',
    '.dshcp-item{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11.5px;border-bottom:1px solid rgba(128,128,128,.08)}',
    '.dshcp-item .dshcp-t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dshcp-check{width:14px;height:14px;flex:none;cursor:pointer}',
    '.dshcp-reason{font-size:11.5px;color:#b9b9b9;margin:4px 0;white-space:pre-wrap;max-height:64px;overflow:hidden;cursor:pointer}',
    '.dshcp-reason.dshcp-full{max-height:none}',
    '.dshcp-foot{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,.16)}',
    '.dshcp-gear{margin-left:auto;cursor:pointer;color:#9aa0a6;font-size:12px;padding:2px 6px;border-radius:6px}',
    '.dshcp-gear:hover{color:#fff;background:rgba(255,255,255,.08)}',
    '.dshcp-gearpop{display:none;position:absolute;right:0;bottom:100%;margin-bottom:6px;width:230px;background:#1b1c1f;',
    'border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);cursor:auto}',
    '.dshcp-gearpop.dshcp-open{display:block}',
    '.dshcp-gearline{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px}',
    '.dshcp-switch{margin-left:auto;position:relative;width:34px;height:18px;border-radius:10px;background:rgba(128,128,128,.35);cursor:pointer;transition:background .15s}',
    '.dshcp-switch.dshcp-on{background:rgba(93,220,138,.6)}',
    '.dshcp-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}',
    '.dshcp-switch.dshcp-on::after{left:18px}',
    '.dshcp-empty{font-size:11.5px;color:#8a93a0;padding:4px 0}',
    '.dshcp-market-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0 8px}',
    '.dshcp-input,.dshcp-select,.dshcp-textarea{box-sizing:border-box;max-width:100%;border:1px solid rgba(128,128,128,.3);border-radius:7px;background:rgba(0,0,0,.22);color:#e8e8ea;padding:6px 8px;font:12px/1.4 system-ui,sans-serif}',
    '.dshcp-input{min-width:90px;flex:1}.dshcp-select{min-width:88px}',
    '.dshcp-textarea{width:100%;min-height:68px;resize:vertical;font-family:ui-monospace,Consolas,monospace}',
    '.dshcp-card{padding:8px 0;border-bottom:1px solid rgba(128,128,128,.12)}',
    '.dshcp-cardtitle{font-weight:650;word-break:break-word}.dshcp-cardmeta{font-size:10.5px;color:#8a93a0;margin:2px 0}',
    '.dshcp-carddesc{font-size:11px;color:#aeb4bd;white-space:pre-wrap;max-height:48px;overflow:hidden;margin:4px 0}',
    '.dshcp-carddesc.dshcp-full{max-height:240px;overflow:auto}',
    '.dshcp-field{margin:8px 0}.dshcp-field label{display:block;font-size:11.5px;color:#c9cdd3;margin-bottom:3px}',
    '.dshcp-field small{display:block;font-size:10.5px;color:#8a93a0;margin-top:2px}',
    '.dshcp-field input[type="text"],.dshcp-field input[type="password"],.dshcp-field input[type="number"]{box-sizing:border-box;width:100%;border:1px solid rgba(128,128,128,.3);border-radius:7px;background:rgba(0,0,0,.22);color:#e8e8ea;padding:6px 8px}',
    '.dshcp-status{font-size:11px;color:#9aa0a6;min-height:17px;margin:4px 0}',
    '.dshcp-dragbar{cursor:grab}',
    '.dshcp-grow{flex:1;min-width:0}',
    '.dshcp-sticker-thumb{flex:none}'
  ].join('')

  var style = document.createElement('style')
  style.setAttribute('data-plugin-css', 'dsh-fish-world')
  style.textContent = CSS
  document.head.appendChild(style)

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function elImg(src, cls) {
    var n = document.createElement('img')
    n.src = src
    n.className = cls || ''
    n.draggable = false
    return n
  }

  // ---- 数据 ----
  function getJSON(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status)
      return r.json()
    })
  }
  function postJSON(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  var state = { mood: null, tts: null }

  // ---- 面板骨架 ----
  var root = el('div', 'dshcp-root')
  var gearWrap = el('div')
  gearWrap.style.position = 'relative'
  gearWrap.style.marginLeft = 'auto'

  var head = el('div', 'dshcp-head')
  head.appendChild(el('span', 'dshcp-title', SETTINGS_MODE ? '鱼的世界' : '🐟 鱼的世界'))
  var closeBtn = el('button', 'dshcp-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', '关闭管理面板')
  head.appendChild(closeBtn)

  // ---- 环境提示条：只有缺前置插件 / 接线异常时才出现 ----
  var envBar = el('div', 'dshcp-env')
  var envTitle = el('div', 'dshcp-env-title')
  var envBody = el('div', 'dshcp-env-body')
  var envFix = el('div', 'dshcp-env-fix')
  var envActions = el('div', 'dshcp-env-actions')
  var envRecheck = el('span', 'dshcp-btn', '重新检查')
  var envNote = el('span', 'dshcp-env-note', '')
  envActions.appendChild(envRecheck)
  envActions.appendChild(envNote)
  envBar.appendChild(envTitle)
  envBar.appendChild(envBody)
  envBar.appendChild(envFix)
  envBar.appendChild(envActions)

  var envState = { busy: false, timer: 0 }
  function renderEnv(env) {
    if (!env || env.ok !== false) {
      envBar.classList.remove('dshcp-open')
      envTitle.textContent = ''
      envBody.textContent = ''
      envFix.textContent = ''
      return
    }
    var warnings = env.warnings || []
    var hints = env.hints || []
    envTitle.textContent = '⚠ 运行环境需要处理（' + warnings.length + ' 项）'
    envBody.textContent = warnings.join('\n')
    envFix.textContent = hints.map(function (item) { return item.command || item.label }).join('\n')
    envBar.classList.add('dshcp-open')
  }
  function refreshEnv(force) {
    if (envState.busy) return
    envState.busy = true
    if (force) envNote.textContent = '检查中…'
    var request = force ? postJSON('/dsh-fish-world/env', {}) : getJSON('/dsh-fish-world/env')
    request.then(function (result) {
      renderEnv(result && result.environment)
      if (force) envNote.textContent = result && result.environment && result.environment.ok ? '已就绪' : '仍有待处理项'
    }).catch(function () {
      if (force) envNote.textContent = '检查失败，请稍后重试'
    }).then(function () { envState.busy = false })
  }
  envRecheck.addEventListener('click', function (e) { e.stopPropagation(); refreshEnv(true) })

  function makeSection(title) {
    var sec = el('div', 'dshcp-sec')
    var h = el('div', 'dshcp-sech')
    h.appendChild(el('span', 'dshcp-caret', '▶'))
    h.appendChild(el('span', null, title))
    var b = el('div', 'dshcp-secb')
    sec.appendChild(h)
    sec.appendChild(b)
    h.addEventListener('click', function () { sec.classList.toggle('dshcp-open') })
    return { sec: sec, body: b }
  }

  var moodSec = makeSection('鱼的状态')
  var ttsSec = makeSection('朗读桥')
  var extensionSec = makeSection('QQ Agent 扩展与设置')
  var diarySec = makeSection('鱼的日记')
  var wishSec = makeSection('鱼的请求')
  var growthSec = makeSection('鱼的成长')
  var doctorSec = makeSection('体检与更新')
  var platformSec = makeSection('鱼与世界')
  var profileSec = makeSection('鱼的设定')
  var stickerSec = makeSection('鱼之宝库')
  var qzoneSec = makeSection('QQ 空间互动额度')
  if (SETTINGS_MODE) {
    moodSec.sec.classList.add('dshcp-open')
    extensionSec.sec.classList.add('dshcp-open')
    diarySec.sec.classList.add('dshcp-open')
    stickerSec.sec.classList.add('dshcp-open')
    qzoneSec.sec.classList.add('dshcp-open')
  }

  var extState = { view: 'installed', kind: 'plugin', installed: [], catalog: { built_in: [], plugins: [], skills: [] }, busy: false, links: [], notice: '', sourceUrl: '' }
  var extTabs = el('div', 'dshcp-market-tools')
  var marketTabBtn = el('span', 'dshcp-btn', '从链接安装')
  var installedTabBtn = el('span', 'dshcp-btn dshcp-on', '已安装')
  var extControls = el('div', 'dshcp-market-tools')
  var kindSelect = document.createElement('select')
  kindSelect.className = 'dshcp-select'
  kindSelect.appendChild(new Option('插件', 'plugin'))
  kindSelect.appendChild(new Option('技能', 'skill'))
  var searchInput = document.createElement('input')
  searchInput.className = 'dshcp-input'
  searchInput.type = 'url'
  searchInput.placeholder = '粘贴 ZIP 直链或 GitHub 仓库主页'
  var installBtn = el('span', 'dshcp-btn dshcp-on', '一键安装')
  var refreshExtBtn = el('span', 'dshcp-btn', '刷新')
  extControls.appendChild(kindSelect)
  extControls.appendChild(searchInput)
  extControls.appendChild(installBtn)
  extControls.appendChild(refreshExtBtn)
  var extStatus = el('div', 'dshcp-status')
  var catalogList = el('div')
  var marketList = el('div')
  var installedList = el('div')
  var settingsPane = el('div')
  extTabs.appendChild(marketTabBtn)
  extTabs.appendChild(installedTabBtn)
  extControls.style.display = 'none'
  installedList.style.display = 'none'
  settingsPane.style.display = 'none'
  extensionSec.body.appendChild(extTabs)
  extensionSec.body.appendChild(extControls)
  extensionSec.body.appendChild(extStatus)
  extensionSec.body.appendChild(catalogList)
  extensionSec.body.appendChild(marketList)
  extensionSec.body.appendChild(installedList)
  extensionSec.body.appendChild(settingsPane)
  extensionSec.body.style.maxHeight = '52vh'
  extensionSec.body.style.overflowY = 'auto'
  marketTabBtn.addEventListener('click', function () { setExtView('market') })
  installedTabBtn.addEventListener('click', function () { setExtView('installed') })
  kindSelect.addEventListener('change', function () { extState.kind = kindSelect.value; refreshMarket() })
  installBtn.addEventListener('click', installFromLink)
  searchInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') installFromLink() })
  refreshExtBtn.addEventListener('click', function () {
    if (extState.view === 'market') refreshMarket()
    else refreshInstalled()
  })
  extensionSec.sec.querySelector('.dshcp-sech').addEventListener('click', function () {
    if (extensionSec.sec.classList.contains('dshcp-open')) setExtView(extState.view)
  })

  var foot = el('div', 'dshcp-foot')
  var hintEl = el('span', 'dshcp-sub', SETTINGS_MODE
    ? '扩展设置与面板显示选项'
    : '设置 → 鱼的世界可打开完整管理页')
  var gearBtn = el('span', 'dshcp-gear', '⚙')
  gearWrap.appendChild(gearBtn)
  var gearPop = el('div', 'dshcp-gearpop')

  function gearLine(label, key) {
    var line = el('div', 'dshcp-gearline')
    line.appendChild(el('span', null, label))
    var sw = el('div', 'dshcp-switch')
    function apply() { sw.classList.toggle('dshcp-on', !!evalKey(key)); lsSet(key, evalKey(key)) }
    sw.addEventListener('click', function () { toggleKey(key); apply(); applyOriginals() })
    line.appendChild(sw)
    apply()
    return line
  }
  function evalKey(key) {
    if (key === 'showMood') return SHOW_MOOD
    if (key === 'showTts') return SHOW_TTS
    return false
  }
  function reloadKey(key) {
    if (key === 'showMood') SHOW_MOOD = lsGet('showMood', false)
    if (key === 'showTts') SHOW_TTS = lsGet('showTts', false)
  }
  function toggleKey(key) {
    if (key === 'showMood') SHOW_MOOD = !SHOW_MOOD
    else if (key === 'showTts') SHOW_TTS = !SHOW_TTS
  }

  function buildGearLines() {
    gearPop.textContent = ''
    gearPop.appendChild(gearLine('心情挂饰（.fm-widget）', 'showMood'))
    gearPop.appendChild(gearLine('显示朗读桥卡（默认关闭）', 'showTts'))
    gearPop.appendChild(el('div', 'dshcp-empty', '「设置 → 鱼的世界」入口始终保留，可从这里或该页面重新显示其它挂件。'))
  }
  buildGearLines()

  gearBtn.addEventListener('click', function (e) { e.stopPropagation(); gearPop.classList.toggle('dshcp-open') })
  foot.appendChild(hintEl)
  gearWrap.appendChild(gearPop)
  foot.appendChild(gearWrap)

  root.appendChild(head)
  root.appendChild(envBar)
  root.appendChild(moodSec.sec)
  root.appendChild(ttsSec.sec)
  root.appendChild(diarySec.sec)
  root.appendChild(wishSec.sec)
  root.appendChild(growthSec.sec)
  root.appendChild(doctorSec.sec)
  root.appendChild(platformSec.sec)
  root.appendChild(profileSec.sec)
  root.appendChild(stickerSec.sec)
  root.appendChild(qzoneSec.sec)
  root.appendChild(extensionSec.sec)
  root.appendChild(foot)
  document.body.appendChild(root)

  var resizeGrip = null
  if (!SETTINGS_MODE) {
    resizeGrip = el('div', 'dshcp-resize')
    resizeGrip.title = '拖动调整面板大小'
    root.appendChild(resizeGrip)
  }

  var floatingLauncher = null
  var launcherMoved = false
  var launcherDragEndAt = 0
  if (!SETTINGS_MODE && FLOATING_MODE) {
    floatingLauncher = document.createElement('button')
    floatingLauncher.type = 'button'
    floatingLauncher.className = 'dshcp-btn dshcp-on dshcp-launcher'
    floatingLauncher.textContent = '🐟'
    floatingLauncher.setAttribute('aria-label', '打开鱼世界面板')
    floatingLauncher.setAttribute('aria-expanded', 'false')
    floatingLauncher.style.position = 'fixed'
    floatingLauncher.style.right = '16px'
    floatingLauncher.style.bottom = '72px'
    floatingLauncher.style.width = '44px'
    floatingLauncher.style.height = '44px'
    floatingLauncher.style.padding = '0'
    floatingLauncher.style.borderRadius = '999px'
    floatingLauncher.style.zIndex = '2147483003'
    var savedLeft = lsGetRaw('launcherLeft', '')
    var savedTop = lsGetRaw('launcherTop', '')
    var launcherLeft = Number(savedLeft)
    var launcherTop = Number(savedTop)
    if (savedLeft !== '' && savedTop !== '' && Number.isFinite(launcherLeft) && Number.isFinite(launcherTop)) {
      var launcherSize = 44
      floatingLauncher.style.left = Math.max(8, Math.min(window.innerWidth - launcherSize - 8, launcherLeft)) + 'px'
      floatingLauncher.style.top = Math.max(8, Math.min(window.innerHeight - launcherSize - 8, launcherTop)) + 'px'
      floatingLauncher.style.right = 'auto'
      floatingLauncher.style.bottom = 'auto'
      launcherMoved = true
    }
    document.body.appendChild(floatingLauncher)
  }

  if (SETTINGS_MODE) {
    root.classList.add('dshcp-open')
    root.style.position = 'relative'
    root.style.left = 'auto'
    root.style.top = 'auto'
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    root.style.width = '100%'
    root.style.maxWidth = 'none'
    root.style.maxHeight = 'none'
    root.style.margin = '0'
    root.style.boxSizing = 'border-box'
    root.style.background = 'transparent'
    root.style.border = '0'
    root.style.boxShadow = 'none'
    root.style.padding = '4px'
    root.style.cursor = 'default'
    closeBtn.style.display = 'none'
    // Keep the gear available in Harness Settings too: the main-page panel may
    // be absent or hidden, but users must always be able to restore its widgets.
    foot.style.display = 'flex'
  }

  function maxPanelHeight() {
    // Keep the floating launcher reachable at its default bottom-right spot.
    var reserve = floatingLauncher && !launcherMoved ? 140 : 32
    return Math.max(240, window.innerHeight - reserve)
  }
  // The panel scrolls its own content, so the grip is viewport-fixed and follows
  // the panel's bottom-right corner instead of scrolling away with the content.
  function positionResizeGrip() {
    if (!resizeGrip) return
    if (!root.classList.contains('dshcp-open')) {
      resizeGrip.style.display = 'none'
      return
    }
    var rect = root.getBoundingClientRect()
    var dockedRight = root.style.right && root.style.right !== 'auto'
    resizeGrip.style.display = 'block'
    resizeGrip.classList.toggle('dshcp-resize-left', !!dockedRight)
    // Grow away from the docked edge: a right-docked panel is resized from its
    // bottom-left grip, otherwise from the bottom-right one.
    resizeGrip.style.left = Math.round(dockedRight ? rect.left + 2 : rect.right - 18) + 'px'
    resizeGrip.style.top = Math.round(rect.bottom - 18) + 'px'
  }
  function updateLauncherState() {
    if (!floatingLauncher) return
    var open = root.classList.contains('dshcp-open')
    floatingLauncher.setAttribute('aria-expanded', open ? 'true' : 'false')
    floatingLauncher.setAttribute('aria-label', open ? '关闭鱼世界面板' : '打开鱼世界面板')
    floatingLauncher.classList.toggle('dshcp-launcher-open', open)
  }
  function closeManager() {
    root.classList.remove('dshcp-open')
    updateLauncherState()
    positionResizeGrip()
  }
  function openManager() {
    var maxWidth = Math.max(320, window.innerWidth - 24)
    var maxHeight = maxPanelHeight()
    var width = Math.min(lsNumber('panelWidth', 500, 320, maxWidth), maxWidth)
    // No saved height: let the content size itself, capped above the launcher.
    var height = lsNumber('panelHeight', 0, 240, maxHeight)
    root.style.width = width + 'px'
    root.style.boxSizing = 'border-box'
    root.style.maxHeight = maxHeight + 'px'
    if (height) {
      root.style.height = height + 'px'
      root.style.maxHeight = height + 'px'
    } else {
      root.style.height = 'auto'
    }
    // Anchor the default position to the right edge. Computing `left` from
    // window.innerWidth at load time stranded the panel mid-page whenever the
    // host laid out a narrower viewport first and then resized.
    root.style.left = 'auto'
    root.style.right = '16px'
    root.style.top = '16px'
    root.style.bottom = 'auto'
    root.classList.add('dshcp-open')
    updateLauncherState()
    refreshMood()
    refreshTts()
    refreshEnv(false)
    positionResizeGrip()
  }
  window.addEventListener('resize', function () {
    if (!root.classList.contains('dshcp-open')) return
    var maxWidth = Math.max(320, window.innerWidth - 24)
    if (root.getBoundingClientRect().width > maxWidth) root.style.width = maxWidth + 'px'
    positionResizeGrip()
    if (root.style.right && root.style.right !== 'auto') return
    var width = root.getBoundingClientRect().width || 0
    var left = parseFloat(root.style.left || '0')
    if (Number.isFinite(left)) {
      root.style.left = Math.max(12, Math.min(window.innerWidth - width - 12, left)) + 'px'
    }
  })
  closeBtn.addEventListener('click', function (e) { e.stopPropagation(); closeManager() })
  if (floatingLauncher) {
    floatingLauncher.addEventListener('click', function () {
      // Ignore the click that the browser emits at the end of a drag.
      if (Date.now() - launcherDragEndAt < 400) return
      if (root.classList.contains('dshcp-open')) closeManager()
      else openManager()
    })
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeManager() })
    openManager()
  }

  // ---- 拖动（拖 bar 与空白处，不抢按钮/折叠区的点击）----
  ;(function () {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0
    function onDown(e) {
      var t = e.target
      if (t && (t.closest('.dshcp-sech') || t.closest('.dshcp-btn') || t.closest('.dshcp-switch') || t.closest('.dshcp-item') || t.closest('.dshcp-gear') || t.closest('.dshcp-gearpop') || t.closest('.dshcp-reason') || t.closest('.dshcp-check') || t.closest('.dshcp-resize') || t.closest('.dshcp-env'))) return
      dragging = true
      sx = e.clientX; sy = e.clientY
      var r = root.getBoundingClientRect()
      ox = r.left; oy = r.top
      root.classList.add('dshcp-drag')
      e.preventDefault()
    }
    function onMove(e) {
      if (!dragging) return
      var x = Math.max(0, Math.min(window.innerWidth - 40, ox + (e.clientX - sx)))
      var y = Math.max(0, Math.min(window.innerHeight - 40, oy + (e.clientY - sy)))
      root.style.left = x + 'px'
      root.style.top = y + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      positionResizeGrip()
    }
    function onUp() { dragging = false; root.classList.remove('dshcp-drag') }
    root.addEventListener('pointerdown', onDown)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  })()

  // ---- 独立面板按钮：可拖动，拖动后点击仍能开关面板 ----
  ;(function () {
    if (!floatingLauncher) return
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0
    function onDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      dragging = true
      moved = false
      sx = e.clientX; sy = e.clientY
      var rect = floatingLauncher.getBoundingClientRect()
      ox = rect.left; oy = rect.top
      floatingLauncher.style.left = ox + 'px'
      floatingLauncher.style.top = oy + 'px'
      floatingLauncher.style.right = 'auto'
      floatingLauncher.style.bottom = 'auto'
      floatingLauncher.classList.add('dshcp-drag')
      try { floatingLauncher.setPointerCapture(e.pointerId) } catch (err) {}
      e.preventDefault()
    }
    function onMove(e) {
      if (!dragging) return
      var dx = e.clientX - sx
      var dy = e.clientY - sy
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true
      var size = floatingLauncher.offsetWidth || 44
      var x = Math.max(8, Math.min(window.innerWidth - size - 8, ox + dx))
      var y = Math.max(8, Math.min(window.innerHeight - size - 8, oy + dy))
      floatingLauncher.style.left = x + 'px'
      floatingLauncher.style.top = y + 'px'
    }
    function onUp(e) {
      if (!dragging) return
      dragging = false
      floatingLauncher.classList.remove('dshcp-drag')
      try { floatingLauncher.releasePointerCapture(e.pointerId) } catch (err) {}
      if (!moved) return
      // A drag must not also toggle the panel; ignore the click that follows.
      launcherDragEndAt = Date.now()
      launcherMoved = true
      var rect = floatingLauncher.getBoundingClientRect()
      lsSetRaw('launcherLeft', Math.round(rect.left))
      lsSetRaw('launcherTop', Math.round(rect.top))
      // The launcher left its default corner, so the panel may use the full height.
      if (root.classList.contains('dshcp-open')) {
        var maxHeight = maxPanelHeight()
        if (root.getBoundingClientRect().height > maxHeight) {
          root.style.height = maxHeight + 'px'
          root.style.maxHeight = maxHeight + 'px'
          positionResizeGrip()
        }
      }
    }
    floatingLauncher.addEventListener('pointerdown', onDown)
    floatingLauncher.addEventListener('pointermove', onMove)
    floatingLauncher.addEventListener('pointerup', onUp)
    floatingLauncher.addEventListener('pointercancel', onUp)
  })()

  // ---- 拖动右下角调整面板大小 ----
  ;(function () {
    if (!resizeGrip) return
    var resizing = false, side = 'right', sx = 0, sy = 0, ow = 0, oh = 0, startLeft = 0, startTop = 0
    function onDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      resizing = true
      side = resizeGrip.classList.contains('dshcp-resize-left') ? 'left' : 'right'
      sx = e.clientX; sy = e.clientY
      var rect = root.getBoundingClientRect()
      ow = rect.width; oh = rect.height
      startLeft = rect.left; startTop = rect.top
      root.style.top = rect.top + 'px'
      root.style.bottom = 'auto'
      if (side === 'right') {
        // Pin the top-left corner so the panel grows toward the pointer.
        root.style.left = rect.left + 'px'
        root.style.right = 'auto'
      }
      root.style.height = oh + 'px'
      root.style.maxHeight = oh + 'px'
      try { resizeGrip.setPointerCapture(e.pointerId) } catch (err) {}
      e.preventDefault()
      e.stopPropagation()
    }
    function onMove(e) {
      if (!resizing) return
      var dx = e.clientX - sx
      var dy = e.clientY - sy
      var minWidth = 320, minHeight = 240
      var maxWidth = Math.max(minWidth, side === 'left' ? window.innerWidth - 32 : window.innerWidth - startLeft - 16)
      var maxHeight = Math.max(minHeight, window.innerHeight - startTop - 16)
      var width = Math.max(minWidth, Math.min(maxWidth, side === 'left' ? ow - dx : ow + dx))
      var height = Math.max(minHeight, Math.min(maxHeight, oh + dy))
      root.style.width = width + 'px'
      root.style.height = height + 'px'
      root.style.maxHeight = height + 'px'
      positionResizeGrip()
    }
    function onUp(e) {
      if (!resizing) return
      resizing = false
      try { resizeGrip.releasePointerCapture(e.pointerId) } catch (err) {}
      var rect = root.getBoundingClientRect()
      lsSetRaw('panelWidth', Math.round(rect.width))
      lsSetRaw('panelHeight', Math.round(rect.height))
      positionResizeGrip()
    }
    resizeGrip.addEventListener('pointerdown', onDown)
    resizeGrip.addEventListener('pointermove', onMove)
    resizeGrip.addEventListener('pointerup', onUp)
    resizeGrip.addEventListener('pointercancel', onUp)
  })()

  // ---- 渲染 ----
  var moodValEl, moodLabelEl, moodDimsEl, moodReasonEl
  function buildMood() {
    moodValEl = el('span', 'dshcp-score', '—')
    moodLabelEl = el('span', 'dshcp-sub', '')
    var top = el('div', 'dshcp-row')
    top.appendChild(moodValEl)
    top.appendChild(moodLabelEl)
    moodDimsEl = el('div')
    moodReasonEl = el('div', 'dshcp-reason')
    moodSec.body.appendChild(top)
    moodSec.body.appendChild(moodDimsEl)
    moodSec.body.appendChild(moodReasonEl)
    moodReasonEl.addEventListener('click', function () { moodReasonEl.classList.toggle('dshcp-full') })
  }
  buildMood()

  function renderMood() {
    var m = state.mood
    if (!m || !m.ok) {
      moodValEl.textContent = '—'
      moodLabelEl.textContent = '读不到心情'
      moodDimsEl.textContent = ''
      moodReasonEl.textContent = ''
      return
    }
    moodValEl.textContent = String(m.mood)
    moodLabelEl.textContent = (m.emoji || '') + ' ' + (m.moodLabel || '')
    moodDimsEl.textContent = ''
    for (var i = 0; i < DIM_KEYS.length; i++) {
      var key = DIM_KEYS[i]
      var dim = (m.dims || []).find(function (d) { return d && d.key === key })
      var v = dim ? Number(dim.value) : 0
      var row = el('div', 'dshcp-row')
      row.appendChild(el('span', 'dshcp-rowlabel', DIM_LABELS[key]))
      var bar = el('div', 'dshcp-bar')
      var fill = document.createElement('i')
      fill.style.width = Math.max(0, Math.min(100, v)) + '%'
      fill.style.background = DIM_COLORS[key] || '#9aa0a6'
      bar.appendChild(fill)
      row.appendChild(bar)
      row.appendChild(el('span', 'dshcp-val', String(v)))
      moodDimsEl.appendChild(row)
    }
    moodReasonEl.textContent = m.lastReason ? ('“' + m.lastReason + '”') : '（没有最近一句）'
    moodReasonEl.classList.remove('dshcp-full')
  }

  var ttsStatusEl, ttsBtnsEl, ttsSessEl, ttsFavEl
  function buildTts() {
    ttsStatusEl = el('div', 'dshcp-sub')
    ttsBtnsEl = el('div')
    ttsSessEl = el('div')
    ttsFavEl = el('div')
    ttsSec.body.appendChild(ttsStatusEl)
    ttsSec.body.appendChild(ttsBtnsEl)
    ttsSec.body.appendChild(el('div', 'dshcp-sech', '听哪些会话'))
    ttsSec.body.appendChild(ttsSessEl)
    ttsSec.body.appendChild(el('div', 'dshcp-sech', '收藏'))
    ttsSec.body.appendChild(ttsFavEl)
  }
  buildTts()

  function renderTts() {
    var t = state.tts
    if (!t || !t.ok) { ttsStatusEl.textContent = '读不到朗读桥状态'; return }
    ttsStatusEl.textContent = (t.auto ? '自动朗读 开' : '自动朗读 关') + '　·　' + (t.playing ? '正在念' : '没在念') + (t.waiting ? '　·　排队 ' + t.waiting : '')
  }
  function renderTtsButtons() {
    ttsBtnsEl.textContent = ''
    var t = state.tts
    var autoBtn = el('span', 'dshcp-btn ' + (t && t.auto ? 'dshcp-on' : 'dshcp-off'), t && t.auto ? '自动朗读：开' : '自动朗读：关')
    autoBtn.addEventListener('click', function () { postJSON('/dsh-tts-bridge/auto', { auto: !(t && t.auto) }).then(refreshTts) })
    var stopBtn = el('span', 'dshcp-btn', '停止并清空')
    stopBtn.addEventListener('click', function () { postJSON('/dsh-tts-bridge/stop', {}).then(refreshTts) })
    var sayBtn = el('span', 'dshcp-btn', '念一句测试')
    sayBtn.addEventListener('click', function () {
      var text = window.prompt('要念的一句话（发给浏览器里登录的 DeepSeek 页面朗读）：')
      if (text) postJSON('/dsh-tts-bridge/say', { text: text }).then(refreshTts)
    })
    ttsBtnsEl.appendChild(autoBtn)
    ttsBtnsEl.appendChild(stopBtn)
    ttsBtnsEl.appendChild(sayBtn)
  }
  function renderTtsSessions(sessions) {
    ttsSessEl.textContent = ''
    var list = (sessions && sessions.sessions) || []
    if (!list.length) { ttsSessEl.appendChild(el('div', 'dshcp-empty', '没有可听的会话')); return }
    for (var i = 0; i < list.length; i++) {
      var s = list[i]
      var item = el('div', 'dshcp-item')
      var cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'dshcp-check'
      cb.checked = !!s.watching
      cb.addEventListener('change', function (s) { return function () { postJSON('/dsh-tts-bridge/watch', { id: s.id, remove: !this.checked }).then(refreshTts) } }(s))
      item.appendChild(cb)
      item.appendChild(el('span', 'dshcp-t', s.title || s.id))
      ttsSessEl.appendChild(item)
    }
  }
  function renderTtsFavs(favs) {
    ttsFavEl.textContent = ''
    var list = (favs && favs.favorites) || []
    if (!list.length) { ttsFavEl.appendChild(el('div', 'dshcp-empty', '还没有收藏')); return }
    for (var i = 0; i < list.length; i++) {
      var f = list[i]
      var item = el('div', 'dshcp-item')
      item.appendChild(el('span', 'dshcp-t', f.text || '（空）'))
      var b = el('span', 'dshcp-btn', '念')
      b.addEventListener('click', function (f) { return function () { postJSON('/dsh-tts-bridge/say', { text: f.text }).then(refreshTts) } }(f))
      item.appendChild(b)
      ttsFavEl.appendChild(item)
    }
  }

  function setExtView(view) {
    extState.view = view === 'market' ? 'market' : 'installed'
    marketTabBtn.classList.toggle('dshcp-on', extState.view === 'market')
    installedTabBtn.classList.toggle('dshcp-on', extState.view === 'installed')
    extControls.style.display = extState.view === 'market' ? 'flex' : 'none'
    marketList.style.display = extState.view === 'market' ? 'block' : 'none'
    installedList.style.display = extState.view === 'installed' ? 'block' : 'none'
    catalogList.style.display = extState.view === 'installed' ? 'block' : 'none'
    settingsPane.style.display = 'none'
    extStatus.textContent = ''
    if (extState.view === 'market') refreshMarket()
    else refreshInstalled()
  }

  // ---- 鱼的日记（只读浏览；写日记是鱼自己的事，主人只负责看和审批）----
  var diarySummaryEl, diaryListEl, diarySuggestEl, diaryDateInput, diaryStatusEl
  function buildDiary() {
    diarySummaryEl = el('div', 'dshcp-sub')
    diaryStatusEl = el('div', 'dshcp-status')

    var dateRow = el('div', 'dshcp-market-tools')
    diaryDateInput = document.createElement('input')
    diaryDateInput.className = 'dshcp-input'
    diaryDateInput.type = 'date'
    diaryDateInput.style.flex = 'none'
    diaryDateInput.style.minWidth = '130px'
    var todayBtn = el('span', 'dshcp-btn', '今天')
    var allBtn = el('span', 'dshcp-btn', '全部')
    var refreshDiaryBtn = el('span', 'dshcp-btn', '刷新')
    dateRow.appendChild(el('span', 'dshcp-sub', '日期'))
    dateRow.appendChild(diaryDateInput)
    dateRow.appendChild(todayBtn)
    dateRow.appendChild(allBtn)
    dateRow.appendChild(refreshDiaryBtn)

    diarySuggestEl = el('div')
    diaryListEl = el('div')

    diarySec.body.appendChild(diarySummaryEl)
    diarySec.body.appendChild(dateRow)
    diarySec.body.appendChild(diaryStatusEl)
    diarySec.body.appendChild(el('div', 'dshcp-sech', '待主人确认'))
    diarySec.body.appendChild(diarySuggestEl)
    diarySec.body.appendChild(el('div', 'dshcp-sech', '已记录'))
    diarySec.body.appendChild(diaryListEl)
    diarySec.body.appendChild(el('div', 'dshcp-empty', '日记由鱼自己写；这里只支持主人查看和批阅（阅览并在日记旁留下批语）。'))
    diarySec.body.style.maxHeight = '46vh'
    diarySec.body.style.overflowY = 'auto'

    function refresh() {
      diaryStatusEl.textContent = '读取中…'
      var date = diaryDateInput.value || ''
      getJSON('/dsh-fish-world/world/diary' + (date ? '?date=' + encodeURIComponent(date) : ''))
        .then(function (r) { renderDiary(r || {}); diaryStatusEl.textContent = '' })
        .catch(function (e) { diaryStatusEl.textContent = '读取失败：' + (e && e.message || e) })
    }
    todayBtn.addEventListener('click', function () {
      diaryDateInput.value = new Date().toISOString().slice(0, 10)
      refresh()
    })
    allBtn.addEventListener('click', function () {
      diaryDateInput.value = ''
      refresh()
    })
    refreshDiaryBtn.addEventListener('click', refresh)
    diaryDateInput.addEventListener('change', refresh)
    diaryDateInput.value = new Date().toISOString().slice(0, 10)
    refreshDiary = refresh
    refresh()
  }
  var refreshDiary = function () {}
  function renderDiary(data) {
    var suggestions = (data.suggestions || [])
    var entries = (data.entries || [])
    diarySummaryEl.textContent = '已记录 ' + entries.length + ' 条' + (suggestions.length ? '，待确认 ' + suggestions.length + ' 条' : '')

    diarySuggestEl.textContent = ''
    if (!suggestions.length) {
      diarySuggestEl.appendChild(el('div', 'dshcp-empty', '没有待确认的日记。信任者提交后，主人可在这里审批。'))
    } else {
      suggestions.forEach(function (item) {
        var box = el('div', 'dshcp-card')
        box.appendChild(el('div', 'dshcp-cardmeta', String(item.at || '').slice(0, 16) + ' · ' + (item.actorName || '未知')))
        var desc = el('div', 'dshcp-carddesc', item.text || '（空）')
        desc.addEventListener('click', function () { desc.classList.toggle('dshcp-full') })
        box.appendChild(desc)
        var row = el('div', 'dshcp-market-tools')
        var acceptBtn = el('span', 'dshcp-btn dshcp-on', '通过')
        var rejectBtn = el('span', 'dshcp-btn', '拒绝')
        acceptBtn.addEventListener('click', function () {
          postJSON('/dsh-fish-world/world/diary/review', { id: item.id, accept: true }).then(function () { refreshDiary() })
        })
        rejectBtn.addEventListener('click', function () {
          postJSON('/dsh-fish-world/world/diary/review', { id: item.id, accept: false }).then(function () { refreshDiary() })
        })
        row.appendChild(acceptBtn)
        row.appendChild(rejectBtn)
        box.appendChild(row)
        diarySuggestEl.appendChild(box)
      })
    }

    diaryListEl.textContent = ''
    if (!entries.length) {
      diaryListEl.appendChild(el('div', 'dshcp-empty', '这一天还没有日记。'))
    } else {
      var comments = data.comments || []
      entries.forEach(function (item) {
        var box = el('div', 'dshcp-card')
        box.appendChild(el('div', 'dshcp-cardmeta', String(item.at || '').slice(0, 16) + ' · ' + (item.actorName || '鱼') + (item.status === 'approved' ? ' · 已批准' : '')))
        var desc = el('div', 'dshcp-carddesc', item.text || '（空）')
        desc.addEventListener('click', function () { desc.classList.toggle('dshcp-full') })
        box.appendChild(desc)
        var mine = comments.filter(function (c) { return c.diaryId === item.id })
        mine.forEach(function (c) {
          var row = el('div', 'dshcp-cardmeta', '批语 · ' + (c.actorName || '主人') + '：' + (c.text || ''))
          box.appendChild(row)
        })
        var row = el('div', 'dshcp-market-tools')
        var input = document.createElement('input')
        input.className = 'dshcp-input'
        input.type = 'text'
        input.placeholder = '写一句批语…'
        var send = el('span', 'dshcp-btn dshcp-on', '批语')
        send.addEventListener('click', function () {
          var text = String(input.value || '').trim()
          if (!text) return
          postJSON('/dsh-fish-world/world/diary/comment', { id: item.id, text: text }).then(function () { refreshDiary() })
        })
        row.appendChild(input)
        row.appendChild(send)
        box.appendChild(row)
        diaryListEl.appendChild(box)
      })
    }
  }
  buildDiary()

  // ---- 鱼的请求 ----
  var wishListEl, wishStatusEl
  function buildWishes() {
    wishStatusEl = el('div', 'dshcp-status')
    wishListEl = el('div')
    wishSec.body.appendChild(el('div', 'dshcp-empty', '鱼提出的请求。同意或拒绝时选择的语气，会反馈到它的心情。'))
    wishSec.body.appendChild(wishStatusEl)
    wishSec.body.appendChild(wishListEl)
    wishSec.body.style.maxHeight = '46vh'
    wishSec.body.style.overflowY = 'auto'

    function refresh() {
      wishStatusEl.textContent = '读取中…'
      getJSON('/dsh-fish-world/world/wishes').then(function (r) {
        renderWishes(r || {})
        wishStatusEl.textContent = ''
      }).catch(function (e) { wishStatusEl.textContent = '读取失败：' + (e && e.message || e) })
    }
    refreshWishes = refresh
    refresh()
  }
  var refreshWishes = function () {}

  function renderWishes(data) {
    wishListEl.textContent = ''
    var all = data.wishes || []
    var pending = all.filter(function (w) { return w.status === 'pending' })
    var decided = all.filter(function (w) { return w.status !== 'pending' })

    wishListEl.appendChild(el('div', 'dshcp-sech', '等待处理（' + pending.length + '）'))
    if (!pending.length) {
      wishListEl.appendChild(el('div', 'dshcp-empty', '现在没有待处理的请求。'))
    } else {
      pending.forEach(function (item) {
        var box = el('div', 'dshcp-card')
        box.appendChild(el('div', 'dshcp-cardmeta',
          String(item.at || '').slice(0, 16) + (item.urgency === 'high' ? ' · 着急' : '') + ' · ' + (item.kind || '请求')))
        var desc = el('div', 'dshcp-carddesc', item.text || '（空）')
        desc.addEventListener('click', function () { desc.classList.toggle('dshcp-full') })
        box.appendChild(desc)

        var row = el('div', 'dshcp-market-tools')
        var reply = document.createElement('input')
        reply.className = 'dshcp-input'
        reply.placeholder = '说明或安慰（可选）…'
        var tone = document.createElement('select')
        tone.className = 'dshcp-select'
        ;[['', '直接答复'], ['explained', '说明原因'], ['comforted', '安慰它'], ['curt', '简短打发']].forEach(function (pair) {
          var opt = document.createElement('option')
          opt.value = pair[0]
          opt.textContent = pair[1]
          tone.appendChild(opt)
        })
        row.appendChild(reply)
        row.appendChild(tone)
        box.appendChild(row)

        function decide(accept) {
          var payload = { id: item.id, accept: accept }
          var text = String(reply.value || '').trim()
          if (text) payload.reply = text
          if (tone.value) payload.tone = tone.value
          postJSON('/dsh-fish-world/world/wishes', payload).then(function () { refreshWishes() })
        }
        var btnRow = el('div', 'dshcp-market-tools')
        var yes = el('span', 'dshcp-btn dshcp-on', '同意')
        yes.addEventListener('click', function () { decide(true) })
        var no = el('span', 'dshcp-btn', '拒绝')
        no.addEventListener('click', function () { decide(false) })
        btnRow.appendChild(yes)
        btnRow.appendChild(no)
        box.appendChild(btnRow)
        wishListEl.appendChild(box)
      })
    }

    wishListEl.appendChild(el('div', 'dshcp-sech', '已处理（' + decided.length + '）'))
    if (!decided.length) {
      wishListEl.appendChild(el('div', 'dshcp-empty', '还没有处理过的请求。'))
    } else {
      decided.slice(0, 20).forEach(function (item) {
        var box = el('div', 'dshcp-card')
        var toneLabel = item.tone === 'curt' ? ' · 简短打发' : item.tone === 'explained' ? ' · 有说明' : item.tone === 'comforted' ? ' · 有安慰' : ''
        box.appendChild(el('div', 'dshcp-cardmeta',
          (item.status === 'approved' ? '已同意' : '已拒绝') + toneLabel + ' · ' + String(item.decidedAt || item.at || '').slice(0, 16)))
        box.appendChild(el('div', 'dshcp-carddesc', item.text || '（空）'))
        if (item.reply) box.appendChild(el('div', 'dshcp-cardmeta', '你的答复：' + item.reply))
        wishListEl.appendChild(box)
      })
    }
  }
  buildWishes()

  // ---- 鱼的成长 ----
  var growthStatusEl, growthListEl
  function buildGrowth() {
    growthStatusEl = el('div', 'dshcp-status')
    growthListEl = el('div')
    growthSec.body.appendChild(el('div', 'dshcp-empty', '成长是可修订、可撤回的理解，不是摘要累积；没有新认识可以不写。'))
    growthSec.body.appendChild(growthStatusEl)
    growthSec.body.appendChild(growthListEl)
    growthSec.body.style.maxHeight = '46vh'
    growthSec.body.style.overflowY = 'auto'

    function refresh() {
      growthStatusEl.textContent = '读取中…'
      getJSON('/dsh-fish-world/world/growth').then(function (r) {
        renderGrowth(r || {})
        growthStatusEl.textContent = ''
      }).catch(function (e) { growthStatusEl.textContent = '读取失败：' + (e && e.message || e) })
    }
    refreshGrowth = refresh
    refresh()
  }
  var refreshGrowth = function () {}

  function renderGrowth(data) {
    growthListEl.textContent = ''
    var stage = data.stage || {}
    growthListEl.appendChild(el('div', 'dshcp-cardmeta',
      (stage.name || '幼鱼') + ' · ' + (data.total || 0) + ' 条 · ' + (data.days || 0) + ' 天 · 今天 ' + (data.todayCount || 0) + '/' + (data.dailyLimit || 2)))
    if (stage.note) growthListEl.appendChild(el('div', 'dshcp-carddesc', stage.note))
    if (data.check && data.check.ok === false) {
      growthListEl.appendChild(el('div', 'dshcp-status', '账本校验异常：' + (data.check.problems || []).join('；')))
    }

    var entries = data.entries || []
    growthListEl.appendChild(el('div', 'dshcp-sech', '记录（' + entries.length + '）'))
    if (!entries.length) {
      growthListEl.appendChild(el('div', 'dshcp-empty', '还没有成长记录。'))
    } else {
      entries.slice(0, 20).forEach(function (item) {
        var box = el('div', 'dshcp-card')
        box.appendChild(el('div', 'dshcp-cardmeta', item.day + ' · ' + (item.kind || 'insight') + (Number(item.revision) > 1 ? ' · 第 ' + item.revision + ' 版' : '')))
        var desc = el('div', 'dshcp-carddesc', item.text || '（空）')
        desc.addEventListener('click', function () { desc.classList.toggle('dshcp-full') })
        box.appendChild(desc)
        if (item.quote) box.appendChild(el('div', 'dshcp-cardmeta', '「' + item.quote + '」'))

        var row = el('div', 'dshcp-market-tools')
        var input = document.createElement('input')
        input.className = 'dshcp-input'
        input.placeholder = '改成更准确的说法…'
        var reviseBtn = el('span', 'dshcp-btn', '修订')
        reviseBtn.addEventListener('click', function () {
          var text = String(input.value || '').trim()
          if (!text) return
          postJSON('/dsh-fish-world/world/growth', { action: 'revise', id: item.id, text: text }).then(function () { refreshGrowth() })
        })
        var retractBtn = el('span', 'dshcp-btn', '撤回这天')
        retractBtn.addEventListener('click', function () {
          postJSON('/dsh-fish-world/world/growth', { action: 'retract', day: item.day }).then(function () { refreshGrowth() })
        })
        row.appendChild(input)
        row.appendChild(reviseBtn)
        row.appendChild(retractBtn)
        box.appendChild(row)
        growthListEl.appendChild(box)
      })
    }
  }
  buildGrowth()

  // ---- 体检与更新 ----
  var doctorOutEl, doctorStatusEl
  function buildDoctor() {
    doctorStatusEl = el('div', 'dshcp-status')
    doctorOutEl = el('div')
    var row = el('div', 'dshcp-market-tools')
    var depBtn = el('span', 'dshcp-btn dshcp-on', '依赖体检')
    var upBtn = el('span', 'dshcp-btn', '更新体检')
    row.appendChild(depBtn)
    row.appendChild(upBtn)
    doctorSec.body.appendChild(el('div', 'dshcp-empty', '依赖体检只看本机；更新体检才联网查版本。都不会自动安装。'))
    doctorSec.body.appendChild(row)
    doctorSec.body.appendChild(doctorStatusEl)
    doctorSec.body.appendChild(doctorOutEl)

    depBtn.addEventListener('click', function () {
      doctorStatusEl.textContent = '检查依赖中…'
      getJSON('/dsh-fish-world/doctor/dependency').then(function (r) {
        doctorStatusEl.textContent = r && r.summary || ''
        renderDoctor(r, null)
      }).catch(function (e) { doctorStatusEl.textContent = '依赖体检失败：' + (e && e.message || e) })
    })
    upBtn.addEventListener('click', function () {
      doctorStatusEl.textContent = '联网检查更新中…'
      getJSON('/dsh-fish-world/doctor/update?force=1').then(function (r) {
        doctorStatusEl.textContent = r && r.summary || ''
        renderDoctor(null, r)
      }).catch(function (e) { doctorStatusEl.textContent = '更新体检失败：' + (e && e.message || e) })
    })
  }
  function renderDoctor(dep, up) {
    doctorOutEl.textContent = ''
    if (dep) {
      ;(dep.packages || []).forEach(function (item) {
        var line = el('div', 'dshcp-item')
        line.appendChild(el('span', 'dshcp-t', (item.label || item.name) + (item.found ? ' @' + (item.version || '?') : (item.optional ? '（可选未装）' : '（缺失）'))))
        doctorOutEl.appendChild(line)
      })
      ;(dep.hints || []).forEach(function (hint) {
        doctorOutEl.appendChild(el('div', 'dshcp-cardmeta', hint.label + (hint.command ? '：' + hint.command : '')))
      })
    }
    if (up) {
      ;(up.items || []).forEach(function (item) {
        var label = { current: '最新', outdated: '有新版本', 'not-installed': '未装', unavailable: '查不到' }[item.status] || item.status
        doctorOutEl.appendChild(el('div', 'dshcp-item',
          (item.label || item.name) + '：' + (item.current || '未装') + (item.latest ? ' → ' + item.latest : '') + ' · ' + label))
      })
      ;(up.hints || []).forEach(function (hint) {
        doctorOutEl.appendChild(el('div', 'dshcp-cardmeta', hint.label + '：' + hint.command))
      })
    }
  }
  buildDoctor()

  // ---- 鱼与平台 ----
  var platformOutEl
  function buildPlatforms() {
    platformOutEl = el('div')
    platformSec.body.appendChild(el('div', 'dshcp-empty', '三个平台各自独立。外发动作默认关闭，模型无法绕过这里的开关。'))
    platformSec.body.appendChild(platformOutEl)
    platformSec.body.style.maxHeight = '52vh'
    platformSec.body.style.overflowY = 'auto'

    var BOOLS = {
      qq: [['enabled', '启用 QQ'], ['readHistory', '读历史'], ['sendMessage', '发送消息'], ['qzoneEnabled', '打理空间']],
      bili: [['enabled', '启用 B 站'], ['watchEnabled', '浏览视频'], ['allowLike', '点赞'], ['allowFavorite', '收藏'], ['allowComment', '评论']],
      douyin: [['enabled', '启用抖音'], ['watchEnabled', '自己刷'], ['silentWatch', '静默'], ['autoStart', '自动开始'], ['allowShare', '分享'], ['allowGreeting', '问候'], ['allowReply', '回私信'], ['allowComment', '评论']],
    }

    function refresh() {
      getJSON('/dsh-fish-world/platforms').then(function (r) {
        platformOutEl.textContent = ''
        ;(r.platforms || []).forEach(function (p) {
          var head = el('div', 'dshcp-cardmeta',
            p.name + (p.installed ? (p.version ? ' @' + p.version : '') : '（插件未安装）'))
          platformOutEl.appendChild(head)
          if (p.notes && p.notes.length) platformOutEl.appendChild(el('div', 'dshcp-carddesc', p.notes[0]))

          ;(BOOLS[p.id] || []).forEach(function (pair) {
            var key = pair[0]
            var line = el('div', 'dshcp-gearline')
            line.appendChild(el('span', null, pair[1]))
            var sw = el('div', 'dshcp-switch' + (p.config[key] === true ? ' dshcp-on' : ''))
            sw.addEventListener('click', function () {
              var next = !(p.config[key] === true)
              postJSON('/dsh-fish-world/platforms', { id: p.id, config: { [key]: next } }).then(refresh)
            })
            line.appendChild(sw)
            platformOutEl.appendChild(line)
          })
        })
      }).catch(function (e) {
        platformOutEl.textContent = '读取失败：' + (e && e.message || e)
      })
    }
    refresh()
  }
  buildPlatforms()

  // ---- 鱼的设定：名字 / 称呼 / 角色卡 ----
  var profileNameInput, profileOwnerInput, profileRoleSelect, profileStatusEl, profilePreviewEl
  function buildProfile() {
    var nameField = el('div', 'dshcp-field')
    nameField.appendChild(el('label', null, '鱼的名字'))
    profileNameInput = document.createElement('input')
    profileNameInput.className = 'dshcp-input'
    profileNameInput.type = 'text'
    profileNameInput.placeholder = '鱼'
    nameField.appendChild(profileNameInput)

    var ownerField = el('div', 'dshcp-field')
    ownerField.appendChild(el('label', null, '它怎么称呼你'))
    profileOwnerInput = document.createElement('input')
    profileOwnerInput.className = 'dshcp-input'
    profileOwnerInput.type = 'text'
    profileOwnerInput.value = '主人'
    ownerField.appendChild(profileOwnerInput)

    var roleField = el('div', 'dshcp-field')
    roleField.appendChild(el('label', null, '外显角色卡'))
    profileRoleSelect = document.createElement('select')
    profileRoleSelect.className = 'dshcp-select'
    roleField.appendChild(profileRoleSelect)

    profilePreviewEl = el('div', 'dshcp-sub', '')
    profileStatusEl = el('div', 'dshcp-status')

    var save = el('span', 'dshcp-btn dshcp-on', '保存设置')
    save.addEventListener('click', function () {
      profileStatusEl.textContent = '保存中…'
      postJSON('/dsh-fish-world/fish/profile', {
        name: String(profileNameInput.value || '').trim(),
        ownerTitle: String(profileOwnerInput.value || '').trim() || '主人',
        persona: profileRoleSelect.value,
      }).then(function (r) {
        profileStatusEl.textContent = r && r.ok ? '已保存，主界面名称会随之更新。' : '保存失败。'
        if (r && r.ok) refreshProfile()
      }).catch(function (e) { profileStatusEl.textContent = '保存失败：' + (e && e.message || e) })
    })

    profileSec.body.appendChild(nameField)
    profileSec.body.appendChild(ownerField)
    profileSec.body.appendChild(roleField)
    profileSec.body.appendChild(profilePreviewEl)

    // 人设卡：按当前角色 id 存取
    var personaField = el('div', 'dshcp-field')
    personaField.appendChild(el('label', null, '角色人设卡'))
    var personaArea = document.createElement('textarea')
    personaArea.className = 'dshcp-textarea'
    personaArea.rows = 10
    personaArea.placeholder = '把角色卡文本粘贴到这里：说话方式、性格、语料…'
    personaField.appendChild(personaArea)
    var personaStatus = el('div', 'dshcp-status', '')
    var personaSave = el('span', 'dshcp-btn dshcp-on', '保存人设卡')
    personaSave.addEventListener('click', function () {
      personaStatus.textContent = '保存中…'
      postJSON('/dsh-fish-world/fish/persona', {
        roleId: profileRoleSelect.value === 'auto' ? 'default' : profileRoleSelect.value,
        text: String(personaArea.value || ''),
      }).then(function (r) {
        personaStatus.textContent = r && r.ok ? '已保存，下一轮对话生效。' : '保存失败。'
        if (r && r.ok) refreshPersona()
      }).catch(function (e) { personaStatus.textContent = '保存失败：' + (e && e.message || e) })
    })
    profileSec.body.appendChild(personaField)
    profileSec.body.appendChild(personaSave)
    profileSec.body.appendChild(personaStatus)

    function refreshPersona() {
      var roleId = profileRoleSelect.value === 'auto' ? 'default' : profileRoleSelect.value
      getJSON('/dsh-fish-world/fish/persona?role=' + encodeURIComponent(roleId)).then(function (r) {
        personaArea.value = (r && r.text) || ''
        personaStatus.textContent = r && r.bytes ? ('当前 ' + r.bytes + ' 字节') : '还没有加载人设卡'
      }).catch(function (e) { personaStatus.textContent = '读取失败：' + (e && e.message || e) })
    }
    profileRoleSelect.addEventListener('change', refreshPersona)
    refreshPersona()
    profileSec.body.appendChild(save)
    profileSec.body.appendChild(profileStatusEl)

    function updatePreview() {
      var chosen = [...profileRoleSelect.options].find(function (o) { return o.value === profileRoleSelect.value })
      var shown = String(profileNameInput.value || '').trim() || (chosen && chosen.dataset.name) || '鱼'
      profilePreviewEl.textContent = '主界面显示：' + shown
    }
    profileNameInput.addEventListener('input', updatePreview)
    profileRoleSelect.addEventListener('change', updatePreview)

    function refresh() {
      getJSON('/dsh-fish-world/fish/profile').then(function (r) {
        var fish = r && r.fish || {}
        profileNameInput.value = fish.name || ''
        profileOwnerInput.value = fish.ownerTitle || '主人'
        profileRoleSelect.textContent = ''
        var auto = document.createElement('option')
        auto.value = 'auto'
        auto.textContent = '跟随挂件置顶/最新角色'
        profileRoleSelect.appendChild(auto)
        ;(r && r.roles || []).forEach(function (role) {
          var opt = document.createElement('option')
          opt.value = role.id
          opt.textContent = (role.name || role.id) + (role.pinned ? '（置顶）' : '')
          opt.dataset.name = role.name || role.id
          profileRoleSelect.appendChild(opt)
        })
        profileRoleSelect.value = fish.persona || 'auto'
        updatePreview()
        refreshPersona()
      }).catch(function (e) { profileStatusEl.textContent = '读取失败：' + (e && e.message || e) })
    }
    refreshProfile = refresh
    refresh()
  }
  var refreshProfile = function () {}
  buildProfile()

  // ---- 鱼之宝库表情 ----
  var stickerSummaryEl, stickerListEl, stickerLimitEl
  function buildStickers() {
    stickerSummaryEl = el('div', 'dshcp-sub')
    var limitRow = el('div', 'dshcp-market-tools')
    var limitInput = document.createElement('input')
    limitInput.className = 'dshcp-input'
    limitInput.type = 'number'
    limitInput.min = '0'
    limitInput.max = '1000'
    limitInput.style.minWidth = '70px'
    limitInput.style.flex = 'none'
    var limitBtn = el('span', 'dshcp-btn dshcp-on', '保存额度')
    limitRow.appendChild(el('span', 'dshcp-sub', '每小时最多收藏'))
    limitRow.appendChild(limitInput)
    limitRow.appendChild(el('span', 'dshcp-sub', '张'))
    limitRow.appendChild(limitBtn)
    var searchInputSticker = document.createElement('input')
    searchInputSticker.className = 'dshcp-input'
    searchInputSticker.type = 'search'
    searchInputSticker.placeholder = '按名称 / 标签过滤'
    var refreshBtn = el('span', 'dshcp-btn', '刷新')
    var searchRow = el('div', 'dshcp-market-tools')
    searchRow.appendChild(searchInputSticker)
    searchRow.appendChild(refreshBtn)
    stickerLimitEl = limitInput
    stickerListEl = el('div')
    stickerSec.body.appendChild(stickerSummaryEl)
    stickerSec.body.appendChild(limitRow)
    stickerSec.body.appendChild(searchRow)
    stickerSec.body.appendChild(stickerListEl)
    stickerSec.body.style.maxHeight = '46vh'
    stickerSec.body.style.overflowY = 'auto'

    limitBtn.addEventListener('click', function () {
      var v = Number(limitInput.value)
      if (!Number.isFinite(v) || v < 0 || v > 1000) { stickerSummaryEl.textContent = '额度需是 0-1000 的整数'; return }
      postJSON('/dsh-fish-world/stickers/limit', { limit: Math.floor(v) })
        .then(function (r) { refreshStickers() })
        .catch(function (e) { stickerSummaryEl.textContent = '保存失败：' + (e && e.message) })
    })
    refreshBtn.addEventListener('click', refreshStickers)
    searchInputSticker.addEventListener('input', function () { renderStickers(searchInputSticker.value) })
  }
  buildStickers()

  // ---- QQ 空间写操作额度（不暴露 Cookie / OneBot token）----
  var qzoneConfigStatus = el('div', 'dshcp-status')
  var qzoneFields = {}
  function buildQzoneSettings() {
    var enabledLine = el('div', 'dshcp-gearline')
    var enabledLabel = el('span', 'dshcp-sub', '允许鱼打理和发布自己的 QQ 空间')
    enabledLabel.style.fontSize = '12px'
    var enabledInput = document.createElement('input')
    enabledInput.type = 'checkbox'
    enabledInput.className = 'dshcp-check'
    enabledInput.style.width = '18px'
    enabledInput.style.height = '18px'
    enabledLine.appendChild(enabledLabel)
    enabledLine.appendChild(enabledInput)
    qzoneSec.body.appendChild(enabledLine)

    var rows = [
      ['postsPerDay', '动态/日记 每日上限'],
      ['likesPerDay', '点赞 每日上限'],
      ['commentsPerDay', '评论 每日上限'],
      ['repliesPerDay', '回复 每日上限'],
    ]
    rows.forEach(function (row) {
      var line = el('div', 'dshcp-market-tools')
      var label = el('span', 'dshcp-sub', row[1])
      label.style.fontSize = '12px'
      label.style.lineHeight = '1.5'
      var input = document.createElement('input')
      input.type = 'number'
      input.min = '0'
      input.max = '100'
      input.step = '1'
      input.className = 'dshcp-input'
      input.style.width = '76px'
      input.style.minHeight = '32px'
      input.style.flex = 'none'
      qzoneFields[row[0]] = input
      line.appendChild(label)
      line.appendChild(input)
      qzoneSec.body.appendChild(line)
    })

    qzoneConfigStatus.style.fontSize = '12px'
    var qzoneHint = el('div', 'dshcp-empty', '动态和日记共用额度；点赞、评论、回复分别计数。0 表示禁用对应操作。到期提醒只投递到主人会话，不绕过工具直接发布。')
    qzoneHint.style.fontSize = '12px'
    qzoneHint.style.lineHeight = '1.5'
    qzoneSec.body.appendChild(qzoneHint)
    qzoneSec.body.appendChild(qzoneConfigStatus)
    var saveButton = document.createElement('button')
    saveButton.type = 'button'
    saveButton.className = 'dshcp-btn dshcp-on'
    saveButton.textContent = '保存空间设置'
    saveButton.style.minHeight = '32px'
    qzoneSec.body.appendChild(saveButton)

    function refresh() {
      getJSON('/dsh-fish-world/config').then(function (result) {
        var cfg = result && result.config && result.config.qzone || {}
        enabledInput.checked = cfg.enabled !== false
        rows.forEach(function (row) { qzoneFields[row[0]].value = String(cfg[row[0]] == null ? 2 : cfg[row[0]]) })
        qzoneConfigStatus.textContent = '当前设置已读取。'
      }).catch(function (error) { qzoneConfigStatus.textContent = '读取失败：' + (error && error.message || error) })
    }
    saveButton.addEventListener('click', function () {
      var patch = { enabled: enabledInput.checked }
      for (var i = 0; i < rows.length; i++) {
        var key = rows[i][0]
        var value = Number(qzoneFields[key].value)
        if (!Number.isInteger(value) || value < 0 || value > 100) {
          qzoneConfigStatus.textContent = rows[i][1] + ' 必须是 0–100 的整数。'
          return
        }
        patch[key] = value
      }
      qzoneConfigStatus.textContent = '正在保存…'
      postJSON('/dsh-fish-world/config', { qzone: patch }).then(function (result) {
        qzoneConfigStatus.textContent = result && result.ok ? 'QQ 空间设置已保存。' : '保存失败。'
      }).catch(function (error) { qzoneConfigStatus.textContent = '保存失败：' + (error && error.message || error) })
    })
    refresh()
  }
  buildQzoneSettings()

  var lastStickerQuery = ''
  function renderStickers(query) {
    lastStickerQuery = query || ''
    stickerListEl.textContent = ''
    var items = stickerState.items || []
    if (query) {
      var q = query.toLowerCase()
      items = items.filter(function (item) {
        return item.name.toLowerCase().indexOf(q) >= 0 || (item.tags || []).some(function (t) { return t.toLowerCase().indexOf(q) >= 0 })
      })
    }
    if (!items.length) { stickerListEl.appendChild(el('div', 'dshcp-empty', '还没有收藏的表情。鱼会在聊天里按心情挑喜欢的表情收藏。')); return }
    for (var i = 0; i < items.length; i++) (function (item) {
      var box = el('div', 'dshcp-card')
      var top = el('div', 'dshcp-market-tools')
      var img = elImg('/dsh-fish-world/sticker-image?id=' + encodeURIComponent(item.id), 'dshcp-sticker-thumb')
      img.style.width = '46px'
      img.style.height = '46px'
      img.style.objectFit = 'contain'
      img.style.background = 'rgba(127,127,127,.12)'
      img.style.borderRadius = '8px'
      top.appendChild(img)
      var meta = el('div', 'dshcp-grow')
      meta.appendChild(el('div', 'dshcp-cardtitle', item.name))
      meta.appendChild(el('div', 'dshcp-cardmeta', (item.tags || []).join('、') || '无标签'))
      top.appendChild(meta)
      box.appendChild(top)
      var row = el('div', 'dshcp-market-tools')
      var sendBtn = el('span', 'dshcp-btn', '发送')
      var tagBtn = el('span', 'dshcp-btn', '改标签')
      var delBtn = el('span', 'dshcp-btn dshcp-off', '删除')
      sendBtn.addEventListener('click', function () {
        var chat = window.prompt('发到（留空用 bridge 默认目标）：private:QQ号 / group:群号')
        postJSON('/dsh-fish-world/stickers/send', { id: item.id, chat: chat == null ? '' : chat })
          .then(function (r) { stickerSummaryEl.textContent = r.ok ? (r.dryRun ? '试运行，未真发' : '已发送') : (r.error || r.reason || '发送失败') })
          .catch(function (e) { stickerSummaryEl.textContent = '发送失败：' + (e && e.message) })
      })
      tagBtn.addEventListener('click', function () {
        var text = window.prompt('标签（逗号/空格分隔，如：开心 委屈 吃饭）', (item.tags || []).join(' '))
        if (text == null) return
        var tags = text.split(/[,，\s]+/).map(function (t) { return t.trim() }).filter(Boolean)
        postJSON('/dsh-fish-world/stickers/update', { id: item.id, tags: tags }).then(refreshStickers)
      })
      delBtn.addEventListener('click', function () {
        if (!window.confirm('删除这张表情「' + item.name + '」？')) return
        postJSON('/dsh-fish-world/stickers/remove', { id: item.id }).then(refreshStickers)
      })
      row.appendChild(sendBtn)
      row.appendChild(tagBtn)
      row.appendChild(delBtn)
      box.appendChild(row)
      stickerListEl.appendChild(box)
    })(items[i])
  }

  var stickerState = { items: [] }
  function refreshStickers() {
    getJSON('/dsh-fish-world/stickers').then(function (r) {
      stickerState.items = r.items || []
      stickerSummaryEl.textContent = '共 ' + (r.summary && r.summary.total) + ' 张，本小时还可收藏 ' + (r.summary && r.summary.remainingThisHour) + ' 张（上限 ' + (r.summary && r.summary.limit) + '/小时）'
      stickerLimitEl.value = String(r.summary && r.summary.limit)
      renderStickers(lastStickerQuery)
    }).catch(function () {
      stickerSummaryEl.textContent = '读不到表情收藏'
    })
  }

  function card(title, meta, description) {
    var box = el('div', 'dshcp-card')
    box.appendChild(el('div', 'dshcp-cardtitle', title || '（未命名扩展）'))
    if (meta) box.appendChild(el('div', 'dshcp-cardmeta', meta))
    if (description) {
      var desc = el('div', 'dshcp-carddesc', description)
      desc.addEventListener('click', function () { desc.classList.toggle('dshcp-full') })
      box.appendChild(desc)
    }
    return box
  }

  function refreshMarket() {
    extStatus.textContent = '正在读取可用的搜索入口…'
    getJSON('/dsh-fish-world/market?kind=' + encodeURIComponent(extState.kind)).then(function (result) {
      extState.links = Array.isArray(result.links) ? result.links : []
      extState.notice = String(result.notice || '')
      renderMarket()
      extStatus.textContent = extState.notice
    }).catch(function (error) {
      extState.links = []
      marketList.textContent = ''
      extStatus.textContent = '搜索入口读取失败：' + String(error.message || error)
    })
  }

  function renderMarket() {
    marketList.textContent = ''
    marketList.appendChild(el('div', 'dshcp-empty', '扩展由你自行搜索：本插件不托管、不镜像下载，只按你粘贴的原始 https 链接安装。'))
    var links = extState.links || []
    if (links.length) {
      var row = el('div', 'dshcp-market-tools')
      links.forEach(function (link) {
        var a = el('a', 'dshcp-btn', link.label)
        a.href = link.url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        row.appendChild(a)
      })
      marketList.appendChild(row)
    }
    marketList.appendChild(el('div', 'dshcp-empty', '支持 GitHub 仓库主页（自动取默认分支压缩包）或 ZIP 直链。压缩包需包含 ' + (extState.kind === 'plugin' ? 'plugin.json' : 'skill.json') + '；安装后默认禁用。'))
  }

  function installFromLink() {
    if (extState.busy) return
    var url = searchInput.value.trim()
    if (!url) { extStatus.textContent = '先粘贴扩展的 https 链接。'; return }
    if (!/^https:\/\//i.test(url)) { extStatus.textContent = '只接受 https 链接。'; return }
    if (!window.confirm('从该链接下载并安装扩展？扩展是本机原生代码，安装后保持禁用，不会立即执行。')) return
    extState.busy = true
    extStatus.textContent = '正在下载、校验并安全安装…'
    postJSON('/dsh-fish-world/market/install', { kind: extState.kind, url: url }).then(function (result) {
      if (!result.ok) throw new Error(result.error || '安装失败')
      searchInput.value = ''
      extStatus.textContent = '已安装 ' + result.name + '，当前保持禁用。检查设置和权限后，可在「已安装」里手动启用。'
      setExtView('installed')
    }).catch(function (error) {
      extStatus.textContent = '安装失败：' + String(error.message || error)
    }).finally(function () { extState.busy = false })
  }

  function refreshInstalled() {
    extStatus.textContent = '正在读取能力清单…'
    Promise.all([getJSON('/dsh-fish-world/extensions'), getJSON('/dsh-fish-world/capabilities')]).then(function (results) {
      var result = results[0]
      extState.installed = Array.isArray(result.extensions) ? result.extensions : []
      extState.catalog = results[1] || { built_in: [], plugins: [], skills: [] }
      renderInstalled()
      extStatus.textContent = extState.installed.length
        ? '已安装 ' + extState.installed.length + ' 个扩展；内置能力随鱼的世界运行'
        : '能力清单已就绪；尚无外部扩展，可按需安装'
    }).catch(function (error) { extStatus.textContent = '读取失败：' + String(error.message || error) })
  }

  function toggleExtension(item) {
    if (extState.busy) return
    var enabled = !item.enabled
    if (enabled && !window.confirm('启用「' + item.name + '」？插件是本机原生代码，会按它声明的权限运行。')) return
    extState.busy = true
    extStatus.textContent = (enabled ? '正在启用 ' : '正在停用 ') + item.id + '…'
    postJSON('/dsh-fish-world/enable', { id: item.id, enabled: enabled }).then(function (result) {
      if (!result.ok) throw new Error(result.error || '操作失败')
      extState.installed = result.extensions || []
      renderInstalled()
      extStatus.textContent = (enabled ? '已启用 ' : '已停用 ') + item.name
    }).catch(function (error) { extStatus.textContent = '操作失败：' + String(error.message || error) })
      .finally(function () { extState.busy = false })
  }

  function renderInstalled() {
    installedList.textContent = ''
    catalogList.textContent = ''
    var catalog = extState.catalog || { built_in: [], plugins: [], skills: [] }
    var groups = [
      ['DSH 内置核心模块', catalog.built_in || []],
      ['本地插件', catalog.plugins || []],
      ['模型技能', catalog.skills || []],
    ]
    groups.forEach(function (group) {
      catalogList.appendChild(el('div', 'dshcp-cardtitle', group[0]))
      if (!group[1].length) {
        catalogList.appendChild(el('div', 'dshcp-empty', '此分类暂无能力'))
        return
      }
      group[1].forEach(function (item) {
        var meta = (item.execution_mode === 'local' ? '本地执行' : '需要模型理解') +
          (item.is_hidden ? ' · 隐藏基建' : '') +
          (item.depends_on && item.depends_on.length ? ' · 依赖：' + item.depends_on.join('、') : '')
        catalogList.appendChild(card(item.name, meta, item.description))
      })
    })
    if (!extState.installed.length) {
      installedList.appendChild(el('div', 'dshcp-empty', '还没有已安装的外部扩展。内置能力由鱼的世界提供；需要时可从链接安装扩展。'))
      return
    }
    extState.installed.forEach(function (item) {
      var meta = [item.kind, item.version && ('v' + item.version), item.status, item.permissions && item.permissions.length && ('权限：' + item.permissions.join(', ')), item.requires && item.requires.length && ('依赖：' + item.requires.join(', '))].filter(Boolean).join(' · ')
      var box = card(item.name, meta, item.error || item.description)
      var configure = el('span', 'dshcp-btn', '设置')
      configure.addEventListener('click', function () { openExtensionSettings(item.id) })
      var toggle = el('span', 'dshcp-btn ' + (item.enabled ? 'dshcp-on' : 'dshcp-off'), item.enabled ? '停用' : '启用')
      toggle.addEventListener('click', function () { toggleExtension(item) })
      box.appendChild(configure)
      box.appendChild(toggle)
      installedList.appendChild(box)
    })
  }

  function openExtensionSettings(id) {
    extStatus.textContent = '读取扩展设置…'
    getJSON('/dsh-fish-world/extension?id=' + encodeURIComponent(id)).then(function (result) {
      if (!result.ok || !result.extension) throw new Error(result.error || '扩展不存在')
      renderExtensionSettings(result.extension)
      extStatus.textContent = ''
    }).catch(function (error) { extStatus.textContent = '设置读取失败：' + String(error.message || error) })
  }

  function renderExtensionSettings(extension) {
    settingsPane.textContent = ''
    marketList.style.display = 'none'
    installedList.style.display = 'none'
    extControls.style.display = 'none'
    settingsPane.style.display = 'block'
    var back = el('span', 'dshcp-btn', '← 返回扩展列表')
    back.addEventListener('click', function () { settingsPane.style.display = 'none'; setExtView('installed') })
    settingsPane.appendChild(back)
    settingsPane.appendChild(el('div', 'dshcp-cardtitle', extension.name + ' 设置'))
    if (extension.description) settingsPane.appendChild(el('div', 'dshcp-cardmeta', extension.description))
    var schema = extension.configSchema || {}
    var controls = Object.create(null)
    var secretClear = Object.create(null)
    var fields = Object.entries(schema)
    if (!fields.length) settingsPane.appendChild(el('div', 'dshcp-empty', '此扩展没有声明可编辑的设置项。'))

    fields.forEach(function (entry) {
      var key = entry[0]
      var field = entry[1] || {}
      var value = extension.settings ? extension.settings[key] : undefined
      var wrap = el('div', 'dshcp-field')
      var label = el('label', null, String(field.label || key) + (field.secret ? '（密钥）' : ''))
      wrap.appendChild(label)
      if (field.description) wrap.appendChild(el('small', null, String(field.description)))
      var control
      var type = field.type || 'string'
      if (type === 'boolean') {
        control = document.createElement('input')
        control.type = 'checkbox'
        control.checked = value === true
      } else if (Array.isArray(field.enum)) {
        control = document.createElement('select')
        control.className = 'dshcp-select'
        field.enum.forEach(function (option) {
          var opt = document.createElement('option')
          opt.value = JSON.stringify(option)
          opt.textContent = String(option)
          opt.selected = JSON.stringify(option) === JSON.stringify(value)
          control.appendChild(opt)
        })
      } else if (type === 'array' || type === 'object') {
        control = document.createElement('textarea')
        control.className = 'dshcp-textarea'
        control.value = value === undefined ? (type === 'array' ? '[]' : '{}') : JSON.stringify(value, null, 2)
      } else {
        control = document.createElement('input')
        control.type = field.secret ? 'password' : (type === 'number' || type === 'integer' ? 'number' : 'text')
        if (type === 'number') control.step = 'any'
        if (type === 'integer') control.step = '1'
        if (Number.isFinite(field.minimum)) control.min = String(field.minimum)
        if (Number.isFinite(field.maximum)) control.max = String(field.maximum)
        if (Number.isFinite(field.maxLength)) control.maxLength = field.maxLength
        control.value = field.secret ? '' : (value == null ? '' : String(value))
        if (field.secret && extension.hasSecrets && extension.hasSecrets[key]) control.placeholder = '已保存；留空表示不修改'
      }
      controls[key] = control
      wrap.appendChild(control)
      if (field.secret && extension.hasSecrets && extension.hasSecrets[key]) {
        var clearLabel = el('label')
        var clear = document.createElement('input')
        clear.type = 'checkbox'
        secretClear[key] = clear
        clearLabel.appendChild(clear)
        clearLabel.appendChild(document.createTextNode(' 清除此密钥'))
        wrap.appendChild(clearLabel)
      }
      settingsPane.appendChild(wrap)
    })

    var save = el('span', 'dshcp-btn dshcp-on', '保存并应用')
    save.addEventListener('click', function () {
      var patch = {}
      var clearSecrets = []
      try {
        fields.forEach(function (entry) {
          var key = entry[0]
          var field = entry[1] || {}
          var control = controls[key]
          if (secretClear[key] && secretClear[key].checked) { clearSecrets.push(key); return }
          if (field.secret && !control.value) return
          var type = field.type || 'string'
          if (type === 'boolean') patch[key] = !!control.checked
          else if (Array.isArray(field.enum)) patch[key] = JSON.parse(control.value)
          else if (type === 'number' || type === 'integer') patch[key] = Number(control.value)
          else if (type === 'array' || type === 'object') patch[key] = JSON.parse(control.value)
          else patch[key] = control.value
        })
      } catch (error) { extStatus.textContent = '设置格式错误：' + String(error.message || error); return }
      save.classList.add('dshcp-off')
      postJSON('/dsh-fish-world/extension/settings', { id: extension.id, settings: patch, clearSecrets: clearSecrets, reload: true })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error || '保存失败')
          extStatus.textContent = '设置已保存'
          renderExtensionSettings(result.extension)
        })
        .catch(function (error) { extStatus.textContent = '保存失败：' + String(error.message || error); save.classList.remove('dshcp-off') })
    })
    settingsPane.appendChild(save)
  }

  // ---- 刷新 ----
  function refreshMood() {
    getJSON('/dsh-feiyu-mood/state').then(function (d) { state.mood = d; renderMood() }).catch(function () { state.mood = { ok: false }; renderMood() })
  }

  function refreshTts() {
    Promise.all([
      getJSON('/dsh-tts-bridge/status').catch(function () { return { ok: false } }),
      getJSON('/dsh-tts-bridge/sessions').catch(function () { return { ok: false } }),
      getJSON('/dsh-tts-bridge/favorites').catch(function () { return { ok: false } }),
    ]).then(function (r) {
      state.tts = r[0]
      renderTts()
      renderTtsButtons()
      renderTtsSessions(r[1])
      renderTtsFavs(r[2])
    })
  }

  // ---- 隐藏 / 恢复原挂件 ----
  // 认朗读桥卡要靠「它是什么」，不能靠 z-index 数字：
  // 鱼世界自己的面板是 2147483002，字符串里同样含有 2147483000，
  // 拿数字比对会把面板自己也认成朗读桥卡（真实后果：开关一开，面板跟着被藏）。
  // 稳定的特征是内容（卡片标题写着「朗读桥」）+ 它是 position:fixed 的浮层。
  function ttsCardElements() {
    var out = []
    var divs = document.querySelectorAll('div[style]')
    for (var i = 0; i < divs.length; i++) {
      var node = divs[i]
      var style = node.getAttribute('style') || ''
      if (style.indexOf('fixed') === -1) continue
      // 自身文字里有「朗读桥」才算；子元素里的不算（避免把外层面板认进来）。
      if (String(node.textContent || '').indexOf('朗读桥') === -1) continue
      out.push(node)
    }
    return out
  }
  function applyOriginals() {
    try {
      // 只藏/放我们自己该管的两个挂件（心情、朗读桥），且按内容识别。
      // 鲸鱼（.dshwv-root / .dshwv-pop）不再碰：与 dsh-whale-widget 解耦后，
      // 每 2 秒去改它的显示属于「影响别人运行」，主人 2026-10-26 明确要求断开。
      var mood = document.querySelectorAll('.fm-widget')
      for (var j = 0; j < mood.length; j++) mood[j].style.display = SHOW_MOOD ? '' : 'none'
      var tts = ttsCardElements()
      for (var k = 0; k < tts.length; k++) tts[k].style.display = SHOW_TTS ? '' : 'none'
    } catch (e) {}
  }

  onStorageSync(function (key) {
    if (['showMood', 'showTts'].indexOf(key) === -1) return
    reloadKey(key)
    // 重新渲染所有受影响的齿轮开关状态
    var gearPopOpen = gearPop.classList.contains('dshcp-open')
    foot.textContent = ''
    foot.appendChild(hintEl)
    gearWrap.textContent = ''
    gearWrap.appendChild(gearBtn)
    gearWrap.appendChild(gearPop)
    foot.appendChild(gearWrap)
    buildGearLines()
    if (gearPopOpen) gearPop.classList.add('dshcp-open')
    applyOriginals()
  })

  // 原挂件可能在我们之后才渲染：反复重试 + 观察 DOM 变化
  var observer = null
  try {
    observer = new MutationObserver(function () { applyOriginals() })
    observer.observe(document.body, { childList: true, subtree: true })
  } catch (e) {}

  // ---- 启动 ----
  refreshMood()
  refreshTts()
  refreshDiary()
  refreshStickers()
  refreshEnv(false)
  applyOriginals()

  setInterval(refreshMood, 6000)
  setInterval(refreshTts, 4000)
  setInterval(refreshStickers, 10000)
  setInterval(refreshDiary, 30000)
  setInterval(applyOriginals, 2000)
  // 服务端有 60s 缓存；面板打开或设置页可见时才轮询，关掉就安静。
  setInterval(function () {
    if (SETTINGS_MODE || root.classList.contains('dshcp-open')) refreshEnv(false)
  }, 60000)
})()
