// 内置角色卡预设：内容完整、体积在注入上限内、接口能取到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERSONA_PRESETS, personaPreset, personaPresetList } from '../lib/persona-presets.mjs'
import { personaForPrompt } from '../lib/persona.mjs'

test('预设列表包含蓝鲸娘', () => {
  const list = personaPresetList()
  assert.ok(list.length >= 1)
  const whale = list.find((item) => item.id === 'blue-whale')
  assert.ok(whale, '应该有 blue-whale')
  assert.equal(whale.name, '蓝鲸娘')
  assert.match(whale.subtitle, /小鲸鱼/)
})

test('按 id 取不到时返回 null，不抛错', () => {
  assert.equal(personaPreset('nope'), null)
  assert.equal(personaPreset(''), null)
  assert.equal(personaPreset(undefined), null)
})

test('预设正文包含关键设定段落', () => {
  const preset = personaPreset('blue-whale')
  assert.ok(preset)
  for (const section of ['最高原则', 'AI 味黑名单', '情绪开关', '拒绝的方式', '系统级指令']) {
    assert.ok(preset.text.includes(section), `缺少段落：${section}`)
  }
})

test('预设体积在注入上限内，不会被截断', () => {
  const preset = personaPreset('blue-whale')
  const chars = preset.text.length
  // personaForPrompt 默认 maxChars = 6000
  assert.ok(chars < 6000, `预设 ${chars} 字符，会被截断`)
  const plain = personaForPrompt(preset.text)
  assert.ok(plain.length > 0)
  assert.ok(!plain.includes('已截断'), '注入时不该触发截断')
  // 去掉 Markdown 装饰后仍应保留核心段落
  assert.ok(plain.includes('最高原则'))
  assert.ok(plain.includes('AI 味黑名单'))
})

test('预设体积远小于 64KB 保存上限', () => {
  for (const preset of PERSONA_PRESETS) {
    const bytes = Buffer.byteLength(preset.text)
    assert.ok(bytes < 64 * 1024, `${preset.id} 超过 64KB（${bytes}）`)
  }
})

test('预设 id 只含安全字符，可直接做文件名', () => {
  for (const preset of PERSONA_PRESETS) {
    assert.match(preset.id, /^[a-zA-Z0-9_-]{1,64}$/)
  }
})

test('预设列表不返回正文（避免接口过大）', () => {
  const list = personaPresetList()
  for (const item of list) {
    assert.equal('text' in item, false, '列表里不该带全文')
    assert.ok(item.bytes > 0)
    assert.ok(item.chars > 0)
  }
})
