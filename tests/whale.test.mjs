import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfigStore } from '../lib/config.mjs'
import { createWhale } from '../lib/whale.mjs'

test('读取 whale 角色 / 余额 / 口癖', () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-whale-'))
  const roles = join(home, 'whale-roles')
  mkdirSync(roles, { recursive: true })
  writeFileSync(join(roles, 'roles.json'), JSON.stringify({
    version: 1,
    roles: [
      { id: 'default', name: '小鲸鱼', pinnedAt: 1, createdAt: 0 },
      { id: 'role_a', name: '蓝鲸娘', format: 'png', pinnedAt: 0, createdAt: 10 },
    ],
  }), 'utf8')
  writeFileSync(join(roles, 'role_a.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(home, '.dshw-usage.json'), JSON.stringify({
    date: '2026-10-23',
    lastCurrency: 'CNY',
    lastBalance: 19.27,
    todayUsage: 3.5,
    history: { '2026-10-22': 1, '2026-10-23': 3.5 },
  }), 'utf8')
  writeFileSync(join(home, '.dshw-bubble.json'), JSON.stringify({
    v: 1,
    items: [{ kind: 'text', text: '在的' }, { kind: 'text', text: '摸鱼中' }],
    lib: [],
  }), 'utf8')

  const store = createConfigStore({ home })
  const whale = createWhale({ home, config: () => store.getConfig() })

  assert.equal(whale.currentRole().name, '小鲸鱼')
  assert.equal(whale.sortedRoles().length, 2)
  assert.match(whale.roleImagePath(whale.readRoles()[1]), /role_a\.png$/)
  assert.equal(whale.usageSummary().balance, 19.27)
  assert.equal(whale.usageSummary().todayUsage, 3.5)
  assert.deepEqual(whale.bubbleQuips(), ['在的', '摸鱼中'])

  const persona = whale.persona()
  assert.match(persona.text, /小鲸鱼/)
  assert.match(persona.text, /19\.27/)
})

test('按配置切到指定角色', () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-whale2-'))
  const roles = join(home, 'whale-roles')
  mkdirSync(roles, { recursive: true })
  writeFileSync(join(roles, 'roles.json'), JSON.stringify({
    version: 1,
    roles: [
      { id: 'default', name: '小鲸鱼' },
      { id: 'role_b', name: '白鲸', createdAt: 99 },
    ],
  }), 'utf8')
  const store = createConfigStore({ home })
  store.saveConfig({ whale: { role: '白鲸' } })
  const whale = createWhale({ home, config: () => store.getConfig() })
  assert.equal(whale.currentRole().id, 'role_b')
})
