// 静态自检：不启动 DSH，只确认文件齐全、模块可导入、清单可解析。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function need(file) {
  if (!existsSync(join(root, file))) problems.push(`缺少文件：${file}`)
}

for (const file of [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'lib/index.js',
  'lib/config.mjs',
  'lib/bus.mjs',
  'lib/qq.mjs',
  'lib/sdk.mjs',
  'lib/loader.mjs',
  'lib/tool.mjs',
  'lib/http.mjs',
  'lib/market.mjs',
  'lib/world.mjs',
  'lib/qzone.mjs',
  'lib/stickers.mjs',
  'lib/env.mjs',
  'lib/capabilities.mjs',
  'lib/persona.mjs',
  'lib/persona-presets.mjs',
  'lib/fish-roles.mjs',
  'lib/growth.mjs',
  'lib/doctor.mjs',
  'lib/sandbox.mjs',
  'lib/platforms.mjs',
  'lib/portrait.mjs',
  'lib/links.mjs',
  'lib/astrbot.mjs',
  'lib/qq-inbox.mjs',
  'lib/sticker-wishes.mjs',
  'lib/knowledge.mjs',
  'lib/kb-vector.mjs',
  'lib/video.mjs',
  'lib/video-frames.mjs',
  'lib/protocol-supervisor.mjs',
  'lib/qqagent.mjs',
  'lib/storage.mjs',
  'lib/activity.mjs',
  'lib/records.mjs',
  'lib/fspick.mjs',
  'lib/core-plugins/read-animation/index.js',
  'lib/core-plugins/read-animation/animation.js',
  'lib/core-plugins/read-animation/admission.js',
  'lib/core-plugins/read-animation/model.js',
  'lib/core-plugins/read-animation/LICENSE',
  'lib/panel.js',
  'ui/index.html',
  'ui/preview.html',
  'ui/tokens.css',
  'ui/panel.css',
  'ui/panel.js',
  'ui/AGENTS.md',
  'client.js',
  'THIRD-PARTY-NOTICES.md',
  'scripts/check-ui.mjs',
  'scripts/preview-ui.mjs',
  'scripts/doctor.mjs',
  'scripts/repair-desktop-auth.mjs',
  'scripts/auth-watchdog.mjs',
  'scripts/install-desktop.mjs',
  'examples/hello-qq/plugin.json',
  'examples/hello-qq/index.js',
]) need(file)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-fish-world') problems.push('package.json name 不对')
if (!pkg.dsh?.bundle?.patch) problems.push('package.json 缺 dsh.bundle.patch')
if (pkg.dependencies?.['dsh-whale-widget']) problems.push('dsh-whale-widget 必须是可选集成，不应成为强依赖')
if (!pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-settings')) problems.push('package.json 未声明 Harness 设置页客户端注入')
if (!existsSync(join(root, pkg.main || ''))) problems.push('package.json main 指向不存在的文件')

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('fish-world')) problems.push('cordis.patch.yml 没挂载 id')
if (patch.includes('name: dsh-whale-widget')) problems.push('dsh-whale-widget 应按运行时检测处理，不要由本包重复装配')

for (const module of ['config', 'bus', 'qq', 'astrbot', 'fish-roles', 'sdk', 'loader', 'tool', 'http', 'market', 'world', 'qzone', 'stickers', 'env', 'storage', 'activity', 'records', 'fspick']) {
  try {
    await import(pathToFileURL(join(root, 'lib', `${module}.mjs`)).href)
  } catch (error) {
    problems.push(`lib/${module}.mjs 导入失败：${error.message}`)
  }
}
try {
  await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
} catch (error) {
  problems.push(`lib/index.js 导入失败：${error.message}`)
}

// 版本号只有一个事实来源，但它在两个文件里各写了一份（package.json 给包管理器，
// version.mjs 给运行时读）。漂移过一次就很难发现，所以在这里钉死。
const versionModule = await import(pathToFileURL(join(root, 'lib', 'version.mjs')).href)
if (String(versionModule.version || '') !== String(pkg.version || '')) {
  problems.push(`版本号不一致：package.json=${pkg.version} 但 lib/version.mjs=${versionModule.version}`)
}

// AstrBot 桥插件已拆到独立仓库（astrbot_plugin_fishworld_bridge）单独发布，
// 版本号由那边自己管，这里不再强制同步。若本地存在该目录，仍做一次一致性校验。
const bridgeMetaPath = join(root, 'astrbot-plugin', 'metadata.yaml')
if (existsSync(bridgeMetaPath)) {
  const bridgeMeta = readFileSync(bridgeMetaPath, 'utf8')
  const bridgeVersion = /^version:\s*v?([\d.]+)\s*$/m.exec(bridgeMeta)?.[1] || ''
  if (bridgeVersion && bridgeVersion !== String(pkg.version || '')) {
    problems.push(`AstrBot 桥插件版本号不一致：metadata.yaml=${bridgeVersion} 但 package.json=${pkg.version}`)
  }
}

for (const bad of ['ctx.kernel', 'process.exit(', 'eval(']) {
  const text = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  if (text.includes(bad)) problems.push(`lib/index.js 出现禁止写法：${bad}`)
}

if (problems.length) {
  console.error('✖ 自检失败：')
  for (const item of problems) console.error('  - ' + item)
  process.exit(1)
}
console.log('✔ 自检通过：文件齐全，模块可导入，清单可解析')
