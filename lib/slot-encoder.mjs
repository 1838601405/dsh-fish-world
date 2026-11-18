// 槽的 encoder 解析：优先真 embedding（kb-vector 的 localModel 通道），
// **拿不到就直接报错**——不许静默退回 fallback-hash-512（主人 2026-11-18 P0-1 第 2 条）。
//
// 兜底 encoder 只剩一个用途：测试 / 离线回放时显式 opt-in（allowFallback:true），
// 且返回的 id 里带 fallback 字样，K 里也记得清清楚楚。
import { createEmbedder, normalizeConfig } from './kb-vector.mjs'
import { encodeFallback } from './slots.mjs'

export class EncoderUnavailable extends Error {
  constructor(reason) {
    super('没有可用的 embedding 模型：' + reason + '（不允许静默退回 fallback-hash-512）')
    this.name = 'EncoderUnavailable'
    this.reason = reason
  }
}

/** 本机默认的本地模型位置（kb-vector 的 localModel 通道就是这么找的）。 */
export function defaultLocalModel({ home = process.env.DSH_HOME || '' } = {}) {
  const dir = home ? `${home}/fish-world-models` : ''
  return {
    model: 'Xenova/bge-small-zh-v1.5',
    localDir: dir.replace(/\\/g, '/'),
    // 依赖装在 fish-world-models/deps 里（本机实测：@huggingface/transformers ^4.3.1）
    localModule: dir ? `${dir.replace(/\\/g, '/')}/deps/node_modules/@huggingface/transformers` : '',
    dtype: 'q8',
  }
}

function wrapEmbedder(emb) {
  let dim = Number(emb.dim) || 0
  const encode = async (text) => {
    const [vec] = await emb.embed([String(text || '')])
    const arr = Float32Array.from(vec)
    if (!dim) dim = arr.length
    return arr
  }
  return {
    id: String(emb.id || 'local'),
    get dim() {
      return dim
    },
    kind: 'embedding',
    async encode(text) {
      return await encode(text)
    },
    async encodeMany(texts) {
      const list = (Array.isArray(texts) ? texts : []).map((t) => String(t || ''))
      const out = await emb.embed(list)
      if (!dim && out[0]) dim = out[0].length
      return out.map((vec) => Float32Array.from(vec))
    },
  }
}

export function fallbackEncoder() {
  return {
    id: 'fallback-hash-512',
    dim: 512,
    kind: 'fallback',
    async encode(text) {
      return encodeFallback(text)
    },
    async encodeMany(texts) {
      return (Array.isArray(texts) ? texts : []).map((t) => encodeFallback(t))
    },
  }
}

/**
 * 解析 encoder。
 * 返回 { encoder, via, model, reason }
 *   via='embedding' 真模型；via='fallback' 只在你显式 allowFallback 时出现。
 * 真模型不可用且没 allowFallback → 抛 EncoderUnavailable（调用方要把它显式报出来）。
 */
export async function resolveSlotEncoder({
  home = process.env.DSH_HOME || '',
  config = null,
  allowFallback = false,
  dim = 512,
} = {}) {
  const local = defaultLocalModel({ home })
  const raw = config || {
    enabled: true,
    mode: 'local',
    localModel: local.model,
    localDir: local.localDir,
    localModule: local.localModule,
    localDtype: local.dtype,
  }
  const { config: cfg, problems, usable } = normalizeConfig(raw)
  if (!usable) {
    if (allowFallback) {
      return { encoder: fallbackEncoder(), via: 'fallback', model: '', reason: 'kb-vector 配置不可用：' + problems.join('；') }
    }
    throw new EncoderUnavailable('kb-vector 配置不可用：' + (problems.join('；') || 'enabled/mode 没开'))
  }
  try {
    const emb = await createEmbedder(cfg)
    if (!emb) throw new Error('createEmbedder 返回空')
    const wrapped = wrapEmbedder(emb)
    const probe = await wrapped.encode('探针')
    if (!probe || probe.length !== dim) {
      // 维度不对也算不可用：K 是 512 维，混进去余弦就没意义
      throw new Error('维度不符：期望 ' + dim + '，实际 ' + (probe ? probe.length : 0))
    }
    return { encoder: wrapped, via: 'embedding', model: wrapped.id, reason: '' }
  } catch (error) {
    const reason = String(error?.message || error)
    if (allowFallback) {
      return { encoder: fallbackEncoder(), via: 'fallback', model: '', reason }
    }
    throw new EncoderUnavailable(reason)
  }
}

/** 给面板/体检看：现在到底能不能用真模型。 */
export async function encoderStatus({ home = process.env.DSH_HOME || '', config = null } = {}) {
  try {
    const got = await resolveSlotEncoder({ home, config })
    return { ok: true, via: got.via, model: got.model, dim: got.encoder.dim }
  } catch (error) {
    return { ok: false, via: '', model: '', reason: String(error?.message || error) }
  }
}