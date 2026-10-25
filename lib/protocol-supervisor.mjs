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
 *   qq: 用来探活的对象（要 call / loginInfo）
 *   isDirectTransport: () => boolean，只有直连协议端时才守护
 *   spawnImpl: 可注入（测试不真起进程）
 */
export function createProtocolSupervisor(options = {}) {
  const {
    qq,
    isDirectTransport = () => true,
    dir,
    spawnImpl,
    logger,
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

  function launch() {
    if (!protocolDir) return { ok: false, error: '找不到协议端目录（需要 node.exe + index.mjs）' }
    if (lastStartAt && now() - lastStartAt < cooldownMs) return { ok: false, error: '冷却中，先不重复拉' }
    const run = spawnImpl || spawn
    try {
      const child = run(join(protocolDir, 'node.exe'), ['index.mjs'], {
        cwd: protocolDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      // detached 之后要 unref，否则宿主退出时会被拖住。
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

    const result = launch()
    if (!result.ok) return { ok: false, alive: false, launched: false, error: result.error || '' }
    const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    await wait(verifyDelayMs)
    const nowAlive = await alive()
    try {
      if (nowAlive) logger?.info?.('fish-world: 协议端已自动拉起并确认在线')
      else logger?.warn?.('fish-world: 协议端拉起来了，但还没应答（可能还在登录/初始化）')
    } catch {}
    return { ok: nowAlive, alive: nowAlive, launched: true, error: nowAlive ? '' : '拉起来但还没应答' }
  }

  /** 探一次；失败计数到阈值就拉。返回这一轮做了什么。 */
  async function tick() {
    if (!protocolDir) return { ok: false, skipped: 'no-dir' }
    let direct = false
    try { direct = isDirectTransport() } catch { direct = false }
    if (!direct) return { ok: true, skipped: 'not-direct' }
    let alive = false
    try {
      const info = await qq.loginInfo()
      alive = Boolean(info && info.ok)
    } catch (error) {
      lastError = String(error?.message || error)
      alive = false
    }
    if (alive) { fails = 0; return { ok: true, alive: true } }
    fails += 1
    if (fails < failsBeforeStart) return { ok: true, alive: false, fails }
    const result = launch()
    if (result.ok) fails = 0
    return { ok: result.ok, alive: false, launched: result.ok, error: result.error || '' }
  }

  return { status, tick, checkAtBoot, dir: protocolDir }
}
