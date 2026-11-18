// 排障页安全模型（herframe 设计移植）。
//
// 三条规则：
//   1. **默认锁**：排障接口一律 423（Locked），不是 403 —— 423 表示「存在但要先解锁」，
//      403 表示「你没有权限」。排障页属于前者，主人自己解锁就能用。
//   2. **登记理由后解锁 30 分钟**：解锁必须给理由（为什么现在要看），
//      理由进审计。到点自动回封，不用手动关。
//   3. **审计写 UI 自己的数据根**，不写鱼的库（`鱼的记忆/` 之类）。
//      排障是「人看系统」的行为，不该混进她的生活记录里。
//
// ★ 为什么不是 403：423 是「可解锁的资源」，403 是「永远别想」。
//   排障数据是主人自己的东西，锁只是防止误触/误分享，不是权限边界。

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** 解锁有效期：30 分钟。 */
export const UNLOCK_MS = 30 * 60 * 1000

/** 状态码：存在但未解锁。 */
export const HTTP_LOCKED = 423

/**
 * @param {object} opts
 * @param {string} opts.uiRoot  审计落点（UI 自己的数据根，不是世界根）
 * @param {() => number} [opts.now]
 */
export function createDebugGate({ uiRoot, now = () => Date.now() } = {}) {
  /** 解锁到期时刻；0 = 锁着。 */
  let unlockedUntil = 0
  /** 最近一次解锁的理由（给界面显示「为什么现在开着」）。 */
  let lastReason = ''
  let lastReasonAt = 0

  function auditDir() {
    const root = String(uiRoot || '').trim()
    if (!root) return ''
    return join(root, '排障')
  }

  function audit(file, entry) {
    const dir = auditDir()
    if (!dir) return false
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, file), JSON.stringify(entry) + '\n', 'utf8')
      return true
    } catch {
      return false
    }
  }

  function log(line) {
    audit('审计.jsonl', { at: new Date(now()).toISOString(), kind: 'log', line })
  }

  /** 当前状态：locked / unlocked，剩余秒数，理由。 */
  function status() {
    const at = now()
    const left = Math.max(0, unlockedUntil - at)
    return {
      locked: left <= 0,
      remainingMs: left,
      remainingSec: Math.ceil(left / 1000),
      reason: left > 0 ? lastReason : '',
      reasonAt: left > 0 ? new Date(lastReasonAt).toISOString() : '',
      unlockSeconds: Math.round(UNLOCK_MS / 1000)
    }
  }

  /**
   * 解锁。**必须给理由**（空理由拒绝）。
   * 返回 {ok, status} 或 {ok:false, error}。
   */
  function unlock(reason) {
    const text = String(reason == null ? '' : reason).trim()
    if (text.length < 2) return { ok: false, error: '解锁要给理由（至少两个字）：为什么现在要看' }
    if (text.length > 200) return { ok: false, error: '理由太长（上限 200 字）' }
    const at = now()
    unlockedUntil = at + UNLOCK_MS
    lastReason = text
    lastReasonAt = at
    audit('审计.jsonl', {
      at: new Date(at).toISOString(),
      kind: 'unlock',
      reason: text,
      until: new Date(unlockedUntil).toISOString()
    })
    return { ok: true, status: status() }
  }

  /** 手动回封（到期会自动回封，这里给「我现在不想看了」用）。 */
  function lock(why = '') {
    const at = now()
    const was = unlockedUntil > at ? '解锁中' : '本来就锁着'
    unlockedUntil = 0
    audit('审计.jsonl', {
      at: new Date(at).toISOString(),
      kind: 'lock',
      was,
      note: String(why || '').slice(0, 200)
    })
    return { ok: true, status: status() }
  }

  /**
   * 闸门：给排障路由用。
   * 返回 null = 放行；返回 {code, body} = 直接回给客户端。
   *
   * ★ 423 的响应体要说清「怎么解锁」，否则主人只看到「锁着」不知道下一步。
   */
  function guard() {
    const st = status()
    if (!st.locked) return null
    return {
      code: HTTP_LOCKED,
      body: {
        ok: false,
        locked: true,
        error: '排障页锁着：先登记理由再解锁',
        hint: 'POST 本路径 {reason:"..."} 解锁，' + Math.round(UNLOCK_MS / 60000) + ' 分钟后自动回封',
        unlockSeconds: st.unlockSeconds
      }
    }
  }

  /** 读审计（给界面看：什么时候谁解锁了、理由是什么）。 */
  function readAudit(limit = 50) {
    const dir = auditDir()
    if (!dir) return []
    const f = join(dir, '审计.jsonl')
    if (!existsSync(f)) return []
    try {
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, Math.min(500, limit))).map((line) => {
        try { return JSON.parse(line) } catch { return { raw: line } }
      })
    } catch {
      return []
    }
  }

  return { status, unlock, lock, guard, readAudit, log, UNLOCK_MS, HTTP_LOCKED }
}
