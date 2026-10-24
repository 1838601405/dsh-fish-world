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
  'lib/whale.mjs',
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
  'lib/core-plugins/read-animation/index.js',
  'lib/core-plugins/read-animation/animation.js',
  'lib/core-plugins/read-animation/admission.js',
  'lib/core-plugins/read-animation/model.js',
  'lib/core-plugins/read-animation/LICENSE',
  'lib/mood-badge.js',
  'lib/panel.js',
  'client.js',
  'scripts/doctor.mjs',
  'scripts/repair-desktop-auth.mjs',
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

for (const module of ['config', 'bus', 'qq', 'whale', 'sdk', 'loader', 'tool', 'http', 'market', 'world', 'qzone', 'stickers', 'env']) {
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
