// 平台输入适配（2026-11-20 主人要求四点五之三）。
//
// 主人原话：「头像等需要上传的动作：桌面版走本地文件路径，插件版走 base64，
//            统一走平台适配器，页面不写死输入形态。」
//
// ── 这条在治什么 ──
// 同一个"换头像"，两端能拿到的东西根本不一样：
//   · 桌面版：能读本机文件 ⇒ 用户给的是**路径**
//   · 插件版（web 面板）：读不到本机文件 ⇒ 用户在页面上选完，给的是**base64**
// 如果把这套差异写死在调用点，就会出现「桌面能换、web 不能换」
// 或者「页面里写着 path 但 web 传进来的是 base64」这类只在一边复现的 bug。
//
// ── 设计 ──
// 适配器只负责一件事：**把任意形态的输入，变成协议端能吃的 payload**。
// 调用方（工具 / 面板）只给"我手上有什么"，不关心协议端要什么形态。
//
// 支持四种输入：本地路径 / 裸 base64 / dataURL / Buffer
// 输出两种形态：
//   · { form:'path', value }     —— 协议端认本地路径时用（省一次读文件）
//   · { form:'base64', value }   —— 最兼容（实测 SnowLuma 认这个）
//
// ★ 安全：路径必须过鱼箱校验（不让它读工作区外面的任意文件）。
//   校验由调用方注入 resolvePath，这里不自己拍脑袋拼路径。

import { existsSync, readFileSync, statSync } from 'node:fs'

/** 头像上限 2MB（主人点名）。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

const EXT_OK = ['.png', '.jpg', '.jpeg']

function clean(v) { return String(v == null ? '' : v).trim() }

/**
 * 把任意输入整理成「我手上有什么」。
 * @returns {{kind:'path'|'base64', value:string, ext:string}}
 */
export function normalizeInput(input) {
  if (Buffer.isBuffer(input)) {
    return { kind: 'base64', value: input.toString('base64'), ext: '' }
  }
  const s = clean(input)
  if (!s) throw new Error('没给图片')

  // dataURL: data:image/png;base64,xxxx
  const m = s.match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i)
  if (m) return { kind: 'base64', value: m[2], ext: '.' + m[1].toLowerCase().replace('jpeg', 'jpg') }

  // base64://xxx 或 base64:xxx
  const b = s.match(/^base64:(\/\/)?(.+)$/i)
  if (b) return { kind: 'base64', value: b[2], ext: '' }

  // 看起来像裸 base64（很长且只有 base64 字符）
  if (s.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(s)) {
    return { kind: 'base64', value: s.replace(/\s+/g, ''), ext: '' }
  }

  return { kind: 'path', value: s, ext: (s.toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0] }
}

/**
 * @param {object} deps
 * @param {() => boolean} [deps.isDesktop]  当前是不是桌面端
 * @param {(p:string)=>string} [deps.resolvePath] 鱼箱路径校验（相对 → 绝对）
 * @param {(line:string)=>void} [deps.log]
 */
export function createMediaInput({ isDesktop, resolvePath, log } = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  const desktop = () => {
    try { return typeof isDesktop === 'function' ? isDesktop() === true : false } catch { return false }
  }

  /**
   * 整理头像输入。
   *
   * @param {object} opts
   * @param {string|Buffer} opts.input  路径 / base64 / dataURL / Buffer
   * @param {boolean} [opts.preferPath] 桌面版是否优先用路径形态（默认 true）
   * @returns {{ok:true, primary:{form:string,value:string}, fallback:{form:string,value:string}|null, bytes:number, ext:string}
   *          | {ok:false, say:string}}
   */
  function avatar({ input, preferPath = true } = {}) {
    let norm
    try {
      norm = normalizeInput(input)
    } catch (error) {
      return { ok: false, say: String(error?.message || error) }
    }

    if (norm.kind === 'base64') {
      // 插件版常态：手上只有 base64，直接给协议端
      const bytes = Math.floor((norm.value.length * 3) / 4)
      if (bytes > AVATAR_MAX_BYTES) {
        return { ok: false, say: '图太大了（超过 2MB），压一下再给我' }
      }
      return {
        ok: true,
        primary: { form: 'base64', value: 'base64://' + norm.value },
        fallback: null,
        bytes,
        ext: norm.ext
      }
    }

    // 本地路径：只有桌面版能走这条
    let abs = norm.value

    // ★ 2026-11-20（安全）：非桌面端收到**路径**时要直接拒，不能去读服务器文件。
    //   场景：web 面板里用户填了个路径 → 若这里照读，等于让浏览器能读服务器任意文件。
    //   所以插件版必须让调用方传 base64（页面选完文件自己转）。
    if (!desktop()) {
      return {
        ok: false,
        say: '网页端传不了本地路径，要把图片内容转成 base64 再给我'
      }
    }

    if (typeof resolvePath === 'function') {
      try {
        abs = resolvePath(abs)
      } catch (error) {
        return { ok: false, say: '这张图读不到（要在鱼箱里）' }
      }
    }
    if (!existsSync(abs)) return { ok: false, say: '找不到这张图' }
    if (!EXT_OK.includes(norm.ext)) {
      return { ok: false, say: '头像只收 png / jpg' }
    }
    let size = 0
    try { size = statSync(abs).size } catch { return { ok: false, say: '读不到这张图的大小' } }
    if (size > AVATAR_MAX_BYTES) {
      return { ok: false, say: '图太大了（超过 2MB），压一下再给我' }
    }

    const asBase64 = () => {
      try {
        const buf = readFileSync(abs)
        return { form: 'base64', value: 'base64://' + buf.toString('base64') }
      } catch (error) {
        logger('读文件转 base64 失败：' + String(error?.message || error))
        return null
      }
    }

    // ★ 桌面版：优先给路径（协议端若认，省一次读文件 + 一次编码）；
    //   同时准备好 base64 兜底，路径被拒时自动换。
    //   插件版走不到这里（它拿不到路径），所以这段差异不会泄漏到调用方。
    if (desktop() && preferPath) {
      return {
        ok: true,
        primary: { form: 'path', value: abs },
        fallback: asBase64(),
        bytes: size,
        ext: norm.ext
      }
    }

    const only = asBase64()
    if (!only) return { ok: false, say: '读不出这张图' }
    return { ok: true, primary: only, fallback: null, bytes: size, ext: norm.ext }
  }

  /** 排查用：现在是哪一端、拿到的是什么形态。 */
  function describe(input) {
    try {
      const n = normalizeInput(input)
      return { desktop: desktop(), kind: n.kind, ext: n.ext, size: n.value.length }
    } catch (error) {
      return { desktop: desktop(), kind: 'invalid', error: String(error?.message || error) }
    }
  }

  return { avatar, describe, AVATAR_MAX_BYTES }
}