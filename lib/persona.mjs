// 人设卡：鱼的语言风格与性格设定。
//
// 与 dsh-whale-widget 的分工：
//  - whale 的 roles.json 只管「名字 + 角色图片 + 置顶」，格式由挂件自己决定；
//  - 人设文本（说话方式、铁律、语料）体积大且需要被提示词直接读取，所以单独
//    存在鱼世界自己的目录里，按角色 id 对应。
//
// 落盘：$DSH_HOME/fish-world-personas/<roleId>.md
// 这样换角色卡=换角色 id，人设文本随之切换，不需要改 whale 的数据。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './paths.mjs'

export const PERSONA_DIR = join(DSH_HOME, 'fish-world-personas')
const MAX_PERSONA_BYTES = 64 * 1024
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/

function safeRoleId(value) {
  const id = String(value || '').trim()
  return SAFE_ID.test(id) ? id : ''
}

export function createPersonaStore({ home = DSH_HOME } = {}) {
  const dir = home === DSH_HOME ? PERSONA_DIR : join(home, 'fish-world-personas')

  function ensureDir() {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function fileFor(roleId) {
    const id = safeRoleId(roleId)
    if (!id) return ''
    return join(dir, `${id}.md`)
  }

  function get(roleId) {
    const file = fileFor(roleId)
    if (!file || !existsSync(file)) return null
    try {
      const text = readFileSync(file, 'utf8')
      return {
        roleId: safeRoleId(roleId),
        text,
        bytes: Buffer.byteLength(text),
      }
    } catch {
      return null
    }
  }

  function set(roleId, text) {
    const id = safeRoleId(roleId)
    if (!id) throw new Error('角色 id 只能包含字母、数字、下划线和短横线')
    const clean = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim()
    if (!clean) throw new Error('人设内容不能为空')
    if (Buffer.byteLength(clean) > MAX_PERSONA_BYTES) throw new Error('人设卡超过 64KB，请精简后再保存')
    ensureDir()
    writeFileSync(join(dir, `${id}.md`), clean + '\n', 'utf8')
    return { ok: true, roleId: id, bytes: Buffer.byteLength(clean) }
  }

  function remove(roleId) {
    const file = fileFor(roleId)
    if (!file || !existsSync(file)) return { ok: false, error: '人设卡不存在' }
    try {
      writeFileSync(file, '', 'utf8')
      return { ok: true, roleId: safeRoleId(roleId) }
    } catch (error) {
      return { ok: false, error: String(error.message || error) }
    }
  }

  function list() {
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => {
          const roleId = name.slice(0, -3)
          const file = join(dir, name)
          let bytes = 0
          try { bytes = readFileSync(file).length } catch {}
          return { roleId, bytes }
        })
    } catch {
      return []
    }
  }

  return { dir: () => dir, get, set, remove, list }
}

// 去掉 Markdown 装饰，只留适合塞进提示词的纯文本。
export function personaForPrompt(text, { maxChars = 6000 } = {}) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return ''
  const plain = raw
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trimEnd())
    .filter((line, index, arr) => line.trim() || arr[index - 1]?.trim())
    .join('\n')
    .trim()
  return plain.length > maxChars ? plain.slice(0, maxChars) + '\n…（人设卡过长，已截断）' : plain
}
