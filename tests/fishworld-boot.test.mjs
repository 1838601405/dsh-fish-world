// 新版 Flutter 面板的启动产物检查。
//
// ★ 2026-11-20 重写：原判据要求 index.html 里有 XMLHttpRequest.prototype.open 重写，
//   那是**上一代面板**的兼容层（把请求改道到 DSH 同源接口）。
//   现在的面板自己有 bridge_web.dart：先探端口（/api/health），
//   再直连 /api/chat、/api/model/config —— 不需要 XHR 重写。
//   产物是干净的 Flutter 构建，没有那段补丁是**对的**，不是回归。
//
// 判据改成检查「新版面板真正依赖的东西」：
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const UI = join(ROOT, 'ui', 'fishworld')
const INDEX = readFileSync(join(UI, 'index.html'), 'utf8')

test('面板产物完整：入口页 + bootstrap + 本地 CanvasKit', () => {
  assert.match(INDEX, /flutter_bootstrap\.js/, '要有 Flutter 引导脚本')
  assert.match(INDEX, /<base href="\/dsh-fish-world\/fishworld\/">/, '要用 DSH 的子路径')
  assert.ok(existsSync(join(UI, 'flutter_bootstrap.js')), 'flutter_bootstrap.js 要真存在')
  assert.ok(existsSync(join(UI, 'main.dart.js')), 'main.dart.js 要真存在')

  // CanvasKit 必须用本地副本：回 gstatic 会在国内直接超时。
  // ★ 2026-11-20：不再匹配源码字面量 `canvasKitBaseUrl: 'canvaskit/'`——
  //   现在的 flutter_bootstrap.js 是**压缩过**的（8.8KB 一行），
  //   那个配置名在产物里已经不存在了。判据改成看**实质**：
  //   ① 本地 canvaskit 目录真的在（这才是「走本地」的物理保证）
  //   ② bootstrap 里引用了 canvaskit 路径
  const boot = readFileSync(join(UI, 'flutter_bootstrap.js'), 'utf8')
  const ckDir = join(UI, 'canvaskit')
  assert.ok(existsSync(ckDir), 'canvaskit 目录要在（走本地副本的物理保证）')
  assert.ok(existsSync(join(ckDir, 'canvaskit.js')), 'canvaskit.js 要在')
  // ★ 判据看「有没有显式配置」，而不是「有没有出现 gstatic 字样」。
  //   flutter_bootstrap.js 里**一定**有 www.gstatic.com —— 那是 Flutter loader 的
  //   回退分支（`canvasKitBaseUrl ? 用它 : ... ? gstatic : 'canvaskit'`），
  //   压缩后也在。真正的判据是：loader.load 的 config 里**显式给了** canvasKitBaseUrl。
  //   给了 ⇒ 那个 gstatic 分支永远走不到。
  const i = boot.lastIndexOf('_flutter.loader.load({')
  assert.ok(i >= 0, 'flutter_bootstrap.js 里要有 loader.load 调用')
  const call = boot.slice(i, i + 300)
  assert.match(call, /canvasKitBaseUrl:\s*'canvaskit\//,
    'loader.load 必须显式配 canvasKitBaseUrl: canvaskit/ —— 否则会回 gstatic 超时')
})

test('面板不再依赖旧兼容层（XHR 重写已随旧面板移除）', () => {
  // 这条是「反向判据」：说明为什么上面不再要求 XHR 重写。
  // 如果哪天有人把旧补丁加回来，会在这里被点出来需要重新评估。
  assert.doesNotMatch(INDEX, /XMLHttpRequest\.prototype\.open/,
    '旧兼容层的 XHR 重写不该出现在新产物里；要加回来请先说明为什么')
})

test('打包快照随产物一起发布（断网也能显示内容）', () => {
  const snap = join(UI, 'assets', 'assets', 'data', 'fish_snapshot.json')
  assert.ok(existsSync(snap), '要带打包快照，桥不可用时回落')
})
