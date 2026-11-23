// 治「拍板感」（霸总语气）—— 发送前的改写/校验（主人 2026-11-24）。
//
// ── 它治什么（四种，得能数出来）──
//   1. 一句一个结论，句句收得住，话不留口气
//   2. 结尾补一句总结或建议（"这样就行了""建议你先…"）
//   3. 四字对仗收尾，前后工整
//   4. 命令式收尾（"就这么办""别问了""按我说的来"）
//
// ── 不治什么（别误杀）──
//   **不是句子短** —— 她的短是本来要的。回一句「哼」不算霸总，
//   回一句「这事就这么定了」才算。判据是「有没有在拍板/收尾/不容置疑」。
//
// ── 三条改法 ──
//   ① 一句拆两句（中间加「不过 / 其实 / 大概」，气就散）
//   ② 删结尾（她的收尾句通常多余，删掉再看，不成立才补）
//   ③ 断言降级（能说「我觉得」的不直接说「是」，能说「大概」的不写「会」）
//
// ── 兜底（主人原话）──
//   重写失败 → **删掉那半句后原样发**（宁可少半句，不发拍板的）
//
// ── 为什么不进人设 ──
//   写进人设或加禁用词表，那些词进了每轮上下文就变成**锚点**，越写越容易冒出来（主人踩过）。
//   所以这一层只在**发送前**动手，每条只看一次。

/** 形态 4：命令式收尾。 */
const RE_COMMAND = /(就这么办|就这么定(?:了)?|就这么干|别问了|按我说的来|听我的|我说了算|必须(?:这么|那样)|立刻执行|马上办|不用犹豫|就这么决定了?)[。！?~～\s]*$/
/** 形态 2：结尾补总结/建议。
 *  ★ 两种都算：
 *    ① 词落在**最末**（「这样就行了」「先这样」）
 *    ② **整句就是一个建议**：最后一句以建议词开头、且句中没有逗号
 *       （「建议你先备份」是主句建议；而「先这样吧，回头再说」——建议词后面还有
 *         逗号分隔的后续内容，收尾是「回头再说」⇒ 不算，保持主人的「收尾」语义）
 */
const RE_SUMMARY_END = /(这样(?:就)?(?:行了|可以了|挺好|没问题|对了)|建议你|不妨|最好(?:是)?先|你可以先|要不(?:你)?先|先这样|就这样)[。！?~～\s]*$/
const RE_SUMMARY_HEAD = /^(建议你|要不你?先|最好(?:是)?先|你可以先|不妨|先这样|就这样)/
function summaryHit(tail) {
  if (RE_SUMMARY_END.test(tail)) return true
  if (tail.includes('，') || tail.includes(',')) return false   // 词后还有后续内容 ⇒ 收尾不是它
  return RE_SUMMARY_HEAD.test(tail)
}
/** 形态 3：**整句**恰好「四字，四字」（前后工整）。
 *  ★ 第一版写成逗号两侧**各有**≥4 字就命中 ⇒「拿肝当麻醉剂，也真管用」(6+5) 也算，
 *    全量 521 次几乎全是误判（违反「别误杀」）。改成整句 4+4 后归 0。 */
const RE_TIGHT_COUPLET = /^[一-龥]{4}[，、][一-龥]{4}[。！?~～]*$/

/** 断言词（改法③ 降级用）—— 只降**肯定断言**，不碰她的语气词与短句。 */
const ASSERTIONS = [
  [/(^|[，。；\s])是(?=[，。；\s]|$)/g, '$1我觉得是'],
  [/(^|[，。；\s])会(?=[，。；\s]|$)/g, '$1大概会'],
  [/(^|[，。；\s])一定/g, '$1觉得一定'],
  [/(^|[，。；\s])肯定(?=[，。；\s]|$)/g, '$1挺肯定'],
]

/** 取最后一行（"收尾"类判据只看收尾那一下）。 */
function lastLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

/** 形态 1：句句收得住 —— ≥2 分句、**每一句**都收得住（不留口气）。 */
function ruleTight(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (!/[。]$/.test(t)) return false                 // 整条收在句号
  const parts = t.split(/[。]/).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return false                 // 至少两句
  const loose = /不过|其实|大概|可能|也许|感觉|好像|差不多|还是|或者/
  const looseEnd = /[…⋯~～吧呢嘛啊呀喔哦嘿？?！!]$/
  // ★ **每一句**都要收得住（第一版只查整条结尾 ⇒「这事我查过了吧。证据是齐的。」
  //   第一句明明留了口气却命中 —— 「句句收得住」本来就是逐句的）
  return !parts.some((s) => loose.test(s) || looseEnd.test(s))
}

/**
 * 数一条回复里四种形态各命中几次。
 * @param {string} text
 * @returns {string[]} 命中的形态名（空 = 没有拍板感）
 */
export function detectDecree(text) {
  const t = String(text || '').trim()
  if (!t) return []
  const hits = []
  const tail = lastLine(t)                    // 收尾类只看最后一行
  if (RE_COMMAND.test(tail)) hits.push('4 命令式收尾')
  if (summaryHit(tail)) hits.push('2 结尾总结/建议')
  if (RE_TIGHT_COUPLET.test(tail)) hits.push('3 四字对仗收尾')
  if (ruleTight(t)) hits.push('1 句句收得住')
  return hits
}

/** 删掉最后一行；只剩一行时删**最后一个分句**（含它的句号）。
 *  ★ 第一版写成 `slice(0, lastIndexOf('。'))` —— 那只删掉**句号本身**，
 *    「嗯，写完了。反正我在群里。」变成「…在群里」（句子还在、只掉标点）⇒ 等于没治。
 *    正确是把最后一段（到句号为止）整段去掉。 */
function dropTail(text) {
  const lines = String(text).split('\n')
  if (lines.length > 1) {
    const kept = lines.slice(0, -1).join('\n').replace(/\s+$/, '')
    if (kept.trim()) return kept
  }
  const t = String(text).trim()
  // 按句末标点切（保留分隔符），pop 掉最后一段
  const segs = t.split(/(?<=[。！？!?])/)
  if (segs.length > 1) {
    segs.pop()
    const out = segs.join('').replace(/\s+$/, '')
    if (out.trim()) return out
  }
  return ''                                    // 删无可删
}

/**
 * 对一条出站文本做「拍板感」软化。
 *
 * ★ 只在**命中**时动手（别误杀）：没命中的原样返回，一个字不动。
 * ★ 兜底：改写后**仍命中** ⇒ 删掉那半句；删完变空 ⇒ **原样发**（不发空消息）。
 *
 * @param {string} text
 * @returns {{text: string, changed: boolean, hits: string[], action: string}}
 *   `action` 说明动了哪一招（改写/删尾/原样），给日志与判据用
 */
export function softenDecree(text) {
  const src = String(text ?? '')
  const hits = detectDecree(src)
  if (!hits.length) return { text: src, changed: false, hits, action: '原样（没命中）' }

  let out = src
  const had = (h) => hits.some((x) => x.startsWith(h))
  let softenedOnce = false     // 拆句/散气已治好 ⇒ **别再走删尾**（否则把改好的又删空）

  // ① 一句拆两句 / 散气（治形态1 与形态3）
  //   · 形态1「句句收得住」：在**第 2 句**开头插「不过」，气就散
  //   · 形态3「四字对仗」：**单句无句号**，删尾删不掉（会删空）⇒ 在**逗号**处插「不过」
  //     （实测：124 条 4+4 对仗全是这么卡住的 —— 它们走删尾必然删空、被兜底原样发）
  if (had('1')) {
    const segs = out.split(/(?<=[。])/)
    if (segs.length >= 2) {
      const trial = [...segs]
      trial[1] = '不过' + trial[1]
      const joined = trial.join('')
      if (!detectDecree(joined).some((h) => h.startsWith('1'))) { out = joined; softenedOnce = true }
    }
  }
  if (had('3')) {
    const m = /^([一-龥]{4})[，、]([一-龥]{4})$/.exec(out.trim())
    if (m) {
      const trial = `${m[1]}，不过${m[2]}`
      if (!detectDecree(trial).some((h) => h.startsWith('3'))) { out = trial; softenedOnce = true }
    }
  }

  // ② 删结尾（治形态 2/3/4「收尾」）—— **散气已治好的不再删**（删了会删空）
  if (!softenedOnce && (had('2') || had('3') || had('4'))) out = dropTail(out)

  // ③ 断言降级（能说「我觉得」的不直接说「是」，能说「大概」的不写「会」）
  for (const [re, rep] of ASSERTIONS) out = out.replace(re, rep)

  // ★ 兜底：改写后**仍命中** ⇒ 再删一次那半句
  if (out && detectDecree(out).length) out = dropTail(out)

  // ★ 删空了就原样发（不发空消息 —— 误杀的代价比拍板更大）
  if (!out.trim()) return { text: src, changed: false, hits, action: '原样（删空了，兜底）' }

  return {
    text: out,
    changed: out !== src,
    hits,
    action: out !== src ? '软化（拆句/删尾/降级）' : '原样（改不动，保持原样发）',
  }
}
