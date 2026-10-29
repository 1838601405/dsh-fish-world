import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAdapter } from '../lib/index.js'
import { createConfigStore } from '../lib/config.mjs'

test('Qzone timer only queues a diary prompt to the owner agent, with persistent cooldown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-world-qzone-timer-'))
  const workspace = join(home, 'workspace')
  const ownerSession = 'session-owner-12345678'
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(home, 'plugin-ecosystem', 'skills'), { recursive: true })
  mkdirSync(join(home, 'plugin-ecosystem', 'plugins'), { recursive: true })
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({
    目标会话: ownerSession,
    私聊QQ: '12345678',
    总开关: true,
    试运行: true,
    NapCat: 'http://127.0.0.1:3000',
  }))

  const timers = []
  const followups = []
  const flushed = []
  const agents = {
    get(id) {
      return id === ownerSession ? {
        id: ownerSession,
        session: { id: ownerSession },
        async followup(message) { followups.push(message) },
      } : undefined
    },
  }
  const sessions = { async flush(session) { flushed.push(session.id) } }
  const services = {
    workspaceRegistry: { list: () => [{ path: workspace, sessionIds: [ownerSession] }] },
    sessions,
    agents,
  }
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    webServer: { register() { return () => {} } },
    get(key) { return services[key] },
    interval(fn, ms) { timers.push({ fn, ms }); return () => {} },
    inject() {},
    on() { return () => {} },
    effect(fn) { return fn() },
  }
  const store = createConfigStore({ home })
  store.saveConfig({ extensionDirs: [join(home, 'plugin-ecosystem', 'skills'), join(home, 'plugin-ecosystem', 'plugins')] })
  const adapter = createAdapter(ctx, { home, configStore: store })
  try {
    // 现在有两条计时器：diary 提醒（15 分钟）+ 每日记忆摘要（10 分钟）。
    // 顺序即注册顺序：diary 先（它在这次改动之前就在），digest 后。
    assert.equal(timers.length, 2)
    assert.equal(timers[0].ms, 15 * 60 * 1000)
    assert.equal(timers[1].ms, 10 * 60 * 1000, '记忆摘要计时器每 10 分钟检查一次日期变更')
    const stateFile = join(adapter.world.root(), '安全与审计', 'qzone-actions.json')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.createdAt = Date.now() - 25 * 60 * 60 * 1000
    writeFileSync(stateFile, JSON.stringify(state))

    timers[0].fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(followups.length, 1)
    assert.equal(followups[0].source.kind, 'system')
    assert.match(followups[0].content[0].text, /qzone-diary/)
    assert.deepEqual(flushed, [ownerSession])

    timers[0].fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(followups.length, 1, 'cooldown prevents duplicate reminder turns')
  } finally {
    await adapter.dispose()
  }
})
