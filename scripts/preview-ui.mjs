import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { personaPreset, personaPresetList } from '../lib/persona-presets.mjs'

const ROOT = join(import.meta.dirname, '..', 'ui')
const PORT = Number(process.argv[2] || 55901)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

// 只有这些假数据接口被拦截，其余一律 404，避免误导成真实后端。
const stub = {
  '/dsh-fish-world/env': { ok: true, environment: { ok: true, packages: [], warnings: [], hints: [] } },
  '/dsh-fish-world/capabilities': {
    ok: true,
    built_in: [{ id: 'animation', name: '动图解码器' }],
    plugins: [{ id: 'animation-frames', name: '多帧采样' }],
    skills: [{ id: 'animation-understanding', name: '动图理解' }],
  },
  '/dsh-fish-world/world/diary': {
    ok: true,
    suggestions: [{ id: 's1', at: '2026-10-24T09:12:00.000Z', actorName: '阿鱼', text: '想让它今天多睡一会儿。' }],
    entries: [{ id: 'e1', at: '2026-10-24T21:40:00.000Z', actorName: '鱼', status: 'approved', text: '今天很安静，海面是平的。' }],
  },
  '/dsh-fish-world/stickers': { ok: true, items: [{ id: 'a', name: '歪头', tags: ['可爱'] }], summary: {} },
  '/dsh-fish-world/config': { ok: true, config: { qzone: { enabled: true, postsPerDay: 2, likesPerDay: 2, commentsPerDay: 2, repliesPerDay: 2 } } },
  '/dsh-fish-world/extensions': { ok: true, extensions: [{ id: 'hello-qq', name: '示例扩展', status: 'loaded' }] },
  '/dsh-feiyu-mood/state': { ok: true, emoji: '😊', moodLabel: '欢喜', mood: 81, lastReason: '今天聊得很好。' },
  '/dsh-tts-bridge/status': { ok: true, auto: false, playing: false, waiting: 0 },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname

  if (Object.hasOwn(stub, path)) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(stub[path]))
    return
  }

  // 角色卡预设直接读真实模块：预览里点「蓝鲸娘」看到的就是真正会注入的正文，
  // 而不是再抄一份可能过期的副本。
  if (path === '/preview/persona-preset') {
    const preset = personaPreset(url.searchParams.get('id') || '')
    res.writeHead(preset ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(preset
      ? {
        ok: true,
        presetId: preset.id,
        presetName: preset.name,
        text: preset.text,
        bytes: Buffer.byteLength(preset.text),
        presets: personaPresetList(),
      }
      : { ok: false, error: '没有这个预设' }))
    return
  }

  const rel = path === '/' ? '/index.html' : path
  // 预览也要能加载 lib/ 下的宿主级脚本（mood-badge.js）：跑真实脚本，
  // 而不是在预览里另抄一份逻辑，否则开关的效果永远验不出来。
  const rootDir = path.startsWith('/lib/') ? normalize(join(ROOT, '..')) : ROOT
  const target = normalize(join(rootDir, rel))
  if (!target.startsWith(rootDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + rel)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('fish-world ui preview: http://127.0.0.1:' + PORT + '/')
})
