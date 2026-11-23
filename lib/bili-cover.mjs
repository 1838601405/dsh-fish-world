// B 站封面 → 视觉管线（2026-11-22 主人方案 P4）。
//
// ── 为什么要有这一层 ──
// 方案 P4 判据：「B站封面和 QQ 里同一张图命中同一缓存」。
// 封面进管线这件事本身很简单，难的是**别在这里重造一遍**：
//   · 下载 / 算 sha256 / 判类型 / 落盘 → 全交给 lib/vision-input.mjs 的 normalizeFile
//     （QQ 收图、空间配图、桌面拖入走的是同一个，sha256 才会撞到一起）
//   · 描述 → 交给 lib/vision.mjs 的管线（缓存键 sha256+focus+模型版本）
// 这里只做 B 站特有的那部分：**按 BV 拿到封面地址**。
//
// ── 不需要 B 站凭据（2026-11-22 实测） ──
// `x/web-interface/view` 对公开视频不校验 cookie，带 UA + referer 就返回 code=0。
// 仓外的 `dsh-bili-whale/tools/diagnostics/fetch-covers.mjs` 要读 credentials，
// 那是因为它顺手还要抓需要登录的接口；我们只要 `data.pic`，不必背那份依赖。
// 拿不到（下架/私链/BV 写错）就如实报 code 与 message，不猜封面地址。
//
// ── 边界 ──
//  · 只认 BV 号形态（BV + 10 位），别的（av号、纯链接）先不接 —— 接了就要处理
//    av↔BV 换算，那是另一件事；
//  · 不缓存「BV → 封面 URL」这一步（视频换封面是常态，URL 会过期），
//    缓存交给管线按图片字节算 —— 同一张封面字节不管从哪个 BV 来都是同一个键。

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeFile } from './vision-input.mjs'

const API = 'https://api.bilibili.com/x/web-interface/view'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
const TIMEOUT_MS = 15000

/** 已下载视频的扩展名（dsh-bili-whale 落的 mp4 为主）。 */
const VIDEO_EXT = ['.mp4', '.mkv', '.flv', '.webm', '.ts']

/** BV 号形态：BV + 10 位字母数字（B 站现行规则）。 */
const BV_RE = /^BV[0-9A-Za-z]{10}$/

/** 从一段文本里抠出第一个合法 BV 号；抠不到返回空串。 */
export function findBv(text) {
  const s = String(text || '')
  // ★ 后面不能紧跟字母数字：`BV139HA6JEE66`（11 位）里确实内含一个合法的 10 位前缀，
  //   不加这条边界就会把多打一位的错误 BV 当成真的发出去。
  //   `?p=1`、`/`、空格这些正常结尾不受影响。
  const m = s.match(/BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/g)
  if (!m) return ''
  for (const cand of m) if (BV_RE.test(cand)) return cand
  return ''
}

/** 校验 BV 号；不合法就抛（调用方据此拒绝，不发无效请求）。 */
export function assertBv(bv) {
  const s = String(bv || '').trim()
  if (!BV_RE.test(s)) throw new Error(`「${s || '(空)'}」不是合法的 BV 号（BV + 10 位）`)
  return s
}

/**
 * 建一个 B 站封面取用器。
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  注入 fetch（测试用；默认走全局）
 * @param {string} opts.inputDir       归一化落盘目录（必须给，normalizeFile 不猜路径）
 * @param {object} [opts.logger]
 * @param {Function} [opts.onCover]    拿到封面文件后的回调（{sha256, path, kind, bytes, meta}）
 *                                    —— 由调用方决定要不要接着走管线，这里不擅自花钱
 */
export function createBiliCover({ home, fetchImpl, inputDir, logger, onCover, videoDir } = {}) {
  if (!inputDir) throw new Error('B 站封面要给落盘目录（inputDir），归一化层不猜路径')
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前运行时没有 fetch')
  // ★ 抽帧不重新下载视频 —— dsh-bili-whale 已经把片落在 $DSH_HOME/shots/video，文件名以 BV 开头
  //   （实测：BV139HA6JEE6-2026-11-22T03-08-43-195Z.mp4）。路径从 home 派生，不写死本机路径（AGENTS 0⑤）。
  const 看片目录 = videoDir || (home ? join(String(home), 'shots', 'video') : '')

  /**
   * 按 BV 拿视频元信息（含封面地址）。
   * @returns {Promise<{bv:string, title:string, cover:string, duration:number, owner:string}>}
   */
  async function meta(bv) {
    const id = assertBv(bv)
    let res
    try {
      res = await doFetch(`${API}?bvid=${id}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`问 B 站拿视频信息失败：${String(error?.message || error)}`)
    }
    if (!res.ok) throw new Error(`问 B 站拿视频信息失败（HTTP ${res.status}）`)

    let body
    try { body = await res.json() } catch (error) {
      throw new Error(`B 站回的不是 JSON：${String(error?.message || error)}`)
    }
    // B 站的「失败」也是 HTTP 200 + code!=0，只能看 code（老坑，别只看 status）。
    if (body?.code !== 0) {
      throw new Error(`B 站说读不到这个视频（code=${body?.code} ${body?.message || ''}，BV=${id}）`)
    }
    const data = body.data || {}
    const cover = String(data.pic || '').trim()
    if (!cover) throw new Error(`B 站没给封面地址（BV=${id}）`)

    return {
      bv: id,
      title: String(data.title || ''),
      cover,
      duration: Number(data.duration) || 0,
      owner: String(data.owner?.name || ''),
    }
  }

  /**
   * 下载封面并归一化成管线能吃的文件。
   * @returns {Promise<{sha256, kind, path, bytes, meta}>}
   */
  async function cover(bv) {
    const info = await meta(bv)
    let res
    try {
      res = await doFetch(info.cover, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`下载封面失败：${String(error?.message || error)}`)
    }
    if (!res.ok) throw new Error(`下载封面失败（HTTP ${res.status}）`)

    // ★ 必须用 arrayBuffer：response.text() 会按 UTF-8 解码，把 JPEG 字节打烂
    //   （实测拿到的头会变成 fdfdfdfd 而不是 ffd8ff）。
    const bytes = Buffer.from(await res.arrayBuffer())
    if (!bytes.length) throw new Error('下载回来的封面是空的')

    const norm = await normalizeFile({ bytes, name: 'bili-cover.jpg' }, { inputDir })
    const out = { ...norm, meta: info }
    if (typeof onCover === 'function') {
      try { await onCover(out) } catch (error) {
        // 回调失败不影响「封面拿到了」这件事 —— 只记一笔。
        try { logger?.warn?.(`fish-world: B站封面回调失败：${String(error?.message || error)}`) } catch {}
      }
    }
    return out
  }

  /**
   * 拿封面 → 走视觉管线出描述。
   *
   * ★ 缓存由管线负责：同一张封面字节，不管从哪个 BV、还是从 QQ 收到同一张图，
   *   sha256 相同 ⇒ 同一个缓存键 ⇒ 只算一次（方案 P4 判据）。
   *
   * @param {string} bv
   * @param {object} opts
   * @param {object} opts.vision  视觉管线实例（createVision 的返回值）
   * @param {string} [opts.focus] 问图什么（进缓存键）
   * @returns {Promise<{id, kind, text, timeline?, tags, cached, model, at, meta}>}
   */
  async function describe(bv, { vision, focus = '' } = {}) {
    if (!vision || typeof vision.describeImage !== 'function') {
      throw new Error('要给视觉管线实例（vision），否则封面没地方描述')
    }
    const got = await cover(bv)
    const said = await vision.describeImage(got.path, {
      focus: focus || '这是 B 站视频的封面，用一句中文说清画面主体。',
    })
    return { ...said, meta: got.meta, sha256: got.sha256 }
  }

  /**
   * 找这个 BV 已经下载好的视频文件（没有就返回 null，**不自己下载**）。
   *
   * ★ 方案 P4 要的是「封面/抽帧」两件事，光看封面等于只看了海报。
   *   视频由 dsh-bili-whale 负责下载（它有 cookie、有 onConflict 语义），我复用它的产物：
   *   文件名以 BV 开头，所以按前缀找，命中多个（分 P / 多次下载）取最新的那个。
   *
   * @param {string} bv
   * @returns {{path:string,name:string,size:number}|null}
   */
  function findVideo(bv) {
    const id = assertBv(bv)
    if (!看片目录) throw new Error('要给 home 或 videoDir 才知道去哪找视频（不猜路径）')
    let names
    try { names = readdirSync(看片目录) } catch { return null }   // 目录不在 = 一条都没下载过
    const hit = names
      .filter((n) => n.startsWith(id) && VIDEO_EXT.some((e) => n.toLowerCase().endsWith(e)))
      .map((n) => {
        try { const st = statSync(join(看片目录, n)); return { path: join(看片目录, n), name: n, size: st.size, mtime: st.mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    if (!hit.length) return null
    const { mtime, ...rest } = hit[0]
    return rest
  }

  /**
   * ★ **看视频本身**（抽帧），不是只看封面 —— 方案 P4「封面/抽帧」的后半句。
   *
   * 复用已下载的片 + 已有的视觉管线（lib/vision.mjs 的 describeVideo：
   * probe 片长 → 宫格抽 6–8 帧 → 看图通道出按时间顺序的摘要）。
   * 缓存按视频文件字节算，同片第二次直接命中。
   *
   * @param {string} bv
   * @param {object} opts
   * @param {object} opts.vision  视觉管线实例
   * @param {string} [opts.focus] 问视频什么（进缓存键）
   * @param {number} [opts.count] 抽几帧（默认走管线的 7）
   * @returns {Promise<{id, kind, text, timeline?, tags, cached, model, at, meta}>}
   * @throws 视频没下载过 / 要给 home / 没给 vision —— 各自明说，不猜
   */
  async function describeVideo(bv, { vision, focus = '', count } = {}) {
    if (!vision || typeof vision.describeVideo !== 'function') {
      throw new Error('要给视觉管线实例（vision），否则抽帧结果没地方放')
    }
    const id = assertBv(bv)
    const hit = findVideo(id)
    if (!hit) {
      throw new Error(`B 站视频还没下载到本地（${看片目录 || '没有看片目录'} 里没有 ${id} 开头的片子）—— 抽帧要先有片，dsh-bili-whale 负责下载`)
    }
    // 元信息拿不到不挡路：视频本身才是主体
    const info = await meta(id).catch(() => null)
    const said = await vision.describeVideo(hit.path, {
      focus: focus || `这是 B 站视频（${id}）的画面，按时间顺序说清发生了什么变化。`,
      ...(count ? { count } : {}),
    })
    return { ...said, meta: info, video: hit.name }
  }

  return { meta, cover, describe, findVideo, describeVideo, findBv, assertBv }
}
