// Sherlock：按用户名排查「这个人在哪些公开站点有账号」，只报存在性。
//
// 为什么不自己写一套平台探测：Sherlock 维护 400+ 站点的判定规则——每个站点
// 「不存在」的特征各不相同，还分「用户名格式不合法」与「网络连不上」。
// 抄一份进来必然和上游漂移（AGENTS §2：优先复用上游），所以鱼世界只在外层加四件事：
//
//   1. 定位：找到 Python 与 sherlock（找不到就如实说没装，不假装能用）；
//   2. 白名单：只查配置里允许的站点，不整盘扫；
//   3. 串行 + 超时：同一时间只跑一次，超时就杀进程；
//   4. 归一：把 CSV 的四种结局收成鱼世界的四态（Claimed / Available / Unknown / Illegal）。
//
// 边界（与 hub 借手一致）：只借「手」，不借别人抓来的内容。
// Sherlock 只回「哪个 URL 存在」，我们不抓主页正文、不抓头像、不做画像。
//
// 落盘：不在这里写。这个模块只负责「跑一次、给一份结构化结果」，
// 账本由 lib/person-records.mjs 管（和 records.mjs 同一套追加写）。
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** CSV 里的 exists 列 → 鱼世界的四态。 */
export const SHERLOCK_STATUS = Object.freeze({
  CLAIMED: 'claimed',
  AVAILABLE: 'available',
  UNKNOWN: 'unknown',
  ILLEGAL: 'illegal',
})

const STATUS_LABELS = Object.freeze({
  claimed: '已占用',
  available: '未占用',
  unknown: '未知',
  illegal: '用户名格式不符',
})

/** 四态的中文名。面板与工具返回共用一份，避免两处各写一套。 */
export function statusLabel(id) {
  return STATUS_LABELS[id] || STATUS_LABELS.unknown
}

/**
 * 把上游的 exists 值归一成四态。
 *
 * ★ 这里不许把「查不出来」当成「没有」：
 *   上游在站点连不上时给 Unknown（http_status=?），那是「没测出来」，不是「不存在」。
 *   混成一个假结论会让主人拿着一张错表去做判断。
 */
export function normalizeExists(raw) {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'claimed') return SHERLOCK_STATUS.CLAIMED
  if (value === 'available') return SHERLOCK_STATUS.AVAILABLE
  if (value === 'illegal') return SHERLOCK_STATUS.ILLEGAL
  return SHERLOCK_STATUS.UNKNOWN
}

/**
 * 解析 Sherlock 的 CSV。
 *
 * 只做这件事，因为上游除了 CSV 没有稳定的机器可读出口：
 * `--json` 是「从 JSON 加载站点表」，不是「输出 JSON」（文档里常被写错，实测 0.16.2 如此）。
 *
 * 手写 CSV 而不是引依赖：字段只有 7 列，唯一要处理的是引号内的逗号
 * （站点名里确实会有逗号，例如 `Some Site, Inc.`）。
 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const source = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n' || ch === '\r') {
      // CRLF 只算一次换行。
      if (ch === '\r' && source[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((item) => item !== '')) rows.push(row)
      row = []
      continue
    }
    field += ch
  }
  row.push(field)
  if (row.some((item) => item !== '')) rows.push(row)
  if (!rows.length) return []
  const header = rows[0].map((item) => item.trim())
  return rows.slice(1).map((cells) => {
    const item = {}
    for (let i = 0; i < header.length; i += 1) item[header[i]] = String(cells[i] ?? '').trim()
    return item
  })
}

/** CSV 行 → 一条平台结果。 */
function toPlatform(row) {
  const status = normalizeExists(row.exists)
  return {
    site: String(row.name || '').trim(),
    url: String(row.url_user || '').trim(),
    status,
    statusLabel: statusLabel(status),
    // http_status 上游在没连通时给 '?'，保留原样而不是塞 0：那是「没测出来」的标记。
    httpStatus: String(row.http_status || '').trim(),
    responseTime: Number(row.response_time_s) || 0,
  }
}

/**
 * 汇总一份结果。
 *
 * counts 里每态都单独给数，**不给「命中率」这种把未知并进分母的指标**：
 * unknown 既不是命中也不是未命中，混进去就是假读数。
 */
export function summarize(platforms) {
  const counts = { claimed: 0, available: 0, unknown: 0, illegal: 0, total: 0 }
  for (const item of platforms) {
    counts[item.status] = (counts[item.status] || 0) + 1
    counts.total += 1
  }
  return counts
}

/** 最小 runner：只接受 argv 数组，`shell: false`，超时杀进程。与 media-tools 的 runner 同一套语义。 */
export function createRunner({ spawn: spawnImpl = spawn, now = () => Date.now() } = {}) {
  return {
    run(argv, options = {}) {
      const list = Array.isArray(argv) ? argv.map((item) => String(item)) : []
      if (!list.length) return Promise.reject(new Error('没有可执行的程序'))
      const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000
      return new Promise((resolvePromise, rejectPromise) => {
        let child
        try {
          child = spawnImpl(list[0], list.slice(1), {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          rejectPromise(new Error(`启动 ${list[0]} 失败：${error?.message || error}`))
          return
        }

        let stdout = ''
        let stderr = ''
        let settled = false
        const startedAt = now()
        const MAX_TEXT = 64 * 1024
        let timer = null

        const cleanup = () => { if (timer) { clearTimeout(timer); timer = null } }
        const finish = (error, value) => {
          if (settled) return
          settled = true
          cleanup()
          if (error) rejectPromise(error)
          else resolvePromise(value)
        }

        // 超时杀进程。Sherlock 对慢站点会一直等，不杀的话一次查询能挂几分钟。
        timer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
          finish(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒还没查完，已终止（可在设置里调 sherlock.timeoutSec）`))
        }, timeoutMs)
        timer.unref?.()

        child.stdout?.on('data', (chunk) => {
          if (stdout.length < MAX_TEXT) stdout += String(chunk)
        })
        child.stderr?.on('data', (chunk) => {
          if (stderr.length < MAX_TEXT) stderr += String(chunk)
        })

        child.on('error', (error) => {
          const code = String(error?.code || '')
          finish(new Error(code === 'ENOENT'
            ? `找不到可执行文件 ${list[0]}（没装 Python，或设置里的 pythonPath 指错了）`
            : `启动 ${list[0]} 失败：${error?.message || error}`))
        })

        child.on('close', (exitCode, signal) => {
          finish(null, {
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            signal: signal || null,
            stdout,
            stderr,
            durationMs: now() - startedAt,
          })
        })
      })
    },
  }
}

/**
 * 定位 Python 与 sherlock。
 *
 * 只做「问一句」：用 `python -c` 查 sherlock_project 能不能 import。
 * 不猜路径、不扫全盘——找不到就返回 found:false，由调用方如实显示「未安装」。
 */
export function createSherlock({
  config,
  logger,
  spawn: spawnImpl,
  now,
  // 测试注入点：临时目录根、定位函数、以及整个 runner（用来断言 argv，不真起进程）。
  tempRoot,
  locate,
  runner: runnerOverride,
} = {}) {
  const runner = runnerOverride || createRunner({ spawn: spawnImpl, now })
  let located = null
  // 串行闸：一次只允许一个查询在跑。
  let running = false

  function cfg() {
    try {
      const value = typeof config === 'function' ? config() : config
      return (value && value.sherlock) || {}
    } catch { return {} }
  }

  function pythonExe() {
    const custom = String(cfg().pythonPath || '').trim()
    return custom || 'python'
  }

  /**
   * 探一次装没装。结果缓存：这个信息一轮内不会变，不必每次查询都起两个进程。
   * @returns {Promise<{found:boolean, python:string, version:string, error:string}>}
   */
  async function locateSherlock() {
    if (typeof locate === 'function') return locate()
    if (located) return located
    const python = pythonExe()
    try {
      const out = await runner.run([
        python, '-c',
        'import sherlock_project,sys;sys.stdout.write(getattr(sherlock_project,"__version__",""))',
      ], { timeoutMs: 20000 })
      if (out.exitCode !== 0) {
        located = {
          found: false,
          python,
          version: '',
          // 原文照抄 stderr 的头一行：主人要能看到「是没模块」还是「python 都找不到」。
          error: String(out.stderr || '').trim().split(/\r?\n/).filter(Boolean)[0] || '导入 sherlock_project 失败',
        }
      } else {
        located = { found: true, python, version: String(out.stdout || '').trim(), error: '' }
      }
    } catch (error) {
      located = { found: false, python, version: '', error: String(error?.message || error) }
    }
    return located
  }

  /** 状态：面板与工具都用这一份，避免两处各报一套。 */
  async function status() {
    const info = await locateSherlock()
    return {
      ok: true,
      installed: info.found === true,
      python: info.python,
      version: info.version || '',
      error: info.error || '',
      enabled: cfg().enabled === true,
      concurrency: 'serial',
      note: info.found
        ? 'Sherlock 已就绪；查询只报「这个用户名在哪些站已占用」，不抓取主页内容。'
        : '本机还没有 Sherlock。装法：pip install sherlock-project（装完不用重启，下次查询即可用）。',
    }
  }

  /**
   * 跑一次查询。
   *
   * @param {object} options
   * @param {string} options.username 要查的用户名
   * @param {string[]} [options.sites] 限定站点；空 = 用配置里的白名单
   * @param {number} [options.timeoutSec]
   * @returns {Promise<{ok:boolean, username:string, platforms:object[], counts:object, error:string, durationMs:number, sites:string[]}>}
   */
  async function check({ username, sites, timeoutSec } = {}) {
    const clean = String(username || '').trim()
    if (!clean) throw new Error('要查的用户名不能为空')
    // 用户名会进命令行参数。走 argv 不拼 shell，这里仍限一道形状：
    // 上游本身有 illegal 判定，这里只是不让空串和明显乱码进流程。
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(clean)) {
      throw new Error('用户名只能用字母、数字、下划线、点、短横线，最长 64 位')
    }

    const info = await locateSherlock()
    if (!info.found) {
      return {
        ok: false,
        username: clean,
        platforms: [],
        counts: summarize([]),
        error: `Sherlock 没装：${info.error || '找不到 sherlock_project'}。装法：pip install sherlock-project`,
        durationMs: 0,
        sites: [],
      }
    }

    const conf = cfg()
    const siteList = (Array.isArray(sites) && sites.length ? sites : (Array.isArray(conf.sites) ? conf.sites : []))
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      // 上限是防御：一次几百个站点等于全网扫，不是这个功能要做的事。
      .slice(0, 40)
    const seconds = Math.max(3, Math.min(Number(timeoutSec) || Number(conf.timeoutSec) || 20, 120))

    const dir = mkdtempSync(join(tempRoot || tmpdir(), 'fish-sherlock-'))
    // ★ 必须 --print-all：上游 CSV 默认（以及 --print-found）只落**已占用**的站点，
    //   Available / Unknown / Illegal 整行不写。只存命中 → 账本里「查过的站」全是已占用，
    //   主人看到的就是一张假表（以为「他只在这两个站有号」，其实是没记其余的）。
    //   实测 0.16.2：不带 --print-all 时 CSV 只有表头；带上才有完整四态。
    const argv = [info.python, '-m', 'sherlock_project', clean,
      '--folderoutput', dir, '--csv', '--print-all', '--no-color', '--local',
      '--timeout', String(seconds)]
    for (const site of siteList) argv.push('--site', site)

    // 串行：Sherlock 一次会并发打几百个站点，两轮叠着跑对目标站不礼貌，也容易互相拖超时。
    if (running) throw new Error('已经有一次查询在跑，等它完成再试（同一时间只查一个用户名）。')
    running = true
    let out
    try {
      out = await runner.run(argv, { timeoutMs: (seconds + 30) * 1000 })
    } finally {
      running = false
    }

    let platforms = []
    try {
      const file = readdirSync(dir).find((name) => name.toLowerCase().endsWith('.csv'))
      if (file) platforms = parseCsv(readFileSync(join(dir, file), 'utf8')).map(toPlatform)
    } catch (error) {
      try { logger?.warn?.(`[sherlock] 读结果失败：${error?.message || error}`) } catch {}
    } finally {
      // 临时目录一定清掉：里面是查询结果原文件，没必要留在系统临时区。
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }

    // 有结果就算成功，不看退出码——Sherlock 在部分站点出错时仍以非 0 退出，
    // 但 CSV 是完整的（这和 media-tools 看 stderr 不看退出码是同一条判断）。
    if (!platforms.length) {
      const hint = String(out.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n')
      return {
        ok: false,
        username: clean,
        platforms: [],
        counts: summarize([]),
        error: `这次没查到结果（退出码 ${out.exitCode}）${hint ? '：' + hint : ''}`,
        durationMs: out.durationMs,
        sites: siteList,
      }
    }

    return {
      ok: true,
      username: clean,
      platforms,
      counts: summarize(platforms),
      error: '',
      durationMs: out.durationMs,
      sites: siteList,
      version: info.version || '',
    }
  }

  return {
    status,
    check,
    locate: locateSherlock,
    /** 开关（读同一份配置）。工具侧判「能不能查」只问这一处，别再自己拿 configStore。 */
    enabled: () => cfg().enabled === true,
    /** 配置里的站点白名单（面板要显示「只查这几个站」）。 */
    sites: () => (Array.isArray(cfg().sites) ? cfg().sites.map((item) => String(item).trim()).filter(Boolean) : []),
  }
}
