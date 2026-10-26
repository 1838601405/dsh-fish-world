// 群友记忆：一个 QQ 号一份，只记「跟她真的聊过」的那几段。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { noteExchange, personBrief, personMemoryPath, readPersonMemory } from '../lib/person-memory.mjs'

const root = () => mkdtempSync(join(tmpdir(), 'fw-person-'))

test('第一次见面不写任何东西：没来回过就没有记忆', () => {
  const home = root()
  assert.equal(readPersonMemory(home, '12345'), null)
  assert.equal(personBrief(home, '12345'), '')
  assert.equal(existsSync(personMemoryPath(home, '12345')), false)
})

test('她回了一句才落盘：记下他说的话和她的回话', () => {
  const home = root()
  const res = noteExchange(home, { qq: '12345', nickname: '阿明', heSaid: '你会对战吗', sheSaid: '我只会嘴上打', at: 1793000000000, chatKey: 'group:20002' })
  assert.equal(res.ok, true)
  const saved = readPersonMemory(home, '12345')
  assert.equal(saved.nickname, '阿明')
  assert.equal(saved.exchanges.length, 1)
  assert.equal(saved.exchanges[0].he, '你会对战吗')
  assert.equal(saved.exchanges[0].she, '我只会嘴上打')
  // 按 QQ 号分文件：不同人互不影响
  assert.equal(readPersonMemory(home, '99999'), null)
})

test('没回话 / 缺字段就不记（她只是旁听的那些话不进记忆）', () => {
  const home = root()
  assert.equal(noteExchange(home, { qq: '12345', heSaid: '今天吃什么', sheSaid: '', at: 1 }).ok, false)
  assert.equal(noteExchange(home, { qq: '', heSaid: '在吗', sheSaid: '在', at: 1 }).ok, false)
  assert.equal(readPersonMemory(home, '12345'), null)
})

test('简报只取最近几段，且带上时间', () => {
  const home = root()
  for (const [i, text] of ['第一句', '第二句', '第三句'].entries()) {
    noteExchange(home, { qq: '12345', nickname: '阿明', heSaid: text, sheSaid: '嗯', at: 1793000000000 + i * 60000, chatKey: 'group:1' })
  }
  const brief = personBrief(home, '12345', 2)
  assert.match(brief, /第二句/)
  assert.match(brief, /第三句/)
  assert.doesNotMatch(brief, /第一句/)
  assert.match(brief, /\d{2}-\d{2} \d{2}:\d{2}/, '要带时间')
})

test('同一人换昵称：记新的，旧记录不丢', () => {
  const home = root()
  noteExchange(home, { qq: '12345', nickname: '阿明', heSaid: 'a', sheSaid: 'b', at: 1 })
  noteExchange(home, { qq: '12345', nickname: '阿明改名了', heSaid: 'c', sheSaid: 'd', at: 2 })
  const saved = JSON.parse(readFileSync(personMemoryPath(home, '12345'), 'utf8'))
  assert.equal(saved.nickname, '阿明改名了')
  assert.equal(saved.exchanges.length, 2)
})
