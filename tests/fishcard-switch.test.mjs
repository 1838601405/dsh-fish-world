// 条件档开关判据（酒馆做法三 + 主人 2026-11-24 判据）：
//   「关掉一条条件档，卡文件逐字节不变，重新打开后行为与关之前一致。」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readSwitches, setConditionEnabled, applySwitches, disabledList } from '../lib/fishcard-switch.mjs'
import { assemblePrompt } from '../lib/fishcard-assemble.mjs'

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const CARD = [
  '---', 'fishcard: 3', 'preset: default', '---', '',
  '### 【常驻】你是谁', '我是小鲸鱼。', '',
  '### 【条件 keys=白饭】白饭档', '主食白饭。', '',
  '### 【条件 when=group】群里', '群里的样子。', '',
].join('\n')

function mk() {
  const root = mkdtempSync(join(tmpdir(), 'fsw-'))
  const personaRoot = join(root, 'personas')
  mkdirSync(personaRoot, { recursive: true })
  const cardFile = join(personaRoot, 'default.md')
  writeFileSync(cardFile, CARD, 'utf8')
  return { root, personaRoot, cardFile }
}

test('★★ 判据：关掉一条 → 卡文件逐字节不变（sha 不变）', () => {
  const { personaRoot, cardFile } = mk()
  const before = sha(cardFile)

  const r = setConditionEnabled({ personaRoot, title: '白饭档', enabled: false })
  assert.equal(r.ok, true)
  assert.ok(r.disabled.includes('白饭档'))

  assert.equal(sha(cardFile), before, '★★ 卡文件 sha 一个字节都没变')
  // 开关写在 sidecar，不在卡里
  assert.equal(readFileSync(cardFile, 'utf8').includes('switches'), false, '★ 卡里没有开关痕迹')
  assert.ok(existsSync(join(personaRoot, 'default.md.switches.json')), '★ 开关在 sidecar')
})

test('★★ 判据：关掉 → 该档不进 prompt；重新打开 → 与关之前**完全一致**', () => {
  const { personaRoot } = mk()
  const facts = { kind: 'group', text: '来份白饭' }
  const base = { name: '小鲸鱼', card: CARD, round: 1, facts }

  // 关之前
  const before = assemblePrompt({ ...base })
  assert.ok(before.text.includes('主食白饭'), '前提：关之前该档在')

  // 关掉
  setConditionEnabled({ personaRoot, title: '白饭档', enabled: false })
  const switches = readSwitches(personaRoot)
  const off = assemblePrompt({ ...base, switches })
  assert.equal(off.text.includes('主食白饭'), false, '★★ 关掉后该档不进 prompt')
  assert.ok(off.text.includes('我是小鲸鱼'), '★ 常驻不受影响（只关这一条）')
  assert.ok(off.warnings.some((w) => w.includes('条件档已关闭')), '★ 要报一条（不静默）')

  // 重新打开 → 与关之前**逐字节一致**
  setConditionEnabled({ personaRoot, title: '白饭档', enabled: true })
  const after = assemblePrompt({ ...base, switches: readSwitches(personaRoot) })
  assert.equal(after.text, before.text, '★★ 重新打开后行为与关之前一致（逐字节）')
  assert.deepEqual(after.warnings, before.warnings)
})

test('★ 关一条不影响另一条 + 只关选中的那条', () => {
  const { personaRoot } = mk()
  setConditionEnabled({ personaRoot, title: '白饭档', enabled: false })

  const r = assemblePrompt({
    name: '小鲸鱼', card: CARD, round: 1,
    facts: { kind: 'group', text: '来份白饭' },
    switches: readSwitches(personaRoot),
  })
  assert.equal(r.text.includes('主食白饭'), false, '★ 被关的不在')
  assert.equal(r.text.includes('群里的样子'), true, '★ 没关的还在（when=group 命中）')
})

test('★ 开关可逆：关了再开，disabled 列表回到空', () => {
  const { personaRoot } = mk()
  setConditionEnabled({ personaRoot, title: 'A', enabled: false })
  setConditionEnabled({ personaRoot, title: 'B', enabled: false })
  assert.deepEqual(disabledList(personaRoot).sort(), ['A', 'B'])

  setConditionEnabled({ personaRoot, title: 'A', enabled: true })
  assert.deepEqual(disabledList(personaRoot), ['B'], '★ 只开 A，B 还关着')

  setConditionEnabled({ personaRoot, title: 'B', enabled: true })
  assert.deepEqual(disabledList(personaRoot), [], '★ 全开 → 空')
})

test('★ 边界：缺参数 / 坏开关文件 / 标题不在卡里', () => {
  const { personaRoot } = mk()
  assert.equal(setConditionEnabled({ title: 'x' }).ok, false, '★ 缺 personaRoot')
  assert.equal(setConditionEnabled({ personaRoot }).ok, false, '★ 缺 title')

  // 坏开关文件 → 当没关（不吞内容、不炸）
  writeFileSync(join(personaRoot, 'default.md.switches.json'), '{不是 json', 'utf8')
  assert.deepEqual(readSwitches(personaRoot).disabled, [], '★ 坏文件当空')
  const r = setConditionEnabled({ personaRoot, title: 'x', enabled: false })
  assert.equal(r.ok, true, '★ 坏文件能被覆盖修好')

  // 标题不在卡里也能记（开关是独立状态，不校验卡内容）
  const r2 = setConditionEnabled({ personaRoot, title: '不存在的档', enabled: false })
  assert.equal(r2.ok, true)
})

test('★ applySwitches：没开关时原样返回（不改入参）', () => {
  const secs = [{ tier: '条件', title: 'A', body: 'x' }, { tier: '条件', title: 'B', body: 'y' }]
  const r1 = applySwitches(secs, { disabled: [] })
  assert.equal(r1.kept.length, 2)
  assert.deepEqual(r1.off, [])

  const r2 = applySwitches(secs, undefined)
  assert.equal(r2.kept.length, 2, '★ 没给开关原样')

  const r3 = applySwitches(secs, { disabled: ['A'] })
  assert.deepEqual(r3.kept.map((s) => s.title), ['B'])
  assert.deepEqual(r3.off, ['A'])
})
