// 暴露给 DSH 模型的能力入口：fish_world / qq_ecosystem；纯基础设施不得进工具列表。
// 模型可以查状态、开关扩展、看 QQ 历史、用当前角色发一条 QQ。
import { oneLine, stripLeakedPlanner } from './util.mjs'
import { environmentView } from './env.mjs'
import { describeSegments } from './qq.mjs'
import { dependencyCheck, updateCheck } from './doctor.mjs'
import { VIDEO_OPS } from './media-tools.mjs'

const ACTIONS = ['status', 'list', 'enable', 'disable', 'reload', 'send', 'persona', 'stickers', 'history', 'forward', 'qq-status', 'sticker-list', 'sticker-collect', 'sticker-send', 'sticker-sync', 'sticker-tags', 'sticker-remove', 'link-list', 'link-collect', 'link-remove', 'world', 'relations', 'diary', 'diary-comment-ack', 'wish', 'growth', 'platforms', 'activity', 'record', 'know', 'doctor', 'env-check', 'qzone-status', 'qzone-feeds', 'qzone-comments', 'qzone-post', 'qzone-diary', 'qzone-like', 'qzone-comment', 'qzone-reply', 'astrbot-tools', 'astrbot-tool', 'qqagent-tools', 'qqagent-tool', 'video']

// 这些动作真的要和 QQ 桥通信；前置插件没装时直接给出安装命令，而不是等超时。
const BRIDGE_ACTIONS = new Set(['send', 'history', 'forward', 'qq-status', 'sticker-send', 'sticker-sync', 'qzone-status', 'qzone-feeds', 'qzone-comments', 'qzone-post', 'qzone-diary', 'qzone-like', 'qzone-comment', 'qzone-reply'])

// history 里最多展开几条聊天记录、总共多少行，避免一条长记录把上下文撑爆。
const FORWARD_EXPAND_RECORDS = 2
const FORWARD_EXPAND_ENTRIES = 20
const FORWARD_EXPAND_TOTAL = 40

function forwardLine(entry) {
  const text = oneLine(entry.text, 100) || describeSegments(entry.parts) || '（非文字内容）'
  return `${entry.nickname || entry.userId || '某人'}：${text}`
}

/** 一条消息 / 一条记录里能取到的图片地址（工具侧只认 http(s)）。 */
function imageUrlsOf(item) {
  const list = Array.isArray(item?.images) ? item.images : []
  return list
    .map((image) => String(image?.url || ''))
    .filter((url) => /^https?:\/\//i.test(url))
}

/**
 * 把一批图片地址换成工具结果里的图片块。
 * 没有宿主附件服务（或全下载失败）时返回空数组，调用方保持写标记的老行为。
 */
async function imageBlocksFor(urls, imageRefs) {
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean).slice(0, 4)
  if (!list.length || typeof imageRefs !== 'function') return []
  try {
    const refs = await imageRefs(list.map((url) => ({ url })))
    return (Array.isArray(refs) ? refs : []).filter((ref) => ref && ref.attachmentId)
  } catch {
    return []
  }
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

/**
 * 当前会话绑定的 QQ 聊天目标（私聊主人 / 某个群）。
 *
 * ⚠️ `world` 必须由调用方传进来：这两个函数在 `buildEcosystemTool` 外面（模块作用域），
 * 而 `world` 是那个工厂的参数。原来这里直接写 `world?.`，ReferenceError 被 try 吃掉，
 * 结果「会话 → 聊天」的映射永远是空 —— 不带 chat 的 send 一律报「没有聊天目标」。
 * 2026-10-28 实测探针证实，改成显式传参。
 */
function chatForSession(world, sessionId) {
  const id = String(sessionId || '')
  if (!id) return ''
  try {
    const target = world?.chatTargetForSession?.(id)
    if (target?.chatKey) return String(target.chatKey)
  } catch {}
  try {
    const rel = world?.listRelations?.()
    const owner = rel?.owner
    if (owner && String(owner.sessionId || '') === id && owner.qqId) return 'private:' + String(owner.qqId)
  } catch {}
  return ''
}

/**
 * 决定这条消息发到哪：
 *  - 显式传了 chat 就用它；
 *  - 没传就用「当前会话绑定的那个聊天」；
 *  - 都没有就不发，绝不再退到「默认目标」——那会把同一句话同时发到私聊和群。
 */
function targetChat(world, args, exec) {
  const explicit = String(args?.chat || '').trim()
  if (explicit) return { chat: explicit, error: '' }
  const mapped = chatForSession(world, sessionIdFromExec(exec))
  if (mapped) return { chat: mapped, error: '' }
  return {
    chat: '',
    error: '没有聊天目标：这条会话没绑定 QQ。请显式给 chat=private:QQ号 或 group:群号，别两边都发。',
  }
}


export function buildEcosystemTool({ loader, qq, roles, world, stickers, links, qzone, environment, growth, platforms, astrbot, activity, records, knowledge, qqagent, media, imageRefs, toolName = 'fish_world' }) {
  /**
   * 借手要上时间线：借了谁的手、借的是哪个工具，主人在「鱼今天动过的手」里要看得见。
   * 记审计失败不影响这次借用本身（工具已经跑完了，不能因为记一笔就整个报错）。
   */
  function 记一笔借手(kind, toolName2) {
    try {
      world?.appendSecurity?.({ role: 'fish', action: kind, recordId: String(toolName2 || '') })
    } catch {}
  }

  /**
   * 内部能力没接上时给一句准话。
   *
   * 表情库 / 链接库 / 成长 / 记录这些都是鱼世界自己的服务，缺了说明插件初始化没走完，
   * 不是「前置插件没装」。原来这些分支直接 `stickers.search(...)`，缺服务就抛
   * `Cannot read properties of undefined`，被外层 catch 成一句含糊的内部错误。
   */
  function 缺能力(value, name) {
    return value ? null : { ok: false, error: `${name}没接上：鱼世界内部这个服务没初始化完成（重启 DSH 试试；还不行看体检页）。` }
  }
  return {
    name: toolName,
    description:
      '鱼的世界统一入口。可查看 QQ 桥、鲸鱼状态和 QQ Agent 扩展；管理扩展；读取 QQ 历史；' +
      '以鲸鱼当前角色发一条 QQ 消息；管理鱼收藏的表情；在主人的隔离会话中浏览和打理鱼自己的 QQ 空间；' +
      '检查前置插件是否装齐（action=env-check）。' +
      'history 会把图片、动图、表情包、语音、视频、卡片和合并转发的聊天记录都标出来，' +
      '里面的图片会一并作为图片给你（最多 4 张）；' +
      '遇到 [聊天记录:id] 再用 action=forward 展开里面的内容（同样带图）。' +
      '发送默认受 dsh-qq-bridge 的总开关、试运行、转私聊/转群限制，不会绕过。' +
      '若主人开了 AstrBot 接入，可用 astrbot-tools 列出 AstrBot 里可借用的插件工具，' +
      '再用 astrbot-tool 执行其中一个 —— 那只是借它的「手」，怎么理解、怎么用自己的话' +
      '说出来，仍然由你自己决定。' +
      'action=know 查知识库（梗、角色、外观、约定）：不认识的先查，查不到就直说没这条，别编。' +
      'action=video 处理音视频（探测 / 剪辑 / 转 GIF / 抽帧 / 转码 / 烧字幕，借已装的 dsh-ffmpeg）：' +
      'input 用鱼箱内的相对路径；没给 output 就写到「鱼的产出」，不会覆盖源文件。',
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
        rebuild: {
          type: 'boolean',
          description: 'know 时：重建向量索引（知识库改过、或换了 embedding 模型之后用）。',
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
          description: 'history 时最多取多少条（1-100，默认 20）；sticker-sync 时这次最多同步几张（不填 = 全部还没同步的）。',
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
        kind: { type: 'string', description: '自由文本，别当枚举用。wish 可以是任何想要的事（persona=想改自己的设定 / 想要某样东西 / 想换个相处方式 / 想让我少管一点…；不填就是普通请求）；growth 的类别是 insight / next / milestone；link-collect 的类型是 design / reference / tool / article / inspiration / other。' },
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
        platform: { type: 'string', description: 'activity 的平台：qq / bili / douyin。' },
        ref: { type: 'string', description: 'activity 可附的引用标识，例如视频 BV 号或动态 id。' },
        tool: { type: 'string', description: 'astrbot-tool 要执行的工具名（先调 astrbot-tools 查可用名字）。' },
        params: {
          type: 'object',
          additionalProperties: true,
          properties: {},
          description: 'astrbot-tool 的调用参数，按 astrbot-tools 返回的 schema 填。',
        },
        op: {
          type: 'string',
          enum: [...VIDEO_OPS],
          description: 'video 时要做的事：probe 探测 / cut 剪辑 / gif 转 GIF / encode 转码 / subtitle 烧字幕 / frames 抽帧 / concat 拼接 / adjust 变速音量旋转 / health 自检。',
        },
        input: {
          type: 'string',
          description: 'video 的输入文件，必须是鱼箱内的相对路径（例如 素材/片段.mp4）。concat 用 inputs 代替。',
        },
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'video+concat 的输入文件列表：2-20 个鱼箱内相对路径。',
        },
        output: {
          type: 'string',
          description: 'video 的输出路径（鱼箱内相对路径）；留空 = 写到「鱼的产出」。frames 用它表示输出目录。',
        },
        outputDir: { type: 'string', description: 'video+frames 的输出目录（与 output 二选一）。' },
        start: { type: 'string', description: 'video 起始时间：秒数或 HH:MM:SS.mmm。' },
        end: { type: 'string', description: 'video 结束时间（与 duration 至少给一个）。' },
        duration: { type: 'string', description: 'video 时长：秒数或 HH:MM:SS.mmm。' },
        reencode: { type: 'boolean', description: 'video 是否精确重编码（cut / concat，默认 false = 流拷贝）。' },
        preset: { type: 'string', description: 'video+encode 预设：bilibili-1080p / bilibili-4k / vertical-1080p / web-720p。' },
        crf: { type: 'integer', description: 'video+encode 质量系数 0-51（越小越清晰）。' },
        fps: { type: 'number', description: 'video 输出帧率（encode / gif / frames）。' },
        scale: { type: 'string', description: 'video+encode 分辨率，如 1920:1080 或 -2:720。' },
        subtitle: { type: 'string', description: 'video+subtitle 的字幕文件（鱼箱内相对路径，SRT/ASS）。' },
        every: { type: 'number', description: 'video+frames 抽帧间隔秒数（与 times 二选一）。' },
        times: {
          type: 'array',
          items: { type: 'string' },
          description: 'video+frames 指定时间点列表（最多 20 个）。',
        },
        maxFrames: { type: 'integer', description: 'video+frames 的帧数上限 1-500（默认 100）。' },
        format: { type: 'string', description: 'video+frames 图片格式：png（默认）或 jpg。' },
        width: { type: 'integer', description: 'video+gif 输出宽度 64-1280（默认 480）。' },
        speed: { type: 'number', description: 'video+adjust 倍速 0.1-100（2 = 两倍速）。' },
        volume: { type: 'string', description: 'video+adjust 音量：1.5 这样的倍数，或 -3dB。' },
        mute: { type: 'boolean', description: 'video+adjust 是否移除音轨。' },
        rotate: { type: 'integer', description: 'video+adjust 顺时针旋转 90 / 180 / 270。' },
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
          op: { type: 'string' },
          output: { type: 'string' },
          durationMs: { type: 'number' },
          extensions: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          receipt: { type: 'object', additionalProperties: true, properties: {} },
          persona: { type: 'object', additionalProperties: true, properties: {} },
          stickers: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          messages: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          status: { type: 'object', additionalProperties: true, properties: {} },
          bridge: { type: 'object', additionalProperties: true, properties: {} },
          login: { type: 'object', additionalProperties: true, properties: {} },
          images: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const text = value && typeof value === 'object'
          ? (typeof value.content === 'string' && value.content ? value.content : JSON.stringify(value, null, 2))
          : String(value ?? '')
        const blocks = [{ type: 'text', text }]
        // 聊天记录 / 历史里的图：存成附件之后直接作为图片交给模型，别只留一个 [图片] 标记。
        for (const ref of Array.isArray(value?.images) ? value.images : []) {
          if (ref && typeof ref.attachmentId === 'string') blocks.push({ type: 'image', attachment: ref })
        }
        return blocks
      },
    },
    async execute(args = {}, exec = {}) {
      const action = String(args.action || '')
      const env = environmentStatus(environment)
      try {
        if (action === 'env-check') {
          const fresh = environment?.check?.() || env
          if (!fresh) return { ok: false, error: '环境检查不可用：宿主没有提供环境检查器。' }
          // 失败时的说法要和 doctor、面板同一套：先说「这不是鱼本身坏了」，再列症状与修法。
          // 原来直接把 warnings 拼出来，模型读到的是一串技术句子，容易当成「鱼坏了」。
          const wiringIssue = Array.isArray(fresh.wiring?.issues) && fresh.wiring.issues.length
            ? fresh.wiring.issues.map((item) => item.message).join('\n')
            : ''
          const content = fresh.ok
            ? `运行环境正常：Node ${fresh.node?.version || process.version}，${fresh.packages.length} 个前置插件已安装，插件接线正常。`
            : '环境检查没通过（这不是鱼本身坏了）：\n'
              + (wiringIssue ? wiringIssue + '\n' : '')
              + fresh.warnings.join('\n')
              + (fresh.hints.length ? '\n修复方式：' + fresh.hints.map((item) => item.command || item.label).join('；') : '')
          return { ok: fresh.ok, healthy: fresh.ok === true, content, environment: environmentView(fresh) }
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
            // 赞与评论数要写进正文：模型读的是 content，不带就等于「看不到别人在她空间的互动」。
            return { ok: true, content: result.items.length
              ? result.items.map((item) => `[${item.nickname}(${item.uin}) ${item.time || ''}] ${item.content}（tid:${item.tid} · 赞 ${item.likes || 0} · 评 ${item.comments || 0}）`).join('\n')
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
              + ` / 协议端 ${status.bridge.napCat}\n`
              + `角色：「${status.roles?.current?.name || '鱼'}」\n`
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
          const tg = targetChat(world, args, exec)
          if (tg.error) return { ok: false, error: tg.error }
          const text = String(args.text || '').trim()
          const image = String(args.image || '').trim()
          if (!text && !image) return { ok: false, error: 'send 需要 text 或 image' }
          let receipt = null
          if (text) {
            // 模型自调用这条路径以前没清洗：它把内部盘算（「回了X那句。」）写进 text 就直发。
            // 凡是要进 QQ 的文字，不管从哪条路来，都过同一道闸（主人 2026-10-29 要求彻底整治）。
            const cleaned = stripLeakedPlanner(text).trim()
            if (!cleaned) {
              return { ok: false, error: 'text 全是内部盘算，没有可发的话' }
            }
            receipt = await qq.send(tg.chat, [{ type: 'text', text: cleaned }])
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
            const imageReceipt = await qq.sendImage(tg.chat, { url: /^https?:\/\//i.test(image) ? image : '', localPath: /^https?:\/\//i.test(image) ? '' : image })
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
          // ⚠️ 这里原来写 `content: persona.text, persona` —— `persona` 根本没这个变量，
          // 每次调用都抛 ReferenceError（模型看到的是「persona is not defined」）。
          // 这条动作要的是「当前角色是什么」，用 roles.current() 就够了。
          const role = roles.current()
          return {
            ok: true,
            content: role
              ? `当前角色：${role.name || '（没名字）'}${role.id ? '（' + role.id + '）' : ''}`
              : '还没有选角色卡。',
            persona: role || null,
          }
        }
        // ⚠️ 原来这里是个死分支：`const list = [].filter(...)` 对空数组字面量过滤，
        // 永远回「没有匹配的表情图」。它和 `sticker-list` 是同一件事，后者才真调
        // stickers.search()。保留老名字（模型可能还按 stickers 调），但走同一条路。
        if (action === 'history') {
          const tg = targetChat(world, args, exec)
          if (tg.error) return { ok: false, error: tg.error }
          const result = await qq.recent(tg.chat, args.limit || 20)
          if (!result.ok) return { ok: false, reason: result.reason, error: '读取 QQ 历史失败：' + (result.reason || '未知原因') }
          const lines = []
          const pendingForwards = []
          // 消息本身和聊天记录里的图都要能看见：只写 [图片] 标记的话模型看不到画面。
          const imageUrls = []
          // 引用回复：谁回了哪一句，要把那句原文摆出来（最多取 2 条，别把这轮拖慢）。
          let quoteBudget = 2
          for (const msg of result.messages) {
            const marks = describeSegments(msg.parts)
            const body = oneLine(msg.text, 120) || (marks ? '' : '（非文字内容）')
            lines.push(`[${new Date(msg.at).toLocaleTimeString()}] ${msg.nickname || msg.userId}：${body}${marks ? ' ' + marks : ''}`)
            const replyId = (Array.isArray(msg.parts) ? msg.parts : [])
              .find((part) => part && part.kind === 'reply' && part.id)?.id
            if (replyId && quoteBudget > 0 && typeof qq.quote === 'function') {
              quoteBudget -= 1
              const quoted = await qq.quote(replyId).catch(() => ({ ok: false }))
              if (quoted && quoted.ok) {
                const who = quoted.nickname || quoted.userId || '某人'
                const what = oneLine(quoted.text, 100) || describeSegments(quoted.parts) || '（图片/非文字）'
                lines.push(`      ↳ 回复的是 ${who}：${what}`)
                imageUrls.push(...imageUrlsOf(quoted))
              } else {
                lines.push('      ↳ 引用原文没取到')
              }
            }
            imageUrls.push(...imageUrlsOf(msg))
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
            for (const entry of shown) {
              lines.push('     ' + forwardLine(entry))
              imageUrls.push(...imageUrlsOf(entry))
            }
            budget -= shown.length
            expanded += 1
          }
          if (pendingForwards.length > expanded) {
            lines.push(`（还有 ${pendingForwards.length - expanded} 条聊天记录没展开，可用 action=forward + forwardId 单独读）`)
          }
          const images = await imageBlocksFor(imageUrls, imageRefs)
          if (images.length) lines.push(`（附了 ${images.length} 张图，见后面的图片）`)
          return {
            ok: true,
            content: lines.join('\n') || '没有消息',
            messages: result.messages,
            forwards: pendingForwards.map((item) => item.id),
            images,
          }
        }
        if (action === 'forward') {
          const key = String(args.forwardId || args.id || '').trim()
          if (!key) return { ok: false, error: 'forward 需要 forwardId（history 里的 [聊天记录:id]）' }
          const record = await qq.forward(key)
          if (!record.ok) return { ok: false, reason: record.reason, error: '读取聊天记录失败：' + (record.reason || '未知原因') }
          const urls = record.entries.flatMap((entry) => imageUrlsOf(entry))
          const images = await imageBlocksFor(urls, imageRefs)
          return {
            ok: true,
            content: (record.entries.length
              ? `聊天记录 ${key}（${record.entries.length} 条）：\n` + record.entries.map((entry, index) => `${index + 1}. ${forwardLine(entry)}`).join('\n')
              : '这条聊天记录是空的。') + (images.length ? `\n（附了 ${images.length} 张图，见后面的图片）` : ''),
            entries: record.entries,
            images,
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
        if (action === 'sticker-list' || action === 'stickers') {
          const 没表情库 = 缺能力(stickers, '表情库')
          if (没表情库) return 没表情库
          const items = stickers.search(args.query || '')
          const summary = stickers.summary()
          return {
            ok: true,
            content: items.length
              // 「已同步 QQ 收藏」写在每行上：模型和主人都要看得出哪张能按收藏表情发。
              ? items.map((item) => `${item.id}｜${item.name}｜标签：${item.tags.join('、') || '无'}${item.emojiId ? '｜已同步 QQ 收藏' : ''}`).join('\n')
                + `\n—— 共 ${summary.total} 张，已同步 ${summary.synced ?? 0}/${summary.total} 张到 QQ 收藏，本小时还可收藏 ${summary.remainingThisHour} 张（上限 ${summary.limit}/小时）`
              : `还没有收藏的表情。本小时还可收藏 ${summary.remainingThisHour} 张。`,
            items: items.map((item) => stickers.toView(item)),
            summary,
          }
        }
        if (action === 'link-list') {
          const 没链接库 = 缺能力(links, '链接库')
          if (没链接库) return 没链接库
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
          const tg = targetChat(world, args, exec)
          if (tg.error) return { ok: false, error: tg.error }
          const receipt = await stickers.send(qq, tg.chat, args.id || args.name || args.query || '')
          if (!receipt.ok) return { ok: false, reason: receipt.reason, content: `表情没发出去：${receipt.reason || '未找到或发送失败'}`, receipt }
          return { ok: true, content: receipt.dryRun ? `试运行：没有真的发（${receipt.reason}）` : '已发送表情到 QQ', receipt }
        }
        if (action === 'sticker-sync') {
          // 写的是主人 QQ 账号的收藏：只在被点/被调时跑，同步过程逐张串行，
          // 已同步的跳过（幂等）。失败逐条如实带回，不假成功（底线③）。
          const 没表情库 = 缺能力(stickers, '表情库')
          if (没表情库) return 没表情库
          const result = await stickers.syncFavorites(qq, { limit: args.limit })
          const head = result.added || result.failed
            ? `同步 QQ 收藏：成功 ${result.added} 张，失败 ${result.failed} 张`
            : ((result.errors || []).length ? '这次没有同步成功' : '没有需要同步的表情（都已经同步过了）')
          const detail = (result.errors || []).length
            ? '。失败原因：' + result.errors.slice(0, 3).map((item) => `${item.name || item.id}：${item.error}`).join('；')
              + ((result.errors || []).length > 3 ? `（还有 ${result.errors.length - 3} 条）` : '')
            : ''
          return {
            ok: result.ok,
            content: head + (result.ok ? '' : detail),
            sync: result,
            summary: stickers.summary(),
          }
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
          return {
            ok: s.ok,
            content: s.ok
              ? `鱼的世界已就绪：工作区 ${s.workspacePath}｜主人会话 ${s.ownerSession}｜关系 ${s.relations} 人`
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
              try { author = roles.current().name || '鱼' } catch { author = '鱼' }
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
          // 四个平台的连接状态（微信只读展示 dsh-wechat-plugin）；模型只能查看，开关只能由主人在面板里改。
          const status = platforms.status()
          return {
            ok: true,
            content: status.platforms.map((item) => {
              const state = !item.installed ? '插件未安装' : (item.config.enabled ? '已启用' : '已关闭')
              return `- ${item.name}（${item.plugin}）${state}${item.version ? ' @' + item.version : ''}`
            }).join('\n') + '\n外发开关只能由主人在「鱼的设定 → 平台」里修改。',
            platforms: status.platforms,
          }
        }
        if (action === 'activity') {
          // 平台上的浏览与互动：带 platform + kind + text 是写一条留存，
          // 不带就是看本地已经留下了什么。
          // 留档只是本地记账，不改变权限——能不能做仍由平台闸门决定，所以这里也不额外拦。
          const platformId = String(args.platform || '').trim()
          if (args.text || args.url) {
            if (!platformId) return { ok: false, error: 'activity 写入需要 platform（qq / bili / douyin）' }
            if (!activity) return { ok: false, error: '留档未接入' }
            const saved = activity.append({
              platform: platformId,
              kind: args.kind,
              text: args.text,
              url: args.url,
              ref: args.ref,
            })
            return {
              ok: true,
              content: `已留存到本地：${saved.platform} · ${saved.record.kind}。留档不授予任何权限，外发仍要看平台开关。`,
              activity: saved,
            }
          }
          const status = activity ? activity.status() : { ok: false, platforms: {} }
          const items = activity ? activity.list({ platform: platformId, limit: 20 }) : []
          return {
            ok: true,
            content: Object.values(status.platforms || {}).map((item) => (
              `- ${item.name}：${item.total} 条（${item.days} 天）${item.dir ? '，' + item.dir : ''}`
            )).join('\n') + (items.length
              ? '\n最近的留存：\n' + items.map((row) => `- [${row.day}] ${row.platform} ${row.kind}：${row.text || row.url}`).join('\n')
              : '\n还没有留存。'),
            platforms: status.platforms,
            items,
          }
        }
        if (action === 'record') {
          // 鱼的记录：主人让它记的东西。带 text 就是记一条，不带就是读。
          if (!records) return { ok: false, error: '记录未接入' }
          const text = String(args.text || '').trim()
          if (text) {
            const saved = records.addMemo({ text, source: 'fish' })
            return {
              ok: true,
              content: `记下了：「${saved.item.text}」。主人可以在「鱼之宝库 → 鱼的记录」里改或删。`,
              record: saved.item,
            }
          }
          const memos = records.listMemos({ limit: 50 })
          const grudges = records.listGrudges({ limit: 50 })
          return {
            ok: true,
            content: (memos.length
              ? '主人让你记下的：\n' + memos.map((row) => `- [${row.day}] ${row.text}`).join('\n')
              : '还没有记录。')
              + (grudges.filter((row) => row.status !== 'accepted').length
                ? '\n\n小本本里还挂着：\n' + grudges
                  .filter((row) => row.status !== 'accepted')
                  .map((row) => `- [${row.day}] ${row.text}${row.status === 'explained' ? '（主人已解释：' + row.explanation + '，你可以决定认不认）' : ''}`)
                  .join('\n')
                : ''),
            records: memos,
            grudges,
          }
        }
        if (action === 'know') {
          // 知识库：给模型一个查梗/角色/外观/约定的入口。
          // 关着向量就用字面档；开着就混合检索，向量那步坏了当轮退回字面档并说明原因。
          if (!knowledge) return { ok: false, error: '知识库未接入' }

          if (args.rebuild === true) {
            const made = await knowledge.rebuild()
            if (!made.ok) return { ok: false, error: made.error || '重建索引失败', knowledge: knowledge.status() }
            return {
              ok: true,
              content: '索引重建好了：' + made.items + ' 条，模型 ' + (made.model?.id || '未知') + '，维度 ' + (made.model?.dim || 0) + '。',
              knowledge: knowledge.status(),
            }
          }

          const query = String(args.query || args.text || '').trim()
          if (!query) {
            const state = knowledge.status()
            return {
              ok: state.ok,
              content: state.ok
                ? '知识库现在 ' + state.items + ' 条，' + (state.enabled ? '向量检索开着（' + state.mode + ' / ' + (state.model || '没填模型') + '）' : '向量检索关着，按字面查')
                  + (state.error ? '；' + state.error : '')
                : (state.error || '知识库状态拿不到'),
              knowledge: state,
            }
          }

          const found = await knowledge.search(query, { limit: args.limit })
          if (!found.ok) return { ok: false, error: found.error || '查知识库失败', knowledge: knowledge.status() }
          if (!found.hits.length) {
            return {
              ok: true,
              content: '知识库里没这条：「' + query + '」。查不到就去问、去搜，弄明白再补一条，别硬编。'
                + (found.notes.length ? '\n（' + found.notes.join('；') + '）' : ''),
              hits: [],
              backend: found.backend,
              notes: found.notes,
            }
          }
          const lines = found.hits.map((hit, index) => (index + 1) + '. ' + hit.text)
          return {
            ok: true,
            content: '查到 ' + found.hits.length + ' 条（' + (found.backend === 'hybrid' ? '语义+字面' : '字面') + '）：\n'
              + lines.join('\n')
              + (found.truncated ? '\n（还有没展开的，按预算截断了）' : '')
              + (found.notes.length ? '\n（' + found.notes.join('；') + '）' : ''),
            hits: found.hits.map((hit) => ({
              id: hit.id, type: hit.type, name: hit.name, score: hit.score,
              lexical: hit.lexical, vector: hit.vector, coverage: hit.coverage,
            })),
            backend: found.backend,
            truncated: found.truncated,
            notes: found.notes,
          }
        }
        if (action === 'video') {
          // 视频：复用已装的 dsh-ffmpeg（真正的参数与执行都在它里面），
          // 鱼世界只在外面加鱼箱校验、输入额度、超时与串行。
          if (!media) {
            return { ok: false, error: '视频工具没接上：鱼世界内部的媒体服务没初始化完成（重启 DSH 试试）。' }
          }
          return await media.run(args)
        }
        if (action === 'doctor') {
          // 依赖体检离线、更新体检联网；都不自动安装，只报告与给命令。
          //
          // ⚠️ 这里把两件事分开：**体检有没有跑完**（ok）与**体检结论好不好**（healthy）。
          // 原来用 ok 兼表「有毛病」，于是模型只看到 ok:false，会以为工具坏了、甚至去重试；
          // 实际是「查完了，发现 N 项要处理」。结论与执行状态混在一起，就是最典型的一种假读数。
          const online = args.online === true || args.force === true
          const dependency = dependencyCheck({})
          if (!online) {
            const healthy = dependency.ok === true
            return {
              ok: true,
              healthy,
              content: healthy
                ? dependency.summary
                : '体检没通过（这不是鱼本身坏了）：' + (dependency.warnings?.length
                  ? dependency.warnings.join('\n')
                  : (dependency.summary || '没拿到具体原因，可能宿主没提供环境检查器'))
                  + (dependency.hints?.length ? '\n修复方式：' + dependency.hints.map((h) => h.command || h.label).join('；') : ''),
              dependency,
            }
          }
          const update = await updateCheck({ force: true })
          return {
            ok: true,
            healthy: dependency.ok === true && update.ok === true,
            content: dependency.summary + '\n' + update.summary
              + (update.hints.length ? '\n可执行：' + update.hints.map((h) => h.command).join('；') : ''),
            dependency,
            update,
          }
        }
        if (action === 'astrbot-tools') {
          // 列出 AstrBot 里可借用的工具。只读，不改 AstrBot 任何配置。
          const view = astrbot?.view?.() || null
          if (!view || view.canBorrowTools !== true) {
            return {
              ok: false,
              error: '主人还没有打开「借用 AstrBot 的插件工具」。这是需要显式授权的操作。',
            }
          }
          const result = await astrbot.tools()
          if (!result.ok) return { ok: false, error: '读取 AstrBot 工具列表失败：' + (result.error || '未知错误') }
          const list = result.tools || []
          if (!list.length) return { ok: true, content: 'AstrBot 里当前没有可借用的工具。', tools: [] }
          return {
            ok: true,
            content: 'AstrBot 里可借用的工具：\n' + list.map((item) => (
              `- ${item.name}：${oneLine(item.description || '', 120) || '（无描述）'}`
            )).join('\n') + '\n要用某个工具，调 astrbot-tool（tool=工具名，params=参数）。',
            tools: list,
          }
        }
        if (action === 'astrbot-tool') {
          // 执行 AstrBot 的单个工具。返回的是原始结果，不是 AstrBot 生成的回复。
          const view = astrbot?.view?.() || null
          if (!view || view.canBorrowTools !== true) {
            return {
              ok: false,
              error: '主人还没有打开「借用 AstrBot 的插件工具」。这是需要显式授权的操作。',
            }
          }
          const toolName = String(args.tool || args.name || '').trim()
          if (!toolName) return { ok: false, error: '需要 tool 参数：要执行哪个 AstrBot 工具' }
          const result = await astrbot.runTool({ name: toolName, params: args.params || {} })
          // 借了谁的手要上时间线：主人在「鱼今天动过的手」里看得见是哪一次、借的哪个工具。
          记一笔借手('borrow-astrbot', toolName)
          if (!result.ok) return { ok: false, error: 'AstrBot 工具执行失败：' + (result.error || '未知错误') }
          return {
            ok: true,
            // 明确标注来源，避免鱼误以为这是自己的观察。
            content: `[通过 AstrBot 的 ${toolName} 得到]\n` + (result.output || '（工具没有返回内容）'),
            tool: toolName,
            output: result.output,
          }
        }
        if (action === 'qqagent-tools') {
          // 列出 QQ-agent 里可借用的插件工具。只读，不动它的任何配置。
          const view = qqagent?.view?.() || null
          if (!view || view.active !== true) {
            return { ok: false, error: 'QQ Agent 借手通道还没打开（面板「借手」里配地址和 token，并打开开关）。' }
          }
          const result = await qqagent.tools()
          if (!result.ok) return { ok: false, error: '读取 QQ Agent 工具列表失败：' + (result.error || '未知错误') }
          const list = result.tools || []
          if (!list.length) return { ok: true, content: 'QQ-agent 里当前没有可借用的工具。', tools: [] }
          return {
            ok: true,
            content: 'QQ-agent 里可借用的工具：\n' + list.map((item) => (
              '- ' + item.name + '：' + (oneLine(item.description || '', 120) || '（无描述）')
            )).join('\n') + '\n要用某个工具，调 qqagent-tool（tool=工具名，params=参数）。',
            tools: list,
          }
        }
        if (action === 'qqagent-tool') {
          // 执行 QQ-agent 的单个插件工具。拿回来的是原始结果，不是它的回复。
          const view = qqagent?.view?.() || null
          if (!view || view.active !== true) {
            return { ok: false, error: 'QQ Agent 借手通道还没打开（面板「借手」里配地址和 token，并打开开关）。' }
          }
          const toolName = String(args.tool || args.name || '').trim()
          if (!toolName) return { ok: false, error: '需要 tool 参数：要执行哪个 QQ Agent 工具' }
          const result = await qqagent.runTool({ name: toolName, params: args.params || {} })
          记一笔借手('borrow-qqagent', toolName)
          if (!result.ok) return { ok: false, error: 'QQ Agent 工具执行失败：' + (result.error || '未知错误') }
          return {
            ok: true,
            // 标注来源：这是借来的手，不是她自己的观察。
            content: `[通过 QQ Agent 的 ${toolName} 得到]\n` + (result.output || '（工具没有返回内容）'),
            tool: toolName,
            output: result.output,
          }
        }
        return { ok: false, error: `未知 action：${action}` }
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        const fix = env && !env.ok && env.fixCommand ? `（修复：${env.fixCommand}）` : ''
        // 缺服务时别把 JS 原始错误直接丢给模型：`Cannot read properties of undefined (reading 'search')`
        // 这种话它读不出「是前置插件没装」，只会以为鱼本身坏了。翻译成一句能行动的话，
        // 原始信息留在括号里，排查时还认得出是哪一行炸的。
        const 原始 = /Cannot read propert|is not a function|Cannot destructure|undefined is not/.test(message)
        if (原始) {
          return {
            ok: false,
            // 不硬猜原因：可能是前置插件没装（QQ/空间那种），也可能是插件自己的内部服务
            // 没初始化完（表情库/记录那种）。两种都说出来，让人知道下一步该查哪儿。
            error: `「${action}」这次没能执行（内部错误：${message}）。可能是对应能力没接上`
              + '（前置插件没装/没启用，或插件初始化没完成）；用 action=env-check 看缺哪个，别当成鱼本身坏了。' + fix,
          }
        }
        return { ok: false, error: message + fix }
      }
    },
  }
}
