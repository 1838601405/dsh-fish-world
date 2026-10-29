// 「修联接」：错位是能修的，不能只报错。
//
// 三条纪律（与改造 bundles 开关同一套）：
//  · 必须 confirm:true —— 它会动主人真实 profile；
//  · 只动联接/软链，绝不删实体目录（不可逆的事不在这个函数里）；
//  · 写完用同一份 resolveSelfLink 回读，不是「我以为指过去了」。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { declareSelf, repairSelfLink } from '../lib/hub.mjs'
import { resolveSelfLink } from '../lib/env.mjs'

/** 造一个 profile；source 目录单独造好当作「当前这份源码」。 */
function fake({ withNodeModules = false, linkTo = '', realDir = false, declare = true, bundle = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-repair-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  const pkg = {
    name: 'p',
    dependencies: declare ? { 'dsh-fish-world': 'link:x' } : {},
    dsh: { profile: { bundles: bundle ? ['dsh-fish-world'] : [] } },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(pkg))
  const target = join(profileDir, 'node_modules', 'dsh-fish-world')
  if (withNodeModules) mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  if (linkTo) {
    mkdirSync(linkTo, { recursive: true })
    if (withNodeModules) symlinkSync(linkTo, target, 'junction')
  } else if (realDir) {
    mkdirSync(target, { recursive: true })
  }
  const sourceDir = join(home, 'source')
  mkdirSync(sourceDir, { recursive: true })
  return { home, profileDir, target, sourceDir }
}

test('不带 confirm 一律拒绝，且不碰任何东西', () => {
  const { home, sourceDir } = fake()
  const result = repairSelfLink({ home, profile: 'desktop', sourceDir })
  assert.equal(result.ok, false)
  assert.match(result.error, /confirm: true/)
})

test('已经指向当前这份时跳过写盘（幂等）', () => {
  const { home, sourceDir } = fake({ withNodeModules: true })
  // 先让它指对
  const first = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  const again = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(again.ok, true)
  assert.equal(again.changed, false, '第二次不该再动文件')
})

test('指错时改过来，并回读确认真指向当前这份', () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'fw-elsewhere-'))
  const { home, sourceDir } = fake({ withNodeModules: true, linkTo: elsewhere })
  const before = resolveSelfLink({ home, profile: 'desktop', sourceDir })
  assert.equal(before.status, 'wrong-target')

  const result = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.backup, before.target, '要记下原来指向哪，方便回退')

  const after = resolveSelfLink({ home, profile: 'desktop', sourceDir })
  assert.equal(after.status, 'ok', '回读必须指向当前这份')
  assert.equal(after.ok, true)
  // 步骤要能说清做了什么
  const labels = result.steps.map((step) => step.label)
  assert.ok(labels.includes('摘掉旧联接'))
  assert.ok(labels.includes('新建联接'))
  assert.ok(labels.includes('回读校验'))
})

test('实体目录不删：那是不可逆的，直接拒绝', () => {
  const { home, sourceDir, target } = fake({ realDir: true })
  const result = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /实体目录/)
  assert.ok(existsSync(target), '实体目录必须原样还在')
})

test('源码目录不存在时拒绝，不去建一个指向空气的联接', () => {
  const { home } = fake()
  const ghost = join(home, 'no-such-source')
  const result = repairSelfLink({ home, profile: 'desktop', sourceDir: ghost, confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /当前源码目录不存在/)
})

test('接线：路由与面板都在，且面板要「两下确认」而不是弹窗', () => {
  const http = readFileSync(join(import.meta.dirname, '..', 'lib', 'http.mjs'), 'utf8')
  assert.match(http, /path: `\$\{prefix\}\/hub\/relink`/)
  assert.match(http, /repairSelfLink\(\{ home, profile, confirm: true \}\)/)
  assert.match(http, /action: 'link-repair'/)
  const routesLine = http.slice(http.indexOf('const routes = ['))
  assert.match(routesLine, /hubTools, hubRelink, hubDeclare, memoryMerge,/)

  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /把联接改到当前目录/)
  assert.match(panel, /确认改联接（会动 profile）/)
  assert.match(panel, /postJSON\('\/dsh-fish-world\/hub\/relink', \{ confirm: true \}\)/)
  // 这一段（修联接）不许用弹窗——整份 panel.js 里别处有历史遗留的 confirm/alert，
  // 不在这条断言的范围里，只核我新加的这一段。
  const segStart = panel.indexOf('function doRelink()')
  const segEnd = panel.indexOf('// ---- 卡一：概览 ----', segStart)
  const seg = panel.slice(segStart, segEnd > 0 ? segEnd : segStart + 2000)
  assert.ok(segStart > 0, '找不到 doRelink')
  assert.ok(!/\balert\(|\bconfirm\(/.test(seg), '修联接这一段里不许出现 alert/confirm 弹窗')
})
test('没装且 profile 没声明它：拒绝，并说清要手动加什么（不替你改 package.json）', () => {
  const { home, sourceDir, target } = fake({ withNodeModules: true, declare: false, bundle: false })
  const result = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /dependencies 里加/)
  assert.match(result.error, /dsh\.profile\.bundles 里加/)
  assert.match(result.error, /不替你改 package\.json/)
  assert.ok(!existsSync(target), '拒绝的时候不该建联接')
  // 步骤里要能看出「看声明」这一步查到了什么
  const declaredStep = result.steps.find((step) => step.label === '看声明')
  assert.ok(declaredStep)
  assert.match(declaredStep.detail, /dependencies 没有/)
})

test('没装但已声明：建联接，回读 ok', () => {
  const { home, sourceDir, target } = fake({ withNodeModules: true })
  const result = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.ok(existsSync(target))
  assert.equal(resolveSelfLink({ home, profile: 'desktop', sourceDir }).ok, true)
})

test('只缺 bundles 那一条也要说清楚（dependencies 有、bundles 没有）', () => {
  const { home, sourceDir } = fake({ withNodeModules: true, declare: true, bundle: false })
  const result = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /dsh\.profile\.bundles 里加/)
  assert.ok(!/dependencies 里加/.test(result.error), 'dependencies 已经有了，不该再叫加')
})
test('账本把「声明了没有」也带出来，面板据此决定给按钮还是给说明', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /hub\.selfLink\.status === 'missing' && hub\.selfLink\.declared/)
  // 没声明时给的是「代写清单」入口（两下确认），不再只是干巴巴一句「手动加」。
  assert.match(panel, /写入 profile 清单/)
  assert.match(panel, /确认写入清单（会动 package\.json）/)
  // 声明齐全时才给按钮
  assert.match(panel, /else if \(hub\.selfLink\.status === 'missing' \|\| hub\.selfLink\.status === 'wrong-target'\)/)
  const hub = readFileSync(join(import.meta.dirname, '..', 'lib', 'hub.mjs'), 'utf8')
  assert.match(hub, /declared: link\.status === 'missing'/)
})
test('declareSelf：备份、写入、回读，三处状态都对', () => {
  const { home, sourceDir } = fake({ withNodeModules: true, declare: false, bundle: false })
  const denied = declareSelf({ home, profile: 'desktop', sourceDir })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /confirm: true/)

  const result = declareSelf({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.ok(result.backup, '要留备份')
  assert.match(result.spec, /^link:/, 'dependencies 里写的是 link: 形式')
  const steps = result.steps.map((step) => step.label)
  assert.deepEqual(steps, ['读 profile', '看现状', '写前备份', '写入', '回读校验'])

  const again = declareSelf({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(again.changed, false, '第二次不该再写')
})

test('declareSelf 之后接着修联接，一条龙能走通', () => {
  const { home, sourceDir } = fake({ withNodeModules: true, declare: false, bundle: false })
  assert.equal(declareSelf({ home, profile: 'desktop', sourceDir, confirm: true }).ok, true)
  const relink = repairSelfLink({ home, profile: 'desktop', sourceDir, confirm: true })
  assert.equal(relink.ok, true)
  assert.equal(resolveSelfLink({ home, profile: 'desktop', sourceDir }).status, 'ok')
})
