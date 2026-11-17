// 「原意 → 锚点」派生：先宽后严。
//
// 主人 2026-11-18 的规矩：
//   生：按「动作 × 立场 × 用法」枚举候选，能出多少出多少；
//   判：每条过三问，全过才留 —— a) 有没有可归属的角色位 b) 有没有指向该用法的可见线索
//       c) 与其它候选是否冲突（冲突且上下文消解不了 → 弃）；
//   留 = 进库；弃 = 不进库，但理由要写「图里缺什么」，存档备查。
//
// 铁律：判据与具体图片无关。这里只有 12 组通用关键词 + 三条通用判断，
// **不许出现「蓝鲸娘·掏刀」这种具体图名判断** —— 为了某张图能发出去单写规则
// 就等于结构漏了。词表外的说法一律归并（normalizeAnchor 负责），归并不了的不进库。
import { ROLES, USES, normalizeAnchor } from './sticker-vocab.mjs'

/** 每个用法一组通用可见线索（朝向 / 动作 / 文字 / 表情都算）。 */
const CLUES = {
  催他一下: ['催', '盯', '瞪', '等', '时钟', '看表', '敲桌', '叉腰', '指', '进度', '快点', '别拖', '在吗', '忙完'],
  哄一句: ['抱', '摸头', '摸摸', '递', '温柔', '安慰', '陪', '拍背', '亲', '别难过', '贴贴', '拍拍'],
  怼回去: ['刀', '凶', '瞪', '白眼', '指人', '吼', '骂', '电', '挑衅', '墨镜', '不屑', '嘲', '问你', '你问', '反问', '怎么样', '怼', '顶嘴', '嘴硬', '笨蛋', '气死'],
  摆烂给他看: ['躺', '趴', '瘫', '闭眼', '摆烂', '摸鱼', '没劲', '累', '不想干', '罢工'],
  看戏: ['看戏', '围观', '吃瓜', '旁观', '玩味', '墨镜', '幸灾乐祸', '盯着看', '看好戏'],
  求饶: ['合十', '跪', '冒汗', '求饶', '怂', '抖', '服软', '饶命', '挣扎', '被拎', '被提', '缩'],
  认错: ['低头', '红脸', '搓手', '认错', '道歉', '对不起', '我错了', '抱歉'],
  道谢: ['鞠躬', '比心', '递', '谢', '感谢', '敬礼', '承情', '谢谢'],
  道晚安: ['枕头', '被子', '月亮', '晚安', '睡觉', '先睡', '打哈欠', '睡姿'],
  夸一句: ['点赞', '竖拇指', '星星眼', '夸', '好棒', '厉害', '得意', '比手', '牛啊', '真行'],
  求救: ['抓手', '举手', '救命', '求救', '喊', '慌', '哭', '不会', '救我', '要饭', '讨饭', '讨吃', '空碗'],
  庆祝: ['彩球', '烟花', '举手', '庆祝', '兴奋', '开心', '恭喜', '赢了', '过了', '击掌', '欢呼', '举拳'],
}

/** 画面里能认出来的动作（只用于 act 字段，不参与用法判断）。 */
const ACT_WORDS = [
  '掏刀', '掏出', '掏', '摸头', '拥抱', '抱', '躺', '趴', '跪', '哭', '笑', '瞪', '盯', '指', '点头', '低头',
  '鞠躬', '点赞', '比心', '合十', '举手', '挥手', '翻白眼', '叉腰', '敲桌', '吃', '睡', '转圈',
  '递', '摊手', '跪坐', '遮脸', '探头', '拍桌', '推', '拉', '抱尾', '抖',
]

/** 角色位线索：谁在施压 / 谁在承受 / 谁在旁观。完全认不出就只留「通用」。 */
const ROLE_CLUES = {
  对你说: ['朝对方', '对着', '指人', '瞪', '盯', '凶', '威胁', '喂', '你', '他', '递过去', '喊'],
  说我: ['自嘲', '自己', '我', '被', '承受', '委屈', '躺', '趴', '瘫', '蔫', '心虚'],
}

const UNKNOWN = /看不清|unknown|不确定|无法辨认/i

function textOf(origin) {
  const o = origin || {}
  return {
    画面: String(o.画面 || ''),
    情绪: String(o.情绪 || ''),
    梗: String(o.梗 || ''),
  }
}

/** 拼成一段可搜的文本；unknown 的字段当空缺，不硬凑。 */
function haystack(origin, words) {
  const t = textOf(origin)
  const parts = [t.画面, t.情绪, t.梗].filter((part) => part && !UNKNOWN.test(part))
  const extra = (Array.isArray(words) ? words : []).filter((w) => w && !UNKNOWN.test(String(w))).join(' ')
  return (parts.join(' ') + ' ' + extra).toLowerCase()
}

/** 从画面里认动作；认不出返回 null（纯文字图允许 null）。 */
export function actOf(origin) {
  const pic = textOf(origin).画面.toLowerCase()
  if (!pic || UNKNOWN.test(pic)) return null
  const hit = ACT_WORDS.find((word) => pic.includes(word))
  return hit || null
}

/** 哪些角色位在原意里有归属线索。
 *  只看「画面」：立场是画面里谁对谁，不由情绪/梗带出来（否则「凶」这种滤镜词会把立场硬塞成对你说）。 */
export function roleSlotsOf(origin) {
  const pic = textOf(origin).画面
  const hay = UNKNOWN.test(pic) ? '' : pic.toLowerCase()
  const slots = []
  for (const role of ['对你说', '说我']) {
    if (ROLE_CLUES[role].some((word) => hay.includes(word.toLowerCase()))) slots.push(role)
  }
  return slots
}

/** 一条用法的线索强度：动作词出现在画面 = 强，出现在情绪/梗/自由词 = 中，只沾到通用词 = 弱。 */
function strengthOf(use, origin, words) {
  const pic = textOf(origin).画面.toLowerCase()
  const rest = haystack(origin, words)
  const clues = CLUES[use] || []
  const inPic = clues.find((word) => pic.includes(word.toLowerCase()))
  if (inPic) return { hit: true, w: 0.8, where: '画面', clue: inPic }
  const inRest = clues.find((word) => word.length >= 2 && rest.includes(word.toLowerCase()))
  if (inRest) return { hit: true, w: 0.5, where: '情绪/梗/标签', clue: inRest }
  return { hit: false, w: 0, where: '', clue: '' }
}

/**
 * 派生出锚点。只吃「原意」(+ 可选自由词)，不读图、不读盘。
 * 返回 { anchors, discarded }；discarded 每条写清「图里缺什么」。
 */
export function deriveAnchors({ origin, words = [] } = {}) {
  const anchors = []
  const discarded = []
  const act = actOf(origin)
  const slots = roleSlotsOf(origin)
  // 角色位：认得出是谁对谁，就按认出来的来；一个都认不出 → 只能「通用」。
  const candidateRoles = slots.length ? slots : ['通用']

  for (const use of USES) {
    const strength = strengthOf(use, origin, words)
    if (!strength.hit) {
      // 只有明确沾到线索才进 discarded 记录，避免把 12 个用法都写成噪声。
      continue
    }
    const perRole = candidateRoles.map((role) => ({ role, w: strength.w }))
    // 冲突：同一用法出现多个立场，只有画面里的朝向能定唯一立场时才算消解；
    // 消解不了（两个角色位线索都命中）→ 只留 w 高的那个（同 w 时留「通用」，不硬选边）。
    let chosen = perRole
    if (perRole.length > 1) {
      const allSame = perRole.every((row) => row.w === perRole[0].w)
      if (allSame) {
        chosen = [{ role: '通用', w: perRole[0].w }]
        for (const row of perRole) {
          if (row.role === '通用') continue
          discarded.push({ use, role: row.role, why: '立场冲突：画面里施压方和承受方线索都在，消解不了，只留通用' })
        }
      } else {
        chosen = [perRole.slice().sort((a, b) => b.w - a.w)[0]]
      }
    }
    for (const row of chosen) {
      const normalized = normalizeAnchor({ act, role: row.role, use, w: row.w })
      if (!normalized) {
        discarded.push({ use, role: row.role, why: '词表外的用法：归并不到 12 个动作短语里' })
        continue
      }
      anchors.push({ ...normalized, where: strength.where, clue: strength.clue || '' })
    }
  }

  // 一条都没留下：说清缺什么（这是要存档备查的）。
  if (!anchors.length) {
    const hay = haystack(origin, words)
    if (!hay.trim()) discarded.push({ use: '', role: '', why: '原意全是 unknown：画面、情绪、梗都没认出来' })
    else if (!slots.length) discarded.push({ use: '', role: '', why: '没线索命中任何用法：缺指向用法的可见动作/文字/表情' })
  }

  return { anchors, discarded }
}

/** 给面板/复盘看的人话。 */
export function explainDerive(result) {
  const out = []
  for (const a of (result?.anchors || [])) {
    out.push(`留：${a.use} · ${a.role}（${a.act || '无动作'}，w=${a.w}，线索在${a.where || '未知'}）`)
  }
  for (const d of (result?.discarded || [])) {
    out.push(`弃：${d.use || '-'} · ${d.role || '-'} —— ${d.why}`)
  }
  return out
}

/** 词表自检：保证 CLUES / ACT_WORDS 不会写出词表外的用法。 */
export function vocabSanity() {
  const badUses = Object.keys(CLUES).filter((use) => !USES.includes(use))
  const missing = USES.filter((use) => !CLUES[use])
  const badRoles = Object.keys(ROLE_CLUES).filter((role) => !ROLES.includes(role))
  return { ok: !badUses.length && !missing.length && !badRoles.length, badUses, missing, badRoles }
}