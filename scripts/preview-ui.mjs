import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { personaPreset, personaPresetList } from '../lib/persona-presets.mjs'
import { PLATFORMS } from '../lib/platforms.mjs'
import { recallPreview, briefPreview } from '../lib/memory-hub.mjs'

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
  // 图片收藏：给一张已同步、一张未同步的，好让「已同步 N 张」「已收藏角标」的排版在预览里能被看到。
  // emojiId 用明显假的 96 位串（真实 emoji_id 也是 96 字符，形状要对）。
  '/dsh-fish-world/stickers': {
    ok: true,
    items: [
      { id: 'a', name: '歪头', tags: ['可爱'], emojiId: 'a'.repeat(96) },
      { id: 'b', name: '贴贴', tags: ['乖'] },
    ],
    summary: { total: 2, synced: 1, useCustomFace: true, limit: 5, remainingThisHour: 5, dir: '/预览/图库', tags: [] },
  },
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
      // 在预览里也能点、也能验；B 站给一份**虚构**的已登录账号（昵称 / mid 都是假的），
      // 用来验「昵称（mid）+ 来源」那一行的排版；微信给一份 dsh-wechat-plugin 的只读快照
      // （账号用虚构名字）；其它平台如实写由插件自己管。
      account: def.id === 'qq'
        ? {
          ok: true,
          loggedIn: false,
          account: null,
          configuredPrivateQQ: '10000001',
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
        : def.id === 'bili'
          ? {
            ok: true,
            loggedIn: true,
            account: { nickname: '预览鲸鱼', userId: '10000001' },
            managed: false,
            source: 'bili-whale',
            self: { mid: '10000001', name: '预览鲸鱼' },
            // 人设同步状态：预览里给一份「已同步」，好让那一行与按钮的排版能被验到。
            persona: { installed: true, syncedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), bytes: 512, sameAsCurrent: true },
            note: '登录由 dsh-bili-whale 自己管理；鱼世界只读显示账号，不代持凭据',
          }
          : def.id === 'wechat'
            ? {
              ok: true,
              installed: true,
              version: 'preview',
              origin: 'http://127.0.0.1:3000',
              route: '/.dsh-wechat-plugin/status',
              reachable: true,
              enabled: true,
              connected: true,
              accounts: [{ name: '预览小号', id: '10000001', connected: true }],
              lastError: '',
              note: 'dsh-wechat-plugin 已就位：通道已启用，已连接，绑定 1 个账号；状态 / 扫码 / 绑定都在「设置 → 微信」。',
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
    folder: 'C:\\workspace\\鱼的世界\\鱼的记忆',
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
    root: 'C:\\workspace\\鱼的世界',
    exists: true,
    configured: false,
    defaultRoot: 'C:\\workspace\\鱼的世界',
    bound: true,
    folders: {
      collection: 'C:\\workspace\\鱼的世界\\鱼之宝库',
      gallery: 'C:\\workspace\\鱼的世界\\鱼之宝库\\图库',
      sites: 'C:\\workspace\\鱼的世界\\鱼之宝库\\网站',
      platforms: 'C:\\workspace\\鱼的世界\\鱼与世界',
      growth: 'C:\\workspace\\鱼的世界\\鱼的成长',
      byPlatform: {
        qq: 'C:\\workspace\\鱼的世界\\鱼与世界\\QQ',
        bili: 'C:\\workspace\\鱼的世界\\鱼与世界\\B站',
        douyin: 'C:\\workspace\\鱼的世界\\鱼与世界\\抖音',
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
      qq: { id: 'qq', name: 'QQ', dir: 'C:\\workspace\\鱼的世界\\鱼与世界\\QQ', total: 0, days: 0, recent: [] },
      bili: { id: 'bili', name: 'B站', dir: 'C:\\workspace\\鱼的世界\\鱼与世界\\B站', total: 0, days: 0, recent: [] },
      douyin: { id: 'douyin', name: '抖音', dir: 'C:\\workspace\\鱼的世界\\鱼与世界\\抖音', total: 0, days: 0, recent: [] },
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
    dir: 'C:\\workspace\\鱼的世界\\鱼的成长\\头像',
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
      root: 'C:\\workspace\\鱼的世界',
      configured: false,
      dirs: [
        { key: 'root', label: '工作区根目录', path: 'C:\\workspace\\鱼的世界', exists: true, isDir: true, writable: true },
        { key: 'collection', label: '鱼之宝库', path: 'C:\\workspace\\鱼的世界\\鱼之宝库', exists: true, isDir: true, writable: true },
        { key: 'gallery', label: '图库', path: 'C:\\workspace\\鱼的世界\\鱼之宝库\\图库', exists: true, isDir: true, writable: true },
        { key: 'sites', label: '网站链接', path: 'C:\\workspace\\鱼的世界\\鱼之宝库\\网站', exists: true, isDir: true, writable: true },
        { key: 'platforms', label: '鱼与世界', path: 'C:\\workspace\\鱼的世界\\鱼与世界', exists: true, isDir: true, writable: true },
        { key: 'growth', label: '鱼的成长', path: 'C:\\workspace\\鱼的世界\\鱼的成长', exists: true, isDir: true, writable: true },
        { key: 'memory', label: '鱼的记忆（知识库）', path: 'C:\\workspace\\鱼的世界\\鱼的记忆', exists: true, isDir: true, writable: true },
      ],
      indexes: [
        { key: 'gallery', label: '图库索引', path: 'C:\\workspace\\鱼的世界\\鱼之宝库\\图库\\stickers.json', exists: true, valid: true, count: 0 },
        { key: 'sites', label: '网站索引', path: 'C:\\workspace\\鱼的世界\\鱼之宝库\\网站\\links.json', exists: false, valid: true, count: 0 },
        { key: 'knowledge', label: '知识库', path: 'C:\\workspace\\鱼的世界\\鱼的记忆\\知识库.json', exists: true, valid: true, count: 6 },
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
  // 「鱼的记忆」页的四块：链接与图片都给一两条例，好检查列表/空态排版。
  '/dsh-fish-world/links': {
    ok: true,
    items: [
      {
        id: 'lnk_1', no: 'A-01', seq: 1, at: '2026-10-24T10:20:00.000Z',
        url: 'https://www.stylekit.top/zh/styles/bento-grid', host: 'www.stylekit.top',
        title: 'Bento Grid 便当盒布局', note: '不规则网格，卡片跨度差形成主次',
        tags: ['bento', '布局'], kind: 'design', source: 'stylekit',
      },
      {
        id: 'lnk_2', no: 'C-01', seq: 1, at: '2026-10-22T15:00:00.000Z',
        url: 'https://fonts.google.com/', host: 'fonts.google.com',
        title: 'Google Fonts', note: '', tags: ['字体'], kind: 'tool', source: '',
      },
    ],
    summary: {
      dir: 'C:\\workspace\\鱼的世界\\鱼之宝库\\网站',
      total: 2,
      limit: 10,
      remainingThisHour: 8,
      sources: [{ name: 'StyleKit 风格库', description: '网页设计风格库，适合收集版式与配色' }],
    },
  },
  // 图片整理：假一份「接口已填、已就绪」，好让「整理全部图片」按钮在预览里可点。
  '/dsh-fish-world/stickers/vision': {
    ok: true,
    ready: true,
    reason: '',
    hasKey: true,
    keySource: 'config',
    config: { enabled: true, baseUrl: 'https://vision.example.com/v1', model: 'preview-vision' },
  },
  '/dsh-fish-world/stickers/dir': {
    ok: true,
    dir: 'C:\\workspace\\鱼的世界\\鱼之宝库\\图库',
    formats: ['png', 'gif', 'jpg', 'webp'],
    note: '图库只存相对位置，实际文件在存储位置里改。',
  },
  '/dsh-fish-world/extensions': { ok: true, extensions: [{ id: 'hello-qq', name: '示例扩展', status: 'loaded' }] },
  // 多份心情（dsh-feiyu-mood 0.6.0+）：给两份 + 工作区模式，这样「切换」和
  // 「按工作区共用」两种情况在预览里都看得见（只有一份时界面和以前一样）。
  '/dsh-feiyu-mood/state': {
    ok: true,
    key: 'slot-1',
    mode: 'workspace',
    multi: true,
    label: '大肥鱼',
    emoji: '😊',
    moodLabel: '欢喜',
    mood: 81,
    lastReason: '今天聊得很好。',
    dims: [
      { key: 'happy', label: '开心', value: 78 },
      { key: 'calm', label: '踏实', value: 64 },
    ],
    slots: [
      { id: 'slot-1', label: '大肥鱼', sessions: ['s1', 's2'] },
      { id: 'slot-2', label: '修路的', sessions: ['s3'] },
    ],
  },
  '/dsh-tts-bridge/status': { ok: true, auto: false, playing: false, waiting: 0 },

  // ---- 整合范围 / 记忆中枢 / 时间线 / 花费 / 主动开口 ----
  // 结构与真实路由同一套字段（scope 的 groups/counts/gatesChecked、actions 的 items、
  // cost 的三档聚合、speak-up 的白名单键）。全部虚构：QQ 号用 10000001，路径写 C:\workspace。
  '/dsh-fish-world/hub': {
    ok: true,
    profile: 'C:\\workspace\\dsh-profile',
    counts: { installed: 13, total: 13, listed: 12, duplicates: 1, retired: 2, absorbed: 3, borrowed: 5 },
    // 账本还不认识的包：新装的必须露脸，不然「装了个新插件，面板上找不到」。
    unknown: [{ name: 'dsh-preview-plugin' }],
    // 本插件与 profile 的联接：ok 时概览只有一句说明，接错时才有修联接 / 写清单按钮。
    selfLink: {
      ok: true,
      status: 'ok',
      missing: false,
      target: 'C:\\workspace\\dsh-fish-world-test',
      expected: 'C:\\workspace\\dsh-fish-world-test',
      declared: { dependency: true, bundle: true },
    },
    roles: {
      absorbed: { label: '接管' },
      retired: { label: '退役' },
      borrowed: { label: '借手' },
    },
    // 按角色分的清单：每项一个开关（写 profile 的加载列表），停用只是移出列表。
    mods: [
      { name: 'dsh-feiyu-mood', role: 'borrowed', installed: true, listed: true, version: '0.7.0', purpose: '心情读数与挂饰' },
      { name: 'dsh-tts-bridge', role: 'borrowed', installed: true, listed: true, version: '0.3.1', purpose: '自动朗读' },
      { name: 'dsh-qq-bridge', role: 'borrowed', installed: true, listed: true, version: '0.3.1', purpose: 'QQ 收发与空间' },
      { name: 'dsh-fish-memory', role: 'absorbed', installed: true, listed: true, version: '0.4.0', purpose: '会话记忆', retireTo: 'dsh-fish-world' },
      { name: 'dsh-bili-humanism', role: 'absorbed', installed: true, listed: true, version: '0.1.0', purpose: 'B 站浏览与收藏', retireTo: 'dsh-fish-world' },
      { name: 'dsh-douyin-agent', role: 'absorbed', installed: false, listed: false, purpose: '抖音分享链接进收藏' },
    ],
    // 重复的能力位：同一个能力有几个 mod 在做，建议留一个。
    duplicates: [
      {
        capability: 'memory',
        label: '记忆（会话库 / 知识库）',
        members: ['dsh-fish-memory', 'dsh-fish-world'],
        keep: 'dsh-fish-world',
        listed: { 'dsh-fish-memory': true, 'dsh-fish-world': true },
      },
    ],
    advice: {
      note: '退役预演：数字来自把那个包当成没装，重算一遍动作清单。',
      groups: [
        {
          capability: 'memory',
          retiring: [
            {
              name: 'dsh-fish-memory',
              lostCount: 2,
              lost: [{ name: 'memory-recall' }, { name: 'memory-merge' }],
              requiredBy: { feature: '记忆中枢' },
              reach: 'here',
            },
          ],
        },
      ],
    },
    scope: {
      ok: true,
      // 预览里故意给 false：好检查「未检查闸门」那句标注真的画出来了。
      gatesChecked: false,
      counts: { ready: 10, blocked: 2, missing: 2, total: 14 },
      groups: [
        {
          id: 'fish',
          label: '养鱼本身',
          items: [
            {
              id: 'mood', label: '心情', detail: '心情读数与挂饰', by: 'dsh-feiyu-mood', state: 'ready', note: '',
              actions: [], usage: { total: 128, days: 9, lastAt: '2026-10-27T21:10:00.000Z' },
            },
            {
              id: 'tts', label: '朗读', detail: '自动朗读桥', by: 'dsh-tts-bridge', state: 'blocked',
              note: '总开关关着（桥的配置里 enabled=false）',
              actions: [{ id: 'toggle', label: '朗读总开关' }],
              usage: { total: 0, days: 0 },
            },
            {
              id: 'portrait', label: '头像', detail: '角色图 + 情绪滤镜', by: 'dsh-fish-world', state: 'ready', note: '',
              actions: [], usage: { total: 42, days: 6, lastAt: '2026-10-27T20:02:00.000Z' },
            },
            {
              id: 'growth', label: '成长账本', detail: '每天的认知与里程碑', by: 'dsh-fish-world', state: 'ready', note: '',
              actions: [],
            },
            {
              id: 'voice', label: '鱼的风格', detail: '说话风格（去 AI 味）：prompt 段 + 两个工具',
              by: 'dsh-fish-tone', state: 'ready', note: '轻 · 种子 7（默认值）', actions: [],
            },
          ],
        },
        {
          id: 'memory',
          label: '鱼的记忆',
          items: [
            {
              id: 'memory-hub', label: '记忆中枢', detail: 'dsh-fish-memory 的会话库 + 知识库', by: 'dsh-fish-memory',
              state: 'ready', note: '', actions: [], usage: { total: 76, days: 7, lastAt: '2026-10-27T22:00:00.000Z' },
            },
            {
              id: 'kb', label: '知识库', detail: '梗 / 外观 / 约定', by: 'dsh-fish-world', state: 'ready', note: '',
              actions: [], usage: { total: 6, days: 3 },
            },
            {
              id: 'memory-merge', label: '并库', detail: '会话库的碎片并进知识库', by: 'dsh-fish-world',
              state: 'blocked', note: '这一轮还没并过（草稿 2 条）',
              actions: [{ id: 'toggle', label: '并库开关' }],
            },
            {
              id: 'person-memory', label: '群友印象', detail: '按人对群的记忆', by: 'dsh-fish-memory',
              state: 'missing', note: 'dsh-fish-memory 没装上', actions: [],
            },
            {
              id: 'digest', label: '每日记忆摘要', detail: '按天压缩的全局记忆，进所有平台的提示词', by: 'dsh-fish-memory',
              state: 'ready', note: '今天 19 条 / 1161 字', actions: [{ id: 'rebuild', label: '立即重建' }],
              usage: { total: 1, days: 1, lastAt: '2026-10-29T10:00:00.000Z' },
            },
          ],
        },
        {
          id: 'platforms',
          label: '四个平台',
          items: [
            {
              id: 'qq', label: 'QQ', detail: '私聊 / 群聊 / 空间', by: 'dsh-qq-bridge', state: 'ready',
              note: '', actions: [], usage: { total: 128, days: 9, lastAt: '2026-10-27T21:40:00.000Z' },
            },
            {
              id: 'bili', label: 'B 站', detail: '浏览 / 点赞 / 收藏', by: 'dsh-bili-humanism', state: 'ready',
              note: '', actions: [], usage: { total: 5, days: 2 },
            },
            {
              id: 'douyin', label: '抖音', detail: '分享链接进收藏', by: 'dsh-douyin-agent', state: 'missing',
              note: 'dsh-douyin-agent 没装上', actions: [],
            },
            {
              id: 'wechat', label: '微信', detail: '收发 / 扫码 / 绑定在 dsh-wechat-plugin', by: 'dsh-wechat-plugin', state: 'ready',
              note: '', actions: [],
            },
          ],
        },
      ],
    },
  },
  '/dsh-fish-world/memory-digest': {
    ok: true,
    enabled: true,
    dateKey: '2026-10-28',
    cached: true,
    textLength: 642,
    lines: 14,
    sources: { sessionFiles: 3, sessionEntries: 24, persons: 2, skippedFiles: 0 },
    updatedAt: '2026-10-28T01:05:00.000Z',
    nextRebuild: '日期变化或手动触发',
  },
  '/dsh-fish-world/memory': {
    ok: true,
    // 不带查询串时回整本账本（记忆中枢卡读的是这一份）；
    // ?recall= / ?brief=1 的结果见 server 里的 /memory 分支。
    checkedAt: '2026-10-27T22:00:00.000Z',
    rootDir: 'C:\\workspace\\鱼的世界',
    totals: { sessions: 3, sessionMemories: 24, persons: 2, knowledge: 6 },
    sources: [
      {
        id: 'fish-memory', label: '会话记忆库', kind: 'sessions',
        dir: 'C:\\workspace\\.dsh\\fish-memory', exists: true, count: 24,
        detail: [
          { id: 'aaaa1111', total: 12, stable: 4, latest: Date.parse('2026-10-27T21:30:00.000Z') },
          { id: 'bbbb2222', total: 8, stable: 2, latest: Date.parse('2026-10-26T18:10:00.000Z') },
          { id: 'cccc3333', total: 4, stable: 0, latest: Date.parse('2026-10-25T09:00:00.000Z') },
        ],
        note: '3 个会话各存一份，互不相认',
      },
      {
        id: 'persons', label: '群友记忆', kind: 'persons',
        dir: 'C:\\workspace\\鱼的世界\\鱼的记忆\\群友', exists: true, count: 2, detail: [],
        note: '按人不按会话，覆盖 2 个人',
      },
      {
        id: 'knowledge', label: '知识库', kind: 'items',
        dir: 'C:\\workspace\\鱼的世界\\鱼的记忆\\知识库.json', exists: true, count: 6, detail: [],
        note: '6 条，谁都能查',
      },
    ],
    warnings: ['会话记忆分成 3 份，换个会话就记不得另一个会话里说过的话。'],
    wardrobe: {
      available: true, file: 'C:\\workspace\\.dsh\\fish-memory\\session-aaaa1111.json',
      count: 18, fromUs: 5, latestAt: '2026-10-27T21:30:00.000Z',
    },
    merge: {
      counts: { new: 2, dup: 2, near: 1 },
      note: '草稿只读：这条并进去，那条不动。',
      sessions: ['aaaa1111', 'bbbb2222'],
      candidates: [
        {
          state: 'near', text: '死鱼眼是嘴硬时用的表情', from: 'aaaa1111',
          matched: '死鱼眼表情', matchedText: '死鱼眼：没话说的时候用；回话时别连续刷屏。',
          actionNote: '这条两边说法不同，点「应用草稿」也不会动它。',
        },
        { state: 'dup', text: '表情一次一个', matched: '表情约定' },
        { state: 'dup', text: '别连着发三个表情', matched: '表情约定' },
      ],
    },
    recallPreview: {
      query: '死鱼眼那个表情怎么用',
      total: 6,
      picked: [
        { source: 'knowledge', text: '死鱼眼是「半眯着看你」的那个表情，用在被夸之后嘴硬的时候。', score: 0.82, activation: 0.9, at: '2026-10-20T10:00:00.000Z' },
        { source: 'sessions', text: '主人说过：表情别连着发三个，一次一个就够。', score: 0.61, activation: 0.7, at: '2026-10-24T21:30:00.000Z' },
        { source: 'persons', person: '阿明', text: '阿明分不清死鱼眼和生气，别对他用。', score: 0.55, activation: 0.4 },
      ],
    },
    briefPreview: {
      count: 2,
      text: [
        '【关于主人】',
        '- 死鱼眼是嘴硬时用的表情，不是真的生气。',
        '- 表情一次一个，别连着刷。',
      ].join('\n'),
    },
  },
  '/dsh-fish-world/actions': {
    ok: true,
    total: 5,
    days: ['2026-10-27', '2026-10-26'],
    items: [
      { id: 'a1', at: '2026-10-27T22:04:00.000Z', label: '写了今天的日记', role: 'fish', roleLabel: '鱼', recordId: 'diary-2026-10-27-01' },
      { id: 'a2', at: '2026-10-27T21:40:00.000Z', label: '回了一条 QQ 私聊', role: 'fish', roleLabel: '鱼', recordId: 'qq-10000001-1024' },
      { id: 'a3', at: '2026-10-27T20:12:00.000Z', label: '批准了鱼的请求', role: 'owner', roleLabel: '主人', recordId: 'wish-2026-10-27-02' },
      { id: 'a4', at: '2026-10-26T23:10:00.000Z', label: '把表情收藏进图库', role: 'fish', roleLabel: '鱼', recordId: 'sticker-a1b2c3' },
      { id: 'a5', at: '2026-10-26T19:02:00.000Z', label: '改了一个平台开关', role: 'owner', roleLabel: '主人', recordId: 'platform-qq-send' },
    ],
    // 今天概览用的三块：审计计数、平台留存、鱼的家（目录真在不在）。
    today: {
      day: '2026-10-27',
      total: 3,
      byAction: { 'diary-write': 1, 'wish-approve': 1, 'sticker-collect': 1 },
      labels: [
        { label: '写日记', count: 1 },
        { label: '批请求', count: 1 },
        { label: '收藏', count: 1 },
      ],
    },
    platformsToday: {
      qq: { id: 'qq', name: 'QQ', today: 12, said: 6, heard: 6, total: 128 },
      bili: { id: 'bili', name: 'B 站', today: 2, said: 0, heard: 2, total: 5 },
    },
    home: [
      {
        name: '鱼之宝库', path: 'C:\\workspace\\鱼的世界\\鱼之宝库', exists: true,
        entries: 4, files: 2, bytes: 245760, latestAt: '2026-10-27T21:00:00.000Z',
        recent: [
          { name: '图库', dir: true, bytes: 0, mtime: Date.parse('2026-10-27T21:00:00.000Z') },
          { name: '歪头.png', dir: false, bytes: 24576, mtime: Date.parse('2026-10-27T20:00:00.000Z') },
        ],
      },
      {
        name: '鱼的记忆', path: 'C:\\workspace\\鱼的世界\\鱼的记忆', exists: true,
        entries: 3, files: 3, bytes: 12288, latestAt: '2026-10-27T22:00:00.000Z', recent: [],
      },
      {
        name: '鱼与世界', path: 'C:\\workspace\\鱼的世界\\鱼与世界', exists: true,
        entries: 3, files: 0, bytes: 0, latestAt: '2026-10-27T21:40:00.000Z', recent: [],
      },
    ],
  },
  // 鱼手上的动作清单：与账本对过一遍，标出哪些缺插件 / 闸门没过。
  '/dsh-fish-world/hub/tools': {
    ok: true,
    counts: { total: 6, available: 4, unverified: 1, noGate: 1, noPlugin: 1 },
    ownTools: [
      { name: 'read_animation', label: '动图解码器', note: '看动图用的独立工具', source: '鱼世界自己注册' },
    ],
    groups: [
      {
        id: 'qq', label: 'QQ', note: '私聊 / 群聊 / 空间', available: 3, total: 4,
        actions: [
          { name: 'qq.send', available: true, gateUnknown: false, note: '发消息（受总开关与试运行限制）' },
          { name: 'qq.history', available: true, gateUnknown: true },
          { name: 'qq.poke', available: true, gateUnknown: false },
          { name: 'qzone.post', available: false, blocked: 'gate', missing: [], reason: '空间写入的闸门关着' },
        ],
      },
      {
        id: 'memory', label: '记忆', note: '回忆 / 知识库', available: 1, total: 2,
        actions: [
          { name: 'memory.recall', available: true, gateUnknown: false },
          { name: 'bili.collect', available: false, missing: ['dsh-bili-humanism'] },
        ],
      },
    ],
  },
  '/dsh-fish-world/cost': {
    ok: true,
    cost: {
      today: { date: '2026-10-27', cost: 0.42, apiCost: 0.38, calls: 26 },
      month: { date: '2026-10', cost: 9.86, apiCost: 8.94, calls: 612 },
      total: { date: '', cost: 41.27, apiCost: 37.5, calls: 2604 },
      budgetUsed: 9.86,
      byModel: [
        { model: 'deepseek/deepseek-chat', cost: 18.4, apiCost: 16.9, calls: 1180 },
        { model: 'deepseek/deepseek-reasoner', cost: 12.6, apiCost: 11.4, calls: 402 },
        { model: 'vision/preview-vision', cost: 6.2, apiCost: 5.7, calls: 68 },
        { model: 'local/Xenova/bge-small-zh-v1.5', cost: 3.1, apiCost: 2.8, calls: 940 },
        { model: 'audio/tts-preview', cost: 0.97, apiCost: 0.7, calls: 14 },
      ],
    },
  },
  '/dsh-fish-world/speak-up': {
    ok: true,
    installed: true,
    config: {
      总开关: true,
      试运行: false,
      目标会话: ['10000001', 'session-preview-owner'],
      间隔分钟: 90,
      峰时命中线: 3,
      谷时命中线: 1,
      安静起: '01:00',
      安静止: '07:30',
      搭话冷却分钟: 30,
    },
  },
  // 鱼的风格：dsh-fish-tone 的只读档位（假值；没装时它回 ok:false + installed:false）。
  '/dsh-fish-world/tone': {
    ok: true,
    installed: true,
    version: '0.3.0',
    enabled: true,
    strength: 'light',
    seed: 7,
    grammar: true,
    marks: 'light',
    configPath: 'C:\\workspace\\dsh-profile\\node_modules\\dsh-fish-tone\\config.json',
    configExists: false,
    source: '默认值',
    note: '设置在 dsh-fish-tone 自己的页面里改（/api/fish-tone）；鱼世界只读显示',
  },
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
      if (patch.stickers && typeof patch.stickers === 'object') {
        // 面板的「优先用收藏表情发」开关读的是 /stickers 的 summary，两边一起改，别让开关弹回去。
        stub['/dsh-fish-world/stickers'].summary.useCustomFace = patch.stickers.useCustomFace !== false
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

  // 同步进 QQ 收藏：预览里点一下就把未同步的假表情标成已同步——只动假数据，不碰任何真实接口。
  if (req.method === 'POST' && path === '/dsh-fish-world/sticker-sync') {
    const sheet = stub['/dsh-fish-world/stickers']
    const pending = sheet.items.filter((item) => !item.emojiId)
    for (const item of pending) item.emojiId = 'b'.repeat(96)
    sheet.summary.synced = sheet.items.filter((item) => item.emojiId).length
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, added: pending.length, failed: 0, errors: [], summary: sheet.summary }))
    return
  }

  // 记忆中枢：?recall= 回召回预览、?brief=1 回记忆便签（与真实路由同一套查询串）。
  // 这两条直接跑真实的 lib/memory-hub.mjs：预览里看到的就是真正注入提示词的那份排版。
  // FISH_WORLD_PREVIEW_ROOT 指向一份「预览用的鱼的世界」目录；没指就退回假数据，
  // 否则预览里这两块永远是空的，布局与空态也分不出来。
  if (req.method !== 'POST' && path === '/dsh-fish-world/memory') {
    const q = url.searchParams.get('recall') || ''
    const mem = stub['/dsh-fish-world/memory']
    // 不带查询串：回整本账本（记忆中枢卡读的是这一份）。
    if (!q && url.searchParams.get('brief') !== '1') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(mem))
      return
    }
    if (url.searchParams.get('brief') === '1') {
      let got = null
      // 只有显式指了预览数据目录（FISH_WORLD_PREVIEW_ROOT）才跑真实实现：
      // 否则 rootDir 传空会去读本机真实的记忆，预览不该顺手把主人的记忆摆出来。
      if (process.env.FISH_WORLD_PREVIEW_ROOT) {
        try { got = briefPreview({ rootDir: process.env.FISH_WORLD_PREVIEW_ROOT || '', query: q }) } catch { got = null }
      }
      const body = got && got.ok && got.text
        ? { ok: true, briefPreview: { count: got.count, text: got.text } }
        : {
          ok: true,
          briefPreview: {
            count: Number(mem.briefPreview.count || 0),
            text: (q ? '（预览：你问的是「' + q + '」）\n' : '') + mem.briefPreview.text,
          },
        }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
      return
    }
    let got = null
    // 同上：没指预览数据目录就只用假数据，不去读本机真实的记忆。
    if (process.env.FISH_WORLD_PREVIEW_ROOT) {
      try { got = recallPreview({ rootDir: process.env.FISH_WORLD_PREVIEW_ROOT || '', query: q }) } catch { got = null }
    }
    const body = got && got.ok && Array.isArray(got.picked) && got.picked.length
      ? { ok: true, recallPreview: { ...got, query: q || got.query } }
      : { ok: true, recallPreview: { ...mem.recallPreview, query: q || mem.recallPreview.query } }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
    return
  }

  // 整合包上的写操作：与真实路由同形（toggle / relink / declare）。
  // 预览里要真的生效，否则「面板点了没反应 / 卡片不刷新」这条验不出来。
  if (req.method === 'POST' && path.indexOf('/dsh-fish-world/hub/') === 0) {
    let body = {}
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch { body = {} }
    const hub = stub['/dsh-fish-world/hub']
    let note = ''
    let steps = []
    if (path.endsWith('/toggle')) {
      // 与真实路由同形：{ name, enabled }（name 是整合包里的插件名，不是面板里的临时 id）。
      const mod = (hub.mods || []).find((entry) => entry.name === body.name)
      if (!mod) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '账本里没有这个包：' + String(body.name || '') }))
        return
      }
      const next = body.enabled === true
      mod.listed = next
      note = mod.name + (next ? ' 已加入加载列表' : ' 已移出加载列表')
      steps = [
        { label: '找到 profile', detail: 'C:\\workspace\\dsh-profile/package.json', tone: 'ok' },
        { label: '备份清单', detail: 'package.json.bak-20261027-220000', tone: 'ok' },
        { label: next ? '写进加载列表' : '移出加载列表', detail: 'dsh.profile.bundles', tone: 'ok' },
        { label: '回读确认', detail: '读回来与写下去的一致', tone: 'ok' },
        { label: '生效时机', detail: '重启 DSH 后生效', tone: '' },
      ]
      // 在列表里的包数跟着走，否则「在宿主的加载列表」会跟清单自相矛盾。
      hub.counts.listed = (hub.mods || []).filter((entry) => entry.listed).length
    } else if (path.endsWith('/relink')) {
      note = '联接已改到 C:\\workspace\\dsh-fish-world-test'
      steps = [
        { label: '找到 profile', detail: 'C:\\workspace\\dsh-profile', tone: 'ok' },
        { label: '备份 package.json', detail: 'package.json.bak-20261027-220100', tone: 'ok' },
        { label: '改联接', detail: 'dsh-fish-world → 当前目录', tone: 'ok' },
        { label: '回读确认', detail: '读到的是当前目录', tone: 'ok' },
      ]
    } else if (path.endsWith('/declare')) {
      note = '已写入 profile 清单（dependencies + bundles）'
      steps = [
        { label: '备份 package.json', detail: 'package.json.bak-20261027-220200', tone: 'ok' },
        { label: '写 dependencies', detail: '加一条 dsh-fish-world 记录', tone: 'ok' },
        { label: '写 dsh.profile.bundles', detail: '加上 dsh-fish-world', tone: 'ok' },
        { label: '回读确认', detail: '两处都在', tone: 'ok' },
      ]
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, note, steps, report: hub }))
    return
  }

  // 每日记忆摘要：POST（重建 / 开关）回一份更新后的状态，卡片当场刷新。
  if (req.method === 'POST' && path === '/dsh-fish-world/memory-digest') {
    const digest = stub['/dsh-fish-world/memory-digest']
    let body = {}
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch { body = {} }
    if (body.enabled != null) digest.enabled = body.enabled === true
    digest.updatedAt = new Date().toISOString()
    digest.lines = digest.enabled ? 14 : 0
    digest.textLength = digest.enabled ? 642 : 0
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, ...digest, status: digest }))
    return
  }

  // B 站人设同步：POST 同步一次（预览里回「已同步」，验按钮反馈与重绘）。
  if (req.method === 'POST' && path === '/dsh-fish-world/bili-persona') {
    const sync = { ok: true, bytes: 512, path: '~/.bili-ai/persona.md', at: new Date().toISOString() }
    const status = { installed: true, syncedAt: sync.at, bytes: 512, sameAsCurrent: true }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ...sync, status }))
    return
  }

  if (req.method === 'POST' && path === '/dsh-fish-world/memory/merge') {
    // 并完回一份新的账本（与真实路由同形的 ledger）：草稿清空，卡片当场变。
    const mem = stub['/dsh-fish-world/memory']
    const ledger = {
      ...mem,
      merge: { ...mem.merge, counts: { ...mem.merge.counts, new: 0 }, candidates: (mem.merge.candidates || []).filter((item) => item.state === 'dup') },
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({
      ok: true,
      note: '并了 2 条新碎片（撞车 1 条没动）',
      changed: true,
      ledger,
      steps: [
        { label: '备份知识库', detail: '知识库.json.bak-20261027-220300', tone: 'ok' },
        { label: '逐条写入', detail: '2 条新条目；1 条说法撞车，跳过', tone: 'ok' },
        { label: '回读确认', detail: '读回来 8 条', tone: 'ok' },
      ],
    }))
    return
  }

  if (Object.hasOwn(stub, path)) {
    let body = stub[path]
    // 心情状态带 ?key=<份 id>：预览也要按份回，否则「切换心情」看着点了没反应。
    if (path === '/dsh-feiyu-mood/state' && body && Array.isArray(body.slots)) {
      const key = url.searchParams.get('key')
      const slot = key ? body.slots.find((item) => item.id === key) : null
      body = { ...body, key: slot ? slot.id : body.key, label: slot ? slot.label : body.label }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
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
