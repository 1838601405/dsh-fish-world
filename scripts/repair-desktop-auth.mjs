// 修 DSH 桌面端的「启动即崩」循环。
//
// 背景（实测，不是推测）：
//   桌面端每次启动都会往 Chromium 的 Cookie 库里写一条 `dsh-auth-*`，
//   host 是 127.0.0.1，**值是空的**（encrypted_value 长度 0），
//   而且 **is_persistent = 1** —— 空的但持久，所以永远不会被自动清掉。
//   攒到一定条数后，桌面端就无法再认证自己的本机服务，启动即退出：
//     desktop welcome: Web authentication failed
//   本机实测攒到 71 条时崩，清理后恢复。
//
// 为什么只删本机回环是安全的：
//   DeepSeek 账号凭据不在这些行里。这里只动 host_key 属于
//   127.0.0.1 / localhost / ::1 三类（桌面端自己跟自己握手用的凭据）。
//
// 两种用法：
//   1) 一次性修（DSH 已退出）：npm run repair:auth
//   2) 每次启动前自动清（防复发）：npm run auth:watchdog
//      看门狗只在一个可执行文件上挂着，见 scripts/auth-watchdog.mjs。
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']

/** 残留到多少条就该清了：留一点余量，别等攒到崩的那天才清。 */
export const STALE_THRESHOLD = 20

export function desktopCookieDb(appDataDir = process.env.APPDATA) {
  if (!appDataDir) return ''
  return join(appDataDir, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

/** 读一次（不改）；返回条数。数据库被占用时给出可读的原因，不抛。 */
export async function countLoopbackCookies({ appDataDir = process.env.APPDATA } = {}) {
  const file = desktopCookieDb(appDataDir)
  if (!file || !existsSync(file)) return { ok: true, skipped: 'cookies-db-missing', file, count: 0 }
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return { ok: false, skipped: 'node:sqlite-unavailable', file, count: 0 }
  }
  let db
  try {
    db = new DatabaseSync(file)
  } catch (error) {
    return { ok: false, skipped: 'cookies-db-locked', file, count: 0, error: String(error?.message || error) }
  }
  try {
    const placeholders = LOOPBACK_HOSTS.map(() => '?').join(',')
    const count = Number(db.prepare(`select count(*) as n from cookies where host_key in (${placeholders})`).get(...LOOPBACK_HOSTS)?.n || 0)
    return { ok: true, file, count }
  } catch (error) {
    return { ok: false, file, count: 0, error: String(error?.message || error) }
  } finally {
    try { db.close() } catch {}
  }
}

export async function repairDesktopAuth({ appDataDir = process.env.APPDATA, logger = console, dryRun = false, backup = true } = {}) {
  const file = desktopCookieDb(appDataDir)
  if (!file || !existsSync(file)) return { ok: true, skipped: 'cookies-db-missing', file, removed: 0 }
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return { ok: false, skipped: 'node:sqlite-unavailable', file, removed: 0 }
  }
  let db
  try {
    db = new DatabaseSync(file)
  } catch (error) {
    return { ok: false, skipped: 'cookies-db-locked', file, removed: 0, error: `请先完整退出 DSH 再运行：${error?.message || error}` }
  }
  try {
    const placeholders = LOOPBACK_HOSTS.map(() => '?').join(',')
    const before = Number(db.prepare(`select count(*) as n from cookies where host_key in (${placeholders})`).get(...LOOPBACK_HOSTS)?.n || 0)
    if (dryRun || before === 0) return { ok: true, file, removed: 0, found: before, dryRun: Boolean(dryRun) }
    let backupFile = ''
    if (backup) {
      try {
        backupFile = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
        copyFileSync(file, backupFile)
      } catch { backupFile = '' }
    }
    // 必须用 prepare().run() 绑定参数：db.exec() 不支持占位符，
    // `in (?,?,?,?)` 在未绑定时按 NULL 比较、永远为假 —— 真实教训：
    // 旧实现删了个寂寞却报「已清理 N 条」（N 来自前置 count），
    // 直到 2026-10-26 补测试才暴露。removed 以 SQLite 报告的 changes 为准。
    const deleted = db.prepare(`delete from cookies where host_key in (${placeholders})`).run(...LOOPBACK_HOSTS)
    const removed = Number(deleted?.changes ?? 0)
    let vacuumed = false
    try { db.exec('vacuum'); vacuumed = true } catch {}
    logger.info?.(`✔ 已清理 ${removed} 条本机启动残留 Cookie${backupFile ? `（备份：${backupFile}）` : ''}`)
    return { ok: true, file, removed, backupFile, vacuumed }
  } catch (error) {
    return { ok: false, file, removed: 0, error: String(error?.message || error) }
  } finally {
    try { db.close() } catch {}
  }
}

/**
 * 给看门狗用：**只在超过阈值时清**，并且不要每次都留备份
 * （看门狗会天天跑，每次几十 MB 的备份最后会把磁盘塞满）。
 * 返回 removed 条数；没到阈值就什么都不做。
 */
export async function pruneIfStale({ appDataDir = process.env.APPDATA, logger = console, threshold = STALE_THRESHOLD } = {}) {
  const counted = await countLoopbackCookies({ appDataDir })
  if (!counted.ok) return { ok: false, skipped: counted.skipped, count: counted.count, removed: 0, error: counted.error }
  if (counted.count < threshold) return { ok: true, count: counted.count, removed: 0, below: true }
  const result = await repairDesktopAuth({ appDataDir, logger, backup: false })
  return { ...result, count: counted.count }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const check = process.argv.includes('--check')
  if (check) {
    const c = await countLoopbackCookies()
    if (!c.ok) console.error(`✖ 读不出来：${c.error || c.skipped}`)
    else console.log(`本机回环 Cookie ${c.count} 条（阈值 ${STALE_THRESHOLD} 条）`)
    process.exitCode = c.ok ? 0 : 1
  } else {
    const result = await repairDesktopAuth()
    if (!result.ok) {
      console.error(`✖ 修复失败：${result.error || result.skipped}`)
      process.exitCode = 1
    } else if (result.skipped) {
      console.log(`· 跳过：${result.skipped}`)
    } else if (result.removed === 0) {
      console.log('· 没有需要清理的启动残留 Cookie')
    }
  }
}
