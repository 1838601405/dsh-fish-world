import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfigStore } from '../lib/config.mjs'
import { createMarket, __test } from '../lib/market.mjs'

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const [filename, raw] of Object.entries(files)) {
    const name = Buffer.from(filename)
    const data = Buffer.from(raw)
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x800, 6)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    local.push(lh, name, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(0x0314, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

test('source list is link-only and never touches the network', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network must not be used') }
  try {
    const market = createMarket({ configStore: {}, loader: { list: () => [] } })
    const result = await market.links('plugin')
    assert.equal(result.ok, true)
    assert.ok(result.links.length >= 2)
    assert.ok(result.links.every((link) => /^https:\/\//.test(link.url)))
    assert.match(result.notice, /不托管下载/)
  } finally { globalThis.fetch = oldFetch }
})

test('install downloads from the pasted link, safely extracts, registers disabled only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qq-market-test-'))
  const pluginDir = join(home, 'plugins')
  const skillDir = join(home, 'skills')
  const store = createConfigStore({ home })
  store.saveConfig({ extensionDirs: [skillDir, pluginDir] })
  const installed = []
  const loader = { list: () => [], refreshInstalled() { installed.push('market-demo'); return { added: ['market-demo'] } } }
  const archive = storedZip({
    'source/plugin.json': JSON.stringify({
      id: 'market-demo', name: '市场示例', version: '1.2.3', kind: 'plugin', apiVersion: 1,
      enabledByDefault: true, entry: 'index.js', permissions: [],
    }),
    'source/index.js': 'export default { setup(ctx) { ctx.log.info("demo") } }',
  })
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(String(url))
    return new Response(archive, { status: 200 })
  }
  const lookupImpl = async () => [{ address: '140.82.112.3', family: 4 }]
  const market = createMarket({ configStore: store, loader, pluginDir, skillDir, fetchImpl, lookupImpl })
  const result = await market.install({ kind: 'plugin', url: 'https://github.com/owner/repo' })
  assert.equal(result.ok, true)
  assert.equal(result.id, 'market-demo')
  assert.equal(result.enabled, false)
  assert.deepEqual(requests, ['https://codeload.github.com/owner/repo/zip/HEAD'])
  assert.deepEqual(installed, ['market-demo'])
  assert.ok(existsSync(join(pluginDir, 'market-demo', 'plugin.json')))
  assert.equal(JSON.parse(readFileSync(join(pluginDir, 'market-demo', 'plugin.json'), 'utf8')).id, 'market-demo')
  assert.equal(store.isEnabled('market-demo', true), false)
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'https://example.com/plugin.zip' }), /已有同 ID/)
})

test('install rejects non-https, localhost and private-network links before download', async () => {
  const market = createMarket({ configStore: {}, loader: { list: () => [] }, fetchImpl: async () => { throw new Error('must not download') } })
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'http://example.com/a.zip' }), /https/)
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'https://localhost/a.zip' }), /本机或内网/)
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'https://127.0.0.1/a.zip' }), /本机或内网/)
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'https://192.168.1.2/a.zip' }), /本机或内网/)
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'https://user:pass@example.com/a.zip' }), /账号/)
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'https://www.npmjs.com/package/foo' }), /GitHub/)
})

test('install rejects a link that resolves to a private address', async () => {
  const market = createMarket({
    configStore: {}, loader: { list: () => [] },
    fetchImpl: async () => { throw new Error('must not download') },
    lookupImpl: async () => [{ address: '10.0.0.7', family: 4 }],
  })
  await assert.rejects(() => market.install({ kind: 'plugin', url: 'https://evil.example.com/a.zip' }), /内网/)
})

test('market install rejects unsafe archive paths and unsupported entries', () => {
  assert.throws(() => __test.safeZipName('../outside.js'), /不安全路径/)
  assert.throws(() => __test.safeZipName('C:/outside.js'), /不安全路径/)
})
