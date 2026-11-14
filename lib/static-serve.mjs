import { createReadStream, statSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { extname, join } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

/** Fish World 面板静态服务：gzip + ETag/304 + 长缓存。 */
export function serveFishworld(req, res, { dir, rootPath }) {
  try {
    const raw = String(req.url || '/').split('?')[0]
    const rest = decodeURIComponent(raw.slice(rootPath.length)) || '/'
    const rel = rest.replace(/^\/+/, '') || 'index.html'
    if (rel.includes('..') || rel.startsWith('.')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad path')
      return
    }
    const file = join(dir, rel)
    const st = statSync(file)
    if (!st.isFile()) throw new Error('not a file')
    const ext = extname(file).toLowerCase()
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
    const cache = ext === '.html'
      ? 'no-cache'
      : (rel.startsWith('assets/') || rel.startsWith('canvaskit/'))
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': cache })
      res.end()
      return
    }
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': cache,
      etag,
      'last-modified': st.mtime.toUTCString(),
    }
    const compressible = ['.html', '.js', '.mjs', '.json', '.css', '.svg', '.wasm'].includes(ext)
    const accept = String(req.headers['accept-encoding'] || '')
    if (compressible && /\bgzip\b/.test(accept)) {
      headers['content-encoding'] = 'gzip'
      headers['vary'] = 'Accept-Encoding'
      res.writeHead(200, headers)
      if (req.method === 'HEAD') return res.end()
      createReadStream(file).pipe(createGzip({ level: 6 })).pipe(res)
      return
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('fish world panel: not found')
  }
}
