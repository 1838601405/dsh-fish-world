import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createAdapter } from '../lib/index.js'
import { createConfigStore } from '../lib/config.mjs'

function fakeCtx() {
  const tools = new Map()
  const routes = []
  const injected = []
  const sections = []
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    on(name, fn) {
      handlers.set(name, fn)
      return () => {}
    },
    effect(fn) { return fn() },
    inject(names, callback) {
      injected.push({ names, callback })
      if (names.includes('systemPrompt')) callback({ systemPrompt: ctx.systemPrompt })
      if ((names.length > 1 && names.includes('tools') && names.includes('fs')) || names.includes('attachments')) callback(ctx)
      return () => {}
    },
  }
  return { ctx, tools, routes, sections, handlers, injected }
}

test('createAdapter 挂上工具 / 路由 / 提示词，并能旁听 QQ 消息', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-adapter-'))
  const plugins = join(home, 'plugin-ecosystem', 'plugins')
  mkdirSync(plugins, { recursive: true })
  cpSync(new URL('../examples/hello-qq', import.meta.url), join(plugins, 'hello-qq'), { recursive: true })

  const store = createConfigStore({ home })
  store.saveConfig({ extensionDirs: [plugins] })
  store.setEnabled('hello-qq', true)
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: true, 转私聊: true, 私聊QQ: '10001', 转群: false, 群号: '', NapCat: 'http://127.0.0.1:3000',
  }), 'utf8')

  const { ctx, tools, routes, sections, handlers, injected } = fakeCtx()
  const adapter = createAdapter(ctx, { home, configStore: store })
  await adapter.reload()

  assert.ok(adapter.loader.get('hello-qq'), '示例扩展应被发现')
  assert.equal(adapter.loader.get('hello-qq').status, 'loaded')
  assert.ok([...tools.keys()].some((name) => name === 'qq_ecosystem'))
  assert.ok([...tools.keys()].some((name) => name === 'fish_world'))
  assert.ok([...tools.keys()].some((name) => name.includes('hello-qq')))
  assert.ok(routes.some((route) => route.path === '/dsh-fish-world/state'))
  assert.ok(routes.some((route) => route.path === '/dsh-fish-world/env'), '环境检查要有本机路由')
  assert.ok(routes.some((route) => route.path === '/dsh-fish-world/capabilities'))
  assert.ok(injected.some((entry) => entry.names.includes('attachments')), '动图核心应等待附件服务挂载')
  // 0.3.0：旧 HTML 面板（panel.js / settings）整块下线，面板只剩新版 Flutter 静态路由。
  assert.ok(routes.some((route) => route.path === '/dsh-fish-world/fishworld'), '新版 Flutter 面板要有 prefix 静态路由')
  assert.ok(!routes.some((route) => route.path === '/dsh-fish-world/panel.js'), '旧 panel.js 路由不该再注册')
  assert.ok(!routes.some((route) => route.path === '/dsh-fish-world/settings'), '旧 settings 路由不该再注册')
  assert.ok(sections.some((section) => section.name === 'fish-world'))
  assert.match(sections[0].text(), /发到 QQ/)
  assert.match(sections[0].text(), /空间属于鱼自己/, '提示词要说明空间归属鱼自己，不是主人的空间')
  assert.match(sections[0].text(), /日记是鱼自己写的/, '提示词要说明日记由鱼自己写，主人只浏览审批')
  assert.match(sections[0].text(), /【运行环境】/, '临时 home 没装前置插件，提示词要提醒安装')
  assert.match(sections[0].text(), /dsh plugin --profile/, '提醒里要带可执行的安装命令')

  const envTool = tools.get('fish_world')
  const envCheck = await envTool.execute({ action: 'env-check' })
  assert.equal(envCheck.ok, false)
  assert.match(envCheck.content, /未安装依赖/)
  assert.ok(envCheck.environment.missing.includes('dsh-qq-bridge'))
  const bridgeMissing = await envTool.execute({ action: 'qq-status' })
  assert.equal(bridgeMissing.ok, false)
  assert.match(bridgeMissing.error, /dsh-qq-bridge/)
  assert.match(bridgeMissing.error, /dsh plugin --profile desktop add github:Yuuyuko-uu\/dsh-qq-bridge/)

  const healthRoute = routes.find((route) => route.path === '/dsh-fish-world/health')
  const healthResponse = { status: 0, body: '', writeHead(code) { this.status = code }, end(text) { this.body = String(text) } }
  await healthRoute.handler({ method: 'GET' }, healthResponse)
  assert.equal(healthResponse.status, 200)
  assert.equal(JSON.parse(healthResponse.body).environment.ok, false, 'health 带脱敏的环境视图')

  const seen = []
  adapter.bus.on('message.in', (message) => seen.push(message))

  // 0.3.0：webserver/index-inject 浮动面板注入已随旧面板下线（面板只在 iframe 里），
  // 这里改成反向断言：hook 不该再注册，宿主页面不会被追加任何脚本。
  assert.equal(handlers.get('webserver/index-inject'), undefined, '旧面板的浮动注入不该再注册')

  const handler = handlers.get('session/event')
  handler({ id: 'session-1' }, {
    type: 'user/message',
    data: { id: 'm1', source: { kind: 'qq' }, content: [{ type: 'text', text: '在吗' }] },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, '在吗')
  assert.equal(seen[0].chatKey, 'private:10001')

  // 非 QQ 来源不触发
  handler({ id: 'session-1' }, {
    type: 'user/message',
    data: { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '本地输入' }] },
  })
  assert.equal(seen.length, 1)

  // 没有 owner session execution context 时，状态详情 fail closed
  const statusTool = tools.get('qq_ecosystem')
  const status = await statusTool.execute({ action: 'status' })
  assert.equal(status.ok, false)
  assert.match(status.error, /主人/)

  await adapter.dispose()
  assert.equal(adapter.loader.get('hello-qq'), undefined)
})

test('apply(ctx) works with no options: host never passes a home', () => {
  // Regression: apply(ctx) used to pass home=undefined into createStickers,
  // which threw on join() before routes/tools were registered. The desktop host
  // calls apply(ctx) with no arguments, so this exact path must stay working.
  const home = mkdtempSync(join(tmpdir(), 'fish-world-nohome-'))
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href
  const script = `
    const routes = []
    const tools = []
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tools: { register(tool) { tools.push(tool.name); return () => {} } },
      webServer: { register(route) { routes.push(route.path); return () => {} } },
      inject() {},
      on() { return () => {} },
      effect(fn) { return fn() },
    }
    const { apply } = await import(${JSON.stringify(moduleUrl)})
    const adapter = apply(ctx)
    if (!routes.includes('/dsh-fish-world/fishworld')) throw new Error('fishworld route missing: ' + routes.join(','))
    if (!tools.includes('fish_world')) throw new Error('fish_world tool missing: ' + tools.join(','))
    await adapter.dispose()
    console.log('ok:' + routes.length + ':' + tools.length)
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert.match(output, /ok:\d+:\d+/)
})

test('fish world ships a sidebar entry and no duplicate settings row', () => {
  // 入口策略变更：左侧栏是主入口（sidebar.panellist + main），
  // 设置列表里不再重复注册同一条，避免用户看到两个「鱼的世界」。
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')

  assert.match(source, /slots\.inject\('sidebar\.panellist'/, '必须有左侧栏入口')
  assert.match(source, /slots\.inject\('main'/, '必须有主区域整页面板')
  assert.match(source, /key: 'fish-world'/, '主面板 key 要与侧栏 id 配对')
  assert.doesNotMatch(source, /slots\.inject\('settings\.section'/, '设置列表里不应重复注册')
  // 旧的隐藏状态仍要自愈，否则残留的 showSettings=0 会让人以为入口丢了
  assert.match(source, /showSettings'\) === '0'/, '旧的隐藏状态应被自动纠正')
})

test('前置插件装齐且接线正常时，启动与提示词都不再提醒', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-world-env-ok-'))
  const profileDir = join(home, 'profiles', 'desktop')
  const modules = join(profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const pluginRoot = join(import.meta.dirname, '..')
  symlinkSync(pluginRoot, join(modules, 'dsh-fish-world'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-fish-world': 'link:' + pluginRoot.replace(/\\/g, '/') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-fish-world'] } },
  }, null, 2), 'utf8')
  for (const name of ['dsh-qq-bridge', 'dsh-feiyu-mood', 'dsh-fish-memory', 'dsh-bili-whale', 'dsh-bili-subagent']) {
    const dir = join(modules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }), 'utf8')
  }

  const warnings = []
  const { ctx, routes, sections } = fakeCtx()
  ctx.logger = { info() {}, warn: (line) => warnings.push(String(line)), error() {}, debug() {} }
  const adapter = createAdapter(ctx, { home })
  assert.equal(adapter.environment.status().ok, true, adapter.environment.status().warnings.join('\n'))
  assert.deepEqual(warnings, [], '环境正常时启动不应写警告')
  assert.doesNotMatch(sections[0].text(), /【运行环境】/, '装齐后提示词里不再出现安装提醒')

  const envRoute = routes.find((route) => route.path === '/dsh-fish-world/env')
  const response = { status: 0, body: '', writeHead(code) { this.status = code }, end(text) { this.body = String(text) } }
  await envRoute.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, response)
  assert.equal(response.status, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.environment.ok, true)
  assert.equal(payload.environment.missing.length, 0)

  await adapter.dispose()
})
