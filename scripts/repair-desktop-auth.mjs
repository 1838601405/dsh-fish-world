// Repair the DSH desktop launch loop.
//
// Every desktop launch stores one short-lived `dsh-auth-*` cookie for
// 127.0.0.1 in Chromium's cookie database. Stale entries accumulate (one per
// launch) until the desktop shell can no longer authenticate against its own
// local host and aborts with:
//   desktop welcome: Web authentication failed
// Removing only the loopback cookies is safe: the DeepSeek account credential
// lives elsewhere, so no login data is touched.
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']

export function desktopCookieDb(appDataDir = process.env.APPDATA) {
  if (!appDataDir) return ''
  return join(appDataDir, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
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
    db.exec(`delete from cookies where host_key in (${placeholders})`)
    let vacuumed = false
    try { db.exec('vacuum'); vacuumed = true } catch {}
    logger.info?.(`✔ 已清理 ${before} 条本机启动残留 Cookie${backupFile ? `（备份：${backupFile}）` : ''}`)
    return { ok: true, file, removed: before, backupFile, vacuumed }
  } catch (error) {
    return { ok: false, file, removed: 0, error: String(error?.message || error) }
  } finally {
    try { db.close() } catch {}
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
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
