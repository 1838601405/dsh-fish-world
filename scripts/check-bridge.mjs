import fs from 'node:fs'
import path from 'node:path'

const FLUTTER = 'E:/WhaleGirl/flutter/lib'
const HTTP = 'E:/dsh_fish_world/lib/http.mjs'
const reds = []
const warns = []

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) return walk(f)
    return e.name.endsWith('.dart') ? [f] : []
  })
}

const flutterPaths = new Map()
for (const f of walk(FLUTTER)) {
  const text = fs.readFileSync(f, 'utf8')
  for (const m of text.matchAll(/['\`](\/dsh-fish-world\/[A-Za-z0-9_\-\/.:$]+)['\`]/g)) {
    const p = m[1].replace(/\$\{[^}]+\}/g, '*')
    if (!flutterPaths.has(p)) flutterPaths.set(p, [])
    flutterPaths.get(p).push(f.replace(/\\/g, '/').replace(FLUTTER + '/', ''))
  }
}

const http = fs.readFileSync(HTTP, 'utf8')
const plugin = new Set()
for (const m of http.matchAll(/path:\s*\`\$\{prefix\}([^\`]+)\`/g)) plugin.add('/dsh-fish-world' + m[1])
for (const m of http.matchAll(/fishworldCompatAction\('([^']+)'/g)) plugin.add('/dsh-fish-world/fishworld/' + m[1])
// notesWrite('save'|'delete'|'move') 拼的是 notes/<kind>，静态扫只看到第一个参数。
for (const m of http.matchAll(/notesWrite\('([^']+)'/g)) plugin.add('/dsh-fish-world/fishworld/notes/' + m[1])

const pluginList = [...plugin].sort()
for (const [p, where] of flutterPaths) {
  const normalized = p.replace(/\/\*$/, '')
  const hit = pluginList.some((q) => q === p || q === normalized || (normalized.endsWith('*') && q.startsWith(normalized.slice(0, -1))))
  if (!hit && !normalized.includes('*')) reds.push('前端调用插件没有的路由: ' + p + '  (' + where[0] + ')')
}

const internal = /\/(health|protocol|state|capabilities|reload|doctor|storage|fs|deps|update|cost|market|astrbot|qqagent|hub|memory|model|chat|snapshot|fish\/|world\/activity|activity|record|sticker|link|qzone|diary|growth|wish|notes|qq\/|world\/)/i
for (const p of pluginList) {
  const called = [...flutterPaths.keys()].some((f) => p.startsWith(f.replace(/\/\*$/, '')) || f.startsWith(p))
  if (!called && !internal.test(p)) warns.push('插件路由前端未调用: ' + p)
}

const report = { flutterPaths: flutterPaths.size, pluginRoutes: pluginList.length, red: reds.length, warn: warns.length, reds, warns: warns.slice(0, 50) }
console.log(JSON.stringify(report, null, 2))
process.exit(reds.length > 0 ? 1 : 0)
