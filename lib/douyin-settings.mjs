// 抖音设置：真源在 dsh-douyin-browser-local 自己的状态与守卫文件里。
// 鱼世界不直接写它的文件（那会绕过它的守卫与预算），只走它自己的本机设置接口：
//   GET  /api/douyin-browser/state          读当前值；返回里带 token
//   POST /api/douyin-browser/<入口>          写，必须带 x-douyin-settings-token
// 读写失败一律抛出，由调用方原样报给面板，不假装成功。

const PREFIX = '/api/douyin-browser'

const lines = (value) => (Array.isArray(value) ? value.join('\n') : '')

/** 把上游的 state 压成面板用的平面字段（键名与 platforms.mjs 的 defaults 一一对应）。 */
export function douyinSnapshot(state = {}) {
  const video = state.video?.policy || {}
  const schedule = state.schedule?.policy || {}
  const options = state.watchOptions?.policy || {}
  const spark = state.spark?.policy || {}
  const comments = state.comments?.policy || {}
  return {
    silentWatch: state.mode?.silent === true,
    autoStart: schedule.enabled === true,
    autoStartMaxRequests: schedule.maxRequests,
    watchTopicMode: options.mode,
    watchTopics: lines(options.topics),
    watchExclude: lines(options.exclude),
    videoWindows: lines(video.windows),
    sessionMinutes: video.sessionMinutes == null ? 0 : video.sessionMinutes,
    allowGreeting: spark.enabled === true,
    greetingWindows: lines(spark.windows),
    greetingDailyLimit: spark.dailyLimit,
    allowComment: comments.enabled === true,
    commentDailyLimit: comments.dailyLimit,
    commentPerSessionLimit: comments.perSessionLimit,
    allowShare: state.share?.enabled === true,
    shareDailyLimit: state.share?.dailyLimit,
    dailyReplyLimit: state.chat?.policy?.dailyReplyLimit,
    // 1.4.5 新增：好友与群聊共用的一份互动开关（默认关）。名单仍由插件自己的设置页维护。
    interactionsOn: state.interactions?.friend?.policy?.enabled === true,
  }
}

/** 面板里多行文本 → 数组（与上游的切分口径一致：换行、逗号、分号都算分隔）。 */
export function splitList(text) {
  return String(text || '').split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean)
}

const DOUYIN_GROUPS = [
  { keys: ['silentWatch'], path: '/mode/configure', body: (m) => ({ silent: m.silentWatch }) },
  { keys: ['autoStart', 'autoStartMaxRequests'], path: '/watch/schedule', body: (m) => ({ enabled: m.autoStart, maxRequests: m.autoStartMaxRequests }) },
  {
    keys: ['watchTopicMode', 'watchTopics', 'watchExclude'], path: '/watch/options',
    body: (m) => ({ mode: m.watchTopicMode, topics: splitList(m.watchTopics), exclude: splitList(m.watchExclude) }),
  },
  {
    keys: ['videoWindows', 'sessionMinutes'], path: '/video/configure',
    body: (m, cur) => ({
      windows: splitList(m.videoWindows),
      sessionMinutes: m.sessionMinutes === 0 ? null : m.sessionMinutes,
      // 上游 savePolicy 会整份覆盖：周末时段不带上就等于把它清掉，所以原样带回。
      ...(cur.__weekendWindows ? { weekendWindows: cur.__weekendWindows } : {}),
    }),
  },
  {
    keys: ['allowGreeting', 'greetingWindows', 'greetingDailyLimit'], path: '/spark/configure',
    body: (m) => ({ enabled: m.allowGreeting, windows: splitList(m.greetingWindows), dailyLimit: m.greetingDailyLimit }),
  },
  {
    keys: ['allowComment', 'commentDailyLimit', 'commentPerSessionLimit'], path: '/comments/configure',
    body: (m) => ({ enabled: m.allowComment, dailyLimit: m.commentDailyLimit, perSessionLimit: m.commentPerSessionLimit }),
  },
  { keys: ['allowShare', 'shareDailyLimit'], path: '/share/configure', body: (m) => ({ enabled: m.allowShare, dailyLimit: m.shareDailyLimit }) },
  {
    keys: ['dailyReplyLimit'], path: '/chat/configure',
    // 私信的许可名单在上游保存，这里只改每日上限，名单原样带回。
    body: (m, cur) => ({ recipientIds: cur.__recipientIds || [], dailyReplyLimit: m.dailyReplyLimit }),
  },
  // 1.4.5：好友互动的总开关，只接收 { enabled }。
  { keys: ['interactionsOn'], path: '/interactions/configure', body: (m) => ({ enabled: m.interactionsOn }) },
]

export const DOUYIN_UPSTREAM_KEYS = new Set(DOUYIN_GROUPS.flatMap((group) => group.keys))

/**
 * 创建抖音设置客户端。
 * getOrigin：返回 DSH 本机地址（宿主的 webServer.getOrigin），拿不到就报错，不猜端口。
 * getRpc：返回宿主的 connection.rpc（可选）。抖音 1.4.5 起设置接口的真实入口是
 *   宿主的认证通道，裸 fetch 打到 webServer 会被 DSH 拒成 401 —— 所以优先走 RPC。
 */
export function createDouyinSettings({ getOrigin, getRpc, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const RPC_CHANNEL = '/douyin-settings'

  /** 走宿主认证的 RPC 通道（抖音插件自己在 connection 上注册的那条）。 */
  async function viaRpc(path, { method = 'GET', body, token } = {}) {
    const rpc = typeof getRpc === 'function' ? getRpc() : null
    if (!rpc || typeof rpc.call !== 'function') return null
    const reply = await rpc.call(
      RPC_CHANNEL,
      'request',
      { path, ...(body === undefined ? {} : { input: body, token }) },
      AbortSignal.timeout(timeoutMs),
    )
    if (!reply || reply.ok !== true) {
      throw new Error(reply?.error?.message || 'DSH 设置通信失败，请确认抖音插件后端已加载')
    }
    const outcome = reply.value
    if (!Number.isInteger(outcome?.status) || !outcome.body || typeof outcome.body !== 'object') {
      throw new Error('抖音设置接口版本不匹配，请完全退出后重开 DSH')
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      throw Object.assign(new Error(outcome.body.error || `抖音设置接口返回 ${outcome.status}`), { status: outcome.status })
    }
    return outcome.body
  }

  async function request(path, { method = 'GET', body, token } = {}) {
    // 先走认证通道：它是抖音插件自己注册的，也唯一能穿过 DSH 的鉴权。
    const viaAuth = await viaRpc(path, { method, body, token })
    if (viaAuth) return viaAuth
    // 拿不到 RPC（老版本插件 / 非宿主环境）才退回直接 HTTP。
    const origin = typeof getOrigin === 'function' ? String(getOrigin() || '').replace(/\/+$/, '') : ''
    if (!origin) throw new Error('读不到 DSH 的本机地址，抖音设置暂时没法同步')
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers['x-douyin-settings-token'] = token
    let res
    try {
      res = await fetchImpl(origin + PREFIX + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`连不上抖音插件的设置接口（${path}）：${error?.message || error}`)
    }
    const text = await res.text()
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = {} }
    if (!res.ok) throw Object.assign(new Error(data.error || `抖音设置接口返回 ${res.status}`), { status: res.status })
    return data
  }

  /** 读：返回面板用的平面字段。 */
  async function read() {
    const state = await request('/state')
    return douyinSnapshot(state)
  }

  /**
   * 写：只动 patch 里涉及的那几组入口；同组的其它字段从上游当前值补齐（上游是整组覆盖）。
   * 返回写完之后重新读回的平面字段，让面板显示的是上游真实状态。
   */
  async function write(patch) {
    const state = await request('/state')
    const token = state.token
    if (!token) throw new Error('抖音插件没给出设置令牌，请先刷新它的设置页再试')
    const current = douyinSnapshot(state)
    const merged = { ...current, ...patch }
    const cur = {
      __weekendWindows: state.video?.policy?.weekendWindows,
      __recipientIds: (state.chat?.policy?.allowlist || []).map((item) => item.id).filter(Boolean),
    }
    for (const group of DOUYIN_GROUPS) {
      if (!group.keys.some((key) => key in patch)) continue
      await request(group.path, { method: 'POST', body: group.body(merged, cur), token })
    }
    return read()
  }

  return { read, write }
}
