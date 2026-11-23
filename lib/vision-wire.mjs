// 视觉管线的共享装配（2026-11-22 主人方案 P3）。
//
// ── 为什么要有这一层 ──
// 「一次算过到处可用」的前提是**所有入口拿到的是同一个管线实例、同一份缓存**。
// 如果每个平台各自 `createVision({root, recognize})`，缓存文件虽然还在磁盘上，
// 但 model 版本串、看图通道、失败计数各是各的 —— 等于没共用。
//
// 这一层只做两件事：
//   1. 按世界根**记一份**（世界根变了就重建，旧实例丢掉）
//   2. 把 omni 后端 + 三个平台适配器一次装好，交出去就能用
//
// ── 为什么不直接在 index.js 里装配 ──
// 装配点在 index.js，但**用它的地方在 qq-inbox / stickers 等子模块**。
// 子模块要能自己拿到实例，又不能互相 import 对方 —— 所以集中在这里，
// 谁需要谁来取。等 index.js 空出来接线时，那边也只是调这一个函数。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createVision } from './vision.mjs'
import { createOmniRecognize } from './vision-omni.mjs'
import { createVisionInput } from './vision-input.mjs'
import { registerMainPlatforms } from './vision-platforms.mjs'
import { FISH_WORLD_CONFIG } from './paths.mjs'
import { readStickerVisionSecret } from './sticker-vision.mjs'

/** 归一化落盘目录名（世界根下面，和视觉缓存同级）。 */
export const INPUT_FOLDER = '视觉输入'

/**
 * 没有显式 `describe` 时，从 `stickerVision` 配置**构造**一个纯文本看图通道。
 *
 * ── 为什么从配置读而不是注入 ──
 * 调用方（qq-inbox / stickers / index.js）都拿不到注入了 `configStore` 的那个对象，
 * 而配置本来就是落盘的（面板改完 `saveConfig` 写 `fish-world-config.json`）——
 * 这里直接读文件，**一处配置两处用**：开一次 `stickerVision`，表情整理与视觉管线都通。
 *
 * ── 与 sticker-vision 的 describe 是两回事，别混 ──
 * 那个返回**结构化 JSON**（name/tags/note，整理要往账本里写字段）；
 * 这里要的是**一句纯文本**（进上下文给模型看）。底层调用一样（OpenAI 兼容
 * `/chat/completions` + `image_url` base64），所以只复用**密钥读取**
 * （`readStickerVisionSecret` —— 密钥只落盘一处，不许再开第二个口子）。
 *
 * 没开 / 缺 baseUrl 或 model / 密钥读不到 ⇒ 返回 undefined（管线如实报「没接看图通道」）。
 *
 * @param {object} [logger]
 * @returns {((file:string, opts?:object) => Promise<{text:string}>)|undefined}
 */
function channelFromConfig(logger) {
  let cfg = {}
  try {
    const raw = JSON.parse(readFileSync(FISH_WORLD_CONFIG, 'utf8'))
    cfg = raw && typeof raw.stickerVision === 'object' ? raw.stickerVision : {}
  } catch { return undefined }            // 配置文件读不到 = 没配
  if (cfg.enabled !== true) return undefined
  const baseUrl = String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
  const model = String(cfg.model || '').trim()
  if (!baseUrl || !model) return undefined

  let key = ''
  try { key = readStickerVisionSecret().key || '' } catch { return undefined }
  const timeout = Number(cfg.timeoutMs) || 30000
  const url = baseUrl + '/chat/completions'
  try { logger?.info?.(`fish-world: 视觉管线接上看图通道（${model} @ ${baseUrl}）`) } catch {}

  return async (file, opts) => {
    const b64 = readFileSync(file).toString('base64')
    const low = String(file).toLowerCase()
    const media = low.endsWith('.jpg') || low.endsWith('.jpeg') ? 'jpeg' : low.endsWith('.gif') ? 'gif' : 'png'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: String((opts && opts.focus) || '用一句中文描述这张图，80 字以内。') },
            { type: 'image_url', image_url: { url: `data:image/${media};base64,${b64}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) throw new Error(`看图通道 HTTP ${res.status}（${url}）`)
    const body = await res.json()
    const content = body && body.choices && body.choices[0] && body.choices[0].message
      ? body.choices[0].message.content : ''
    return { text: Array.isArray(content) ? content.map((p) => (p && p.text) || '').join('') : String(content || '') }
  }
}

/**
 * 记住每个世界根对应的实例。
 *
 * ★ 按世界根分而不是全局单例：换工作区 = 换一份缓存与一份失败计数，
 *   共用一个实例会把 A 工作区的「这个文件识别不了」带到 B 工作区去。
 */
const byRoot = new Map()

/**
 * 取（或建）某个世界根下的视觉管线。
 *
 * @param {object} opts
 * @param {string} [opts.worldRoot] 世界根；没绑定工作区时返回 null（**不猜默认路径**）
 * @param {string} [opts.home]      DSH_HOME（给 resolveDependency 定位 omni）
 * @param {string} [opts.profile]   profile 名
 * @param {object} [opts.config]    omni 插件配置 { ffmpegPath, pythonPath, asr }
 * @param {Function} [opts.describe] 看图通道（omni 不看图，要调用方给）
 * @param {object} [opts.logger]
 * @param {boolean} [opts.forget]   true = 丢掉已记的实例，下次重建（配置变了用）
 * @returns {{vision:object, input:object, backend:object}|null}
 */
export function getVisionWire({
  worldRoot,
  home,
  profile,
  config,
  describe,
  logger,
  forget = false
} = {}) {
  const root = String(worldRoot || '').trim()
  // 没绑定工作区就没有缓存落点 —— 如实返回 null，调用方据此跳过，不写死一个默认目录。
  if (!root) return null

  if (forget) byRoot.delete(root)

  // ★ 看图通道：显式传的优先；没传就从 stickerVision 配置构造（开一次两处用）。
  //   两者都没有 ⇒ 后端没有 describe，管线会如实报「没接看图通道」，不假装看懂。
  const 看图 = typeof describe === 'function' ? describe : channelFromConfig(logger)

  const cached = byRoot.get(root)
  // 看图通道换了、omni 配置换了都要重建 —— 否则拿到的是旧后端。
  // ★ 必须用 channelStamp（配置指纹）而不是 describeStamp(看图)：
  //   describeStamp 取的是**函数源码**，不含闭包里的 baseUrl/model ——
  //   主人在面板改了配置，源码字符串一模一样 ⇒ stamp 不变 ⇒ 拿到旧实例、新配置不生效。
  const stamp = describeStamp(describe) + '|' + channelStamp() + '|' + configStamp(config)
  if (cached && cached.stamp === stamp) return cached.wire

  const backend = createOmniRecognize({
    ...(home ? { home } : {}),
    ...(profile ? { profile } : {}),
    ...(config ? { config } : {}),
    ...(typeof 看图 === 'function' ? { describe: 看图 } : {}),
    ...(logger ? { logger } : {}),
    gridDir: join(root, INPUT_FOLDER, '宫格')
  })

  const vision = createVision({
    root,
    recognize: backend,
    model: backend.modelVersion(),
    ...(logger ? { logger } : {})
  })

  const input = createVisionInput({
    vision,
    inputDir: join(root, INPUT_FOLDER),
    ...(logger ? { logger } : {})
  })
  // 三个主平台一次性登记；再要加平台，调用方自己 input.register(...)。
  registerMainPlatforms(input)

  const wire = { vision, input, backend, inputDir: join(root, INPUT_FOLDER) }
  byRoot.set(root, { stamp, wire })
  return wire
}

/** 看图通道的指纹：换了一个函数就当换了一套后端。 */
function describeStamp(describe) {
  if (typeof describe !== 'function') return 'none'
  // 函数体当指纹够用了（同名不同实现会变），比存引用更耐得住模块重载。
  try { return String(describe).slice(0, 200) } catch { return 'fn' }
}

function configStamp(config) {
  if (!config) return ''
  try {
    const asr = config.asr || {}
    return [config.ffmpegPath, config.pythonPath, asr.mode, asr.localModel].join(',')
  } catch { return 'cfg' }
}

/**
 * 看图通道的**配置指纹**（不是函数指纹）。
 *
 * ★ 为什么不能用 `describeStamp(看图)`：那个取函数**源码**，而 `channelFromConfig`
 *   返回的箭头函数源码里**不含闭包的 baseUrl/model** —— 主人在面板改了配置，
 *   源码字符串一模一样 ⇒ stamp 不变 ⇒ 命中旧 wire ⇒ **新配置不生效**（静默失效）。
 *   这里读配置本身当指纹，改了就重建。
 */
function channelStamp() {
  try {
    const raw = JSON.parse(readFileSync(FISH_WORLD_CONFIG, 'utf8'))
    const c = raw && typeof raw.stickerVision === 'object' ? raw.stickerVision : {}
    if (c.enabled !== true) return 'off'
    return ['on', String(c.baseUrl || ''), String(c.model || ''), String(c.timeoutMs || '')].join('|')
  } catch { return 'noconf' }
}

/** 排查用：现在记着几个世界根（面板/日志）。 */
export function wiredRoots() {
  return [...byRoot.keys()]
}

/** 世界根换了配置时清干净（测试与热更新用）。 */
export function forgetVisionWire(worldRoot) {
  if (worldRoot == null) { byRoot.clear(); return }
  byRoot.delete(String(worldRoot))
}
