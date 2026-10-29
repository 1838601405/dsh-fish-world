// dsh-wechat-plugin 只读状态：未安装 / 已装但状态接口 401 / 200 正常 / 地址为空 /
// 默认探针超时 / 只读不写。
//
// 边界（与 lib/wechat-plugin.mjs 的文件头一致）：
//   · 插件装没装只看本机；装了且拿得到宿主地址才去 GET 状态接口（探针可注入，测试不碰真网络）；
//   · 只读一次 GET /.dsh-wechat-plugin/status：不调 /toggle、不调 /login/*、不写任何文件；
//   · 读不到就如实报错，不用默认值冒充「读到了」。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { STATUS_ROUTE, createWeChatPlugin, normalizeOrigin } from '../lib/wechat-plugin.mjs'

const PLUGIN = 'dsh-wechat-plugin'

/** 造一个「装了 dsh-wechat-plugin」的 home（profile 名固定 desktop）。 */
function homeWithPlugin(version = '0.47.0') {
  const home = mkdtempSync(join(tmpdir(), 'fw-wechat-plugin-'))
  const dir = join(home, 'profiles', 'desktop', 'node_modules', PLUGIN)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PLUGIN, version }), 'utf8')
  return home
}

/** 把目录里所有文件的内容与 mtime 记下来，用来证明「只读」。 */
function snapshotTree(root) {
  const out = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      const stat = statSync(file)
      if (stat.isDirectory()) walk(file)
      else out[file] = `${stat.mtimeMs}:${readFileSync(file, 'utf8')}`
    }
  }
  walk(root)
  return out
}

test('未安装：installed=false，note 给安装命令，不去连状态接口', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-wechat-plugin-empty-'))
  let probed = 0
  const service = createWeChatPlugin({
    home,
    profile: 'desktop',
    getOrigin: () => 'http://127.0.0.1:3000',
    probe: () => { probed += 1; return { enabled: true } },
  })
  const status = await service.status()

  assert.equal(status.ok, true)
  assert.equal(status.installed, false)
  assert.equal(status.version, '')
  assert.equal(status.route, STATUS_ROUTE)
  assert.equal(status.reachable, null, '没装就是「还没法探」，不写 false 冒充「连不上」')
  assert.equal(status.enabled, null)
  assert.equal(status.connected, null)
  assert.deepEqual(status.accounts, [])
  assert.match(status.note, /还没安装 dsh-wechat-plugin/)
  assert.match(status.note, /dsh plugin --profile desktop add dsh-wechat-plugin/)
  assert.match(status.note, /装完重启 DSH/)
  assert.equal(probed, 0, '插件都没装，不该去连状态接口')
})

test('已安装但状态接口 401：单独说「需要宿主授权」，指向设置 → 微信', async () => {
  const home = homeWithPlugin()
  const calls = []
  const status = await createWeChatPlugin({
    home,
    profile: 'desktop',
    getOrigin: () => 'http://127.0.0.1:3000',
    probe: ({ url }) => {
      calls.push(url)
      return { reachable: false, status: 401, body: null, error: 'HTTP 401' }
    },
  }).status()

  assert.equal(status.installed, true)
  assert.equal(status.version, '0.47.0')
  assert.equal(status.reachable, false)
  assert.equal(status.lastError, 'HTTP 401')
  assert.equal(calls.length, 1, '每次 status() 只探一次')
  assert.equal(calls[0], 'http://127.0.0.1:3000/.dsh-wechat-plugin/status', '只读 GET 状态接口')
  assert.match(status.note, /需要宿主授权/)
  assert.match(status.note, /设置 → 微信/)
})

test('状态接口 200：通道、连接、绑定账号照抄上游，且只留看得懂的字段', async () => {
  const home = homeWithPlugin()
  const status = await createWeChatPlugin({
    home,
    profile: 'desktop',
    getOrigin: () => 'http://127.0.0.1:3000',
    probe: () => ({
      reachable: true,
      status: 200,
      body: {
        enabled: true,
        connected: true,
        accounts: [
          { name: '预览小号', id: '10000001', connected: true, token: '不该带出去' },
          { nickname: '小号二', uin: '10000002', online: false },
        ],
        token: '也不该带出去',
      },
    }),
  }).status()

  assert.equal(status.reachable, true)
  assert.equal(status.enabled, true)
  assert.equal(status.connected, true)
  assert.equal(status.accounts.length, 2)
  assert.deepEqual(status.accounts[0], { name: '预览小号', id: '10000001', connected: true })
  assert.deepEqual(status.accounts[1], { name: '小号二', id: '10000002', connected: false })
  assert.equal(status.lastError, '')
  assert.match(status.note, /通道已启用/)
  assert.match(status.note, /已连接/)
  assert.match(status.note, /绑定 2 个账号/)
})

test('替身直接给 body 也认（视为可达、HTTP 200）', async () => {
  const home = homeWithPlugin()
  const status = await createWeChatPlugin({
    home,
    profile: 'desktop',
    getOrigin: () => 'http://127.0.0.1:3000',
    probe: () => ({ enabled: false, connected: false, accounts: [] }),
  }).status()
  assert.equal(status.reachable, true)
  assert.equal(status.enabled, false)
  assert.equal(status.connected, false)
  assert.deepEqual(status.accounts, [])
  assert.match(status.note, /通道已停用/)
})

test('拿不到宿主地址：origin 为空、不去探，如实说明重启 DSH 后再看', async () => {
  const home = homeWithPlugin()
  let probed = 0
  const service = createWeChatPlugin({
    home,
    profile: 'desktop',
    getOrigin: () => '',
    probe: () => { probed += 1; return { enabled: true } },
  })
  const status = await service.status()

  assert.equal(status.installed, true)
  assert.equal(status.origin, '')
  assert.equal(status.reachable, null)
  assert.equal(probed, 0, '没有地址就不该去连')
  assert.match(status.note, /拿不到 DSH 的地址/)
  assert.match(status.note, /重启 DSH/)

  // getOrigin 抛错也按「拿不到」处理，不把异常漏给面板。
  const thrown = await createWeChatPlugin({
    home,
    profile: 'desktop',
    getOrigin: () => { throw new Error('webServer 未就绪') },
  }).status()
  assert.equal(thrown.origin, '')
  assert.equal(thrown.reachable, null)
})

test('normalizeOrigin 只认 http(s) 的绝对地址', () => {
  assert.equal(normalizeOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000')
  assert.equal(normalizeOrigin('https://dsh.example.com/base'), 'https://dsh.example.com')
  assert.equal(normalizeOrigin('ftp://127.0.0.1:3000'), '')
  assert.equal(normalizeOrigin('127.0.0.1:3000'), '')
  assert.equal(normalizeOrigin(''), '')
  assert.equal(normalizeOrigin(null), '')
})

test('默认探针超时：1.5 秒内放弃，如实报「请求超时」', { timeout: 8000 }, async () => {
  const home = homeWithPlugin()
  // 本机起一个「只接不回」的服务：默认探针一定会超时，不依赖任何外部网络。
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const started = Date.now()
    const status = await createWeChatPlugin({
      home,
      profile: 'desktop',
      getOrigin: () => `http://127.0.0.1:${port}`,
    }).status()
    const spent = Date.now() - started

    assert.equal(status.reachable, false)
    assert.equal(status.lastError, '请求超时')
    assert.match(status.note, /状态接口连不上/)
    assert.ok(spent < 5000, `默认探针应在超时后返回，实际用了 ${spent}ms`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('只读：status() 不写任何文件，也不碰 /toggle 或 /login', async () => {
  const home = homeWithPlugin()
  writeFileSync(join(home, 'fish-world-config.json'), JSON.stringify({ platforms: { wechat: { enabled: true } } }), 'utf8')
  const before = snapshotTree(home)
  const urls = []
  const service = createWeChatPlugin({
    home,
    profile: 'desktop',
    getOrigin: () => 'http://127.0.0.1:3000',
    probe: ({ url }) => { urls.push(url); return { enabled: true, connected: true, accounts: [] } },
  })
  await service.status()
  await service.status()

  assert.deepEqual(snapshotTree(home), before, 'status() 不能改任何文件（含 mtime）')
  assert.deepEqual(urls, [
    'http://127.0.0.1:3000/.dsh-wechat-plugin/status',
    'http://127.0.0.1:3000/.dsh-wechat-plugin/status',
  ], '只 GET 状态接口：不调 /toggle、不调 /login/*')
})
