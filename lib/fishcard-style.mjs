// 鱼卡 v3 风格层（2026-11-23 主人规格 §4）。
//
// ── 它和内容层的关系 ──
// 规格 §4：「内容层不压。风格单独写，每个场景一份，按场景选一份注入。」
// 所以这一层**只管怎么出去**（长度/标点/策略），不管说什么 —— 说什么在常驻与条件档里。
//
// ── 为什么输入是「场景」而不是 `when` ──
// 规格 §4 写的是「按 when 选一份」，但 §3 的 when 表里**没有 panel**
// （只有 group/private/owner/at-me/named/quoted/attachment/cold-start）。
// 而 §4 的表格明明有三列：群聊 / 私聊 / 面板。⇒ 面板不是 QQ 场景，没有对应的 when。
// 所以这里按**场景**选，`when` 留给内容档：
//   kind==='group'   → 群聊
//   kind==='private' → 私聊
//   其它（面板 / DSH 会话 / 没有 kind）→ 面板（默认，规格把面板当正常句子的基准）
//
// ── 文本存哪（规格没明说，这是我的解读，已标注给主人）──
// 规格 §1 要求「存储不动：`fish-world-personas/` 一个文件族，不新建第五个存储」，
// §2 又说「只有三种节头」—— 风格既进不了三档、也不该另开一个存储目录树。
// ⇒ 解读：放在**同一个文件族里**的子目录 `<家>/风格/<场景>.md`，
//   它是文件不是新存储（和 `default.md` 平级的一种）；不存在就当没有风格层，
//   装配退化成「只注入内容」——**默认行为逐字节不变**（M6：默认关的不改既有输出）。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 三个场景名（也是文件名）。 */
export const SCENES = ['群聊', '私聊', '面板']

/** 风格文件所在子目录名（相对 `<家>/fish-world-personas/`）。 */
export const STYLE_FOLDER = '风格'

/**
 * 这一轮该用哪份风格。
 *
 * @param {object} [facts] 已判定的事实（同 fishcard-select 的 facts）
 * @returns {'群聊'|'私聊'|'面板'}
 */
export function pickStyle(facts = {}) {
  const kind = String((facts && facts.kind) || '')
  if (kind === 'group') return '群聊'
  if (kind === 'private') return '私聊'
  return '面板'
}

/**
 * 某个场景的风格文件路径。
 *
 * @param {string} home 人设根（`$DSH-home/fish-world-personas`）
 * @param {string} [scene] 不给就按 facts 选
 * @param {object} [facts]
 * @returns {string}
 */
export function styleFile(home, scene, facts) {
  const s = SCENES.includes(String(scene)) ? String(scene) : pickStyle(facts)
  return join(String(home), STYLE_FOLDER, `${s}.md`)
}

/**
 * 读一份风格文本。
 *
 * @param {object} opts
 * @param {string} opts.home 人设根
 * @param {string} [opts.scene] 不给就按 facts 选
 * @param {object} [opts.facts]
 * @returns {{scene:string, text:string}|null}
 *   文件不存在 / 读不了 ⇒ **null**（装配据此跳过风格层，行为与没有这层时一致）
 *   读到 ⇒ 原样返回（**不 trim、不截断** —— 一个字都不改，才谈得上验收 #9 的长度统计）
 */
export function loadStyle({ home, scene, facts } = {}) {
  if (!home) return null
  const file = styleFile(home, scene, facts)
  if (!existsSync(file)) return null
  try {
    let text = readFileSync(file, 'utf8')
    // ★ 剥前导 BOM —— 它是**编码标记不是内容**，留着会脏了注入 prompt 的第一行
    //   （实测：Windows 记事本 / PowerShell `Set-Content -Encoding UTF8` 存出来都带 BOM，
    //    读出来是 `﻿我在群里…`，那个不可见字符会跟着进上下文）。
    //   剥它不违反「原样返回」—— 原样指的是写卡的人写的内容，不是字节序标记。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    // 空文件当没有（别注入一个空段，装配会平白多出一节）
    if (!text.trim()) return null
    return { scene: SCENES.includes(String(scene)) ? String(scene) : pickStyle(facts), text }
  } catch {
    return null
  }
}
