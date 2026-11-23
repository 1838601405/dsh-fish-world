// 鱼卡 v3 两层存储（2026-11-23 施工单 §2.2）。
//
// ```
// 预设库    <家>/人设预设/<preset>.md      可攒一堆，没人用就不占上下文
//    │  应用（拷贝一份，记来源 preset id + 版本哈希）
//    ▼
// 角色人设  <家>/鱼/<角色>/.当前人设.md     这个角色现在在用的那份
// ```
//
// ── ★ `<家>` 是哪（主人 2026-11-24 明确）──
// `<家>` = **`DSH_HOME`**（`D:\DSH-home`），因为「应用」的落点 `fish-world-personas/`
// 就在那里 —— 预设库必须与它同级，否则就是两棵树：
//   预设库    `$DSH_HOME/人设预设/<preset>.md`          ← 卡的**资产**（源）
//      │  应用（整份拷贝 + 记来源 preset id / version / 内容哈希）
//      ▼
//   角色人设  `$DSH_HOME/fish-world-personas/<roleId>.md` ← 当前**应用结果**（生产在用）
// （我上轮曾把预设库建在世界根 `鱼的世界/人设预设/` —— 主人指出 DSH-home 下没有，
//   两份并存必漂移 ⇒ 2026-11-24 已挪到 DSH-home 并删掉世界根那份。）
//
// ── 快照不是引用（§2.2）──
// 应用时**拷贝**：之后改预设不影响已应用的角色；要生效得「重新应用」（带 diff 预览）。
// 来源记在**卡自己的 front-matter** 里（`preset` / `version` + 版本哈希）——
// §2.1 的 front-matter 本来就有 `preset:` 与 `version:`，不另开 sidecar 文件。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseCard } from './fishcard.mjs'

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

  // ★ 「别这么做」②：**别允许把一份空卡或解析失败的卡 apply 进去 —— 宁可拒绝，不要写半份。**
  //   两层校验：① 全空白；② 解析出来**一条有内容的节都没有**（文件损坏/只有一堆空节头）。
  if (!String(next).trim()) {
    return { ok: false, file: '', created: false, dryRun: !!dryRun, before: null, after: null, diff: { changed: false, lines: { add: [], del: [] } }, error: '预设是空的，拒绝 apply（不写半份）' }
  }
  const probe = parseCard(next)
  const hasContent = Array.isArray(probe.sections) && probe.sections.some((s) => String(s?.body || '').trim() !== '')
  if (!hasContent) {
    return { ok: false, file: '', created: false, dryRun: !!dryRun, before: null, after: null, diff: { changed: false, lines: { add: [], del: [] } }, error: '预设解析不出任何内容（可能损坏），拒绝 apply' }
  }

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
      // ★ 「别这么做」①：**别在没有 apply 前备份的情况下写 `fish-world-personas/`**。
      //   覆盖生产卡是不可逆动作 —— 先落一份 `.bak-before-apply-<时间>`，失败也能回滚。
      //   （新角色第一次创建没有旧文件，无需备份。）
      if (exists) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        copyFileSync(dst, `${dst}.bak-before-apply-${stamp}`)
      }
      writeFileSync(dst, next, 'utf8')
      // ★ 记来源（施工单 §2.2「记来源 preset id + 版本哈希」+ 主人 2026-11-24
      //   「面板上加一行：当前人设来自[哪个预设 / 哪个版本 / 什么时候应用的]」）。
      //   写 **sidecar**（`<role>.applied.json`）而不是改卡 —— 卡是主人定的字，别动它；
      //   front-matter 里的 `preset`/`version` 是卡自带的（资产元数据），
      //   「**什么时候应用的**」只有这次动作知道，必须由 applyPreset 记。
      try {
        writeFileSync(`${dst}.applied.json`, JSON.stringify({
          preset: String(preset),
          version: String(after.version || ''),
          hash: String(after.hash || ''),        // 应用时的内容哈希（版本指纹）
          appliedAt: new Date().toISOString(),
        }, null, 2), 'utf8')
      } catch { /* 记来源失败不影响卡已落盘 —— 面板那一行显示不出来而已 */ }
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

/**
 * 读「当前人设来自哪」——面板那一行的数据源。
 *
 * 主人 2026-11-24：「面板上加一行：当前人设来自[哪个预设 / 哪个版本 / 什么时候应用的]。
 * 不然后面『我改了预设怎么没生效』会天天出现。」
 *
 * @param {string} personaRoot `fish-world-personas` 目录
 * @param {string} roleId      角色 id（默认 default）
 * @returns {{preset:string, version:string, hash:string, appliedAt:string, source:string}|null}
 *   没有 sidecar（手工改过卡 / 旧数据）⇒ `null`，面板那行显示「来源未记录」
 */
export function readApplied(personaRoot, roleId = 'default') {
  try {
    const file = `${roleCardFile(personaRoot, roleId)}.applied.json`
    if (!existsSync(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (!j || typeof j !== 'object') return null
    return {
      preset: String(j.preset || ''),
      version: String(j.version || ''),
      hash: String(j.hash || ''),
      appliedAt: String(j.appliedAt || ''),
      source: `${j.preset || '?'}${j.version ? ` v${j.version}` : ''} @ ${j.appliedAt || '?'}`,
    }
  } catch {
    return null
  }
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
