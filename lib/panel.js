// dsh-fish-world 面板的兜底：只有在 ui/panel.js 读不到时才会加载到这里。
//
// 这里刻意不复制一份 UI。曾经这里有一份 1800 行的旧面板，结果是：
//   · 它停留在几个月前的能力，缺了后来加的 QQ 白名单、知识库、收藏、AstrBot 等；
//   · 每加一个功能都要判断要不要两边都改，已经因此出过漂移；
//   · 真正出错时，用户看到的是一个「看起来能用、其实少一半」的面板，比白屏更难查。
// 所以这里只做一件事：把「缺了什么、怎么修」说清楚。不假装能用。
;(function () {
  'use strict'
  if (window.__dshcpInited) return
  window.__dshcpInited = true

  var NOTE = [
    '鱼的面板文件没有加载出来（ui/panel.js 读不到）。',
    '这不是你的设置丢了，只是面板没渲染。',
    '',
    '可以这样修：',
    '1. 确认插件目录里的 ui/ 文件夹完整（panel.js、panel.css、tokens.css）；',
    '2. 重装一次：dsh plugin --profile desktop add dsh-fish-world；',
    '3. 修好后刷新这个页面。',
  ]

  function paint() {
    var host = document.getElementById('app') || document.body
    if (!host) return
    host.textContent = ''
    var box = document.createElement('div')
    box.setAttribute('role', 'alert')
    // 这里拿不到 panel.css，但要显示得体面：颜色全走 token，取不到时 CSS 会回退到继承色。
    box.style.cssText = 'max-width:560px;margin:48px auto;padding:24px;' +
      'border:1px solid var(--border-subtle, rgba(128,128,128,.28));' +
      'border-radius:var(--radius-md, 12px);' +
      'font:var(--text-body, 13px)/1.6 var(--font-ui, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);' +
      'color:var(--text-primary, inherit);background:transparent;white-space:pre-wrap'
    box.textContent = NOTE.join('\n')
    host.appendChild(box)
    // 控制台也留一份：面板不可用时，控制台是唯一能看到的记录。
    try { console.error('dsh-fish-world: ' + NOTE.join(' ')) } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paint)
  } else {
    paint()
  }
})()
