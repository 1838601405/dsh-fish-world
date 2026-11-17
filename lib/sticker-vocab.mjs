// 表情标签的两个封闭词表：role（站哪）+ use（拿图干什么）。
//
// 定位（主人 2026-11-18）：标签有两个作用 —— **检索**（找哪张图）+ **锚定**
// （发图前注入上下文的那一个词）。所以词表不是分类系统，是「行为方向」：
// 进上下文的词要是能直接产生动作的短语，不能是「无语 / 礼貌 / 得体」这类状态或评价。
//
// 铁律：
//   · 词表封闭。词表外的说法一律**归并到最近的词**，不许临时新增；
//   · 归并不了的（比如只是在描述画面）返回 null，由调用方当「没有可用法」处理；
//   · 改词表要动 DERIVE_VERSION —— 只拿「原意」重算标签，不重读图。
export const DERIVE_VERSION = 'anchor-v1'

/** 说话人站哪：只三种。 */
export const ROLES = Object.freeze(['对你说', '说我', '通用'])

/** 用法：动作短语，12 个（封闭；12–15 之间不许随手上浮）。 */
export const USES = Object.freeze([
  '催他一下',
  '哄一句',
  '怼回去',
  '摆烂给他看',
  '看戏',
  '求饶',
  '认错',
  '道谢',
  '道晚安',
  '夸一句',
  '求救',
  '庆祝',
])

/**
 * 词表外的说法 → 最近的那个词。
 * 只收真的会从视觉描述 / 聊天语境里冒出来的说法；匹配是「包含即命中」，
 * 顺序有意义：先匹配更具体的（道晚安 先于 晚安）。
 */
const USE_SYNONYMS = [
  ['催他一下', ['催', '快点', '推进', '盯着进度', '别拖', '在干什么', '忙完了没']],
  ['哄一句', ['哄', '安慰', '别难过', '摸摸', '抱抱', '陪一会', '没关系']],
  ['怼回去', ['怼', '反击', '嘲讽', '阴阳', '嘲', '攻击', '凶', '骂', '不服']],
  ['摆烂给他看', ['摆烂', '躺平', '躺', '摸鱼', '不想干', '罢工', '没劲']],
  ['看戏', ['看戏', '围观', '吃瓜', '旁观', '幸灾乐祸', '看好戏']],
  ['求饶', ['求饶', '认怂', '饶命', '别打了', '放过', '投降', '服软']],
  ['认错', ['认错', '道歉', '对不起', '我错了', '悔过']],
  ['道谢', ['道谢', '谢谢', '感谢', '谢了', '承情']],
  ['道晚安', ['道晚安', '晚安', '睡觉了', '先睡了', '去睡了']],
  ['夸一句', ['夸', '称赞', '厉害', '牛', '好看', '真棒', '服气']],
  ['求救', ['求救', '救命', '求助', '帮帮我', '救我', '不会了']],
  ['庆祝', ['庆祝', '恭喜', '庆祝一下', '开心', '成了', '赢了', '过了']],
]

/** 角色说法的归一。认不出就当「通用」——它不带立场，最安全。 */
const ROLE_SYNONYMS = [
  ['说我', ['说我', '对我', '自嘲', '自己', '我被', '我挨', '我在']],
  ['对你说', ['对你说', '對你說', '对ta说', '对他', '对你', '怼他', '怼你', '夸他', '夸你', '哄他', '哄你']],
]

export function isUse(value) {
  return USES.includes(String(value || '').trim())
}

export function isRole(value) {
  return ROLES.includes(String(value || '').trim())
}

/** 词表外的用法归并到最近的词；归并不了返回 null（不编新词）。 */
export function normalizeUse(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  if (USES.includes(text)) return text
  for (const [use, words] of USE_SYNONYMS) {
    if (words.some((word) => text.includes(word))) return use
  }
  // 反过来：文本是某个同义词的子串（「催」在「催他一下」里）也放行。
  for (const [use, words] of USE_SYNONYMS) {
    if (words.some((word) => word.includes(text) && text.length >= 2)) return use
  }
  return null
}

/** 立场归一：认不出当「通用」。 */
export function normalizeRole(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return '通用'
  if (ROLES.includes(text)) return text
  for (const [role, words] of ROLE_SYNONYMS) {
    if (words.some((word) => text.includes(word))) return role
  }
  return '通用'
}

/**
 * 把一条候选锚点规格化：use 不在词表里就归并，归并不了返回 null。
 * w 落在 0.1–1；缺省 0.5（「两条用法都能用」的中间值）。
 */
export function normalizeAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null
  const use = normalizeUse(raw.use)
  if (!use) return null
  const act = raw.act == null ? null : String(raw.act).trim().slice(0, 24) || null
  const w = Number(raw.w)
  return {
    act,
    role: normalizeRole(raw.role),
    use,
    w: Number.isFinite(w) ? Math.min(1, Math.max(0.1, Math.round(w * 100) / 100)) : 0.5,
  }
}

/** 词表说明（给面板/体检看，不进提示词）。 */
export function vocabInfo() {
  return { version: DERIVE_VERSION, roles: [...ROLES], uses: [...USES] }
}