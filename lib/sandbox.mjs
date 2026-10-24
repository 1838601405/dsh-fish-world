// 鱼箱：鱼的独立工作区与文件访问沙箱。
//
// 安全模型（默认拒绝，白名单放行）：
//  - 鱼只能读写自己的鱼箱目录，任何绝对路径、盘符、UNC 路径一律拒绝；
//  - 先做词法归一（resolve），再做真实路径（realpath）比对，挡住符号链接与
//    目录联接把访问引到鱼箱外；
//  - 拒绝 .. 穿越、拒绝以盘符/协议开头的输入、拒绝空字节；
//  - 只读操作也走同一套校验，防止借"读图片"把工作区外的文件发出去。
//
// 鱼箱与主人工程目录分开：默认落在 $DSH_HOME/fish-tank，不与任何代码仓库重叠。
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const TANK_DIR_NAME = 'fish-tank'

export class SandboxError extends Error {
  constructor(message, code = 'sandbox-denied') {
    super(message)
    this.name = 'SandboxError'
    this.code = code
  }
}

/** 把任意输入归一成"相对鱼箱"的路径；越界直接抛错。 */
function normalizeRelative(input) {
  const raw = String(input == null ? '' : input)
  if (raw.includes('\0')) throw new SandboxError('路径包含非法字符', 'bad-path')
  const trimmed = raw.trim()
  // 空白路径不能当成"鱼箱根目录"放行——那等于允许列目录/写到根上。
  if (!trimmed) throw new SandboxError('路径不能为空', 'empty-path')
  // 协议 / 盘符 / UNC 一律不接受：鱼的沙箱里只有相对路径。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) throw new SandboxError('沙箱内不接受协议路径', 'protocol-path')
  if (/^[a-zA-Z]:/.test(trimmed)) throw new SandboxError('沙箱内不接受盘符路径', 'drive-path')
  if (/^[\\/]{2}/.test(trimmed)) throw new SandboxError('沙箱内不接受网络路径', 'unc-path')
  if (isAbsolute(trimmed)) throw new SandboxError('沙箱内不接受绝对路径', 'absolute-path')

  const rel = relative('.', trimmed)
  const parts = rel.split(/[\\/]+/).filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) throw new SandboxError('路径不能跳出鱼箱', 'traversal')
  if (!parts.length) throw new SandboxError('路径没有指向任何文件', 'empty-path')
  return parts.join(sep)
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

export function createSandbox({ home = DSH_HOME, root } = {}) {
  const tankRoot = resolve(root || join(home, TANK_DIR_NAME))

  function ensureRoot() {
    if (!existsSync(tankRoot)) mkdirSync(tankRoot, { recursive: true })
    return tankRoot
  }

  /**
   * 把沙箱相对路径解析成真实绝对路径，并做双重越界检查。
   * @param {string} input 沙箱内的相对路径
   * @param {{ mustExist?: boolean, forWrite?: boolean }} options
   */
  function resolveInside(input, { mustExist = false, forWrite = false } = {}) {
    const rel = normalizeRelative(input)
    ensureRoot()
    const candidate = resolve(tankRoot, rel)

    // 词法检查：先挡住 ../ 之外的花招
    if (!isInside(tankRoot, candidate)) throw new SandboxError('路径跳出鱼箱', 'escape')

    if (forWrite) {
      // 写操作只看父目录的真实路径，文件本身可能还不存在。
      const parent = resolve(candidate, '..')
      if (!isInside(tankRoot, parent)) throw new SandboxError('写入位置跳出鱼箱', 'escape')
      const realParent = existsSync(parent) ? realpathSync(parent) : parent
      if (!isInside(tankRoot, realParent)) throw new SandboxError('写入位置的父目录指向鱼箱外', 'symlink-escape')
      return candidate
    }

    if (!existsSync(candidate)) {
      if (mustExist) throw new SandboxError('沙箱内找不到这个文件', 'not-found')
      return candidate
    }

    // 真实路径检查：符号链接 / 目录联接指向鱼箱外时拒绝
    let real
    try { real = realpathSync(candidate) } catch { real = candidate }
    if (!isInside(tankRoot, real)) throw new SandboxError('该路径指向鱼箱外', 'symlink-escape')

    // 复核真实路径本身也不是软链逃逸
    try {
      const stat = lstatSync(candidate)
      if (stat.isSymbolicLink() && !isInside(tankRoot, real)) {
        throw new SandboxError('不接受指向鱼箱外的符号链接', 'symlink-escape')
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error
    }

    if (mustExist) {
      try {
        if (!statSync(real).isFile()) throw new SandboxError('目标不是文件', 'not-a-file')
      } catch (error) {
        if (error instanceof SandboxError) throw error
        throw new SandboxError('无法读取该文件', 'unreadable')
      }
    }
    return real
  }

  /** 判断某个绝对路径是否在鱼箱内（供内部诊断用，不暴露给模型）。 */
  function contains(path) {
    try {
      const real = existsSync(path) ? realpathSync(path) : resolve(path)
      return isInside(tankRoot, real)
    } catch {
      return false
    }
  }

  return {
    root: () => tankRoot,
    ensureRoot,
    resolveInside,
    contains,
    // 给面板/诊断用的只读快照
    describe: () => ({ root: tankRoot, exists: existsSync(tankRoot) }),
  }
}

/** 校验一段"图片/表情来源"参数是否允许进入沙箱读取。 */
export function sandboxSource(sandbox, source) {
  if (!sandbox) throw new SandboxError('鱼箱未初始化，拒绝读取本机文件', 'no-sandbox')
  const raw = String(source?.localPath || source?.file || '').trim()
  if (!raw) throw new SandboxError('缺少鱼箱内路径', 'empty-path')
  return sandbox.resolveInside(raw, { mustExist: true })
}
