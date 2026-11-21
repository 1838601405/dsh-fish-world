// 测试残留保护的判据（2026-11-21 主人要求）。
//
// 危害很具体：别人加她好友看到的是 "x"。
// 我已经两次把测试值留在真实账号上（昵称 x、群名片「小鲸鱼」）。
// 靠"记得还原"不可靠 —— 要靠代码强制。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProfileEdit } from '../lib/profile-edit.mjs'

/** 可控的假账号：记录 nickname / signature，能回读。 */
function mkAccount({ nickname = '哦鲸鲸不是欧金金', signature = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prof-test-'))
  const server = { nickname, signature }
  let t = Date.parse('2026-11-21T10:00:00+08:00')
  const calls = []
  const acts = []
  const qq = {
    async call(action, body) {
      calls.push({ action, body })
      if (action === 'set_qq_profile') {
        if (body?.nickname) server.nickname = body.nickname
        if (body?.personal_note != null) server.signature = body.personal_note
        return { ok: true }
      }
      if (action === 'get_login_info') return { ok: true, data: { user_id: 1, nickname: server.nickname } }
      if (action === 'get_stranger_info') return { ok: true, data: { user_id: 1, nickname: server.nickname } }
      return { ok: true }
    }
  }
  const pe = createProfileEdit({
    qq,
    activity: { append: (e) => acts.push(e) },
    gate: { checkAction: () => ({ ok: true }) },
    approvedWish: () => true,
    stateFile: join(dir, 'state.json'),
    now: () => t,
    log: () => {}
  })
  return { pe, server, calls, acts, dir, advance: (ms) => { t += ms } }
}

test('★ runInTestMode：里面改的资料，结束后自动还原', async () => {
  const { pe, server } = mkAccount({ nickname: '哦鲸鲸不是欧金金' })
  const r = await pe.runInTestMode(async () => {
    await pe.setProfile({ nickname: 'x', source: 'owner' })
    assert.equal(server.nickname, 'x', '测试期间确实改了')
  })
  assert.equal(server.nickname, '哦鲸鲸不是欧金金', '★ 结束后必须自动还原')
  assert.equal(r.restored, true)
  assert.equal(r.ok, true)
})

test('★★ runInTestMode：回读校验（改完必须和测试前一致）', async () => {
  const { pe } = mkAccount({ nickname: '哦鲸鲸不是欧金金' })
  const r = await pe.runInTestMode(async () => {
    await pe.setProfile({ nickname: 'x', source: 'owner' })
  })
  assert.equal(r.verified, true, '★ 回读要和测试前一致')
})

test('★★ 测试中途抛错也要还原（finally 语义）', async () => {
  const { pe, server } = mkAccount({ nickname: '哦鲸鲸不是欧金金' })
  const r = await pe.runInTestMode(async () => {
    await pe.setProfile({ nickname: 'x', source: 'owner' })
    throw new Error('测试故意失败')
  })
  assert.equal(server.nickname, '哦鲸鲸不是欧金金', '★ 抛错也必须还原')
  assert.equal(r.restored, true)
  assert.match(r.error, /故意失败/, '错误要留在结果里')
})

test('★ 还原失败要如实报（不假成功）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prof-badrestore-'))
  let nickname = '哦鲸鲸不是欧金金'
  let failSet = false
  const pe = createProfileEdit({
    qq: {
      async call(action, body) {
        if (action === 'set_qq_profile') {
          if (failSet) return { ok: false, error: '被拦了' }
          if (body?.nickname) nickname = body.nickname
          return { ok: true }
        }
        if (action === 'get_login_info') return { ok: true, data: { user_id: 1, nickname } }
        if (action === 'get_stranger_info') return { ok: true, data: { user_id: 1, nickname } }
        return { ok: true }
      }
    },
    activity: { append: () => {} },
    gate: { checkAction: () => ({ ok: true }) },
    approvedWish: () => true,
    stateFile: join(dir, 'state.json'),
    now: () => Date.parse('2026-11-21T10:00:00+08:00'),
    log: () => {}
  })
  const r = await pe.runInTestMode(async () => {
    await pe.setProfile({ nickname: 'x', source: 'owner' })
    failSet = true   // 还原时让它失败
  })
  assert.equal(r.restored, false, '★ 还原失败不许说成功')
  assert.equal(r.ok, false)
})

test('没改过任何东西时，runInTestMode 也正常返回', async () => {
  const { pe } = mkAccount()
  const r = await pe.runInTestMode(async () => 'nothing')
  assert.equal(r.result, 'nothing')
  assert.equal(r.verified, true, '没改过 = 无需校验')
})

test('★★ 回读校验真的在比（造一个「还原后仍不一致」的账号）', async () => {
  // 反证 2 第一次没红的教训：前面几条测试里还原都成功了，
  // 回读校验永远一致 ⇒ 把校验写成恒 true 也测不出来。
  // 这条造一个「set 报成功但没真改」的账号，逼校验生效。
  const dir = mkdtempSync(join(tmpdir(), 'prof-stuck-'))
  // ★ 关键：服务端一开始是原名；set_qq_profile 收下但不生效；
  //   然后**改成测试值后才开始卡住** —— 这样基准是原名、还原后是测试值，
  //   校验才能判出"不一致"。
  let serverName = '哦鲸鲸不是欧金金'
  let stuck = false
  const pe = createProfileEdit({
    qq: {
      async call(action) {
        if (action === 'set_qq_profile') {
          // 假成功：第一次（测试时）真的改；第二次（还原时）卡住不改
          if (!stuck) { serverName = 'x'; stuck = true }
          return { ok: true }
        }
        if (action === 'get_login_info') return { ok: true, data: { user_id: 1, nickname: serverName } }
        if (action === 'get_stranger_info') return { ok: true, data: { user_id: 1, nickname: serverName } }
        return { ok: true }
      }
    },
    activity: { append: () => {} },
    gate: { checkAction: () => ({ ok: true }) },
    approvedWish: () => true,
    stateFile: join(dir, 'state.json'),
    now: () => Date.parse('2026-11-21T10:00:00+08:00'),
    log: () => {}
  })
  const r = await pe.runInTestMode(async () => {
    // 用真实 API：先让 peek 记下原值，再"改"成 x（set 假成功所以服务端不变）
    await pe.setProfile({ nickname: 'x', source: 'owner' })
  })
  // 关键：还原后回读仍卡在 x ⇒ verified 必须 false（证明校验在真比）
  assert.equal(r.verified, false,
    '★ 还原后回读仍是测试值 ⇒ verified 必须 false（证明校验在真比）')
})

test('★★ 连基准都拿不到时，verified 必须 false（不许假装校验过）', async () => {
  // 反证 3 第一次没红的教训：正常情况 baseline 总能从服务端拿到，
  // 所以"没基准"这条分支走不到 —— 把 else 改成 true 也测不出来。
  // 这条造一个「读昵称永远失败」的账号，逼那条分支生效。
  const dir = mkdtempSync(join(tmpdir(), 'prof-noname-'))
  const pe = createProfileEdit({
    qq: {
      async call(action) {
        if (action === 'set_qq_profile') return { ok: true }
        // 读昵称一律失败 / 返回空
        if (action === 'get_login_info') return { ok: false }
        if (action === 'get_stranger_info') return { ok: false }
        return { ok: true }
      }
    },
    activity: { append: () => {} },
    gate: { checkAction: () => ({ ok: true }) },
    approvedWish: () => true,
    stateFile: join(dir, 'state.json'),
    now: () => Date.parse('2026-11-21T10:00:00+08:00'),
    log: () => {}
  })
  const r = await pe.runInTestMode(async () => 'nothing')
  assert.equal(r.verified, false,
    '★ 拿不到基准 = 没校验成 ⇒ 必须 false，不能假装通过')
})

test('源码级：runInTestMode 用的是 finally 语义（抛错也还原）', () => {
  const src = readFileSync('lib/profile-edit.mjs', 'utf8')
  // 必须在 catch 之后仍然调 restoreProfile
  const i = src.indexOf('async function runInTestMode')
  const seg = src.slice(i, i + 1600)
  assert.match(seg, /try \{[\s\S]*?\} catch/, '要捕获异常')
  assert.match(seg, /restoreProfile/, '★ 要调还原')
  // 还原在 catch 之后（不是只在成功路径）
  const catchIdx = seg.indexOf('catch')
  const restoreIdx = seg.indexOf('restoreProfile')
  assert.ok(restoreIdx > catchIdx, '★ restoreProfile 要在 catch 之后（保证异常也还原）')
})

test('群名片也要能还原（setCard 的残留）', () => {
  // ★ 这条是补充：群名片不在 profile-edit 里，是 chat-actions 的 setCard
  //   但同样的道理 —— 测试改过就要还原。判据只确认那边有回读校验。
  const src = readFileSync('lib/chat-actions.mjs', 'utf8')
  assert.match(src, /get_group_member_info/, 'setCard 要有回读校验（防假成功）')
  assert.match(src, /没改成/, '回读不一致要如实说')
})
