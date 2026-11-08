// 表情图库的标签体系：维度化 + 受控词表 + 同义词归一。
//
// 为什么要有这个文件（主人 2026-11-09）：
//   「让表情包和图片被整理后进库，方便鱼直接调用图片而不需要识别图片，
//    只要识别标签就可以了，所以标签要细一些，防止重复太多让鱼识别错误。」
//
// 以前标签是视觉模型自由发挥（3-6 个词），同一张「摸头」图可能出现
// 「摸一摸 / 摸摸头 / 被摸头」三种写法；鱼按标签找图时三种都搜不到。
// 现在：标签按维度产出（主体 / 情绪 / 动作 / 场景 / 形态），同义词统一成词表里的写法，
// 鱼先看「标签目录」（sticker-tags 不带参数），再按标签取图，不用逐张识别画面。
//
// 这个模块不依赖任何别的模块（stickers / sticker-vision / tool 都可以 import 它）。

/** 标签维度：给视觉模型看的产出结构。数组顺序就是提示词里的顺序。 */
export const TAG_DIMENSIONS = [
  {
    key: '主体',
    hint: '画面里是谁或什么',
    sample: ['蓝鲸娘', '猫', '鲸鱼', '机器人', '食物'],
  },
  {
    key: '情绪',
    hint: '这张图传达的情绪（选最贴近的一个）',
    sample: ['开心', '得意', '害羞', '难过', '生气', '无语', '困', '饿', '兴奋', '平静', '委屈', '疑惑', '嫌弃', '惊讶'],
  },
  {
    key: '动作',
    hint: '画面里在做什么',
    sample: ['摸头', '拥抱', '掏刀', '吃饭', '睡觉', '点赞', '握手', '挥手', '跑', '哭', '笑', '比心', '戳', '拍桌', '递东西', '躺'],
  },
  {
    key: '场景',
    hint: '适合什么时候用',
    sample: ['打招呼', '道晚安', '被夸', '被催', '道歉', '安慰', '告别', '庆祝', '拒绝', '卖萌'],
  },
  {
    key: '形态',
    hint: '图片形态（动图必须写）',
    sample: ['动图', '静图', '表情包', '立绘', '截图'],
  },
]

/** 同义词 → 词表标准写法。只放真的会撞车的，不追求大而全。 */
export const SYNONYMS = {
  // 动作
  摸一摸: '摸头', 摸摸: '摸头', 摸摸头: '摸头', 被摸头: '摸头', 摸头杀: '摸头',
  抱抱: '拥抱', 抱住: '拥抱', 抱: '拥抱', 抱一抱: '拥抱',
  掏刀子: '掏刀', 拔刀: '掏刀',
  干饭: '吃饭', 吃东西: '吃饭', 吃饭饭: '吃饭',
  睡: '睡觉', 睡了: '睡觉', 打盹: '睡觉', 困觉: '睡觉',
  赞: '点赞', 点赞赞: '点赞',
  招手: '挥手', 拜拜: '挥手',
  哭哭: '哭', 大哭: '哭',
  笑笑: '笑', 大笑: '笑',
  比心: '比心',
  戳一戳: '戳', 戳戳: '戳',
  // 情绪
  高兴: '开心', 快乐: '开心', 开森: '开心',
  得意洋洋: '得意', 骄傲: '得意',
  害羞了: '害羞', 脸红: '害羞',
  伤心: '难过', 悲痛: '难过',
  愤怒: '生气', 怒: '生气', 气鼓鼓: '生气',
  无奈: '无语', 沉默: '无语',
  睏: '困', 好困: '困',
  饿了: '饿', 好饿: '饿',
  激动: '兴奋',
  困惑: '疑惑', 疑问: '疑惑', 问号: '疑惑',
  鄙视: '嫌弃', 嫌弃脸: '嫌弃',
  // 场景
  你好: '打招呼', 嗨: '打招呼',
  晚安: '道晚安', 睡好: '道晚安',
  夸奖: '被夸', 被称赞: '被夸',
  催: '被催', 催更: '被催',
  对不起: '道歉',
  安慰人: '安慰', 摸摸安慰: '安慰',
  再见: '告别',
  庆祝: '庆祝', 恭喜: '庆祝',
  不行: '拒绝',
  卖萌: '卖萌', 撒娇: '卖萌',
  // 形态
  gif: '动图', GIF: '动图', 动态: '动图', 动图表情: '动图', 动图表情包: '动图',
  静态: '静图', 静止: '静图', 静图版: '静图',
  表情: '表情包', 表情图: '表情包',
  // 主体
  鲸鱼娘: '蓝鲸娘', 小鲸鱼: '蓝鲸娘', 大肥鱼: '蓝鲸娘', 肥鱼: '蓝鲸娘',
  小猫: '猫', 喵: '猫',
}

/** 归一化：去掉首尾空白/多余空格、英文小写化、同义词映射到标准写法。 */
export function normalizeTag(tag) {
  let text = String(tag == null ? '' : tag).trim().replace(/\s+/g, ' ')
  if (!text) return ''
  // 英文统一小写（synonyms 里同时留了 gif / GIF 两种写法兜底）
  const lower = text.toLowerCase()
  if (SYNONYMS[text]) return SYNONYMS[text]
  if (SYNONYMS[lower]) return SYNONYMS[lower]
  // 去掉结尾的「了」「的」这类虚词造成的近似重复
  const trimmed = text.replace(/[了的]$/, '')
  if (trimmed && trimmed !== text) {
    if (SYNONYMS[trimmed]) return SYNONYMS[trimmed]
    if (SYNONYMS[trimmed.toLowerCase()]) return SYNONYMS[trimmed.toLowerCase()]
    return trimmed
  }
  return text
}

/** 一批标签：归一化 + 去重（保序），并丢掉空串。 */
export function dedupeTags(tags) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = normalizeTag(raw)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** 给视觉模型的词表提示（拼进整理提示词）。 */
export function promptHints() {
  const dims = TAG_DIMENSIONS.map((dim) => `- ${dim.key}（${dim.hint}）：${dim.sample.join(' / ')}`)
  return [
    '标签要按下面五个维度来给，每个维度选 1–2 个，总数 5–9 个，优先用括号里给出的写法：',
    ...dims,
    '凡是画面里的动图，必须带「动图」；静图带「静图」。',
    '不要自创新词，词表里没有才用最短的通用词，别把同一件事写成好几种说法。',
  ].join('\n')
}

/** 把任意一批标签整理成「词表内优先」的写法（用于旧数据迁移 / 面板编辑后的归一）。 */
export function canonicalizeTags(tags) {
  const list = dedupeTags(tags)
  const vocab = new Set()
  for (const dim of TAG_DIMENSIONS) for (const word of dim.sample) vocab.add(word)
  // 词表内的提到前面（鱼看目录时常用标签更显眼），其余保持原序
  const inside = list.filter((tag) => vocab.has(tag))
  const outside = list.filter((tag) => !vocab.has(tag))
  return [...inside, ...outside]
}
