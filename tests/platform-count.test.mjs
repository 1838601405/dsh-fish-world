import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const UI = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

function counter() {
  const m = UI.match(/var enabledCount = platformList\.filter\(function \(p\) \{ return (.*?) \}\)\.length/)
  assert.ok(m, '没找到平台启用计数表达式')
  return new Function('platformList', 'return platformList.filter(function (p) { return ' + m[1] + ' }).length')
}

test('平台计数只算已安装且已启用：未安装的 enabled=true 不能算进去', () => {
  const count = counter()
  assert.equal(count([
    { id: 'qq', installed: true, config: { enabled: true } },
    { id: 'douyin', installed: true, config: { enabled: false } },
    { id: 'bili', installed: false, config: { enabled: true } },
    { id: 'wechat', installed: false, config: { enabled: true } },
  ]), 1, '截图里只有 QQ 真正可用，不该显示 3/4')
  assert.equal(count([{ id: 'qq', installed: false, config: { enabled: true } }]), 0)
})
