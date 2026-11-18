import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
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
const noGzip = process.argv.includes('--no-gzip')

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
  if (!dry) {
    const args = ['build', 'web', '--release', '--base-href=/dsh-fish-world/fishworld/']
    if (process.platform === 'win32') execFileSync('cmd.exe', ['/c', 'flutter', ...args], { cwd: flutter, stdio: 'inherit' })
    else execFileSync('flutter', args, { cwd: flutter, stdio: 'inherit' })
  }
}
const src = join(flutter, 'build/web')
if (!existsSync(join(src, 'index.html'))) throw new Error('构建产物缺失：' + src)
const prune = ['canvaskit/chromium', 'canvaskit/skwasm.js', 'canvaskit/skwasm.wasm', 'canvaskit/skwasm.js.symbols', 'canvaskit/canvaskit.js.symbols']
for (const rel of prune) rmSync(join(src, rel), { recursive: true, force: true })
// 预压缩：发布脚本负责 build → prune → **gzip** → 拷贝。
// 服务端（lib/static-serve.mjs）有 .gz 就直接发它，省掉每次请求的现场压缩。
// 幂等：只压 >1KB 的可压缩文件，且源文件比 .gz 新才重压。
const GZ_EXT = ['.html', '.js', '.mjs', '.json', '.css', '.svg', '.wasm']
function precompress(dir) {
  let made = 0
  let skipped = 0
  let bytesBefore = 0
  let bytesAfter = 0
  for (const entry of walk(dir)) {
    const abs = join(dir, entry.path)
    const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
    if (!GZ_EXT.includes(ext)) continue
    if (entry.bytes < 1024) continue
    const gz = abs + '.gz'
    let gzStat = null
    try { gzStat = statSync(gz) } catch { gzStat = null }
    const srcStat = statSync(abs)
    if (gzStat && gzStat.isFile() && gzStat.mtimeMs >= srcStat.mtimeMs) { skipped += 1; continue }
    const raw = readFileSync(abs)
    const packed = gzipSync(raw, { level: 9 })
    writeFileSync(gz, packed)
    made += 1
    bytesBefore += raw.length
    bytesAfter += packed.length
  }
  return { made, skipped, bytesBefore, bytesAfter }
}
if (!noGzip) {
  const gz = precompress(src)
  const ratio = gz.bytesBefore ? (gz.bytesAfter / gz.bytesBefore * 100).toFixed(1) : '0'
  console.log('[release] gzip: 新压 ' + gz.made + ' 个 / 跳过 ' + gz.skipped + ' 个 / ' + gz.bytesBefore + 'B → ' + gz.bytesAfter + 'B（' + ratio + '%）')
} else {
  console.log('[release] gzip: 跳过（--no-gzip）')
}
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
  gzFiles: readdirSync(live, { recursive: true }).filter((n) => String(n).endsWith('.gz')).length,
}
// 部署时间 = 现在：cpSync 保留了构建时的 mtime，会让 deploy-check 把「刚部署」判成「没部署」。
const nowSec = Date.now() / 1000
for (const entry of walk(live)) {
  try { utimesSync(join(live, entry.path), nowSec, nowSec) } catch {}
}
writeFileSync(join(root, 'release-manifest.json'), JSON.stringify(manifest, null, 2))
console.log('[release] live=' + live)
console.log('[release] ' + JSON.stringify(manifest))
