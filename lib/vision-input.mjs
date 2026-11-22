// 平台适配与归一化（2026-11-22 主人方案 §三 的第 1、2 层）。
//
// ── 分工 ──
//   平台适配器：每平台一个，**互不认识**。只把本平台的原始输入摊成统一结构
//               { source, who, when, text, files[], raw_id }
//   归一化：    files[] 里的一项 → { sha256, kind, path, bytes }
//               本地路径 / 网络地址 / 已有字节三种形态，**必须算出同一个 sha256**
//   管线：      lib/vision.mjs 只认归一化后的文件，不认平台
//
// ── 为什么「只算一次」是机制不是约定 ──
// vision.mjs 的缓存键 = sha256 + focus + 模型版本。所以只要三个平台都走到这里、
// 算出来的 sha256 相同，就必然命中同一条缓存 —— 不需要任何平台之间互相知道。
// 这也是「新增一个假平台适配器、不动视觉代码」就能被识别的判据来源。
//
// ── 为什么要落盘成文件 ──
// vision.mjs 的入口是**文件路径**（要算 sha256、要交给 ffmpeg）。
// QQ 给的是 url、面板给的是 base64 —— 这两种都得先落成文件才能进管线。
// 落盘位置由调用方给（inputDir），默认不猜路径。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import { kindOf as kindOfFile, renderForContext } from './vision.mjs'

/** 单个文件的大小上限：QQ 图 8MB、视频 40MB 都在这个数之下。 */
export const MAX_FILE_BYTES = 40 * 1024 * 1024

/** 归一化认识的三种形态。 */
const FORMS = ['path', 'url', 'bytes']

/**
 * 按文件名判类型。**类型表只有一份** —— 直接问 vision.mjs（它才是要认文件的那层）。
 * 自己再抄一张表的代价已经吃过一次：归一化不认 `.silk`，QQ 语音在进管线前就被拒了。
 *
 * @returns {'image'|'video'|'audio'|''} 判不出返回空串，调用方据此拒绝，不猜
 */
export function kindOfName(name) {
  try {
    // kindOf 认不出会抛，这里吞成空串 —— 「判不出」是正常分支不是错误。
    return kindOfFile(String(name || ''))
  } catch {
    return ''
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function pick(value, fallback) {
  return value == null || value === '' ? fallback : value
}

/**
 * 造一条统一结构。**只在这里校验**，各平台适配器照着填就行。
 *
 * @param {object} raw
 * @param {string} raw.source   平台名（qq / session / desktop / …），只进 source 字段
 * @param {string} [raw.who]    谁发的
 * @param {number|string} [raw.when]
 * @param {string} [raw.text]   这条消息的文字部分
 * @param {Array} [raw.files]   附件：{ path } / { url } / { bytes } / dataURL 字符串
 * @param {string} [raw.raw_id] 平台自己的消息 id
 * @returns {{source:string, who:string, when:number, text:string, files:Array, raw_id:string}}
 */
export function makeEntry(raw) {
  const src = String(raw?.source || '').trim()
  if (!src) throw new Error('统一结构必须带 source（是哪个平台来的）')
  const files = Array.isArray(raw?.files) ? raw.files.filter(Boolean) : []
  return {
    source: src,
    who: String(pick(raw?.who, '')),
    when: Number(pick(raw?.when, 0)) || 0,
    text: String(pick(raw?.text, '')),
    files,
    raw_id: String(pick(raw?.raw_id, ''))
  }
}

/** dataURL → Buffer；不是 dataURL 返回 null。 */
function decodeDataUrl(value) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(String(value || ''))
  if (!m) return null
  if (!m[2]) return Buffer.from(decodeURIComponent(m[3]), 'utf8')
  try { return Buffer.from(m[3].replace(/\s/g, ''), 'base64') } catch { return null }
}

/**
 * 归一化一项文件输入。
 *
 * 三种形态殊途同归：**都先变成字节**，再算 sha256、判 kind、落成 path。
 * 这样「同一份内容换个平台来」必然得到同一个 sha256 —— 缓存共享的前提。
 *
 * @param {object|string} file  { path } / { url } / { bytes } / dataURL 字符串
 * @param {object} deps
 * @param {string} deps.inputDir  落盘目录（path/url 形态要写文件才能进管线）
 * @param {Function} [deps.fetchImpl]
 * @param {number} [deps.maxBytes]
 * @returns {Promise<{sha256:string, kind:string, path:string, bytes:number, form:string}>}
 */
export async function normalizeFile(file, { inputDir, fetchImpl, maxBytes = MAX_FILE_BYTES } = {}) {
  if (!inputDir) throw new Error('归一化需要落盘目录（inputDir）')

  let raw = file
  let form = ''
  if (typeof file === 'string') {
    const data = decodeDataUrl(file)
    // dataURL 解出来就是字节，form 直接记 bytes —— 后面的分支只认三种形态。
    if (data) { raw = { bytes: data }; form = 'bytes' }
    else if (/^https?:\/\//i.test(file)) { raw = { url: file }; form = 'url' }
    else { raw = { path: file }; form = 'path' }
  } else if (raw && typeof raw === 'object') {
    if (Buffer.isBuffer(raw.bytes) || ArrayBuffer.isView(raw.bytes)) form = 'bytes'
    else if (raw.url) form = 'url'
    else if (raw.path) form = 'path'
    else {
      const data = decodeDataUrl(raw.dataUrl || raw.data)
      if (data) { raw = { bytes: data }; form = 'bytes' }
    }
  }
  if (!form || !FORMS.includes(form)) {
    throw new Error('认不出这个文件形态（要 path / url / bytes / dataURL）')
  }

  let bytes
  let source = ''

  if (form === 'path') {
    const p = String(raw.path)
    if (!existsSync(p)) throw new Error('文件不存在：' + p)
    let size = 0
    try { size = statSync(p).size } catch (error) { throw new Error('读不到文件：' + String(error?.message || error)) }
    if (size > maxBytes) throw new Error(`文件太大（${Math.round(size / 1024 / 1024)}MB，上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
    try { bytes = readFileSync(p) } catch (error) { throw new Error('读文件失败：' + String(error?.message || error)) }
    source = p
  } else if (form === 'bytes') {
    bytes = Buffer.isBuffer(raw.bytes) ? raw.bytes : Buffer.from(raw.bytes)
    if (!bytes.length) throw new Error('文件内容是空的')
    if (bytes.length > maxBytes) throw new Error(`文件太大（${Math.round(bytes.length / 1024 / 1024)}MB，上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
  } else {
    const url = String(raw.url)
    if (!/^https?:\/\//i.test(url)) throw new Error('只认 HTTP(S) 地址')
    const doFetch = fetchImpl || globalThis.fetch
    if (typeof doFetch !== 'function') throw new Error('当前运行时没有 fetch，下载不了这个地址')
    const response = await doFetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new Error('文件太大，不下（远端声明超过上限）')
    bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) throw new Error('下载回来是空的')
    if (bytes.length > maxBytes) throw new Error(`文件太大（${Math.round(bytes.length / 1024 / 1024)}MB，上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
    source = url
  }

  const sha256 = sha256Hex(bytes)
  // 名字的取法按形态来：路径用路径、地址用地址的末段（QQ 的语音地址是 /v.silk 这种，
  // 拿不到扩展名就判不出类型 —— 只剩文件头猜，而音频的文件头最难猜）。
  const fallbackName = form === 'path'
    ? raw.path
    : form === 'url'
      ? (() => { try { return decodeURIComponent(new URL(raw.url).pathname) } catch { return '' } })()
      : ''
  const givenName = String(raw.name || fallbackName || '').split(/[\\/]/).pop() || ''
  const ext = (extname(givenName) || guessExt(bytes)).toLowerCase()
  const kind = kindOfName(givenName || 'x' + ext)
  if (!kind) throw new Error(`看不出这是什么类型的文件（${ext || '没有扩展名'}）`)

  // 已经是本地文件就别再拷一份；url / bytes 才落盘。
  // 落盘名用 sha256 ⇒ 同一份内容永远落到同一个文件，重复下载也不会越积越多。
  let path = form === 'path' ? source : ''
  if (!path) {
    try { mkdirSync(inputDir, { recursive: true }) } catch {}
    path = join(inputDir, sha256 + ext)
    if (!existsSync(path)) {
      try { writeFileSync(path, bytes) } catch (error) {
        throw new Error('落盘失败：' + String(error?.message || error))
      }
    }
  }

  return { sha256, kind, path, bytes: bytes.length, form, source }
}

/** 没有扩展名时按文件头猜一个（只用来决定落盘后缀，不进 kind 判定）。 */
function guessExt(bytes) {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return '.gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return '.webp'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return '.mp4'
  if (bytes[0] === 0x4f && bytes[1] === 0x67) return '.ogg'
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return '.mp3'
  if (bytes.toString('ascii', 0, 4) === 'RIFF') return '.wav'
  return ''
}

/**
 * 建「平台 → 管线」的入口。
 *
 * @param {object} opts
 * @param {object} opts.vision      lib/vision.mjs 的实例（describe / describeImage / …）
 * @param {string} opts.inputDir    归一化落盘目录
 * @param {Function} [opts.fetchImpl]
 * @param {object} [opts.logger]
 * @param {Function} [opts.render]  上下文行渲染器（默认 vision.mjs 的 renderForContext）
 */
export function createVisionInput({ vision, inputDir, fetchImpl, logger, render } = {}) {
  if (!vision) throw new Error('平台适配层要接一个视觉管线实例')
  if (!inputDir) throw new Error('平台适配层要给落盘目录（inputDir）')

  const adapters = new Map()

  /**
   * 登记一个平台适配器。**新平台只加这一个函数，不碰视觉代码** ——
   * 这就是方案验收 (f) 要的「平台无关」。
   *
   * @param {string} source 平台名
   * @param {(raw:any) => object|Promise<object>} fn 把平台原始输入摊成统一结构
   */
  function register(source, fn) {
    const name = String(source || '').trim()
    if (!name) throw new Error('平台名不能为空')
    if (typeof fn !== 'function') throw new Error('适配器必须是函数')
    adapters.set(name, fn)
    return () => adapters.delete(name)
  }

  function has(source) { return adapters.has(String(source)) }

  /**
   * 走一条消息：适配 → 归一化 → 管线 → 统一输出。
   *
   * 平台信息**只留在 entry.source**，不进描述正文 —— 同一张图在哪看都是同一句话。
   *
   * @param {string} source 平台名
   * @param {any} raw       该平台的原始输入（交给适配器）
   * @param {object} [opts]
   * @param {string} [opts.focus] 问图什么（进了缓存键，不同问题不互相顶掉）
   * @param {object} [opts.meta]   附加给适配器的 { who, when, text, raw_id }
   *                              （raw 里没这些字段的平台，比如粘贴的附件块，从这里带）
   * @returns {Promise<{entry:object, files:Array, results:Array, lines:string[]}>}
   */
  async function ingest(source, raw, { focus = '', meta } = {}) {
    const name = String(source)
    const adapter = adapters.get(name)
    if (!adapter) throw new Error(`没登记平台「${name}」的适配器（已登记：${[...adapters.keys()].join('、') || '无'}）`)

    const entry = makeEntry(await adapter(raw, meta))
    const files = []
    const results = []

    for (const item of entry.files.slice(0, 8)) {
      let norm
      try {
        norm = await normalizeFile(item, { inputDir, fetchImpl })
      } catch (error) {
        // 一个附件坏了不拖垮整条消息：记下来，其余照走。
        try { logger?.warn?.(`fish-world: 视觉输入归一化失败（${name}）：${String(error?.message || error)}`) } catch {}
        files.push({ ok: false, error: String(error?.message || error) })
        continue
      }
      files.push({ ok: true, ...norm })

      try {
        const result = await vision.describe(norm.path, { focus })
        results.push({ ...norm, result })
      } catch (error) {
        // 管线本身抛错（缺依赖 / 文件没了）：如实带出来，不当成没发生。
        results.push({ ...norm, error: String(error?.message || error) })
      }
    }

    const lines = results
      .filter((r) => r.result)
      .map((r) => renderLine(r.result))

    return { entry, files, results, lines }
  }

  function renderLine(result) {
    if (typeof render === 'function') return render(result)
    // 默认走 vision.mjs 自己的渲染器 —— 格式只有一处定义。
    try { return renderForContext(result) } catch { return '' }
  }

  /** 已登记的平台（面板/排查用）。 */
  function platforms() { return [...adapters.keys()] }

  return { register, has, ingest, platforms }
}
