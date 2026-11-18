// 预压缩优先：有 .gz 就发 .gz（x-precompressed:1），没有就现场压。
// 这条是「发布脚本 gzip 一步真的有用」的判据——没有它，gzip 出来的 .gz 只是死文件。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { serveFishworld } from '../lib/static-serve.mjs'

function serve(dir) {
  const server = createServer((req, res) => serveFishworld(req, res, { dir, rootPath: '/panel' }))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function fetchRaw(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
  })
}

test('有 .gz 就发预压缩，带 x-precompressed 标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gz-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  const text = '<html>' + 'x'.repeat(4000) + '</html>'
  writeFileSync(join(dir, 'index.html'), text, 'utf8')
  writeFileSync(join(dir, 'index.html.gz'), gzipSync(Buffer.from(text, 'utf8'), { level: 9 }))
  const server = await serve(dir)
  const { port } = server.address()
  try {
    const res = await fetchRaw(port, '/panel/index.html', { 'accept-encoding': 'gzip' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(res.headers['x-precompressed'], '1', '要能从响应头看出走的是预压缩')
    const { gunzipSync } = await import('node:zlib')
    assert.equal(gunzipSync(res.body).toString('utf8'), text)
  } finally {
    server.close()
  }
})

test('没有 .gz 就现场压，不带预压缩标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gz2-'))
  const text = 'console.log("' + 'y'.repeat(3000) + '")'
  writeFileSync(join(dir, 'main.dart.js'), text, 'utf8')
  const server = await serve(dir)
  const { port } = server.address()
  try {
    const res = await fetchRaw(port, '/panel/main.dart.js', { 'accept-encoding': 'gzip' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(res.headers['x-precompressed'], undefined, '现场压不该有预压缩标记')
  } finally {
    server.close()
  }
})

test('客户端不支持 gzip：发原始文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gz3-'))
  writeFileSync(join(dir, 'a.js'), 'var a=1;'.repeat(200), 'utf8')
  writeFileSync(join(dir, 'a.js.gz'), gzipSync(Buffer.from('var a=1;'.repeat(200), 'utf8')))
  const server = await serve(dir)
  const { port } = server.address()
  try {
    const res = await fetchRaw(port, '/panel/a.js', {})
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], undefined)
    assert.match(res.body.toString('utf8'), /var a=1;/)
  } finally {
    server.close()
  }
})