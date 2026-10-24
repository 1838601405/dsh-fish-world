// AstrBot 接入的单元测试：配置归一化、token 安全、通道切换。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeAstrbot,
  validateAstrBotUrl,
  maskToken,
  createAstrbot,
  DEFAULT_ASTRBOT,
} from '../lib/astrbot.mjs'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'fw-astrbot-'))
}

test('validateAstrBotUrl 只接受 http(s)，非本机必须 https', () => {
  assert.equal(validateAstrBotUrl('http://127.0.0.1:6210').ok, true)
  assert.equal(validateAstrBotUrl('http://localhost:6210').ok, true)
  assert.equal(validateAstrBotUrl('https://example.com').ok, true)
  // 非本机用明文 http 会泄露 token，必须拒绝。
  assert.equal(validateAstrBotUrl('http://example.com').ok, false)
  assert.equal(validateAstrBotUrl('ftp://example.com').ok, false)
  // 地址里带账号密码也要拒绝。
  assert.equal(validateAstrBotUrl('https://user:pass@example.com').ok, false)
})

test('normalizeAstrbot 把未知字段丢掉并夹紧数值', () => {
  const cfg = normalizeAstrbot({
    enabled: true,
    useForQQ: 'yes',
    borrowTools: 1,
    randomField: 'should be dropped',
    timeoutMs: 999999,
    pollMs: 1,
  })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.useForQQ, false, '字符串 "yes" 不算 true')
  assert.equal(cfg.borrowTools, false, '数字 1 不算 true')
  assert.equal('randomField' in cfg, false)
  assert.equal(cfg.timeoutMs, 120000, '超时被夹到上限')
  assert.equal(cfg.pollMs, 1000, '轮询间隔被夹到下限')
})

test('normalizeAstrbot 默认全部关闭', () => {
  const cfg = normalizeAstrbot(undefined)
  assert.deepEqual(cfg, DEFAULT_ASTRBOT)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.useForQQ, false)
  assert.equal(cfg.borrowTools, false)
})

test('maskToken 只留最后 4 位', () => {
  assert.equal(maskToken(''), '')
  assert.equal(maskToken('abc'), '••••')
  assert.equal(maskToken('fw_1234567890abcd'), '••••abcd')
})

test('createAstrbot 的视图永不返回 token 明文', () => {
  const home = tempHome()
  const bot = createAstrbot({ home })
  bot.save({ enabled: true, baseUrl: 'http://127.0.0.1:6210', token: 'fw_secret_token_value' })
  const view = bot.view()
  assert.equal(view.hasToken, true)
  assert.equal(view.tokenPreview, '••••alue')
  // 整个视图序列化后不能含明文
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('fw_secret_token_value'), false)
})

test('token 落盘权限收紧且不写进主配置', () => {
  const home = tempHome()
  const saved = []
  const configStore = {
    getConfig: () => ({}),
    saveConfig: (patch) => saved.push(patch),
  }
  const bot = createAstrbot({ home, configStore })
  bot.save({ enabled: true, token: 'fw_abc123456' })

  const raw = JSON.parse(readFileSync(join(home, 'fish-world-astrbot.json'), 'utf8'))
  assert.equal(raw.token, 'fw_abc123456')
  assert.equal(raw.astrbot.enabled, true)

  // 主配置里出现的是非敏感字段，不能有 token。
  const synced = saved.find((p) => p.astrbot)
  assert.ok(synced, '应该同步非敏感字段到主配置')
  assert.equal('token' in synced.astrbot, false)
  assert.equal(JSON.stringify(synced).includes('fw_abc123456'), false)

  // 权限：非 Windows 才检查 0600（Windows 上 chmod 语义不同）。
  if (process.platform !== 'win32') {
    const mode = statSync(join(home, 'fish-world-astrbot.json')).mode & 0o777
    assert.equal(mode, 0o600)
  }
})

test('token 传空字符串表示保持原值，传 null 表示清除', () => {
  const home = tempHome()
  const bot = createAstrbot({ home })
  bot.save({ token: 'fw_original' })
  assert.equal(bot.token(), 'fw_original')

  bot.save({ token: '' })
  assert.equal(bot.token(), 'fw_original', '空字符串不应该清掉密钥')

  bot.save({ token: null })
  assert.equal(bot.token(), '', 'null 才是清除')
})

test('rotateToken 生成新 token 并只在这一次返回明文', () => {
  const home = tempHome()
  const bot = createAstrbot({ home })
  const result = bot.rotateToken()
  assert.match(result.token, /^fw_[0-9a-f]{48}$/)
  assert.equal(result.hasToken, true)
  // 之后通过 view 拿不到明文
  const view = bot.view()
  assert.equal(JSON.stringify(view).includes(result.token), false)
  assert.equal(bot.token(), result.token)
})

test('canUseForQQ 需要同时满足 启用 + useForQQ + 地址 + token', () => {
  const home = tempHome()
  const bot = createAstrbot({ home })

  bot.save({ enabled: true, useForQQ: true, baseUrl: 'http://127.0.0.1:6210' })
  assert.equal(bot.view().canUseForQQ, false, '缺 token 时不能用')

  bot.save({ token: 'fw_x' })
  assert.equal(bot.view().canUseForQQ, true)

  bot.save({ useForQQ: false })
  assert.equal(bot.view().canUseForQQ, false, '关掉 useForQQ 就不能当通道')

  bot.save({ useForQQ: true, enabled: false })
  assert.equal(bot.view().canUseForQQ, false, '总开关关掉就不能用')
})

test('canBorrowTools 与 canUseForQQ 互相独立', () => {
  const home = tempHome()
  const bot = createAstrbot({ home })
  bot.save({ enabled: true, borrowTools: true, token: 'fw_x' })
  const view = bot.view()
  assert.equal(view.canBorrowTools, true)
  assert.equal(view.canUseForQQ, false, '借用工具不需要开 QQ 通道')
})

test('callOneBot 没有 token 时直接失败，不发请求', async () => {
  const home = tempHome()
  const bot = createAstrbot({ home })
  const result = await bot.callOneBot('get_login_info', {})
  assert.equal(result.ok, false)
  assert.match(result.error, /token/)
})

test('callOneBot 桥不可达时返回结构化失败，不抛异常', async () => {
  const home = tempHome()
  // 指向一个几乎肯定没人监听的端口。
  const bot = createAstrbot({ home })
  bot.save({ enabled: true, useForQQ: true, baseUrl: 'http://127.0.0.1:59999', token: 'fw_x', timeoutMs: 1000 })
  const result = await bot.callOneBot('get_login_info', {})
  assert.equal(result.ok, false)
  assert.equal(result.data, null)
  assert.equal(typeof result.error, 'string')
  assert.equal(result.action, 'get_login_info')
})

test('坏掉的配置文件不会让模块崩溃', () => {
  const home = tempHome()
  writeFileSync(join(home, 'fish-world-astrbot.json'), 'this is not json', 'utf8')
  const bot = createAstrbot({ home })
  const view = bot.view()
  assert.equal(view.hasToken, false)
  assert.equal(view.enabled, false)
})

test('save 拒绝非本机的明文 http 地址', () => {
  const home = tempHome()
  const bot = createAstrbot({ home })
  assert.throws(
    () => bot.save({ baseUrl: 'http://evil.example.com' }),
    /https/,
  )
})
