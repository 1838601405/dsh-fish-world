/**
 * DSH 客户端半边：把「鱼的世界」注册成左侧栏的独立入口 + 主区域整页面板。
 *
 * 为什么不再放设置里：设置页是表单流的容器，鱼世界是一个需要常驻、
 * 需要整页宽度（12 列便当盒、拖拽重排）的管理界面，塞在设置弹窗里
 * 既挤又要滚。左侧栏入口是 DSH 给独立面板的标准位置。
 *
 * 设置入口仍然保留：有些用户习惯从「设置」进入，两处并存不冲突。
 */
window.__ModuleLoader__.load({
	id: 'dsh-fish-world',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement

		// 与 settings.section 共用同一个 iframe 页面，只是占满主区域。
		function FishWorldFrame({ title }) {
			return h('iframe', {
				title,
				src: '/dsh-fish-world/settings',
				style: {
					width: '100%',
					height: '100%',
					minHeight: '60vh',
					flex: 1,
					border: '0',
					borderRadius: '10px',
					background: 'transparent',
					display: 'block',
				},
			})
		}

		/** 左侧栏整页面板（点侧栏入口后占满主区域）。 */
		function FishWorldPage() {
			return h('div', {
				style: {
					display: 'flex',
					flexDirection: 'column',
					width: '100%',
					height: '100%',
					minHeight: '70vh',
					gap: '8px',
				},
			}, [h(FishWorldFrame, { key: 'frame', title: '鱼的世界' })])
		}

		/**
		 * 侧栏图标：不依赖宿主图标库（不同 DSH 版本导出的图标名不一样），
		 * 用内联 SVG 画一条鱼，尺寸跟随侧栏给的 size。
		 */
		function FishWorldIcon({ size }) {
			const edge = Number(size) || 16
			return h('svg', {
				width: edge,
				height: edge,
				viewBox: '0 0 16 16',
				fill: 'none',
				'aria-hidden': 'true',
				style: { display: 'block' },
			}, [
				h('path', {
					key: 'body',
					d: 'M1.6 8c1.5-2.3 3.8-3.6 6.2-3.6 2.6 0 4.6 1.4 5.7 3.6-1.1 2.2-3.1 3.6-5.7 3.6C5.4 11.6 3.1 10.3 1.6 8Z',
					stroke: 'currentColor',
					strokeWidth: '1.1',
					strokeLinejoin: 'round',
				}),
				h('circle', { key: 'eye', cx: '5.6', cy: '7.5', r: '0.85', fill: 'currentColor' }),
				h('path', {
					key: 'tail',
					d: 'M13.2 5.6 15 8l-1.8 2.4',
					stroke: 'currentColor',
					strokeWidth: '1.1',
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				}),
			])
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
				if (!slots) return

				// 设置入口必须永远可达：它自己就是恢复其它隐藏项的入口。
				try {
					if (window.localStorage.getItem('dshcp.showSettings') === '0') {
						window.localStorage.setItem('dshcp.showSettings', '1')
					}
				} catch (error) {}

				// 1) 左侧栏入口：点一下占满主区域
				try {
					slots.inject('sidebar.panellist', () => slots.register({
						name: 'sidebar.panellist',
						id: 'fish-world',
						order: 30,
						label: () => '鱼的世界',
					}, FishWorldIcon))
				} catch (error) {
					console.warn('[fish-world] 注册左侧栏入口失败：', error)
				}

				// 2) 主区域整页：key 与侧栏 id 相同，DSH 才能配对
				try {
					slots.inject('main', () => slots.register({
						name: 'main',
						key: 'fish-world',
					}, FishWorldPage))
				} catch (error) {
					console.warn('[fish-world] 注册主面板失败：', error)
				}

				// 不再注册 settings.section：左侧栏已有独立入口，设置列表里再来一条
				// 只会重复。面板内部仍保留「设置」入口以兼容旧链接。
			},
		}
	},
})
