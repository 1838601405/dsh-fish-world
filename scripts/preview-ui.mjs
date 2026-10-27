import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { personaPreset, personaPresetList } from '../lib/persona-presets.mjs'
import { PLATFORMS } from '../lib/platforms.mjs'

const ROOT = join(import.meta.dirname, '..', 'ui')
const PORT = Number(process.argv[2] || 55901)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

// 只有这些假数据接口被拦截，其余一律 404，避免误导成真实后端。
const stub = {
  '/dsh-fish-world/env': { ok: true, environment: { ok: true, packages: [], warnings: [], hints: [] } },
  '/dsh-fish-world/capabilities': {
    ok: true,
    built_in: [{ id: 'animation', name: '动图解码器' }],
    plugins: [{ id: 'animation-frames', name: '多帧采样' }],
    skills: [{ id: 'animation-understanding', name: '动图理解' }],
  },
  '/dsh-fish-world/world/diary': {
    ok: true,
    suggestions: [{ id: 's1', at: '2026-10-24T09:12:00.000Z', actorName: '阿鱼', text: '想让它今天多睡一会儿。' }],
    entries: [{ id: 'e1', at: '2026-10-24T21:40:00.000Z', actorName: '鱼', status: 'approved', text: '今天很安静，海面是平的。' }],
  },
  '/dsh-fish-world/stickers': { ok: true, items: [{ id: 'a', name: '歪头', tags: ['可爱'] }], summary: {} },
  // 更新检查：给一份「有一个新版」的假数据，这样「一键更新」按钮在预览里看得见
  // （它只在 hasUpdates 为真时出现，否则没法实测那个按钮）。
  '/dsh-fish-world/doctor/update': {
    ok: true,
    counts: { total: 3, outdated: 1, current: 2, unavailable: 0 },
    summary: '3 项里 1 项有新版本（预览假数据）',
    items: [
      { name: 'dsh-qq-bridge', label: 'QQ 桥', status: 'outdated', current: '0.3.0', latest: '0.3.1' },
      { name: 'dsh-feiyu-mood', label: '心情', status: 'current', current: '0.2.0', latest: '0.2.0' },
      { name: 'dsh-fish-world', label: '鱼世界（本插件）', status: 'current', current: '0.2.0', latest: '0.2.0' },
    ],
    hints: [],
  },
  // 平台卡直接读真实默认值：预览里看到的开关就是主人第一次打开时的样子，
  // 不另外抄一份会漂移的假配置。installed 写 preview，避免误当成真装好了。
  '/dsh-fish-world/platforms': {
    ok: true,
    platforms: Object.values(PLATFORMS).map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      plugin: def.plugin,
      installed: true,
      version: 'preview',
      config: { ...def.defaults },
      notes: def.notes,
      // QQ 给一份「未连接」的账号情况，好让「一键启动协议端」和那几个开关
      // 在预览里也能点、也能验；其它平台如实写由插件自己管。
      account: def.id === 'qq'
        ? {
          ok: true,
          loggedIn: false,
          account: null,
          configuredPrivateQQ: '1838601405',
          configuredGroup: '',
          targetSession: '',
          toPrivate: true,
          toGroup: false,
          masterSwitch: true,
          trial: false,
          receiveImages: true,
          sendImages: true,
          maxImages: 4,
          missing: false,
        }
        : { ok: true, loggedIn: false, managed: false, note: `登录状态由 ${def.plugin} 自己管理` },
    })),
  },
  '/dsh-fish-world/world/sticker-wishes': { ok: true, items: [] },
  '/dsh-fish-world/qqagent': {
    ok: true,
    enabled: false,
    baseUrl: 'http://127.0.0.1:3211',
    timeoutMs: 15000,
    hasToken: false,
    tokenPreview: '',
    active: false,
  },
  '/dsh-fish-world/astrbot': {
    ok: true,
    enabled: true,
    useForQQ: false,
    borrowTools: false,
    baseUrl: 'http://127.0.0.1:6210',
    timeoutMs: 15000,
    pollMs: 3000,
    hasToken: true,
    tokenPreview: '••••ab12',
    active: true,
    canUseForQQ: false,
    canBorrowTools: false,
    transport: 'snowluma',
  },
  '/dsh-fish-world/world/growth': {
    ok: true,
    stage: { key: 'small', name: '小鱼', note: '开始有自己的判断，但还容易改。' },
    entries: [{ id: 'g1', day: '2026-10-24', kind: 'insight', text: '被拒绝不一定是不喜欢，也可能只是那时候不合适。', revision: 2 }],
    materials: [],
    check: { ok: true, problems: [] },
  },
  // 知识库：假一份「开着本地向量档、索引最新」的状态，好检查卡片排版。
  '/dsh-fish-world/world/knowledge': {
    ok: true,
    items: 6,
    enabled: true,
    mode: 'local',
    index: { model: 'local:Xenova/bge-small-zh-v1.5', dim: 512, builtAt: Date.parse('2026-10-25T19:18:00Z'), fresh: true },
    indexFresh: true,
    indexWhy: '',
    config: { enabled: true, mode: 'local', localModel: 'Xenova/bge-small-zh-v1.5', baseUrl: '', model: '', vectorsFile: '' },
    problems: [],
    hasKey: false,
    folder: 'D:\\大肥鱼\\鱼的世界\\鱼的记忆',
    files: [
      { name: '知识库.json', exists: true, bytes: 3613, mtime: Date.parse('2026-10-25T19:24:00Z') },
      { name: '知识库.md', exists: true, bytes: 1905, mtime: Date.parse('2026-10-25T19:24:00Z') },
      { name: '外观设定.md', exists: true, bytes: 1644, mtime: Date.parse('2026-10-25T16:00:00Z') },
    ],
  },
  '/dsh-fish-world/config': { ok: true, config: { qzone: { enabled: true, postsPerDay: 2, likesPerDay: 2, commentsPerDay: 2, repliesPerDay: 2 } } },
  // 以下四条与真实路由同形状（见 lib/http.mjs 的 fishProfile / storageInfo / qqChatRoute / worldActivity）。
  // 缺任何一条，对应卡就会显示「读取失败：HTTP 404」——那是预览缺假数据，不是真实后端的问题。
  '/dsh-fish-world/fish/profile': {
    ok: true,
    fish: { name: '鱼', ownerTitle: '主人', persona: '' },
    // 预览给两张卡：否则「编辑 / 换图 / 置顶 / 删除」那排在预览里只剩「跟随挂件」一项，
    // 改过角色卡界面也验不出来。
    current: { id: 'default', name: '鱼', displayName: '鱼', pinned: false, hasImage: false, avatar: '' },
    roles: [
      { id: 'default', name: '鱼', pinned: false, createdAt: 0, hasImage: false, avatar: '' },
      { id: 'maid', name: '女仆鱼', pinned: true, createdAt: 1, hasImage: false, avatar: '' },
    ],
    ownerTitle: '主人',
    owner: {
      qq: { bridge: '10001', config: '', relation: '' },
      session: { bridge: 'session-preview-owner', config: '', relation: '' },
      qqAgree: true,
      sessionAgree: true,
      sessionAlive: true,
    },
    sessions: [
      { id: 'session-preview-owner', title: '预览主人会话' },
      { id: 'session-preview-room', title: '预览房间' },
    ],
  },
  '/dsh-fish-world/storage': {
    ok: true,
    root: 'C:\\预览\\鱼的世界',
    exists: true,
    configured: false,
    defaultRoot: 'C:\\预览\\桌面\\鱼的世界',
    bound: true,
    folders: {
      collection: 'C:\\预览\\鱼的世界\\鱼之宝库',
      gallery: 'C:\\预览\\鱼的世界\\鱼之宝库\\图库',
      sites: 'C:\\预览\\鱼的世界\\鱼之宝库\\网站',
      platforms: 'C:\\预览\\鱼的世界\\鱼与世界',
      growth: 'C:\\预览\\鱼的世界\\鱼的成长',
      byPlatform: {
        qq: 'C:\\预览\\鱼的世界\\鱼与世界\\QQ',
        bili: 'C:\\预览\\鱼的世界\\鱼与世界\\B站',
        douyin: 'C:\\预览\\鱼的世界\\鱼与世界\\抖音',
      },
    },
    layoutNote: '鱼之宝库 → 图库 / 网站链接；鱼与世界 → QQ / B站 / 抖音。',
  },
  '/dsh-fish-world/qq/chat': {
    ok: true,
    chat: { enabled: false },
    config: { ...PLATFORMS.qq.defaults },
    targets: [{ chatKey: 'group:10086', kind: 'group', id: '10086', name: '预览群', sessionId: '', enabled: true }],
    sessions: [{ id: 'session-preview-room', title: '预览房间' }],
    ownerSession: 'session-preview-owner',
  },
  // QQ 空间运行时状态：面板空间栏要照着它说话（今天写过日记没、今天发过没、额度剩余）。
  '/dsh-fish-world/qzone/status': {
    ok: true,
    enabled: true,
    day: '2026-10-27',
    usage: {
      byKind: {
        post: { used: 0, limit: 2, remaining: 2 },
        like: { used: 0, limit: 2, remaining: 2 },
        comment: { used: 0, limit: 2, remaining: 2 },
        reply: { used: 0, limit: 2, remaining: 2 },
      },
    },
    lastDiaryAt: null,
    diaryDue: false,
    diaryToday: true,
    diaryPostedToday: false,
    sameDayDue: true,
    diaryPromptAt: 0,
    diaryDueReason: '今天本机已经写过日记，但空间还没发',
  },
  '/dsh-fish-world/world/activity': {
    ok: true,
    platforms: {
      qq: { id: 'qq', name: 'QQ', dir: 'C:\\预览\\鱼的世界\\鱼与世界\\QQ', total: 0, days: 0, recent: [] },
      bili: { id: 'bili', name: 'B站', dir: 'C:\\预览\\鱼的世界\\鱼与世界\\B站', total: 0, days: 0, recent: [] },
      douyin: { id: 'douyin', name: '抖音', dir: 'C:\\预览\\鱼的世界\\鱼与世界\\抖音', total: 0, days: 0, recent: [] },
    },
    kinds: [],
    note: '浏览与互动记录只写入本机工作区，鱼世界不上传、不镜像。',
    items: [],
    owner: {
      ok: true,
      platform: 'qq',
      interactions: 128,
      ownerSaid: 61,
      fishSaid: 67,
      days: 9,
      streak: 3,
      firstAt: '2026-10-18T09:12:00.000Z',
      lastAt: '2026-10-26T22:40:00.000Z',
      peakHour: 21,
      hours: [0, 0, 0, 0, 0, 0, 0, 1, 3, 5, 2, 4, 6, 3, 2, 4, 7, 9, 11, 14, 18, 24, 16, 3],
      recentDays: [
        { day: '2026-10-18', total: 8, owner: 4, fish: 4 },
        { day: '2026-10-19', total: 12, owner: 6, fish: 6 },
        { day: '2026-10-20', total: 6, owner: 3, fish: 3 },
        { day: '2026-10-21', total: 15, owner: 7, fish: 8 },
        { day: '2026-10-22', total: 9, owner: 4, fish: 5 },
        { day: '2026-10-23', total: 11, owner: 5, fish: 6 },
        { day: '2026-10-24', total: 14, owner: 7, fish: 7 },
        { day: '2026-10-25', total: 22, owner: 10, fish: 12 },
        { day: '2026-10-26', total: 31, owner: 15, fish: 16 },
      ],
      ownerKnown: true,
      note: '只算你和鱼之间的收发，不含平台浏览与群通知。',
    },
  },
  // 第二批：同样照真实路由的返回形状写（lib/http.mjs 对应 handler），空数据用空数组。
  '/dsh-fish-world/fish/portrait': {
    ok: true,
    emotion: 'calm',
    emotionLabel: '平静',
    imageUrl: '',
    dir: 'C:\\预览\\鱼的世界\\鱼的成长\\头像',
  },
  '/dsh-fish-world/doctor/dependency': {
    ok: true,
    counts: {
      installed: 5,
      total: 5,
      missing: 0,
      optionalMissing: 0,
      platforms: { installed: 4, total: 4, missing: 0 },
    },
    items: [],
    node: { version: 'v22.0.0', ok: true },
  },
  '/dsh-fish-world/doctor/storage': {
    ok: true,
    audit: {
      ok: true,
      root: 'C:\\预览\\鱼的世界',
      configured: false,
      dirs: [
        { key: 'root', label: '工作区根目录', path: 'C:\\预览\\鱼的世界', exists: true, isDir: true, writable: true },
        { key: 'collection', label: '鱼之宝库', path: 'C:\\预览\\鱼的世界\\鱼之宝库', exists: true, isDir: true, writable: true },
        { key: 'gallery', label: '图库', path: 'C:\\预览\\鱼的世界\\鱼之宝库\\图库', exists: true, isDir: true, writable: true },
        { key: 'sites', label: '网站链接', path: 'C:\\预览\\鱼的世界\\鱼之宝库\\网站', exists: true, isDir: true, writable: true },
        { key: 'platforms', label: '鱼与世界', path: 'C:\\预览\\鱼的世界\\鱼与世界', exists: true, isDir: true, writable: true },
        { key: 'growth', label: '鱼的成长', path: 'C:\\预览\\鱼的世界\\鱼的成长', exists: true, isDir: true, writable: true },
        { key: 'memory', label: '鱼的记忆（知识库）', path: 'C:\\预览\\鱼的世界\\鱼的记忆', exists: true, isDir: true, writable: true },
      ],
      indexes: [
        { key: 'gallery', label: '图库索引', path: 'C:\\预览\\鱼的世界\\鱼之宝库\\图库\\stickers.json', exists: true, valid: true, count: 0 },
        { key: 'sites', label: '网站索引', path: 'C:\\预览\\鱼的世界\\鱼之宝库\\网站\\links.json', exists: false, valid: true, count: 0 },
        { key: 'knowledge', label: '知识库', path: 'C:\\预览\\鱼的世界\\鱼的记忆\\知识库.json', exists: true, valid: true, count: 6 },
      ],
      problems: [],
    },
    growth: { ok: true },
  },
  '/dsh-fish-world/world/wishes': {
    ok: true,
    wishes: [],
    days: [],
    dailyLimit: 3,
    limitNote: '每天最多 3 个，零点重置',
  },
  '/dsh-fish-world/fish/persona': {
    ok: true,
    roleId: 'default',
    current: null,
    text: '（预览）这张角色卡的人设正文。真实环境里，这里就是 fish-world-personas/<id>.md 的全文。\n',
    bytes: 74,
    cards: [],
    presets: [],
  },
  '/dsh-fish-world/world/records': { ok: true, items: [], grudges: [] },
  '/dsh-fish-world/links': { ok: true, items: [], summary: { total: 0 } },
  '/dsh-fish-world/stickers/dir': {
    ok: true,
    dir: 'C:\\预览\\鱼的世界\\鱼之宝库\\图库',
    formats: ['png', 'gif', 'jpg', 'webp'],
    note: '图库只存相对位置，实际文件在存储位置里改。',
  },
  '/dsh-fish-world/extensions': { ok: true, extensions: [{ id: 'hello-qq', name: '示例扩展', status: 'loaded' }] },
  '/dsh-feiyu-mood/state': { ok: true, emoji: '😊', moodLabel: '欢喜', mood: 81, lastReason: '今天聊得很好。' },
  '/dsh-tts-bridge/status': { ok: true, auto: false, playing: false, waiting: 0 },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname

  // 预览里的「写入」要真的生效，否则「面板无法互动」根本验不出来。
  // 这两个接口与真实后端同形状：都回 { ok, ...platforms.status() }。
  // 角色卡增删改：与真实路由同形（create / remove / current / pin / image / remove-image）。
  if (req.method === 'POST' && path === '/dsh-fish-world/fish/roles') {
    let body = {}
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch { body = {} }
    const fp = stub['/dsh-fish-world/fish/profile']
    fp.roles = fp.roles || []
    const action = String(body.action || '')
    const replyRole = () => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, current: fp.current || null, roles: fp.roles }))
    }
    if (action === 'create') {
      const name = String(body.name || '').trim()
      if (!name) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '角色名不能为空' }))
        return
      }
      fp.roles.push({ id: 'role-' + (fp.roles.length + 1), name, pinned: false, hasImage: false, avatar: '' })
      return replyRole()
    }
    if (action === 'remove') {
      fp.roles = fp.roles.filter((r) => r.id !== body.id)
      return replyRole()
    }
    if (action === 'pin') {
      const r = fp.roles.find((x) => x.id === body.id)
      if (r) r.pinned = body.pinned !== false
      return replyRole()
    }
    if (action === 'current') {
      fp.current = fp.roles.find((r) => r.id === body.id) || null
      return replyRole()
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, current: fp.current || null, roles: fp.roles }))
    return
  }

  // 知识库写入：和真实路由同形状——合并配置、apiKey 只改 hasKey（不回显内容）、问题跟着配置重算。
  if (req.method === 'POST' && path === '/dsh-fish-world/world/knowledge') {
    let body = {}
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch { body = {} }
    const kb = stub['/dsh-fish-world/world/knowledge']
    if (body.apiKey === null) kb.hasKey = false
    else if (typeof body.apiKey === 'string' && body.apiKey.trim()) kb.hasKey = true
    // 索引三动作与真实路由同形：check 只读、update 按需、rebuild 强制。
    if (body.action === 'check') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, action: 'check', fresh: kb.indexFresh === true, reason: kb.indexFresh ? '' : (kb.indexWhy || ''), ...kb }))
      return
    }
    if (body.action === 'update' || body.action === 'rebuild' || body.rebuild) {
      const force = body.action === 'rebuild' || body.rebuild === true
      const rebuilt = force || kb.indexFresh !== true
      if (rebuilt) kb.indexFresh = true
      kb.index = kb.index || { model: 'local:Xenova/bge-small-zh-v1.5', dim: 512, builtAt: Date.now(), fresh: true }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, action: body.action || 'rebuild', rebuilt, items: kb.items, ...kb }))
      return
    }
    if (!body.rebuild) {
      const { apiKey, rebuild, action, ...patch } = body
      kb.config = { ...kb.config, ...patch }
    }
    kb.enabled = kb.config.enabled === true
    kb.mode = kb.config.mode || 'off'
    // 只镜像 lib/kb-vector.mjs 里已有的那条真实提示，不在预览里编新文案。
    kb.problems = kb.enabled && kb.mode === 'off' ? ['向量开关开着，但没选后端（off）'] : []
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, ...kb }))
    return
  }

  // 人设卡正文保存：与真实路由同形（roleId + text），预览里直接写回假数据，
  // 这样角色卡上的「编辑」在预览里也能真存一次、看见状态行变化。
  if (req.method === 'POST' && path === '/dsh-fish-world/fish/persona') {
    let body = {}
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch { body = {} }
    const text = String(body.text || '').replace(/\r\n/g, '\n').trim()
    if (!text) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '人设内容不能为空' }))
      return
    }
    const card = stub['/dsh-fish-world/fish/persona']
    card.roleId = String(body.roleId || 'default')
    card.text = text + '\n'
    card.bytes = Buffer.byteLength(text)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, roleId: card.roleId, bytes: card.bytes }))
    return
  }

  if (req.method === 'POST' && path === '/dsh-fish-world/fish/profile') {
    let body = {}
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch { body = {} }
    const qqEntry = stub['/dsh-fish-world/platforms'].platforms.find((p) => p.id === 'qq')
    const fishStub = stub['/dsh-fish-world/fish/profile']
    // 鱼的信息 / 鱼的角色保存：和真实路由一样只改提交的字段，并回 fish。
    if (body.name != null || body.ownerTitle != null || body.persona != null) {
      if (body.name != null) fishStub.fish.name = String(body.name)
      if (body.ownerTitle != null) { fishStub.ownerTitle = String(body.ownerTitle); fishStub.fish.ownerTitle = String(body.ownerTitle) }
      if (body.persona != null) fishStub.fish.persona = String(body.persona)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, fish: fishStub.fish, current: null }))
      return
    }
    if (body.ownerQQ != null) qqEntry.account = { ...qqEntry.account, configuredPrivateQQ: String(body.ownerQQ) }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, owner: { qq: { bridge: String(body.ownerQQ || '') } }, sessions: [] }))
    return
  }

  if (req.method === 'POST' && (path === '/dsh-fish-world/platforms' || path === '/dsh-fish-world/config')) {
    let body = {}
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch { body = {} }

    if (path === '/dsh-fish-world/config') {
      const patch = body && typeof body === 'object' ? body : {}
      if (patch.qzone && typeof patch.qzone === 'object') {
        stub['/dsh-fish-world/config'].config.qzone = { ...stub['/dsh-fish-world/config'].config.qzone, ...patch.qzone }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(stub['/dsh-fish-world/config']))
      return
    }

    const qqEntry = stub['/dsh-fish-world/platforms'].platforms.find((p) => p.id === 'qq')
    // 账号情况里的可写字段（与 lib/qq.mjs 的白名单同名）
    const bridgeFields = {
      转私聊: 'toPrivate', 转群: 'toGroup', 群号: 'configuredGroup', 目标会话: 'targetSession',
      收图: 'receiveImages', 发图: 'sendImages', 总开关: 'masterSwitch', 试运行: 'trial',
    }
    if (body.action === 'bridge-field' || body.action === 'bridge-switch') {
      const key = bridgeFields[String(body.name || '')]
      if (!key) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `这个配置项不允许从面板修改：${body.name}` }))
        return
      }
      qqEntry.account = { ...qqEntry.account, [key]: body.value }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, ...stub['/dsh-fish-world/platforms'] }))
      return
    }
    if (body.id) {
      const entry = stub['/dsh-fish-world/platforms'].platforms.find((p) => p.id === body.id)
      if (entry) entry.config = { ...entry.config, ...(body.config || body.patch || {}) }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, ...stub['/dsh-fish-world/platforms'] }))
      return
    }
  }

  if (Object.hasOwn(stub, path)) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(stub[path]))
    return
  }

  // 角色卡预设直接读真实模块：预览里点「蓝鲸娘」看到的就是真正会注入的正文，
  // 而不是再抄一份可能过期的副本。
  if (path === '/preview/persona-preset') {
    const preset = personaPreset(url.searchParams.get('id') || '')
    res.writeHead(preset ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(preset
      ? {
        ok: true,
        presetId: preset.id,
        presetName: preset.name,
        text: preset.text,
        bytes: Buffer.byteLength(preset.text),
        presets: personaPresetList(),
      }
      : { ok: false, error: '没有这个预设' }))
    return
  }

  const rel = path === '/' ? '/index.html' : path
  // 预览也要能加载 lib/ 下的宿主级脚本：跑真实脚本，
  // 而不是在预览里另抄一份逻辑，否则开关的效果永远验不出来。
  const rootDir = path.startsWith('/lib/') ? normalize(join(ROOT, '..')) : ROOT
  const target = normalize(join(rootDir, rel))
  if (!target.startsWith(rootDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + rel)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('fish-world ui preview: http://127.0.0.1:' + PORT + '/')
})
