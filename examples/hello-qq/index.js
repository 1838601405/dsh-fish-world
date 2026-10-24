// QQ Agent 0.5 风格示例扩展。
// 复制到 ~/.dsh/plugin-ecosystem/plugins/hello-qq 后，在 qq_ecosystem 工具里
// action=enable id=hello-qq 即可启用。
export default {
  setup(ctx) {
    ctx.log.info('hello-qq 已装载（适配器示例）')

    // 读鲸鱼挂件当前角色（内置能力，不需要额外权限）。
    ctx.registerTool({
      id: 'whoami',
      name: '当前角色',
      description: '返回 dsh-whale-widget 当前置顶角色与余额。',
      params: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async handler() {
        const persona = ctx.capability('whale.persona').get()
        const role = persona.role
        return {
          content: `角色「${role.name}」${persona.usage ? `｜余额 ${persona.usage.balance} ${persona.usage.currency}` : ''}`,
          role,
          usage: persona.usage,
        }
      },
    })

    // 发一条 QQ：仍受 bridge 的总开关 / 试运行 / 转私聊 / 转群约束。
    ctx.registerTool({
      id: 'say',
      name: '发到 QQ',
      description: '把一句话发到 dsh-qq-bridge 配置的 QQ 私聊或群。',
      params: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 2000, description: '要发的内容' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async handler({ text }) {
        const greeting = ctx.config.get('greeting') || ''
        const body = greeting ? `${greeting}——${text}` : text
        const receipt = await ctx.send('', [{ type: 'text', text: body }])
        if (!receipt.ok) return { content: `没发出去：${receipt.reason}`, isError: true }
        return { content: receipt.dryRun ? `试运行，未真发（${receipt.reason}）` : '已发到 QQ', receipt }
      },
    })

    // 旁听 QQ 消息（bridge 注入 DSH 后触发）。
    ctx.events.on('message.in', (message) => {
      ctx.log.info(`收到 QQ 消息：${String(message.text || '').slice(0, 60)}`)
    })

    ctx.prompt.add({
      id: 'hello-qq',
      title: 'QQ 示例扩展',
      priority: 40,
      content: '需要把一句话发到 QQ 时，可以调用 hello-qq 的 say 工具；它不会绕过主人的总开关。',
    })
  },
}
