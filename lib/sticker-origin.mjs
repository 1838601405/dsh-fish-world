// 「原意」派生：从已有的名字 / 说明 / 自由标签里，还原这张图**画了什么**。
//
// 为什么要有它：主人 2026-11-18 的规矩是「改词表或规则后，只拿原意重算标签，不重读图」。
// 所以「原意」必须是一份与词表无关的、看画面的描述（画面 / 情绪 / 梗），
// 派生锚点只吃它。已有的 132 张图没有逐张重读，就从 note（视觉整理留下的「画面：…；用在：…」）
// 和名字里还原 —— 还原不出来就写 unknown，不硬凑。
//
// 边界：这里只做文本还原，不判断用法（用法由 sticker-annotate 按词表派生）。

/** 看得见的物 / 动作，从名字里取「·」后面那段（蓝鲸娘·掏刀-003 → 掏刀）。 */
function actFromName(name) {
  const text = String(name || '')
  const dot = text.indexOf('·')
  if (dot < 0) return ''
  return text.slice(dot + 1).replace(/-\d+$/, '').trim()
}

/** note 的「画面：X；用在：Y」结构。 */
function partsOfNote(note) {
  const text = String(note || '')
  const picMatch = text.match(/画面[：:]\s*([^；;\n]*)/)
  const useMatch = text.match(/用在[：:]\s*([^；;\n]*)/)
  return {
    pic: picMatch ? picMatch[1].trim() : '',
    when: useMatch ? useMatch[1].trim() : '',
  }
}

/** 情绪词表：只认这些词，不认识的标签不当情绪（免得把「蓝鲸娘」当情绪）。 */
const MOOD_WORDS = [
  '开心', '得意', '害羞', '难过', '生气', '无语', '困', '饿', '兴奋', '平静',
  '委屈', '疑惑', '嫌弃', '惊讶', '慌', '怂', '欠揍', '挑衅', '无奈', '心虚', '得意忘形',
  // 画面里常见、但没写进上面那些词的说法（「掏出菜刀杀气腾腾」→ 生气）。
  '凶', '怒', '气', '杀', '冷漠', '严肃', '蔫', '虚',
]

/** 梗 / 形态线索：说明这张图「像哪种网络表达」。 */
const MEME_WORDS = ['梗', '表情包', '截图', '文字', '聊天记录', '弹幕', '二创', '同人', 'meme', '动图']

/**
 * 从现有字段还原「原意」。返回 { 画面, 情绪, 梗 }，认不出的字段写 unknown。
 * 纯函数：不读盘、不看图。
 */
export function deriveOrigin({ name = '', note = '', tagWords = [] } = {}) {
  const { pic, when } = partsOfNote(note)
  const words = (Array.isArray(tagWords) ? tagWords : []).map((word) => String(word || '').trim()).filter(Boolean)

  const act = actFromName(name)
  // 画面 = note 里的画面描述；没有就退回「名字里的动作 + 自由词里能看见的东西」；
  // 再没有才 unknown（不硬凑）。
  const visibleWords = words.filter((word) => (
    !MOOD_WORDS.some((mood) => word.includes(mood))
    && !MEME_WORDS.some((meme) => word.toLowerCase().includes(meme))
  ))
  const 画面 = (pic || [act, visibleWords.slice(0, 6).join(' ')].filter(Boolean).join(' ')).trim()
  // 情绪 = 自由标签里的情绪词（最多三个），没有就看「用在」里有没有情绪词。
  const moods = words.filter((word) => MOOD_WORDS.some((mood) => word.includes(mood))).slice(0, 3)
  const moodFromWhen = MOOD_WORDS.filter((mood) => when.includes(mood)).slice(0, 2)
  const 情绪 = (moods.length ? moods.join('、') : moodFromWhen.join('、')) || 'unknown'
  // 梗 = 标签/说明里的形态线索（截图/文字/表情包/梗…）。
  const memeHits = words.filter((word) => MEME_WORDS.some((meme) => word.toLowerCase().includes(meme)))
  const 梗 = (memeHits.length ? memeHits.join('、') : '') || 'unknown'

  return {
    画面: 画面 || 'unknown',
    情绪,
    梗,
    // 还原线索一起带出去，便于复核「这张图的原意是从哪来的」。
    来源: { act, when, words: words.slice(0, 8) },
  }
}

/** 原意是不是等于「什么都没认出来」。 */
export function originUnknown(origin) {
  const o = origin || {}
  return String(o.画面 || '').trim() === 'unknown' && String(o.情绪 || '').trim() === 'unknown'
}