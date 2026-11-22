// QQ 语音转写（2026-11-22 主人方案 P3 · §二 点名的空白）。
//
// ── 现在是什么样 ──
// QQ 语音只有两条出路：
//   ① 协议端自己转好了放在 record 段的 data.text → normalizeMessage 拼成「[语音] 译文」
//   ② 没转 → 只剩一个 [语音] 占位，她**完全不知道对方说了什么**
// 方案 §二 把「语音转写进上下文」列为缺口，§七 要求「受现有开关控制：
// 开了才转，关着回落占位」。
//
// ── 开关为什么读桥的 ──
// 「现有开关」= `qq-bridge-config.json` 的 `语音转写`（默认 false）。
// 读它而不是另开一个，是因为主人只该管一个开关；而且这条链路自洽，不会重复花钱：
//   · 桥转过 → data.text 有值 → 正文里已有「[语音] 译文」→ 这里看到译文就跳过
//   · 桥没转 → 没译文 → 这里才下载音频交给视觉管线转
//   · 开关关 → 直接跳过，回落 [语音] 占位（跟现在一模一样）
//
// ── 边界 ──
//  · 只认 http(s) 地址：QQ 给的 data.file 常常只是个文件名（不是路径），下不到就如实跳过；
//  · 转写失败不吞：正文里标「没转出来」，不假装收到过这句话；
//  · 一次最多转一段：一条消息连发多段语音是很少见的，先只转第一段（省额度）。

import { normalizeFile } from './vision-input.mjs'

/** 一条消息最多转几段语音。 */
export const MAX_VOICE_PER_MESSAGE = 1

/** 正文里已经有译文的特征（normalizeMessage 拼的格式）。 */
const HAS_TRANSCRIPT = /\[语音\]\s*\S/

/**
 * 这条消息要不要转写。**纯函数**，判据直接打这里。
 *
 * @param {object} opts
 * @param {Array}  opts.parts  归一后的分段（要 kind==='record' 且带 url）
 * @param {string} opts.text   当前正文
 * @param {boolean} opts.switchOn 桥的「语音转写」开关
 * @returns {{ok:boolean, reason:string, url:string}}
 */
export function shouldTranscribe({ parts, text, switchOn } = {}) {
  if (switchOn !== true) return { ok: false, reason: 'switch-off', url: '' }

  const records = (Array.isArray(parts) ? parts : [])
    .filter((p) => p && p.kind === 'record')
    .map((p) => String(p.url || '').trim())
    .filter(Boolean)
  if (!records.length) return { ok: false, reason: 'no-record', url: '' }

  // 桥/协议端已经转过 → 正文里有译文，别再花一次钱。
  if (HAS_TRANSCRIPT.test(String(text || ''))) return { ok: false, reason: 'has-transcript', url: '' }

  const url = records[0]
  if (!/^https?:\/\//i.test(url)) {
    // QQ 常给的是文件名（不是路径），下不到 —— 如实说，不猜。
    return { ok: false, reason: 'not-downloadable', url }
  }
  return { ok: true, reason: '', url }
}

/**
 * 建一个转写器。
 *
 * @param {object} opts
 * @param {Function} opts.getWire  () => { vision, input, backend } | null —— 拿视觉管线
 *                                 （延迟取：世界根可能还没绑定，也可能是热更新后换了实例）
 * @param {Function} [opts.readSwitch] () => boolean —— 桥的「语音转写」开关
 * @param {Function} [opts.fetchImpl]
 * @param {object} [opts.logger]
 * @param {number} [opts.inputDir] 归一化落盘目录（不给就用 wire.input 的目录）
 */
export function createVoiceTranscriber({ getWire, readSwitch, fetchImpl, logger, inputDir } = {}) {
  if (typeof getWire !== 'function') throw new Error('转写器要能拿到视觉管线（getWire）')

  function switchOn() {
    try { return readSwitch?.() === true } catch { return false }
  }

  /**
   * 转一条消息里的语音。
   *
   * @returns {Promise<{ok:boolean, text:string, reason:string, url:string}>}
   *   ok=true  → text 是转写结果（已由管线按 1500 字截断）
   *   ok=false → reason 是没转的原因，调用方据此回落占位
   */
  async function transcribe({ parts, text } = {}) {
    const verdict = shouldTranscribe({ parts, text, switchOn: switchOn() })
    if (!verdict.ok) return { ok: false, text: '', reason: verdict.reason, url: verdict.url }

    const wire = getWire()
    if (!wire) return { ok: false, text: '', reason: 'no-wire', url: verdict.url }

    // 先归一化：url → 落盘成文件（管线只认路径），顺带判出 kind。
    let file
    try {
      const dir = inputDir || wire.backend?.status?.()?.gridDir?.replace(/[\\/]宫格$/, '') || ''
      if (!dir) return { ok: false, text: '', reason: 'no-input-dir', url: verdict.url }
      file = await normalizeFile(
        // 不给 name：让归一化从地址末段取（/v.silk → .silk），硬写一个没扩展名的名字会盖掉它
        { url: verdict.url },
        { inputDir: dir, ...(fetchImpl ? { fetchImpl } : {}) }
      )
    } catch (error) {
      const why = String(error?.message || error)
      try { logger?.warn?.(`fish-world: 语音下载失败：${why}`) } catch {}
      return { ok: false, text: '', reason: 'download-failed:' + why, url: verdict.url }
    }

    // 非音频（QQ 偶尔给错类型）：不硬转，如实说。
    if (file.kind !== 'audio') {
      return { ok: false, text: '', reason: 'not-audio:' + file.kind, url: verdict.url }
    }

    try {
      const result = await wire.vision.transcribeAudio(file.path)
      const said = String(result?.text || '').trim()
      if (!said) return { ok: false, text: '', reason: 'blank', url: verdict.url }
      return { ok: true, text: said, reason: '', url: verdict.url, id: result.id, cached: result.cached === true }
    } catch (error) {
      const why = String(error?.message || error)
      try { logger?.warn?.(`fish-world: 语音转写失败：${why}`) } catch {}
      return { ok: false, text: '', reason: 'transcribe-failed:' + why, url: verdict.url }
    }
  }

  return { transcribe, switchOn, MAX_VOICE_PER_MESSAGE }
}

/**
 * 把转写结果拼回正文。
 *
 * ★ 占位格式沿用协议端那套「[语音] 译文」—— 她读到的形状不变，
 *   只是以前空着的那半句现在有字了。
 *
 * @returns {string} 要追加到正文的那行（不该追加就返回空串，**一个字都不加**）
 */
export function transcriptLine(result) {
  if (!result || result.ok !== true) return ''
  const said = String(result.text || '').trim()
  if (!said) return ''
  return `[语音] ${said}`
}
