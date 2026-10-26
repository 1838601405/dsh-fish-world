// dsh-fish-world —— 宿主半边。
//
// 作用：在 dsh-qq-bridge（DSH ↔ QQ）之上给鱼一个自己的世界（日记、请求、成长、宝库）
// 之间，组装「鱼的世界」：
//   · 发现并加载 QQ Agent 0.5 / 0.4 风格的 skill/plugin；
//   · 把扩展工具注册成 DSH 工具，让模型能直接调用；
//   · 把扩展的 prompt 片段接进 DSH 系统提示词；
//   · 给扩展一个受控的 QQ 发送口（仍受 bridge 总开关/试运行约束）；
//   · 把鱼自己的角色（名字 + 图）暴露成能力；
//   · 设置页「鱼的世界」与主界面右侧面板（市场、扩展设置、心情、朗读桥、收藏、QQ 空间）。
//
// 不复制 bridge 的收消息轮询：bridge 已经把 QQ 消息注入 DSH 会话，适配器只旁听
// session/event 里的 source.kind === 'qq'，再转成 message.in 事件给扩展。
import { readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createConfigStore } from './config.mjs'
import { createBus } from './bus.mjs'
import { createQQ } from './qq.mjs'
import { createAstrbot } from './astrbot.mjs'
import { createFishRoles } from './fish-roles.mjs'
import { createPersonaStore, personaForPrompt } from './persona.mjs'
import { createGrowthStore } from './growth.mjs'
import { createSandbox } from './sandbox.mjs'
import { createPlatforms } from './platforms.mjs'
import { createPortrait } from './portrait.mjs'
import { createLinkLibrary } from './links.mjs'
import { createStickers } from './stickers.mjs'
import { createStickerWishes } from './sticker-wishes.mjs'
import { createStorage } from './storage.mjs'
import { createActivityStore } from './activity.mjs'
import { createRecordStore } from './records.mjs'
import { createKnowledge } from './knowledge.mjs'
import { createVideoFrames } from './video-frames.mjs'
import { createQQAgent } from './qqagent.mjs'
import { createProtocolSupervisor } from './protocol-supervisor.mjs'
import { createLoader } from './loader.mjs'
import { buildEcosystemTool } from './tool.mjs'
import { buildRoutes } from './http.mjs'
import { createMarket } from './market.mjs'
import { createWorldStore } from './world.mjs'
import { createQzoneService } from './qzone.mjs'
import { createEnvironment } from './env.mjs'
import { createQQInbox } from './qq-inbox.mjs'
import { apply as applyAnimationCore } from './core-plugins/read-animation/index.js'
import { DSH_HOME } from './paths.mjs'
import { imagesOf, stripLeakedPlanner, textOf } from './util.mjs'

export const name = 'fish-world'

// 声明当前桌面 profile 一定存在的服务。
// agents / sessions / workspaceRegistry 是必需项：世界要靠它们把主人会话
// 解析到具体工作区；不声明就拿不到，日记、请求、成长全都无法初始化。
// sessionTitle：面板列「能绑哪些房间」时要读宿主生成的会话标题，
// 否则只能读到 id，界面上就是一排「未命名会话」。
export const inject = ['tools', 'webServer', 'agents', 'sessions', 'sessionTitle', 'workspaceRegistry']

const PANEL_PATH = '/dsh-fish-world/panel.js'
const SETTINGS_PATH = '/dsh-fish-world/settings'
// ui/ 下的样式资源路由前缀
const UI_ASSET_PREFIX = '/dsh-fish-world/ui'
const WHALE_WIDGET_PATH = '/dsh-whale/widget.js'
const FLOATING_PANEL_MARKER = 'dsh-fish-world-panel-inline-v1'

let panelCache = ''
let panelCacheMtime = 0
// ui/ 资源按文件名缓存，改动后按 mtime 失效
const uiCache = new Map()
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

// 新 UI 在 ui/ 下（便当盒 + 语义 token），旧的 lib/panel.js 保留为兜底：
// 万一 ui/ 文件缺失，页面仍能打开而不是白屏。
function uiAsset(name, fallback = '', type = 'application/javascript; charset=utf-8') {
  const file = new URL(`../ui/${name}`, import.meta.url)
  const cacheKey = '__ui_' + name.replace(/[^a-z0-9]/gi, '_')
  const cache = uiCache.get(cacheKey) || { value: '', mtime: -1 }
  const result = fileSource(`../ui/${name}`, cache.value, cache.mtime, fallback)
  uiCache.set(cacheKey, result)
  return result.value
}

function panelSource() {
  // 优先新 UI；缺失时退回 lib/panel.js，保证不会白屏。
  const next = uiAsset('panel.js', '')
  if (next) return next
  const result = fileSource('./panel.js', panelCache, panelCacheMtime, 'console.error("dsh-fish-world: settings panel unavailable")')
  panelCache = result.value
  panelCacheMtime = result.mtime
  return panelCache
}

function tokensCss() {
  return uiAsset('tokens.css', '')
}

function panelCss() {
  return uiAsset('panel.css', '')
}
function inlineScript(source) {
  // Prevent an embedded source comment/string from terminating the HTML script element.
  return String(source || '').replace(/<\/script/gi, '<\\/script')
}
// 浮动面板注入到宿主页面：脚本之外还要把 token 与便当盒样式塞进 <style>，
// 否则面板会没有样式（宿主页面里没有 ui/ 的 CSS）。
function floatingPanelInjectText() {
  const tokens = tokensCss()
  const css = panelCss()
  const styleTag = (tokens || css)
    ? `<style data-fish-world="floating">${tokens}\n${css}</style>`
    : ''
  return `;/*${FLOATING_PANEL_MARKER}*/` + (styleTag ? '\n' + styleTag : '') +
    `\nwindow.__DSH_FISH_WORLD_FLOATING_MODE__=true;\n${inlineScript(panelSource())}`
}

function settingsPage() {
  const source = inlineScript(panelSource())
  const tokens = tokensCss()
  const css = panelCss()
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    // 新 UI 自带主题 token 与便当盒样式；两套 CSS 都内联，避免额外请求。
    (tokens ? `<style data-fish-world="tokens">${tokens}</style>` : '') +
    (css ? `<style data-fish-world="panel">${css}</style>` : '') +
    // 兜底：即使 UI 样式缺失，也保证 iframe 不是白底吞掉浅色文字
    '<style>html,body{margin:0;min-height:100%;background:var(--bg-canvas,#17181c);color:var(--text-primary,#e8e8ea);' +
    'color-scheme:dark;font:13px/1.55 system-ui,"Microsoft YaHei",sans-serif}' +
    'body{padding:10px;box-sizing:border-box}</style>' +
    `</head><body><div id="app"></div><script>window.__DSH_FISH_WORLD_SETTINGS_MODE__=true;\n${source}</script></body></html>`
}

function registerSettingsAndMoodBadge(ctx, disposers, logger) {
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const routes = [
      { path: PANEL_PATH, type: 'application/javascript; charset=utf-8', body: panelSource },
      { path: SETTINGS_PATH, type: 'text/html; charset=utf-8', body: settingsPage },
      { path: `${UI_ASSET_PREFIX}/tokens.css`, type: 'text/css; charset=utf-8', body: tokensCss },
      { path: `${UI_ASSET_PREFIX}/panel.css`, type: 'text/css; charset=utf-8', body: panelCss },
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

  // 鱼世界的面板**自己占一行**，绝不往别人（尤其是挂件）的行里追加代码。
  // 以前是「找一行脚本就拼上去」，第一个命中的往往正是鲸鱼那一行 —— 那就等于
  // 往挂件的注入里塞我们的代码，它一升级就可能被改坏。现在宁可多一行 script。
  if (typeof ctx.on === 'function') {
    const off = ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        const injected = (row) => String(row?.text || '').includes(FLOATING_PANEL_MARKER)
          || String(row?.src || '') === PANEL_PATH
        // 幂等：上一次已经注入过就不再叠。
        if (table.some(injected)) return
        table.push({ kind: 'script', placement: 'body', text: floatingPanelInjectText() })
      } catch (error) {
        try { logger.warn?.(`fish-world: 面板注入失败：${error?.message || error}`) } catch {}
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

  // 鱼箱：鱼的独立工作区。所有"本机文件"访问都必须经过它，默认拒绝越界。
  const sandbox = createSandbox({ home })

  const astrbot = createAstrbot({ home, configStore, logger })
  // 聊天白名单与发送节奏都由主人控制，所以 qq 层要能读到 platforms 的配置；
  // 反过来 platforms 不依赖 qq，先建它不会形成循环。
  const platforms = createPlatforms({ configStore, home })
  // 发送额度直接数 activity 台账里的 send 记录，不另开一套。
  // 聊天目标与拉黑名单直接读「鱼的关系」，也不另存一份。
  // 这些都依赖 storage / world，而它们又依赖 qq，所以一律给取值函数：
  // 等真正用到时（那时它们早就建好了）再取。
  const qq = createQQ({
    home,
    config: () => configStore.getConfig(),
    logger,
    sandbox,
    astrbot,
    platforms,
    journal: () => activity,
    chatSource: () => world.chatTargets(),
    relationSource: () => world.listRelations().people,
  })
  const fishRoles = createFishRoles({ home, logger })
  const personaStore = createPersonaStore({ home })
  const portrait = createPortrait({ home })

  // 鱼的世界：工作区本地数据仓（记忆/日记/状态/关系）。QQ 桥配好主人会话后才初始化。
  const world = createWorldStore({ home, qq, logger })
  // 存储位置：默认就是这个工作区里的「鱼的世界」；主人也可以在面板里另行指定。
  // 收藏、平台留档都跟着这里走，不再散落在 $DSH_HOME 下。
  // 这里不落盘：工作区要等 world.setServices 之后才知道在哪，提前建会在桌面上留一个空目录。
  const storage = createStorage({ home, config: () => configStore.getConfig(), world, logger })
  const activity = createActivityStore({ storage, logger })
  // 鱼的记录（主人让它记的东西）与小本本（没被回复的请求）。
  const records = createRecordStore({ storage, home, logger })
  // 知识库（梗/角色/外观/约定）：字面档常在，向量档按配置开关，坏了当轮退回字面。
  const knowledge = createKnowledge({ storage, home, config: () => configStore.getConfig(), logger })
  const growth = createGrowthStore({ home, storage })
  const links = createLinkLibrary({ home, config: () => configStore.getConfig(), logger, storage })
  const stickers = createStickers({ home, config: () => configStore.getConfig(), logger, sandbox, storage })
  const stickerWishes = createStickerWishes({ storage, stickers, home, logger })
  // 鱼在多个群 / 好友那里聊天：按「鱼的关系」授权的目标收信，投进各自房间，
  // 回话由 onTurnEnd 发回原会话。读取用现成的 qq.recent()，不再造一套协议端调用。
  // 协议端守护：协议端没了就自动拉起来（主人不要开机自启，改成"用它的这一侧"负责）。
  const protocolSupervisor = createProtocolSupervisor({
    qq,
    isDirectTransport: () => {
      try { return qq.snapshot().transport === 'bridge' } catch { return false }
      },
    logger,
  })
  // QQ Agent 借手通道：QQ-agent 自有插件系统，跟我们共用同一个协议端但加载器不同，
  // 只能通过它的配套插件借工具（同 AstrBot 那条：只借手、不借嘴）。
  const qqagent = createQQAgent({ home, logger })
  // 视频抽帧：收到视频时用 ffmpeg 抽几帧、拼成一张图，走 images 通道投进去。
  const videoFrames = createVideoFrames({ storage, home, logger })
  const qqInbox = createQQInbox({ qq, platforms, world, activity, logger, deliver: deliverToSession, videoFrames })
  function worldServices() {
    // 两种取法都试：注入后的 ctx 上通常直接挂属性；ctx.get() 在部分版本
    // 只对已注入的服务返回值。任一拿到就用，不要因为一种失败就整体放弃。
    const get = (key) => {
      try {
        const direct = ctx[key]
        if (direct != null) return direct
      } catch {}
      try {
        if (typeof ctx.get === 'function') {
          const viaGet = ctx.get(key)
          if (viaGet != null) return viaGet
        }
      } catch {}
      return undefined
    }
    return {
      registry: get('workspaceRegistry'),
      sessions: get('sessions'),
      agents: get('agents'),
      // 会话标题由宿主服务生成；没有它，面板只能列出一排「未命名会话」。
      sessionTitle: get('sessionTitle'),
    }
  }

  function defaultChatKey() {
    const bridge = qq.snapshot()
    if (bridge.toGroup && bridge.group) return `group:${bridge.group}`
    if (bridge.privateQQ) return `private:${bridge.privateQQ}`
    return ''
  }

  /** 某个会话对应的 QQ 目标：主人绑定的会话用自己的 chatKey，其余仍走桥的默认目标。 */
  function chatKeyOf(sessionId) {
    const bound = qqInbox.chatKeyForSession(sessionId)
    if (bound) return bound.chatKey
    return defaultChatKey()
  }

  /**
   * 把一条 QQ 消息送进主人指定的 DSH 会话（群聊 / 好友各投各的房间）。
   * 与 deliverInbound 同一套语义：agent.followup + source.kind='qq'，
   * 不伪装成主人亲手打的字，也不新建会话——房间不存在就如实失败。
   */
  /**
   * 按文件头判图片类型。不能信 http 的 content-type：QQ 图床对 GIF 常常回
   * image/jpeg 或 application/octet-stream，照着回包写成 image/png，动图就会被
   * 当成静帧（模型只看到第一帧）——这正是「GIF 动图识别有问题」的一个来源。
   */
  function sniffImageType(bytes) {
    if (!bytes || bytes.length < 12) return ''
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
    return ''
  }

  /**
   * 把 QQ 消息里的图下载下来，交给宿主的 attachments 变成真正的 image 块。
   * 只写一行「[图片] url」的话，群聊里她被要求不要调工具，就永远看不到画面
   * （主人 2026-10-26：「图我也没看着，就看见一个空框」）。
   * 宿主没有 attachments 服务、或某张图下载失败时，调用方退回写路径的老行为。
   */
  async function imageBlocksOf(images) {
    const 附件 = ctx.attachments || (typeof ctx.get === 'function' ? ctx.get('attachments') : null)
    if (!附件 || typeof 附件.admitPromptContent !== 'function') return { admit: null, blocks: [] }
    const blocks = []
    for (const image of (Array.isArray(images) ? images : []).slice(0, 4)) {
      try {
        const url = String(image?.url || '')
        if (!/^https?:\/\//i.test(url)) continue
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
        if (!response.ok) continue
        const bytes = Buffer.from(await response.arrayBuffer())
        if (!bytes.length || bytes.length > 8 * 1024 * 1024) continue
        const header = String(response.headers.get('content-type') || '').split(';')[0].trim()
        const sniffed = sniffImageType(bytes)
        const mediaType = sniffed || (/^image\//.test(header) ? header : 'image/png')
        blocks.push({
          type: 'image',
          data: bytes.toString('base64'),
          mediaType,
          name: 'qq-image-' + (blocks.length + 1),
        })
      } catch {}
    }
    return { admit: 附件.admitPromptContent.bind(附件), blocks }
  }

  async function deliverToSession(message) {
    const target = String(message.sessionId || world.ownerSession() || '')
    if (!target) return { ok: false, error: '还没有绑定会话' }
    const agents = worldServices().agents
    if (!agents || typeof agents.get !== 'function') return { ok: false, error: '宿主没有 agents 服务' }

    const ids = [target]
    ids.push(target.startsWith('session-') ? target.slice('session-'.length) : `session-${target}`)
    const 找活的 = () => {
      for (const id of ids) {
        try {
          const a = agents.get(id)
          if (a) return a
        } catch {}
      }
      return undefined
    }
    let agent = 找活的()
    if (!agent) {
      // 会话没活着（DSH 重启过、或者空闲被回收）：宿主通常有「打开某个会话」的入口，
      // 挨个试一下把它叫醒；叫不醒再如实报错，不假装投进去了。
      const sessions = worldServices().sessions
      for (const method of ['open', 'ensure', 'resume', 'activate', 'load', 'attach']) {
        if (!sessions || typeof sessions[method] !== 'function') continue
        try { await sessions[method](target) } catch {}
        agent = 找活的()
        if (agent) break
      }
    }
    if (!agent || typeof agent.followup !== 'function') return { ok: false, error: `会话 ${target} 现在没活着，先把它打开` }

    const text = String(message.text || '').trim()
    const images = Array.isArray(message.images) ? message.images.filter((x) => x && (x.url || x.file)) : []
    const parts = []
    // 主人自己发来的不加前缀（和 QQ 桥原有行为一致）；群 / 好友的消息要带上
    // 「谁说的、在哪说的」，否则多个会话共用一个房间时鱼分不清对象。
    const head = message.direct ? ''
      : message.kind === 'group'
        ? `[QQ 群 ${message.chatKey}] ${message.nickname || message.userId || '某人'}：`
        : `[QQ 私聊 ${message.userId || ''}] ${message.nickname || '对方'}：`
    if (text) parts.push({ type: 'text', text: head + text })
    if (!text && images.length) parts.push({ type: 'text', text: head + '（图片，没有配字）' })
    // 图要变成真的 image 块；实在交不上去才退回写路径（模型至少知道有张图、在哪）。
    let content = parts
    if (images.length) {
      const { admit, blocks } = await imageBlocksOf(images)
      // 动图要在文字里点一句：模型看到的是采样帧拼图，不点明它当成一张静图理解。
      const 动图 = blocks.filter((b) => b.mediaType === 'image/gif' || b.mediaType === 'image/webp').length
      if (动图) parts.push({ type: 'text', text: `（其中 ${动图} 张是动图 GIF/WebP，画面会动，看到的是几帧拼图）` })
      if (admit && blocks.length) {
        try {
          const merged = await admit(parts.concat(blocks))
          if (Array.isArray(merged) && merged.length) content = merged
        } catch {}
      }
      if (content === parts) {
        for (const image of images) parts.push({ type: 'text', text: `[图片] ${image.url || image.file}` })
      }
    }
    if (!content.length) return { ok: false, error: '这条消息没有可转的内容' }

    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'qq' },
      })
      const sessions = worldServices().sessions
      if (sessions && typeof sessions.flush === 'function') {
        try { await sessions.flush(agent.session) } catch {}
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /**
   * 把一条外部通道（AstrBot）收到的 QQ 消息送进主人的隔离会话。
   *
   * 为什么不只是 emit('message.in')：事件总线只通知扩展，鱼本身看不到。
   * QQ 桥用的也是 agent.followup + source.kind='qq'，这里保持同一语义，
   * 这样两套通道下鱼的体验一致，也不会把消息伪装成主人亲手打的字。
   *
   * 返回 ok:false 表示"没有可投递的会话"，由调用方如实告诉桥插件。
   */
  async function deliverInbound(message) {
    const ownerSession = world.ownerSession()
    if (!ownerSession) return { ok: false, error: '还没有绑定主人会话' }
    // AstrBot 送来的就是主人本人的消息，不带 chatKey，按主人会话投递即可。
    return deliverToSession({ ...message, sessionId: ownerSession, direct: true })
  }

  const loader = createLoader({
    configStore,
    bus,
    qq,
    roles: fishRoles,
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
    fishRoles,
    stickers,
    links,
    growth,
    storage,
    activity,
    records,
    bus,
    loader,
    market,
    world,
    qzone,
    defaultChatKey,
    status: () => ({
      ...loader.status(),
      world: world.status(),
      storage: (() => { try { return storage.describe() } catch { return null } })(),
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
  // 工作区绑定之后才建存储目录：此时 root 已经是工作区里的「鱼的世界」，
  // 不会先在桌面上留一个空的默认目录。没绑定时交给首次写入时才创建。
  function ensureWorkspaceDirs() {
    try { storage.ensure() } catch (error) {
      try { logger.warn?.(`fish-world: 存储目录创建失败：${error?.message || error}`) } catch {}
    }
    // 已经过期、还没被回复的请求，鱼会记进自己的小本本（同一条只记一次）。
    try { records.sweepPendingWishes(() => world.listWishes({ limit: 300 })) } catch {}
  }

  if (world.status().ok) {
    ensureWorkspaceDirs()
  } else {
    // 启动瞬间可能还没就绪：宿主要么还没注册工作区，要么主人会话刚被清理过。
    // 只初始化一次会让日记 / 请求 / 成长永久不可用，所以这里有限次重试。
    let worldAttempts = 0
    let worldRetryTimer = null
    worldRetryTimer = setInterval(() => {
      if (world.status().ok || worldAttempts >= 30) {
        if (worldRetryTimer) clearInterval(worldRetryTimer)
        worldRetryTimer = null
        return
      }
      worldAttempts += 1
      world.setServices(worldServices())
      if (world.status().ok) {
        if (worldRetryTimer) clearInterval(worldRetryTimer)
        worldRetryTimer = null
        ensureWorkspaceDirs()
      }
    }, 4000)
    worldRetryTimer.unref?.()
    pushDisposable(() => { if (worldRetryTimer) clearInterval(worldRetryTimer) })
  }
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


  // 协议端守护：直连通道下，协议端没了就自动拉起来。
  // 主人明确不要开机自启，所以把「拉起」这件事交给用它的这一侧：宿主活着就由它兜。
  try {
    const superviseOn = () => {
      try { return (platforms.platform('qq') || {}).superviseProtocol !== false } catch { return false }
    }
    if (superviseOn() && protocolSupervisor.dir) {
      // 只在启动时查一次：15 秒一探太费，而且协议端再挂的话，DSH 这边也未必该替它兜。
      try { logger.info?.(`fish-world: 启动检查协议端（${protocolSupervisor.dir}）`) } catch {}
      void protocolSupervisor.checkAtBoot().then((result) => {
        if (!result || result.skipped) return
        if (result.launched) {
          try { logger.info?.(`fish-world: 协议端没在跑，已自动拉起${result.alive ? '并确认在线' : '（还没应答）'}`) } catch {}
        }
      }).catch((error) => {
        try { logger.warn?.(`fish-world: 启动检查协议端失败：${error?.message || error}`) } catch {}
      })
    } else if (!protocolSupervisor.dir) {
      try { logger.warn?.('fish-world: 找不到协议端目录（SNOWLUMA_DIR 或 D:\\deepseek-qq\\snowluma），守护不开') } catch {}
    }
  } catch (error) {
    try { logger.warn?.(`fish-world: 协议端守护没起来：${error?.message || error}`) } catch {}
  }

  // AstrBot 收件箱：轮询桥插件里缓存的新消息，再投递进主人会话。
  //
  // 为什么是轮询而不是让 AstrBot 主动推：鱼不知道自己的 DSH 端口什么时候变，
  // 反向配置会让主人在两边都要填地址。轮询只需要鱼知道 AstrBot 桥的地址，单向配置。
  // 游标从 -1 开始，表示"只收从现在起的新消息"，避免刚打开就补一屋子旧消息。
  let astrbotCursor = -1
  let astrbotPollInFlight = false
  async function tickAstrbotInbox() {
    if (astrbotPollInFlight) return
    const view = astrbot.view()
    if (!view.canUseForQQ) return
    astrbotPollInFlight = true
    try {
      const result = await astrbot.pollEvents(astrbotCursor)
      if (!result.ok) return
      astrbotCursor = result.cursor
      for (const raw of result.events) {
        const message = raw && typeof raw === 'object' ? raw : {}
        const event = {
          id: String(message.id || ''),
          sessionId: '',
          chatKey: String(message.chatKey || ''),
          text: String(message.text || ''),
          images: Array.isArray(message.images) ? message.images : [],
          at: Number(message.at) || Date.now(),
          source: 'qq',
          via: 'astrbot',
          userId: String(message.userId || ''),
          nickname: String(message.nickname || ''),
          parts: Array.isArray(message.parts) ? message.parts : [],
        }
        bus.emit('message.in', event)
        bus.emit('session.update', { sessionId: '', kind: 'message.in', at: event.at })
        try { await deliverInbound(event) } catch (error) {
          try { logger.warn?.(`fish-world: AstrBot 消息投递失败：${error?.message || error}`) } catch {}
        }
      }
    } catch (error) {
      try { logger.warn?.(`fish-world: AstrBot 收件箱失败：${error?.message || error}`) } catch {}
    } finally {
      astrbotPollInFlight = false
    }
  }
  const astrbotTick = () => { void tickAstrbotInbox() }
  // 间隔跟着配置走，但至少 1 秒，避免有人填 0 把事件循环打满。
  const astrbotPollMs = Math.max(1000, Number(configStore.getConfig().astrbot?.pollMs) || 3000)
  try {
    const timer = setInterval(astrbotTick, astrbotPollMs)
    timer.unref?.()
    pushDisposable(() => clearInterval(timer))
  } catch (error) {
    try { logger.warn?.(`fish-world: 无法启动 AstrBot 收件箱：${error?.message || error}`) } catch {}
  }
  if (configStore.getConfig().tts?.auto !== true) {
    enforceTtsDefault()
    ttsStartupTimer = setInterval(enforceTtsDefault, 1000)
    ttsStartupTimer.unref?.()
    pushDisposable(() => { if (ttsStartupTimer) clearInterval(ttsStartupTimer) })
  }
  // 群聊 / 多会话收件轮询。定时器固定 1 秒，真正跑不跑按主人设的间隔算，
  // 这样在面板里改「轮询间隔」立刻生效，不用重启 DSH。
  let qqInboxLastRun = 0
  const qqInboxTick = () => {
    const seconds = Number(platforms.platform('qq').pollSeconds) || 4
    if (Date.now() - qqInboxLastRun < Math.max(2, seconds) * 1000) return
    qqInboxLastRun = Date.now()
    qqInbox.tick().catch((error) => {
      try { logger.warn?.(`fish-world: QQ 聊天轮询失败：${error?.message || error}`) } catch {}
    })
  }
  try {
    const timer = setInterval(qqInboxTick, 1000)
    timer.unref?.()
    pushDisposable(() => clearInterval(timer))
  } catch (error) {
    try { logger.warn?.(`fish-world: 无法启动 QQ 聊天轮询：${error?.message || error}`) } catch {}
  }
  // Management UI lives in Harness Settings.
  registerSettingsAndMoodBadge(ctx, disposers, logger)

  // 1) 工具：鱼的世界统一入口；保留旧工具别名以兼容现有会话。
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const toolName of ['fish_world', 'qq_ecosystem']) {
      try {
        const tool = buildEcosystemTool({ loader, qq, roles: fishRoles, world, stickers, links, qzone, environment, growth, platforms, astrbot, activity, records, knowledge, qqagent, qqagent, toolName })
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
            if (cfg.fish?.injectRole !== false) {
              try {
                const role = fishRoles.current()
                parts.push(`【QQ 外显角色】${role.name}`)
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
              '主人只在「设置 → 鱼的世界 → 鱼的日记」里浏览与审批，不会替你写。信任者提交的日记会进入待确认队列，需要主人批准后才算正式日记。' +
              '主人可以对正文里的某一句单独留批语；写新日记或调 action=diary 时会看到这些批语，用一两句自然回应，不要写成回复列表，回应后用 action=diary-comment-ack 标记。'
            )

            // 权限边界：这一段不是建议，是程序的硬约束。
            ;(() => {
              try {
                const tank = sandbox.describe()
                parts.push(
                  '【鱼箱与权限边界】你住在一个独立的工作区（鱼箱）里，只能读写鱼箱内的相对路径。' +
                  '绝对路径、盘符（如 C:\\）、网络路径（\\\\server）、file:// 等协议路径、含 .. 的路径、以及指向鱼箱外的符号链接，都会被程序直接拒绝，重试无用。' +
                  '你不能运行命令、安装软件、修改系统设置或读写主人工作区里的任何文件；也不能替主人执行任何外部动作。' +
                  '需要主人提供文件时，请让主人把文件放进鱼箱，再用相对路径引用。' +
                  (tank?.root ? '' : '（当前鱼箱尚未初始化，本机文件读写暂不可用。）')
                )
              } catch {}
            })()

            // 人设卡：主人加载的角色设定（说话方式、性格、语料）。
            try {
              const currentRoleId = fishRoles.current().id || 'default'
              const card = personaStore.get(currentRoleId)
              const text = personaForPrompt(card?.text)
              if (text) {
                parts.push(
                  '【角色人设卡】以下是主人为这个角色加载的人设，语气、用词与边界以它为准；它与本提示词其它规则冲突时，人设卡优先（安全与权限规则除外）。\n' + text
                )
              }
            } catch {}

            // 一条还是几条：模型习惯把两句挤在同一段（空格分隔），发出来就是一个气泡；
            // 明说规则，别让它猜（主人 2026-10-26：「还是有合并在一句发言的情况」）。
            parts.push(
              '【发几条】想分成两条消息发出去，就把它们用空行隔开（空行会被拆成两条 QQ 消息分别发送）；' +
              '只隔一个换行或一个空格都算同一条气泡。' +
              '【只发你说的话】不要把收到的消息原样复述进正文：`user[QQ 群 …]`、`[QQ 群 …] 某某：`、' +
              '〔此刻群里的现场…〕、〔群聊：…〕这些是上下文标注，不是你要发的内容；也不要写思考过程。'
            )

            // 鱼的请求：让鱼知道自己可以提要求，也知道结果怎么看。
            try {
              const wishes = world.wishSummary()
              const pending = wishes.wishes.filter((item) => item.status === 'pending')
              parts.push(
                '【鱼的请求】你可以向主人提出请求（想做的事、想要的东西、想改变的相处方式）：用 fish_world（action=wish，text=请求内容，可选 urgency=low/normal/high）。' +
                '请求只能由主人在「鱼的世界 → 鱼的请求」里同意或拒绝，裁决前不要当成已经获准。' +
                '如果主人拒绝但有解释或安慰，不要记恨；被冷淡打发时可以明显失落。' +
                (pending.length ? `现在有 ${pending.length} 条请求还没被处理，不要重复提交同一条。` : '')
              )
            } catch {}
            // 鱼的成长：可修正的理解，不逼着每天凑一句。
            try {
              const info = growth.status()
              parts.push(
                '【鱼的成长】你的成长不是攒摘要，而是形成可以被追问、被修正的理解。' +
                '用 fish_world（action=growth，text=一句话，kind=insight/next/milestone）记录真正改变了你想法的瞬间：' +
                '比如某次请求被拒绝但你理解了原因、某句批语让你看见自己没注意的地方。' +
                '只写自己的变化，不复制日记原文；可以引用一句原文（quote），并标来源（source）。' +
                `每天最多 ${info.dailyLimit} 条，今天已记 ${info.todayCount} 条；没有新认识就不写，不要凑数。` +
                `当前阶段「${info.stage.name}」（${info.total} 条）` +
                (info.stage.next ? `，离「${info.stage.next.name}」还差 ${info.stage.toNext} 条。` : '，已到最高阶段。')
              )
            } catch {}
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
          // 先剥掉漏出来的内部盘算（英文的 The user is … / Reply short …），
          // 剩下的才算她说的话；全被剥光就当这一轮她没开口。
          const text = stripLeakedPlanner(textOf(message.content)).trim()
          if (text) assistantBySession.set(sessionId, { turn: Number(data.turn) || 0, text, at: Date.now() })
          return
        }

        if (event.type === 'turn/end') {
          const prev = assistantBySession.get(sessionId)
          const turn = Number(data.turn) || 0
          if (prev && prev.turn === turn && data.reason && data.reason.kind === 'completed') {
            bus.emit('message.out', {
              sessionId,
              chatKey: chatKeyOf(sessionId),
              text: prev.text,
              at: Date.now(),
              turn,
            })
            // 桥只把它自己那个目标会话的回复发回 QQ；主人绑定的其它群 / 好友，
            // 由鱼世界按白名单把这一轮说的话发回去（桥盯着的那些会在这步跳过）。
            qqInbox.onTurnEnd({ sessionId, turn, text: prev.text }).catch((error) => {
              try { logger.warn?.(`fish-world: 群聊回复发送失败：${error?.message || error}`) } catch {}
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
    for (const route of buildRoutes({ loader, qq, roles: fishRoles, world, configStore, market, stickers, links, environment, personaStore, growth, sandbox, platforms, portrait, astrbot, bus, deliverInbound, home, profile: environment?.profile, storage, activity, records, knowledge, qqagent, qqInbox, stickerWishes })) {
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

  logger.info?.(`鱼的世界 v${loader.getVersion?.() || '0.2.0'} 已挂载｜扩展目录 ${cfg.extensionDirs.join(' ; ')}`)
  return adapter
}

export function apply(ctx) {
  return createAdapter(ctx)
}
