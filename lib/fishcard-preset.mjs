// 鱼卡 v3 两层存储（2026-11-23 施工单 §2.2）。
//
// ```
// 预设库    <家>/人设预设/<preset>.md      可攒一堆，没人用就不占上下文
//    │  应用（拷贝一份，记来源 preset id + 版本哈希）
//    ▼
// 角色人设  <家>/鱼/<角色>/.当前人设.md     这个角色现在在用的那份
// ```
//
// ── ★ <家> 是哪、和现有 fish-world-personas/ 什么关系（主人没答，我按并存做）──
// 施工单画的是 `<家>/鱼/<角色>/.当前人设.md`，但现有生产在用的是
// `$DSH_HOME/fish-world-personas/<roleId>.md`（default.md 3212 字，就是那张卡）。
// **两个解读**：A 迁移（搬进新结构、旧位置废弃）／ B 并存（旧位置继续当角色人设，
// 只新增预设库）。
// 我按 **B** 做：**不碰生产在用的那份** —— 迁移要动它、风险大且主人没明说；
// B 只新增 `人设预设/`，旧路径一字不动（`发给AI.md` 硬要求「旧卡逐字节不变」）。
// 若主人本意是 A，这里改一个常量就能换过去（见 ROLE_DIR_FALLBACK）。
//
// ── 快照不是引用（§2.2）──
// 应用时**拷贝**：之后改预设不影响已应用的角色；要生效得「重新应用」（带 diff 预览）。
// 来源记在**卡自己的 front-matter** 里（`preset` / `version` + 版本哈希）——
// §2.1 的 front-matter 本来就有 `preset:` 与 `version:`，不另开 sidecar 文件。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 预设库目录名（相对 `<家>`）。 */
export const PRESET_FOLDER = '人设预设'

/**
 * 角色人设落点：**沿用现有位置** `$DSH_HOME/fish-world-personas/<roleId>.md`（解读 B）。
 * 若主人改选解读 A，把这里换成 `<世界根>/鱼/<角色>/.当前人设.md` 即可，其余不动。
 */
export function roleCardFile(personaRoot, roleId) {
  return join(String(personaRoot), `${String(roleId || 'default')}.md`)
}

/** 预设文件路径。 */
export function presetFile(home, preset) {
  return join(String(home), PRESET_FOLDER, `${String(preset)}.md`)
}

/** 一段文本的内容哈希（§2.2「版本哈希」——改一个字就变，能判断该不该重应用）。 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/** 从卡的 front-matter 里取 `preset` / `version`（取不到给空）。 */
export function presetMeta(text) {
  const s = String(text || '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(s)
  if (!m) return { preset: '', version: '', hash: contentHash(s) }
  const get = (k) => {
    const r = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1])
    return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : ''
  }
  return { preset: get('preset'), version: get('version'), hash: contentHash(s) }
}

/**
 * 列出预设库里的卡（文件名即 preset id）。
 * @returns {Array<{preset:string, file:string, size:number, mtime:number, meta:object}>}
 */
export function listPresets(home) {
  const dir = join(String(home), PRESET_FOLDER)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => {
      const file = join(dir, n)
      const text = readFileSync(file, 'utf8')
      const st = statSync(file)
      return { preset: n.slice(0, -3), file, size: st.size, mtime: st.mtimeMs, meta: presetMeta(text) }
    })
    .sort((a, b) => a.preset.localeCompare(b.preset))
}

/**
 * 应用一个预设到某个角色（**快照：拷贝**，不是引用）。
 *
 * @param {object} o
 * @param {string} o.home       世界根（预设库所在）
 * @param {string} o.preset     预设 id（= 文件名，不含 .md）
 * @param {string} o.personaRoot 角色人设目录（现有 `fish-world-personas`）
 * @param {string} [o.roleId]   目标角色（默认 `default`）
 * @param {boolean} [o.dryRun]  只看 diff 不落盘（§2.2「重新应用要带 diff 预览」）
 * @returns {{ok:boolean, file:string, created:boolean, dryRun:boolean,
 *            before:{preset:string,version:string,hash:string}|null,
 *            after:{preset:string,version:string,hash:string},
 *            diff:{changed:boolean, lines:{add:string[],del:string[]}}, error?:string}}
 */
export function applyPreset({ home, preset, personaRoot, roleId = 'default', dryRun = false } = {}) {
  if (!home || !preset) return { ok: false, file: '', created: false, dryRun: !!dryRun, before: null, after: null, diff: { changed: false, lines: { add: [], del: [] } }, error: '要给 home 与 preset' }
  if (!personaRoot) return { ok: false, file: '', created: false, dryRun: !!dryRun, before: null, after: null, diff: { changed: false, lines: { add: [], del: [] } }, error: '要给 personaRoot（角色人设目录）' }

  const src = presetFile(home, preset)
  if (!existsSync(src)) {
    return { ok: false, file: '', created: false, dryRun: !!dryRun, before: null, after: null, diff: { changed: false, lines: { add: [], del: [] } }, error: `预设不存在：${preset}` }
  }

  const next = readFileSync(src, 'utf8')
  const dst = roleCardFile(personaRoot, roleId)
  const exists = existsSync(dst)
  const prev = exists ? readFileSync(dst, 'utf8') : ''

  const before = exists ? presetMeta(prev) : null
  const after = presetMeta(next)
  const diff = diffLines(prev, next)

  // ★ 快照不是引用：整份拷贝（含 front-matter 的 preset/version），之后改预设不影响这里
  if (!dryRun) {
    try {
      mkdirSync(personaRoot, { recursive: true })
      writeFileSync(dst, next, 'utf8')
    } catch (e) {
      return { ok: false, file: dst, created: false, dryRun: false, before, after, diff, error: `写入失败：${e.message}` }
    }
  }

  return { ok: true, file: dst, created: !exists, dryRun: !!dryRun, before, after, diff }
}

/**
 * 重新应用前的 diff 预览（§2.2：「要生效得重应用（带 diff 预览）」）。
 * 只算不写 —— 调用方拿 `diff.changed` 决定要不要真应用。
 */
export function previewApply({ home, preset, personaRoot, roleId = 'default' } = {}) {
  return applyPreset({ home, preset, personaRoot, roleId, dryRun: true })
}

/** 行级 diff（够面板显示「改了哪几行」，不引 diff 库）。 */
function diffLines(a, b) {
  const A = String(a || '').split('\n')
  const B = String(b || '').split('\n')
  const setA = new Set(A)
  const setB = new Set(B)
  const del = A.filter((l) => !setB.has(l))
  const add = B.filter((l) => !setA.has(l))
  return { changed: del.length > 0 || add.length > 0, lines: { add, del } }
}
