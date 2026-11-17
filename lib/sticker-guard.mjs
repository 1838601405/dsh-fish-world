// 用图闸：文字负责事，图负责气。这几条只在**代码里**判，不进上下文。
//
// 主人 2026-11-18 定的规矩（第一版统一口径）：
//   · 只在情绪位用图；有信息要给（时间/数字/结论/步骤）→ 只发文字；
//   · 图与文字不许同义，也不许解释图；
//   · 一条只一张，另起一条发，不和文字挤同一气泡；
//   · 普通闲聊 3–5 轮一张；连续两条带图后，第三条强制只文字。
//
// 为什么在代码里：这些是「发出去之前才该判」的事，写进人设等于每轮自锚。
// 这里只回答「这一次能不能配图 / 这条文字能不能配图」，不负责挑哪张（那是 pickForReply）。

/** 状态按会话存：连续几张、距上次图过了几轮、上一次是什么。 */
const states = new Map()

export function stateFor(chatKey) {
  const key = String(chatKey || '')
  if (!states.has(key)) {
    states.set(key, {
      consecutiveStickers: 0,
      // 从 0 起：新会话也要先聊满 3 轮才轮到图。
      turnsSinceSticker: 0,
      lastKind: '',
      lastAnchor: null,
      lastAt: 0,
      // 对方最近一条是不是图（对方先发图，可以回一张）；是不是在难过（难过先说话不发表情）。
      lastIncomingHadImage: false,
      lastIncomingSad: false,
    })
  }
  return states.get(key)
}

export function resetState(chatKey) {
  states.delete(String(chatKey || ''))
}

/** 这条文字是不是「有信息要给」：数字、时间、列举、结论句。 */
export function hasInfo(text) {
  const s = String(text || '')
  if (!s.trim()) return false
  if (/\d/.test(s)) return true
  if (/\d{1,2}\s*[:：点]\s*\d{0,2}/.test(s)) return true
  if (/(第[一二三四五12345]|首先|其次|然后|最后|所以|因为|结论|步骤|方法|一是|二是)/.test(s)) return true
  // 一句话里有两个以上分句，通常是在讲事，不是在出气。
  if ((s.match(/[，,]/g) || []).length >= 2 && s.length >= 24) return true
  return false
}

const EXPLAIN_WORDS = ['这张图', '这个图', '如图', '图里', '图上的', '表情包', '这图', '图片里']

/** 对方在难过：这时候先说话，不发表情（主人 2026-11-18 §十.4）。 */
const SAD_WORDS = ['难过', '伤心', '委屈', '想哭', '哭了', '难受', '崩溃', 'emo', '不开心', '失落', '心凉', '撑不住']

export function looksSad(text) {
  const s = String(text || '')
  return SAD_WORDS.some((word) => s.includes(word))
}

/** 记一下对方刚发来的那条：带图？在难过？ */
export function noteIncoming({ chatKey, hasImage = false, text = '' } = {}) {
  const state = stateFor(chatKey)
  state.lastIncomingHadImage = hasImage === true
  state.lastIncomingSad = looksSad(text)
  return state
}

/** 图刚发过：这条文字是不是在解释图 / 和图同义。 */
export function checkText({ chatKey, text, anchor } = {}) {
  const s = String(text || '').trim()
  if (!s) return { ok: true }
  const state = stateFor(chatKey)
  if (state.lastKind !== 'sticker') return { ok: true }
  if (EXPLAIN_WORDS.some((word) => s.includes(word))) {
    return { ok: false, reason: 'explains-sticker', why: '在解释刚发的那张图' }
  }
  const use = String(anchor?.use || state.lastAnchor?.use || '')
  if (use && s.includes(use.replace(/他|我/g, '').slice(0, 2))) {
    return { ok: false, reason: 'same-meaning', why: '文字和图同义（都在说「' + use + '」）' }
  }
  return { ok: true }
}

/**
 * 能不能发这张图。
 * text：同一轮已经准备好的文字（没有就空）；anchor：这张图的锚点；images：本轮图片数。
 */
export function checkSticker({ chatKey, text = '', anchor = null, images = 1, now = Date.now() } = {}) {
  const state = stateFor(chatKey)
  if (Number(images) > 1) return { ok: false, reason: 'multi-image', why: '一条只发一张图' }
  if (String(text || '').trim()) return { ok: false, reason: 'same-bubble', why: '图和文字不许挤同一条' }
  if (hasInfo(text)) return { ok: false, reason: 'info-bearing', why: '这条有信息要给，只发文字' }
  if (state.consecutiveStickers >= 2) return { ok: false, reason: 'after-two', why: '已经连发两张，第三条强制只文字' }
  // 对方难过：先说话，不发表情（这条优先级高于「轮到发图了」）。
  if (state.lastIncomingSad) return { ok: false, reason: 'comforting', why: '对方在难过，先说话，不发表情' }
  // 对方先发图：这是唯一可以抢节奏的时候——回一张，不受「3–5 轮」限制。
  if (state.lastIncomingHadImage) return { ok: true }
  if (state.turnsSinceSticker < 3) return { ok: false, reason: 'too-soon', why: '普通闲聊 3–5 轮才一张，这次还不到' }
  return { ok: true }
}

/** 发出去之后记账（文字一轮算一轮；图重置轮数并累计连发）。 */
export function noteSend({ chatKey, kind, text = '', anchor = null, now = Date.now() } = {}) {
  const state = stateFor(chatKey)
  state.lastAt = now
  if (kind === 'sticker') {
    state.consecutiveStickers = state.lastKind === 'sticker' ? state.consecutiveStickers + 1 : 1
    state.turnsSinceSticker = 0
    state.lastKind = 'sticker'
    state.lastAnchor = anchor ? { use: anchor.use, role: anchor.role } : null
    return state
  }
  state.consecutiveStickers = 0
  state.turnsSinceSticker = Math.min(999, state.turnsSinceSticker + 1)
  state.lastKind = 'text'
  state.lastAnchor = null
  return state
}

/** 拦下时给模型/主人看的人话。 */
export function explainReason(reason) {
  return ({
    'multi-image': '一条只发一张图',
    'same-bubble': '图和文字别挤在同一气泡',
    'info-bearing': '这条有信息（数字/时间/步骤/结论），用图会把信息糊掉',
    'after-two': '已经连发两张图，这条只发文字',
    'too-soon': '离上一张太近，普通闲聊 3–5 轮一张',
    'explains-sticker': '这条在解释图，别解释',
    'same-meaning': '文字和图同义了，留一个就够',
    comforting: '对方在难过，先说话，不发表情',
  })[reason] || reason
}