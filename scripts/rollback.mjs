import { existsSync, readdirSync, cpSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const live = join(root, 'ui/fishworld')
const backups = join(root, 'backups')
if (!existsSync(backups)) { console.log('[rollback] 没有备份'); process.exit(1) }
const all = readdirSync(backups).filter((n) => n.startsWith('fishworld-')).sort()
if (process.argv.includes('--list')) { console.log(all.join('\n')); process.exit(0) }
const want = process.argv.find((a) => a.startsWith('fishworld-')) || all.at(-1)
if (!want || !existsSync(join(backups, want))) { console.log('[rollback] 找不到备份：' + want); process.exit(1) }
rmSync(live, { recursive: true, force: true })
cpSync(join(backups, want), live, { recursive: true })
console.log('[rollback] restored=' + want)
