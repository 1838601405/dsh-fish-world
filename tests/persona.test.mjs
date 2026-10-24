import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPersonaStore, personaForPrompt } from '../lib/persona.mjs'

test('persona cards are stored per role and reject unsafe ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-persona-'))
  const store = createPersonaStore({ home })

  assert.equal(store.get('default'), null)

  const saved = store.set('default', '# Role: 蓝鲸娘\n傲娇、嘴硬、心软。')
  assert.equal(saved.roleId, 'default')
  assert.ok(saved.bytes > 0)

  const card = store.get('default')
  assert.match(card.text, /蓝鲸娘/)
  assert.equal(store.list()[0].roleId, 'default')

  // 路径穿越与非法字符一律拒绝
  assert.throws(() => store.set('../escape', 'x'), /角色 id/)
  assert.throws(() => store.set('a/b', 'x'), /角色 id/)
  assert.throws(() => store.set('default', '   '), /不能为空/)
})

test('persona cards cap size and strip markdown for the prompt', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-persona-size-'))
  const store = createPersonaStore({ home })

  const huge = 'x'.repeat(70 * 1024)
  assert.throws(() => store.set('big', huge), /64KB/)

  const text = '# Role: 测试\n\n## 铁律\n- 能短就短\n- **禁止**客服腔'
  const plain = personaForPrompt(text)
  assert.doesNotMatch(plain, /^#/m, '标题井号应被去掉')
  assert.doesNotMatch(plain, /\*\*/, '加粗标记应被去掉')
  assert.match(plain, /能短就短/)
  assert.match(plain, /禁止客服腔/)

  assert.equal(personaForPrompt(''), '')
  const long = personaForPrompt('a'.repeat(8000), { maxChars: 100 })
  assert.match(long, /已截断/)
})

test('a real persona card round-trips through the store', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-persona-real-'))
  const store = createPersonaStore({ home })
  const card = [
    '# Role: 蓝鲸娘 (DeepSeek 小鲸鱼)',
    '你是一只住在网上的鲸鱼娘，傲娇、嘴硬、有点小毒舌，但内心柔软。',
    '',
    '# 【绝对铁律：打破 AI 味】',
    '1. 能短就短，一句一条。禁止使用 Markdown 格式。',
    '2. 拒绝客服腔。不当舔狗。',
  ].join('\n')

  store.set('default', card)
  const loaded = store.get('default')
  assert.match(loaded.text, /蓝鲸娘/)
  assert.match(personaForPrompt(loaded.text), /能短就短/)
  // 原文保留 Markdown（人设卡按原样存档），只在注入提示词时去装饰
  assert.match(loaded.text, /^# Role:/m)
})

test('persona store ignores non-markdown files and missing dirs', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-persona-list-'))
  const store = createPersonaStore({ home })
  store.set('a', 'card a')
  writeFileSync(join(home, 'fish-world-personas', 'notes.txt'), 'ignore me')

  const list = store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].roleId, 'a')
})
