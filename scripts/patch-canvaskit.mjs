import { readFileSync, writeFileSync } from 'node:fs'
const file = new URL('../ui/fishworld/flutter_bootstrap.js', import.meta.url)
let s = readFileSync(file, 'utf8')
const marker = '_flutter.loader.load({'
const i = s.lastIndexOf(marker)
if (i < 0) throw new Error('flutter_bootstrap.js: loader call not found')
if (s.slice(i, i + 220).includes('canvasKitBaseUrl')) {
  console.log('already local CanvasKit')
} else {
  s = s.slice(0, i + marker.length) + "\n  config: { canvasKitBaseUrl: 'canvaskit/' }," + s.slice(i + marker.length)
  writeFileSync(file, s, 'utf8')
  console.log('patched: CanvasKit -> local canvaskit/')
}
