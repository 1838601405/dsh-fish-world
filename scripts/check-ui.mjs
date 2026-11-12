import fs from 'node:fs'
import path from 'node:path'
const ROOT = 'E:/WhaleGirl/flutter/lib/fish'
const KIT = path.join(ROOT, 'ui_kit')
const reds = [], warns = []
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'ui_kit' ? [] : files(f)
    return e.name.endsWith('.dart') ? [f] : []
  })
}
for (const f of files(ROOT)) {
  const rel = f.replace(/\\/g, '/').replace(ROOT + '/', '')
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    const at = rel + ':' + (i + 1)
    if (/Color\(0x/.test(line)) reds.push(at + ' 裸色值: ' + line.trim().slice(0, 80))
    if (/\bTooltip\(/.test(line)) reds.push(at + ' 直接 Tooltip(: ' + line.trim().slice(0, 80))
    if (/\bInkWell\(/.test(line)) warns.push(at + ' 直接 InkWell(（若当卡片用需换 FishUiCard）')
  })
  // 失败类文案必须伴随 FishStatusAction（同一文件里有 FishStatusAction 即算通过）
  const text = lines.join('\n')
  const hasBar = /FishStatusAction\(/.test(text)
  if (!hasBar) {
    lines.forEach((line, i) => {
      if (/(失败|未就绪|未连接|没连上)/.test(line) && /['"]/.test(line)) {
        reds.push(rel + ':' + (i + 1) + ' 失败/未就绪文案没有 FishStatusAction: ' + line.trim().slice(0, 70))
      }
    })
  }
}
const report = {
  scanned: files(ROOT).length,
  red: reds.length,
  warn: warns.length,
  reds,
  warns: warns.slice(0, 40),
}
console.log(JSON.stringify(report, null, 2))
process.exit(reds.length > 0 ? 1 : 0)
