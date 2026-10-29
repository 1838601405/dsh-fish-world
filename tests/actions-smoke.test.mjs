// 45 个动作的冒烟：每条都真调一次，只看「有没有走到实现」。
//
// 为什么值得写：`stickers` 曾经是个死分支——`[].filter(...)` 对空数组过滤，永远回
// 「没有匹配的表情图」。它一直可调、一直"成功"，只是永远没内容。这类假成功，
// 读说明看不出来，只有真调一遍才露。所以这里对每条动作的最低要求是：
//  1. 返回里有布尔 `ok`；
//  2. 不能是「未知 action」——那说明 ACTIONS 里写了、实现里没分支；
//  3. 成功时 content 不能是空串（空 = 用户什么也看不到）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEcosystemTool } from '../lib/tool.mjs'

/** 环境检查结果的完整形状：environmentView() 会读 wiring / config / warnings / hints / home 等字段。 */
function smEnv() {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    profile: 'desktop',
    home: '',
    node: { version: 'v24.0.0' },
    packages: [],
    missing: [],
    wiring: { checked: true, ok: true, issues: [] },
    config: { ok: true, error: '' },
    warnings: [],
    hints: [],
    fixCommand: '',
    summary: '',
  }
}
const TODAY = new Date().toISOString()

/** 一套「什么都有、但什么都不干」的最小桩：只要不抛，就说明这条动作走到了自己的实现里。 */
function buildTool(overrides = {}) {
  const audits = []
  const base = {
    loader: {
      list: () => [{ id: 'demo-ext', version: '1.0.0', kind: 'skill', status: 'loaded' }],
      status: async () => ({ version: '0.2.0', extensions: [], tools: [], bridge: { masterSwitch: true, trial: false, napCat: 'http://127.0.0.1:3000' }, roles: { current: { name: '鱼' } } }),
      setEnabled: async () => ({ ok: true }),
      reload: async () => ({ ok: true }),
    },
    qq: {
      snapshot: () => ({ ok: true }),
      config: () => ({}),
      loginInfo: async () => ({ ok: true, userId: '777' }),
      recent: async () => ({ ok: true, messages: [{ userId: '1', nickname: '甲', text: '一句话', at: Date.now() }] }),
      send: async () => ({ ok: true, sent: [{ kind: 'text', id: '1' }] }),
      sendImage: async () => ({ ok: true, sent: [{ kind: 'image', id: '2' }] }),
      poke: async () => ({ ok: true }),
      forward: async () => ({ ok: true, entries: [] }),
    },
    roles: { current: () => ({ id: 'default', name: '鱼', avatar: '' }), summary: () => ({ roles: [] }) },
    world: {
      status: () => ({ ok: true, worldPath: '', platforms: {} }),
      chatTargetForSession: () => ({ chatKey: 'private:10000001' }),
      isOwnerSession: () => true,
      listRelations: () => ({ owner: { qqId: '10000001', sessionId: 's1' }, people: [] }),
      chatTargets: () => [{ chatKey: 'private:10000001', sessionId: 's1' }],
      appendSecurity: (row) => { audits.push(row); return { ok: true } },
      ownerBinding: () => ({ qq: { bridge: '10000001' }, session: { bridge: 's1' } }),
      listDiary: () => [],
      listDiaryComments: () => [],
      pendingDiaryComments: () => [],
      appendDiary: () => ({ id: 'd1', suggestion: false }),
      markDiaryCommentResponded: () => ({ ok: true, comment: { id: 'c1' } }),
      appendWish: () => ({ wish: { id: 'w1' } }),
      wishSummary: () => ({ pending: 0, total: 0 }),
      listRelations: () => ({ owner: { qqId: '10000001', sessionId: 's1' }, people: [] }),
    },
    stickers: {
      search: () => [{ id: 'a', name: '歪头', tags: ['可爱'], emojiId: '' }],
      summary: () => ({ total: 1, remainingThisHour: 4, limit: 5, pending: 0, synced: 1, useCustomFace: true }),
      toView: (item) => item,
      add: async () => ({ id: 'a', name: '歪头', tags: ['可爱'] }),
      send: () => ({ ok: true }),
      syncFavorites: async () => ({ ok: true, added: 1, failed: 0, errors: [] }),
      remove: () => ({ ok: true }),
      tags: () => [{ tag: '可爱', count: 1 }],
      get: (key) => ({ id: 'a', name: '歪头', tags: ['可爱'] }),
      updateTags: (id, tags) => ({ id, name: '歪头', tags: tags || ['可爱'] }),
    },
    links: {
      list: () => [{ id: 'l1', title: '示例站', url: 'https://example.com', kind: 'design', tags: ['配色'] }],
      summary: () => ({ total: 1 }),
      add: () => ({ ok: true, item: { id: 'l1', title: '示例站' } }),
      remove: () => ({ ok: true }),
    },
    qzone: {
      // 注意：qzone.status() 是**同步**的（见 lib/qzone.mjs），桩不能写成 async。
      status: () => ({ ok: true, enabled: true, usage: { byKind: {} }, diaryDue: false }),
      listFeeds: async () => ({ ok: true, items: [{ nickname: '甲', uin: '1', tid: 'f1', content: '一条动态', time: '2026-10-28', likes: 0, comments: 0 }], hasMore: false }),
      listComments: async () => ({ ok: true, comments: [{ nickname: '甲', uin: '1', id: 'c1', content: '一条评论' }] }),
      post: async () => ({ ok: true, id: 'p1' }),
      diary: async () => ({ ok: true, id: 'd1' }),
      like: async () => ({ ok: true }),
      comment: async () => ({ ok: true, id: 'c2' }),
      reply: async () => ({ ok: true, id: 'c3' }),
      config: () => ({ enabled: true, postsPerDay: 2, likesPerDay: 2, commentsPerDay: 2, repliesPerDay: 2 }),
      actionCount: () => 0,
    },
    environment: {
      status: () => smEnv(),
      check: () => smEnv(),
    },
    growth: {
      status: () => ({ ok: true, total: 1, todayCount: 0, dailyLimit: 2, stage: { name: '小鱼', next: null }, toNext: 0 }),
      recent: () => ({ ok: true, entries: [{ id: 'g1', text: '想明白一件事', at: TODAY }] }),
      record: () => ({ ok: true, entry: { id: 'g2' } }),
    },
    platforms: {
      gate: () => ({ ok: true }),
      status: () => ({ ok: true, platforms: [] }),
      update: () => ({ ok: true }),
      platform: () => ({ enabled: true }),
      refresh: async () => ({ ok: true }),
    },
    astrbot: {
      view: () => ({ canBorrowTools: true, enabled: true }),
      tools: async () => ({ ok: true, tools: [{ name: 'search_web', description: '搜一下' }] }),
      runTool: async () => ({ ok: true, output: '外部结果' }),
      snapshot: () => ({}),
    },
    qqagent: {
      view: () => ({ active: true }),
      tools: async () => ({ ok: true, tools: [{ name: 'netdisk', description: '网盘' }] }),
      runTool: async () => ({ ok: true, output: '外部结果' }),
    },
    activity: {
      append: () => ({ ok: true }),
      status: () => ({ ok: true, platforms: {} }),
      list: () => ({ ok: true, items: [], total: 0 }),
      stats: () => ({ ok: true, interactions: 1, ownerSaid: 1, fishSaid: 0, days: 1, recentDays: [], hours: [] }),
    },
    records: {
      listMemos: () => [{ day: '2026-10-28', text: '一条记录' }],
      listGrudges: () => [],
      addMemo: () => ({ ok: true, item: { day: '2026-10-28', text: '记下了' } }),
    },
    knowledge: {
      status: () => ({ ok: true, items: 1 }),
      search: async () => ({ ok: true, hits: [{ text: '死鱼眼：没话说的时候用' }], notes: [], backend: 'literal' }),
      rebuild: async () => ({ ok: true, rebuilt: true }),
    },
    media: {
      run: async (args) => ({ ok: true, op: args.op, content: '视频自检正常', durationMs: 1 }),
    },
    imageRefs: async () => [],
  }
  return { tool: buildEcosystemTool({ ...base, ...overrides }), audits }
}

/** 每条动作的最小参数：需要参数的给上，不需要的留空。 */
const ARGS = {
  send: { text: '一句话' },
  history: { limit: 5 },
  forward: { forwardId: 'f1' },
  'sticker-collect': { url: 'https://example.com/a.jpg', name: '歪头' },
  'sticker-send': { name: '歪头' },
  'sticker-sync': { limit: 1 },
  'sticker-remove': { name: '歪头' },
  'sticker-tags': { id: 'a', tags: ['可爱', '嘲讽'] },
  'link-collect': { url: 'https://example.com', title: '示例站' },
  'link-remove': { id: 'l1' },
  enable: { id: 'demo-ext' },
  disable: { id: 'demo-ext' },
  diary: { text: '今天很安静' },
  'diary-comment-ack': { commentId: 'c1', note: '收到' },
  wish: { text: '想吃白饭' },
  growth: { text: '想明白一件事', kind: 'insight' },
  record: { text: '记住这句话' },
  know: { query: '死鱼眼' },
  'astrbot-tool': { tool: 'search_web', params: {} },
  'qqagent-tool': { tool: 'netdisk', params: {} },
  'qzone-post': { text: '一条动态' },
  'qzone-diary': { text: '一篇日记' },
  'qzone-like': { tid: 'f1' },
  'qzone-comment': { tid: 'f1', text: '评论' },
  'qzone-reply': { tid: 'f1', commentId: 'c1', text: '回复' },
  video: { op: 'health' },
}

const ACTIONS = [
  'status', 'list', 'enable', 'disable', 'reload', 'send', 'persona', 'stickers', 'history', 'forward',
  'qq-status', 'sticker-list', 'sticker-collect', 'sticker-send', 'sticker-sync', 'sticker-tags', 'sticker-remove',
  'link-list', 'link-collect', 'link-remove', 'world', 'relations', 'diary', 'diary-comment-ack',
  'wish', 'growth', 'platforms', 'activity', 'record', 'know', 'doctor', 'env-check',
  'qzone-status', 'qzone-feeds', 'qzone-comments', 'qzone-post', 'qzone-diary', 'qzone-like',
  'qzone-comment', 'qzone-reply', 'astrbot-tools', 'astrbot-tool', 'qqagent-tools', 'qqagent-tool',
  'video',
]

// 服务齐全时允许失败的动作：每一条都要写清「为什么它可以失败」。
// 空集合：服务齐全时**每一条**都必须成功。
// （doctor 曾经在这里：它读真实 profile，测试副本没 link 进去必然报接线异常。
//  现在 doctor 把「体检跑完」与「体检结论」分成 ok / healthy 两件事，ok 恒为 true，
//  所以它不再需要豁免。）
const ALLOW_FAIL = new Set([])

for (const action of ACTIONS) {
  test(`冒烟：${action} 走到了实现，不是「未知 action」`, async () => {
    const { tool } = buildTool()
    const result = await tool.execute({ action, ...(ARGS[action] || {}) }, { agent: { sessionId: 's1' } })
    assert.equal(typeof result?.ok, 'boolean', `${action} 的返回里没有布尔 ok：${JSON.stringify(result)}`)
    // 「未知 action」= ACTIONS 里写了、实现里没分支 —— 这正是 stickers 当初那种假成功。
    assert.ok(!/未知 action/.test(String(result.error || '')), `${action} 没有实现分支`)
    // 服务全在、参数也给了，还失败就是真有问题：`persona` 当年就是这样——变量名写错，
    // 每次抛 ReferenceError；它「有分支、ok 是布尔」，读代码和旧判据都看不出来。
    // 例外只放「必须靠外部状态」的动作，且要写清为什么。
    if (!ALLOW_FAIL.has(action)) {
      assert.equal(result.ok, true, `${action} 在服务齐全时仍然失败：${JSON.stringify(result).slice(0, 160)}`)
    }
    // 成功时不能给一个空串：那等于「点了没反应」。
    if (result.ok && 'content' in result) {
      assert.notEqual(String(result.content || '').trim(), '', `${action} 成功了但 content 是空的`)
    }
  })
}
// 只判「有没有分支」还不够：`stickers` 当年返回的是 `{ok:true, content:'没有匹配的表情图'}`——
// 分支在、ok 是真、content 非空，只是**内容永远不对**。所以对「桩里备了数据」的读路径，
// 还要断言返回值里真的带着那份数据。
const EXPECT = {
  stickers: '歪头',
  'sticker-list': '歪头',
  history: '一句话',
  'link-list': '示例站',
  record: '记下了',
  'qzone-feeds': '一条动态',
  'qzone-comments': '一条评论',
  'sticker-tags': '可爱',
}

for (const [action, needle] of Object.entries(EXPECT)) {
  test(`冒烟：${action} 要把桩里的数据真带回来（不是空壳）`, async () => {
    const { tool } = buildTool()
    const result = await tool.execute({ action, ...(ARGS[action] || {}) }, { agent: { sessionId: 's1' } })
    assert.equal(result.ok, true, `${action} 该成功：${JSON.stringify(result)}`)
    assert.ok(
      String(result.content || '').includes(needle),
      `${action} 的返回里没有桩数据「${needle}」：${String(result.content || '').slice(0, 80)}`,
    )
  })
}
test('doctor：体检跑完就是成功，结论单独用一个字段说', async () => {
  const { tool } = buildTool()
  const result = await tool.execute({ action: 'doctor' }, {})
  // ok = 「这次调用跑完了」；healthy = 「体检结论好不好」。
  // 原来用 ok 兼表「有毛病」，模型只看到 ok:false，会以为工具坏了或者去重试。
  assert.equal(result.ok, true, '体检跑完就该 ok:true，哪怕查出问题')
  assert.equal(typeof result.healthy, 'boolean', '结论要用 healthy 字段单独说')
  assert.ok(String(result.content || '').length > 0, '要给出内容：结论 + 修复方式')
  assert.ok(result.dependency, '原始体检结果也要带回去，方便追问细节')
})
test('env-check 失败时也要说「这不是鱼本身坏了」，并把接线问题单独摆出来', async () => {
  const bad = {
    ok: false, checkedAt: '', profile: 'desktop', home: '', node: { version: 'v24' },
    packages: [], missing: [],
    wiring: { checked: true, ok: false, issues: [{ code: 'link-wrong-target', message: 'node_modules/dsh-fish-world 指向 A，不是当前插件目录 B' }] },
    config: { ok: true, error: '' }, warnings: ['还有一条别的问题'], hints: [{ command: 'npm run doctor --fix' }],
    fixCommand: '', summary: '',
  }
  const { tool } = buildTool({ environment: { check: () => bad, status: () => bad } })
  const result = await tool.execute({ action: 'env-check' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.healthy, false, '结论要用 healthy 说，别只靠 ok')
  assert.match(result.content, /这不是鱼本身坏了/, '要先说清不是鱼坏了，模型才不会当成故障')
  assert.match(result.content, /不是当前插件目录/, '接线问题要单独摆出来')
  assert.match(result.content, /修复方式：/)
})
// ---- 空态：桩在、但数据是空的 ----
// 这是另一条容易烂的路：**静默空**。`ok:true` + `content:''` 等于「点了没反应」，
// 而「空」本身不是错——错的是不说清「现在确实没有」。所以这里要求：可以成功，但必须
// 用一句人话说清「没有」，不许交白卷，也不许把空当成失败。
const EMPTY = {
  stickers: {
    search: () => [],
    summary: () => ({ total: 0, remainingThisHour: 5, limit: 5, pending: 0 }),
    toView: (item) => item,
    add: async () => ({ id: 'a', name: 'x', tags: [] }),
    send: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    tags: () => [],
    get: () => null,
    updateTags: () => null,
  },
  links: {
    list: () => [],
    summary: () => ({ total: 0, remainingThisHour: 5 }),
    add: () => ({ ok: true, item: { id: 'l1', title: 't' } }),
    remove: () => ({ ok: true }),
  },
  records: {
    listMemos: () => [],
    listGrudges: () => [],
    addMemo: () => ({ ok: true, item: { day: '2026-10-28', text: '记下了' } }),
  },
  qzone: {
    status: () => ({ ok: true, enabled: true, usage: { byKind: {} }, diaryDue: false }),
    listFeeds: async () => ({ ok: true, items: [], hasMore: false }),
    listComments: async () => ({ ok: true, comments: [] }),
    post: async () => ({ ok: true, id: 'p1' }),
    diary: async () => ({ ok: true, id: 'd1' }),
    like: async () => ({ ok: true }),
    comment: async () => ({ ok: true, id: 'c2' }),
    reply: async () => ({ ok: true, id: 'c3' }),
    config: () => ({ enabled: true }),
    actionCount: () => 0,
  },
}

const EMPTY_CASES = [
  ['sticker-list', /还没有收藏的表情/],
  ['link-list', /还没收藏链接/],
  ['record', /还没有记录/],
  ['qzone-feeds', /暂时没有读取到好友动态/],
  ['qzone-comments', /没有读取到评论/],
]

for (const [action, pattern] of EMPTY_CASES) {
  test(`空态：${action} 要明说「没有」，不许交白卷`, async () => {
    const { tool } = buildTool(EMPTY)
    // record 带 text 就是「记一条」，那走的是写路径；空态要测的是「不带 text 只读」。
    const emptyArgs = action === 'record' ? {} : (ARGS[action] || {})
    const result = await tool.execute({ action, ...emptyArgs }, { agent: { sessionId: 's1' } })
    assert.equal(result.ok, true, `空不是错，不该判失败：${JSON.stringify(result).slice(0, 120)}`)
    assert.match(String(result.content || ''), pattern, `${action} 的空态要说清「没有」，不能给空串`)
  })
}
