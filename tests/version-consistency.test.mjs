import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { version } from '../lib/version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('package.json 与 lib/version.mjs 版本一致', () => {
  assert.equal(pkg.version, version, `package.json=${pkg.version} 但 lib/version.mjs=${version}`)
})

test('CHANGELOG 里有当前版本的条目', () => {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  assert.ok(cl.includes('## ' + pkg.version), 'CHANGELOG 缺少 ## ' + pkg.version)
})