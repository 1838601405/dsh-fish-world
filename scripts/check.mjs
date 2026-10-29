// 静态自检：不启动 DSH，只确认文件齐全、模块可导入、清单可解析。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
  'lib/media-tools.mjs',
  'lib/protocol-supervisor.mjs',
  'lib/qqagent.mjs',
  'lib/storage.mjs',
  'lib/activity.mjs',
  'lib/records.mjs',
  'lib/fspick.mjs',
  // 整合层：范围清单（hub）、时间线（actions）、记忆中枢（memory-hub）、
  // 记忆便签排版（memory-brief）、衣柜双写（fish-memory-bridge）、鱼的风格（fish-tone 只读）。
  'lib/hub.mjs',
  'lib/memory-hub.mjs',
  'lib/memory-brief.mjs',
  'lib/actions.mjs',
  'lib/fish-memory-bridge.mjs',
  'lib/fish-tone.mjs',
  // 微信：dsh-wechat-plugin 的只读状态（插件 / 地址 / 状态接口 / 通道 / 账号）。
  'lib/wechat-plugin.mjs',
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

for (const module of ['config', 'bus', 'qq', 'astrbot', 'fish-roles', 'sdk', 'loader', 'tool', 'http', 'market', 'world', 'qzone', 'stickers', 'env', 'storage', 'activity', 'records', 'fspick', 'media-tools']) {
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

// 面板数字控件的范围必须和 platforms.mjs 的 NUMERIC_RULES 一致：
// 一处给人输入、一处做归一化，本质是同一件事的两份定义。
// 2026-10-26 主人调「每日发送上限」时踩过：后端放到 3000、面板还写着 500，
// 填进去保存就被夹回 500（表现为「只要一动就自动变成五百」）。
try {
  const { NUMERIC_RULES } = await import(pathToFileURL(join(root, 'lib', 'platforms.mjs')).href)
  const panelSource = readFileSync(join(root, 'ui', 'panel.js'), 'utf8')
  const re = /\{ key: '([^']+)'[^}]*?kind: 'num'[^}]*?min: (-?\d+), max: (-?\d+)/g
  let match
  while ((match = re.exec(panelSource))) {
    const [, key, min, max] = match
    const rule = NUMERIC_RULES[key]
    if (!rule) problems.push(`ui/panel.js 的数字字段 ${key} 在 NUMERIC_RULES 里没有对应规则`)
    else if (Number(min) !== rule[0] || Number(max) !== rule[1]) {
      problems.push(`数字字段范围漂移：${key} 面板写 ${min}-${max}，归一化规则是 ${rule[0]}-${rule[1]}`)
    }
  }
} catch (error) {
  problems.push(`比对面板数字字段失败：${error.message}`)
}

// 面板「鱼手上的动作」那张清单里的动作名，必须真的在 fish_world 的 ACTIONS 里：
// 清单是对人展示的目录，ACTIONS 是真正能被调用的枚举。两边各写一份，迟早出现
// 「面板上有、调了报未知 action」这种假功能。
try {
  const { TOOL_GROUPS } = await import(pathToFileURL(join(root, 'lib', 'hub.mjs')).href)
  const toolSource = readFileSync(join(root, 'lib', 'tool.mjs'), 'utf8')
  const enumStart = toolSource.indexOf('const ACTIONS = [')
  const enumEnd = toolSource.indexOf(']', enumStart)
  const callable = new Set(
    enumStart < 0 || enumEnd < 0
      ? []
      : [...toolSource.slice(enumStart, enumEnd).matchAll(/'([^']+)'/g)].map((m) => m[1]),
  )
  if (!callable.size) problems.push('读不到 lib/tool.mjs 的 ACTIONS，动作清单没法核对')
  const listed = new Set()
  for (const group of TOOL_GROUPS) {
    for (const action of group.actions) {
      listed.add(action.name)
      if (!callable.has(action.name)) {
        problems.push(`动作清单里的 ${action.name}（${group.label}）在 fish_world 的 ACTIONS 里不存在`)
      }
    }
  }
  // 反过来也要核：ACTIONS 里有、清单里没有的动作，面板上就永远看不见它。
  for (const name of callable) {
    if (!listed.has(name)) problems.push(`动作 ${name} 在 ACTIONS 里有，但面板清单里没有（用户看不见它）`)
  }
} catch (error) {
  problems.push(`核对动作清单失败：${error.message}`)
}

// 记忆目录名只有一个真源（lib/knowledge.mjs 的 KNOWLEDGE_FOLDER）。
// memory-hub 自己拼路径去读知识库，两处名字一旦漂，并库就会「找不到知识库」而静默返回空。
try {
  const knowledge = await import(pathToFileURL(join(root, 'lib', 'knowledge.mjs')).href)
  const memoryHub = await import(pathToFileURL(join(root, 'lib', 'memory-hub.mjs')).href)
  if (memoryHub.MEMORY_FOLDER !== knowledge.KNOWLEDGE_FOLDER) {
    problems.push(`记忆目录名漂了：memory-hub 写 ${memoryHub.MEMORY_FOLDER}，knowledge.mjs 是 ${knowledge.KNOWLEDGE_FOLDER}`)
  }
} catch (error) {
  problems.push(`核对记忆目录名失败：${error.message}`)
}

// 自检闸：被跟踪文件里不许出现「本机」绝对路径（铁律 ⑤）。
//
// 这里**故意不写任何具体的用户名 / 本机目录名**：把「这台机器是谁」钉进仓库，
// 本身就是铁律 ⑤ 禁止的事（以前这里写死过两个本机串，检查器自己成了违规样本）。
// 改成运行时问本机：家目录的 basename、USERNAME / USER，用它们拼出三种形状——
//   · Windows 盘符：`X:\<名字>` / `X:/<名字>`
//   · 类 Unix：`/home/<名字>`、`/Users/<名字>`
// 只拦这三种「带着本机用户名的绝对路径」，不拦中性占位（`C:/Users/x`、`D:/fake`
// 这类是测试与文档要用的例子）。
function localPathNeedles() {
  const names = new Set()
  for (const value of [basename(homedir()), process.env.USERNAME, process.env.USER]) {
    const text = String(value || '').trim()
    // 太短的名字（一两个字符）会把正常内容扫成命中，宁可不查。
    if (text.length >= 3) names.add(text)
  }
  return [...names]
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把「本机用户名」编成两条正则（分开写，比一条带分支的大正则好读也好改）：
 *   · Windows：`X:\…\<名字>`，名字前可以隔 0~3 层目录（`C:\Users\<名字>` 就是隔一层）；
 *   · 类 Unix：`/home/<名字>`、`/Users/<名字>`。
 * 判定只看「名字是不是路径的一段」，所以 `C:/Users/x` 这种中性占位不会命中。
 */
function localPathPatterns(name) {
  const escaped = escapeRe(name)
  const segment = '[^\\\\/\\r\\n:*?"<>|]{1,64}'
  // 名字后面不能再接字母/数字/下划线/点/横线，否则只是「前缀相同」（比如仓库名里恰好带着
  // 同一串数字）。这样判定的是「名字正好是路径的一段」。
  const tail = '(?![\\w.-])'
  return [
    new RegExp(`[A-Za-z]:[\\\\/]+(?:${segment}[\\\\/]+){0,3}${escaped}${tail}`, 'i'),
    new RegExp(`/(?:home|Users)/${escaped}${tail}`, 'i'),
  ]
}

try {
  // 用 git 的「被跟踪文件」清单，而不是遍历目录：后者会把 node_modules 与本地数据也扫进来。
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const needles = localPathNeedles()
  for (const name of needles) {
    const patterns = localPathPatterns(name)
    for (const file of listed) {
      let text = ''
      try {
        text = readFileSync(join(root, file), 'utf8')
      } catch {
        continue // 二进制 / 读不动：不在这里判
      }
      const hits = patterns.map((re) => text.search(re)).filter((at) => at >= 0)
      if (!hits.length) continue
      const line = text.slice(0, Math.min(...hits)).split('\n').length
      problems.push(`${file} 里出现本机绝对路径（铁律 ⑤）：第 ${line} 行`)
    }
  }
} catch (error) {
  // 不是 git 仓库（比如解压出来的包）就列不出被跟踪文件。跳过要说出来，不能静默当通过。
  console.log(`· 跳过「本机路径」自检：这里不是可用的 git 仓库（${error.message.split('\n')[0]}）`)
}

if (problems.length) {
  console.error('✖ 自检失败：')
  for (const item of problems) console.error('  - ' + item)
  process.exit(1)
}
console.log('✔ 自检通过：文件齐全，模块可导入，清单可解析')
