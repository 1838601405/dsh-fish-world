import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const UI = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

test('平台页规则卡独占一行，不在 8 列内容后留下 8 列空洞', () => {
  const at = UI.indexOf("key: 'platforms-rules'")
  assert.ok(at > 0, '找不到规则卡')
  const block = UI.slice(at, at + 220)
  assert.match(block, /span: 12/, '规则卡应为 12 列通栏')
  assert.match(UI, /data\.platforms \|\| \[\]\)\.filter\(function \(p\) \{ return p\.installed === true \}\)/, '未安装平台不进入平台列表')
})
