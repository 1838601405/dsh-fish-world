// 本地小模型 runner：入库管道（接内容 → 标话题 → 摘要 → 消歧）用它，宿主只负责最终对话生成。
//
// 两个后端，按优先级：
//   1. 进程内 @huggingface/transformers 的 text-generation（复用 kb-vector 那套
//      localModule / localDir / 模型名配置口径）；
//   2. 本机 OpenAI 兼容端点（只认 loopback —— 这是「本地」，不是把内容发去云端）。
// 两个都不可用就如实回 { ok:false, reason }，调用方退回确定性规则并标 via:'fallback'，
// **绝不假装本地模型跑过了**。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'
import { readModelConfig } from './model-api.mjs'

const LOCAL_LIB = '@huggingface/transformers'
const LOOPBACK = /^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i

function absPath(value) {
  const text = String(value == null ? '' : value).trim()
  return text && /^[a-zA-Z]:[\\/]/.test(text) ? text : ''
}

/** 从 kb-vector 的配置里取本地模型口径（model / localModule / localDir / dtype）。 */
export function localConfigOf(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    model: String(src.ingestModel || src.localModel || 'Qwen/Qwen3.5-4B-Instruct').trim(),
    localModule: String(src.localModule || '').trim(),
    localDir: absPath(src.localDir) || join(DSH_HOME, 'fish-world-models'),
    dtype: String(src.localDtype || 'q4').trim(),
    maxTokens: Math.min(1024, Math.max(32, Number(src.ingestMaxTokens) || 256)),
    timeoutMs: Math.min(120000, Math.max(2000, Number(src.ingestTimeoutMs) || 30000)),
  }
}

/**
 * 建一个本地 runner。
 * 返回 { ok, via, reason, generate(prompt, opts) }：
 *   · via='transformers' 进程内；
 *   · via='loopback' 本机 OpenAI 兼容端点；
 *   · ok:false 时 generate 调用会抛错，调用方自己退回 fallback。
 */
export async function createLocalRunner({ config = {}, home = DSH_HOME, loadLibrary = null } = {}) {
  const cfg = localConfigOf(config)

  // ① 进程内 transformers
  try {
    let lib = null
    if (typeof loadLibrary === 'function') lib = await loadLibrary(cfg)
    else lib = await importTransformer(cfg)
    if (lib && typeof lib.pipeline === 'function') {
      if (lib.env) {
        lib.env.cacheDir = cfg.localDir
        lib.env.allowLocalModels = true
      }
      const pipe = await lib.pipeline('text-generation', cfg.model, { dtype: cfg.dtype })
      return {
        ok: true,
        via: 'transformers',
        reason: '',
        model: cfg.model,
        async generate(prompt, { maxTokens = cfg.maxTokens } = {}) {
          const out = await pipe(prompt, { max_new_tokens: maxTokens, do_sample: false })
          const first = Array.isArray(out) ? out[0] : out
          const text = first && typeof first === 'object'
            ? (first.generated_text || first.text || '')
            : String(first || '')
          // 有的后端会把 prompt 一起回显，切掉。
          return String(text).startsWith(prompt) ? String(text).slice(prompt.length).trim() : String(text).trim()
        },
      }
    }
  } catch (error) {
    const reason = String(error?.message || error)
    // 库在但模型没下：把它当成不可用，继续试 loopback
    if (!/loopback/i.test(reason)) {
      const fallback = loopbackRunner(cfg, home)
      if (fallback.ok) return fallback
      return { ok: false, via: '', reason: '进程内本地模型不可用：' + reason, model: cfg.model }
    }
  }

  const fallback = loopbackRunner(cfg, home)
  if (fallback.ok) return fallback
  return {
    ok: false,
    via: '',
    reason: '没有可用的本地模型：' + (fallback.reason || '既没装 ' + LOCAL_LIB + '，也没有本机 OpenAI 兼容端点'),
    model: cfg.model,
  }
}

async function importTransformer(cfg) {
  const spec = cfg.localModule || LOCAL_LIB
  return await import(spec)
}

/** 本机 OpenAI 兼容端点（Ollama / LM Studio 之类）。只认 loopback。 */
function loopbackRunner(cfg, home) {
  const mc = readModelConfig({ home })
  if (!mc.baseUrl || !/^https?:\/\//i.test(mc.baseUrl)) return { ok: false, reason: '没有配置本机模型端点' }
  if (!LOOPBACK.test(mc.baseUrl)) return { ok: false, reason: '配置的模型地址不是本机（' + mc.baseUrl + '）' }
  return {
    ok: true,
    via: 'loopback',
    reason: '',
    model: mc.model || cfg.model,
    async generate(prompt, { maxTokens = cfg.maxTokens } = {}) {
      const res = await fetch(mc.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: mc.model || cfg.model,
          temperature: 0,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      })
      if (!res.ok) throw new Error('本机模型返回 ' + res.status)
      const body = await res.json()
      return String(body?.choices?.[0]?.message?.content || '').trim()
    },
  }
}

/** 本地模型目录里有没有这个模型的权重（给体检/面板看）。 */
export function modelCached({ model = '', localDir = '' } = {}) {
  if (!model || !localDir) return false
  return existsSync(join(localDir, ...String(model).split('/')))
}