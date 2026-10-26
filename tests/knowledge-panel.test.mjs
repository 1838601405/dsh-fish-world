// 知识库面板：所有设置都要在面板上看得见、点得到（不能只能手改 json）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const src = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

test('知识库面板：有「向量后端」下拉，选后端即开启，旧的单一开关已移除', () => {
  assert.match(src, /向量后端/)
  assert.match(src, /saveKnowledge\(\{ mode: modeSelect\.value, enabled: modeSelect\.value !== 'off' \}\)/)
  assert.doesNotMatch(src, /用向量档（本机小模型）/)
})

test('知识库面板：远程 key 只显示已保存 / 未设置，输入框是密码框，清除走 apiKey: null', () => {
  assert.match(src, /type: 'password'/)
  assert.match(src, /已保存（留空不改）/)
  assert.match(src, /saveKnowledge\(\{ apiKey: null \}\)/)
})

test('知识库面板：配置问题直接列在卡片上', () => {
  assert.match(src, /k\.problems/)
})
