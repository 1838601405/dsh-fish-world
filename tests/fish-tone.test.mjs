// 鱼的风格：dsh-fish-tone 的只读状态（lib/fish-tone.mjs）与只读路由 /dsh-fish-world/tone。
//
// 这一层最怕两件事：把「没装 / 配置坏了」说成「默认值」；以及顺手在插件目录里建了 config.json。
// 所以每个用例都用临时目录 + 注入的 locate 替身，不碰本机真实装了什么（AGENTS §6.3）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFishTone, TONE_DEFAULTS } from '../lib/fish-tone.mjs'
import { SCOPE } from '../lib/hub.mjs'
import { buildRoutes } from '../lib/http.mjs'

/** 造一个「装了 dsh-fish-tone」的假插件目录。 */
function fakeInstall({ version = '0.3.0' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-tone-'))
  const dir = join(home, 'node_modules', 'dsh-fish-tone')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-fish-tone', version }))
  return { home, dir }
}

/** 找包替身：装在某处。 */
function locateTo(dir, version = '0.3.0') {
  return () => ({ found: true, path: dir, version })
}

/** 找包替身：没装。 */
function locateMissing() {
  return () => ({ found: false, path: '', version: '', error: 'MODULE_NOT_FOUND' })
}

test.afterEach(() => {
  // 每个用例自己造的临时目录在用例里删；这里只兜底清理 tmp 前缀目录。
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('fw-tone-')) continue
    try { rmSync(join(tmpdir(), name), { recursive: true, force: true }) } catch {}
  }
})

test('没装 dsh-fish-tone：如实报未安装，不编默认值', () => {
  const { home } = fakeInstall()
  const tone = createFishTone({ home, locate: locateMissing(), env: {} })
  assert.deepEqual(tone.status(), { ok: false, installed: false, error: '未安装 dsh-fish-tone' })
})

test('找包时抛错也不许炸：按未安装报', () => {
  const tone = createFishTone({
    home: tmpdir(),
    locate: () => { throw new Error('读不动') },
    env: {},
  })
  assert.equal(tone.status().installed, false)
})

test('没有 config.json：用上游默认值（light / 7），并且一个文件都不建', () => {
  const { home, dir } = fakeInstall()
  const before = readdirSync(dir)
  const status = createFishTone({ home, locate: locateTo(dir), env: {} }).status()

  assert.equal(status.ok, true)
  assert.equal(status.installed, true)
  assert.equal(status.version, '0.3.0')
  assert.equal(status.strength, 'light')
  assert.equal(status.seed, 7)
  assert.equal(status.grammar, true)
  assert.equal(status.marks, 'light')
  assert.equal(status.enabled, true)
  assert.equal(status.configExists, false)
  assert.equal(status.source, '默认值')
  assert.equal(status.configPath, join(dir, 'config.json'))
  assert.match(status.note, /dsh-fish-tone/)
  // 只读：插件目录里不许多出 config.json（那会改变上游自己的行为）。
  assert.deepEqual(readdirSync(dir), before)
  assert.equal(existsSync(join(dir, 'config.json')), false)
  // 默认值也必须是上游那一份，不是这边另定一套。
  assert.deepEqual(TONE_DEFAULTS, { enabled: true, strength: 'light', seed: 7, grammar: true, marks: 'light' })
})

test('有 config.json：照它读强度 / 种子 / 语法 / 标记 / 开关', () => {
  const { home, dir } = fakeInstall()
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({ enabled: false, strength: 'max', seed: 42, grammar: false, marks: 'normal' }))
  const before = readFileSync(file, 'utf8')
  const status = createFishTone({ home, locate: locateTo(dir), env: {} }).status()

  assert.equal(status.ok, true)
  assert.equal(status.enabled, false)
  assert.equal(status.strength, 'max')
  assert.equal(status.seed, 42)
  assert.equal(status.grammar, false)
  assert.equal(status.marks, 'normal')
  assert.equal(status.configExists, true)
  assert.equal(status.source, 'config.json')
  // 只读：文件一个字节都不改。
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('config.json 里认不出的值按「没写」处理，与上游 loadConfig 一致', () => {
  const { home, dir } = fakeInstall()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ strength: 'strong', seed: '七', marks: 'heavy', grammar: 'yes' }))
  const status = createFishTone({ home, locate: locateTo(dir), env: {} }).status()
  assert.equal(status.ok, true)
  assert.equal(status.strength, 'light', '上游不认的档位不该被面板显示成某一档')
  assert.equal(status.seed, 7)
  assert.equal(status.marks, 'light')
  assert.equal(status.grammar, true)
})

test('config.json 坏了：如实报错，不拿默认值冒充读到了', () => {
  const { home, dir } = fakeInstall()
  const file = join(dir, 'config.json')
  writeFileSync(file, '{ "strength": "light", ')
  const before = readFileSync(file, 'utf8')
  const status = createFishTone({ home, locate: locateTo(dir), env: {} }).status()

  assert.equal(status.ok, false)
  assert.equal(status.installed, true)
  assert.equal(status.configExists, true)
  assert.match(status.error, /config.json 读不出来/)
  // 坏文件不能被「顺手修好」：内容原样留着，等人自己看。
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('config.json 不是对象（数组 / 字符串）：同样如实报错', () => {
  const { home, dir } = fakeInstall()
  writeFileSync(join(dir, 'config.json'), JSON.stringify(['light']))
  const status = createFishTone({ home, locate: locateTo(dir), env: {} }).status()
  assert.equal(status.ok, false)
  assert.match(status.error, /不是一个 JSON 对象/)
})

test('DSH_FISH_TONE_CONFIG 优先：读的是上游设置页写的那一份', () => {
  const { home, dir } = fakeInstall()
  const elsewhere = join(home, 'custom-tone.json')
  writeFileSync(elsewhere, JSON.stringify({ strength: 'normal', seed: 3 }))
  const status = createFishTone({
    home,
    locate: locateTo(dir),
    env: { DSH_FISH_TONE_CONFIG: elsewhere },
  }).status()

  assert.equal(status.configPath, elsewhere)
  assert.equal(status.strength, 'normal')
  assert.equal(status.seed, 3)
  // 插件根下那份不存在，但覆盖路径在：configExists 说的是「实际读的那份」。
  assert.equal(status.configExists, true)
})

// ---------- /dsh-fish-world/tone ----------

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(value) { this.body = String(value || '') },
    json() { return JSON.parse(this.body) },
  }
}

function request({ method = 'GET', url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return { method, url, socket: { remoteAddress } }
}

function routeWith(fishTone) {
  return buildRoutes({ fishTone }).find((route) => route.path === '/dsh-fish-world/tone')
}

test('路由：把服务读到的状态原样给面板', async () => {
  const { home, dir } = fakeInstall()
  const fishTone = createFishTone({ home, locate: locateTo(dir), env: {} })
  const route = routeWith(fishTone)
  assert.ok(route, '/dsh-fish-world/tone 没注册')
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.strength, 'light')
  assert.equal(body.seed, 7)
})

test('路由：没装时回「未安装」，不画默认值', async () => {
  const route = routeWith(createFishTone({ home: tmpdir(), locate: locateMissing(), env: {} }))
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.installed, false)
  assert.match(body.error, /未安装 dsh-fish-tone/)
})

test('路由：没给服务 / 服务不完整时也不假装读到了', async () => {
  for (const stub of [null, {}, { status: 'not-a-function' }]) {
    const route = routeWith(stub)
    const res = response()
    await route.handler(request(), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, false)
  }
})

test('路由：服务抛错要变成一句人话，不要冒到宿主', async () => {
  const route = routeWith({ status: () => { throw new Error('盘读不动') } })
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  assert.match(res.json().error, /盘读不动/)
})

test('路由：只给本机调用', async () => {
  const route = routeWith({ status: () => ({ ok: true, installed: true }) })
  const res = response()
  await route.handler(request({ remoteAddress: '192.0.2.4' }), res)
  assert.equal(res.statusCode, 403)
})

test('面板与提示词都接上了，而且没把风格规则抄进鱼世界', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /key: 'tone'/)
  assert.match(panel, /title: '鱼的风格'/)
  assert.match(panel, /getJSON\('\/dsh-fish-world\/tone'\)/)
  // 「设置与更多」那一页要顺手拉这一张卡的数据。
  assert.match(panel, /view === 'extensions'\)[\s\S]{0,160}loadTone\(\)/)
  // 档位要翻成中文，面板不许自己再编一套档位名（表只有这一处）。
  assert.match(panel, /off: '关闭', light: '轻', normal: '标准', max: '强'/)

  const index = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
  assert.match(index, /【鱼的风格】/)
  assert.match(index, /fish-tone:voice/)
  assert.match(index, /fish_tone 工具/)
  // 这一段的职责是「说清谁管」，不是把风格规则搬过来。
  assert.match(index, /不要自己另造一套文风规则/)
  assert.match(index, /「设置 → 鱼味」/)

  const voice = SCOPE.flatMap((group) => group.items).find((item) => item.id === 'voice')
  assert.ok(voice, 'SCOPE 里要有「鱼的风格」')
  assert.deepEqual(voice.by, ['dsh-fish-tone'])
  assert.match(voice.detail, /fish-tone:voice/)
})
