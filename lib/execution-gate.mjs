// 执行层：从「知道」到「做到」（2026-11-21 主人要求）。
//
// ── 现象（真机）──
// 她说了「对，我在先总结再挑一句」「这就是你说的那种毛病」——
// 她完全知道问题是什么、也知道该怎么改，但**下一句照样犯**。
//
// ── 结论 ──
// 这类规则不能只写在提示词里。模型能复述规则，不代表生成时会执行。
// 必须在输出链上加一道**执行层**。
//
// ── 这一层和提示词的分工 ──
//   · 提示词：正向锚定（顺着往下走 / 回应的是人 / 换口气）—— 影响"想生成什么"
//   · 这一层：**拦截 + 给替代** —— 保证"不达标的不出去"
//
//   两者都要。只写提示词 = 她会复述规则但照犯（就是现在的现象）；
//   只做拦截 = 她会说不出话（没有替代品，只能丢）。
//
// ── 三件事 ──
//   ① 三条闸（评论式开场 / 评点结构 / 自我诊断）
//   ② 重写：命中后**给三选一的指令**让她重来，不是给"禁止 X"的清单
//   ③ 兜底：重写仍不合格 → 最短反应（？/草/6）或不发
//
// ── ★ 为什么不给「禁止 X」清单 ──
// 主人定过：每轮进上下文的禁词会形成语义引力井（白熊效应），越写越容易撞上。
// 所以重写指令只给三个**动作**（往下推 / 拉回两个人 / 直说嫌恶），不给黑名单。

/** 闸的类别（activity 里用这些标签）。 */
export const GATE_KIND = Object.freeze({
  COMMENTARY: 'commentary',         // 评论式开场
  CRITIQUE: 'critique',             // 评点结构
  SELF_DIAGNOSIS: 'self-diagnosis', // 自我诊断
  // ★★ 2026-11-21 主人要求「去掉解说体」：
  //   根因 —— 她把「我理解了」输出成了「我来讲讲这是什么」。
  //   理解是自己的，解说是在给观众讲 —— 而群里没有观众。
  NARRATION: 'narration',           // 解说体（注释/考据/设定）
  COMMITMENT: 'commitment',         // 认错后补承诺（「以后不评了」）
  TECH_REPORT: 'tech-report',       // 技术报告腔（「返回 200」）
  GOLDEN_LINE: 'golden-line'        // 金句体（能当签名的单句）
})

/** 兜底用的最短反应（主人给的清单）。 */
export const MINIMAL_REACTIONS = Object.freeze(['？', '草', '6', '嗯', '难绷'])

// ── 闸 1：评论式开场（以这些词开头就是没在跟人说话，在评文本）──
//
// ★ 只认**开头**：正文里提到「这段」是正常指代（「这段给你」）。
const OPENERS = [
  /^(?:通篇|整篇|全文|全篇)/,
  // ★ 「这段」后面必须跟评点动词才算 —— 「这段给你」「这段呢」是正常指代
  /^(?:这段话|这段|这句|这句话|这句诗)(?:写|说|讲|评|看|读)/,
  /^(?:前面|后面)(?:都|还|才|我|那句|这段|写|说)/
]

// ── 闸 2：评点结构（把话当文本打分）──
const CRITIQUES = [
  /只有(?:[^，。！？]{1,20})那句是真的/,
  /(?:这段|这句|这篇|这句诗)(?:写|说|讲|评)(?:得|的)/,
  /前面(?:都)?还能忍/,
  /它还真敢往下推/,
  /(?:比|较)(?:之前|刚才)(?:的)?(?:都)?(?:重|轻|稳|平|强|沉)/
]

// ── 闸 3：自我诊断（把"认错"当成接话）──
//
// ★ 主人特别点名：「第 3 条特别重要：她把'认错'当成了接话，实际还是在聊自己。」
const SELF_DIAG = [
  /我在(?:先|又|老是|总是)/,               // 「我在先总结」
  /这就是你说的/,                          // 「这就是你说的那种毛病」
  /我(?:这|那)(?:就是|是)(?:个|种)?[^，。！？]{0,8}(?:毛病|习惯|问题|惯性)/,
  /我知道我(?:又|在|这|是)/,               // 「我知道我又…」
  /我(?:老|总|又|总是)(?:是)?(?:犯|想|爱|这样|这么|来|在)/
]

// ── 闸 4：解说体（2026-11-21 主人要求「去掉解说体：认出就够了，不用讲解」）──
//
// 主人给的现象：
//   · 对别人发的东西做注释（「把 MyGO 写成克苏鲁了」「沙耶之歌那个设定是…」）
//   · 查出处、发新闻链接（[这里有一版](…)）
//   · 技术报告腔（「返回 200」「star 都 5969 了」）
//
// 根因：她把「我理解了」输出成了「我来讲讲这是什么」。
// ★ 判据只看"长什么样"—— 解说体有很固定的句式，不需要理解语义。
const NARRATION = [
  /把[^，。！？]{1,12}写成[^，。！？]{1,12}了/,   // 「把 MyGO 写成克苏鲁了」
  /(?:那个|这个)?设定(?:是|就|其实)/,           // 「沙耶之歌那个设定是…」
  /这不就是[^，。！？]{1,16}吗/,                 // 解释句
  /(?:原梗|出处|引自|参考自)[：:]/,              // 考据
  /第[0-9一二三四五六七八九十]+(?:集|话|卷)/,     // 「第三话」
  /\[[^\]]{1,40}\]\(https?:\/\/[^)]{1,200}\)/,  // markdown 链接（考据用）
  /https?:\/\/[^\s]{6,}/                        // 裸链接
]

// ── 闸 5：认错后补承诺（「懂了，以后不评了」）──
const COMMITMENT = [
  /(?:懂了|明白了|知道了|行吧|好)[，,]?以后(?:不|别|会|我)/,
  /以后(?:不|别)(?:再)?(?:评|说|这样|那么)/,
  /下次(?:不|会)(?:再)?/
]

// ── 闸 6：技术报告腔（把指标当聊天内容）──
const TECH_REPORT = [
  /返回\s*\d{3}/,                    // 「返回 200」
  /\d{3}\s*(?:状态码|status)/i,
  /(?:占比|成功率|命中率)\s*\d+\s*%/,
  /\d+\s*ms(?:\b|$)/,
  /star\s*(?:都|有|已经)?\s*\d{2,}/i,          // 「star 都 5969 了」
  /(?:已有|有)\s*\d{2,}\s*(?:人|个)?\s*(?:star|关注|收藏)/i
]

/**
 * 闸 7：金句体。
 *
 * ★ 这条最容易误杀，所以条件卡得很紧 —— 必须同时满足：
 *   单句 + 12–40 字 + （转折词 且 抽象词）或 排比。
 *   普通的短句（「好」「睡觉」）不满足「有转折 + 抽象词」，不会被误杀。
 */
function looksLikeGoldenLine(text) {
  const body = clean(text)
  if (!body) return false
  const clauses = body.split(/[。！？；\n]/).filter((x) => x.trim())
  if (clauses.length !== 1) return false
  const len = body.replace(/\s/g, '').length
  if (len < 12 || len > 40) return false
  const hasTurn = /但|却|而|只是|不过/.test(body)
  const abstract = /思念|时间|孤独|永远|意义|灵魂|世界|存在|记得|忘记|温柔|深渊|星辰/.test(body)
  const parallel = /能[^，。]{2,8}[，,]?[^，。]{0,6}能/.test(body)
  return (hasTurn && abstract) || parallel
}

function clean(v) { return String(v == null ? '' : v).trim() }

/**
 * 判一条回复合不合格。
 *
 * @param {string} text 一条要发出去的气泡
 * @returns {{ok:boolean, kinds:string[]}} kinds 是命中的闸类别（activity 用）
 */
export function judgeReply(text) {
  const body = clean(text)
  if (!body) return { ok: true, kinds: [] }

  const kinds = []

  // 闸 1：开头
  if (OPENERS.some((re) => re.test(body))) kinds.push(GATE_KIND.COMMENTARY)

  // 闸 2：评点结构（任意位置）
  if (CRITIQUES.some((re) => re.test(body))) kinds.push(GATE_KIND.CRITIQUE)

  // 闸 3：自我诊断
  if (SELF_DIAG.some((re) => re.test(body))) kinds.push(GATE_KIND.SELF_DIAGNOSIS)

  // 闸 4：解说体（注释 / 考据 / 设定 / 链接）
  if (NARRATION.some((re) => re.test(body))) kinds.push(GATE_KIND.NARRATION)

  // 闸 5：认错后补承诺
  if (COMMITMENT.some((re) => re.test(body))) kinds.push(GATE_KIND.COMMITMENT)

  // 闸 6：技术报告腔
  if (TECH_REPORT.some((re) => re.test(body))) kinds.push(GATE_KIND.TECH_REPORT)

  // 闸 7：金句体
  if (looksLikeGoldenLine(body)) kinds.push(GATE_KIND.GOLDEN_LINE)

  return { ok: kinds.length === 0, kinds }
}

/**
 * 生成重写指令。
 *
 * ★ 主人要求：「重写时把这三选一作为指令给出，不要给'禁止 X'的清单」。
 *
 * 所以这里只给三个**动作**，且不告诉她"刚才错在哪"——
 * 说了等于把那段话又念一遍（引力的来源）。
 *
 * @param {object} opts
 * @param {string} [opts.original] 她原本想说的话（**不放进指令**，只用来判断要不要带上下文）
 * @param {string} [opts.from]  谁说的（可选，便于"拉回两个人"）
 * @returns {string} 交给模型的指令
 */
export function buildRewriteInstruction({ original = '', from = '' } = {}) {
  // ★ 不引用 original 的内容 —— 只给方向。
  //   如果指令里写"你刚才那段在解说"，等于又提了一遍解说，反而强化。
  const who = clean(from)
  const lines = [
    '（这一条重说一次。直接给一句就行：）',
    '① 接住他那个梗，顺着往下推一层；',
    '② 认出出处就直接点破，一句话，别铺开；',
    '③ 拿不准就问一句「这是哪的」。',
    '',
    '说给' + (who || '对方') + '这个人听。'
  ]
  return lines.join('\n')
}

/**
 * 兜底：重写仍不合格时，挑一个最短反应。
 *
 * 主人要求：「第二次仍命中 → 不发这条，改成最短反应（「？」「草」「6」）或不发」。
 *
 * @param {number} [seed] 用同一 seed 结果稳定（判据用）
 */
export function pickMinimalReaction(seed = 0) {
  const i = Math.abs(Math.floor(Number(seed) || 0)) % MINIMAL_REACTIONS.length
  return MINIMAL_REACTIONS[i]
}

/**
 * 执行层：给一条待发文本跑完整流程。
 *
 * 流程（主人的三段）：
 *   ① judgeReply → 合格就直接发
 *   ② 不合格 → 返回 needRewrite，让上层把指令投回会话重来
 *   ③ 重写回来仍不合格（attempt >= 2）→ 最短反应或不发
 *
 * ★ 这一层**不自己调模型**：宿主接口在 index.js 那边（agent.followup），
 *   这里只做判断和产出指令，保持可测。
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {number} [opts.attempt] 这是第几次（0 = 第一次生成）
 * @param {number} [opts.seed]    兜底挑最短反应用
 */
export function runExecutionGate({ text = '', attempt = 0, seed = 0 } = {}) {
  const judged = judgeReply(text)

  // ① 合格
  if (judged.ok) {
    return { action: 'send', text: clean(text), kinds: [], attempt, fellBack: false }
  }

  // ② 第一次不合格 → 要求重写（给三选一）
  if (attempt < 1) {
    return {
      action: 'rewrite',
      text: '',
      instruction: buildRewriteInstruction(),
      kinds: judged.kinds,
      attempt,
      fellBack: false
    }
  }

  // ③ 重写回来还是不合格 → 兜底
  const minimal = pickMinimalReaction(seed)
  return {
    action: minimal ? 'fallback' : 'drop',
    text: minimal,
    kinds: judged.kinds,
    attempt,
    fellBack: true
  }
}

/**
 * 度量：纠正之后同类问题有没有复现（主人要求「这一步别省」）。
 *
 * 定位：每次纠正记一条时间点；之后每次判到不合格就记一次；
 *      看「纠正后 20 轮内」复现了几次。
 *
 * @param {object[]} events 形如 { at:number, kind:'correction'|'hit', gate:string }
 * @param {object} [opts]
 * @param {number} [opts.window] 观察窗口（轮数，默认 20）
 * @param {number} [opts.alertAt] 复现到这个数就报警（默认 2）
 * @returns {{corrections:number, windows:object[], alarms:object[]}}
 */
export function measureRecurrence(events = [], { window = 20, alertAt = 2 } = {}) {
  const sorted = [...events].sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
  const corrections = sorted.filter((e) => e.kind === 'correction')
  const hits = sorted.filter((e) => e.kind === 'hit')

  const windows = []
  for (let i = 0; i < corrections.length; i++) {
    const c = corrections[i]
    const nextC = corrections[i + 1]
    // 窗口：这次纠正之后、下次纠正之前（或末尾）
    const inWindow = hits.filter((h) => {
      const at = Number(h.at || 0)
      if (at <= Number(c.at || 0)) return false
      if (nextC && at >= Number(nextC.at || 0)) return false
      return true
    })
    // ★ 「20 轮内」用轮序号（seq）算更准；没有 seq 就退化成"到下次纠正为止"
    const limited = c.seq != null
      ? inWindow.filter((h) => h.seq != null && Number(h.seq) - Number(c.seq) <= window)
      : inWindow
    windows.push({
      correctionAt: c.at,
      gate: String(c.gate || ''),
      recurred: limited.length,
      exceeded: limited.length >= alertAt,
      hits: limited.map((h) => ({ at: h.at, gate: h.gate, seq: h.seq }))
    })
  }

  return {
    corrections: corrections.length,
    windows,
    // 报警的窗口（要面板标红并提示的）
    alarms: windows.filter((w) => w.exceeded)
  }
}
