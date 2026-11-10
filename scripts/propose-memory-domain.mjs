#!/usr/bin/env node
// 记忆 / 工作账归属迁移：默认 dry-run，不允许直接写。
// 用法：node scripts/propose-memory-domain.mjs            # 只报
//       node scripts/propose-memory-domain.mjs --write --confirm  # 写前备份
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const LEDGER_IDS = new Set([
  'mmw2bug0m950','mmw1f120w182','mmw1biasv564','mmw1ad9nz572',
  'mmvtiqmgy555','mmvting7b382','mmvtijld4170','mmvtihvwf169',
  'mmvt4dcb7681','mmvsafjf8727','mmvrr0t011','mmvrnl0od803',
  'mmvnho96q229','mmvnhnbgc574','mmvnhk7l5127','mmvnhh8eu87',
])

const home = process.env.DSH_HOME || 'D:/DSH-home'
const roots = [join(home, '鱼的世界', '鱼的记忆'), 'D:/大肥鱼/鱼的世界/鱼的记忆'].filter((r) => existsSync(r))
if (!roots.length) { console.error('找不到记忆目录'); process.exit(1) }
const write = process.argv.includes('--write')
const confirm = process.argv.includes('--confirm')
if (write && !confirm) { console.error('拒绝写入：必须同时带 --confirm'); process.exit(1) }

let hits = 0
const files = roots.flatMap((root) => readdirSync(root).filter((n) => /^session-.*\.json$/.test(n)).map((name) => join(root, name)))
for (const path of files) {
  const name = path.split(/[\\/]/).pop()
  const raw = readFileSync(path, 'utf8')
  const j = JSON.parse(raw)
  if (!Array.isArray(j.memories)) continue
  const marked = j.memories.filter((m) => LEDGER_IDS.has(String(m.id || '')))
  if (!marked.length) continue
  hits += marked.length
  console.log(name + ' → ' + marked.length + ' 条工作账')
  for (const m of marked) console.log('  ' + m.id + '  ' + String(m.text || '').slice(0, 32))
  if (write) {
    for (const m of marked) m.domain = 'ledger'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(path, path + '.bak-domain-' + stamp)
    writeFileSync(path, JSON.stringify(j, null, 2), 'utf8')
    console.log('  已写：' + path)
  }
}
console.log(write ? '完成：' + hits + ' 条已标 ledger' : 'dry-run：' + hits + ' 条待迁（未写盘）')
