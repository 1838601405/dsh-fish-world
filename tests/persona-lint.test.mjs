// 人设卡回归测试：守住「不教她催人」这条底线（主人 2026-11-18 修法）。
// 只在真实人设卡存在时跑；CI 没挂这份卡就跳过。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import test from 'node:test'

const HOME = process.env.DSH_HOME || join(os.homedir(), 'DSH-home')
const FILE = join(HOME, 'fish-world-personas', 'default.md')
const exists = existsSync(FILE)
const text = exists ? readFileSync(FILE, 'utf8').replace(/\r/g, '') : ''

test('人设卡存在且能读到', { skip: exists ? false : '本机没有 default.md，跳过' }, () => {
  assert.ok(exists, '找不到 ' + FILE)
  assert.ok(text.includes('说话') || text.includes('说话的样子'), '人设卡内容异常')
})

test('不教催人：没有「话说一半先等、等不到就催」这类规则', { skip: exists ? false : '本机没有 default.md，跳过' }, () => {
  const banned = ['催一下', '你说啊', '等不到就', '话说一半', '先等，等不到']
  for (const phrase of banned) {
    assert.ok(!text.includes(phrase), `人设卡里还残留「${phrase}」——这会教她催人`)
  }
})

test('改成正向：对方留半句就接上去', { skip: exists ? false : '本机没有 default.md，跳过' }, () => {
  // ★ 2026-11-21 人设瘦身（主人要求 ≤3000 字、负面规约 ≤3 条）：
  //   原来还要求「等不到再问一次」这个兜底 —— 那是**行为规约**，不是她是谁。
  //   瘦身后只留正向锚定（接上去），兜底交给执行层。
  assert.ok(text.includes('接上去'), '没有「接上去」的正向说法')
})

test('一轮回复硬上限仍是两条（代码侧，不唯一靠提示词）', { skip: false }, async () => {
  const { splitBubbles, MAX_BUBBLES } = await import('../lib/util.mjs')
  assert.equal(MAX_BUBBLES, 2, '一轮最多两条，硬闸常数是 2')
  const parts = splitBubbles('一\n二\n三\n四\n五')
  assert.equal(parts.length, 2, '超出的要并进第二条')
  assert.equal(parts[0], '一')
  assert.equal(parts[1], '二 三 四 五')
})