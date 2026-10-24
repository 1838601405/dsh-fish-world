// 暴露给 DSH 模型的能力入口：fish_world / qq_ecosystem；纯基础设施不得进工具列表。
// 模型可以查状态、开关扩展、看 QQ 历史、用 whale 人格发一条 QQ。
import { oneLine } from './util.mjs'
import { environmentView } from './env.mjs'
import { describeSegments } from './qq.mjs'
import { dependencyCheck, updateCheck } from './doctor.mjs'

const ACTIONS = ['status', 'list', 'enable', 'disable', 'reload', 'send', 'persona', 'stickers', 'history', 'forward', 'qq-status', 'sticker-list', 'sticker-collect', 'sticker-send', 'sticker-tags', 'sticker-remove', 'link-list', 'link-collect', 'link-remove', 'world', 'relations', 'diary', 'diary-comment-ack', 'wish', 'growth', 'platforms', 'doctor', 'env-check', 'qzone-status', 'qzone-feeds', 'qzone-comments', 'qzone-post', 'qzone-diary', 'qzone-like', 'qzone-comment', 'qzone-reply']

// 这些动作真的要和 QQ 桥通信；前置插件没装时直接给出安装命令，而不是等超时。
const BRIDGE_ACTIONS = new Set(['send', 'history', 'forward', 'qq-status', 'sticker-send', 'qzone-status', 'qzone-feeds', 'qzone-comments', 'qzone-post', 'qzone-diary', 'qzone-like', 'qzone-comment', 'qzone-reply'])

// history 里最多展开几条聊天记录、总共多少行，避免一条长记录把上下文撑爆。
const FORWARD_EXPAND_RECORDS = 2
const FORWARD_EXPAND_ENTRIES = 20
const FORWARD_EXPAND_TOTAL = 40

function forwardLine(entry) {
  const text = oneLine(entry.text, 100) || describeSegments(entry.parts) || '（非文字内容）'
  return `${entry.nickname || entry.userId || '某人'}：${text}`
}

function environmentStatus(environment) {
  try { return environment?.status?.() || null } catch { return null }
}

function missingPackages(env) {
  return new Set((env?.packages || []).filter((item) => !item.found).map((item) => item.name))
}

function installCommand(env, name) {
  const item = (env?.packages || []).find((pkg) => pkg.name === name)
  return `dsh plugin --profile ${env?.profile || 'desktop'} add ${item?.spec || name}`
}

function sessionIdFromExec(exec) {
  try {
    const agent = exec && (exec.agent || exec.caller || exec.agentRef)
    const session = agent?.session || exec?.session
    if (typeof session === 'string') return session
    if (session && typeof session.id === 'string') return session.id
    for (const key of ['sessionId', 'id']) if (typeof agent?.[key] === 'string') return agent[key]
    if (typeof exec?.sessionId === 'string') return exec.sessionId
  } catch {}
  return ''
}

export function buildEcosystemTool({ loader, qq, whale, world, stickers, links, qzone, environment, growth, platforms, astrbot, toolName = 'fish_world' }) {
  return {
    name: toolName,
    description:
      '鱼的世界统一入口。可查看 QQ 桥、鲸鱼状态和 QQ Agent 扩展；管理扩展；读取 QQ 历史；' +
      '以鲸鱼当前角色发一条 QQ 消息；管理鱼收藏的表情；在主人的隔离会话中浏览和打理鱼自己的 QQ 空间；' +
      '检查前置插件是否装齐（action=env-check）。' +
      'history 会把图片、动图、表情包、语音、视频、卡片和合并转发的聊天记录都标出来，' +
      '遇到 [聊天记录:id] 再用 action=forward 展开里面的内容。' +
      '发送默认受 dsh-qq-bridge 的总开关、试运行、转私聊/转群限制，不会绕过。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: '要执行的动作。',
          enum: ACTIONS,
        },
        id: {
          type: 'string',
          description: 'enable / disable 时要操作的扩展 id。',
        },
        chat: {
          type: 'string',
          description: '目标聊天：private:QQ号 / group:群号；留空 = 用 bridge 配置的默认目标。',
        },
        text: {
          type: 'string',
          description: 'send 时要发的文字。',
        },
        image: {
          type: 'string',
          description: 'send 时可选的图片：http(s) URL 或本机绝对路径。',
        },
        query: {
          type: 'string',
          description: 'stickers / sticker-list 时按 id / 名称 / 标签过滤，也可作为 sticker-send 的旧式查找参数。',
        },
        forwardId: {
          type: 'string',
          description: 'forward 时要展开的聊天记录 id（history 返回的 [聊天记录:id] 里的那串）。',
        },
        limit: {
          type: 'number',
          description: 'history 时最多取多少条（1-100，默认 20）。',
        },
        people: {
          type: 'array',
          items: { type: 'object', additionalProperties: true, properties: {} },
          description: 'relations 更新时使用的关系列表（每项含 qqId/name/role/chatKey/sessionId 等）。',
        },
        actorName: {
          type: 'string',
          description: 'diary 写入时的可选署名；留空默认用鱼当前的外显角色名。',
        },
        role: {
          type: 'string',
          description: 'diary 写入来源等级：owner 或 trusted。',
        },
        date: {
          type: 'string',
          description: 'diary 查询某一天的日记（YYYY-MM-DD）。',
        },
        url: { type: 'string', description: 'sticker-collect 的 HTTP(S) 图片地址。' },
        localPath: { type: 'string', description: 'sticker-collect 的本机图片路径。' },
        tags: { type: 'array', items: { type: 'string' }, description: '表情标签。' },
        name: { type: 'string', description: '收藏名称；发送、改标签或删除时也可用于查找。' },
        note: { type: 'string', description: '收藏或发送时的可选说明；diary-comment-ack 时作为回应备注。' },
        kind: { type: 'string', description: 'wish 的类别；growth 的类别；link-collect 的链接类型（design / reference / tool / article / inspiration / other）。' },
        urgency: { type: 'string', description: 'wish 的紧急度：low / normal / high。' },
        quote: { type: 'string', description: 'growth 记录可附的一句原文引用（来自日记或批语）。' },
        source: {
          type: 'object',
          additionalProperties: true,
          properties: {},
          description: 'growth 记录的来源线索，例如 { type: "diary", id: "..." }。',
        },
        uin: { type: 'string', description: 'Qzone 动态作者 QQ 号（从 qzone-feeds 返回值中使用）。' },
        tid: { type: 'string', description: 'Qzone 动态 ID（从 qzone-feeds 返回值中使用）。' },
        count: { type: 'number', description: 'qzone-feeds 每次最多读取多少条。' },
        commentId: { type: 'string', description: 'qzone-reply 用 qzone-comments 返回的评论 ID；diary-comment-ack 用日记批语 id（来自 [comment:id]）。' },
        commentUin: { type: 'string', description: '回复时使用 qzone-comments 返回的评论作者 QQ 号。' },
        diary: { type: 'boolean', description: 'qzone-post=true 时按日记额度计数。' },
        title: { type: 'string', description: 'qzone-diary 的可选标题，仅用于返回与记录。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          content: { type: 'string' },
          note: { type: 'string' },
          extensions: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          receipt: { type: 'object', additionalProperties: true, properties: {} },
          persona: { type: 'object', additionalProperties: true, properties: {} },
          stickers: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          messages: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          status: { type: 'object', additionalProperties: true, properties: {} },
          bridge: { type: 'object', additionalProperties: true, properties: {} },
          login: { type: 'object', additionalProperties: true, properties: {} },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const text = value && typeof value === 'object'
          ? (typeof value.content === 'string' && value.content ? value.content : JSON.stringify(value, null, 2))
          : String(value ?? '')
        return [{ type: 'text', text }]
      },
    },
    async execute(args = {}, exec = {}) {
      const action = String(args.action || '')
      const env = environmentStatus(environment)
      try {
        if (action === 'env-check') {
          const fresh = environment?.check?.() || env
          if (!fresh) return { ok: false, error: '环境检查不可用：宿主没有提供环境检查器。' }
          const content = fresh.ok
            ? `运行环境正常：Node ${fresh.node?.version || process.version}，${fresh.packages.length} 个前置插件已安装，插件接线正常。`
            : fresh.warnings.join('\n') + (fresh.hints.length ? '\n修复方式：' + fresh.hints.map((item) => item.command || item.label).join('；') : '')
          return { ok: fresh.ok, content, environment: environmentView(fresh) }
        }
        if (BRIDGE_ACTIONS.has(action) && missingPackages(env).has('dsh-qq-bridge')) {
          // 主人把 AstrBot 当 QQ 通道时，QQ 桥不是必需的，别继续报"缺少 dsh-qq-bridge"。
          const viaAstrBot = (() => {
            try { return astrbot?.view?.()?.canUseForQQ === true } catch { return false }
          })()
          if (!viaAstrBot) {
            return {
              ok: false,
              error: `缺少前置插件 dsh-qq-bridge（QQ 桥），${action} 现在不可用。安装后重启 DSH：${installCommand(env, 'dsh-qq-bridge')}`,
              missing: ['dsh-qq-bridge'],
            }
          }
        }
        const qzoneActions = new Set(['qzone-status', 'qzone-feeds', 'qzone-comments', 'qzone-post', 'qzone-diary', 'qzone-like', 'qzone-comment', 'qzone-reply'])
        if (qzoneActions.has(action)) {
          const platformGate = platforms ? platforms.gate('qq', 'qzone') : { ok: true }
          if (!platformGate.ok) return { ok: false, error: platformGate.reason }
          const sessionId = sessionIdFromExec(exec)
          if (!sessionId || !world.isOwnerSession(sessionId)) {
            return { ok: false, error: 'QQ 空间仅允许在主人的隔离会话中使用。' }
          }
          if (action === 'qzone-status') {
            const status = qzone.status()
            const usage = status.usage?.byKind || {}
            return {
              ok: status.ok,
              content: status.ok
                ? `QQ 空间${status.enabled ? '已启用' : '已停用'}；动态/日记 ${usage.post?.remaining ?? 0}，点赞 ${usage.like?.remaining ?? 0}，评论 ${usage.comment?.remaining ?? 0}，回复 ${usage.reply?.remaining ?? 0} 次额度剩余。`
                  + `日记${status.diaryDue ? '已到 24 小时提醒时间' : '尚未到提醒时间'}。`
                : status.error,
              status,
            }
          }
          if (action === 'qzone-feeds') {
            const result = await qzone.listFeeds(args.count)
            return { ok: true, content: result.items.length
              ? result.items.map((item) => `[${item.nickname}(${item.uin}) ${item.time || ''}] ${item.content}（tid:${item.tid}）`).join('\n')
              : '暂时没有读取到好友动态。', feeds: result.items, hasMore: result.hasMore }
          }
          if (action === 'qzone-comments') {
            const result = await qzone.listComments(args.uin || '', args.tid || '')
            return { ok: true, content: result.comments.length
              ? result.comments.map((item) => `${item.nickname}(${item.uin}) [comment:${item.id}]：${item.content}`).join('\n')
              : '这条动态没有读取到评论。', comments: result.comments }
          }
          if (action === 'qzone-post' || action === 'qzone-diary') {
            if (action === 'qzone-diary' && !String(args.text || '').trim()) {
              const material = qzone.diaryMaterial()
              const comments = material.comments || []
              return {
                ok: material.ok,
                content: material.ok
                  ? `${material.diaryDue ? '空间日记已到期' : '空间日记尚未到期'}；今日动态/日记额度还剩 ${material.remainingToday} 次。\n`
                    + (material.entries.length ? material.entries.map((entry) => `${entry.actorName || '我'}：${oneLine(entry.text, 140)}`).join('\n') : '鱼世界里还没有已批准的日记素材。')
                    + (comments.length
                      ? '\n\n主人在你之前日记上留了批语（还没回应）：\n' + comments.map((item) => {
                        const quote = item.quote ? `〔原句「${oneLine(item.quote, 60)}」〕` : ''
                        return `- [comment:${item.id}]${quote}${oneLine(item.text, 120)}`
                      }).join('\n')
                        + '\n写新日记时可以用一两句自然回应其中一部分，不要逐条复述成回复列表。回应过的批语用 action=diary-comment-ack 标记。'
                      : '')
                  : material.error,
                material,
              }
            }
            const result = await qzone.post({ text: args.text, diary: action === 'qzone-diary' || args.diary === true, title: args.title })
            return { ...result, content: result.content || 'QQ 空间动态已处理。' }
          }
          if (action === 'qzone-like') return await qzone.like({ uin: args.uin, tid: args.tid })
          if (action === 'qzone-comment') return await qzone.comment({ uin: args.uin, tid: args.tid, content: args.text })
          if (action === 'qzone-reply') return await qzone.reply({ uin: args.uin, tid: args.tid, commentId: args.commentId, commentUin: args.commentUin, content: args.text })
        }
        if (action === 'status') {
          const sessionId = sessionIdFromExec(exec)
          if (!sessionId || !world.isOwnerSession(sessionId)) return { ok: false, error: '状态详情仅允许在主人的隔离会话中查看。' }
          const status = await loader.status()
          const worldStatus = world.status()
          const stickerSummary = stickers.summary()
          const qzoneStatus = qzone.status()
          return {
            ok: true,
            content:
              `鱼的世界 v${status.version}｜扩展 ${status.extensions.length} 个｜工具 ${status.tools.length} 个\n`
              + `bridge：总开关 ${status.bridge.masterSwitch ? '开' : '关'} / 试运行 ${status.bridge.trial ? '开' : '关'}`
              + ` / NapCat ${status.bridge.napCat}\n`
              + `whale：角色「${status.whale.current?.name || '?'}」，余额 ${status.whale.usage?.balance ?? '?'} ${status.whale.usage?.currency || ''}\n`
              + `世界：${worldStatus.ok ? '就绪' : worldStatus.error || '未绑定工作区'}｜收藏表情 ${stickerSummary.total} 张，本小时剩余 ${stickerSummary.remainingThisHour}/${stickerSummary.limit}`
              + `\nQQ 空间：${qzoneStatus.enabled ? '启用' : '停用'}`
              + (env && !env.ok ? `\n环境：${env.summary}（${env.hints.map((item) => item.command || item.label).join('；')}）` : ''),
            status: { ...status, world: worldStatus, stickers: stickerSummary, qzone: qzoneStatus, ...(env && !env.ok ? { environment: environmentView(env) } : {}) },
          }
        }
        if (action === 'list') {
          const extensions = loader.list()
          return {
            ok: true,
            content: extensions.length
              ? extensions.map((ext) => `${ext.status === 'loaded' ? '✅' : ext.status === 'disabled' ? '⏸' : '⚠'} ${ext.id}@${ext.version}（${ext.kind}，${ext.status}）${ext.error ? '：' + ext.error : ''}`).join('\n')
              : '还没有发现 QQ Agent 扩展。把扩展目录放到 ~/.dsh/plugin-ecosystem/skills 或 plugins 下。',
            extensions,
          }
        }
        if (action === 'enable' || action === 'disable') {
          const id = String(args.id || '').trim()
          if (!id) return { ok: false, error: '缺少 id' }
          await loader.setEnabled(id, action === 'enable')
          return {
            ok: true,
            content: `已${action === 'enable' ? '启用' : '停用'} ${id}`,
            extensions: loader.list(),
          }
        }
        if (action === 'reload') {
          await loader.reload()
          return { ok: true, content: '已重新扫描并加载扩展', extensions: loader.list() }
        }
        if (action === 'history' || action === 'forward') {
          const gateResult = platforms ? platforms.gate('qq', 'read') : { ok: true }
          if (!gateResult.ok) return { ok: false, error: gateResult.reason }
        }
        if (action === 'send') {
          // 平台闸门：未安装、平台关闭或发送开关关闭时直接拒绝。
          const gateResult = platforms ? platforms.gate('qq', 'send') : { ok: true }
          if (!gateResult.ok) {
            return { ok: false, error: gateResult.reason }
          }
          const text = String(args.text || '').trim()
          const image = String(args.image || '').trim()
          if (!text && !image) return { ok: false, error: 'send 需要 text 或 image' }
          let receipt = null
          if (text) {
            receipt = await qq.send(args.chat || '', [{ type: 'text', text }])
            if (!receipt.ok) {
              return {
                ok: false,
                reason: receipt.reason,
                content: `没有发出去：${receipt.reason || '未知原因'}${receipt.failed?.length ? '｜' + receipt.failed.map((x) => x.reason).join(',') : ''}`,
                receipt,
              }
            }
          }
          if (image) {
            // 模型给的本地路径必须落在鱼箱内；URL 由 qq 层按 http(s) 处理。
            const imageReceipt = await qq.sendImage(args.chat || '', { url: /^https?:\/\//i.test(image) ? image : '', localPath: /^https?:\/\//i.test(image) ? '' : image })
            if (!imageReceipt.ok) return { ok: false, reason: imageReceipt.reason, content: '图片没有发出去', receipt: imageReceipt }
            receipt = receipt ? { ...receipt, sent: [...receipt.sent, ...imageReceipt.sent] } : imageReceipt
          }
          return {
            ok: true,
            content: receipt?.dryRun
              ? `试运行：没有真的发到 QQ（${receipt.reason}）`
              : `已发到 QQ（${receipt.sent.map((x) => x.kind + ':' + x.id).join('、')}）`,
            receipt,
          }
        }
        if (action === 'persona') {
          const persona = whale.persona()
          return { ok: true, content: persona.text, persona }
        }
        if (action === 'stickers') {
          const query = String(args.query || '').toLowerCase()
          const list = whale.stickers().filter((item) => !query || item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query))
          return {
            ok: true,
            content: list.length ? list.map((item) => `${item.id}（${item.name}）`).join('\n') : '没有匹配的表情图',
            stickers: list,
          }
        }
        if (action === 'history') {
          const result = await qq.recent(args.chat || '', args.limit || 20)
          if (!result.ok) return { ok: false, reason: result.reason, error: '读取 QQ 历史失败：' + (result.reason || '未知原因') }
          const lines = []
          const pendingForwards = []
          for (const msg of result.messages) {
            const marks = describeSegments(msg.parts)
            const body = oneLine(msg.text, 120) || (marks ? '' : '（非文字内容）')
            lines.push(`[${new Date(msg.at).toLocaleTimeString()}] ${msg.nickname || msg.userId}：${body}${marks ? ' ' + marks : ''}`)
            for (const id of msg.forwards || []) pendingForwards.push({ id, at: msg.at })
          }
          // 聊天记录单独展开：主人说「看这个」时，模型能直接读到里面说了什么。
          let budget = FORWARD_EXPAND_TOTAL
          let expanded = 0
          for (const item of pendingForwards.slice(0, FORWARD_EXPAND_RECORDS)) {
            if (budget <= 0) break
            const record = await qq.forward(item.id)
            if (!record.ok) {
              lines.push(`  ↳ 聊天记录 ${item.id} 读取失败：${record.reason || '未知原因'}`)
              continue
            }
            const shown = record.entries.slice(0, Math.min(FORWARD_EXPAND_ENTRIES, budget))
            const more = record.entries.length > shown.length ? `，先展开 ${shown.length} 条` : ''
            lines.push(`  ↳ 聊天记录 ${item.id}（${record.entries.length} 条${more}）：`)
            for (const entry of shown) lines.push('     ' + forwardLine(entry))
            budget -= shown.length
            expanded += 1
          }
          if (pendingForwards.length > expanded) {
            lines.push(`（还有 ${pendingForwards.length - expanded} 条聊天记录没展开，可用 action=forward + forwardId 单独读）`)
          }
          return {
            ok: true,
            content: lines.join('\n') || '没有消息',
            messages: result.messages,
            forwards: pendingForwards.map((item) => item.id),
          }
        }
        if (action === 'forward') {
          const key = String(args.forwardId || args.id || '').trim()
          if (!key) return { ok: false, error: 'forward 需要 forwardId（history 里的 [聊天记录:id]）' }
          const record = await qq.forward(key)
          if (!record.ok) return { ok: false, reason: record.reason, error: '读取聊天记录失败：' + (record.reason || '未知原因') }
          return {
            ok: true,
            content: record.entries.length
              ? `聊天记录 ${key}（${record.entries.length} 条）：\n` + record.entries.map((entry, index) => `${index + 1}. ${forwardLine(entry)}`).join('\n')
              : '这条聊天记录是空的。',
            entries: record.entries,
          }
        }
        if (action === 'qq-status') {
          const login = await qq.loginInfo()
          return {
            ok: true,
            content: login.ok
              ? `OneBot 已连接：${login.nickname}（${login.userId}）`
              : `OneBot 连不上：${login.error}`,
            login,
            bridge: qq.snapshot(),
          }
        }
        if (action === 'sticker-list') {
          const items = stickers.search(args.query || '')
          const summary = stickers.summary()
          return {
            ok: true,
            content: items.length
              ? items.map((item) => `${item.id}｜${item.name}｜标签：${item.tags.join('、') || '无'}`).join('\n')
                + `\n—— 共 ${summary.total} 张，本小时还可收藏 ${summary.remainingThisHour} 张（上限 ${summary.limit}/小时）`
              : `还没有收藏的表情。本小时还可收藏 ${summary.remainingThisHour} 张。`,
            items: items.map((item) => stickers.toView(item)),
            summary,
          }
        }
        if (action === 'link-list') {
          const list = links.list({ query: args.query || '', kind: args.kind || '' })
          const summary = links.summary()
          return {
            ok: true,
            content: list.length
              ? list.map((item) => `- [${item.id}] ${item.title}（${item.kind}）${item.url}${item.tags.length ? ' #' + item.tags.join(' #') : ''}`).join('\n')
                + `\n\n本小时还能收 ${summary.remainingThisHour} 条。`
              : '还没收藏链接。默认可以去 StyleKit 风格库自己挑：https://www.stylekit.top/zh/styles',
            links: list,
            summary,
          }
        }
        if (action === 'link-collect') {
          // 类型与标签由鱼自己判断；程序只校验地址与额度。
          const saved = links.add({
            url: args.url,
            title: args.title || args.name || '',
            note: args.note || '',
            tags: args.tags,
            kind: args.kind,
            source: args.source || '',
          })
          return {
            ok: true,
            content: `已收藏「${saved.item.title}」（${saved.item.kind}）`,
            item: saved.item,
            summary: links.summary(),
          }
        }
        if (action === 'link-remove') {
          const result = links.remove(args.id || '')
          return {
            ok: result.ok,
            content: result.ok ? '已删除这条链接收藏' : (result.error || '没有找到'),
            summary: links.summary(),
          }
        }
        if (action === 'sticker-collect') {
          const url = String(args.url || '').trim()
          const localPath = String(args.localPath || '').trim()
          if (!url && !localPath) return { ok: false, error: 'sticker-collect 需要 url 或 localPath' }
          const item = await stickers.add({ url, localPath }, { tags: args.tags, name: args.name, note: args.note })
          return {
            ok: true,
            content: `已收藏「${item.name}」（${item.id}），标签：${item.tags.join('、') || '无'}`,
            item: stickers.toView(item),
            summary: stickers.summary(),
          }
        }
        if (action === 'sticker-send') {
          const receipt = await stickers.send(qq, args.chat || '', args.id || args.name || args.query || '')
          if (!receipt.ok) return { ok: false, reason: receipt.reason, content: `表情没发出去：${receipt.reason || '未找到或发送失败'}`, receipt }
          return { ok: true, content: receipt.dryRun ? `试运行：没有真的发（${receipt.reason}）` : '已发送表情到 QQ', receipt }
        }
        if (action === 'sticker-tags') {
          const key = String(args.id || args.name || '').trim()
          if (!key) return { ok: false, error: 'sticker-tags 需要 id 或 name' }
          const item = stickers.get(key)
          if (!item) return { ok: false, error: `没有找到表情：${key}` }
          const updated = stickers.updateTags(item.id, args.tags)
          return { ok: true, content: `已更新「${updated.name}」标签：${updated.tags.join('、') || '无'}`, item: stickers.toView(updated) }
        }
        if (action === 'sticker-remove') {
          const key = String(args.id || args.name || '').trim()
          if (!key) return { ok: false, error: 'sticker-remove 需要 id 或 name' }
          const item = stickers.get(key)
          const removed = item ? stickers.remove(item.id) : false
          return { ok: true, content: removed ? '已删除表情' : '没有找到表情', removed, summary: stickers.summary() }
        }
        if (action === 'world') {
          const s = world.status()
          const phys = s.physical
          return {
            ok: s.ok,
            content: s.ok
              ? `鱼的世界已就绪：工作区 ${s.workspacePath}｜主人会话 ${s.ownerSession}｜关系 ${s.relations} 人`
                + (phys ? `\n生理：精力 ${phys.values?.energy ?? '—'} / 困倦 ${phys.values?.sleepiness ?? '—'} / 饱腹 ${phys.values?.hunger ?? '—'}` : '')
              : `鱼的世界尚未就绪：${s.error || '未绑定工作区'}`,
            status: s,
          }
        }
        if (action === 'relations') {
          const data = world.listRelations()
          return {
            ok: true,
            content: data.people.length
              ? data.people.map((p) => `${p.role === 'trusted' ? '信任' : p.role === 'blocked' ? '屏蔽' : '普通'} ${p.name}（${p.qqId}，${p.enabled ? '启用' : '停用'}）`).join('\n')
              : '还没有登记任何关系。',
            relations: data,
          }
        }
        if (action === 'diary') {
          if (args.text) {
            // 日记是鱼自己写的；署名默认用鱼当前的外显角色，主人/信任者只在面板里看与审批。
            let author = args.actorName || ''
            if (!author) {
              try { author = whale.persona().role.name || '鱼' } catch { author = '鱼' }
            }
            const record = world.appendDiary({ text: args.text, actorName: author, role: args.role || 'owner' })
            return { ok: true, content: record.suggestion ? '已写入待确认日记（需主人批准）' : '已写入日记', record }
          }
          const diary = {
            suggestions: world.listDiary({ suggestions: true, limit: 20 }),
            entries: world.listDiary({ date: args.date || '', limit: 40 }),
            comments: world.listDiaryComments({ date: args.date || '' }),
            pendingComments: world.pendingDiaryComments({ limit: 20 }),
          }
          return {
            ok: true,
            content: (diary.entries.length
              ? diary.entries.map((e) => `[${String(e.at).slice(0, 16)}] ${e.actorName}：${oneLine(e.text, 120)}`).join('\n')
              : '还没有日记。')
              + (diary.pendingComments.length
                ? '\n\n主人还没被你回应的批语：\n' + diary.pendingComments.map((c) => `- [comment:${c.id}]${c.quote ? `〔原句「${oneLine(c.quote, 60)}」〕` : ''}${oneLine(c.text, 120)}`).join('\n')
                : ''),
            diary,
          }
        }
        if (action === 'diary-comment-ack') {
          // 鱼读完主人的批语后标记「已回应」，避免下次再被重复提醒。
          const saved = world.markDiaryCommentResponded(String(args.commentId || ''), args.note || '')
          return { ok: true, content: '已标记批语为回应过', comment: saved.comment }
        }
        if (action === 'wish') {
          // 不带 text 时是查看；带 text 时鱼主动提出一条请求，等主人裁决。
          if (args.text) {
            const created = world.appendWish({ text: args.text, kind: args.kind || 'wish', urgency: args.urgency })
            return {
              ok: true,
              content: '已向主人提出请求，等主人同意或拒绝；在裁决前不要假设已经得到许可。',
              wish: created.wish,
            }
          }
          const summary = world.wishSummary()
          const pending = summary.wishes.filter((item) => item.status === 'pending')
          return {
            ok: true,
            content: summary.total
              ? (pending.length
                ? '还没被处理的请求：\n' + pending.map((item) => `- [wish:${item.id}] ${oneLine(item.text, 120)}`).join('\n')
                : '没有待处理的请求。')
              : '还没有提过请求。',
            wishes: summary.wishes,
            pending: pending.length,
          }
        }
        if (action === 'growth') {
          // 不带 text 时查看成长；带 text 时记一条可修正的理解。
          if (args.text) {
            const created = growth.record({
              text: args.text,
              kind: args.kind,
              quote: args.quote,
              source: args.source,
            })
            return {
              ok: true,
              content: `已记下这条成长（${created.entry.kind}）。它可以在「鱼的成长」里被修订或撤回。`,
              entry: created.entry,
            }
          }
          const info = growth.status()
          const page = growth.list({ limit: 10 })
          return {
            ok: true,
            content: `成长阶段：${info.stage.name}（${info.total} 条记录，${info.days} 天）`
              + (info.stage.next ? `；离「${info.stage.next.name}」还差 ${info.stage.toNext} 条。` : '；已经是最高阶段。')
              + (info.todayCount >= info.dailyLimit ? '今天已经记满，允许没有新认识。' : '')
              + (page.entries.length
                ? '\n最近的记录：\n' + page.entries.map((e) => `- [${e.day}] ${oneLine(e.text, 120)}`).join('\n')
                : '\n还没有成长记录。'),
            growth: { ...info, entries: page.entries },
          }
        }
        if (action === 'platforms') {
          // 三个平台的连接状态；模型只能查看，开关只能由主人在面板里改。
          const status = platforms.status()
          return {
            ok: true,
            content: status.platforms.map((item) => {
              const state = !item.installed ? '插件未安装' : (item.config.enabled ? '已启用' : '已关闭')
              return `- ${item.name}（${item.plugin}）${state}${item.version ? ' @' + item.version : ''}`
            }).join('\n') + '\n外发开关只能由主人在「鱼的设置 → 平台」里修改。',
            platforms: status.platforms,
          }
        }
        if (action === 'doctor') {
          // 依赖体检离线、更新体检联网；都不自动安装，只报告与给命令。
          const online = args.online === true || args.force === true
          const dependency = dependencyCheck({})
          if (!online) {
            return {
              ok: dependency.ok,
              content: dependency.ok
                ? dependency.summary
                : dependency.warnings.join('\n') + (dependency.hints.length ? '\n修复方式：' + dependency.hints.map((h) => h.command || h.label).join('；') : ''),
              dependency,
            }
          }
          const update = await updateCheck({ force: true })
          return {
            ok: update.ok,
            content: dependency.summary + '\n' + update.summary
              + (update.hints.length ? '\n可执行：' + update.hints.map((h) => h.command).join('；') : ''),
            dependency,
            update,
          }
        }
        return { ok: false, error: `未知 action：${action}` }
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        const fix = env && !env.ok && env.fixCommand ? `（修复：${env.fixCommand}）` : ''
        return { ok: false, error: message + fix }
      }
    },
  }
}
