import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'fish-world-model.json'

function pathOf(home) { return join(home || process.env.DSH_HOME || '', FILE) }
function env(name, fallback = '') { try { return String(process.env[name] || fallback).trim() } catch { return fallback } }

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
}

export function readModelConfig({ home = process.env.DSH_HOME || '' } = {}) {
  const saved = readJson(pathOf(home))
  return {
    baseUrl: env('DSH_FISH_MODEL_BASE_URL', String(saved.baseUrl || '')).replace(/\/+$/, ''),
    model: env('DSH_FISH_MODEL_MODEL', String(saved.model || '')),
    hasKey: Boolean(env('DSH_FISH_MODEL_API_KEY', String(saved.apiKey || ''))),
    source: env('DSH_FISH_MODEL_API_KEY') ? 'env' : (saved.apiKey ? 'file' : 'none'),
  }
}

export function saveModelConfig({ home = process.env.DSH_HOME || '', baseUrl, model, apiKey } = {}) {
  const file = pathOf(home)
  const old = readJson(file)
  const next = {
    baseUrl: String(baseUrl == null ? old.baseUrl || '' : baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(model == null ? old.model || '' : model || '').trim(),
    apiKey: apiKey == null || String(apiKey) === '' ? String(old.apiKey || '') : String(apiKey),
  }
  writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  return readModelConfig({ home })
}

function endpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('还没配置模型 API 地址')
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions'
}

export async function chatWithModel({ home = process.env.DSH_HOME || '', messages, system } = {}) {
  const cfg = readModelConfig({ home })
  if (!cfg.baseUrl) throw new Error('还没配置模型 API 地址')
  const key = env('DSH_FISH_MODEL_API_KEY', '') || readJson(pathOf(home)).apiKey || ''
  const list = Array.isArray(messages) ? messages : []
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages: [
      ...(system ? [{ role: 'system', content: String(system) }] : []),
      ...list.filter((m) => m && m.role && m.content).map((m) => ({ role: String(m.role), content: String(m.content) })),
    ],
    stream: false,
  }
  const res = await fetch(endpoint(cfg.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  if (!res.ok) throw new Error('模型 API ' + res.status + '：' + (data?.error?.message || text.slice(0, 200)))
  const reply = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.reply || ''
  if (!String(reply).trim()) throw new Error('模型 API 返回了空回复')
  return { ok: true, reply: String(reply), model: cfg.model || '' }
}
