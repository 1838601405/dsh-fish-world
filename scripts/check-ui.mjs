import fs from 'node:fs'
import path from 'node:path'

const LIB = 'E:/WhaleGirl/flutter/lib'
const KIT = path.join(LIB, 'fish', 'ui_kit')
const TOKENS = path.join(LIB, 'theme', 'whale_tokens.dart')
const reds = []
const warns = []

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) return files(f)
    return e.name.endsWith('.dart') ? [f] : []
  })
}

for (const f of files(LIB)) {
  const rel = f.replace(/\\/g, '/').replace(LIB + '/', '')
  if (f === TOKENS) continue
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    const at = rel + ':' + (i + 1)
    if (/Color\(0x/.test(line)) reds.push(at + ' 裸色值: ' + line.trim().slice(0, 80))
    if (/\bTooltip\(/.test(line) && !f.startsWith(KIT)) reds.push(at + ' 非 ui_kit Tooltip(: ' + line.trim().slice(0, 80))
    if (/CircularProgressIndicator\(/.test(line)) warns.push(at + ' 页面级转圈')
    if (/Matrix4\.translationValues\(0,\s*-?([3-9]|\d{2,})/.test(line)) reds.push(at + ' hover 位移 >2px: ' + line.trim().slice(0, 80))
    const m = line.match(/BorderRadius\.circular\(([0-9.]+)\)/)
    if (m && ![8, 12].includes(Number(m[1]))) warns.push(at + ' 圆角非 8/12: ' + m[1])
  })
}

const report = { scanned: files(LIB).length, red: reds.length, warn: warns.length, reds, warns: warns.slice(0, 60) }
console.log(JSON.stringify(report, null, 2))
process.exit(reds.length > 0 ? 1 : 0)
