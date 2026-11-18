// 换 encoder 的全库重建：两阶段（写 next → 校验 → 原子换），旧版本在重建期仍可查。
//
// 规格第 8 节：换 encoder → 全库重建，kVersion 升号，重建期读旧版。
// 这里**不做静默重建**：槽表损坏直接报错（createSlotStore 已经这么做了）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILES } from './slots.mjs'

function quantizeVec(vec) {
  let max = 0
  for (const v of vec) max = Math.max(max, Math.abs(v))
  const scale = max ? 127 / max : 1
  const q = Array.from(vec, (v) => Math.max(-127, Math.min(127, Math.round(v * scale))))
  return { q, scale }
}

/**
 * 重建 K 表向量。
 * 返回 { ok, from, to, count, kVersion, backup }
 *   · from：旧 encoder 名（重建前）
 *   · backup：旧表备份路径（回滚用）
 */
export async function reindexSlots({ store, encoder, kVersion = 0 } = {}) {
  if (!store || typeof store.loadK !== 'function') throw new Error('reindexSlots 需要 store')
  if (!encoder || typeof encoder.encode !== 'function') throw new Error('reindexSlots 需要 encoder')

  const old = store.loadK()
  if (!old.length) return { ok: true, from: null, to: encoder.id, count: 0, kVersion: Number(kVersion) || 1, backup: '' }

  const from = String(old[0].encoder || '(unknown)')
  const nextKVersion = Number(kVersion) || Math.max(...old.map((s) => Number(s.kVersion) || 1)) + 1

  const rebuilt = []
  for (const slot of old) {
    const text = [slot.semantic, slot.response, ...(slot.trigger || []), ...Object.values(slot.tags || {})].join(' ')
    const vec = await encoder.encode(text)
    rebuilt.push({ ...slot, vec: quantizeVec(vec), encoder: encoder.id, kVersion: nextKVersion })
  }

  const base = store.base
  const nextFile = join(base, '槽表.next.json')
  const liveFile = join(base, FILES.k)
  const prevFile = join(base, '槽表.prev.json')
  mkdirSync(base, { recursive: true })

  // 1) 写 next（不覆盖正在用的表）
  writeFileSync(nextFile, JSON.stringify(rebuilt, null, 2), 'utf8')
  // 2) 校验：读回来条数必须一致，不一致就不换
  const parsed = JSON.parse(readFileSync(nextFile, 'utf8'))
  if (parsed.length !== rebuilt.length) throw new Error('重建校验失败：条数不一致（' + parsed.length + ' vs ' + rebuilt.length + '）')

  // 3) 原子换：旧表留成 prev（回滚），next 变成正式表
  if (existsSync(liveFile)) {
    if (existsSync(prevFile)) rmSync(prevFile)
    renameSync(liveFile, prevFile)
  }
  renameSync(nextFile, liveFile)

  return { ok: true, from, to: encoder.id, count: rebuilt.length, kVersion: nextKVersion, backup: existsSync(prevFile) ? prevFile : '' }
}

/** 回滚：把 prev 换回去（重建之后发现不对，一条命令退回）。 */
export function rollbackReindex({ store } = {}) {
  const base = store.base
  const liveFile = join(base, FILES.k)
  const prevFile = join(base, '槽表.prev.json')
  if (!existsSync(prevFile)) return { ok: false, reason: '没有可回滚的旧表' }
  if (existsSync(liveFile)) rmSync(liveFile)
  renameSync(prevFile, liveFile)
  return { ok: true, restored: liveFile }
}