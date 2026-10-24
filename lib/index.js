// dsh-fish-world —— 宿主半边。
//
// 作用：在 dsh-qq-bridge（DSH ↔ QQ）与可选的 dsh-whale-widget（角色/账本/泡泡）
// 之间，组装「鱼的世界」：
//   · 发现并加载 QQ Agent 0.5 / 0.4 风格的 skill/plugin；
//   · 把扩展工具注册成 DSH 工具，让模型能直接调用；
//   · 把扩展的 prompt 片段接进 DSH 系统提示词；
//   · 给扩展一个受控的 QQ 发送口（仍受 bridge 总开关/试运行约束）；
//   · 把 whale 挂件的当前角色、余额、表情图暴露成能力；
//   · 设置页「鱼的世界」与主界面右侧面板（市场、扩展设置、心情、朗读桥、收藏、QQ 空间）。
//
// 不复制 bridge 的收消息轮询：bridge 已经把 QQ 消息注入 DSH 会话，适配器只旁听
// session/event 里的 source.kind === 'qq'，再转成 message.in 事件给扩展。
import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createConfigStore } from './config.mjs'
import { createBus } from './bus.mjs'
import { createQQ } from './qq.mjs'
import { createWhale } from './whale.mjs'
import { createStickers } from './stickers.mjs'
import { createLoader } from './loader.mjs'
import { buildEcosystemTool } from './tool.mjs'
import { buildRoutes } from './http.mjs'
import { createMarket } from './market.mjs'
import { createWorldStore } from './world.mjs'
import { createQzoneService } from './qzone.mjs'
import { createEnvironment } from './env.mjs'
import { apply as applyAnimationCore } from './core-plugins/read-animation/index.js'
import { DSH_HOME } from './paths.mjs'
import { imagesOf, textOf } from './util.mjs'

export const name = 'fish-world'

// 只声明当前桌面 profile 一定存在的服务；其余能力用 ctx.get 可选探测。
export const inject = ['tools', 'webServer']

const PANEL_PATH = '/dsh-fish-world/panel.js'
const SETTINGS_PATH = '/dsh-fish-world/settings'
const MOOD_BADGE_PATH = '/dsh-fish-world/mood-badge.js'
const WHALE_WIDGET_PATH = '/dsh-whale/widget.js'
const MOOD_BADGE_MARKER = 'dsh-fish-world-mood-badge-inline-v1'
const FLOATING_PANEL_MARKER = 'dsh-fish-world-panel-inline-v1'

let panelCache = ''
let panelCacheMtime = 0
let moodBadgeCache = ''
let moodBadgeCacheMtime = 0
function fileSource(name, cachedValue, cachedMtime, fallback) {
  const file = new URL(name, import.meta.url)
  let mtime = 0
  try { mtime = statSync(file).mtimeMs } catch {}
  if (cachedValue && cachedMtime === mtime) return { value: cachedValue, mtime }
  try {
    return { value: readFileSync(file, 'utf8'), mtime }
  } catch {
    return { value: fallback, mtime }
  }
}

function panelSource() {
  const result = fileSource('./panel.js', panelCache, panelCacheMtime, 'console.error("dsh-fish-world: settings panel unavailable")')
  panelCache = result.value
  panelCacheMtime = result.mtime
  return panelCache
}
function moodBadgeSource() {
  const result = fileSource('./mood-badge.js', moodBadgeCache, moodBadgeCacheMtime, 'console.error("dsh-fish-world: mood badge unavailable")')
  moodBadgeCache = result.value
  moodBadgeCacheMtime = result.mtime
  return moodBadgeCache
}

function inlineScript(source) {
  // Prevent an embedded source comment/string from terminating the HTML script element.
  return String(source || '').replace(/<\/script/gi, '<\\/script')
}
function moodBadgeInjectText() {
  return `;/*${MOOD_BADGE_MARKER}*/\n${inlineScript(moodBadgeSource())}`
}
function floatingPanelInjectText() {
  return `;/*${FLOATING_PANEL_MARKER}*/\nwindow.__DSH_FISH_WORLD_FLOATING_MODE__=true;\n${inlineScript(panelSource())}`
}
// The floating panel is always appended last, so everything from its marker on
// belongs to this plugin and can be dropped when the whale takes over.
function stripFloatingPanel(text) {
  const marker = `/*${FLOATING_PANEL_MARKER}*/`
  const at = text.indexOf(marker)
  return at < 0 ? text : text.slice(0, at)
}

function settingsPage() {
  const source = inlineScript(panelSource())
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    // The settings host renders this route in an iframe; without an explicit
    // opaque surface the iframe canvas is white while the panel text is light.
    '<style>html,body{margin:0;min-height:100%;background:#17181c;color:#e8e8ea;' +
    'color-scheme:dark;font:13px/1.55 system-ui,"Microsoft YaHei",sans-serif}' +
    'body{padding:10px;box-sizing:border-box}</style>' +
    `</head><body><script>window.__DSH_FISH_WORLD_SETTINGS_MODE__=true;\n${source}</script></body></html>`
}

function registerSettingsAndMoodBadge(ctx, disposers, logger) {
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const routes = [
      { path: PANEL_PATH, type: 'application/javascript; charset=utf-8', body: panelSource },
      { path: SETTINGS_PATH, type: 'text/html; charset=utf-8', body: settingsPage },
      { path: MOOD_BADGE_PATH, type: 'application/javascript; charset=utf-8', body: moodBadgeSource },
    ]
    for (const asset of routes) {
      const register = () => ctx.webServer.register({
        kind: 'exact',
        path: asset.path,
        handler: (_req, res) => {
          try {
            res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
            res.end(asset.body())
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('fish world UI asset unavailable')
          }
        },
      })
      try {
        if (typeof ctx.effect === 'function') {
          const off = ctx.effect(register, `fish-world: ${asset.path}`)
          if (typeof off === 'function') disposers.push(off)
          else if (off && typeof off.dispose === 'function') disposers.push(() => off.dispose())
        } else {
          const off = register()
          if (typeof off === 'function') disposers.push(off)
          else if (off && typeof off.dispose === 'function') disposers.push(() => off.dispose())
        }
      } catch (error) {
        try { logger.warn?.(`fish-world: 注册 UI 资源 ${asset.path} 失败：${error?.message || error}`) } catch {}
      }
    }
  }

  // The right-side fish-world panel is the fallback. If the optional whale is
  // present, merge mood / speaking state into its existing row, hide the
  // standalone mood sprite and TTS card, and do not show a second floating
  // panel; the full manager remains available in Harness Settings.
  if (typeof ctx.on === 'function') {
    const off = ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        const whaleRow = table.find((row) => row?.kind === 'script' && typeof row.text === 'string' && row.text.includes(WHALE_WIDGET_PATH))
        if (whaleRow) {
          // Idempotency: drop any panel injection added by an earlier pass over
          // this request table, then keep only the whale row plus mood badge.
          for (let i = table.length - 1; i >= 0; i--) {
            const row = table[i]
            if (!row || row === whaleRow) continue
            if (row.kind === 'script-src' && row.src === PANEL_PATH) { table.splice(i, 1); continue }
            if (typeof row.text === 'string') row.text = stripFloatingPanel(row.text)
          }
          whaleRow.text = stripFloatingPanel(whaleRow.text)
          if (!whaleRow.text.includes(MOOD_BADGE_MARKER)) whaleRow.text += moodBadgeInjectText()
          return
        }
        const panelAlreadyInjected = table.some((row) => (
          String(row?.text || '').includes(FLOATING_PANEL_MARKER) || String(row?.src || '') === PANEL_PATH
        ))
        if (panelAlreadyInjected) return
        // Prefer an existing inline script row to avoid adding another loader row.
        const targetRow = table.find((row) => row?.kind === 'script' && typeof row.text === 'string')
        if (targetRow) targetRow.text += floatingPanelInjectText()
        else table.push({ kind: 'script', placement: 'body', text: floatingPanelInjectText() })
      } catch (error) {
        try { logger.warn?.(`fish-world: 面板/鲸鱼兼容注入失败：${error?.message || error}`) } catch {}
      }
    })
    if (typeof off === 'function') disposers.push(off)
  }
}

export function createAdapter(ctx, options = {}) {
  // The host calls apply(ctx) with no options, so every service must receive a
  // resolved home instead of undefined: createStickers joins it directly and a
  // missing value used to abort the whole server half before routes/tools were
  // registered (client.js still loaded, which made the plugin look installed).
  const home = options.home || DSH_HOME
  const configStore = options.configStore || createConfigStore({ home })
  const cfg = configStore.getConfig()
  const logger = ctx.logger || console
  const disposers = []
  const assistantBySession = new Map()
  // 运行时环境自检：只在前置插件缺失 / 接线异常时提醒，装齐了完全静默。
  const environment = createEnvironment({
    home,
    profile: options.profile,
    configStore,
    logger,
  })

  function pushDisposable(value) {
    if (typeof value === 'function') disposers.push(value)
    else if (value && typeof value.dispose === 'function') disposers.push(() => value.dispose())
  }

  if (cfg.enabled === false) {
    logger.info?.('fish-world: 配置里 enabled=false，本次不加载')
    return { name, disabled: true, configStore, status: () => ({ ok: true, disabled: true }) }
  }

  try {
    const core = applyAnimationCore(ctx, {
      maxFrames: 8,
      maxEdge: 640,
      background: 'white',
      maxInputBytes: 64 * 1024 * 1024,
      expandPastedAnimations: true,
    })
    pushDisposable(core)
  } catch (error) {
    // Animation support is optional on legacy hosts without the attachment seams.
    if (typeof ctx.get === 'function') {
      try { logger.warn?.(`fish-world: 动图解码能力不可用：${error?.message || error}`) } catch {}
    }
  }

  const bus = createBus({
    onError: (error, event) => {
      try { logger.warn?.(`fish-world: 事件 ${event} 的监听器出错：${error?.message || error}`) } catch {}
    },
  })

  const qq = createQQ({ home, config: () => configStore.getConfig(), logger })
  const whale = createWhale({ home, config: () => configStore.getConfig(), logger })
  const stickers = createStickers({ home, config: () => configStore.getConfig(), logger })

  // 鱼的世界：工作区本地数据仓（记忆/日记/状态/关系）。QQ 桥配好主人会话后才初始化。
  const world = createWorldStore({ home, qq, logger })
  function worldServices() {
    const get = (key) => {
      try { return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key] } catch { return undefined }
    }
    return { registry: get('workspaceRegistry'), sessions: get('sessions'), agents: get('agents') }
  }

  function defaultChatKey() {
    const bridge = qq.snapshot()
    if (bridge.toGroup && bridge.group) return `group:${bridge.group}`
    if (bridge.privateQQ) return `private:${bridge.privateQQ}`
    return ''
  }

  const loader = createLoader({
    configStore,
    bus,
    qq,
    whale,
    stickers,
    logger,
    dshTools: {
      register(tool) {
        if (!ctx.tools || typeof ctx.tools.register !== 'function') {
          throw new Error('宿主没有 tools 服务，无法注册扩展工具')
        }
        return ctx.tools.register(tool)
      },
    },
    defaultChatKey,
  })
  const market = createMarket({ configStore, loader })
  const qzone = createQzoneService({ qq, world, config: () => configStore.getConfig() })

  // TTS stays opt-in; the local bridge's auto queue is disabled unless the user
  // explicitly sets tts.auto=true in fish-world configuration.
  let ttsStartupAttempts = 0
  let ttsStartupTimer = null
  const enforceTtsDefault = () => {
    if (configStore.getConfig().tts?.auto === true || ttsStartupAttempts >= 20) return
    ttsStartupAttempts += 1
    try {
      const origin = typeof ctx.webServer?.getOrigin === 'function' ? ctx.webServer.getOrigin() : ''
      const target = new URL('/dsh-tts-bridge/auto', origin)
      if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) return
      void fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auto: false }),
        signal: AbortSignal.timeout(1200),
      }).then((response) => {
        if (!response.ok) return
        if (ttsStartupTimer) clearInterval(ttsStartupTimer)
        ttsStartupTimer = null
      }).catch(() => {})
    } catch {}
  }
  const adapter = {
    name,
    configStore,
    environment,
    qq,
    whale,
    stickers,
    bus,
    loader,
    market,
    world,
    qzone,
    defaultChatKey,
    status: () => ({
      ...loader.status(),
      world: world.status(),
      stickers: stickers.summary(),
      qzone: qzone.status(),
      environment: environment.view(),
    }),
    reload: () => loader.reload(),
    async dispose() {
      for (const dispose of [...disposers].reverse()) {
        try { dispose() } catch {}
      }
      disposers.length = 0
      return loader.unloadAll()
    },
  }

  // 启动时检查一次依赖环境：缺前置插件或接线异常才写警告日志。
  try { environment.check() } catch (error) {
    try { logger.warn?.(`fish-world: 环境检查失败：${error?.message || error}`) } catch {}
  }

  // 绑定服务后初始化工作区数据（QQ 桥未配置时仅记录原因，不创建目录）。
  world.setServices(worldServices())
  // Initialize the 24-hour diary anchor at plugin startup; this is local-only.
  try { qzone.status() } catch {}

  // 日记到期后只向主人的隔离会话投递任务提示；由模型写作并调用带主人闸的 Qzone 工具。
  // 不直接生成或发布内容，也不会为非主人会话创建 followup。
  let diaryReminderInFlight = false
  async function tickQzoneDiaryReminder() {
    if (diaryReminderInFlight || configStore.getConfig().qzone?.enabled === false) return
    const qzoneStatus = qzone.status()
    if (!qzoneStatus.ok || !qzoneStatus.diaryDue || qzoneStatus.usage?.byKind?.post?.remaining <= 0) return
    const ownerSession = world.ownerSession()
    if (!ownerSession) return
    const agents = worldServices().agents
    if (!agents || typeof agents.get !== 'function') return
    const ids = [String(ownerSession)]
    if (ids[0].startsWith('session-')) ids.push(ids[0].slice('session-'.length))
    else ids.push(`session-${ids[0]}`)
    let agent
    for (const id of ids) {
      try { agent = agents.get(id); if (agent) break } catch {}
    }
    if (!agent || typeof agent.followup !== 'function') return
    if (!await qzone.claimDiaryReminder()) return

    diaryReminderInFlight = true
    try {
      const text = '[System 定时日记提醒] 鱼世界的空间日记已到 24 小时提醒时间。请先调用 fish_world（action=qzone-diary，不传 text）读取今日已批准日记素材，再在不编造事件、不泄露他人私聊或隐私的前提下写一篇简短第一人称日记，并调用 fish_world（action=qzone-diary，text=正文）发布。只在写入成功后简短告知主人；若额度、登录态或权限不允许，如实说明，不重试、不改发其他内容。'
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'system' },
      })
      const sessions = worldServices().sessions
      if (sessions && typeof sessions.flush === 'function') {
        try { await sessions.flush(agent.session) } catch {}
      }
    } catch (error) {
      try { logger.warn?.(`fish-world: QQ 空间日记提醒投递失败：${error?.message || error}`) } catch {}
    } finally {
      diaryReminderInFlight = false
    }
  }
  const diaryTick = () => { void tickQzoneDiaryReminder().catch((error) => {
    try { logger.warn?.(`fish-world: QQ 空间日记计时器失败：${error?.message || error}`) } catch {}
  }) }
  try {
    if (typeof ctx.interval === 'function') {
      pushDisposable(ctx.interval(diaryTick, 15 * 60 * 1000))
    } else {
      const timer = setInterval(diaryTick, 15 * 60 * 1000)
      timer.unref?.()
      pushDisposable(() => clearInterval(timer))
    }
  } catch (error) {
    try { logger.warn?.(`fish-world: 无法启动 QQ 空间日记计时器：${error?.message || error}`) } catch {}
  }
  if (configStore.getConfig().tts?.auto !== true) {
    enforceTtsDefault()
    ttsStartupTimer = setInterval(enforceTtsDefault, 1000)
    ttsStartupTimer.unref?.()
    pushDisposable(() => { if (ttsStartupTimer) clearInterval(ttsStartupTimer) })
  }
  // Management UI lives in Harness Settings; the whale only gets its mood badge.
  registerSettingsAndMoodBadge(ctx, disposers, logger)

  // 1) 工具：鱼的世界统一入口；保留旧工具别名以兼容现有会话。
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const toolName of ['fish_world', 'qq_ecosystem']) {
      try {
        const tool = buildEcosystemTool({ loader, qq, whale, world, stickers, qzone, environment, toolName })
        pushDisposable(ctx.tools.register(tool))
      } catch (error) {
        logger.error?.(`fish-world: 注册 ${toolName} 工具失败：${error?.message || error}`)
      }
    }
  }

  // 2) 系统提示词：扩展的 prompt 片段统一由 loader 汇总。
  if (cfg.prompt.enabled !== false && typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (inner) => {
      try {
        const service = inner.systemPrompt
        if (!service || typeof service.section !== 'function') return
        const off = service.section({
          name: 'fish-world',
          order: cfg.prompt.order,
          text: () => {
            const parts = []
            if (cfg.whale.enabled !== false && cfg.whale.injectPersona === true) {
              try {
                const persona = whale.persona()
                parts.push(`【QQ 外显角色】${persona.role.name}` + (persona.quips.length ? `；可用口癖：${persona.quips.slice(0, 6).map((x) => `「${x}」`).join('、')}` : ''))
              } catch {}
            }
            const extensionText = loader.promptText()
            if (extensionText) parts.push(extensionText)
            // QQ 收消息只带文字和图片；合并转发、语音、卡片不会自动进上下文。
            // 先说清楚哪些内容它看不到，再给一条回查路径，避免它对着空气编。
            try {
              if (!qq.snapshot().bridgeMissing) {
                parts.push(
      '【QQ 收消息】你直接看到的 QQ 消息只有文字和图片。GIF/动态 WebP 会在附件准入时由鱼世界内置动图处理器本地采样为带时间戳的多帧胶片条，然后再交给视觉模型；看到帧标注时按时间顺序理解，不要把抽样间隔外的动作当成已观察事实。' +
                  '合并转发的聊天记录、语音、视频、卡片不会自动出现在上下文里。' +
                  '如果主人说「看这个」「聊天记录」「转发的」而你没看到内容，调用 fish_world（action=history，chat=private:QQ号 或 group:群号）读最近消息：' +
      '返回里的 [动图]、[表情包]、[语音]、[聊天记录:id] 是类型标记，聊天记录会顺手展开一部分，没展开的用 action=forward（forwardId=id）单独读。主人询问贴入聊天的 GIF/WebP 内容时，优先使用 read_animation 读取原始动图并检查时间标注帧；不能只凭缩略图第一帧作答。' +
                  '读不到就直说，不要猜内容。'
                )
              }
            } catch {}
            // 只在缺依赖 / 接线异常时提醒；环境正常时提示词里不出现这一节。
            try {
              const env = environment.status()
              if (env && env.ok === false) {
                parts.push(
                  '【运行环境】鱼的世界检测到前置插件或接线不完整：' + env.warnings.join(' ') +
                  (env.hints.length ? '修复方式：' + env.hints.map((item) => item.command || item.label).join('；') + '。' : '') +
                  '请用一两句话提醒主人按上面的方式安装或修复；对应功能在修好前不要假装可用，也不要反复重试。'
                )
              }
            } catch {}
            const qzoneConfig = configStore.getConfig().qzone || {}
            if (qzoneConfig.enabled !== false) {
              parts.push(
                '【QQ空间】空间属于鱼自己（QQ 桥登录的账号），不是主人的空间；读写仅在主人的隔离会话中发起，其他会话的空间工具会被程序拒绝。' +
                '你可以在聊天轮次中择机浏览自己空间里的动态、发一条有意义的原创动态/日记、点赞、评论或回复。后台计时器只会向主人会话投递日记提醒，不会绕过工具直接发空间内容。' +
                '使用 fish_world 工具的 qzone-status、qzone-feeds、qzone-comments、qzone-post、qzone-diary、qzone-like、qzone-comment、qzone-reply 动作。' +
                `每日额度分别为：动态/日记 ${qzoneConfig.postsPerDay ?? 2} 次、点赞 ${qzoneConfig.likesPerDay ?? 2} 次、` +
                `评论 ${qzoneConfig.commentsPerDay ?? 2} 次、回复 ${qzoneConfig.repliesPerDay ?? 2} 次。` +
                '空间日记目标为每 24 小时至少一篇：计时器发现到期且主人 agent 可用时，会投递内部提醒；到期且额度可用时先用 qzone-diary（不带 text）取已批准素材，再写并发布。' +
                '没有已批准素材时可以写安静的一天，但不得编造经历；主人 agent 暂不可用时会等它恢复后再提醒。' +
                '空间内容对好友可见且发布后难以撤回；不要公开转发他人私聊、私密图片或敏感信息。' +
                '互动目标必须先从最近的动态/评论清单中选取；网络结果不确定时不要重试同一操作。'
              )
            }
            parts.push(
              '【鱼的日记】日记是鱼自己写的，不是主人代笔：你可以用 fish_world（action=diary，text=正文）记录自己的日常与心情，默认署名用当前外显角色名。' +
              '主人只在「设置 → 鱼的世界 → 鱼的日记」里浏览与审批，不会替你写。信任者提交的日记会进入待确认队列，需要主人批准后才算正式日记。'
            )
            return parts.join('\n\n')
          },
        })
        pushDisposable(off)
      } catch (error) {
        logger.warn?.(`fish-world: 挂系统提示词失败：${error?.message || error}`)
      }
    })
  }

  // 3) 旁听会话事件：把 bridge 注入的 QQ 用户消息转成 message.in；
  //    把一轮完成的助手回复转成 message.out（只观察，不重复发 QQ）。
  if (typeof ctx.on === 'function') {
    const off = ctx.on('session/event', (session, event) => {
      try {
        const data = event && event.data
        if (!data || typeof data !== 'object') return
        const sessionId = String(session && session.id ? session.id : '')

        if (event.type === 'user/message') {
          const source = data.source && typeof data.source === 'object' ? data.source : {}
          if (source.kind !== 'qq') return
          const payload = {
            id: String(data.id || ''),
            sessionId,
            chatKey: defaultChatKey(),
            text: textOf(data.content),
            images: imagesOf(data.content),
            at: Date.now(),
            source: 'qq',
          }
          bus.emit('message.in', payload)
          bus.emit('session.update', { sessionId, kind: 'message.in', at: payload.at })
          return
        }

        if (event.type === 'assistant/message') {
          const message = data.message && typeof data.message === 'object' ? data.message : {}
          const text = textOf(message.content).trim()
          if (text) assistantBySession.set(sessionId, { turn: Number(data.turn) || 0, text, at: Date.now() })
          return
        }

        if (event.type === 'turn/end') {
          const prev = assistantBySession.get(sessionId)
          const turn = Number(data.turn) || 0
          if (prev && prev.turn === turn && data.reason && data.reason.kind === 'completed') {
            bus.emit('message.out', {
              sessionId,
              chatKey: defaultChatKey(),
              text: prev.text,
              at: Date.now(),
              turn,
            })
          }
          assistantBySession.delete(sessionId)
          bus.emit('session.update', { sessionId, kind: 'turn.end', at: Date.now() })
        }
      } catch (error) {
        try { logger.warn?.(`fish-world: 处理会话事件失败：${error?.message || error}`) } catch {}
      }
    })
    if (typeof off === 'function') disposers.push(off)
  }

  // 4) 本地 HTTP 路由。
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    for (const route of buildRoutes({ loader, qq, whale, world, configStore, market, stickers, environment })) {
      const register = () => ctx.webServer.register(route)
      try {
        if (typeof ctx.effect === 'function') {
          const off = ctx.effect(register, `fish-world: ${route.path}`)
          pushDisposable(off)
        } else {
          const off = register()
          pushDisposable(off)
        }
      } catch (error) {
        logger.warn?.(`fish-world: 注册路由 ${route.path} 失败：${error?.message || error}`)
      }
    }
  }

  // 5) 扫描并加载扩展（异步，不阻塞宿主启动）。
  queueMicrotask(() => {
    loader.reload().catch((error) => {
      try { logger.error?.(`fish-world: 首次扫描失败：${error?.message || error}`) } catch {}
    })
  })

  logger.info?.(`鱼的世界 v${loader.getVersion?.() || '0.1.0'} 已挂载｜扩展目录 ${cfg.extensionDirs.join(' ; ')}`)
  return adapter
}

export function apply(ctx) {
  return createAdapter(ctx)
}
