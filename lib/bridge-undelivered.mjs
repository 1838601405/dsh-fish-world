import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// 桥侧兜底：让 fish-world 看见「桥投不进去的那些消息」。
//
// 背景（2026-11-20 主人指出）：
//   `dsh-qq-bridge` 负责把 QQ 消息转进 DSH 会话。它投不进去时（会话关着、
//   或者消息超窗）会直接丢掉，且只写自己的日志——
//   而主人私聊走的就是桥这条路，所以 **fish-world 的 delivery-router 完全看不到**，
//   那条「会话优先、不在就 API」的兜底对主人私聊根本不生效。
//
// 这一层做的事：
//   1. 读桥的 `/dsh-qq-bridge/state`，拿「未投队列」（桥那边 2026-11-20 新增的 `未投` 字段）；
//   2. 给面板/调用方一个「有 N 条没投出去」的视图；
//   3. 能触发桥的 `/dsh-qq-bridge/redeliver` 手动补投。
//
// ★ 这一层**不自己发消息**：补投是让桥把它自己攒的那条投进会话，
//   走原路（人设/上下文/记忆都在），而不是我们另造一条回复。
//   这样「一条消息只被回一次」的约定不会被这里打破。

/** 桥的默认本机地址（DSH webServer 端口由调用方给）。 */
const STATE_PATH = '/dsh-qq-bridge/state'
const REDELIVER_PATH = '/dsh-qq-bridge/redeliver'

function numOr(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * 从桥的状态文件读未投队列（**首选路径**）。
 *
 * 为什么不走 HTTP：插件拿不到宿主 webServer 的端口，靠猜端口会让这条链路随时断；
 * 而桥的状态文件本来就在 DSH_HOME 里（qq-bridge-state.json，它自己也在用），
 * fish-world 和桥跑在同一个进程/同一个目录下，直接读文件最可靠。
 *
 * @param {string} stateFile 桥的状态文件绝对路径
 */
export function readBridgeStateFile(stateFile) {
  const empty = {
    ok: true, items: [], count: 0,
    bridgeStartedAt: 0, exemptMinutes: 30,
    supportsQueue: false, source: 'file', error: '', exists: false
  }
  const f = String(stateFile || '').trim()
  if (!f) return { ...empty, ok: false, error: '没有桥状态文件路径', source: 'none' }
  try {
    if (!existsSync(f)) return { ...empty, source: 'file' }
    const raw = JSON.parse(readFileSync(f, 'utf8')) || {}
    const items = Array.isArray(raw['未投队列']) ? raw['未投队列'] : []
    return {
      ok: true,
      exists: true,
      items: items.map((x) => ({
        id: String(x.id || ''),
        atMs: numOr(x['时间'], 0) * 1000,
        ageSec: numOr(x['秒'], 0),
        text: String(x['文字'] || ''),
        nickname: String(x['昵称'] || ''),
        qq: numOr(x['号码'], 0),
        reason: String(x['原因'] || ''),
        receivedAtMs: numOr(x['收到于'], 0)
      })),
      count: items.length,
      bridgeStartedAt: numOr(raw['桥启动于'], 0) || 0,
      exemptMinutes: numOr(raw['重启豁免分'], 30),
      supportsQueue: Object.prototype.hasOwnProperty.call(raw, '未投队列'),
      source: 'file',
      error: ''
    }
  } catch (error) {
    return { ...empty, ok: false, exists: true, error: String(error?.message || error), source: 'file' }
  }
}

/**
 * @param {object} opts
 * @param {() => string} opts.baseUrl  取 DSH webServer 的 base（如 http://127.0.0.1:54819）
 * @param {(url, init) => Promise<any>} [opts.fetchJson]  注入以便单测
 * @param {(line:string)=>void} [opts.log]
 * @param {() => number} [opts.now]
 */
export function createBridgeUndelivered({ baseUrl, fetchJson, log, stateFile, appData, fileFirst = true, now = () => Date.now() } = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  const call = typeof fetchJson === 'function' ? fetchJson : undefined

  async function request(path, body) {
    const base = String(typeof baseUrl === 'function' ? baseUrl() : baseUrl || '').replace(/\/+$/, '')
    if (!base) return { ok: false, error: '没有 DSH 地址' }
    const url = base + path
    if (call) {
      // ★ 注入的实现也可能抛（网络错/超时）——
      //   这一层是面板路径，绝不能把异常冒到调用方把界面弄崩。
      try { return await call(url, body) } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    }
    // 默认实现：本机 loopback，超时短（这是面板路径，不该拖住任何事）
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      })
      const text = await res.text()
      try { return JSON.parse(text) } catch { return { ok: false, error: '返回不是 JSON' } }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 读桥的未投队列。
   * 返回 { ok, items: [...], count, bridgeStartedAt, exemptMinutes, error }
   *
   * ★ 「桥没装 / 版本旧没有这个字段」都算正常：返回 ok:true + count:0，
   *   不把「上游没这个能力」当成错误刷屏。
   */
  /** 桥状态文件路径：显式给的优先，否则按 DSH_HOME / %APPDATA% 推。 */
  function resolveStateFile() {
    const f = String(typeof stateFile === 'function' ? stateFile() : stateFile || '').trim()
    if (f) return f
    const home = String(appData || process.env.DSH_HOME || '').trim()
    if (home) return join(home, 'qq-bridge-state.json')
    return ''
  }

  async function status() {
    // ★ 先读文件：插件拿不到宿主 webServer 端口，HTTP 那条路随时会断；
    //   桥自己的状态文件就在 DSH_HOME 里，和 fish-world 同一个目录树，最可靠。
    const file = fileFirst ? resolveStateFile() : ''
    if (file) {
      const fromFile = readBridgeStateFile(file)
      // 文件读到了就用（哪怕队列是空的）
      if (fromFile.ok && fromFile.exists) return fromFile
      // 文件不存在 / 读坏了 → 退回 HTTP 试一次，别直接放弃
    }
    const raw = await request(STATE_PATH)
    if (!raw || raw.ok === false) {
      return { ok: false, items: [], count: 0, error: String(raw?.说 || raw?.error || '读不到桥状态') }
    }
    const items = Array.isArray(raw.未投) ? raw.未投 : []
    return {
      ok: true,
      items: items.map((x) => ({
        id: String(x.id || ''),
        atMs: numOr(x.时间, 0) * 1000,
        ageSec: numOr(x.秒, 0),
        text: String(x.文字 || ''),
        nickname: String(x.昵称 || ''),
        qq: numOr(x.号码, 0),
        reason: String(x.原因 || ''),
        receivedAtMs: numOr(x.收到于, 0)
      })),
      count: items.length,
      bridgeStartedAt: numOr(raw.桥启动于, 0) || 0,
      exemptMinutes: numOr(raw.重启豁免分, 30),
      // 桥的版本/能力标记：没有 未投 字段就说明是老版本
      supportsQueue: Object.prototype.hasOwnProperty.call(raw, '未投')
    }
  }

  /** 面板文案：一句话说清现在有没有没投出去的消息。 */
  async function summaryText() {
    const s = await status()
    if (!s.ok) return ''
    if (!s.supportsQueue) return ''
    if (!s.count) return ''
    const first = s.items[s.items.length - 1]
    const 摘要 = first && first.text ? String(first.text).slice(0, 20) : ''
    return `有 ${s.count} 条消息没投出去${摘要 ? '（最早一条：' + 摘要 + '…）' : ''}`
  }

  /**
   * 手动补投。
   * @param {object} [opts] { id } 或 { all: true }
   */
  async function redeliver(opts = {}) {
    const body = opts.all === true ? { 全部: true } : { id: String(opts.id || '') }
    if (!body.全部 && !body.id) return { ok: false, error: '要给 id 或 all:true' }
    const raw = await request(REDELIVER_PATH, body)
    if (!raw) return { ok: false, error: '桥没有返回' }
    return {
      ok: raw.ok !== false,
      results: Array.isArray(raw.结果) ? raw.结果 : [],
      remaining: numOr(raw.还剩, -1),
      error: raw.ok === false ? String(raw.说 || '补投失败') : ''
    }
  }

  return { status, summaryText, redeliver, STATE_PATH, REDELIVER_PATH }
}
