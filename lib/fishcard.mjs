// 鱼卡 v3 解析层（2026-11-23 主人规格《鱼卡-v1-规格.md》§1–§2）。
//
// ── 只做一件事：把一张卡摊成结构 ──
// 解析不判断该不该注入（那是 lib/fishcard-select.mjs 的事），也不读文件（调用方给文本）。
// 这样解析器可以纯函数测，不必造文件系统。
//
// ── 三种节头（规格 §2「只有三种」）──
//   ### 【常驻】你是谁          → 每轮都进
//   ### 【条件 keys=饭,饿】白饭  → 说到才进（keys= 或 when= 至少一个）
//   ### 【语料】冷启动示例      → 仅会话前 3 轮
//
// ── 三条不丢信息的兜底（规格 §2）──
//   · 未识别的标记 → 按常驻兜底**并报一条**（宁可多注入，不静默丢）
//   · `条件` 少了 keys/when → 同上
//   · 没有 front-matter 的旧卡 → **整张当常驻，body 与输入逐字节一致**
//     （规格 §11 验收 #1 就是拿这条卡的；`default.md` 3212 字、无 front-matter）
//
// ── front-matter 为什么不引 YAML 库 ──
// 规格 §12 自己写了取舍：「md 分节 + front-matter，不引 JSON。坏：只能 lint 不能校验」。
// 样例只有标量 + 一个内联 flow map（budget: {…}），手写够用；引 js-yaml 要动
// package.json 的依赖，而它本机虽有却从没被本仓 import 过 —— 为5 个键背一个依赖不值。

/** 规格 §1 front-matter 样例的键；不在表里的键保留原样（不丢信息），只是不参与决策。 */
const KNOWN_FM = new Set(['fishcard', 'preset', 'suggestedName', 'version', 'budget'])

/** 节头形态：`### 【档】标题`，档后可带空格分隔的属性（keys=/when=/order=/cooldown=）。 */
const HEAD_RE = /^#{3}\s*【([^】]+)】\s*(.*)$/

/** 只认这三种档名；`【條件】` 这类拼错的走「未识别」分支（体检第 1 项盯的就是它）。 */
const TIERS = new Set(['常驻', '条件', '语料'])

/** 默认值来自规格 §2：`order` 越小越靠前、默认 100；`cooldown` 单位是轮。 */
const DEFAULT_ORDER = 100
const DEFAULT_COOLDOWN = 0

/**
 * 解析一张鱼卡。
 *
 * @param {string} text 卡的全文（可能是旧卡：没有 front-matter、没有 ### 节头）
 * @returns {{
 *   frontmatter: Record<string, unknown>|null,
 *   sections: Array<{tier:'常驻'|'条件'|'语料', title:string, keys:string[],
 *                    when:string, order:number, cooldown:number, body:string}>,
 *   warnings: string[],
 *   legacy: boolean,
 * }}
 *   · `legacy=true` 表示这是旧卡：整张一个「常驻」节，body 与输入**逐字节相同**
 *   · `warnings` 逐条说明哪里被兜底了（给体检与日志用，不静默）
 */
export function parseCard(text) {
  const src = String(text ?? '')
  const warnings = []

  const { fm, body } = splitFrontmatter(src, warnings)

  // ★ 旧卡：没有 front-matter ⇒ 整张当常驻，一个字都不切（验收 #1 的依据）。
  //   反过来说，有 front-matter 就一定有节头 —— 没有则整段当常驻并报一条，
  //   否则「写了 front-matter 却没分节」会静默丢掉全部内容。
  if (!fm) {
    return { frontmatter: null, sections: [resident(src)], warnings, legacy: true }
  }

  const sections = []
  let current = null
  const lines = body.split(/\r?\n/)
  let headSeen = false

  for (const line of lines) {
    const m = HEAD_RE.exec(line)
    if (m) {
      headSeen = true
      current = makeSection(m[1], m[2], warnings)
      sections.push(current)
      continue
    }
    // 节头之前的内容（含空行）也归当前节；一个节头都没有时 current 仍是 null
    if (current) current.body += (current.body === '' ? '' : '\n') + line
    else if (line.trim() !== '') {
      // front-matter 之后、第一个节头之前有正文 ⇒ 丢掉就是丢信息，兜进常驻
      current = resident('')
      sections.push(current)
      current.body = line
    }
  }

  if (!headSeen) {
    warnings.push('有 front-matter 但一个 ### 节头都没有 —— 整段按常驻兜底（不丢信息）')
    return { frontmatter: fm, sections: [resident(body)], warnings, legacy: false }
  }

  // 收尾：去掉末尾多余空行，但**保留**内部换行（body 逐字节的承诺只对旧卡，
  // 新卡按节切过，trim 只为不把节与节之间的空行算进内容）
  for (const s of sections) s.body = s.body.replace(/^\n+/, '').replace(/\n+$/, '')

  return { frontmatter: fm, sections, warnings, legacy: false }
}

/** 一个常驻节（兜底用；标题给个占位，调用方不按标题找内容）。 */
function resident(body) {
  return { tier: '常驻', title: '', keys: [], when: '', order: DEFAULT_ORDER, cooldown: DEFAULT_COOLDOWN, body }
}

/**
 * 把 `【档】标题` 后面的属性串解析成一个节。
 * 认不出的档名 / 缺 keys+when 的条件节 → **兜底成常驻并报一条**（规格 §2）。
 */
function makeSection(rawTier, rest, warnings) {
  // ★ 属性在**档名内部**：`【条件 keys=饭,饿,白饭】白饭` ——
  //   正则 `【([^】]+)】` 捕获的是「条件 keys=饭,饿,白饭」整段，
  //   不先按第一个空格切开就会被当成未识别档名（我第一版就是这么错的）。
  const s = String(rawTier)
  const sp = s.search(/\s/)
  const tier = (sp < 0 ? s : s.slice(0, sp)).trim()
  const inlineAttrs = sp < 0 ? '' : s.slice(sp + 1).trim()

  // 属性可能落在两处：档名里（规格样例都是）或标题后（兼容），档名里的优先
  const fromTitle = splitAttrs(rest)
  const attrs = { ...fromTitle.attrs, ...parseAttrPairs(inlineAttrs) }
  const title = fromTitle.title

  if (!TIERS.has(tier)) {
    warnings.push(`未识别的节头「【${s}】${title}」→ 按常驻兜底（可能是拼错，体检第 1 项）`)
    return { ...resident(''), title }
  }

  const keys = splitList(attrs.keys)
  const when = String(attrs.when || '').trim()

  if (tier === '条件' && keys.length === 0 && !when) {
    warnings.push(`「【条件】${title}」既没有 keys= 也没有 when= → 按常驻兜底（否则这条永远不进）`)
    return { ...resident(''), title }
  }

  return {
    tier,
    title,
    keys,
    when,
    order: numAttr(attrs.order, DEFAULT_ORDER),
    cooldown: numAttr(attrs.cooldown, DEFAULT_COOLDOWN),
    body: '',
  }
}

/**
 * 把 `keys=a,b when=owner order=5` 解析成对象。
 * 用「空格 + 已知键名」切，避免把 `keys=饭,饿` 的值切成两半。
 */
function parseAttrPairs(str) {
  const attrs = {}
  const s = String(str || '').trim()
  if (!s) return attrs
  for (const piece of s.split(/\s+(?=(?:keys|when|order|cooldown)=)/)) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    attrs[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim()
  }
  return attrs
}

/**
 * 拆 `标题 keys=a,b when=owner` → 标题 + 属性（属性在标题后时用）。
 * 属性只认 `k=v` 形态。
 */
function splitAttrs(rest) {
  const s = String(rest || '')
  // 属性段从第一个 ` key=` 开始（标题里可以有空格，所以不能按空格硬切）
  const m = /\s((?:keys|when|order|cooldown)=)/.exec(s)
  if (!m) return { title: s.trim(), attrs: {} }
  return {
    title: s.slice(0, m.index).trim(),
    attrs: parseAttrPairs(s.slice(m.index + 1)),
  }
}

/** `keys=饭,饿, 白饭` → `['饭','饿','白饭']`（中英文逗号都认，去空去重）。 */
function splitList(v) {
  if (!v) return []
  return [...new Set(String(v).split(/[,，]/).map((x) => x.trim()).filter(Boolean))]
}

function numAttr(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/**
 * 拆 front-matter。
 * @returns {{fm: Record<string,unknown>|null, body: string}}
 *   没有 front-matter ⇒ `fm=null`、`body=全文`（**原样**，一个字符都不动）
 */
function splitFrontmatter(src, warnings) {
  // 必须是文件开头的 `---`（允许 BOM 与前置空行），且要有闭合的 `---`
  const m = /^(?:\uFEFF)?[ \t]*\r?\n?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!m) return { fm: null, body: src }

  const fmText = m[1]
  const body = src.slice(m[0].length)
  const fm = {}
  for (const raw of fmText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf(':')
    if (eq < 0) { warnings.push(`front-matter 里认不出的行「${line}」（没有冒号）→ 忽略`); continue }
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // 内联 flow map / flow list：原样保留成字符串，不做结构化解析
    // （规格 §12：只能 lint 不能校验 —— 复杂结构交给 lint，不在这里猜）
    if (val.startsWith('{') || val.startsWith('[')) val = val
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val)
    else if (val === 'true') val = true
    else if (val === 'false') val = false
    else val = val.replace(/^['"]|['"]$/g, '')
    fm[key] = val
  }
  if (!KNOWN_FM.size) warnings.push('KNOWN_FM 为空（不该发生）')
  return { fm, body }
}
