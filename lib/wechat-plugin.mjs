// 微信：dsh-wechat-plugin 的只读状态。
//
// 微信这边鱼世界**没有**自己的协议实现，也不代管人格与登录：
//   · 收发、扫码、绑定账号、人格与行为全在 `dsh-wechat-plugin` 自己那里
//     （正规 DSH 插件，入口 lib/host.js，设置页在「设置 → 微信」，改完立即生效）；
//   · 它把路由注册在 DSH 自己的 webServer 上，前缀 `/.dsh-wechat-plugin`：
//       GET  /.dsh-wechat-plugin/status       当前通道状态
//       POST /.dsh-wechat-plugin/toggle       开关通道（鱼世界不调）
//       GET  /.dsh-wechat-plugin/login        登录任务状态（含二维码）
//       POST /.dsh-wechat-plugin/login/start  开始扫码（鱼世界不调）
//   · 协议是腾讯 iLink / ClawBot，支持多账号绑定；一个微信可以对应多个 DSH 会话。
//
// 所以这个模块只做三件只读的事：
//   ① 插件装没装、版本多少（resolveDependency，只看本机）；
//   ② DSH 的地址拿不拿得到（getOrigin 由 index.js 传 ctx.webServer.getOrigin）；
//   ③ GET 一次 /.dsh-wechat-plugin/status（1.5 秒超时）拿通道开关 / 连接 / 账号。
//
// 铁律：不写任何文件、不调 POST /toggle 或 /login/*、不打印 token 或账号明文。
// 读不到就如实说读不到，不用默认值冒充「读到了」（AGENTS §0③）。
import { detectProfile, resolveDependency } from './env.mjs'

/** 微信通道插件（npm 包名；仓库 xcisxc29/dsh-wechat）。 */
export const WECHAT_PLUGIN = 'dsh-wechat-plugin'

/** 插件自己在 DSH webServer 上注册的状态接口（只读）。 */
export const STATUS_ROUTE = '/.dsh-wechat-plugin/status'

const STATUS_TIMEOUT_MS = 1500

/** 安装命令：面板与提示词都从这里取，别各写一份。 */
export function installCommand(profile = 'desktop') {
  return `dsh plugin --profile ${profile || 'desktop'} add ${WECHAT_PLUGIN}`
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function text(value, max = 120) {
  if (value == null) return ''
  return String(value).trim().slice(0, max)
}

/**
 * 把 getOrigin 的返回值收敛成可用的 base URL。
 * 只认 http(s) 的绝对地址；拿不到 / 不是字符串 / 协议不对都回 ''（调用方据此说「取不到地址」）。
 */
export function normalizeOrigin(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

/** 账号只留「叫人看得懂」的字段：名字、标识、连接状态；其余一概不带出去。 */
function normalizeAccount(item) {
  if (typeof item === 'string') return { name: text(item, 80), id: '', connected: null }
  const src = asObject(item) || {}
  const name = text(src.name || src.nickname || src.alias || src.remark, 80)
  const id = text(src.id || src.uin || src.wxid || src.userId, 80)
  const connected = typeof src.connected === 'boolean'
    ? src.connected
    : (typeof src.online === 'boolean' ? src.online : null)
  return { name, id, connected }
}

/**
 * probe 的两种形状都认：
 *   · 默认探针：{ reachable, status, body, error }
 *   · 替身：直接给 body（{ enabled, connected, accounts }）——视为可达、HTTP 200
 */
function normalizeProbe(raw) {
  const src = asObject(raw) || {}
  const shaped = 'reachable' in src || 'body' in src || 'status' in src
  const body = shaped ? asObject(src.body) || {} : src
  const status = shaped ? Number(src.status) || 0 : 200
  const reachable = shaped ? src.reachable === true : true
  // 有些实现把真正的状态包一层 data：只在顶层确实没有这些字段时才拆。
  const inner = asObject(body.data)
  const flat = inner
    && body.enabled === undefined
    && body.connected === undefined
    && body.accounts === undefined
    ? inner
    : body
  const accountsRaw = Array.isArray(flat.accounts)
    ? flat.accounts
    : (asObject(flat.account) ? [flat.account] : [])
  return {
    reachable,
    status,
    enabled: typeof flat.enabled === 'boolean' ? flat.enabled : null,
    connected: typeof flat.connected === 'boolean' ? flat.connected : null,
    accounts: accountsRaw.map(normalizeAccount),
    error: shaped ? text(src.error, 200) : '',
  }
}

/** 默认探针：只发一个 GET，1.5 秒超时，不做任何写操作。 */
async function defaultProbe({ url } = {}) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return {
      reachable: response.ok === true,
      status: response.status,
      body,
      error: response.ok ? '' : `HTTP ${response.status}`,
    }
  } catch (error) {
    const name = String(error?.name || '')
    return {
      reachable: false,
      status: 0,
      body: null,
      error: name === 'TimeoutError' || name === 'AbortError' ? '请求超时' : String(error?.message || error),
    }
  }
}

function channelState({ enabled, connected, accounts }) {
  const parts = []
  parts.push(enabled === true ? '通道已启用' : (enabled === false ? '通道已停用' : '通道开关未知'))
  parts.push(connected === true ? '已连接' : (connected === false ? '未连接' : '连接状态未知'))
  parts.push(accounts.length ? `绑定 ${accounts.length} 个账号` : '还没有绑定账号')
  return parts.join('，')
}

function noteOf({ installed, version, profile, origin, probeInfo }) {
  if (!installed) {
    return `还没安装 ${WECHAT_PLUGIN}。装它：${installCommand(profile)}；装完重启 DSH。`
  }
  if (!origin) {
    return `${WECHAT_PLUGIN} ${version} 已装，但拿不到 DSH 的地址（宿主 webServer 未就绪），状态接口没法探；重启 DSH 后再看。`
  }
  if (probeInfo.status === 401 || probeInfo.status === 403) {
    return `状态接口需要宿主授权（HTTP ${probeInfo.status}），去「设置 → 微信」查看。`
  }
  if (!probeInfo.reachable) {
    return `${WECHAT_PLUGIN} ${version} 已装，但状态接口连不上（DSH 未重启 / 路由未注册）：${probeInfo.error || '没有应答'}。`
  }
  return `${WECHAT_PLUGIN} ${version} 已就位：${channelState(probeInfo)}；状态 / 扫码 / 绑定都在「设置 → 微信」。`
}

/**
 * @param {object} options
 * @param {string} [options.home]       $DSH_HOME
 * @param {string} [options.profile]    profile 名（如 desktop）
 * @param {Function} [options.getOrigin] 替身：() => 'http://127.0.0.1:3000'
 * @param {Function} [options.locate]    替身：() => ({found, version, path})
 * @param {Function} [options.probe]     替身：({url}) => ({reachable, status, body}) 或直接给 body
 * @param {object} [options.logger]      宿主 logger（只用来报定位错误，不打印账号）
 */
export function createWeChatPlugin({ home, profile, getOrigin, locate, probe, logger } = {}) {
  const resolvedHome = String(home || '')
  const resolvedProfile = detectProfile(resolvedHome, profile)

  /** 默认 locate：只看本机装没装，不联网。 */
  function locatePlugin() {
    if (typeof locate === 'function') return locate()
    return resolveDependency(WECHAT_PLUGIN, { home: resolvedHome, profile: resolvedProfile })
  }

  /** 宿主地址：拿去拼状态接口的 URL；拿不到就 ''。 */
  function resolveOrigin() {
    if (typeof getOrigin !== 'function') return ''
    try {
      return normalizeOrigin(getOrigin())
    } catch {
      return ''
    }
  }

  /**
   * 探一次真实状态并返回。**只读**：locate 看盘、probe 一个 GET。
   * 每次调用都重新探（面板只在打开 / 改动后调，不是定时轮询）。
   */
  async function status() {
    let hit = { found: false, version: '', path: '', error: '' }
    try {
      const got = locatePlugin()
      hit = got && typeof got === 'object' ? got : hit
    } catch (error) {
      hit = { found: false, version: '', path: '', error: String(error?.message || error) }
      try { logger?.warn?.(`fish-world: 微信插件定位失败：${hit.error}`) } catch {}
    }
    const installed = hit.found === true
    const version = String(hit.version || '')
    const origin = resolveOrigin()
    const url = origin ? `${origin}${STATUS_ROUTE}` : ''

    const probeInfo = installed && url
      ? normalizeProbe(await (typeof probe === 'function'
        ? Promise.resolve().then(() => probe({ url, origin })).catch((error) => ({
          reachable: false,
          status: 0,
          body: null,
          error: String(error?.message || error),
        }))
        : defaultProbe({ url })))
      : { reachable: null, status: 0, enabled: null, connected: null, accounts: [], error: '' }

    return {
      ok: true,
      installed,
      version,
      origin,
      route: STATUS_ROUTE,
      // null = 还没法探（没装 / 取不到宿主地址），不是「不通」。
      reachable: probeInfo.reachable,
      enabled: probeInfo.enabled,
      connected: probeInfo.connected,
      accounts: probeInfo.accounts,
      lastError: probeInfo.error || '',
      note: noteOf({ installed, version, profile: resolvedProfile, origin, probeInfo }),
    }
  }

  return { status, profile: resolvedProfile, plugin: WECHAT_PLUGIN, route: STATUS_ROUTE, home: resolvedHome }
}
