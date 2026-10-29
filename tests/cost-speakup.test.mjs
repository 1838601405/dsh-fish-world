// 「养鱼花费」(/dsh-fish-world/cost) 与「鱼主动开口」(/dsh-fish-world/speak-up) 两条只读路由。
// ⚠ speak-up 路由读的是 paths.mjs 在模块加载时算好的 DSH_HOME，
//    所以必须先设 process.env.DSH_HOME（指向临时目录）再动态 import http.mjs——
//    绝不能碰本机真实的 speak-up 配置文件（AGENTS §6.3：测试不许依赖本机状态）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'fish-world-speakup-'))
process.env.DSH_HOME = fakeHome
const { buildRoutes } = await import('../lib/http.mjs')

test.after(() => {
  try { rmSync(fakeHome, { recursive: true, force: true }) } catch {}
})

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

function routesWith(costMeter) {
  const routes = buildRoutes({ costMeter })
  return Object.fromEntries(routes.map((route) => [route.path, route]))
}

// ---------- /dsh-fish-world/cost ----------

test('cost: 没有 cost-meter 服务时如实报未安装（HTTP 200 + ok:false）', async () => {
  for (const stub of [null, {}, { getState: 'not-a-function' }]) {
    const route = routesWith(stub)['/dsh-fish-world/cost']
    const res = response()
    await route.handler(request(), res)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.error, /未安装 dsh-cost-meter/)
  }
})

test('cost: getState 抛错时如实报错，不编数字', async () => {
  const route = routesWith({ getState: async () => { throw new Error('账本坏了') } })['/dsh-fish-world/cost']
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /账本坏了/)
})

test('cost: 只透出裁剪后的字段，不倒整份 state', async () => {
  const route = routesWith({
    getState: async () => ({
      today: { date: '2026-10-29', input: 111, output: 222, cost: 1.5, apiCost: 1.2, calls: 7, sessions: [{ id: 'x' }] },
      month: { date: '2026-10', input: 999, cost: 20.3, apiCost: 18, calls: 300, sessions: [] },
      total: {
        date: '', cost: 100.6, apiCost: 90, calls: 4000, sessions: [],
        byProviderModel: {
          'deepseek/deepseek-chat': { cost: 50.5, apiCost: 50, calls: 2000, input: 1, output: 2 },
          'volcengine/doubao': { cost: 30.2, apiCost: 30, calls: 800 },
          'qwen/qwen-max': { cost: 20.1, apiCost: 20, calls: 700 },
          'kimi/kimi': { cost: 5, apiCost: 5, calls: 300 },
          'zai/glm': { cost: 3, apiCost: 3, calls: 100 },
          'or/llama': { cost: 1, apiCost: 1, calls: 50 },
        },
      },
      budgetUsed: 12.3,
      balance: { amount: 999, secretToken: 'leak-me-not' },
      history: [{ date: '2026-08-01', cost: 9 }],
      config: { apiKey: 'leak-me-not' },
      meta: { now: 123 },
    }),
  })['/dsh-fish-world/cost']
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  // 只有四个聚合字段 + byModel
  assert.deepEqual(Object.keys(body.cost).sort(), ['budgetUsed', 'byModel', 'month', 'today', 'total'])
  // 桶里只留 date/cost/apiCost/calls —— input/output/sessions 不许跟着出去
  assert.deepEqual(Object.keys(body.cost.today).sort(), ['apiCost', 'calls', 'cost', 'date'])
  assert.equal(body.cost.today.cost, 1.5)
  assert.equal(body.cost.month.calls, 300)
  // byModel 按花费排序、截前 5、每项只留三个数
  assert.equal(body.cost.byModel.length, 5)
  assert.equal(body.cost.byModel[0].model, 'deepseek/deepseek-chat')
  assert.equal(body.cost.byModel[0].cost, 50.5)
  assert.deepEqual(Object.keys(body.cost.byModel[0]).sort(), ['apiCost', 'calls', 'cost', 'model'])
  // 整份 JSON 里不许出现被裁掉的内容
  assert.equal(res.body.includes('leak-me-not'), false)
  assert.equal(res.body.includes('deepseek-chat-below-5'), false)
  assert.equal(res.body.includes('history'), false)
})

test('cost: getState 返回空对象 / 非对象时不炸，给零值桶', async () => {
  for (const stub of [async () => null, async () => 'oops']) {
    const route = routesWith({ getState: stub })['/dsh-fish-world/cost']
    const res = response()
    await route.handler(request(), res)
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.cost.today.cost, 0)
    assert.deepEqual(body.cost.byModel, [])
  }
})

test('cost: 非本机调用被拒绝', async () => {
  const route = routesWith({ getState: async () => ({}) })['/dsh-fish-world/cost']
  const res = response()
  await route.handler(request({ remoteAddress: '192.0.2.4' }), res)
  assert.equal(res.statusCode, 403)
})

// ---------- /dsh-fish-world/speak-up ----------

test('speak-up: 没有配置文件时如实报未安装', async () => {
  const route = routesWith(null)['/dsh-fish-world/speak-up']
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body, { ok: false, installed: false, error: '未安装 dsh-speak-up' })
})

test('speak-up: 只透出白名单键，其余键一律裁掉', async () => {
  const file = join(fakeHome, 'speak-up-config.json')
  writeFileSync(file, JSON.stringify({
    总开关: true,
    试运行: true,
    目标会话: ['session-10000001', 'session-10000002'],
    间隔分钟: 30,
    安静起: 1,
    安静止: 8,
    峰时命中线: 20,
    谷时命中线: 60,
    搭话冷却分钟: 20,
    // 白名单之外：上游以后新增/内部字段不许透出
    触发文案: 'leak-me-not',
    角色: 'developer',
    内部凭据: 'leak-me-not',
  }))
  const route = routesWith(null)['/dsh-fish-world/speak-up']
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.installed, true)
  assert.deepEqual(Object.keys(body.config).sort(), ['安静起', '安静止', '总开关', '试运行', '目标会话', '间隔分钟', '峰时命中线', '谷时命中线', '搭话冷却分钟'].sort())
  assert.equal(body.config.总开关, true)
  assert.equal(body.config.间隔分钟, 30)
  assert.deepEqual(body.config.目标会话, ['session-10000001', 'session-10000002'])
  assert.equal(res.body.includes('leak-me-not'), false)
  assert.equal(res.body.includes('触发文案'), false)
  // 只读承诺：handler 跑完文件一个字节都不能变
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.总开关, true)
  assert.equal(after.触发文案, 'leak-me-not')
})

test('speak-up: 类型不规矩的值被归一（不炸、不照单全收）', async () => {
  const file = join(fakeHome, 'speak-up-config.json')
  writeFileSync(file, JSON.stringify({
    总开关: 'true', // 不是布尔 → 归一成 false（只有真布尔 true 才算开）
    试运行: 1,
    目标会话: 'not-an-array', // 不是数组 → 空数组
    间隔分钟: '45', // 数字字符串 → 数字
    安静起: 'x', // 非数字 → 0
  }))
  const route = routesWith(null)['/dsh-fish-world/speak-up']
  const res = response()
  await route.handler(request(), res)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.config.总开关, false)
  assert.equal(body.config.试运行, false)
  assert.deepEqual(body.config.目标会话, [])
  assert.equal(body.config.间隔分钟, 45)
  assert.equal(body.config.安静起, 0)
})

test('speak-up: 配置文件是坏 JSON 时如实报错', async () => {
  const file = join(fakeHome, 'speak-up-config.json')
  writeFileSync(file, '{ 坏掉的')
  const route = routesWith(null)['/dsh-fish-world/speak-up']
  const res = response()
  await route.handler(request(), res)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.installed, true)
  assert.match(body.error, /读不出来/)
})

test('speak-up: 目标会话超长清单被截断（坏文件也不能整份倒出去）', async () => {
  const file = join(fakeHome, 'speak-up-config.json')
  const many = Array.from({ length: 100 }, (_, i) => `session-${String(i).padStart(8, '0')}`)
  writeFileSync(file, JSON.stringify({ 总开关: true, 目标会话: many }))
  const route = routesWith(null)['/dsh-fish-world/speak-up']
  const res = response()
  await route.handler(request(), res)
  const body = res.json()
  assert.equal(body.config.目标会话.length, 16)
})

test('speak-up: 非本机调用被拒绝', async () => {
  const route = routesWith(null)['/dsh-fish-world/speak-up']
  const res = response()
  await route.handler(request({ remoteAddress: '192.0.2.4' }), res)
  assert.equal(res.statusCode, 403)
})

test('两条路由都注册进了 buildRoutes 且文件确实没被写过', async () => {
  const routes = routesWith(null)
  assert.ok(routes['/dsh-fish-world/cost'])
  assert.ok(routes['/dsh-fish-world/speak-up'])
  // 临时目录里只该有我们写的 speak-up-config.json，路由不该创建任何新文件
  const only = ['speak-up-config.json']
  for (const name of readdirSync(fakeHome)) {
    assert.ok(only.includes(name), `路由不该往 DSH_HOME 写文件：${name}`)
  }
  assert.ok(existsSync(fakeHome))
})
