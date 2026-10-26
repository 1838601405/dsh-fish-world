// 群友记忆：一个 QQ 号一份；主体是「聊满 100 个来回才更新一次」的印象总结。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  needsSummary,
  noteExchange,
  personBrief,
  personMemoryPath,
  readPersonMemory,
  saveSummary,
  SUMMARY_EVERY,
  summaryMaterial,
} from '../lib/person-memory.mjs'

const root = () => mkdtempSync(join(tmpdir(), 'fw-person-'))

function chat(home, qq, text, n = 1) {
  let last = null
  for (let i = 0; i < n; i++) {
    last = noteExchange(home, { qq, nickname: '阿明', heSaid: `${text}${i}`, sheSaid: `回${i}`, at: 1793000000000 + i * 1000, chatKey: 'group:20002' })
  }
  return last
}

test('第一次见面不写任何东西：没来回过就没有记忆', () => {
  const home = root()
  assert.equal(readPersonMemory(home, '12345'), null)
  assert.equal(personBrief(home, '12345'), '')
  assert.equal(needsSummary(home, '12345'), false)
  assert.equal(existsSync(personMemoryPath(home, '12345')), false)
})

test('她回了一句才落盘：记下他说的话、她的回话和来回计数', () => {
  const home = root()
  const res = noteExchange(home, { qq: '12345', nickname: '阿明', heSaid: '你会对战吗', sheSaid: '我只会嘴上打', at: 1793000000000, chatKey: 'group:20002' })
  assert.equal(res.ok, true)
  const saved = readPersonMemory(home, '12345')
  assert.equal(saved.nickname, '阿明')
  assert.equal(saved.total, 1)
  assert.equal(saved.sinceSummary, 1)
  assert.equal(saved.exchanges[0].he, '你会对战吗')
  assert.equal(readPersonMemory(home, '99999'), null, '按 QQ 号分文件')
})

test('没回话 / 缺字段就不记（她只是旁听的那些话不进记忆）', () => {
  const home = root()
  assert.equal(noteExchange(home, { qq: '12345', heSaid: '今天吃什么', sheSaid: '', at: 1 }).ok, false)
  assert.equal(noteExchange(home, { qq: '', heSaid: '在吗', sheSaid: '在', at: 1 }).ok, false)
  assert.equal(readPersonMemory(home, '12345'), null)
})

test(`聊满 ${SUMMARY_EVERY} 个来回才要求更新印象，更新后计数归零`, () => {
  const home = root()
  chat(home, '12345', '话', SUMMARY_EVERY - 1)
  assert.equal(needsSummary(home, '12345'), false, '没到 100 不催')
  chat(home, '12345', '话', 1)
  assert.equal(needsSummary(home, '12345'), true, '满 100 要更新')

  assert.equal(saveSummary(home, '12345', '嘴硬，爱接梗，聊游戏时会突然认真').ok, true)
  const saved = readPersonMemory(home, '12345')
  assert.equal(saved.sinceSummary, 0)
  assert.equal(saved.total, SUMMARY_EVERY, '总来回数不清零')
  assert.match(saved.summary.text, /嘴硬/)
  assert.equal(needsSummary(home, '12345'), false)

  chat(home, '12345', '话', 3)
  assert.equal(needsSummary(home, '12345'), false, '下一轮要再攒 100 个来回')
})

test('空印象不覆盖旧印象；没记录的人不能写', () => {
  const home = root()
  chat(home, '12345', '话', SUMMARY_EVERY)
  saveSummary(home, '12345', '旧印象')
  assert.equal(saveSummary(home, '12345', '   ').ok, false)
  assert.equal(readPersonMemory(home, '12345').summary.text, '旧印象')
  assert.equal(saveSummary(home, '999', '谁').ok, false)
})

test('简报先给印象，再给最近一段来回', () => {
  const home = root()
  chat(home, '12345', '话', SUMMARY_EVERY)
  saveSummary(home, '12345', '嘴硬但好说话')
  chat(home, '12345', '最后一问', 1)
  const brief = personBrief(home, '12345')
  assert.match(brief, /印象：嘴硬但好说话/)
  assert.match(brief, /最后一问0/)
  assert.match(brief, /\d{2}-\d{2} \d{2}:\d{2}/, '最近一段要带时间')
})

test('写印象的素材是最近的来回，一行一条', () => {
  const home = root()
  chat(home, '12345', '素材', 3)
  const material = summaryMaterial(home, '12345', 2)
  assert.equal(material.split('\n').length, 2)
  assert.match(material, /他说「素材2」/)
})
