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

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { wrapServiceMethod, describe as describeError } from './core-plugins/read-animation/patch.js'
import { DSH_HOME } from './paths.mjs'

/**
 * 装配与每次 warmup 都往这里追加一行。
 *
 * ★ 为什么不能只靠 `logger.info`：DSH 的 logger **不落文件**（我上一轮用了它，
 *   结果主人贴的图没进缓存时，我翻遍 `*.log` 一个字都没有 —— 白加）。
 *   同目录的邻居 `memewiki.log` / `fish-memory-diag.log` 都是各插件自己 append 的，
 *   这里对齐那个惯例，保证「下次出问题一眼能查到卡在哪一环」。
 * ★ 路径来自 `paths.mjs` 的 `DSH_HOME`（环境变量），不写死本机路径（AGENTS 0⑤）。
 */
const LOG_FILE = join(DSH_HOME, 'vision-session.log')

function record(msg) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch {
    // 落盘失败绝不影响装配/消息 —— 日志是旁路。
  }
}

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
      // ★ 决定性日志：进 wrapper 就记（只记带图的，避免每条文字消息刷屏）。
      //   没有这行就分不清两种情况 —— ①包装没被调用 ②base() 抛错跳过了 warmup。
      //   2026-11-23 贴图排查时就卡在这：warmup 一条记录都没有，但两种原因都解释得通。
      const imgCount = Array.isArray(content)
        ? content.filter((p) => p && p.type === 'image').length
        : -1
      if (imgCount !== 0) {
        record(`admit 进 wrapper：content=${Array.isArray(content) ? 'array' : typeof content} 图=${imgCount}`)
      }

      // ★ 先走原实现、原样拿回结果 —— 任何后续失败都不许影响这条消息。
      let admitted
      try {
        admitted = await base(content)
      } catch (error) {
        record(`★ base() 抛错（warmup 被跳过）：${describeError(error)}`)
        throw error
      }
      if (imgCount !== 0) record(`admit base() 成功 → 返回 ${Array.isArray(admitted) ? admitted.length : typeof admitted} 项`)
      try {
        // ★ 不 await：算缓存是旁路。这里只发起，结果自己 catch。
        warmup(content, getWire, logger)
      } catch (error) {
        log(`会话视觉层旁路出错（不影响消息）：${describeError(error)}`)
        record(`warmup 同步抛：${describeError(error)}`)
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

  // ★ 装上是**成功**，但必须留痕 —— 没有这条，生产侧就分不清
  //   「装上了」和「静默 return false」（测试里靠 isWrapped 区分，生产没那个口子）。
  try { logger?.info?.('fish-world: 会话视觉层已装上（粘图会算进视觉缓存）') } catch {}
  record('装配成功：admitPromptContent 已包装（粘图会算进视觉缓存）')
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
  const info = (msg) => { try { logger?.info?.('fish-world: 会话视觉层 → ' + msg) } catch {} }
  const total = (Array.isArray(content) ? content : []).length
  try {
    const wire = typeof getWire === 'function' ? getWire() : null
    // 没绑工作区 → 没有缓存落点，直接放弃（vision-wire 也返回 null，不猜路径）
    if (!wire || !wire.input || typeof wire.input.ingest !== 'function') {
      const msg = `warmup: wire=null（parts=${total}）—— 世界根没绑定？视觉输入/缓存 不会出现`
      info(msg); record(msg)
      return
    }

    // ★ 过滤必须在**原始 part** 上做：`fromSession` 归一后只留 {bytes,name}，
    //   不保留 mediaType —— 拿归一后的结果去滤动图是死代码（实测 gif 照样进来）。
    const parts = (Array.isArray(content) ? content : []).filter((part) => {
      if (!part || part.type !== 'image') return false
      const media = String(part.mediaType || '').toLowerCase()
      return !SKIP_MEDIA.has(media)
    }).slice(0, MAX_PER_MESSAGE)
    if (!parts.length) {
      const msg = `warmup: 有 wire 但没可算的图（parts=${total}）—— 动图被跳过？还是没有 image 块？`
      info(msg); record(msg)
      return
    }

    // ★ 先把 part 的**真实形状**记下来（不打 base64 本身，只打类型与长度）。
    //   我踩过：复现时用 `{type:'image', data:<base64 string>, mediaType}` 成功，
    //   生产却 0/1 —— 差异只可能在宿主给的形状上（data 不是 string 就会被
    //   fromSession 的 `if (!data) continue` 跳过，于是连 normalizeFile 都不走、
    //   目录都不建，和观察到的现象一致）。不记形状就只能靠猜。
    const shapes = parts.map((p) => {
      const d = p.data
      const dInfo = d == null ? 'null' : `${Array.isArray(d) ? 'array' : typeof d}(${String(d).length})`
      return `${p.type}|mediaType=${p.mediaType ?? '-'}|name=${p.name ?? '-'}|data=${dInfo}`
    })
    record(`warmup: parts 形状 → ${shapes.join(' ｜ ')}`)

    // ★ focus 留空 = 通用描述。另两个入口（QQ / 桌面）也用空 focus，
    //   口径一致才撞得到同一个缓存键 —— 方案 §三「各平台共用同一格式」。
    const r = await wire.input.ingest('session', parts, { focus: '' })
    const ok = (r.results || []).filter((x) => x && x.result).length
    // ★ 要把**失败原因**打出来：`ingest` 不抛，归一化/管线的错都塞在
    //   files[].error / results[].error 里。我第一版只数成功的张数，
    //   于是日志只有「算完 0/1 张」而看不到为什么 —— 排查时等于没留痕。
    const why = []
    for (const f of r.files || []) if (f && f.ok === false) why.push('归一化失败：' + f.error)
    for (const x of r.results || []) if (x && x.error) why.push('管线失败：' + x.error)
    const msg = `warmup: 算完 ${ok}/${parts.length} 张  inputDir=${wire.inputDir}`
      + (why.length ? `  失败原因 → ${why.slice(0, 3).join(' ｜ ')}` : '')
    info(msg); record(msg)
  } catch (error) {
    const msg = `warmup: 失败（不影响消息）：${describeError(error)}`
    record(msg)
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
