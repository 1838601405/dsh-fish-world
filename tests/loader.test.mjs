import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBus } from '../lib/bus.mjs'
import { createConfigStore } from '../lib/config.mjs'
import { createLoader } from '../lib/loader.mjs'

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'qce-loader-'))
  const plugins = join(home, 'plugin-ecosystem', 'plugins')
  mkdirSync(plugins, { recursive: true })
  const store = createConfigStore({ home })
  store.saveConfig({ extensionDirs: [plugins], forceDisabledByDefault: false, loadEnabledByDefault: true })
  return { home, plugins, store }
}

function writeExtension(root, id, manifest, code) {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, ...manifest }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), code, 'utf8')
  return dir
}

function fakeHost() {
  const tools = new Map()
  const qq = {
    sent: [],
    snapshot: () => ({ masterSwitch: true, trial: false, privateQQ: '10001', group: '', toPrivate: true, toGroup: false, napCat: 'http://127.0.0.1:3000' }),
    send: async (chatKey, segments) => { qq.sent.push({ chatKey, segments }); return { ok: true, sent: [{ kind: 'private', id: 10001, ok: true }], failed: [] } },
    sendTextBatch: async (chatKey, texts) => { qq.sent.push({ chatKey, texts }); return { ok: true, sent: [{ kind: 'private', id: 10001, ok: true }], failed: [] } },
    sendImage: async () => ({ ok: true, sent: [], failed: [] }),
    sendSticker: async () => ({ ok: true, sent: [], failed: [] }),
    poke: async () => ({ ok: true }),
    recent: async () => ({ ok: true, messages: [] }),
    call: async () => ({ ok: true, data: [] }),
  }
  const whale = {
    stickers: () => [{ id: 's1', name: '贴纸', path: 'C:/x.png' }],
    findSticker: (id) => ({ id, name: '贴纸' }),
    currentRole: () => ({ id: 'default', name: '小鲸鱼' }),
    persona: () => ({ role: { id: 'default', name: '小鲸鱼' }, usage: { balance: 1, currency: 'CNY' }, quips: [], text: '角色：小鲸鱼' }),
    summary: () => ({ current: { name: '小鲸鱼' }, usage: { balance: 1, currency: 'CNY' } }),
  }
  const dshTools = {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  }
  return { tools, qq, whale, dshTools }
}

function makeLoader(ctx) {
  const { home, store } = ctx
  return createLoader({
    configStore: store,
    bus: createBus(),
    qq: ctx.qq,
    whale: ctx.whale,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dshTools: ctx.dshTools,
    defaultChatKey: () => 'private:10001',
  })
}

test('加载 0.5 扩展并注册可执行工具', async () => {
  const ctx = setupHome()
  writeExtension(ctx.plugins, 'demo', {
    kind: 'plugin',
    apiVersion: 1,
    enabledByDefault: true,
    permissions: ['qq.send'],
    settings: { greeting: '你好' },
  }, `
export default {
  setup(ctx) {
    ctx.registerTool({
      id: 'echo',
      name: '回显',
      description: '回显输入',
      params: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      async handler({ text }) {
        const greeting = ctx.config.get('greeting')
        return { content: greeting + '：' + text, echoed: text }
      },
    })
  },
}
`)
  Object.assign(ctx, fakeHost())
  const loader = makeLoader(ctx)
  await loader.reload()
  const record = loader.get('demo')
  assert.equal(record.status, 'loaded')
  const tool = [...ctx.tools.values()].find((item) => item.name.includes('demo') && item.name.includes('echo'))
  assert.ok(tool, '工具应已注册')
  const value = await tool.execute({ text: '世界' })
  assert.equal(value.ok, true)
  assert.equal(value.content, '你好：世界')
})

test('0.4 旧扩展：parameters + execute(ctx,args) + 可调用 log/config', async () => {
  const ctx = setupHome()
  writeExtension(ctx.plugins, 'legacy', {
    kind: 'skill',
    apiVersion: 1,
    enabledByDefault: true,
    permissions: ['web_fetch'],
    settings: { prefix: '旧' },
  }, `
export default {
  setup(api) {
    api.log('legacy 装载 %s', 'ok')
    const cfg = api.config()
    api.registerTool({
      id: 'legacy_echo',
      name: '旧版回显',
      description: '旧版工具',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute(context, args) {
        return '前缀=' + (cfg.prefix || '') + ' 文本=' + args.text
      },
    })
  },
}
`)
  Object.assign(ctx, fakeHost())
  const loader = makeLoader(ctx)
  await loader.reload()
  assert.equal(loader.get('legacy').status, 'loaded')
  const tool = [...ctx.tools.values()].find((item) => item.name.includes('legacy_echo'))
  assert.ok(tool)
  const value = await tool.execute({ text: 'A' })
  assert.equal(value.ok, true)
  assert.match(value.content, /前缀=旧/)
})

test('enabledByDefault=false 默认停用，启用后加载', async () => {
  const ctx = setupHome()
  writeExtension(ctx.plugins, 'off', {
    kind: 'plugin',
    apiVersion: 1,
    enabledByDefault: false,
  }, `
export default { setup(ctx) { ctx.log.info('loaded') } }
`)
  Object.assign(ctx, fakeHost())
  const loader = makeLoader(ctx)
  await loader.reload()
  assert.equal(loader.get('off').status, 'disabled')
  await loader.setEnabled('off', true)
  assert.equal(loader.get('off').status, 'loaded')
  await loader.setEnabled('off', false)
  assert.equal(loader.get('off').status, 'disabled')
})

test('没声明 qq.send 的扩展调用 ctx.send 会明确报错', async () => {
  const ctx = setupHome()
  writeExtension(ctx.plugins, 'nosend', {
    kind: 'skill',
    apiVersion: 1,
    enabledByDefault: true,
    permissions: [],
  }, `
export default {
  setup(ctx) {
    ctx.registerTool({
      id: 'try_send',
      name: '尝试发送',
      description: '应被权限拒绝',
      params: { type: 'object', properties: {}, additionalProperties: false },
      async handler() { await ctx.send('', [{ type: 'text', text: 'x' }]); return { content: '不应该到这里' } },
    })
  },
}
`)
  Object.assign(ctx, fakeHost())
  const loader = makeLoader(ctx)
  await loader.reload()
  const tool = [...ctx.tools.values()].find((item) => item.name.includes('try_send'))
  const value = await tool.execute({})
  assert.equal(value.ok, false)
  assert.match(value.content, /qq\.send/)
})

test('扩展 prompt 进入系统提示词', async () => {
  const ctx = setupHome()
  writeExtension(ctx.plugins, 'prompted', {
    kind: 'skill',
    apiVersion: 1,
    enabledByDefault: true,
    prompt: { sections: [{ id: 'p1', title: '规则', content: '发 QQ 前先想清楚。', priority: 60 }] },
  }, `export default { setup(ctx) { ctx.prompt.add({ id: 'p2', content: '不要刷屏。' }) } }`)
  Object.assign(ctx, fakeHost())
  const loader = makeLoader(ctx)
  await loader.reload()
  const text = loader.promptText()
  assert.match(text, /发 QQ 前先想清楚/)
  assert.match(text, /不要刷屏/)
})

test('扩展设置按清单 schema 保存，密钥只返回 hasSecret 并可显式清除', async () => {
  const ctx = setupHome()
  writeExtension(ctx.plugins, 'settings-demo', {
    kind: 'plugin',
    apiVersion: 1,
    enabledByDefault: false,
    settings: { label: '初始', token: '' },
    configSchema: {
      label: { type: 'string', label: '显示名' },
      token: { type: 'string', label: '服务密钥', secret: true },
      enabled: { type: 'boolean', label: '内部开关' },
    },
  }, `export default { setup() {} }`)
  Object.assign(ctx, fakeHost())
  const loader = makeLoader(ctx)
  await loader.reload()

  const saved = loader.saveExtensionSettings('settings-demo', { label: '已经设置', token: 'private-token', enabled: true })
  assert.equal(saved.settings.label, '已经设置')
  assert.equal(saved.settings.token, '')
  assert.equal(saved.hasSecrets.token, true)
  assert.equal(JSON.stringify(saved).includes('private-token'), false)
  assert.throws(() => loader.saveExtensionSettings('settings-demo', { notDeclared: true }), /未在 configSchema 声明/)

  const cleared = loader.saveExtensionSettings('settings-demo', {}, ['token'])
  assert.equal(cleared.hasSecrets.token, false)
})
