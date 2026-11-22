// 三个主平台的视觉输入适配器（2026-11-22 主人方案 P3）。
//
// ── 这一层在干什么 ──
// vision-input.mjs 定了统一结构 { source, who, when, text, files[], raw_id }，
// 这里是**每平台一个**的摊平函数：把该平台的原始形状摊成那个结构。
// 三个函数互不认识、互不调用 —— 平台差异到此为止，往下（归一化 → 管线）全是共用的。
//
// ── 各平台拿到的东西根本不一样 ──
//   QQ       ：normalizeMessage 出来的 { text, images:[{url,file}], videos:[{url}], parts[] }
//              图和视频只有 url（要下载），语音段的 url 藏在 parts 里
//   DSH 会话 ：宿主 attachments 的块 { type:'image', data(base64), mediaType, name }
//              或者已经落好盘的 { path } —— 两种都在
//   桌面版   ：本地拖入 ⇒ 路径；网页面板 ⇒ dataURL；两者的分界在 media-input.mjs 已经定过
//
// ── 为什么不合并成一个函数 ──
// 合并就要在里面写 `if (platform === 'qq')`，第三个平台进来时改的还是同一个函数。
// 现在每加一个平台 = 加一个函数 + 登记一行，视觉代码一行不动 —— 方案验收 (f) 要的就是这个。

import { makeEntry } from './vision-input.mjs'

/** 一条消息最多带几个附件（与 vision-input 的 8 上限对齐，别在这层先超了）。 */
export const MAX_FILES = 8

/** 摊平结果的兜底：缺字段补默认，多出来的字段丢掉。 */
function finish(partial) {
  return makeEntry(partial)
}

/**
 * QQ：`lib/qq.mjs normalizeMessage` 的输出。
 *
 * 图 / 视频给 url（归一化层负责下载），语音段的 url 在 parts 里 ——
 * QQ 自己转的文字已经在 text 里了（`[语音] 译文`），所以**有译文就不把语音段当附件**，
 * 免得同一句话既进正文又花钱转写一遍。
 *
 * @param {object} row  normalizeMessage 的返回值
 */
export function fromQQ(row) {
  const m = row && typeof row === 'object' ? row : {}
  const parts = Array.isArray(m.parts) ? m.parts : []

  const files = []
  for (const image of (Array.isArray(m.images) ? m.images : [])) {
    const url = String(image?.url || '')
    if (url) files.push({ url, name: String(image?.file || '') })
    if (files.length >= MAX_FILES) break
  }
  for (const video of (Array.isArray(m.videos) ? m.videos : [])) {
    const url = String(video?.url || '')
    if (url) files.push({ url, name: String(video?.name || '') })
    if (files.length >= MAX_FILES) break
  }

  // 语音：正文里已经有 QQ 的译文就不再转写；没有译文才把音频当附件交出去。
  const hasTranscript = /\[语音\]\s*\S/.test(String(m.text || ''))
  if (!hasTranscript && files.length < MAX_FILES) {
    for (const part of parts) {
      if (part?.kind !== 'record') continue
      const url = String(part.url || '')
      if (url) files.push({ url, name: '' })
      break // 一条消息最多转一段语音
    }
  }

  return finish({
    source: 'qq',
    who: String(m.nickname || m.userId || ''),
    when: Number(m.at || 0),
    text: String(m.text || ''),
    files,
    raw_id: String(m.id || m.messageId || '')
  })
}

/**
 * DSH 会话：粘贴的图 / 附件（宿主 attachments 的块，或已落盘的路径）。
 *
 * 宿主给的块是 `{ type:'image'|'video'|'audio', data: <base64>, mediaType, name }`；
 * 有的路径直接是 `{ path }`。两种都收，交给归一化层判类型 —— 这层不猜扩展名。
 *
 * @param {object|Array} input 一个块、或一块数组
 * @param {object} [meta]      { who, when, text, raw_id }
 */
export function fromSession(input, meta = {}) {
  const blocks = Array.isArray(input) ? input : [input]
  const files = []

  for (const block of blocks) {
    if (!block || files.length >= MAX_FILES) continue
    if (typeof block === 'string') { files.push(block); continue }

    // 宿主的 attachment 引用（saveImages 回来的）带的是引用不是字节，交给上层按 id 取。
    if (block.path) { files.push({ path: String(block.path), name: String(block.name || '') }); continue }

    const data = typeof block.data === 'string' ? block.data : ''
    if (!data) continue
    const media = String(block.mediaType || '').toLowerCase()
    const kind = /video/.test(media) ? 'video' : /audio|voice|speech/.test(media) ? 'audio' : 'image'
    const ext = (String(block.name || '').match(/\.[a-z0-9]+$/i) || [''])[0]
      || (kind === 'video' ? '.mp4' : kind === 'audio' ? '.m4a' : '.png')
    files.push({
      bytes: Buffer.from(data, 'base64'),
      name: String(block.name || '') || kind + ext
    })
  }

  return finish({
    source: 'session',
    who: String(meta.who || ''),
    when: Number(meta.when || 0),
    text: String(meta.text || ''),
    files,
    raw_id: String(meta.raw_id || '')
  })
}

/**
 * 桌面版本地拖入 / 网页面板选文件。
 *
 * 桌面版给**路径**（能读本机文件），网页版给 **dataURL**（读不到本机）——
 * 这条分界 media-input.mjs 已经定过，这里照抄同一个口径，不另立一套。
 *
 * @param {string|object|Array} input  路径 / dataURL / {path|dataUrl|url|bytes} / 它们组成的数组
 * @param {object} [meta]              { who, when, text, raw_id }
 */
export function fromDesktop(input, meta = {}) {
  const items = Array.isArray(input) ? input : [input]
  const files = items.filter(Boolean).slice(0, MAX_FILES).map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') {
      const out = {}
      if (item.path) out.path = String(item.path)
      else if (item.dataUrl || item.data) out.dataUrl = String(item.dataUrl || item.data)
      else if (item.url) out.url = String(item.url)
      else if (item.bytes) out.bytes = item.bytes
      if (item.name) out.name = String(item.name)
      return out
    }
    return null
  }).filter(Boolean)

  return finish({
    source: 'desktop',
    who: String(meta.who || ''),
    when: Number(meta.when || 0),
    text: String(meta.text || ''),
    files,
    raw_id: String(meta.raw_id || '')
  })
}

/**
 * 登记三个主平台。**只碰 vision-input 的 register，不碰视觉管线。**
 *
 * @param {object} input  createVisionInput 的实例
 * @returns {{count:number, platforms:string[]}}
 */
export function registerMainPlatforms(input) {
  if (!input || typeof input.register !== 'function') {
    throw new Error('要给一个 vision-input 实例')
  }
  input.register('qq', (raw) => fromQQ(raw))
  input.register('session', (raw, meta) => fromSession(raw, meta))
  input.register('desktop', (raw, meta) => fromDesktop(raw, meta))
  return { count: 3, platforms: input.platforms() }
}
