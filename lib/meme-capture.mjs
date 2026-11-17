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
export function buildPendingItem({ name, kind, why, sentence, source, now = Date.now() }) {
  return {
    id: 'pending-' + kind + '-' + String(now),
    type: kind === 'quote' ? 'quote' : 'meme',
    name: String(name || '').slice(0, 24),
    aliases: [],
    meaning: '待确认',
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
