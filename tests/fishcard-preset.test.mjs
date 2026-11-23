// 鱼卡 v3 两层存储判据（施工单 §2.2 + 判据 #8/#9）。
//
// ★ 全部用 tmpdir（AGENTS 6.3：测试不许依赖本机状态）—— 不碰真实的
//   `fish-world-personas/`（生产在用的 default.md 就在那里）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PRESET_FOLDER, roleCardFile, presetFile, contentHash, presetMeta,
  listPresets, applyPreset, previewApply,
} from '../lib/fishcard-preset.mjs'

const PRESET_CARD = [
  '---', 'fishcard: 3', 'preset: 小鲸鱼', 'version: 3', '---', '',
  '### 【常驻】你是谁', '我是小鲸鱼。', '',
].join('\n')

function mkWorld() {
  const home = mkdtempSync(join(tmpdir(), 'fcp-'))
  mkdirSync(join(home, PRESET_FOLDER), { recursive: true })
  const personaRoot = join(home, 'personas')
  mkdirSync(personaRoot, { recursive: true })
  return { home, personaRoot }
}

test('★ listPresets：预设库列得出来（文件名即 preset id）', () => {
  const { home } = mkWorld()
  assert.deepEqual(listPresets(home), [], '★ 空库给空数组，不炸')
  writeFileSync(presetFile(home, '小鲸鱼'), PRESET_CARD, 'utf8')
  writeFileSync(presetFile(home, '另一个'), '---\npreset: 另一个\n---\n\n正文\n', 'utf8')

  const list = listPresets(home)
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((p) => p.preset), ['另一个', '小鲸鱼'], '★ 按名字排')
  assert.equal(list[1].meta.preset, '小鲸鱼', '★ 能读出 front-matter 的 preset')
  assert.equal(list[1].meta.version, '3')
  assert.ok(list[1].meta.hash, '★ 带内容哈希（判断该不该重应用）')
})

test('★★ 判据#9：快照不是引用——改预设不影响已应用的角色', () => {
  const { home, personaRoot } = mkWorld()
  writeFileSync(presetFile(home, '小鲸鱼'), PRESET_CARD, 'utf8')

  const r = applyPreset({ home, preset: '小鲸鱼', personaRoot, roleId: 'whale' })
  assert.equal(r.ok, true)
  assert.equal(r.created, true, '★ 新角色是新建')
  assert.equal(readFileSync(r.file, 'utf8'), PRESET_CARD, '★ 整份拷贝（含 front-matter）')

  // ★ 改预设库里的卡 —— 已应用的角色必须**逐字节不变**
  writeFileSync(presetFile(home, '小鲸鱼'), PRESET_CARD + '改了新的一行\n', 'utf8')
  assert.equal(readFileSync(r.file, 'utf8'), PRESET_CARD, '★★ 改预设后角色卡一字没动（快照生效）')

  // 重新应用才生效
  const r2 = applyPreset({ home, preset: '小鲸鱼', personaRoot, roleId: 'whale' })
  assert.equal(r2.created, false, '★ 是覆盖不是新建')
  assert.equal(r2.before.hash !== r2.after.hash, true, '★ before/after 哈希不同（能判断要重应用）')
  assert.ok(readFileSync(r.file, 'utf8').includes('改了新的一行'))
})

test('★★ 判据#8：应用到已有角色 —— 家目录 mtime 不变（只换人设，家不动）', () => {
  const { home, personaRoot } = mkWorld()
  writeFileSync(presetFile(home, '小鲸鱼'), PRESET_CARD, 'utf8')

  // 造一个「家」（记忆/日记/成长所在），记 mtime
  const homeDir = join(home, '鱼的成长')
  mkdirSync(homeDir, { recursive: true })
  const keep = join(homeDir, 'keep.txt')
  writeFileSync(keep, '旧数据', 'utf8')
  const old = new Date(Date.now() - 60000)
  utimesSync(keep, old, old)
  const mtimeBefore = statSync(keep).mtimeMs

  applyPreset({ home, preset: '小鲸鱼', personaRoot, roleId: 'whale' })

  assert.equal(statSync(keep).mtimeMs, mtimeBefore, '★★ 家目录里的文件 mtime 一字没动（只换人设）')
  assert.equal(readFileSync(keep, 'utf8'), '旧数据', '★ 家里数据没被碰')
})

test('★★ 判据#8：应用到新角色 —— 旧角色文件一份没动', () => {
  const { home, personaRoot } = mkWorld()
  writeFileSync(presetFile(home, '小鲸鱼'), PRESET_CARD, 'utf8')
  writeFileSync(presetFile(home, '另一个'), '---\npreset: 另一个\n---\n\n别人的卡\n', 'utf8')

  // 旧角色先在用
  const oldCard = roleCardFile(personaRoot, 'default')
  writeFileSync(oldCard, '---\npreset: 旧\n---\n\n旧角色的卡\n', 'utf8')
  const oldBefore = readFileSync(oldCard, 'utf8')

  const r = applyPreset({ home, preset: '小鲸鱼', personaRoot, roleId: 'whale' })
  assert.equal(r.created, true, '★ 新角色是新建')
  assert.equal(readFileSync(oldCard, 'utf8'), oldBefore, '★★ 旧角色的卡一份没动')
  assert.equal(existsSync(roleCardFile(personaRoot, 'whale')), true)
})

test('★ presetMeta：读 front-matter 的 preset/version + 内容哈希；没 front-matter 也给哈希', () => {
  const m = presetMeta(PRESET_CARD)
  assert.equal(m.preset, '小鲸鱼')
  assert.equal(m.version, '3')
  assert.equal(m.hash, contentHash(PRESET_CARD), '★ 哈希按全文算（改一个字就变）')

  const plain = presetMeta('没有 front-matter 的旧卡')
  assert.equal(plain.preset, '')
  assert.ok(plain.hash, '★ 旧卡也要有哈希（能比对）')
  assert.notEqual(plain.hash, contentHash(PRESET_CARD))
})

test('★ previewApply / dryRun：只看 diff 不落盘（§2.2「重应用要带 diff 预览」）', () => {
  const { home, personaRoot } = mkWorld()
  writeFileSync(presetFile(home, '小鲸鱼'), PRESET_CARD, 'utf8')
  const dst = roleCardFile(personaRoot, 'default')
  writeFileSync(dst, '---\npreset: 旧\n---\n\n旧的\n', 'utf8')
  const before = readFileSync(dst, 'utf8')

  const p = previewApply({ home, preset: '小鲸鱼', personaRoot })
  assert.equal(p.ok, true)
  assert.equal(p.dryRun, true)
  assert.equal(p.diff.changed, true, '★ 内容不同要报 changed')
  assert.ok(p.diff.lines.add.length > 0 && p.diff.lines.del.length > 0, '★ 加了哪些、删了哪些都要列出')
  assert.equal(readFileSync(dst, 'utf8'), before, '★★ dryRun 一个字都不落盘')
})

test('★ 边界：预设不存在 / 缺参数 → ok:false 且带原因（不炸、不静默）', () => {
  const { home, personaRoot } = mkWorld()
  const miss = applyPreset({ home, preset: '不存在的', personaRoot })
  assert.equal(miss.ok, false)
  assert.match(miss.error, /预设不存在/)

  const noHome = applyPreset({ preset: 'x', personaRoot })
  assert.equal(noHome.ok, false)
  assert.match(noHome.error, /home/)

  const noRoot = applyPreset({ home, preset: 'x' })
  assert.equal(noRoot.ok, false)
  assert.match(noRoot.error, /personaRoot/)
})

// ══════════ 主人 2026-11-24 的三条「别这么做」 ══════════

test('★★ 判据3：apply 一份空卡 → 被拒绝，现值不变', () => {
  const { home, personaRoot } = mkWorld()
  writeFileSync(presetFile(home, '好卡'), PRESET_CARD, 'utf8')
  // 先应用一份好的，拿到「现值」
  const ok1 = applyPreset({ home, preset: '好卡', personaRoot, roleId: 'r' })
  assert.equal(ok1.ok, true)
  const nowValue = readFileSync(roleCardFile(personaRoot, 'r'), 'utf8')

  // 换成空卡再 apply → 必须拒绝
  writeFileSync(presetFile(home, '好卡'), '   \n\n  ', 'utf8')
  const r = applyPreset({ home, preset: '好卡', personaRoot, roleId: 'r' })
  assert.equal(r.ok, false, '★★ 空卡必须被拒绝（宁可拒绝，不写半份）')
  assert.match(r.error, /空的|解析不出/)

  // ★ 现值一个字节没变
  assert.equal(readFileSync(roleCardFile(personaRoot, 'r'), 'utf8'), nowValue, '★★ 拒绝后现值不变')

  // 解析不出内容的卡（只有空节头、没有正文）也拒绝
  writeFileSync(presetFile(home, '好卡'), '---\nfishcard: 3\n---\n\n### 【常驻】空的\n\n', 'utf8')
  const r2 = applyPreset({ home, preset: '好卡', personaRoot, roleId: 'r' })
  assert.equal(r2.ok, false, '★ 只有节头没有正文 → 也算「解析不出内容」')
  assert.equal(readFileSync(roleCardFile(personaRoot, 'r'), 'utf8'), nowValue, '★ 现值仍不变')
})

test('★★ 「别这么做①」：写生产卡前必须先备份（.bak-before-apply-*）', () => {
  const { home, personaRoot } = mkWorld()
  writeFileSync(presetFile(home, 'p'), PRESET_CARD, 'utf8')

  // 第一次：新角色，没有旧文件 → 无需备份，created=true
  const first = applyPreset({ home, preset: 'p', personaRoot, roleId: 'r2' })
  assert.equal(first.created, true)
  assert.equal(readdirSync(personaRoot).filter((n) => n.includes('.bak-before-apply-')).length, 0, '★ 第一次创建不备份（没有旧的）')

  // 第二次：已有卡 → 覆盖前必须留备份
  writeFileSync(presetFile(home, 'p'), PRESET_CARD + '第二版\n', 'utf8')
  const second = applyPreset({ home, preset: 'p', personaRoot, roleId: 'r2' })
  assert.equal(second.ok, true)
  const baks = readdirSync(personaRoot).filter((n) => n.includes('.bak-before-apply-'))
  assert.equal(baks.length, 1, '★★ 覆盖生产卡前必须留一份备份')
  // 备份里是**旧值**（第一版），不是新值
  const bakContent = readFileSync(join(personaRoot, baks[0]), 'utf8')
  assert.equal(bakContent.includes('第二版'), false, '★★ 备份的是覆盖前的旧内容')
  assert.equal(bakContent, first.ok ? readFileSync(roleCardFile(personaRoot, 'r2'), 'utf8').replace('第二版\n', '') : '', '（对照）')
})

test('★ 「别这么做③」：apply 前能看 diff（preview 不落盘）', () => {
  const { home, personaRoot } = mkWorld()
  writeFileSync(presetFile(home, 'p'), PRESET_CARD, 'utf8')
  writeFileSync(roleCardFile(personaRoot, 'r'), '旧的卡\n', 'utf8')
  const before = readFileSync(roleCardFile(personaRoot, 'r'), 'utf8')

  const preview = previewApply({ home, preset: 'p', personaRoot, roleId: 'r' })
  assert.equal(preview.dryRun, true, '★ preview 是 dryRun')
  assert.equal(preview.diff.changed, true, '★ 要能看出「会变什么」')
  assert.ok(preview.diff.lines.add.length > 0 && preview.diff.lines.del.length > 0, '★ 加了哪些/删了哪些都列出')
  assert.equal(readFileSync(roleCardFile(personaRoot, 'r'), 'utf8'), before, '★★ preview 一个字都不落盘')
})
