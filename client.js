/**
 * DSH client half: add one row to Harness Settings and host the fish-world manager
 * in that page. The manager is deliberately not injected over the whale widget.
 */
window.__ModuleLoader__.load({
	id: 'dsh-fish-world',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement

		function SettingsPanel() {
			return h('section', {
				style: {
					display: 'flex',
					flexDirection: 'column',
					gap: '8px',
					width: '100%',
					minHeight: '75vh',
				},
			}, [
				h('div', {
					key: 'description',
					style: { opacity: 0.72, fontSize: '12px', lineHeight: 1.5 },
				}, '管理鱼的世界、QQ Agent 扩展安装来源、已安装扩展与设置。鲸鱼挂件继续在主界面独立运行，心情状态显示在鲸鱼上。'),
				h('iframe', {
					key: 'manager',
					title: '鱼的世界',
					src: '/dsh-fish-world/settings',
					style: {
						width: '100%',
						minHeight: '72vh',
						flex: 1,
						border: '0',
						borderRadius: '10px',
						background: 'transparent',
					},
				}),
			])
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
				if (!slots) return
				// 设置入口必须永远可达：它自己就是恢复其它隐藏项的入口，隐藏它会让用户
				// 无法再打开「鱼的世界」，所以这里不做条件注册。旧版本写入的
				// dshcp.showSettings='0' 在这里自动纠正回来。
				try {
					if (window.localStorage.getItem('dshcp.showSettings') === '0') {
						window.localStorage.setItem('dshcp.showSettings', '1')
					}
				} catch (error) {}
				slots.inject('settings.section', () => slots.register(
					{ name: 'settings.section', id: 'fish-world', order: 45, label: '鱼的世界' },
					() => h(SettingsPanel),
				))
			},
		}
	},
})
