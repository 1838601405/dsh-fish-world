// 桥插件的「出站闸」补丁：抽取、幂等、回退、注入代码真的能剥工具语法。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CALL_MARK,
  GUARD_BEGIN,
  GUARD_END,
  applyBridgePatch,
  bridgeGuardStatus,
  extractGuard,
  findBridgeHost,
  patchBridgeNow,
  revertBridgePatch,
} from '../lib/bridge-patch.mjs'

const ROOT = join(import.meta.dirname, '..')

const HOST = `// 假桥：结构照抄 dsh-qq-bridge 的关键两行
import { join } from 'node:path'

export const name = 'qq-bridge'
export const inject = ['agents', 'sessions', 'webServer']

function 落地一发(配置, 文字, 图们, 方向) {
  const 标记 = 抠QQ标记(文字, 配置.只发标记内)
  let 待发文字 = 标记.文字
  const 抠过 = 配置.发图 ? 抠正文图(待发文字) : { 净文字: 待发文字, 图: [] }
  return 发到QQ(配置, 待发文字, 图们, 方向)
}
`

const guard = () => extractGuard(readFileSync(join(ROOT, 'lib', 'util.mjs'), 'utf8'))

test('从 util.mjs 抽出的补丁不含 export，且有 stripToolMarkup', () => {
  const g = guard()
  assert.match(g, /function stripToolMarkup\(/)
  assert.match(g, /function looksLikeToolMarkup\(/)
  assert.doesNotMatch(g, /^export\s/m, '补丁块里不能留 export')
  assert.ok(g.length > 500, '抽出来的应该是完整实现，不是空壳')
})

test('打补丁：插入补丁块 + 出站闸调用，锚点保持', () => {
  const out = applyBridgePatch(HOST, guard())
  assert.ok(out.includes(GUARD_BEGIN) && out.includes(GUARD_END), '有补丁块标记')
  assert.ok(out.includes(CALL_MARK), '有出站闸调用')
  assert.ok(out.includes('let 待发文字 = 标记.文字'), '原锚点还在')
  assert.ok(out.includes('待发文字 = stripToolMarkup(待发文字)'), '调用点已插入')
  // 补丁块必须在调用点之前（const 初始化早于函数执行）
  assert.ok(out.indexOf('const stripToolMarkup') < out.indexOf(CALL_MARK), '补丁块在前')
})

test('幂等：重复打补丁不会叠加', () => {
  const once = applyBridgePatch(HOST, guard())
  const twice = applyBridgePatch(once, guard())
  assert.equal(twice, once)
  assert.equal(twice.split(GUARD_BEGIN).length - 1, 1, '只有一块')
  assert.equal(twice.split(CALL_MARK).length - 1, 1, '只有一处调用')
})

test('改了 util 后重打：替换内容而不是再加一块', () => {
  const once = applyBridgePatch(HOST, guard())
  const changed = once.replace(/function stripToolMarkup\(/, 'function stripToolMarkup_OLD(')
  // 用新 guard 重打，应该整块替换，不留旧实现
  const again = applyBridgePatch(changed, guard())
  assert.doesNotMatch(again, /stripToolMarkup_OLD/)
  assert.equal(again.split(GUARD_BEGIN).length - 1, 1)
})

test('回退：补丁块与调用点都删干净，回到原样', () => {
  const out = applyBridgePatch(HOST, guard())
  const back = revertBridgePatch(out)
  assert.equal(back.trim(), HOST.trim())
  assert.ok(!back.includes(GUARD_BEGIN))
  assert.ok(!back.includes(CALL_MARK))
})

test('注入的代码真的能剥工具调用语法（不是只写了个名字）', () => {
  const out = applyBridgePatch(HOST, guard())
  const start = out.indexOf('const stripToolMarkup = (() => {')
  const end = out.indexOf('})()', start)
  assert.ok(start >= 0 && end > start, '找到补丁里的 IIFE')
  const code = out.slice(start, end + '})()'.length)
  const factory = new Function(`${code}; return stripToolMarkup`) // eslint-disable-line no-new-func
  const strip = factory()
  assert.equal(strip('<invoke name="fish_tone"><parameter name="text">x</parameter></invoke>'), '')
  assert.equal(strip('真的吗\n<invoke name="x"><parameter name="a">b</parameter></invoke>\n放心了'), '真的吗\n放心了')
  assert.equal(strip('3<5 和 a>b'), '3<5 和 a>b')
})

test('找不到桥时返回空串（不抛、不瞎猜路径）', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bridge-'))
  assert.equal(findBridgeHost({ dshHome: home }), '')
  // 造一个假 profile 里的桥，应该能找到
  const dir = join(home, 'profiles', 'demo', 'node_modules', 'dsh-qq-bridge', 'lib')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'host.js'), 'export const name = "x"\n', 'utf8')
  assert.equal(findBridgeHost({ dshHome: home }), join(dir, 'host.js'))
})

test('patchBridgeNow：临时 profile 里打补丁 → 状态 → 幂等 → 撤销', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bridge-patch-'))
  const dir = join(home, 'profiles', 'demo', 'node_modules', 'dsh-qq-bridge', 'lib')
  mkdirSync(dir, { recursive: true })
  const host = join(dir, 'host.js')
  writeFileSync(host, HOST, 'utf8')
  const utilFile = join(ROOT, 'lib', 'util.mjs')

  assert.deepEqual(bridgeGuardStatus({ dshHome: home }), { installed: true, patched: false })

  const applied = patchBridgeNow({ dshHome: home, utilFile, action: 'apply' })
  assert.equal(applied.ok, true, applied.error)
  assert.equal(applied.patched, true)
  assert.equal(applied.changed, true)
  assert.match(readFileSync(host, 'utf8'), /stripToolMarkup/, '真的写进去了')
  assert.equal(bridgeGuardStatus({ dshHome: home }).patched, true)

  const again = patchBridgeNow({ dshHome: home, utilFile, action: 'apply' })
  assert.equal(again.ok, true)
  assert.equal(again.changed, false, '幂等：第二次不改盘')

  const reverted = patchBridgeNow({ dshHome: home, utilFile, action: 'revert' })
  assert.equal(reverted.ok, true)
  assert.equal(bridgeGuardStatus({ dshHome: home }).patched, false)
  assert.equal(readFileSync(host, 'utf8').trim(), HOST.trim(), '撤销后回到原样')
})

test('patchBridgeNow：没装桥时如实失败，不瞎写', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-bridge-none-'))
  const r = patchBridgeNow({ dshHome: home, action: 'apply' })
  assert.equal(r.ok, false)
  assert.equal(r.installed, false)
  assert.match(r.error, /dsh-qq-bridge/)
})
