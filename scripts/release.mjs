import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const flutter = resolve('E:/WhaleGirl/flutter')
const live = join(root, 'ui/fishworld')
const backups = join(root, 'backups')
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
const dry = process.argv.includes('--dry-run')
const noBuild = process.argv.includes('--no-build')

function walk(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p, base))
    else out.push({ path: p.slice(base.length + 1).replaceAll('\\', '/'), bytes: st.size })
  }
  return out
}
function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }

if (!noBuild) {
  console.log('[release] flutter build web')
  if (!dry) execFileSync('flutter', ['build', 'web', '--release', '--base-href=/dsh-fish-world/fishworld/'], { cwd: flutter, stdio: 'inherit' })
}
const src = join(flutter, 'build/web')
if (!existsSync(join(src, 'index.html'))) throw new Error('构建产物缺失：' + src)
const prune = ['canvaskit/chromium', 'canvaskit/skwasm.js', 'canvaskit/skwasm.wasm', 'canvaskit/skwasm.js.symbols', 'canvaskit/canvaskit.js.symbols']
for (const rel of prune) rmSync(join(src, rel), { recursive: true, force: true })
const files = walk(src)
const total = files.reduce((n, f) => n + f.bytes, 0)
console.log('[release] files=' + files.length + ' bytes=' + total + ' dry=' + dry)
if (dry) process.exit(0)

if (existsSync(live)) {
  const dst = join(backups, 'fishworld-' + stamp)
  mkdirSync(backups, { recursive: true })
  cpSync(live, dst, { recursive: true })
  console.log('[release] backup=' + dst)
}
rmSync(live, { recursive: true, force: true })
cpSync(src, live, { recursive: true })
const manifest = {
  at: new Date().toISOString(),
  files: files.length,
  bytes: total,
  indexSha256: hash(join(live, 'index.html')),
  mainSha256: hash(join(live, 'main.dart.js')),
}
writeFileSync(join(root, 'release-manifest.json'), JSON.stringify(manifest, null, 2))
console.log('[release] live=' + live)
console.log('[release] ' + JSON.stringify(manifest))
