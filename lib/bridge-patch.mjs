// 给已安装的 dsh-qq-bridge 打「出站闸」补丁：发 QQ 之前剥掉工具调用语法。
//
// 为什么需要它：桥插件自己监听 session/event、自己调 OneBot 发消息，不经过
// dsh-fish-world 的 onTurnEnd。它没有发送前钩子，所以只能就地补一小段。
//
// 设计约束：
//  · 补丁内容不手写第二份——从 lib/util.mjs 的 `#region tool-markup-guard` 原样抄，
//    这样两边逻辑永远一致（改 util 后重跑脚本即可）。
//  · 可回退：revertBridgePatch() 把补丁块和调用点一起删掉，回到原样。
//  · 幂等：重复执行只会替换补丁块，不会叠加。
//  · 用 IIFE 包起来，避免和桥自己的变量名撞车。
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_HOME } from './paths.mjs'

export const GUARD_BEGIN = '// >>> dsh-fish-world: tool-markup-guard >>>'
export const GUARD_END = '// <<< dsh-fish-world: tool-markup-guard <<<'
export const CALL_MARK = '// [dsh-fish-world] 出站闸：工具调用语法'

/** 从 lib/util.mjs 源码里抽出 `#region tool-markup-guard` 那段，去掉 export。 */
export function extractGuard(utilSource) {
  const src = String(utilSource || '')
  const begin = src.indexOf('// #region tool-markup-guard')
  const end = src.indexOf('// #endregion tool-markup-guard')
  if (begin < 0 || end < 0 || end <= begin) throw new Error('lib/util.mjs 里找不到 tool-markup-guard 区域标记')
  const body = src
    .slice(begin, end)
    .split('\n')
    .filter((line) => !line.includes('#region tool-markup-guard') && !line.includes('#endregion tool-markup-guard'))
    .join('\n')
  return body.replace(/^export\s+/gm, '').trim()
}

function guardBlock(guard) {
  return [
    GUARD_BEGIN,
    '// 自动生成：改 lib/util.mjs 的 #region tool-markup-guard 后重跑',
    '//   node scripts/patch-qq-bridge.mjs',
    '// 作用：桥插件自己发 QQ，不经过 dsh-fish-world，所以在这里也做一次出站闸。',
    'const stripToolMarkup = (() => {',
    guard,
    '  return stripToolMarkup',
    '})()',
    GUARD_END,
  ].join('\n')
}

const CALL_BLOCK = [
  CALL_MARK,
  '    待发文字 = stripToolMarkup(待发文字)',
  '    if (!String(待发文字 || \'\').trim() && !(Array.isArray(图们) && 图们.length)) {',
  '      记账(\'这一轮只剩工具调用语法，已丢弃（不往 QQ 发）\')',
  '      return',
  '    }',
].join('\n')

/**
 * 把补丁写进桥的 host.js 源码。幂等：重复调用只替换补丁块。
 * 找不到锚点就抛错（桥的版本变了），而不是悄悄写坏。
 */
export function applyBridgePatch(hostSource, guard) {
  let s = String(hostSource || '')
  const block = guardBlock(String(guard || '').trim())

  const begin = s.indexOf(GUARD_BEGIN)
  if (begin >= 0) {
    const end = s.indexOf(GUARD_END)
    if (end < 0 || end <= begin) throw new Error('已有补丁块不完整（只有开始标记没有结束标记），先 --revert')
    s = s.slice(0, begin) + block + s.slice(end + GUARD_END.length)
  } else {
    // 插在 `export const inject = [...]` 之后：那里是顶层、且在所有函数之前。
    const m = s.match(/^export const inject\s*=\s*\[[^\]]*\]\s*$/m)
    if (!m) throw new Error('找不到 `export const inject = [...]`，桥的版本可能变了')
    const at = m.index + m[0].length
    s = s.slice(0, at) + '\n\n' + block + '\n' + s.slice(at)
  }

  if (!s.includes(CALL_MARK)) {
    // 桥在「只发标记内」过滤之后取待发文字；就在这里插出站闸。
    const anchor = 'let 待发文字 = 标记.文字'
    const at = s.indexOf(anchor)
    if (at < 0) throw new Error('找不到 `let 待发文字 = 标记.文字`，桥的版本可能变了')
    s = s.slice(0, at) + anchor + '\n    ' + CALL_BLOCK + s.slice(at + anchor.length)
  }
  return s
}

/** 去掉补丁块与调用点，回到桥的原样。 */
export function revertBridgePatch(hostSource) {
  let s = String(hostSource || '')
  let begin = s.indexOf(GUARD_BEGIN)
  let end = s.indexOf(GUARD_END)
  if (begin >= 0 && end > begin) {
    let from = begin
    let to = end + GUARD_END.length
    // 打补丁时在前面加了两个换行、后面加了一个：一起收掉，回退才能和原文件逐字一致。
    if (s.slice(from - 2, from) === '\n\n') from -= 2
    else if (s[from - 1] === '\n') from -= 1
    if (s[to] === '\n') to += 1
    s = s.slice(0, from) + s.slice(to)
  }
  // 调用块：从标记行到 `}` 结束（6 行），按标记整段删，避免误伤相邻代码。
  const lines = s.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(CALL_MARK)) {
      // 跳过：标记行 + 待发文字 + if + 记账 + return + }
      let skip = 1
      while (skip < 8 && i + skip < lines.length) {
        const l = lines[i + skip].trim()
        skip += 1
        if (l === '}') break
      }
      i += skip - 1
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

/** 在一台机器上找已安装的桥：优先环境变量，其次 DSH_HOME 下的各 profile。 */
export function findBridgeHost({ dshHome = DSH_HOME, override = process.env.DSH_QQ_BRIDGE_DIR } = {}) {
  if (override) {
    const direct = join(override, 'lib', 'host.js')
    if (existsSync(direct)) return direct
  }
  const profiles = join(dshHome, 'profiles')
  let names = []
  try { names = readdirSync(profiles, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { names = [] }
  for (const name of names) {
    const file = join(profiles, name, 'node_modules', 'dsh-qq-bridge', 'lib', 'host.js')
    if (existsSync(file)) return file
  }
  return ''
}

const HERE = dirname(fileURLToPath(import.meta.url))
const UTIL_FILE = join(HERE, 'util.mjs')

/** 面板用：桥装没装、出站闸打没打（只读，不改盘）。 */
export function bridgeGuardStatus({ dshHome = DSH_HOME } = {}) {
  const hostFile = findBridgeHost({ dshHome })
  if (!hostFile) return { installed: false, patched: false }
  let patched = false
  try { patched = readFileSync(hostFile, 'utf8').includes(GUARD_BEGIN) } catch {}
  return { installed: true, patched }
}

/**
 * 面板 / CLI 共用：打或撤补丁。改前备份、改后 `node --check`，失败自动回滚。
 * action = apply 或 revert
 */
export function patchBridgeNow({ dshHome = DSH_HOME, utilFile = UTIL_FILE, action = 'apply' } = {}) {
  const hostFile = findBridgeHost({ dshHome })
  if (!hostFile) return { ok: false, installed: false, error: '没有找到已安装的 dsh-qq-bridge' }
  const before = readFileSync(hostFile, 'utf8')
  const patched = before.includes(GUARD_BEGIN)
  if (action === 'revert' && !patched) return { ok: true, installed: true, patched: false, changed: false }
  const guard = action === 'apply' ? extractGuard(readFileSync(utilFile, 'utf8')) : ''
  const after = action === 'apply' ? applyBridgePatch(before, guard) : revertBridgePatch(before)
  if (after === before) return { ok: true, installed: true, patched: action === 'apply', changed: false }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${hostFile}.bak-fishworld-${stamp}`
  try { if (!existsSync(backup)) copyFileSync(hostFile, backup) } catch {}
  try {
    writeFileSync(hostFile, after, 'utf8')
    execFileSync(process.execPath, ['--check', hostFile], { stdio: 'pipe' })
  } catch (error) {
    // 语法检查失败：用备份回滚，绝不能把桥弄坏（它一坏，QQ 整条链路都停）。
    try { if (existsSync(backup)) copyFileSync(backup, hostFile) } catch {}
    return { ok: false, installed: true, patched, error: `写入失败，已回滚：${String(error?.message || error).slice(0, 200)}` }
  }
  return { ok: true, installed: true, patched: action === 'apply', changed: true }
}
