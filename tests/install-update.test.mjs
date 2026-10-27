// 「一键更新」的 bug（主人 2026-10-27）：
// 点完显示「更新完成」，重启 DSH 后还是旧版。
//
// 根因：runInstall 只装「缺失」的包，已装但过期的根本不进计划；
// 而且 GitHub 源的依赖被 lockfile 钉在 codeload 的 commit 哈希上，
// 普通 pnpm install 永远不会重拉，pnpm update 又只支持 registry 包
// （实测报 ERR_PNPM_INVALID_PACKAGE_NAME）。
//
// 这里测的是 planInstall（纯计划函数，不执行 pnpm），锁定三条分支各自走对的命令。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { COMPANIONS, PACKAGE, planInstall } from '../lib/install.mjs'

/** 造一个 profile 目录：package.json 里有声明，node_modules 里「已装」或「没装」。
 *  其余必需依赖默认都算已装，否则它们会被排进「缺失」分支，干扰要测的那一条。 */
function fakeProfile({ deps, installed }) {
  const home = mkdtempSync(join(tmpdir(), 'fw-plan-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  const allDeps = { ...deps }
  for (const item of COMPANIONS) {
    if (!item.optional && !Object.hasOwn(allDeps, item.name)) allDeps[item.name] = item.spec
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: allDeps }))
  const present = new Set([...installed, ...COMPANIONS.filter((c) => !c.optional).map((c) => c.name)])
  for (const name of present) {
    // 只给「本次要测」的包造实体，其余必需依赖也造，避免被当成缺失
    if (!Object.hasOwn(allDeps, name)) continue
    mkdirSync(join(profileDir, 'node_modules', name), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.0.1' }))
  }
  return { home, profileDir }
}

const labels = (planned) => planned.map((plan) => plan.label)

test('没有 updateOutdated 时只装缺失的包，不碰已装的（旧行为保持）', () => {
  const all = COMPANIONS.map((item) => item.name)
  const { home } = fakeProfile({ deps: Object.fromEntries(COMPANIONS.map((c) => [c.name, c.spec])), installed: all })
  const planned = planInstall({ home, profile: 'desktop', includeOptional: true })
  const adds = planned.filter((plan) => plan.label.startsWith('pnpm add ') && !plan.label.includes(':'))
  assert.equal(adds.length, 0, '全都装好了，不该再有 add')
  assert.deepEqual(labels(planned), ['pnpm install'], '只剩最后一次完整 install')
})

test('GitHub 源的过期依赖走 pnpm add 重解析（update 不支持 github 源）', () => {
  const { home } = fakeProfile({
    deps: { 'dsh-bili-subagent': 'github:Yuuyuko-uu/dsh-bili-subagent' },
    installed: ['dsh-bili-subagent'],
  })
  const planned = planInstall({ home, profile: 'desktop', updateOutdated: ['dsh-bili-subagent'] })
  assert.deepEqual(labels(planned), [
    'pnpm add github:Yuuyuko-uu/dsh-bili-subagent',
    'pnpm install',
  ])
  // 绝不能出现 pnpm update github 源：实测会报 ERR_PNPM_INVALID_PACKAGE_NAME
  assert.equal(planned.some((plan) => plan.label.startsWith('pnpm update ')), false)
})

test('registry 包的过期依赖走 pnpm update --latest', () => {
  const { home } = fakeProfile({
    deps: { 'dsh-douyin-browser-local': '1.4.4' },
    installed: ['dsh-douyin-browser-local'],
  })
  const planned = planInstall({ home, profile: 'desktop', updateOutdated: ['dsh-douyin-browser-local'] })
  assert.deepEqual(labels(planned), ['pnpm update dsh-douyin-browser-local', 'pnpm install'])
  const update = planned.find((plan) => plan.label.startsWith('pnpm update '))
  assert.ok(update.args.includes('--latest'), '要拿到最新版，不是只满足当前范围')
})

test('link: 源的依赖不会被「更新」（没有新版概念，动它会弄坏声明）', () => {
  const { home } = fakeProfile({
    deps: { [PACKAGE]: 'link:C:/Users/x/dsh-fish-world' },
    installed: [PACKAGE],
  })
  const planned = planInstall({ home, profile: 'desktop', updateOutdated: [PACKAGE] })
  assert.deepEqual(labels(planned), ['pnpm install'], '本插件只能 git pull，pnpm 不动它')
})

test('没装过的包走 add，不会被重复排进 update', () => {
  const { home } = fakeProfile({
    deps: { 'dsh-tts-bridge': 'github:Yuuyuko-uu/dsh-tts-bridge' },
    installed: [],
  })
  const planned = planInstall({ home, profile: 'desktop', includeOptional: true, updateOutdated: ['dsh-tts-bridge'] })
  const forIt = planned.filter((plan) => plan.label.includes('dsh-tts-bridge'))
  assert.equal(forIt.length, 1, '同一个包不能既 add 又 update')
  assert.equal(forIt[0].label, 'pnpm add dsh-tts-bridge')
})

test('空名 / 不存在的包被忽略，不会拼出坏命令', () => {
  const { home } = fakeProfile({ deps: {}, installed: [] })
  const planned = planInstall({ home, profile: 'desktop', updateOutdated: ['', '  ', 'nope-pkg'] })
  assert.deepEqual(labels(planned), ['pnpm install'])
})
