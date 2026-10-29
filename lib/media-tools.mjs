// 视频工具：把已装的 dsh-ffmpeg 借过来用，鱼世界只在外面加三层东西——鱼箱、额度、串行。
//
// 为什么不重写一套 ffmpeg 参数：参数语义、预设档位、输出命名、防覆写都在上游
// `dsh-ffmpeg/lib/tools.js` 里。抄一份进来必然和上游漂移（AGENTS §2：优先复用上游）。
// 所以这里只做三件事：
//   1. 路径：`input` 必须先过沙箱（`sandbox.resolveInside(..., { mustExist: true })`），
//      模型给的 `output` 也必须落在鱼箱里；没给 `output` 就写到 `<世界>/鱼的产出/`；
//   2. 额度：输入文件 ≤ `media.maxInputMB`（默认 500MB）、单次超时 ≤ 5 分钟、同时只跑一个；
//   3. 执行：自己实现 runner（spawn + argv 数组，绝不 shell:true、绝不拼接命令行）。
//
// 参数白名单不手抄：直接读上游工具定义里的 `parameters.properties`。上游加了新参数，
// 这里自动认得；上游没有的参数（比如模型随手编的 `-vf`）一律拒绝。
import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDependency } from './env.mjs'
import { clampNumber } from './util.mjs'

/** 允许的视频操作。与上游工具名一一对应；`extract` 不在契约里，故意不给。 */
export const VIDEO_OPS = Object.freeze([
  'probe', 'cut', 'gif', 'encode', 'subtitle', 'frames', 'concat', 'adjust', 'health',
])

/** op → 上游工具名。 */
const TOOL_NAMES = Object.freeze({
  probe: 'ffmpeg_probe',
  cut: 'ffmpeg_cut',
  gif: 'ffmpeg_gif',
  encode: 'ffmpeg_encode',
  subtitle: 'ffmpeg_subtitle',
  frames: 'ffmpeg_frames',
  concat: 'ffmpeg_concat',
  adjust: 'ffmpeg_adjust',
  health: 'ffmpeg_health',
})

/** 产出目录名：没给 output 时统一落在这里（世界根下），不回写输入同目录。 */
export const OUTPUT_FOLDER = '鱼的产出'

/** 需要产出文件的 op（probe / health 不产出）。 */
const PRODUCE_OPS = new Set(['cut', 'gif', 'encode', 'subtitle', 'frames', 'concat', 'adjust'])

/** 默认文件名后缀，与上游 `resolveOutputPath` 的默认值保持一致。 */
const OUTPUT_SUFFIX = Object.freeze({
  cut: '.cut',
  encode: '.encoded',
  subtitle: '.sub',
  gif: '.gif',
  adjust: '.adjust',
  concat: '.concat',
})

/** 单条流最多留 1MB；stderr 留尾部（错误通常在最后），stdout 超了就当失败。 */
const MAX_CAPTURE_BYTES = 1024 * 1024

const MISSING_MESSAGE = 'dsh-ffmpeg 没装，视频工具不可用'

/** 路径 / 额度这类「输入不对」的错误：给模型看的是中文原因，不是 JS 异常。 */
class MediaInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MediaInputError'
  }
}

class MediaUnavailableError extends Error {
  constructor(message = MISSING_MESSAGE) {
    super(message)
    this.name = 'MediaUnavailableError'
  }
}

/** 与上游 `sanitizeName` 同一套清洗规则；只用于「没给 output」时拼默认名。 */
function sanitizeName(name) {
  const cleaned = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 120)
  return cleaned === '' ? 'output' : cleaned
}

function fileSizeOf(file) {
  try {
    const stat = statSync(file)
    return stat.isFile() ? stat.size : -1
  } catch {
    return -1
  }
}

function pickString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 收集子进程输出。`mode: 'tail'` 表示超过上限时丢头部、保尾部（stderr 用），
 * `head` 表示只保头部并把「被截断」标出来（stdout 用，probe 的 JSON 截断后无法解析）。
 */
function createCollector(mode) {
  const chunks = []
  let size = 0
  let truncated = false
  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return
      if (size >= MAX_CAPTURE_BYTES) {
        truncated = true
        if (mode === 'head') return
        // tail：丢掉最老的一块，给新内容腾位置。
        while (size >= MAX_CAPTURE_BYTES && chunks.length) size -= chunks.shift().length
      }
      let part = chunk
      const room = MAX_CAPTURE_BYTES - size
      if (part.length > room) {
        part = mode === 'tail' ? part.subarray(part.length - room) : part.subarray(0, room)
        truncated = true
      }
      chunks.push(part)
      size += part.length
    },
    get truncated() { return truncated },
    text() { return Buffer.concat(chunks).toString('utf8') },
  }
}

/**
 * 最小 runner：`run(argv, { timeoutMs, signal })`。
 *
 * 只接受 argv 数组，`spawn(bin, argv, { shell: false })`——调用方（上游 tools.js）已经把
 * 每个参数拆好了，这里没有第二次解释字符串的机会。超时直接杀进程并按失败返回。
 */
export function createRunner({ spawn: spawnImpl = spawn, now = () => Date.now() } = {}) {
  return {
    run(argv, options = {}) {
      const list = Array.isArray(argv) ? argv.map((item) => String(item)) : []
      if (!list.length) return Promise.reject(new Error('没有可执行的程序'))
      const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 300000
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

        const stdout = createCollector('head')
        const stderr = createCollector('tail')
        let settled = false
        let timer = null
        const startedAt = now()

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          try { options?.signal?.removeEventListener?.('abort', onAbort) } catch {}
        }
        const finish = (error, value) => {
          if (settled) return
          settled = true
          cleanup()
          if (error) rejectPromise(error)
          else resolvePromise(value)
        }
        const onAbort = () => {
          try { child.kill('SIGKILL') } catch {}
          finish(options?.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error('任务被取消'))
        }

        if (options?.signal) {
          if (options.signal.aborted === true) {
            onAbort()
            return
          }
          options.signal.addEventListener?.('abort', onAbort, { once: true })
        }

        timer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
          finish(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒还没跑完，已终止（可用 media.timeoutMs 调整）`))
        }, timeoutMs)
        timer.unref?.()

        child.stdout?.on('data', (chunk) => stdout.push(chunk))
        child.stderr?.on('data', (chunk) => stderr.push(chunk))

        child.on('error', (error) => {
          const code = String(error?.code || '')
          const reason = code === 'ENOENT'
            ? `找不到可执行文件 ${list[0]}（系统里没有，或 media.ffmpegPath / media.ffprobePath 指错了）`
            : `启动 ${list[0]} 失败：${error?.message || error}`
          finish(new Error(reason))
        })

        child.on('close', (exitCode, signal) => {
          if (settled) return
          if (stdout.truncated) {
            finish(new Error('输出超过 1MB 已截断（探测结果不完整，无法解析）；请把任务拆小一点。'))
            return
          }
          finish(null, {
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            signal: signal || null,
            stdout: stdout.text(),
            stderr: stderr.text(),
            durationMs: now() - startedAt,
          })
        })
      })
    },
  }
}

/**
 * 创建视频服务。
 *
 * @param {object} options
 * @param {object} options.sandbox 鱼箱（createSandbox 的返回值）
 * @param {object} options.world   鱼世界（用 `world.root()` 找世界根目录）
 * @param {object} [options.storage] 存储层；world 未绑定时用它兜底
 * @param {Function|object} options.config 配置读取函数（返回整份配置）或配置对象
 * @param {Function} [options.locate] 找 dsh-ffmpeg → `{ found, path, version }`
 * @param {Function} [options.loadTools] `(dir) => import('.../lib/tools.js')`
 * @param {object} [options.logger]
 * @param {string} [options.home] 找依赖时用的 DSH_HOME
 * @param {string} [options.profile] 找依赖时用的 profile
 */
export function createMediaTools({
  sandbox,
  world,
  storage,
  config,
  locate,
  loadTools,
  logger,
  home,
  profile,
  spawn: spawnImpl,
  now,
} = {}) {
  const runner = createRunner({ spawn: spawnImpl, now })

  const findDependency = typeof locate === 'function'
    ? locate
    : () => resolveDependency('dsh-ffmpeg', { ...(home ? { home } : {}), ...(profile ? { profile } : {}) })

  const importTools = typeof loadTools === 'function'
    ? loadTools
    : async (dir) => import(pathToFileURL(join(dir, 'lib', 'tools.js')).href)

  // 模块只加载一次；dsh-ffmpeg 被卸掉时 locate() 会先返回 found:false，不会再走到这里。
  let loadedModule = null
  let loadedFrom = ''
  let busy = false

  function configValue() {
    try {
      return typeof config === 'function' ? config() : (config || {})
    } catch {
      return {}
    }
  }

  function mediaConfig() {
    const whole = configValue()
    const raw = whole?.media && typeof whole.media === 'object' ? whole.media : {}
    return {
      ffmpegPath: pickString(raw.ffmpegPath) || 'ffmpeg',
      ffprobePath: pickString(raw.ffprobePath) || 'ffprobe',
      // 单次上限就是 5 分钟；主人可以在面板里调小，不能调大。
      timeoutMs: clampNumber(raw.timeoutMs, 5000, 300000, 300000),
      // 输入上限同样只许往小里调：500MB 是硬天花板。
      maxInputMB: clampNumber(raw.maxInputMB, 1, 500, 500),
      outputDir: isAbsolute(pickString(raw.outputDir)) ? resolve(pickString(raw.outputDir)) : '',
    }
  }

  /**
   * 产出根目录：配置指定 → 世界根 → 存储根 → 鱼箱。
   *
   * 这里**不**接受模型输入，只由主人配置和世界位置决定；所以不走沙箱解析。
   * 模型给的 `output` 走 `resolveInside(..., { forWrite: true })`，只能落在鱼箱里。
   */
  function outputRoot() {
    const configured = mediaConfig().outputDir
    if (configured) return configured
    const worldRoot = (() => {
      try { return pickString(world?.root?.()) } catch { return '' }
    })()
    if (worldRoot) return join(worldRoot, OUTPUT_FOLDER)
    const storageRoot = (() => {
      try { return pickString(storage?.root?.()) } catch { return '' }
    })()
    if (storageRoot) return join(storageRoot, OUTPUT_FOLDER)
    try { return join(sandbox.root(), OUTPUT_FOLDER) } catch { return '' }
  }

  function requireSandbox() {
    if (!sandbox || typeof sandbox.resolveInside !== 'function') {
      throw new MediaInputError('鱼箱未初始化，视频工具不可用（重启 DSH 试试）')
    }
    return sandbox
  }

  /** 模型给的输入路径：必须是鱼箱内的现存文件，并且不超过单文件额度。 */
  function resolveInput(value, label) {
    const text = pickString(value)
    if (!text) throw new MediaInputError(`${label}不能为空（按鱼箱内的相对路径给，例如 素材/片段.mp4）`)
    const box = requireSandbox()
    let absolute
    try {
      absolute = box.resolveInside(text, { mustExist: true })
    } catch (error) {
      throw new MediaInputError(`${label}只能放在鱼箱里：${error?.message || error}`)
    }
    const size = fileSizeOf(absolute)
    if (size < 0) throw new MediaInputError(`${label}不是可读文件：${text}`)
    const maxBytes = mediaConfig().maxInputMB * 1024 * 1024
    if (size > maxBytes) {
      const mb = (size / 1024 / 1024).toFixed(1)
      throw new MediaInputError(`${label}太大：${mb} MB，超过上限 ${mediaConfig().maxInputMB} MB`)
    }
    return absolute
  }

  /** 模型给的输出路径：必须落在鱼箱里（写位置），父目录不存在就建出来。 */
  function resolveOutput(value) {
    const text = pickString(value)
    if (!text) return ''
    const box = requireSandbox()
    let absolute
    try {
      absolute = box.resolveInside(text, { forWrite: true })
    } catch (error) {
      throw new MediaInputError(`output 只能写在鱼箱里：${error?.message || error}`)
    }
    mkdirSync(dirname(absolute), { recursive: true })
    return absolute
  }

  function defaultOutput(op, inputAbsolute) {
    const root = outputRoot()
    if (!root) throw new MediaInputError('找不到产出目录：世界还没绑定，也没配置 media.outputDir')
    const inputExt = extname(inputAbsolute)
    const base = sanitizeName(basename(inputAbsolute, inputExt))
    if (op === 'frames') return join(root, `${base}-frames`)
    if (op === 'gif') return join(root, `${base}.gif`)
    const suffix = OUTPUT_SUFFIX[op] || ''
    return join(root, `${base}${suffix}${inputExt || '.mp4'}`)
  }

  /** 找包、加载模块、取工具定义。没装和装坏要分开说。 */
  async function toolFor(op) {
    let located
    try {
      located = findDependency()
    } catch (error) {
      throw new MediaUnavailableError(`找不到 dsh-ffmpeg：${error?.message || error}`)
    }
    if (!located || located.found !== true || !located.path) throw new MediaUnavailableError()
    const dir = String(located.path)
    if (!loadedModule || loadedFrom !== dir) {
      try {
        loadedModule = await importTools(dir)
        loadedFrom = dir
      } catch (error) {
        throw new Error(`dsh-ffmpeg 装是装了，但加载失败：${error?.message || error}`)
      }
    }
    if (typeof loadedModule?.buildFfmpegTools !== 'function') {
      throw new Error('dsh-ffmpeg 的 lib/tools.js 没有导出 buildFfmpegTools（版本不兼容）')
    }
    const cfg = mediaConfig()
    // overwrite 固定 false：宁可多出一个 _1 副本，也不覆盖主人已有的文件。
    const list = loadedModule.buildFfmpegTools({
      ffmpegPath: cfg.ffmpegPath,
      ffprobePath: cfg.ffprobePath,
      timeoutMs: cfg.timeoutMs,
      graceMs: 15000,
      overwrite: false,
    }, runner)
    const tool = (Array.isArray(list) ? list : []).find((item) => item?.name === TOOL_NAMES[op])
    if (!tool) throw new Error(`dsh-ffmpeg 里没有 ${TOOL_NAMES[op]}（版本太新或太旧）`)
    return { tool, version: String(located.version || '') }
  }

  function successContent(op, value) {
    if (op === 'probe') return `媒体信息：${value?.summary || '（没有摘要）'}`
    if (op === 'frames') return `抽帧完成：共 ${value?.count ?? 0} 张，输出目录 ${value?.outputDir || ''}`
    if (op === 'health') {
      const checks = Array.isArray(value?.checks) ? value.checks : []
      return checks.length
        ? 'dsh-ffmpeg 自检：\n' + checks.map((item) => `- ${item.name}：${item.ok ? '可用 ' + (item.version || '') : '不可用 ' + (item.detail || '')}`).join('\n')
        : 'dsh-ffmpeg 自检完成'
    }
    const ops = Array.isArray(value?.ops) && value.ops.length ? `（${value.ops.join('，')}）` : ''
    return `视频已处理好：${value?.output || ''}${ops}`
  }

  /**
   * 执行一个视频操作。永不抛错：失败一律返回 `{ ok: false, error }`（中文原因）。
   * 成功返回 `{ ok: true, op, output?, summary?, durationMs, content, ...上游字段 }`。
   */
  async function run(rawArgs = {}) {
    const op = pickString(rawArgs?.op)
    if (!VIDEO_OPS.includes(op)) {
      return {
        ok: false,
        error: `不认识的视频操作：${op || '（空）'}。可用：${VIDEO_OPS.join(' / ')}。`,
      }
    }
    if (busy) {
      return { ok: false, error: '已经有一个视频任务在跑，等它完成再试（同一时间只允许一个 ffmpeg 任务）。' }
    }
    busy = true
    const startedAt = Date.now()
    try {
      const { tool } = await toolFor(op)

      // 参数白名单直接取上游定义；produce 类额外认 output（frames 认 outputDir / output 别名）。
      const allowed = new Set(Object.keys(tool.parameters?.properties || {}))
      if (PRODUCE_OPS.has(op)) allowed.add('output')
      const payload = {}
      const unknown = []
      for (const [key, value] of Object.entries(rawArgs || {})) {
        if (key === 'op' || key === 'action') continue
        if (!allowed.has(key)) {
          unknown.push(key)
          continue
        }
        payload[key] = value
      }
      if (unknown.length) {
        throw new MediaInputError(`不认识的参数：${unknown.join('、')}。${op} 只接受：${[...allowed].join(' / ')}`)
      }

      const cfg = mediaConfig()
      if (op === 'concat') {
        const inputs = Array.isArray(payload.inputs) ? payload.inputs : []
        if (!inputs.length) throw new MediaInputError('concat 需要 inputs：2-20 个鱼箱内的文件路径')
        payload.inputs = inputs.map((item, index) => resolveInput(item, `inputs 第 ${index + 1} 个文件`))
      } else if (op !== 'health') {
        payload.input = resolveInput(payload.input, 'input')
      }
      if (op === 'subtitle') {
        payload.subtitle = resolveInput(payload.subtitle, 'subtitle')
      }

      if (op === 'frames') {
        if (pickString(payload.output) && pickString(payload.outputDir)) {
          throw new MediaInputError('frames 只能给 output 或 outputDir 其中一个（两者都是输出目录）')
        }
        const requested = pickString(payload.output) || pickString(payload.outputDir)
        const dir = requested ? resolveOutput(requested) : defaultOutput(op, payload.input)
        payload.outputDir = dir
        delete payload.output
        mkdirSync(dir, { recursive: true })
      } else if (PRODUCE_OPS.has(op)) {
        const requested = pickString(payload.output)
        payload.output = requested ? resolveOutput(requested) : defaultOutput(op, op === 'concat' ? payload.inputs[0] : payload.input)
        mkdirSync(dirname(payload.output), { recursive: true })
      }

      const value = await tool.execute(payload, {})
      if (op === 'health' && value?.ok !== true) {
        const checks = Array.isArray(value?.checks) ? value.checks : []
        const bad = checks.filter((item) => item?.ok !== true).map((item) => `${item.name}：${item.detail || '不可用'}`)
        return {
          ok: false,
          op,
          error: `ffmpeg 自检没通过：${bad.join('；') || '原因没返回'}（可在 media.ffmpegPath / media.ffprobePath 指定路径）`,
          durationMs: Date.now() - startedAt,
        }
      }

      return {
        ...(value && typeof value === 'object' ? value : {}),
        // 契约里「产出在哪」统一叫 output；frames 上游叫 outputDir，这里补一个同义字段。
        ...(op === 'frames' ? { output: value?.outputDir } : {}),
        ok: true,
        op,
        content: successContent(op, value),
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      const message = String(error?.message || error)
      if (error instanceof MediaUnavailableError) return { ok: false, op, error: error.message, durationMs: Date.now() - startedAt }
      if (error instanceof MediaInputError) return { ok: false, op, error: message, durationMs: Date.now() - startedAt }
      try { logger?.warn?.(`fish-world: 视频 ${op} 失败：${message}`) } catch {}
      return { ok: false, op, error: `视频 ${op} 没做成：${message}`, durationMs: Date.now() - startedAt }
    } finally {
      busy = false
    }
  }

  /** 面板 / 自检用的只读快照：装没装、版本、额度、正在忙不忙。 */
  function status() {
    const cfg = mediaConfig()
    let located = null
    let error = ''
    try {
      located = findDependency()
    } catch (findError) {
      error = String(findError?.message || findError)
    }
    const installed = Boolean(located && located.found === true && located.path)
    return {
      ok: installed,
      installed,
      version: installed ? String(located.version || '') : '',
      ops: [...VIDEO_OPS],
      busy,
      ffmpegPath: cfg.ffmpegPath,
      ffprobePath: cfg.ffprobePath,
      timeoutMs: cfg.timeoutMs,
      maxInputMB: cfg.maxInputMB,
      outputDir: (() => {
        try { return outputRoot() } catch { return '' }
      })(),
      sandboxRoot: (() => {
        try { return sandbox?.root?.() || '' } catch { return '' }
      })(),
      error: installed ? '' : (error || MISSING_MESSAGE),
    }
  }

  return { run, status }
}

export const __test = { sanitizeName, createCollector, TOOL_NAMES, OUTPUT_SUFFIX, MISSING_MESSAGE }
