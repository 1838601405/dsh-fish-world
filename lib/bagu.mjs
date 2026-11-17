// 鱼八股检测：把主人给的判据「格言堆叠」写成可测的纯函数。
//
// 判据原话：**每句话单独看都对、都能当签名，串起来没有人在场。**
//
// 所以这里不存例句、不认句式（没有「宁可…也不能…」这种清单，那只是病征不是病因），
// 只回答两个问题：
//   1. 这一句能不能当签名？（有判断 + 没有任何落地指代 + 长度像一句签名）
//   2. 整段里有几条这样的句子，并且整段有没有人/时间/物在场？
//
// 一条能当签名的句子不算八股（谁都会甩一句金句）；两条以上、且整段一个具体的
// 人/时间/物都没有，才是「没有人在场」的格言堆叠。
//
// 纯函数：不 import 任何东西、不读盘、不联网、不看当前时间。同样的输入永远同样的输出。
//
// 两级切分（这条是判据的骨架）：
//   · 句子（clausesOf）：按 。！？!?；; 和换行切 —— 契约不变，对外就是「句子」
//   · 分句（piecesOf，内部）：在句子下面再按 ，,、 切一层
// 为什么必须两级：最典型的八股不是六个句号，而是**一整段逗号连缀** —— 六个判断
// 塞进一个句号里。只按句子数会把它算成 1 句、被「≥2」门槛漏掉。
//
// 导出函数的边界（谁调用都要知道）：
//   · clausesOf          只切句，不改字（去掉的只有首尾空白和 ，,、 这些边角）
//   · isSignatureClause  单句判据，宁可漏判也不乱判（判据要能失败，但不能在真鱼话上乱红）
//   · looksLikeBagu      整段判据：句子/分句任一层面签名 ≥2 条，且整段没有任何落地指代
//   · shortestClause     分句层面最短的那一段（一定是原文片段）
//   · baguReport         诊断视图，不参与判定

/** 判断词：一句话要先「有观点」，才可能被人拿去当签名。 */
const JUDGMENT_WORDS = Object.freeze([
  '是',
  '要',
  '得',
  '才',
  '就',
  '永远',
  '从不',
  '无非',
  '本质',
  '说到底',
])

/**
 * 落地指代：出现任何一个，就说明这段话里有具体的人/时间/物在场。
 *
 * 分四类，都是「可数、可指、可对上号」的东西 —— 抽象名词（人、事、日子、规矩）
 * 不算，因为格言里也满是这些词。
 */
const ANCHOR_PATTERNS = Object.freeze([
  // ① 人称：有「谁」在说话/被说
  /[我你他她它咱俺您]/,
  /@\S/,
  // ② 指示代词 + 量词/处所：指着眼前那一件具体东西
  /(这个|那个|这些|那些|这种|那种|这里|那里|这边|那边|这段|那段|这句|那句|这位|那位|这次|那次|这回|那回)/,
  /[这那][个只条件张把次天年句段位名本回遍篇]/,
  // ③ 具体时间
  /(今天|昨天|明天|前天|后天|刚才|刚刚|现在|目前|如今|早上|上午|中午|下午|傍晚|晚上|夜里|凌晨|半夜|今年|去年|明年|上个月|下个月|这个月|上周|下周|这周|周末|礼拜|星期)/,
  /周[一二三四五六日天末]/,
  /\d{1,2}\s*(点|时)(半|\d{1,2}\s*分)?/,
  /\d{1,2}\s*[:：]\s*\d{1,2}/,
  /\d{1,4}\s*(年|月|日|号|岁)/,
  // ④ 数字 + 量词/单位：能数出来、能对上号的东西
  /\d+\s*(个|只|条|次|天|年|月|日|号|岁|块|元|毛|分|秒|分钟|小时|斤|公斤|克|米|公里|人|遍|句|段|张|件|位|名|点|倍|度|%|％|℃)/,
  // 中文数字的量词搭配。刻意不含「一」：「一辈子」「一点」「一心」这类是格言里的
  // 惯用说法，算进去就会把「人这一辈子，图的就是个踏实」误判成有落地指代。
  /[两二三四五六七八九十]\s*(个|只|条|次|天|年|月|号|岁|块|元|点|分|小时|斤|公斤|公里|遍|句|段|张|件|位|名|倍|度)/,
  /第\s*[一二三四五六七八九十百千\d]+/,
  // ⑤ 链接 / 行内代码 / 表情包占位：这些一定是「具体某一件事」
  /https?:\/\//i,
  /www\./i,
  /\b[\w-]+\.(com|cn|net|org|io|dev|me|top)\b/i,
  /`[^`\n]*`/,
  /\[[^\]\n]{1,12}\]/,
  /〔[^〕\n]{1,12}〕/,
])

/** 签名句的长度窗口（按字符数）：太短是口头禅，太长是解释。 */
const MIN_SIGNATURE_CHARS = 6
const MAX_SIGNATURE_CHARS = 40

/** 整段里要几条签名句才算堆叠：一条是金句，两条以上才是堆。 */
const MIN_SIGNATURE_CLAUSES = 2

/** 切句用的分隔符：句末标点 + 换行（\r 一起吃掉，免得 Windows 换行留下空句）。 */
const CLAUSE_SPLITTER = /[。！？!?；;\n\r]+/

/**
 * 分句用的分隔符：逗号 / 顿号。
 *
 * 为什么要再切一层：八股最常见的形态根本不是六个句号，而是**一整段逗号连缀** ——
 * 一口气六个判断，中间不带句号。只按句末标点数，这种整段只算 1 句，会被
 * 「≥2」直接卡掉，等于判据漏掉了最典型的那一类。
 */
const PIECE_SPLITTER = /[，,、]+/

/** 句首句尾要去掉的边角：空白和 ，,、 不算句子内容。 */
const EDGE_NOISE = /^[\s，,、]+|[\s，,、]+$/g

/** 一段文字里有没有具体的「人/时间/物」。 */
function hasAnchor(text) {
  if (typeof text !== 'string' || text === '') return false
  return ANCHOR_PATTERNS.some((pattern) => pattern.test(text))
}

/** 去掉句子首尾的空白和逗号类边角（只动两端，中间一个字不改）。 */
function trimEdges(clause) {
  return clause.replace(EDGE_NOISE, '')
}

/** 按字符数算长度：代理对（表情）算一个字，别被 length 骗。 */
function charCount(text) {
  return [...text].length
}

/**
 * 按句末标点和换行切句，丢掉空白句。
 *
 * 逗号不是分隔符 —— 一句话里带个逗号还是同一句。
 *
 * @param {string} text
 * @returns {string[]} 每项都是原文里连续存在的一段（只去了首尾边角）
 */
export function clausesOf(text) {
  if (typeof text !== 'string' || text === '') return []
  return text
    .split(CLAUSE_SPLITTER)
    .map(trimEdges)
    .filter((clause) => clause.length > 0)
}

/**
 * 在「句子」下面再切一层「分句」：逗号 / 顿号。
 *
 * 只给内部判定用（clausesOf 的契约不变，别的调用方仍拿句子）。
 * 切出来的每一段同样只动首尾边角，所以一定是原文里真实存在的片段。
 *
 * @param {string} text
 * @returns {string[]}
 */
function piecesOf(text) {
  if (typeof text !== 'string' || text === '') return []
  return text
    .split(CLAUSE_SPLITTER)
    .flatMap((clause) => clause.split(PIECE_SPLITTER))
    .map(trimEdges)
    .filter((piece) => piece.length > 0)
}

/**
 * 这一句能不能当签名？
 *
 * 三条同时满足才算：有判断词、没有任何落地指代、长度在 6..40 字。
 * 少一条都不算 —— 缺判断词是叙述，有指代是聊天，长度不对是口头禅或长解释。
 *
 * @param {string} clause
 * @returns {boolean}
 */
export function isSignatureClause(clause) {
  if (typeof clause !== 'string') return false
  const text = trimEdges(clause)
  const size = charCount(text)
  if (size < MIN_SIGNATURE_CHARS || size > MAX_SIGNATURE_CHARS) return false
  if (!JUDGMENT_WORDS.some((word) => text.includes(word))) return false
  if (hasAnchor(text)) return false
  return true
}

/** 数一批候选里有几条能当签名。 */
function countSignatures(units) {
  let hits = 0
  for (const unit of units) {
    if (isSignatureClause(unit)) hits += 1
  }
  return hits
}

/**
 * 整段是不是「格言堆叠」？
 *
 * 两个条件同时成立才算：能当签名的句子/分句 ≥2 条，且整段没有任何落地指代。
 * 整段只要出现一个人/时间/物，就说明有人在现场 —— 一律放行。
 *
 * 「≥2 条」按两种读法各数一遍，取更宽的那一种：
 *   · 按句子数：每句本身就是一条签名（短句横幅式八股）
 *   · 按分句数：一整段逗号连缀，六个判断塞进一个句号里（最典型的那一类）
 * 两种都数不到 2 条才放行。只数句子会漏掉逗号连缀；只数分句会把
 * 「东西好不好，吃过才知道」这类整句才成立的签名拆碎，所以两边都要看。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeBagu(text) {
  if (typeof text !== 'string') return false
  if (hasAnchor(text)) return false
  if (countSignatures(clausesOf(text)) >= MIN_SIGNATURE_CLAUSES) return true
  return countSignatures(piecesOf(text)) >= MIN_SIGNATURE_CLAUSES
}

/**
 * 最短的那一段（命中八股时只发它，别把整段背出来）。
 *
 * 在分句层面找：逗号连缀的八股里，最短的往往是最像签名的那一截。
 * 返回的一定是原文里真实存在的一段文字：切句只动首尾边角，不改字。
 * 一样长的时候取先出现的；切不出来就返回空串。
 *
 * @param {string} text
 * @returns {string}
 */
export function shortestClause(text) {
  const pieces = piecesOf(text)
  if (pieces.length === 0) return ''
  let best = pieces[0]
  let bestSize = charCount(best)
  for (const piece of pieces) {
    const size = charCount(piece)
    if (size < bestSize) {
      best = piece
      bestSize = size
    }
  }
  return best
}

/**
 * 诊断用：把一次判定的中间结果摊开（面板 / 日志 / 手跑核对用）。
 *
 * 只读，不参与 looksLikeBagu 的判定 —— 判定永远只看上面那几条判据。
 *
 * @param {string} text
 * @returns {{bagu: boolean, clauseCount: number, pieceCount: number, signaturePieces: string[], anchored: boolean, shortest: string}}
 */
export function baguReport(text) {
  const clauses = clausesOf(text)
  const pieces = piecesOf(text)
  return {
    bagu: looksLikeBagu(text),
    clauseCount: clauses.length,
    pieceCount: pieces.length,
    signaturePieces: pieces.filter(isSignatureClause),
    anchored: hasAnchor(typeof text === 'string' ? text : ''),
    shortest: shortestClause(text),
  }
}

