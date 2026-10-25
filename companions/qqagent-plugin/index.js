// QQ-agent 一侧的「借手」配套插件（最小实现）。
//
// 作用：把 QQ-agent 里注册的插件工具，用一条只监听本机的小 HTTP 接口交出去，
// 让 DSH 那边的鱼能"借手"——执行工具、拿原始结果，但说话仍由鱼自己来。
//
// 契约（和 AstrBot 桥一致，DSH 侧已实现并有测试）：
//   GET  /health -> { ok:true, version, account? }
//   GET  /tools  -> { ok:true, tools:[{ name, description }] }
//   POST /tool   -> { ok:true, output:"..." } | { ok:false, error:"..." }
//   除 /health 外都要 Authorization: Bearer <token>
//
// ⚠️ 未验证：本机没装 QQ-agent，这个文件是按契约写的骨架，**宿主侧的注册方式要按
// QQ-agent 实际版本补**（见下面 registerTools 的 TODO）。HTTP 那一半是照 DSH 侧测过的契约写的。
import http from 'node:http'

export const name = 'fishworld-borrow'
export const description = '把本机的插件工具借给 DSH 里的鱼（只借手，不借嘴）'

const PORT = Number(process.env.FISHWORLD_BRIDGE_PORT || 3211)
const TOKEN = String(process.env.FISHWORLD_BRIDGE_TOKEN || '')

/** 工具表：name -> { description, run(params) } */
const tools = new Map()

/**
 * TODO(宿主侧)：按 QQ-agent 的插件 API 把它的工具注册进来。
 * 目前留一个示例工具，方便先连通再替换。
 */
export function registerTools(registry) {
  tools.set('echo', {
    description: '回声（示例工具，装好后可以删）',
    async run(params) { return 'echo: ' + JSON.stringify(params || {}) },
  })
  if (registry && typeof registry.list === 'function') {
    for (const item of registry.list()) {
      tools.set(item.name, { description: item.description || '', run: item.run })
    }
  }
}

function reply(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export function createServer() {
  if (!TOKEN) throw new Error('没有设置 FISHWORLD_BRIDGE_TOKEN，拒绝启动')
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      return reply(res, 200, { ok: true, version: '0.1.0', tools: tools.size })
    }
    const auth = String(req.headers.authorization || '')
    if (auth !== 'Bearer ' + TOKEN) return reply(res, 401, { ok: false, error: 'token 不对' })
    if (req.method === 'GET' && url.pathname === '/tools') {
      return reply(res, 200, { ok: true, tools: [...tools].map(([name, item]) => ({ name, description: item.description })) })
    }
    if (req.method === 'POST' && url.pathname === '/tool') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch { return reply(res, 400, { ok: false, error: 'body 不是 JSON' }) }
        const tool = tools.get(String(parsed.name || ''))
        if (!tool) return reply(res, 404, { ok: false, error: '没有这个工具：' + String(parsed.name || '') })
        try {
          const output = await tool.run(parsed.params && typeof parsed.params === 'object' ? parsed.params : {})
          reply(res, 200, { ok: true, output: String(output == null ? '' : output) })
        } catch (error) {
          reply(res, 200, { ok: false, error: String((error && error.message) || error).slice(0, 200) })
        }
      })
      return undefined
    }
    return reply(res, 404, { ok: false, error: '没有这个路由' })
  })
}

export function start() {
  const server = createServer()
  server.listen(PORT, '127.0.0.1', () => { console.log('[fishworld-borrow] 监听 http://127.0.0.1:' + PORT) })
  return server
}
