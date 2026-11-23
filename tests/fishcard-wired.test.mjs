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
  // 必须在用原文（CRLF 归一 + trim，不砍）
  // ★ 用字符串 includes 而不是正则：源码是 `.replace(/\r\n/g, …)`，`(` 后还夹一个 `/`，
  //   正则里要写 `\/\\r\\n`，我连着两版都漏了那个 `/` —— 字符串字面量没有转义地狱。
  assert.ok(src.includes("String(card?.text || '')"), '★ 要用 card 的原文')
  assert.ok(src.includes('.replace(/\\r\\n/g'), '★ 保留无害的 CRLF 归一')
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
