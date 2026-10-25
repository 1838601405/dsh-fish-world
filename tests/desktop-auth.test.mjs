// DSH 桌面端「启动即崩」的防复发逻辑。
//
// 真实背景（本机实测）：每次启动写一条空值的持久 dsh-auth-* → 攒到 71 条时
// 启动即崩（Web authentication failed）。这里测的是「什么时候清、清完有没有副作用」，
// 不测 sqlite 本身。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { STALE_THRESHOLD, countLoopbackCookies, pruneIfStale, repairDesktopAuth, desktopCookieDb } from '../scripts/repair-desktop-auth.mjs'

/** 造一个只含 cookies 表的假 Chromium 库。 */
async function fakeCookieDb({ loopback = 0, account = 2 } = {}) {
  const appData = mkdtempSync(join(tmpdir(), 'fw-auth-'))
  const dir = join(appData, '@deepseek-ai', 'dsh-desktop', 'Network')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'Cookies')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  db.exec('create table cookies (host_key text, name text, encrypted_value blob, is_persistent integer)')
  const ins = db.prepare('insert into cookies (host_key, name, encrypted_value, is_persistent) values (?,?,?,?)')
  for (let i = 0; i < loopback; i += 1) ins.run('127.0.0.1', `dsh-auth-${i}`, new Uint8Array(0), 1)
  for (let i = 0; i < account; i += 1) ins.run('.deepseek.com', `session_${i}`, new Uint8Array(4), 1)
  db.close()
  return { appData, file }
}

const quiet = { info() {}, warn() {} }

test('数据库路径落在 dsh-desktop/Network/Cookies', () => {
  assert.match(desktopCookieDb('C:\\AppData'), /dsh-desktop[\\/]Network[\\/]Cookies$/)
  assert.equal(desktopCookieDb(''), '')
})

test('只数本机回环，不把账号 Cookie 算进来', async () => {
  const { appData } = await fakeCookieDb({ loopback: 5, account: 3 })
  const r = await countLoopbackCookies({ appDataDir: appData })
  assert.equal(r.ok, true)
  assert.equal(r.count, 5)
})

test('清理只删本机回环，账号凭据一条不动', async () => {
  const { appData, file } = await fakeCookieDb({ loopback: 71, account: 3 })
  const r = await repairDesktopAuth({ appDataDir: appData, logger: quiet })
  assert.equal(r.ok, true)
  assert.equal(r.removed, 71, '正好清掉 71 条残留')

  const left = await countLoopbackCookies({ appDataDir: appData })
  assert.equal(left.count, 0, '本机回环清空')

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file)
  const account = db.prepare("select count(*) as n from cookies where host_key = '.deepseek.com'").get().n
  db.close()
  assert.equal(account, 3, '账号 Cookie 必须还在 —— 清的是桌面端自己的握手凭据')
})

test('空库不乱写：没有残留时直接返回，不产生备份', async () => {
  const { appData } = await fakeCookieDb({ loopback: 0, account: 2 })
  const r = await repairDesktopAuth({ appDataDir: appData, logger: quiet })
  assert.equal(r.removed, 0)
  assert.equal(r.backupFile, undefined)
})

test('看门狗只在超过阈值时清，别每次启动都删', async () => {
  const below = await fakeCookieDb({ loopback: STALE_THRESHOLD - 1, account: 1 })
  const r1 = await pruneIfStale({ appDataDir: below.appData, logger: quiet })
  assert.equal(r1.removed, 0, '没到阈值不动')
  assert.equal(r1.below, true)

  const over = await fakeCookieDb({ loopback: STALE_THRESHOLD + 5, account: 1 })
  const r2 = await pruneIfStale({ appDataDir: over.appData, logger: quiet })
  assert.equal(r2.removed, STALE_THRESHOLD + 5, '超过阈值就清干净')
})

test('看门狗清的时候不留备份文件（它会天天跑）', async () => {
  const { appData } = await fakeCookieDb({ loopback: STALE_THRESHOLD + 1, account: 0 })
  await pruneIfStale({ appDataDir: appData, logger: quiet })
  const dir = join(appData, '@deepseek-ai', 'dsh-desktop', 'Network')
  const { readdirSync } = await import('node:fs')
  const baks = readdirSync(dir).filter((n) => n.includes('.bak-'))
  assert.deepEqual(baks, [], '看门狗不写备份，否则攒几次就占满磁盘')
})

test('数据库不存在时安静跳过，不报错', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'fw-auth-empty-'))
  const r = await repairDesktopAuth({ appDataDir: empty, logger: quiet })
  assert.equal(r.ok, true)
  assert.equal(r.skipped, 'cookies-db-missing')
})
