// 预览契约：面板读的每一条 GET 路由，预览里都要有对应的假数据。
//
// 这条测试挡的是一类反复出现的问题：新加了一张卡、面板去读某条路由，
// 但 scripts/preview-ui.mjs 没跟着补假数据 —— 预览里那张卡就一直显示
// 「读取失败：HTTP 404」，而真实环境是好的，很容易被当成真 bug 去查。
//
// 做法：把「面板会用 GET 读的路由」列出来，逐条要求预览里有 stub。
// 只读动作（POST）不需要 stub；确实没法在预览里造的要在 EXEMPT 里写明原因。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const preview = readFileSync(join(ROOT, 'scripts', 'preview-ui.mjs'), 'utf8')
const panel = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

// 面板真的会 GET 的路由（从 ui/panel.js 里出现的字面量整理）
const PANEL_GET_ROUTES = [
  '/dsh-fish-world/config',
  '/dsh-fish-world/astrbot',
  '/dsh-fish-world/platforms',
  '/dsh-fish-world/qq/chat',
  '/dsh-fish-world/world/activity',
  '/dsh-fish-world/world/wishes',
  '/dsh-fish-world/world/records',
  '/dsh-fish-world/world/diary',
  '/dsh-fish-world/world/growth',
  '/dsh-fish-world/world/knowledge',
  '/dsh-fish-world/world/sticker-wishes',
  '/dsh-fish-world/qqagent',
  '/dsh-fish-world/env',
  '/dsh-fish-world/storage',
  '/dsh-fish-world/doctor/dependency',
  '/dsh-fish-world/doctor/storage',
  '/dsh-fish-world/doctor/update',
  '/dsh-fish-world/links',
  '/dsh-fish-world/stickers',
  '/dsh-fish-world/stickers/dir',
  '/dsh-fish-world/fish/profile',
  '/dsh-fish-world/fish/persona',
  '/dsh-fish-world/fish/portrait',
  '/dsh-fish-world/extensions',
  '/dsh-fish-world/capabilities',
]

// 预览里确实造不出来、或面板不依赖其数据的：写明原因，不许空着。
const EXEMPT = new Map([])

test('预览契约：面板 GET 的每条路由都有假数据', () => {
  const missing = []
  for (const route of PANEL_GET_ROUTES) {
    if (EXEMPT.has(route)) continue
    // 预览里写成 '/dsh-fish-world/xxx': {...} 或 path === '/dsh-fish-world/xxx'
    const key = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`['"]${key}['"]\\s*:|path === ['"]${key}['"]`)
    if (!pattern.test(preview)) missing.push(route)
  }
  assert.deepEqual(missing, [], '这些路由在预览里没有假数据，对应卡片会显示 HTTP 404：\n' + missing.join('\n'))
})

test('预览契约：每条列表在清单里，且真的在 panel.js 里被读过', () => {
  // 清单不许写没用的项：每条都得能在 ui/panel.js 找到，否则清单本身会漂移。
  const orphans = PANEL_GET_ROUTES.filter((route) => !panel.includes(route))
  assert.deepEqual(orphans, [], '清单里这些路由 panel.js 根本没读，删掉或改对：\n' + orphans.join('\n'))
})

test('预览契约：假数据与真实状态同形（关键字段在）', () => {
  // 只断言面板真的会读的字段，避免假数据形状漂移导致预览「看着对、其实缺字段」。
  const mustHave = {
    '/dsh-fish-world/fish/profile': ['fish', 'owner', 'sessions'],
    '/dsh-fish-world/storage': ['root', 'folders'],
    '/dsh-fish-world/qq/chat': ['chat', 'config', 'targets', 'sessions'],
    '/dsh-fish-world/world/knowledge': ['config', 'problems', 'hasKey'],
    '/dsh-fish-world/world/activity': ['platforms', 'items'],
    '/dsh-fish-world/doctor/dependency': ['counts'],
    '/dsh-fish-world/doctor/storage': ['audit', 'growth'],
  }
  for (const [route, fields] of Object.entries(mustHave)) {
    const at = preview.indexOf(`'${route}':`)
    assert.ok(at >= 0, `${route} 没有假数据`)
    const slice = preview.slice(at, at + 1200)
    for (const field of fields) {
      assert.ok(new RegExp(`\\b${field}\\s*:`).test(slice), `${route} 的假数据缺字段 ${field}`)
    }
  }
})
