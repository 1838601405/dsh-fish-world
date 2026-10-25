// DSH 桌面端「启动即崩」的防复发看门狗。
//
// 为什么需要它：
//   桌面端每次启动都往 Cookie 库里写一条空值的持久 `dsh-auth-*`（127.0.0.1），
//   攒到一定条数就 `Web authentication failed` 启动即退出（本机实测 71 条时崩）。
//   手动 `npm run repair:auth` 只能救一次，救不了下一次。
//
// 为什么不在启动前清：
//   桌面端没有可靠的「启动前」钩子（只有快捷方式，没有启动脚本），
//   从安装目录挂会被升级冲掉。但**退出时**它是可观测的：
//   进程没了，数据库也就不锁了 —— 这时清既安全、又保证下次启动是干净的。
//
// 行为：
//   · 每 30 秒看一次 DSH 桌面端进程；
//   · 从「在跑」变成「不在跑」时，等 3 秒让 Chromium 收尾，再清本机回环 Cookie；
//   · DSH 在跑的时候**不碰**数据库（它锁着，硬删有损坏风险）；
//   · 一次运行结束后自动退出，不常驻内存；由任务计划在登录时拉起。
//
// 只删 127.0.0.1 / localhost / ::1 三类，不碰账号凭据。
import { execFileSync } from 'node:child_process'
import { pruneIfStale, countLoopbackCookies, STALE_THRESHOLD } from './repair-desktop-auth.mjs'

const POLL_MS = 30_000
const SETTLE_MS = 3_000
const PROCESS_NAMES = ['DeepSeek Harness.exe', 'DeepSeek Harness']

/** DSH 桌面端现在有没有在跑。tasklist 在 Windows 上最省事，也不需要额外依赖。 */
export function dshRunning() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    })
    for (const name of PROCESS_NAMES) {
      if (out.includes(`"${name}"`)) return true
    }
    return false
  } catch {
    // 拿不到进程列表时宁可当作「在跑」：不动数据库比冒险删更安全。
    return true
  }
}

/**
 * 看门狗主循环。
 * @param {object} opts
 *   pollMs 轮询间隔；settleMs 退出后等多久再清；
 *   isRunning 可注入（测试不真去 tasklist）；
 *   prune 可注入（测试不真删数据）；
 *   log 输出函数；
 *   signal 可传入 AbortSignal 让它停下。
 */
export async function watchDesktopAuth({
  pollMs = POLL_MS,
  settleMs = SETTLE_MS,
  isRunning = dshRunning,
  prune = pruneIfStale,
  log = (line) => console.log(line),
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let wasRunning = isRunning()
  log(`· 看门狗启动：DSH 当前${wasRunning ? '在跑' : '没在跑'}`)
  const stats = { cleaned: 0, removed: 0, checks: 0 }

  // 启动时如果 DSH 本来就没在跑，先顺手清一次（上次可能崩在半路，没人收尾）。
  if (!wasRunning) {
    const r = await prune()
    stats.checks += 1
    if (r.removed) {
      stats.cleaned += 1
      stats.removed += r.removed
      log(`· 启动自检：清掉 ${r.removed} 条残留`)
    }
  }

  while (!signal?.aborted) {
    await sleep(pollMs)
    if (signal?.aborted) break
    const running = isRunning()
    if (wasRunning && !running) {
      // 刚退出：等 Chromium 把数据库句柄放开，再清。
      await sleep(settleMs)
      const r = await prune()
      stats.checks += 1
      if (r.removed) {
        stats.cleaned += 1
        stats.removed += r.removed
        log(`· DSH 已退出，清掉 ${r.removed} 条本机 Cookie`)
      }
      wasRunning = false
    } else if (!wasRunning && running) {
      log('· DSH 启动了')
      wasRunning = true
    }
  }
  return stats
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith('auth-watchdog.mjs')
if (invokedDirectly) {
  if (process.argv.includes('--status')) {
    const c = await countLoopbackCookies()
    console.log(`DSH ${dshRunning() ? '在跑' : '没在跑'}；本机回环 Cookie ${c.count} 条（阈值 ${STALE_THRESHOLD}）`)
    process.exit(0)
  }
  if (process.argv.includes('--once')) {
    // 单次模式：给任务计划「登录时运行一次」用，跑完就退。
    const wasRunning = dshRunning()
    if (wasRunning) {
      console.log('· DSH 在跑，不动数据库')
      process.exit(0)
    }
    const r = await pruneIfStale()
    console.log(r.removed ? `✔ 清掉 ${r.removed} 条` : `· 不需要清（${r.count} 条）`)
    process.exit(0)
  }
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  process.on('SIGTERM', () => controller.abort())
  await watchDesktopAuth({ signal: controller.signal })
}
