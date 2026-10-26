// 协议端守护：**宿主启动时检查一次**，没在跑就拉起来。不做周期轮询。
//
// 为什么不走计划任务：主人 2026-10-25 明确不要开机自启。所以改由**用它的这一侧**负责拉：
//   · 只在「直连协议端」通道下工作（切到 AstrBot 时不掺和）
//   · 只在启动那一刻探一次（15 秒一探太费，主人 2026-10-25 否掉了周期版）
//   · 起来之后再确认一次，把结果如实写进日志；失败不假装成功
//   · 找不到可执行文件就如实报，不假装守护着
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'

/**
 * 探一下 OneBot HTTP 端口能不能连上。
 *
 * 为什么用它而不是只信 loginInfo：协议端起来之后要先登录、拿 token 才开始应答，
 * 这期间 loginInfo 会失败。守护若只看「有没有应答」，就会把「在跑但还没登录」
 * 误判成「没在跑」—— 于是每次启动 DSH 都多拉一个进程（主人 2026-10-26 反馈）。
 * 端口能连上就说明那个进程活着，这才是「有没有在跑」。
 */
export function probePort({ host = '127.0.0.1', port, timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const n = Number(port)
    if (!Number.isInteger(n) || n <= 0 || n > 65535) return resolve(false)
    const socket = net.connect({ host, port: n })
    const done = (value) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
    socket.on('timeout', () => done(false))
  })
}

/** 从桥配置里取 OneBot HTTP 端口；取不到按协议端默认 3000（本机实测：HTTP 3000 / WS 3001）。 */
export function oneBotPort(bridgeConfig) {
  const raw = String(bridgeConfig?.NapCat || '').trim()
  if (raw) {
    try {
      const url = new URL(raw)
      if (url.port) return Number(url.port)
      return url.protocol === 'https:' ? 443 : 80
    } catch {}
    const m = /:(\d{1,5})\b/.exec(raw)
    if (m) return Number(m[1])
  }
  return 3000
}

/** 连续探活失败几次才拉。太敏感会在协议端刚启动、还没监听时被重复拉起。 */
export const FAILS_BEFORE_START = 3
/** 拉起之后的冷却：这段时间内不再尝试。 */
export const COOLDOWN_MS = 60_000

/** 候选目录：环境变量优先，其次本机常见安装位置。只认含 node.exe + index.mjs 的目录。 */
export function candidateDirs(env = process.env) {
  const list = []
  if (env.SNOWLUMA_DIR) list.push(String(env.SNOWLUMA_DIR))
  // 默认探测本机常见放法（不是硬编码依赖：换机器把 SNOWLUMA_DIR 指过去即可）。
  list.push(join('D:', 'deepseek-qq', 'snowluma'))
  return [...new Set(list)]
}

export function findProtocolDir(candidates = candidateDirs()) {
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, 'node.exe')) && existsSync(join(dir, 'index.mjs'))) return dir
    } catch {}
  }
  return ''
}

/**
 * @param {object} options
 *   qq: 用来探活的对象（要 loginInfo；bridgeConfig 可选，用来取端口）
 *   isDirectTransport: () => boolean，只有直连协议端时才守护
 *   spawnImpl: 可注入（测试不真起进程）
 *   probe: 可注入的「在跑吗」判断（测试不许真去连端口，否则结果随本机状态飘）
 */
export function createProtocolSupervisor(options = {}) {
  const {
    qq,
    isDirectTransport = () => true,
    dir,
    spawnImpl,
    logger,
    probe,
    failsBeforeStart = FAILS_BEFORE_START,
    cooldownMs = COOLDOWN_MS,
    now = () => Date.now(),
  } = options

  let fails = 0
  let lastStartAt = 0
  let lastError = ''
  let started = 0
  const protocolDir = dir === undefined ? findProtocolDir() : String(dir || '')

  function status() {
    return {
      enabled: Boolean(protocolDir),
      dir: protocolDir,
      fails,
      started,
      lastStartAt,
      lastError,
      cooldown: lastStartAt > 0 && now() - lastStartAt < cooldownMs,
    }
  }

  /** 协议端那个进程活着吗：看 OneBot HTTP 端口，不看它有没有登录完成。 */
  async function running() {
    if (probe) {
      try { return Boolean(await probe()) } catch { return false }
    }
    let port = 3000
    try { port = oneBotPort(qq?.bridgeConfig?.()) } catch {}
    return probePort({ port })
  }

  /** 它开始应答了吗：登录完成、能回 get_login_info 才算「真的可用」。 */
  async function answered() {
    try {
      const info = await qq.loginInfo()
      return Boolean(info && info.ok)
    } catch (error) {
      lastError = String(error?.message || error)
      return false
    }
  }

  async function launch() {
    if (!protocolDir) return { ok: false, error: '找不到协议端目录（需要 node.exe + index.mjs）' }
    if (lastStartAt && now() - lastStartAt < cooldownMs) return { ok: false, error: '冷却中，先不重复拉' }
    // 拉起前必须再看一眼「那个进程在不在」。
    // 只凭 loginInfo 判活会误判：协议端起来之后要登录、拿 token 才开始应答，
    // 这期间 loginInfo 失败 → 守护以为没在跑 → 每启动一次 DSH 就多拉一个，
    // 而每拉一个就多一个控制台窗口（主人 2026-10-26 反馈的现象）。
    if (await running()) {
      try { logger?.info?.('fish-world: 协议端已经在跑（端口通），不再重复拉起') } catch {}
      return { ok: false, alreadyRunning: true, error: '已经有协议端在跑' }
    }
    const run = spawnImpl || spawn
    try {
      // 不能 detached。SnowLuma 起来之后会用 `stdio: 'inherit'` 再 spawn 一个自己
      // （更新 / 重启逻辑，见 index.mjs 里那句 spawn(process.execPath, …)）。
      //   detached: true  → 子进程**没有控制台** → 那个 inherit 的孙进程无处继承，
      //                       Windows 只能给它**新建一个可见控制台** = 每次启动冒黑窗口。
      //   detached: false + windowsHide → 子进程有控制台但窗口是隐藏的，
      //                       孙进程继承同一个隐藏控制台，不再新建窗口。
      // 主人 2026-10-26 反馈的「每次启动 DSH 连冒几个空白控制台」就是这个。
      const child = run(join(protocolDir, 'node.exe'), ['index.mjs'], {
        cwd: protocolDir,
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      // unref：不等它退出，也不把宿主退出拖住。
      // Windows 下普通子进程不会随父进程退出而死（除非宿主挂了 job object）。
      if (child && typeof child.unref === 'function') child.unref()
      if (child && typeof child.on === 'function') child.on('error', (error) => { lastError = String(error?.message || error) })
      lastStartAt = now()
      started += 1
      try { logger?.info?.('fish-world: 协议端没在跑，已自动拉起（' + protocolDir + '）') } catch {}
      return { ok: true }
    } catch (error) {
      lastError = String(error?.message || error)
      try { logger?.warn?.('fish-world: 自动拉起协议端失败：' + lastError) } catch {}
      return { ok: false, error: lastError }
    }
  }

  /**
   * 启动时检查一次：活着什么都不做；没活着就拉起来，过一会儿再确认一次。
   * 不排周期任务 —— 宿主活着期间协议端再挂，就要等下次启动或人工，这是明确取舍。
   */
  async function checkAtBoot({ verifyDelayMs = 8000, sleep } = {}) {
    if (!protocolDir) return { ok: false, skipped: 'no-dir' }
    let direct = false
    try { direct = isDirectTransport() } catch { direct = false }
    if (!direct) return { ok: true, skipped: 'not-direct' }

    const alive = async () => {
      try { const info = await qq.loginInfo(); return Boolean(info && info.ok) } catch { return false }
    }
    if (await alive()) return { ok: true, alive: true, launched: false }

    // 「要不要拉」看端口（进程在不在），「拉得好不好」看应答。
    // 两个判据分开：进程活着但还没登录完成时，不该再拉一个。
    if (await running()) return { ok: true, alive: true, launched: false, waitingLogin: !(await answered()) }

    const result = await launch()
    if (!result.ok) return { ok: false, alive: false, launched: false, alreadyRunning: Boolean(result.alreadyRunning), error: result.error || '' }
    const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    await wait(verifyDelayMs)
    const nowAlive = await answered()
    try {
      if (nowAlive) logger?.info?.('fish-world: 协议端已自动拉起并确认在线')
      else logger?.warn?.('fish-world: 协议端拉起来了，但还没应答（可能还在登录/初始化）')
    } catch {}
    return { ok: nowAlive, alive: nowAlive, launched: true, error: nowAlive ? '' : '拉起来但还没应答' }
  }

  /** 探一次；失败计数到阈值才拉。拉起前还要确认进程不在，避免重复拉。 */
  async function tick() {
    if (!protocolDir) return { ok: false, skipped: 'no-dir' }
    let direct = false
    try { direct = isDirectTransport() } catch { direct = false }
    if (!direct) return { ok: true, skipped: 'not-direct' }
    const answeredNow = await answered()
    if (answeredNow) { fails = 0; return { ok: true, alive: true } }
    // 没应答不等于没在跑：先把这一轮记成失败，到阈值再判。
    lastError = ''
    fails += 1
    if (fails < failsBeforeStart) return { ok: true, alive: false, fails }
    if (await running()) {
      // 端口通但没应答 = 它在跑、只是还没登录完。别拉第二个，也别把计数清零装没事。
      try { logger?.warn?.('fish-world: 协议端进程在跑但还没应答（端口通），这次不再拉起') } catch {}
      return { ok: true, alive: false, launched: false, running: true, fails }
    }
    const result = await launch()
    if (result.ok) fails = 0
    return { ok: result.ok || Boolean(result.alreadyRunning), alive: false, launched: result.ok, error: result.error || '' }
  }

  return { status, tick, checkAtBoot, dir: protocolDir }
}
