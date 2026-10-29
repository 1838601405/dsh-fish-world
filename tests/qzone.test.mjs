import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createQzoneService, __test } from '../lib/qzone.mjs'

const UIN = '12345678'
const FRIEND = '23456789'
const TID = '0123456789abcdef01234567'
const TID2 = '1123456789abcdef01234567'
const TID3 = '2123456789abcdef01234567'

/**
 * 造一个假的 qq（只实现 call），把每次调用记进 calls 供断言。
 * 上游返回结构对齐 SnowLuma 的空间接口（get_qzone_feeds / get_qzone_msg_detail /
 * send_qzone_msg / like_qzone / comment_qzone / get_login_info）。
 * overrides 可以按 action 覆盖某个 handler，用来构造失败或缺字段的场景。
 */
function makeQQ(overrides = {}) {
  const calls = []
  const handlers = {
    get_login_info: () => ({ ok: true, data: { user_id: Number(UIN) } }),
    get_qzone_feeds: () => ({
      ok: true,
      data: {
        feeds: [TID, TID2, TID3].map((tid, index) => ({
          uin: Number(FRIEND),
          nickname: `朋友${index + 1}`,
          time: 1792771200 - index * 60,
          tid,
          content: `有趣的动态 ${index + 1}`,
          like_count: 1,
          comment_count: 2,
        })),
        has_more: false,
        next_cursor: '',
      },
    }),
    get_qzone_msg_detail: () => ({
      ok: true,
      data: {
        tid: TID,
        comment_num: 1,
        comments: [{
          uin: Number(FRIEND), name: '朋友', time: 0, content: '原评论', comment_id: '98765', replies: [],
        }],
      },
    }),
    send_qzone_msg: () => ({ ok: true, data: { tid: TID, time: 0 } }),
    like_qzone: () => ({ ok: true, data: null }),
    comment_qzone: () => ({ ok: true, data: { comment_id: '98766', parent_comment_id: '', parent_comment_uin: 0 } }),
    ...overrides,
  }
  const qq = {
    async call(action, params, options) {
      calls.push({ action, params, options })
      const handler = handlers[action]
      if (!handler) return { ok: false, error: `fixture 未预期的 action: ${action}` }
      return handler(params, options)
    },
  }
  return { qq, calls }
}

function fixture(config = {}, extraWorld = {}, qqOverrides = {}) {
  const worldPath = join(mkdtempSync(join(tmpdir(), 'fish-world-qzone-')), '鱼的世界')
  const { qq, calls } = makeQQ(qqOverrides)
  const world = { status: () => ({ ok: true, worldPath }), root: () => worldPath, ...extraWorld }
  const service = createQzoneService({
    qq,
    world,
    config: () => ({ qzone: { enabled: true, postsPerDay: 2, likesPerDay: 2, commentsPerDay: 2, repliesPerDay: 2, ...config } }),
  })
  return { service, calls, worldPath, qq }
}

test('状态只报事实，不外泄登录态；normalizeFeed 认新结构 content 优先、html 兜底', () => {
  const { service } = fixture()
  const status = service.status()
  assert.equal(status.ok, true)
  // 新结构：content 已是纯文本，优先用它。
  const fed = __test.normalizeFeed({ uin: Number(FRIEND), tid: TID, time: 1792771200, content: '纯文本正文', html: '<b>html正文</b>', like_count: 3, comment_count: 4 })
  assert.equal(fed.content, '纯文本正文')
  assert.equal(fed.likes, 3)
  assert.equal(fed.comments, 4)
  // 没有 content 时，从 html 解一层兜底。
  const fromHtml = __test.normalizeFeed({ uin: Number(FRIEND), tid: TID, time: 1792771200, html: '<span>只有 html</span>' })
  assert.equal(fromHtml.content, '只有 html')
})

test('posts and diaries share their editable daily cap and concurrency cannot exceed it', async () => {
  const { service, worldPath, qq } = fixture({ postsPerDay: 2 })
  const posts = await Promise.allSettled([
    service.post({ text: '第一条' }),
    service.post({ text: '第二条' }),
    service.post({ text: '第三条' }),
  ])
  assert.equal(posts.filter((result) => result.status === 'fulfilled').length, 2)
  assert.equal(posts.filter((result) => result.status === 'rejected').length, 1)
  assert.match(posts.find((result) => result.status === 'rejected').reason.message, /额度已用完/)
  await assert.rejects(() => service.post({ text: '今日记录', diary: true }), /额度已用完/)
  // 额度在进程重启后仍保存在工作区：新造一个 service 指向同一个 worldPath。
  const afterRestart = createQzoneService({
    qq: { call: async () => ({ ok: true, data: {} }) },
    world: { status: () => ({ ok: true, worldPath }), root: () => worldPath },
    config: () => ({ qzone: { enabled: true, postsPerDay: 2 } }),
  })
  assert.equal(afterRestart.status().usage.byKind.post.used, 2, '额度在进程重启后仍保存在工作区')
  assert.ok(qq, 'fixture 提供了假 qq')
})

test('diary reminder is based on a rolling 24-hour clock and uses the workspace ledger', () => {
  const { service, worldPath } = fixture()
  const stateFile = join(worldPath, '安全与审计', 'qzone-actions.json')
  mkdirSync(join(worldPath, '安全与审计'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    actions: [{ id: 'old-diary', kind: 'diary', day: '2026-10-21', at: Date.now() - 24 * 60 * 60 * 1000 - 1, status: 'success' }],
    acted: {}, feedCache: [], commentCache: {},
  }))
  assert.equal(service.status().diaryDue, true)
})

test('a successful diary clears the 24-hour reminder', async () => {
  const { service, worldPath } = fixture()
  const stateFile = join(worldPath, '安全与审计', 'qzone-actions.json')
  mkdirSync(join(worldPath, '安全与审计'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    createdAt: Date.now() - 25 * 60 * 60 * 1000,
    diaryPromptAt: 0,
    actions: [], acted: {}, feedCache: [], commentCache: {},
  }))
  assert.equal(service.status().diaryDue, true)
  await service.post({ text: '今天有阳光，安静地记一笔。', diary: true })
  assert.equal(service.status().diaryDue, false)
})

test('background reminder claims are owner-workspace-persisted and throttled', async () => {
  const { service, worldPath } = fixture()
  const stateFile = join(worldPath, '安全与审计', 'qzone-actions.json')
  mkdirSync(join(worldPath, '安全与审计'), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    createdAt: Date.now() - 25 * 60 * 60 * 1000,
    diaryPromptAt: 0,
    actions: [], acted: {}, feedCache: [], commentCache: {},
  }))
  assert.equal(await service.claimDiaryReminder(), true)
  assert.equal(await service.claimDiaryReminder(), false, '重复计时器 tick 不会重复投递提醒')
})

test('likes, comments and replies each have a separate daily cap and require cached targets', async () => {
  const { service, calls, worldPath } = fixture({ likesPerDay: 2, commentsPerDay: 2, repliesPerDay: 2 })
  const listed = await service.listFeeds(10)
  assert.equal(listed.items.length, 3)
  const [feed, feed2, feed3] = listed.items
  assert.equal(feed.content, '有趣的动态 1')

  await service.like({ uin: feed.uin, tid: feed.tid })
  await service.like({ uin: feed2.uin, tid: feed2.tid })
  await assert.rejects(() => service.like({ uin: feed3.uin, tid: feed3.tid }), /额度已用完/)
  await service.comment({ uin: feed.uin, tid: feed.tid, content: '说得好' })
  const comments = await service.listComments(feed.uin, feed.tid)
  assert.equal(comments.comments.length, 1)
  await service.comment({ uin: feed2.uin, tid: feed2.tid, content: '谢谢分享' })
  await assert.rejects(() => service.comment({ uin: feed3.uin, tid: feed3.tid, content: '第三条' }), /额度已用完/)
  await service.reply({ uin: feed.uin, tid: feed.tid, commentId: '98765', commentUin: FRIEND, content: '回复一' })
  await service.listComments(feed2.uin, feed2.tid)
  await service.reply({ uin: feed2.uin, tid: feed2.tid, commentId: '98765', commentUin: FRIEND, content: '回复二' })
  await service.listComments(feed3.uin, feed3.tid)
  await assert.rejects(() => service.reply({ uin: feed3.uin, tid: feed3.tid, commentId: '98765', commentUin: FRIEND, content: '回复三' }), /额度已用完/)

  const usage = service.status().usage.byKind
  assert.deepEqual([usage.like.used, usage.comment.used, usage.reply.used], [2, 2, 2])
  // 私人动态正文和评论原文不写入持久化状态。
  const persisted = readFileSync(join(worldPath, '安全与审计', 'qzone-actions.json'), 'utf8')
  assert.equal(persisted.includes('原评论'), false, '评论原文不写入持久化状态')
  assert.equal(persisted.includes('有趣的动态'), false, '动态正文不写入持久化状态')
  // 不在清单里的评论不能回复。
  await assert.rejects(() => service.reply({ uin: feed.uin, tid: feed.tid, commentId: '111', commentUin: FRIEND, content: '不在清单中的评论' }), /清单中/)
  // 全程只走 qq.call，绝不再有 cookie / 直连 CGI。
  assert.ok(calls.every((call) => typeof call.action === 'string'))
  assert.equal(calls.some((call) => call.action === 'get_cookies'), false, '不再申请 cookie')
})

test('发说说走上游 send_qzone_msg，ugc_right 保持仅自己可见（64）', async () => {
  const { service, calls } = fixture()
  const posted = await service.post({ text: '午后安静，记一笔。' })
  assert.equal(posted.ok, true)
  const send = calls.find((call) => call.action === 'send_qzone_msg')
  assert.ok(send, '发说说必须走 send_qzone_msg')
  assert.equal(send.params.content, '午后安静，记一笔。')
  assert.equal(send.params.ugc_right, 64, '可见性保持「仅自己可见」')
  assert.deepEqual(send.params.images, undefined, '纯文字说说不带 images')
  assert.equal(calls.some((call) => call.action === 'get_cookies'), false, '不再申请 cookie')
})

test('点赞/评论的 target_uin 取被操作说说的主人（feeds 里的 uin），不是鱼自己', async () => {
  const { service, calls } = fixture()
  const listed = await service.listFeeds(3)
  const feed = listed.items[0]
  assert.equal(feed.uin, FRIEND, '这条动态的主人是朋友，不是鱼')
  await service.like({ uin: feed.uin, tid: feed.tid })
  const likeCall = calls.find((call) => call.action === 'like_qzone')
  assert.equal(likeCall.params.tid, feed.tid)
  assert.equal(likeCall.params.target_uin, Number(FRIEND), '点赞 target_uin 是说说主人')
  await service.comment({ uin: feed.uin, tid: feed.tid, content: '好看' })
  const commentCall = calls.find((call) => call.action === 'comment_qzone')
  assert.equal(commentCall.params.target_uin, Number(FRIEND), '评论 target_uin 是说说主人')
  assert.equal(commentCall.params.content, '好看')
})

test('协议端没返回 tid 时如实报错，不用默认值掩盖', async () => {
  // 让 send_qzone_msg 返回 ok 但缺 tid。
  const { service } = fixture({}, {}, { send_qzone_msg: () => ({ ok: true, data: {} }) })
  await assert.rejects(() => service.post({ text: '一条可能发出去的说说' }), /未返回动态 ID/)
})

test('外发闸门关着时，读写都拒绝且不碰协议端', async () => {
  const { service, calls } = fixture({ enabled: false })
  await assert.rejects(() => service.post({ text: '不该发出去' }), /已关闭/)
  await assert.rejects(() => service.listFeeds(5), /已关闭/)
  assert.equal(calls.length, 0, '闸门关着时一次都不该调协议端')
})

test('Qzone endpoints reject invalid or non-cached feed identifiers before network writes', async () => {
  const { service, calls } = fixture()
  await assert.rejects(() => service.like({ uin: '127.0.0.1', tid: TID }), /无效/)
  await assert.rejects(() => service.comment({ uin: FRIEND, tid: TID, content: 'hello' }), /最近一次列表/)
  assert.equal(calls.length, 0, '非法或未缓存的目标在碰协议端之前就被拒')
})

// —— 当天写完日记就发一条空间（主人 2026-10-27 要求；外发默认关，要单独打开）——

/** 写一份空间状态文件：createdAt 决定「滚动 24 小时」那条路是否成立。 */
function seedState(worldPath, patch = {}) {
  const dir = join(worldPath, '安全与审计')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'qzone-actions.json'), JSON.stringify({
    version: 1,
    createdAt: Date.now() - 60 * 60 * 1000, // 刚建档：滚动 24 小时还没到
    diaryPromptAt: 0,
    actions: [], acted: {}, feedCache: [], commentCache: {},
    ...patch,
  }), 'utf8')
}

const todayDiaryWorld = (entries) => ({ listDiary: () => entries })

test('状态里如实说明：今天本机写过日记、今天还没发空间日记', () => {
  const { service, worldPath } = fixture({}, todayDiaryWorld([{ at: new Date().toISOString(), text: '今天记了一笔' }]))
  seedState(worldPath)
  const status = service.status()
  assert.equal(status.diaryToday, true)
  assert.equal(status.diaryPostedToday, false)
  assert.equal(status.diaryDue, false, '建档才一小时，滚动 24 小时那条不算到期')
  assert.equal(status.sameDayDue, true)
})

test('没打开「当天就发」时，写过日记也不触发（外发默认关）', async () => {
  const { service, worldPath } = fixture({}, todayDiaryWorld([{ at: new Date().toISOString() }]))
  seedState(worldPath)
  assert.equal(await service.claimDiaryReminder({ allowSameDay: false }), false)
})

test('打开「当天就发」后触发一次，再 claim 不重复投', async () => {
  const { service, worldPath } = fixture({}, todayDiaryWorld([{ at: new Date().toISOString() }]))
  seedState(worldPath)
  assert.equal(await service.claimDiaryReminder({ allowSameDay: true }), true)
  assert.equal(await service.claimDiaryReminder({ allowSameDay: true }), false, '冷却内不重复提醒')
})

test('今天已经发过空间日记，就不该再为同一天催一次', async () => {
  const { service, worldPath } = fixture({}, todayDiaryWorld([{ at: new Date().toISOString() }]))
  seedState(worldPath)
  await service.post({ text: '今天安静地记一笔。', diary: true })
  assert.equal(service.status().diaryPostedToday, true)
  assert.equal(service.status().sameDayDue, false)
  assert.equal(await service.claimDiaryReminder({ allowSameDay: true }), false)
})

test('世界没绑上时 diaryToday 给 null，不当成「今天没写」', () => {
  const { service, worldPath } = fixture({}, { listDiary: () => { throw new Error('鱼的世界尚未绑定到工作区') } })
  seedState(worldPath)
  const status = service.status()
  assert.equal(status.diaryToday, null)
  assert.equal(status.sameDayDue, false)
})

test('发帖正文带上赞与评论数：否则模型看不到别人在她空间的互动', async () => {
  const { service } = fixture()
  const listed = await service.listFeeds(3)
  assert.ok(listed.items[0].likes > 0 && listed.items[0].comments > 0, '台账里本来就有赞与评论数')
  const text = listed.items.map((item) => item.content || '').join(' ')
  assert.ok(!/赞 \d+ · 评 \d+/.test(text), '点赞数不在 qzone 层拼，交给工具层，避免两处口径不一致')
})
