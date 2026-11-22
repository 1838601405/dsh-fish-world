// DSH 会话（粘贴的图 / 附件）→ 视觉管线（2026-11-22 主人方案 P3 的第三个平台）。
//
// ── 这一层做什么 ──
// 主人往 DSH 会话里粘一张图，宿主的 `attachments.admitPromptContent` 会把它
// 变成 image 块交给模型 —— **模型本来就看得见原图**。所以这里不是「让她能看见」，
// 而是**把这张图算进缓存**：同一份字节之后从 QQ、B站、空间任何一个入口再来，
// 都直接命中，不再花第二次钱。这就是方案「一次算过到处可用」的第三个入口。
//
// ── 为什么包 admitPromptContent ──
// 那是原图字节**还在**的最后一个时刻（宿主随后就把 bytes 销毁、只留引用），
// 再往后就只能拿到降级过的副本。`read-animation` 采样动图帧走的也是这里。
//
// ── 三条硬规矩（照抄 read-animation 的教训）──
//   ① **返回值一个字都不改**：`admitted` 原样交还，消息是主人写的就还是他写的；
//   ② **不 await**：算缓存是旁路，绝不能把粘图这件事拖慢（fire-and-forget + catch）；
//   ③ **装不上就如实说**：没 attachments 服务 / 方法不存在 / 只读属性装不进去，
//      各自 warn 一句并返回 false，不假装装好了。
//
// ── 复用而不是重造 ──
// 包装用 `read-animation/patch.js` 的 `wrapServiceMethod` —— 它的注释写明是
// 「shared rather than copied three times」：三个模块各包一个方法时，
// 各自为政会踩两个坑（安装检查永远为假、拆卸是后写者赢）。现在有第四个包装者，
// **必须共用同一套栈**，否则 read-animation 拆卸时会把我留成死包装。
// 归一化与描述走 `vision-input` 的 `ingest('session', …)` —— 与另两个入口同一个函数。

import { wrapServiceMethod, describe as describeError } from './core-plugins/read-animation/patch.js'

/** 一次最多算几张：与 vision-input 的 8 上限对齐，别让一条消息带一堆图时把预算打爆。 */
const MAX_PER_MESSAGE = 8

/** 动图不进这里：它的帧由 read-animation 展开交给模型，首帧描述反而是误导。 */
const SKIP_MEDIA = new Set(['image/gif'])

/**
 * 装上「粘图 → 算进缓存」这一层。**装上即生效**（没有额外开关）——
 * 要关掉就别调这个函数，装配本身就是开关。
 *
 * @param {object} opts
 * @param {object} opts.ctx      插件上下文（要能 `ctx.get('attachments')` 与 `ctx.effect`）
 * @param {Function} opts.getWire  () => { input, vision, backend } | null
 *                                —— 每次现取：世界根会变（换工作区），缓存旧实例会串
 * @param {object} [opts.logger]
 * @returns {boolean} 装上了没有（false = 已 warn 过原因）
 */
export function installSessionVision({ ctx, getWire, logger } = {}) {
  const log = (msg) => { try { logger?.warn?.(`fish-world: ${msg}`) } catch {} }

  // ★ 分两档，别把「宿主形态差异」当成错误喊出来：
  //   ① 压根没给 ctx —— 调用方写错了，warn（这条是真问题）；
  //   ② ctx 给了但没有 get 方法 —— 有些宿主/测试替身就是这个形态，
  //      read-animation 也是这么处理的（`if (typeof ctx.get === 'function')`），
  //      属**正常降级**，静默返回 false，不许写警告：
  //      adapter.test.mjs「环境正常时启动不应写警告」抓到过我把这条喊出来。
  if (!ctx) { log('会话视觉层：没有 ctx，装不上'); return false }
  if (typeof ctx.get !== 'function') return false

  const attachments = ctx.get('attachments')
  if (!attachments) { log('会话视觉层：宿主没有 attachments 服务，粘图不会算进缓存'); return false }
  if (typeof attachments.admitPromptContent !== 'function') {
    log('会话视觉层：宿主没有 admitPromptContent，粘图不会算进缓存')
    return false
  }

  const patch = wrapServiceMethod(attachments, 'admitPromptContent', (base) =>
    async function admitPromptContentVision(content) {
      // ★ 先走原实现、原样拿回结果 —— 任何后续失败都不许影响这条消息。
      const admitted = await base(content)
      try {
        // ★ 不 await：算缓存是旁路。这里只发起，结果自己 catch。
        warmup(content, getWire, logger)
      } catch (error) {
        log(`会话视觉层旁路出错（不影响消息）：${describeError(error)}`)
      }
      return admitted
    },
  )

  if (!patch.installed) {
    log('会话视觉层：包装没生效（属性可能只读），粘图不会算进缓存')
    return false
  }

  // 拆卸交给宿主的 effect 生命周期 —— 插件停用时把包装摘干净，不留死包装。
  try {
    ctx.effect(() => () => patch.remove(), 'dsh-fish-world: session vision warmup')
  } catch {
    // 没有 effect 的 ctx（测试替身）：包装仍然有效，只是没人替我们拆。
  }
  return true
}

/**
 * 把这条消息里的图算进缓存。**永不 reject**（调用方是 fire-and-forget）。
 *
 * @param {any} content  `admitPromptContent` 的入参（parts 数组）
 * @param {Function} getWire
 * @param {object} [logger]
 */
async function warmup(content, getWire, logger) {
  try {
    const wire = typeof getWire === 'function' ? getWire() : null
    // 没绑工作区 → 没有缓存落点，直接放弃（vision-wire 也返回 null，不猜路径）
    if (!wire || !wire.input || typeof wire.input.ingest !== 'function') return

    // ★ 过滤必须在**原始 part** 上做：`fromSession` 归一后只留 {bytes,name}，
    //   不保留 mediaType —— 拿归一后的结果去滤动图是死代码（实测 gif 照样进来）。
    const parts = (Array.isArray(content) ? content : []).filter((part) => {
      if (!part || part.type !== 'image') return false
      const media = String(part.mediaType || '').toLowerCase()
      return !SKIP_MEDIA.has(media)
    }).slice(0, MAX_PER_MESSAGE)
    if (!parts.length) return

    // ★ focus 留空 = 通用描述。另两个入口（QQ / 桌面）也用空 focus，
    //   口径一致才撞得到同一个缓存键 —— 方案 §三「各平台共用同一格式」。
    await wire.input.ingest('session', parts, { focus: '' })
  } catch (error) {
    try { logger?.warn?.(`fish-world: 会话视觉层算缓存失败（不影响消息）：${describeError(error)}`) } catch {}
  }
}

/**
 * 排查用：这层装没装、宿主给不给条件。
 * @param {object} ctx
 */
export function sessionVisionStatus(ctx) {
  const attachments = ctx?.get?.('attachments')
  return {
    hasCtx: Boolean(ctx && typeof ctx.get === 'function'),
    hasAttachments: Boolean(attachments),
    hasAdmit: typeof attachments?.admitPromptContent === 'function',
  }
}
