// 目录选择：让主人从本机目录树里点选，而不是手打一串路径。
//
// 只读、只列目录、只允许 loopback：
//  - GET /dsh-fish-world/fs/roots   → 各盘符 / 根（Windows 是 C:\、D:\…，其它是 /）
//  - GET /dsh-fish-world/fs/list    → 某个目录下的子目录（不返回文件内容）
//
// 为什么不直接用浏览器的 <input webkitdirectory>：它只给相对文件名，
// 拿不到绝对路径；面板要把"收藏存在哪里"如实写在界面上，所以由本地服务列出目录。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

const MAX_ENTRIES = 500

/** 本机可选的根目录：Windows 列出存在的盘符，其它系统就是 /。 */
export function listRoots() {
  const roots = []
  if (platform() === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const drive = String.fromCharCode(code) + ':\\'
      try {
        if (existsSync(drive)) roots.push({ path: drive, label: drive.slice(0, 2) })
      } catch {}
    }
  } else {
    roots.push({ path: '/', label: '/' })
  }
  // 常见落点排前面，省得每次从盘符根一路点进去。
  const home = homedir()
  const shortcuts = [
    { path: home, label: '主目录' },
    { path: join(home, 'Desktop'), label: '桌面' },
    { path: join(home, 'Documents'), label: '文档' },
  ].filter((item) => {
    try { return existsSync(item.path) && statSync(item.path).isDirectory() } catch { return false }
  })
  return { ok: true, home, roots, shortcuts }
}

/** 列出一个目录下的子目录。只给目录名与路径，不读文件内容。 */
export function listDir(rawPath) {
  const target = resolve(String(rawPath || homedir()))
  if (!isAbsolute(target)) return { ok: false, error: '需要绝对路径' }
  let stat
  try { stat = statSync(target) } catch { return { ok: false, error: '这个目录不存在', path: target } }
  if (!stat.isDirectory()) return { ok: false, error: '这不是目录', path: target }

  const entries = []
  let truncated = false
  try {
    const names = readdirSync(target).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    for (const name of names) {
      if (name.startsWith('.')) continue
      if (entries.length >= MAX_ENTRIES) { truncated = true; break }
      const full = join(target, name)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch { continue }
      entries.push({ name, path: full })
    }
  } catch (error) {
    return { ok: false, error: `读不了这个目录：${error?.message || error}`, path: target }
  }

  const info = parse(target)
  return {
    ok: true,
    path: target,
    parent: target === info.root ? '' : dirname(target),
    root: info.root,
    entries,
    truncated,
  }
}

export const __test = { listRoots, listDir }
