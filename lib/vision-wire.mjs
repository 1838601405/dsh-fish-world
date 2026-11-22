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

import { join } from 'node:path'

import { createVision } from './vision.mjs'
import { createOmniRecognize } from './vision-omni.mjs'
import { createVisionInput } from './vision-input.mjs'
import { registerMainPlatforms } from './vision-platforms.mjs'

/** 归一化落盘目录名（世界根下面，和视觉缓存同级）。 */
export const INPUT_FOLDER = '视觉输入'

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

  const cached = byRoot.get(root)
  // 看图通道换了、omni 配置换了都要重建 —— 否则拿到的是旧后端。
  const stamp = describeStamp(describe) + '|' + configStamp(config)
  if (cached && cached.stamp === stamp) return cached.wire

  const backend = createOmniRecognize({
    ...(home ? { home } : {}),
    ...(profile ? { profile } : {}),
    ...(config ? { config } : {}),
    ...(typeof describe === 'function' ? { describe } : {}),
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

/** 排查用：现在记着几个世界根（面板/日志）。 */
export function wiredRoots() {
  return [...byRoot.keys()]
}

/** 世界根换了配置时清干净（测试与热更新用）。 */
export function forgetVisionWire(worldRoot) {
  if (worldRoot == null) { byRoot.clear(); return }
  byRoot.delete(String(worldRoot))
}
