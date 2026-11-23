// 鱼卡 v3 接线判据（源码级）——施工单 §2.3 点名的两处改动 + §4 的禁令。
//
// ★ 为什么是源码级：这两处都在 `index.js` 的提示词拼装里，函数是闭包、
//   拿不到返回值去断言；按文本扫源码是唯一能真红的办法。
// ★ M59：被扫的是 `lib/index.js`，**它自己的注释也算输入** —— 所以源码里
//   刻意不写被禁句的字面（注释用"外部为她加载的设定"描述），
//   这里才能用字面 grep 当判据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

test('★★ §2.3：第三人称引导要改掉（配第一人称正文会打架）', () => {
  // 被禁的那句字面：把人设说成「主人为这个角色加载的」——第一人称正文配它会打架。
  assert.doesNotMatch(
    src,
    /主人为这个角色加载的人设/,
    '★ 还有第三人称引导（§2.3 点名要改）—— 若本条红了，先确认不是注释里写了字面（M59）'
  )
  // 改成了标签行语义（与 QQ 投递那条同一口径）
  assert.match(src, /以下是她自己的话/, '★ 要改成第一人称标签行语义')
})

test('★★ §4：人设卡注入不许走 personaForPrompt（它会剥节头 + 从尾部砍字符）', () => {
  // 两处拼人设的地方都必须用**原文**
  assert.doesNotMatch(
    src,
    /personaForPrompt\(\s*card\?\.text/,
    '★ DSH 系统提示词那处仍走 personaForPrompt —— 会剥掉 ### 节头并砍尾（§4 禁止）'
  )
  assert.doesNotMatch(
    src,
    /personaForPrompt\(\s*text\s*\)/,
    '★ whale-task 那处仍走 personaForPrompt —— 同上'
  )
  // 必须在用原文（**不 trim、不转 CRLF、不砍** —— 逐字节）
  // ★ 用字符串 includes 而不是正则：正则转义地狱我连着错两版（漏 `(` 后的 `/` 等）。
  assert.ok(src.includes("String(card?.text || '')"), '★ 要用 card 的原文')
  // ★ 2026-11-24 主人「别这么做」：CRLF→LF 同样是改字节 ⇒ **不许再做归一**。
  //   （旧判据这条写反了 —— 要求「保留无害的 CRLF 归一」，与新指令直接矛盾，改掉。）
  assert.equal(src.includes('.replace(/\\r\\n/g'), false,
    '★★ 不许把 CRLF 转 LF（逐字节一致，2026-11-24 主人「别这么做」）')
})

test('★ personaForPrompt 在 index.js 里不再被真实调用（只许 import 与注释出现）', () => {
  // 把 import 行与整行注释剔掉，剩下的才是**真实代码**。
  // （不剔的话 import 和我写的说明注释都会命中，判据就成了假红 —— M59 的另一面。）
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
      if (t.startsWith('import ')) return false
      return true
    })
    .join('\n')
  assert.doesNotMatch(code, /personaForPrompt\(/, '★ 真实代码里还有调用 —— 它会剥节头并砍尾（§4 禁止）')
})

// ══════════ P1（主人 2026-11-24 点破）：两条注入路不许灌原文 ══════════
//
// `8227111` 只修了 `parseCard`，而 `index.js` 的**系统提示词**（【角色人设卡】）与
// **whale-task**（【你的人设】）两条路不走 parseCard、直接用原文 ⇒
// front-matter 的六行 YAML 与 `<!-- -->` 每轮进上下文。
// 主人指定的修法：复用 `splitFrontmatter` 取 body（这里实现为导出 `stripCard`），
// **正文一个字不动**；别换 `personaForPrompt`（它剥 `###` + 砍尾，两个都不能要）。
test('★★ P1：两条注入路都走 stripCard，且不直接灌 persona/card 原文（源码级）', () => {
  // ★ 扫真实代码（剥 import 与整行注释 —— M59：注释也算输入）
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
      if (t.startsWith('import ')) return false
      return true
    })
    .join('\n')

  // 两条路都要用 stripCard
  const uses = code.match(/stripCard\(/g) || []
  assert.ok(uses.length >= 2, `★★ 两处注入都要走 stripCard，实为 ${uses.length} 处`)

  // 不许把卡原文**直接拼进提示词**。
  // ★ 断言口径：`stripCard(String(persona?.text || ''))` 这种**当入参**是允许的
  //   （那正是要剥的东西）；禁的是 `+ persona?.text` / `${persona?.text}` 这种**直接拼接**。
  //   （第一版我写成 `/persona\?\.text/` 全禁，把自己正确的传参判红了。）
  assert.equal(/\+\s*persona\?\.text/.test(code), false, '★ 不许把 persona?.text 直接拼进提示词')
  assert.equal(/\$\{persona\?\.text/.test(code), false, '★ 同上（模板字符串形态）')
  assert.equal(/\+\s*card\?\.text/.test(code), false, '★ 不许把 card?.text 直接拼进提示词')
  assert.equal(/\$\{card\?\.text/.test(code), false, '★ 同上（模板字符串形态）')

  // 也不许退回 personaForPrompt（它剥 ### 节头 + 超 6000 字砍尾）
  assert.equal(/personaForPrompt\(/.test(code), false, '★ 不许用 personaForPrompt（§4 禁止砍尾）')

  // ★ 主人「别这么做」两条（2026-11-24）：
  //   · 别顺手 trim 首尾空行 —— 正文要**逐字节一致**，不是「长度差不多」
  //   · 别把 CRLF 转 LF（同样是改字节）
  //   ⇒ `stripCard` 返回的 body 必须**原样**用。
  // ★ 断言口径：只查**解构出来的那两个变量**有没有被 trim/replace ——
  //   （第一版我写成全文件禁 `\.trim\(\)`，可 index.js 里到处都是无关的 trim，必假红。）
  const vars = [...code.matchAll(/const\s*\{\s*body:\s*(\w+)\s*\}\s*=\s*stripCard/g)].map((m) => m[1])
  assert.ok(vars.length >= 2, `★ 两处都要解构 stripCard 的 body，实为 ${vars.length} 处`)
  for (const v of vars) {
    assert.equal(new RegExp(`\\b${v}\\.trim\\(`).test(code), false,
      `★★ 「${v}」不许 trim（trim = 改字节，判据2 要逐字节一致）`)
    assert.equal(new RegExp(`\\b${v}\\.replace\\(`).test(code), false,
      `★★ 「${v}」不许 replace（CRLF→LF 同样是改字节）`)
  }
})
