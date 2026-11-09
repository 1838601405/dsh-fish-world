import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const INDEX = readFileSync(join(ROOT, 'ui', 'fishworld', 'index.html'), 'utf8')
const SNAPSHOT = readFileSync(join(ROOT, 'ui', 'fishworld', 'assets', 'assets', 'data', 'fish_snapshot.json'), 'utf8')

test('新版 Flutter 面板在 DSH 里不再等 7799 端口超时', () => {
  assert.match(INDEX, /XMLHttpRequest\.prototype\.open/, '要有启动前的桥重写')
  assert.match(INDEX, /dsh-health\.json/, '健康检查指到同源静态文件')
  assert.match(INDEX, /u = 'snapshot'/, '快照走动态接口，失败再回落打包快照')
  assert.match(INDEX, /api\\\/qq\\\/\(status\|config\|recv\|forward\)/, 'QQ 页走同源兼容桥')
  assert.match(INDEX, /api\\\/chat\$/, '聊天走同源模型桥')
  assert.match(INDEX, /api\\\/model\\\/config\$/, '模型配置走同源桥')
  assert.ok(INDEX.indexOf('XMLHttpRequest.prototype.open') < INDEX.indexOf('flutter_bootstrap.js'), '重写必须放在 flutter_bootstrap 之前')
})
