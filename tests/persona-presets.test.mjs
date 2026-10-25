// 内置角色卡预设：列表只给元数据，正文只有一份（在 $DSH_HOME 的人设卡里）。
//
// 这里刻意不再断言「代码里有某段正文」——那正是这次要消掉的分叉：
// 预设一旦内置一份正文，就会和 fish-world-personas/default.md 各说各的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERSONA_PRESETS, personaPreset, personaPresetList } from '../lib/persona-presets.mjs'

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

test('蓝鲸娘是动态预设：代码里不留正文副本', () => {
  const preset = personaPreset('blue-whale')
  assert.ok(preset)
  assert.equal(preset.dynamic, true, '正文应该由后端读真实人设卡')
  assert.equal(preset.text, '', '代码里不该再存一份会分叉的正文')
  assert.ok(preset.summary.length > 0, '摘要仍要能给人看')
})

test('预设列表不返回正文（避免接口过大，也避免两处副本）', () => {
  const list = personaPresetList()
  for (const item of list) {
    assert.equal('text' in item, false, '列表里不该带全文')
    assert.ok(item.id && item.name)
  }
})

test('预设 id 只含安全字符，可直接做文件名', () => {
  for (const preset of PERSONA_PRESETS) {
    assert.match(preset.id, /^[a-zA-Z0-9_-]{1,64}$/)
  }
})

test('动态预设的正文由路由读当前人设卡，不在这里伪造', () => {
  // 这个测试守的是「契约」：动态预设的 text 必须为空，真正的正文来源只有
  // personaStore.get('default').text（见 lib/http.mjs 的 ?preset= 分支）。
  for (const preset of PERSONA_PRESETS) {
    if (!preset.dynamic) continue
    assert.equal(preset.text, '', `${preset.id} 是动态预设，不该内置正文`)
  }
})
