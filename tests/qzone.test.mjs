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

function fixture(config = {}) {
  const worldPath = join(mkdtempSync(join(tmpdir(), 'fish-world-qzone-')), '鱼的世界')
  const calls = []
  const qq = {
    async call(action, body) {
      assert.equal(action, 'get_cookies')
      assert.equal(body.domain, 'qzone.qq.com')
      return { ok: true, data: { cookies: `uin=o${UIN}; p_skey=fake-skey; skey=fake-skey` } }
    },
  }
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    calls.push({ url: parsed, init })
    assert.equal(parsed.origin, 'https://user.qzone.qq.com', 'Qzone fetch must stay on the fixed Tencent origin')
    if (parsed.pathname.endsWith('feeds3_html_more')) {
      return new Response(JSON.stringify({ data: { data: [TID, TID2, TID3].map((tid, index) => ({
        uin: FRIEND, key: tid, abstime: 1792771200 - index * 60, nickname: `朋友${index + 1}`,
        html: `<span>有趣的动态 ${index + 1}</span>`, likecount: 1, commentcount: 2,
      })) } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('emotion_cgi_msgdetail_v6')) {
      return new Response(JSON.stringify({ data: { commentlist: [{
        uin: FRIEND, nickname: '朋友', commentid: '98765', content: '原评论',
      }] } }), { status: 200 })
    }
    if (parsed.pathname.endsWith('emotion_cgi_publish_v6')) {
      return new Response(`callback({"code":0,"t1_tid":"${TID}"});`, { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0, ret: 0 }), { status: 200 })
  }
  const world = {
    status: () => ({ ok: true, worldPath }),
    root: () => worldPath,
  }
  const service = createQzoneService({
    qq,
    world,
    config: () => ({ qzone: { enabled: true, postsPerDay: 2, likesPerDay: 2, commentsPerDay: 2, repliesPerDay: 2, ...config } }),
    fetchImpl,
  })
  return { service, calls, worldPath }
}

test('Qzone parser handles JSON, JSONP, JS literal and keeps cookies out of status', async () => {
  assert.deepEqual(__test.parseQzoneResponse('callback({"code":0,"x":1});'), { code: 0, x: 1 })
  assert.deepEqual(__test.parseQzoneResponse("cb({data:{ok:true, text:'hello'},});"), { data: { ok: true, text: 'hello' } })
  const { service } = fixture()
  const status = service.status()
  assert.equal(status.ok, true)
  assert.equal(JSON.stringify(status).includes('fake-skey'), false)
})

test('posts and diaries share their editable daily cap and concurrency cannot exceed it', async () => {
  const { service, worldPath } = fixture({ postsPerDay: 2 })
  const posts = await Promise.allSettled([
    service.post({ text: '第一条' }),
    service.post({ text: '第二条' }),
    service.post({ text: '第三条' }),
  ])
  assert.equal(posts.filter((result) => result.status === 'fulfilled').length, 2)
  assert.equal(posts.filter((result) => result.status === 'rejected').length, 1)
  assert.match(posts.find((result) => result.status === 'rejected').reason.message, /额度已用完/)
  await assert.rejects(() => service.post({ text: '今日记录', diary: true }), /额度已用完/)
  const afterRestart = createQzoneService({
    qq: { call: async () => ({ ok: true, data: { cookies: `uin=o${UIN};p_skey=fake` } }) },
    world: { status: () => ({ ok: true, worldPath }), root: () => worldPath },
    config: () => ({ qzone: { enabled: true, postsPerDay: 2 } }),
    fetchImpl: async () => new Response('{}'),
  })
  assert.equal(afterRestart.status().usage.byKind.post.used, 2, '额度在进程重启后仍保存在工作区')
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
  const persisted = readFileSync(join(worldPath, '安全与审计', 'qzone-actions.json'), 'utf8')
  assert.equal(persisted.includes('原评论'), false, '私人动态正文和评论原文不写入持久化状态')
  assert.equal(persisted.includes('一条有趣的动态'), false)
  await assert.rejects(() => service.reply({ uin: feed.uin, tid: feed.tid, commentId: '111', commentUin: FRIEND, content: '不在清单中的评论' }), /清单中/)
  assert.ok(calls.every((call) => call.url.origin === 'https://user.qzone.qq.com'))
  assert.ok(calls.every((call) => call.init.redirect === 'error'))
  assert.ok(calls.every((call) => String(call.init.headers.cookie).includes('p_skey=')))
})

test('Qzone endpoints reject invalid or non-cached feed identifiers before network writes', async () => {
  const { service, calls } = fixture()
  await assert.rejects(() => service.like({ uin: '127.0.0.1', tid: TID }), /无效/)
  await assert.rejects(() => service.comment({ uin: FRIEND, tid: TID, content: 'hello' }), /最近一次列表/)
  assert.equal(calls.length, 0)
})
