// 跨平台心跳：谁在跑就算活。
//
// 问题（2026-11-20 主人指出）：
//   桌面版（Flutter）写 `%APPDATA%\大肥鱼\qq-heartbeat.json`，
//   插件版**不写** ⇒ 面板（鱼的世界新版）拿它当「她的心跳」时，
//   在插件模式下会一直显示「心跳停了」——误报。
//
// 两条路可选（主人给了）：
//   A. 插件也写同一个文件（谁跑都算活）
//   B. 面板按当前平台读对应来源
// 取 A + B 一起做：
//   · 插件写**同一个文件** ⇒ 已经装好的桌面版面板不用改就能看到（兼容旧版）；
//   · 同时写一份**平台标记**，面板能说清「现在是插件在跑」，而不是含糊地显示一个时间。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 心跳多久算「停了」：插件 tick 是 1 秒一次，容 15 分钟足够宽松。 */
export const HEARTBEAT_STALE_MS = 15 * 60 * 1000

/** 写心跳的间隔：比 tick 的频率低得多，够用且不频繁写盘。 */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000

/**
 * @param {object} opts
 * @param {string} opts.file  心跳文件路径（与桌面版同一个文件）
 * @param {() => number} [opts.now]
 * @param {(line:string)=>void} [opts.log]
 */
export function createHeartbeatWriter({ file, now = () => Date.now(), log } = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  let timer = null
  let lastWriteAt = 0
  let lastError = ''

  function path() {
    const p = String(file || '').trim()
    if (!p) return ''
    return p
  }

  /**
   * 写一次。**原子写在 Windows 上要小心**：
   * 桌面版和插件版可能同时存在（一个在写、一个在读），
   * 直接覆盖可能让对面读到半个文件 → JSON 解析失败 → 显示「心跳停了」。
   * 所以先写临时文件再 rename（同一分区上 rename 是原子的）。
   */
  function writeOnce(extra = {}) {
    const f = path()
    if (!f) return { ok: false, error: '没有心跳文件路径' }
    try {
      mkdirSync(dirname(f), { recursive: true })
      const at = now()
      const payload = {
        at: new Date(at).toISOString(),
        // ★ 新增：这个心跳是谁写的。旧面板只读 at，多一个字段不影响它。
        source: 'plugin',
        ...extra
      }
      const tmp = join(dirname(f), '.qq-heartbeat.' + process.pid + '.tmp')
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, f)
      lastWriteAt = at
      lastError = ''
      return { ok: true, at }
    } catch (error) {
      lastError = String(error?.message || error)
      // 写失败不能静默：否则面板显示「停了」而没人知道为什么。
      try { logger('心跳写入失败：' + lastError) } catch {}
      return { ok: false, error: lastError }
    }
  }

  /** 启动：立刻写一次（面板马上就能看到「插件活着」），之后定期写。 */
  function start() {
    stop()
    writeOnce()
    timer = setInterval(() => writeOnce(), HEARTBEAT_INTERVAL_MS)
    timer.unref?.()
    return { ok: true, intervalMs: HEARTBEAT_INTERVAL_MS }
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  /** 读回（给面板/排查用）。 */
  function status() {
    const f = path()
    const empty = { ok: true, exists: false, stale: true, atMs: 0, source: '', ageMs: -1, lastWriteAt, lastError }
    if (!f || !existsSync(f)) return empty
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      const atMs = Date.parse(String(raw?.at || '')) || 0
      const ageMs = atMs > 0 ? now() - atMs : -1
      return {
        ok: true,
        exists: true,
        stale: !(ageMs >= 0 && ageMs <= HEARTBEAT_STALE_MS),
        atMs,
        source: String(raw?.source || 'desktop'),
        ageMs,
        lastWriteAt,
        lastError
      }
    } catch (error) {
      return { ...empty, ok: false, exists: true, error: String(error?.message || error) }
    }
  }

  return { start, stop, writeOnce, status, HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS }
}

/** 默认心跳文件位置：与桌面版同一个文件（%APPDATA%\大肥鱼\qq-heartbeat.json）。 */
export function defaultHeartbeatFile(home = '') {
  const appData = String(process.env.APPDATA || '').trim()
  if (appData) return join(appData, '大肥鱼', 'qq-heartbeat.json')
  const h = String(home || process.env.USERPROFILE || '.').trim()
  return join(h, '大肥鱼', 'qq-heartbeat.json')
}
