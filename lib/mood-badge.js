// 主界面合并脚本（有鲸鱼时注入到鲸鱼那一行）。
//
// 主界面上原本有三个右下角挂件：鲸鱼（dsh-whale-widget）、鱼的心情挂饰
// （dsh-feiyu-mood 的 .fm-widget）、朗读桥小卡（dsh-tts-bridge，无 class，只能按
// 内联 z-index 认）。三个都固定在右下角，会叠在一起。
//
// 这里做两件事：
//   1. 把心情（以及正在朗读的状态）并进鲸鱼身上的一个徽标；
//   2. 默认收起心情挂饰和朗读桥小卡，让主界面只剩鲸鱼和它的余额气泡。
//
// 两个原挂件没有删掉，仍可在 Harness 设置 →「鱼的世界」→ 齿轮里单独放出来；
// 这里监听 localStorage 的 dshcp.showMood / dshcp.showTts，改完立刻生效。
;(function () {
	'use strict'
	if (window.__dshFishWorldMergeBadgesV2) return
	window.__dshFishWorldMergeBadgesV2 = true

	const STYLE_ID = 'dsh-fish-world-mood-badge-style'
	const BUBBLE_STYLE_ID = 'dsh-fish-world-bubble-visibility'
	const CLASS_NAME = 'dsh-fish-world-mood-badge'
	const CSS = [
		'.' + CLASS_NAME + '{position:absolute;left:4%;bottom:4%;z-index:20;max-width:78%;padding:4px 9px;',
		'border:1px solid rgba(255,255,255,.2);border-radius:999px;background:rgba(20,22,30,.84);',
		'color:#f5f6fa;font:600 12px/1.4 system-ui,"Microsoft YaHei",sans-serif;white-space:nowrap;',
		'overflow:hidden;text-overflow:ellipsis;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.28)}',
		'.dshwv-root.dshwv-left .' + CLASS_NAME + '{transform:scaleX(-1)}',
	].join('')

	function installStyle() {
		if (document.getElementById(STYLE_ID)) return
		const style = document.createElement('style')
		style.id = STYLE_ID
		style.textContent = CSS
		;(document.head || document.documentElement).appendChild(style)
	}

	// 与面板共用同一套开关（dshcp.*），默认：徽标开、气泡开、原挂件关。
	function flag(key, fallback) {
		try {
			const value = window.localStorage.getItem('dshcp.' + key)
			return value == null ? fallback : value === '1'
		} catch (error) {
			return fallback
		}
	}

	function bubbleStyle() {
		let style = document.getElementById(BUBBLE_STYLE_ID)
		if (!style) {
			style = document.createElement('style')
			style.id = BUBBLE_STYLE_ID
			;(document.head || document.documentElement).appendChild(style)
		}
		style.textContent = flag('showBubble', true) ? '' : '.dshwv-pop{display:none !important}'
	}

	// 朗读桥小卡没有 id/class，只能按它唯一的内联 z-index 认；鱼世界面板自己用的是
	// 2147483002 / 2147483003 / 2147483004，不会被误伤。
	function ttsCards() {
		return document.querySelectorAll('div[style*="2147483000"]')
	}

	function applyVisibility() {
		const showBadge = flag('showBadge', true)
		const showMoodWidget = flag('showMood', false)
		const showTtsCard = flag('showTts', false)
		for (const badge of document.querySelectorAll('.' + CLASS_NAME)) {
			badge.style.display = showBadge ? '' : 'none'
		}
		for (const node of document.querySelectorAll('.fm-widget')) {
			node.style.display = showMoodWidget ? '' : 'none'
		}
		for (const node of ttsCards()) {
			node.style.display = showTtsCard ? '' : 'none'
		}
		bubbleStyle()
	}

	let moodLabel = ''
	let ttsPlaying = false
	let busy = false

	async function readMood() {
		try {
			const response = await fetch('/dsh-feiyu-mood/state', {
				cache: 'no-store',
				headers: { accept: 'application/json' },
			})
			if (!response.ok) return
			const state = await response.json()
			if (!state || state.ok !== true) return
			moodLabel = [state.emoji, state.moodLabel || '心情', state.mood == null ? '' : String(state.mood)]
				.filter(Boolean)
				.join(' · ')
		} catch {
			// 心情是可选插件：读不到就保持上一次的标签，绝不打扰鲸鱼本身。
		}
	}

	async function readTts() {
		try {
			const response = await fetch('/dsh-tts-bridge/status', {
				cache: 'no-store',
				headers: { accept: 'application/json' },
			})
			if (!response.ok) return
			const state = await response.json()
			ttsPlaying = !!(state && state.ok === true && state.playing)
		} catch {
			ttsPlaying = false
		}
	}

	function renderBadges() {
		const label = [moodLabel, ttsPlaying ? '朗读中' : ''].filter(Boolean).join(' · ')
		if (!label) return
		installStyle()
		for (const root of document.querySelectorAll('.dshwv-root')) {
			let badge = root.querySelector('.' + CLASS_NAME)
			if (!badge) {
				badge = document.createElement('div')
				badge.className = CLASS_NAME
				root.appendChild(badge)
			}
			badge.textContent = label
			badge.title = label
		}
	}

	async function refresh() {
		if (busy) return
		busy = true
		try {
			// 鲸鱼还没出现时也要收起原挂件，避免它先渲染出来抢右下角。
			if (document.querySelector('.dshwv-root')) {
				await Promise.all([readMood(), readTts()])
			}
			renderBadges()
			applyVisibility()
		} finally {
			busy = false
		}
	}

	let timer = 0
	function schedule() {
		if (timer) return
		timer = window.setTimeout(function () {
			timer = 0
			void refresh()
		}, 250)
	}

	const observer = new MutationObserver(schedule)
	observer.observe(document.documentElement, { childList: true, subtree: true })

	window.addEventListener('storage', function (event) {
		if (!event.key || event.key === 'dshcp.showBadge' || event.key === 'dshcp.showBubble' ||
			event.key === 'dshcp.showMood' || event.key === 'dshcp.showTts') {
			applyVisibility()
			if (event.key === 'dshcp.showBadge' || !event.key) schedule()
		}
	})

	void refresh()
	// 状态 15 秒一刷；可见性 2 秒一兜底，防止原挂件自己把 display 改回来。
	window.setInterval(function () { void refresh() }, 15000)
	window.setInterval(applyVisibility, 2000)
})()
