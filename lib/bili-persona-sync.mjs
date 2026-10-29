// B 站人设同步：把鱼世界的人设卡同步到 dsh-bili-whale 的 ~/.bili-ai/persona.md。
//
// 为什么要有：dsh-bili-whale 读自己目录下的 persona.md，鱼世界读 $DSH_HOME/fish-world-personas/；
// 两者不同步 = B 站上是另一个人格。
// 边界：只写文件、不读 bili-whale 的内部状态；未安装时如实说没装。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveDependency } from './env.mjs'

export function createBiliPersonaSync({ home, profile, personaStore, locate = resolveDependency, logger, currentRoleId, targetDir } = {}) {
  // 目标目录默认在用户主目录（与 bili-whale 读的那一份同一路径）；
  // targetDir 只给测试注入替身用，生产代码永远不传。
  const dir = targetDir || join(homedir(), '.bili-ai')
  const targetFile = join(dir, 'persona.md')

  function ensureDir() {
    try {
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
    } catch {}
  }

  function roleIdNow() {
    try {
      if (typeof currentRoleId === 'function') return String(currentRoleId() || 'default')
      if (typeof personaStore?.current === 'function') return String(personaStore.current()?.id || 'default')
    } catch {}
    return 'default'
  }

  function currentText() {
    try {
      const card = personaStore?.get?.(roleIdNow())
      return card?.text || ''
    } catch {
      return ''
    }
  }

  function readTarget() {
    try {
      if (!existsSync(targetFile)) return ''
      return readFileSync(targetFile, 'utf8').replace(/^\uFEFF/, '')
    } catch {
      return ''
    }
  }

  function safeChmod(file) {
    try {
      if (process.platform !== 'win32') {
        import('node:fs').then(({ chmodSync }) => { chmodSync(file, 0o600) }).catch(() => {})
      }
    } catch {}
  }

  const located = (() => {
    try { return locate('dsh-bili-whale', { home, profile }) } catch { return { found: false, path: '' } }
  })()
  const installed = !!(located && located.found)

  async function sync() {
    if (!installed) {
      const error = '未安装 dsh-bili-whale'
      try { logger?.warn?.(`fish-world: B 站人设同步跳过：${error}`) } catch {}
      return { ok: false, error }
    }
    const text = currentText()
    if (!text) {
      try { logger?.warn?.('fish-world: B 站人设同步跳过：当前人设内容为空') } catch {}
      return { ok: false, error: '当前人设内容为空' }
    }
    ensureDir()
    try {
      writeFileSync(targetFile, text, 'utf8')
      safeChmod(targetFile)
      return {
        ok: true,
        bytes: Buffer.byteLength(text),
        path: targetFile,
        at: new Date().toISOString(),
      }
    } catch (error) {
      try { logger?.warn?.(`fish-world: B 站人设同步失败：${error?.message || error}`) } catch {}
      return { ok: false, error: String(error?.message || error) }
    }
  }

  function status() {
    const target = readTarget()
    const source = currentText()
    const sameAsCurrent = target === source && !!source
    let syncedAt = ''
    try {
      if (existsSync(targetFile)) syncedAt = new Date(statSync(targetFile).mtimeMs).toISOString()
    } catch {}
    return {
      installed,
      syncedAt,
      bytes: Buffer.byteLength(target),
      sameAsCurrent,
      targetFile,
    }
  }

  return { sync, status, installed }
}
