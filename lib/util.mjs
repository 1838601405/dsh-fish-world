// 小工具集合：不依赖任何 DSH 内部模块，方便单测。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 读 JSON；文件不存在 / 解析失败都返回 fallback（并可选把错误交给 onError）。 */
export function readJson(file, fallback = null, onError) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code !== 'ENOENT' && typeof onError === 'function') {
      try { onError(error) } catch {}
    }
    return fallback
  }
}

/** 原子写 JSON（先写 .tmp 再 rename），避免半份文件。 */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
  return true
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function fileMtime(file) {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

export function fileExists(file) {
  try { return existsSync(file) } catch { return false }
}

/** 把消息 content（字符串 / 块数组）压成纯文本。 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => {
      if (!block || typeof block !== 'object') return false
      // 思维链 / 分析块不是她说的话：宁可少拼一段，也不能把内部盘算当正文发出去。
      const type = String(block.type || '')
      return !/reason|think|analysis|scratch/i.test(type)
    })
    .map((block) => {
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      return ''
    })
    .join('')
}

// 有些轮次模型会把「内部盘算」当正文吐出来：英文的 The user is … / Reply short …
// 这些不是她说的话，也不是群里该看见的东西。按段落识别，整段丢掉。
const PLANNER_PATTERNS = [
  /^\s*The user (is|said|asked)\b/im,
  /^\s*Group chat, one person to reply/im,
  /\bNeed to respond (as|to)\b/i,
  /\bReply (short|in persona|as the character)\b/i,
  /\bI'm the fish in the group\b/i,
  /\(each message = separate bubble/i,
  /\bDon'?t respond to others\b/i,
  /\bHis line:\s*["“]/i,
  // 复读投递文本（主人 2026-10-26 贴的群记录）：她把整段上下文当正文发了出来 ——
  // 「user[QQ 群 …] 某某：…」、〔此刻群里的现场…〕、〔群聊：优先聊天…〕。
  // 这些是我们投递时加的标注，一个字都不该出现在 QQ 里。
  /^\s*user\s*\[/i,
  /^\s*\[QQ\s*(群|私聊)/,
  /^\s*〔/,
]

/** 去掉漏出来的内部盘算；全被丢光就返回空串（这一轮当作没说话）。 */
export function stripLeakedPlanner(text) {
  const value = String(text == null ? '' : text)
  if (!value.trim()) return ''
  const kept = value
    .split(/\n{2,}/)
    .filter((block) => !PLANNER_PATTERNS.some((re) => re.test(block)))
  return kept.join('\n\n').trim()
}

/**
 * 一轮说的话拆成几个气泡：**每一个换行都算一条**。
 *
 * 原来只认空行，理由是「单换行可能是一句长话的折行」。但实测模型不用空行分段，
 * 它写两条消息时就是一个换行（主人 2026-10-26：「存不了 图在桥的临时目录 /
 * 你丢进 大肥鱼 目录 我再收」又被合成了一条，说这完全是 BUG）。
 * 折行和分条在聊天里本来就分不开，宁可多一条也不要把两句压成一个气泡。
 *
 * 另外人设卡的示例里用「／」当分隔符（「不许说胖！… ／ ？你再说一遍试试」），
 * 所以单独一个全角 ／、或者两侧带空格的半角 /，也当分条 —— 规则和提示词对齐，
 * 不然她按示例写、代码却当成一句话。半角斜杠只在两侧有空格时才拆，免得切坏 5/10 这种。
 */
export function splitBubbles(text) {
  const value = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  return value
    .split(/\n+|／+|\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** 从 content 里挑出图片块（保留原始块，调用方自己决定怎么处理）。 */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block && block.type === 'image')
}

export function oneLine(value, max = 160) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 工具名 / 扩展 id 只留安全字符。 */
export function sanitizeId(value, fallback = 'x') {
  const text = String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '')
  return text || fallback
}

/** 截断但不切出半个代理对。 */
export function sliceSafe(text, max) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  let end = max
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return s.slice(0, end)
}

/**
 * 浅合并：只覆盖对象里显式给出的键；数组整体替换。
 * 用于设置补丁，避免把默认值里的嵌套对象丢掉。
 */
export function mergePatch(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergePatch(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}
