// 视觉管线的识别后端：把 @ztr66/dsh-omni 的 lib 接到 lib/vision.mjs 的 recognize 契约上。
//
// ── 为什么要单独一个文件 ──
// vision.mjs 只认 { describe, video, audio } 三个方法，不认平台也不认厂商。
// 换底层（omni → 别的）只改这里，管线与缓存一行不动。
//
// ── omni 给什么、不给什么 ──
//   视频：renderGrid 抽帧拼宫格 + 时间轴（只依赖 PATH 上的 ffmpeg）
//   语音：transcribeAudio 走本地 faster-whisper（只依赖 Python 里那几个库）
//   图片：omni 只有 image_generate（生成），**没有看图** ⇒ describe 是个插槽，
//         由调用方注入看图通道；没注入就如实报「没接看图通道」，不编内容。
//
// ── 找包 ──
// 复用 env.mjs 的 resolveDependency（先 profile 的 node_modules，再退回 Node 解析）。
// omni 的 package.json `exports` 只有 "."，子路径 import 会被挡 ⇒ 必须 pathToFileURL。

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveDependency } from './env.mjs'

/** 要找的包名。 */
export const OMNI_PACKAGE = '@ztr66/dsh-omni'

/** 视频默认抽几格 —— 对齐 vision.mjs 的 DEFAULT_FRAMES（主人定的 6–8）。 */
export const DEFAULT_GRID_CELLS = 7

/** 格数上限：vision.mjs 把 frames 夹到 12，这里再夹一次（直接调本模块也别逐帧）。 */
export const MAX_GRID_CELLS = 12

/** 网格图默认落点：系统临时目录下的一层，跨平台、不写死盘符。 */
const DEFAULT_GRID_FOLDER = 'fish-vision-grid'

/** 网格图保留多久（超过就清，免得临时目录被撑满）。 */
const GRID_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const HINT_FFMPEG = '装法：winget install Gyan.FFmpeg（或把 ffmpeg、ffprobe 放进 PATH）'
const HINT_OMNI = `装法：dsh plugin add ${OMNI_PACKAGE}`

/** 缺可执行文件的特征。omni 把 spawn 的错误原样带回来，所以只认 ENOENT。 */
function isMissingBinary(raw) {
  return /\bENOENT\b/i.test(String(raw || ''))
}

/** 把 omni 的英文错误翻成「缺什么、怎么装」，不吞原文。 */
function probeError(raw) {
  const text = String(raw || '').trim()
  if (isMissingBinary(text)) return new Error(`缺 ffmpeg / ffprobe，读不了这个文件。${HINT_FFMPEG}`)
  if (/\bEPERM\b/i.test(text)) return new Error(`起 ffmpeg 被系统拦下来了（EPERM）：${text}`)
  if (/file not found/i.test(text)) return new Error(`文件不存在：${text}`)
  return new Error(`读不了这个媒体文件：${text || '（没给出原因）'}`)
}

function gridError(raw, detail) {
  const text = String(raw || '').trim()
  if (isMissingBinary(text)) return new Error(`缺 ffmpeg，抽不了帧。${HINT_FFMPEG}`)
  const tail = String(detail || '').trim()
  return new Error(`抽帧失败：${text || '（没给出原因）'}${tail ? `｜${tail.slice(-300)}` : ''}`)
}

/** 抽单帧失败（video.mjs 那条链路用）。和 gridError 分开，措辞按调用方场景来。 */
function framesError(raw, detail) {
  const text = String(raw || '').trim()
  if (isMissingBinary(text)) return new Error(`缺 ffmpeg，抽不了帧。${HINT_FFMPEG}`)
  if (/file not found/i.test(text)) return new Error(`文件不存在：${text}`)
  if (/at is required|no moments/i.test(text)) return new Error('没给要抽的时间点')
  if (/past the end of the file/i.test(text)) return new Error(`要抽的时间点超出了片长：${text}`)
  const tail = String(detail || '').trim()
  return new Error(`一帧都没抽出来：${text || '（没给出原因）'}${tail ? `｜${tail.slice(-300)}` : ''}`)
}

function audioError(result) {
  const text = String(result?.error || '').trim()
  const install = String(result?.install || '').trim()
  const hint = String(result?.hint || '').trim()
  const parts = [`语音转写失败：${text || '（没给出原因）'}`]
  if (install) parts.push(install)
  if (hint) parts.push(hint)
  if (result?.detail) parts.push(String(result.detail).trim().slice(-300))
  return new Error(parts.join('｜'))
}

/** 格数夹到 1..12。给了垃圾值就落回默认，不抛 —— 这是参数容错，不是错误。 */
function clampCells(frames) {
  const n = Number(frames)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GRID_CELLS
  return Math.max(1, Math.min(MAX_GRID_CELLS, Math.round(n)))
}

/** 时长 → 「8.1 秒」。ffprobe 拿不到时长就说时长未知，不猜。 */
function durationLabel(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? `${seconds.toFixed(1)} 秒`
    : '时长未知'
}

/**
 * 看图通道的**身份**（进缓存键，见 modelVersion）。
 *
 * 两种来源：
 *  · `channelId` —— 通道自己声明的（`vision-wire.channelFromConfig` 打的是 `baseUrl|model`），
 *    换地址/换模型就换身份，**换了通道必须换缓存**。
 *  · 没声明 —— 用函数源码前 40 字符当身份：同一段代码算同一个通道，
 *    两处不同实现（哪怕长得像）会算成两个通道，宁可多算一次也别串缓存。
 *
 * @param {Function|undefined} fn
 * @returns {string} 空串表示「没有通道」
 */
function describeId(fn) {
  if (typeof fn !== 'function') return ''
  const declared = fn.channelId
  if (declared) return String(declared)
  try { return 'inline:' + String(fn).replace(/\s+/g, ' ').trim().slice(0, 40) } catch { return 'inline' }
}

/**
 * 建一个识别后端，形状就是 vision.mjs 要的 { describe, video, audio }。
 *
 * @param {object} [opts]
 * @param {string} [opts.home]          DSH_HOME（给 resolveDependency 定位 profile）
 * @param {string} [opts.profile]       profile 名
 * @param {Function} [opts.locate]      找包的替身（测试注入用）
 * @param {Function} [opts.loadLibs]    载入 omni lib 的替身：(hit) => {scan,audio,ffmpeg,version}
 *                                      （测试注入用；不给就按 locate 到的路径真 import）
 * @param {Function} [opts.describe]    看图通道：(file, {focus}) => Promise<{text, tags?}>
 *                                      **omni 不看图**，这一层必须由调用方给；不给就如实报。
 * @param {object} [opts.config]        omni 插件配置：{ ffmpegPath, pythonPath, asr:{mode,localModel} }
 * @param {string} [opts.language]      转写语言，默认 zh
 * @param {string} [opts.gridDir]       宫格图落点，默认 <系统临时目录>/fish-vision-grid
 * @param {object} [opts.logger]
 */
export function createOmniRecognize({
  home,
  profile,
  locate = resolveDependency,
  loadLibs,
  describe: describeChannel,
  config = {},
  language = 'zh',
  gridDir = '',
  logger
} = {}) {
  const locateArgs = { ...(home ? { home } : {}), ...(profile ? { profile } : {}) }

  /** omni 包定位只算一次（找包要打几次文件系统）。 */
  let located = null
  function locateOmni() {
    if (located !== null) return located
    try {
      located = locate(OMNI_PACKAGE, locateArgs) || { found: false }
    } catch (error) {
      located = { found: false, error: String(error?.message || error) }
    }
    return located
  }

  /** omni 的 lib 只 import 一次（import 有模块级副作用，别每次调用都跑）。 */
  let libs = null
  async function loadOmni() {
    if (libs) return libs
    const hit = locateOmni()
    if (hit?.found !== true) {
      const why = hit?.error ? `（${hit.error}）` : ''
      throw new Error(`${OMNI_PACKAGE} 没装${why}，视频与语音识别都不可用。${HINT_OMNI}`)
    }
    // 测试注入的替身直接用；没注入就按 locate 到的路径真 import。
    // 两条路都可能失败，失败要带原始原因，别把「装了但加载失败」这句吃掉。
    try {
      if (typeof loadLibs === 'function') {
        libs = await loadLibs(hit)
        return libs
      }
      const base = pathToFileURL(join(hit.path, 'lib')).href
      const [scan, audio, ffmpeg, frames] = await Promise.all([
        import(`${base}/scan.js`),
        import(`${base}/audio.js`),
        import(`${base}/ffmpeg.js`),
        import(`${base}/frames.js`)
      ])
      libs = { scan, audio, ffmpeg, frames, version: String(hit.version || '') }
      return libs
    } catch (error) {
      throw new Error(`${OMNI_PACKAGE} 装了但加载失败：${String(error?.message || error)}`)
    }
  }

  /** omni 自己的配置形状（它的 lib 只认这几个键）。 */
  function omniConfig() {
    const asr = config?.asr || {}
    return {
      ffmpegPath: String(config?.ffmpegPath || ''),
      pythonPath: String(config?.pythonPath || ''),
      asr: {
        mode: String(asr.mode || 'auto'),
        localModel: String(asr.localModel || 'small')
      }
    }
  }

  function gridFolder() {
    return gridDir || join(tmpdir(), DEFAULT_GRID_FOLDER)
  }

  /** 清掉过期宫格图。失败不影响主流程 —— 这是卫生，不是正确性。 */
  function pruneGrids(dir) {
    try {
      const cutoff = Date.now() - GRID_MAX_AGE_MS
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.png')) continue
        const file = join(dir, name)
        try {
          if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
        } catch {}
      }
    } catch {}
  }

  /**
   * 看一张图。omni 没这个能力，所以这里只是个插槽：
   * 注入了就转给注入的通道，没注入就明说没接 —— 不返回空串、不编描述。
   */
  async function describe(file, { focus = '' } = {}) {
    if (typeof describeChannel !== 'function') {
      throw new Error('没接看图通道：dsh-omni 只能生成图、不能读图，这一层要由调用方注入')
    }
    return describeChannel(file, { focus })
  }

  /**
   * 视频 → 宫格图 + 时间轴 + 一段话。
   *
   * 话从哪来：注入了看图通道就让模型看宫格（真正「说出发生了什么」）；
   * 没注入就只报量出来的事实（时长/分辨率/帧率/抽了几格），
   * 并写明画面内容没识别 —— **不猜、不编**。
   */
  async function video(file, { focus = '', frames = DEFAULT_GRID_CELLS } = {}) {
    const omni = await loadOmni()
    const cfg = omniConfig()
    const cells = clampCells(frames)

    const info = await omni.ffmpeg.probe(cfg, file)
    if (info.ok !== true) throw probeError(info.error)

    const dir = gridFolder()
    try { mkdirSync(dir, { recursive: true }) } catch {}

    // fps 给到上限是为了让 renderGrid 先取够候选帧，再由 maxCells 夹到 cells ——
    // 这样短片得到精确的 cells 格，长片也不会因为 fps 下限被撑成几十格（不逐帧）。
    const grid = await omni.scan.renderGrid(cfg, {
      input: file,
      fps: 30,
      maxCells: cells,
      cellWidth: 320,
      outDir: dir
    })
    if (grid.ok !== true) throw gridError(grid.error, grid.detail)
    pruneGrids(dir)

    const timeline = Array.isArray(grid.timeline) ? grid.timeline : []
    const tags = []

    let text = ''
    if (typeof describeChannel === 'function') {
      try {
        const said = await describeChannel(grid.path, {
          focus: focus || '按时间顺序说清这段视频里发生了什么'
        })
        text = String(said?.text == null ? '' : said.text).trim()
        if (Array.isArray(said?.tags)) tags.push(...said.tags.filter((t) => typeof t === 'string'))
      } catch (error) {
        // 看图通道坏了不否定抽帧的结果：宫格与时间轴仍然有效，退回报事实。
        try { logger?.warn?.(`fish-world: 视频看图通道失败，退回量出来的事实：${String(error?.message || error)}`) } catch {}
      }
    }

    if (!text) {
      const v = info.video || {}
      const parts = [
        durationLabel(info.duration),
        v.width && v.height ? `${v.width}×${v.height}` : '分辨率未知',
        v.fps ? `${v.fps}fps` : '帧率未知',
        `抽 ${timeline.length} 格`
      ]
      text = `${parts.join(' · ')}｜没接看图通道，画面内容没识别`
    }

    return { text, tags, timeline }
  }

  /**
   * 语音 → 转写文字 + 时间轴。
   *
   * omni 的 asr.mode=auto：宿主有识别器就用宿主，没有就回落本地 faster-whisper。
   * 转写回来是空的（这段没说话）→ 说「没听出话」，**不返回空串**（空串会被管线当成失败）。
   */
  async function audio(file, { focus = '' } = {}) {
    const omni = await loadOmni()
    // transcribeAudio 的 ctx 只用来取宿主识别器；这里传 null = 不主动要宿主的，
    // 让 omni 自己按 asr.mode 决定走哪条（取不到服务时它会正常回落本地）。
    const result = await omni.audio.transcribeAudio(null, omniConfig(), {
      input: file,
      language: String(language || 'zh')
    })
    if (result?.ok !== true) throw audioError(result)

    const text = String(result.text == null ? '' : result.text).trim()
    const segments = Array.isArray(result.segments) ? result.segments : []
    const timeline = segments
      .filter((s) => s && Number.isFinite(Number(s.start)))
      .map((s, i) => ({
        n: i + 1,
        at: Number(Number(s.start).toFixed(3)),
        label: omni.scan.formatClock(Number(s.start))
      }))

    return { text: text || '没听出话', tags: [], timeline }
  }

  /**
   * 缓存键里的模型版本。**换底层 / 换转写模型 / 接上看图通道都要变**，
   * 否则旧答案会被当成新答案（缓存键 = sha256 + focus + 这个串）。
   */
  function modelVersion() {
    const hit = locateOmni()
    const asr = String(config?.asr?.localModel || 'small')
    const omniPart = hit?.found === true ? `omni@${hit.version || '?'}` : 'omni@未装'
    // ★ 看图通道要带**身份**，不能只标「有」——
    //   缓存键 = sha256 + focus + 模型版本，而 `model` 就是这个串。
    //   只写 `+看图` 的话，换 baseUrl/换模型后串一模一样 ⇒ **换了通道却复用旧缓存**
    //   （2026-11-23 实测撞出来的：配置通道与内联 describe 都是 `+看图`，测试红、缓存也串）。
    const chan = describeId(describeChannel)
    return `${omniPart}+asr-${asr}${chan ? '+看图:' + chan : ''}`
  }

  /** 面板/排查用：包在不在、看图通道接没接。不跑子进程，纯静态。 */
  function status() {
    const hit = locateOmni()
    return {
      ok: hit?.found === true,
      package: OMNI_PACKAGE,
      version: hit?.found === true ? String(hit.version || '') : '',
      error: hit?.found === true ? '' : String(hit?.error || '没装'),
      describe: typeof describeChannel === 'function',
      model: modelVersion(),
      gridDir: gridFolder(),
      language: String(language || 'zh')
    }
  }

  /**
   * 读媒体元信息（时长 / 分辨率 / 编解码）。
   *
   * ★ 这是 P5「ffmpeg 只许在 vision 层」的出口之一：`lib/video.mjs` 以前自己
   *   `execFile(ffmpeg, ['-i', …])` 从 stderr 抠时长，现在改问这里。
   *   用 omni 的 ffprobe 路线，比从 stderr 抠文本稳（也不会因 ffmpeg版本换了格式就失效）。
   *
   * @returns {Promise<object>} omni 的 probe 结果（含 duration / video / audio / hasVideo…）
   * @throws 缺 ffprobe、文件不存在、不是媒体文件 —— 各自带原文与装法
   */
  async function probe(file) {
    const omni = await loadOmni()
    const result = await omni.ffmpeg.probe(omniConfig(), file)
    if (result?.ok !== true) throw probeError(result?.error)
    return result
  }

  /**
   * 按给定时间点抽帧，**落成文件**返回。
   *
   * ★ 同样是 P5 的出口：以前 `video.mjs` 自己一条一条 execFile ffmpeg，现在集中到这里。
   * ★ 必须给 outDir —— omni 的默认目录是 `process.cwd()/omni-frames`，
   *   那会往调用方的工作目录里塞东西（面板进程的 cwd 是宿主的，不能碰）。
   *
   * @param {string} file 视频路径
   * @param {object} opts
   * @param {number[]} opts.at     要哪几个时间点（秒）
   * @param {number} [opts.width]  单帧宽度（omni 夹在 160–3840）
   * @param {string} opts.outDir   落盘目录（必给）
   * @returns {Promise<Array<{at:number, path:string, bytes:number}>>}
   * @throws 一个都没抽到 / 缺 ffmpeg / 不是视频 —— 带原文
   */
  async function frames(file, { at, width, outDir } = {}) {
    const omni = await loadOmni()
    const moments = (Array.isArray(at) ? at : [at])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x >= 0)
    if (!moments.length) throw new Error('没给要抽的时间点')
    if (!outDir) throw new Error('抽帧要给落盘目录（outDir）')

    const result = await omni.frames.extractFrames(omniConfig(), {
      input: file,
      at: moments,
      ...(width ? { width } : {}),
      outDir,
    })

    // ★ 部分成功也算成功：omni 是一次调用抽全部，**任何一帧失败就整体 ok:false**，
    //   但会把已抽到的放进 `captured`。原来的 video.mjs 是逐帧抽、单帧失败就跳过，
    //   所以「6 个时间点里最后一个抽不到」以前只是少一帧，现在不能变成整条失败。
    //   实测：1 秒的测试片，planTimes 给的 0.95s 会 seek 到文件尾抽不出来。
    const list = result?.ok === true
      ? (Array.isArray(result.frames) ? result.frames : [])
      : (Array.isArray(result.captured) ? result.captured : [])
    if (!list.length) throw framesError(result?.error, result?.detail)

    return list.map((f) => ({
      at: Number(f.at),
      path: String(f.path),
      bytes: Number(f.bytes) || 0,
    }))
  }

  return { describe, video, audio, probe, frames, modelVersion, status }
}
