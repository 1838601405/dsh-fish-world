// 梗 / 语录识别：在聊天里做，不另跑模型。
//
// 三条触发（任一）：
//   ① 出现知识库里没有的新词（模型用「？」这类疑似不认识的口气，或主人用不认识的词）
//   ② 同一句话被多人重复
//   ③ 明显是梗的句式（v我50 / X 是什么鬼 / 难绷 / 何意味 …）
// 产出 candidate，落库时写现有 知识库.json，type=meme|quote，status=pending。
//
// 为什么写在桌面端而不是插件里：桌面版独立收答时插件可能没跑；
// 知识库文件两边共用一个，写进去插件也能读到。

const MEME_SHAPES = [
  'v我50',
  'V我50',
  '是什么鬼',
  '难绷',
  '何意味',
  '绷不住',
  '乐死',
  '典中典',
  '好家伙',
  '笑死',
  '蚌埠住了',
  '真的假的',
  '笑不活了',
];

// 明显不是梗的词：数字、标点、超短语气词。
function looksLikeWord(token) {
  if (!token) return false;
  const t = token.trim();
  if (t.length < 2 || t.length > 12) return false;
  if (/^[0-9]+$/.test(t)) return false;
  if (/^[。！？，、…~～\-—]+$/.test(t)) return false;
  return true;
}

// 从一句话里抽出「像新词」的片段：被引号 / 书名号括起来的、或者整句就是一个短词。
export function extractCandidate(sentence) {
  const s = String(sentence || '').trim();
  if (!s) return null;
  const quoted = s.match(/[「『"“]([^」』"”]{2,12})[」』"”]/);
  if (quoted) {
    const w = quoted[1].trim();
    if (looksLikeWord(w)) return { name: w, kind: 'meme', why: '被引号括起来的新词' };
  }
  for (const shape of MEME_SHAPES) {
    if (!s.includes(shape)) continue;
    // 梗句式的整句就是候选；名字取句式本身，方便查重。
    return { name: shape, kind: 'meme', why: '命中梗句式「' + shape + '」', sentence: s };
  }
  if (s.length <= 12 && looksLikeWord(s)) {
    return { name: s, kind: 'meme', why: '整句就是一个短词' };
  }
  return null;
}

// 长文本 / 引用体 / 段子 → 语录候选。
//
// 与 extractCandidate（短梗）互补：那段只认 ≤12 字的短词，转发的整段语录/定律/段子
// 全被漏掉，结果就是「识别到语录 → 写库」这条链从来没走过一次（知识库 mtime 停在 10-28）。
// 判据要能真红：够长、带引用、多人对话、命中语录腔（定律/效应/最后才是…）才认；
// 普通闲聊一句「今天天气不错」不能变成语录。
const QUOTE_MARKERS = /(定律|效应|法则|口诀|引力井|白熊|不是.{0,12}而是|最后才是|说到底|本视频|特别致谢)/

function summarize(text, limit = 24) {
  const s = String(text || '').trim()
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  // 优先在标点处收，别把词截断；找不到就硬截加省略号。
  const marks = [...cut.matchAll(/[。！？!?；;，,、：:]/g)]
  const at = marks.length ? marks[marks.length - 1].index + 1 : limit
  return (at >= 6 ? cut.slice(0, at) : cut).replace(/[，,、：:]$/, '') + '…'
}

export function extractQuote({ text, name = '', meaning = '', why = '' } = {}) {
  const s = String(text || '').replace(/\r/g, '').trim()
  if (!s) return null
  const plain = s.replace(/\[[^\]]{1,8}\]/g, '').trim()
  const lines = plain.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  const longEnough = plain.length >= 45
  const quoted = /[「『“"]/.test(plain) && /[」』”"]/.test(plain)
  const dialogue = lines.length >= 2 && lines.some((line) => /[：:]/.test(line) && line.length <= 60)
  const marked = QUOTE_MARKERS.test(plain) && plain.length >= 12
  if (!longEnough && !quoted && !(dialogue && lines.length >= 3) && !marked) return null

  const first = lines[0] || plain
  const pieces = first.split(/(?<=[。！？!?；;])/).filter(Boolean)
  const nameOut = String(name || '').trim() || summarize(pieces[0] || first)
  let meaningOut = String(meaning || '').trim()
  if (!meaningOut) {
    // 关键句优先：命中语录腔的那几句；没有就取前两句。上限 140 字，别把整段塞进 meaning。
    const hits = lines.filter((line) => QUOTE_MARKERS.test(line))
    const picked = (hits.length ? hits : lines.slice(0, 2)).join(' ')
    meaningOut = picked.length > 140 ? picked.slice(0, 140) + '…' : picked
  }
  return { name: nameOut, kind: 'quote', why: why || '长文本/引用体/段子', meaning: meaningOut, sentence: s }
}

// 同一句话 5 分钟内被 ≥2 个人说过 → 语录候选。
export function repeatedQuote({ text, speakers, count }) {
  if (!text || count < 2) return null;
  if (new Set(speakers || []).size < 2) return null;
  return {
    name: text.length > 12 ? text.slice(0, 12) : text,
    kind: 'quote',
    why: '同一句话被 ' + new Set(speakers).size + ' 个人重复',
    sentence: text,
  };
}

// 去重：name 或 aliases 命中已有条目 ⇒ 只追加别名，不新建。
export function findDuplicate(items, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  for (const it of items || []) {
    const names = [it.name, ...(Array.isArray(it.aliases) ? it.aliases : [])]
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean);
    if (names.includes(key)) return it;
  }
  return null;
}

// 生成一条待确认条目（字段沿用现有知识库）。
// 名字超过 24 字时按标点收口，别把词砍成半截（「主语不动 / 化」这种）。
function tidyName(value, limit = 24) {
  const s = String(value || '').trim()
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const marks = [...cut.matchAll(/[。！？!?；;，,、：:/／·]/g)]
  const at = marks.length ? marks[marks.length - 1].index : limit
  const head = at >= 8 ? cut.slice(0, at) : cut
  return head.replace(/[\s/／·、，,：:；;]+$/, '') + '…'
}

export function buildPendingItem({ name, kind, why, sentence, source, meaning, now = Date.now() }) {
  const isQuote = kind === 'quote'
  return {
    id: 'pending-' + kind + '-' + String(now),
    type: isQuote ? 'quote' : 'meme',
    name: tidyName(name),
    aliases: [],
    // 语录的 meaning 是全文关键句，不是「待确认」占位；写进去才对模型有用。
    meaning: String(meaning || (isQuote ? sentence : '待确认') || '').slice(0, 200),
    usage: '',
    avoid: '',
    source: String(source || ''),
    status: 'pending',
    why: String(why || ''),
    quote: String(sentence || ''),
    addedAt: now,
    checkedAt: 0,
  };
}

// 只把 confirmed 的梗喂给模型；pending 的只能「问一句这是啥」。
export function splitForPrompt(items) {
  const confirmed = [];
  const pending = [];
  for (const it of items || []) {
    const status = String(it.status || 'confirmed');
    if (status === 'confirmed') confirmed.push(it);
    else if (status === 'pending') pending.push(it);
  }
  return { confirmed, pending };
}
