// 图库表情同步进 QQ 账号收藏（add_custom_face → emojiId 落索引），再用 send_custom_face 发。
//
// 全部用假协议端（替换 globalThis.fetch）或假 qq 对象，不碰真协议端、不写真账号收藏。
// 覆盖：老路径不回归、custom_face 分支、chatKey → group_id/user_id 二选一、
// 未收藏时如实报错、闸门与额度复用、setdiff 兜底、同步幂等与 limit。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfigStore } from '../lib/config.mjs'
import { createQQ } from '../lib/qq.mjs'
import { createStickers } from '../lib/stickers.mjs'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
// 真实 emoji_id 是 96 位十六进制串；这里用明显假的等长串。
const EMOJI_A = 'a1'.repeat(48)
const EMOJI_B = 'b2'.repeat(48)

function baseBridge(patch = {}) {
  return {
    总开关: true,
    试运行: false,
    转私聊: true,
    私聊QQ: '10001',
    转群: true,
    群号: '20002',
    NapCat: 'http://127.0.0.1:3000',
    ...patch,
  }
}

/** 一个假 qq 通道：真 createQQ + 假 fetch（本机 3000 可能真挂着协议端，测试绝不碰它）。 */
function makeQQ(t, { bridge, chatConfig, configPatch, handler, journal } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'qce-sticker-sync-'))
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify(baseBridge(bridge), null, 2), 'utf8')
  const store = createConfigStore({ home })
  if (configPatch) store.saveConfig(configPatch)
  const qq = createQQ({
    home,
    config: () => store.getConfig(),
    logger: { info() {} },
    platforms: { platform: () => chatConfig || { dailyMessages: 0, minSendIntervalSec: 0, maxCharsPerMessage: 0 } },
    journal: journal || { append() {}, countToday: () => 0 },
  })
  return qq
}

/** 替换 globalThis.fetch：按 action 回话，记录每次调用的 action 与 body。 */
function mockProtocol(t, handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop()
    const body = JSON.parse(init.body || '{}')
    calls.push({ action, body })
    const reply = handler
      ? handler(action, body, calls.length)
      : { status: 'ok', retcode: 0, data: { message_id: 42 } }
    return new Response(JSON.stringify(reply), { status: 200 })
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

test('没同步（无 emojiId）的表情照旧走 image + sub_type，现状不变', async (t) => {
  const qq = makeQQ(t)
  const calls = mockProtocol(t)
  const receipt = await qq.sendSticker('group:20002', { url: 'http://example.com/s.png', emojiId: '' })
  assert.equal(receipt.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'send_group_msg')
  const image = calls[0].body.message.find((seg) => seg.type === 'image')
  assert.equal(image.data.sub_type, 1, '老路径仍然按表情渲染')
})

test('同步过（有 emojiId）走 send_custom_face：group → group_id，且不带 user_id', async (t) => {
  const qq = makeQQ(t)
  const calls = mockProtocol(t)
  const receipt = await qq.sendSticker('group:20002', { url: 'http://example.com/s.png', emojiId: EMOJI_A })
  assert.equal(receipt.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'send_custom_face')
  // {emoji_id, group_id} 与 {emoji_id, user_id} 二选一：都传协议端会报错。
  assert.deepEqual(calls[0].body, { emoji_id: EMOJI_A, group_id: 20002 })
  assert.equal('user_id' in calls[0].body, false)
})

test('private: 目标发收藏表情用 user_id，且不带 group_id', async (t) => {
  const qq = makeQQ(t)
  const calls = mockProtocol(t)
  await qq.sendSticker('private:10001', { emojiId: EMOJI_A })
  assert.equal(calls[0].action, 'send_custom_face')
  assert.deepEqual(calls[0].body, { emoji_id: EMOJI_A, user_id: 10001 })
  assert.equal('group_id' in calls[0].body, false)
})

test('send 直接收 custom_face 段：表情先发、文字随后，各走各的 dispatch', async (t) => {
  const qq = makeQQ(t)
  const calls = mockProtocol(t)
  const receipt = await qq.send('group:20002', [
    { type: 'custom_face', data: { emojiId: EMOJI_A } },
    { type: 'text', text: '看这个' },
  ])
  assert.equal(receipt.ok, true, JSON.stringify(receipt.failed))
  assert.equal(calls.length, 2)
  assert.equal(calls[0].action, 'send_custom_face')
  assert.equal(calls[0].body.emoji_id, EMOJI_A)
  assert.equal(calls[1].action, 'send_group_msg')
  assert.deepEqual(calls[1].body.message, [{ type: 'text', data: { text: '看这个' } }])
})

test('emoji_id 不在收藏里：失败如实报（不假成功），协议端原话带回来', async (t) => {
  const qq = makeQQ(t)
  mockProtocol(t, () => ({ status: 'failed', retcode: 100, message: 'custom face is not in the saved sticker list' }))
  const receipt = await qq.sendSticker('group:20002', { emojiId: EMOJI_A })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.sent.length, 1)
  assert.equal(receipt.sent[0].ok, false)
  assert.equal(receipt.sent[0].action, 'send_custom_face')
  assert.match(receipt.sent[0].error, /not in the saved sticker list/)
})

test('闸门复用：总开关关着时收藏表情也拒发，一条都不发出去', async (t) => {
  const qq = makeQQ(t, { bridge: { 总开关: false } })
  const calls = mockProtocol(t)
  const receipt = await qq.sendSticker('group:20002', { emojiId: EMOJI_A })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.reason, 'bridge-switch-off')
  assert.equal(calls.length, 0)
})

test('额度复用：今天到量后收藏表情同样被拒，且不产生 send_custom_face 调用', async (t) => {
  const counter = { count: 0, append() {}, countToday() { return this.count } }
  const qq = makeQQ(t, {
    chatConfig: { dailyMessages: 1, minSendIntervalSec: 0, maxCharsPerMessage: 0 },
    journal: counter,
  })
  const calls = mockProtocol(t)
  const first = await qq.send('group:20002', [{ type: 'text', text: '先说一句' }])
  assert.equal(first.ok, true)
  counter.count = 1 // 模拟额度已满
  const capped = await qq.sendSticker('group:20002', { emojiId: EMOJI_A })
  assert.equal(capped.ok, false)
  assert.match(capped.reason, /daily-limit/)
  assert.equal(calls.filter((item) => item.action === 'send_custom_face').length, 0, '被额度挡下的不该打到协议端')
})

test('台账：发收藏表情记一行「[收藏表情]」，不记成空话', async (t) => {
  const booked = []
  const qq = makeQQ(t, { journal: { append: (row) => booked.push(row), countToday: () => 0 } })
  mockProtocol(t)
  await qq.sendSticker('group:20002', { emojiId: EMOJI_A })
  assert.equal(booked.length, 1)
  assert.match(booked[0].text, /发到 group:20002：\[收藏表情\]/)
})

test('useCustomFace 关掉后，同步过的表情也退回图片路径', async (t) => {
  const qq = makeQQ(t, { configPatch: { stickers: { useCustomFace: false } } })
  const calls = mockProtocol(t)
  await qq.sendSticker('group:20002', { url: 'http://example.com/s.png', emojiId: EMOJI_A })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'send_group_msg')
  const image = calls[0].body.message.find((seg) => seg.type === 'image')
  assert.equal(image.data.sub_type, 1)
})

function tempPng() {
  const dir = mkdtempSync(join(tmpdir(), 'qce-sync-file-'))
  const file = join(dir, '表情.png')
  writeFileSync(file, PNG_BYTES)
  return file
}

test('add 返回体带 emoji_id：直接用（via=response），只在 add 前 fetch 一次', async (t) => {
  const qq = makeQQ(t)
  const calls = mockProtocol(t, (action) => {
    if (action === 'fetch_custom_face') return { status: 'ok', retcode: 0, data: [EMOJI_A] }
    if (action === 'add_custom_face') return { status: 'ok', retcode: 0, data: { emoji_id: EMOJI_B } }
    return { status: 'ok', retcode: 0, data: null }
  })
  const result = await qq.addCustomFace(tempPng(), { trusted: true })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.emojiId, EMOJI_B)
  assert.equal(result.via, 'response')
  assert.equal(calls.filter((item) => item.action === 'fetch_custom_face').length, 1, '拿到了就不用再 fetch 兜底')
})

test('add 返回体没有 emoji_id：用前后 fetch 集合差兜底（via=setdiff）', async (t) => {
  const qq = makeQQ(t)
  const favorites = [EMOJI_A]
  const calls = mockProtocol(t, (action) => {
    if (action === 'fetch_custom_face') return { status: 'ok', retcode: 0, data: favorites.slice() }
    if (action === 'add_custom_face') {
      favorites.push(EMOJI_B) // 协议端真加进去了，但返回体里没有 id 字段
      return { status: 'ok', retcode: 0, data: {} }
    }
    return { status: 'ok', retcode: 0, data: null }
  })
  const result = await qq.addCustomFace(tempPng(), { trusted: true })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.via, 'setdiff')
  assert.equal(result.emojiId, EMOJI_B)
  assert.equal(calls.filter((item) => item.action === 'fetch_custom_face').length, 2, 'add 前后各一次')
})

test('addCustomFace 的路径边界：非 trusted 要过鱼箱；文件不存在如实报', async (t) => {
  const qq = makeQQ(t)
  const outside = await qq.addCustomFace('somewhere/x.png')
  assert.equal(outside.ok, false)
  assert.match(outside.error, /鱼箱/)
  const missing = join(mkdtempSync(join(tmpdir(), 'qce-sync-missing-')), '没有这张.png')
  const gone = await qq.addCustomFace(missing, { trusted: true })
  assert.equal(gone.ok, false)
  assert.match(gone.error, /不存在/)
})

function makeStickers(t) {
  const home = mkdtempSync(join(tmpdir(), 'qce-sync-stickers-'))
  const stickers = createStickers({
    home,
    config: () => ({ stickers: { enabled: true, hourlyLimit: 5 } }),
    logger: { info() {}, warn() {} },
  })
  return { home, stickers }
}

test('syncFavorites：逐张同步、emojiId 落盘；重复跑幂等，已同步的不再 add', async () => {
  const { home, stickers } = makeStickers()
  const a = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { name: '甲' })
  const b = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { name: '乙' })
  const addedFiles = []
  const qq = {
    addCustomFace: async (file) => {
      addedFiles.push(file)
      return { ok: true, emojiId: 'fake_' + addedFiles.length, via: 'response' }
    },
  }

  const first = await stickers.syncFavorites(qq, {})
  assert.equal(first.ok, true, JSON.stringify(first.errors))
  assert.equal(first.added, 2)
  assert.equal(first.failed, 0)
  assert.equal(addedFiles.length, 2)
  // 索引按加入时间倒序，先同步的是后收藏的乙。
  assert.equal(stickers.get(b.id).emojiId, 'fake_1')
  assert.equal(stickers.get(a.id).emojiId, 'fake_2')
  assert.ok(stickers.get(a.id).syncedAt, '同步时间要落盘')

  // emojiId 写进了 stickers.json：换个实例（模拟重启）还在。
  const reopened = createStickers({ home, config: () => ({ stickers: { enabled: true, hourlyLimit: 5 } }), logger: {} })
  assert.equal(reopened.get(a.id).emojiId, 'fake_2')

  // 幂等：再跑一遍，一张都不该重复 add。
  const second = await stickers.syncFavorites(qq, {})
  assert.equal(second.ok, true)
  assert.equal(second.added, 0)
  assert.equal(addedFiles.length, 2, '已同步的不重复 add')

  // 汇总里看得到同步状态（面板「已同步 N 张」的数据源）。
  assert.equal(stickers.summary().synced, 2)
  assert.equal(stickers.summary().useCustomFace, true)
})

test('syncFavorites：limit 生效、单张失败如实带回且不中断后面的', async () => {
  const { stickers } = makeStickers()
  const a = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { name: '甲' })
  const b = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { name: '乙' })
  let calls = 0
  const failing = {
    // 按文件认人：乙那张一直失败，甲那张一直成功——失败不该中断后面的。
    addCustomFace: async (file) => {
      calls += 1
      if (file === stickers.fileFor(b)) return { ok: false, error: '协议端拒了这张（假错误）' }
      return { ok: true, emojiId: EMOJI_A, via: 'setdiff' }
    },
  }

  // limit: 1 → 这次只处理一张（最新那张恰好是会失败的乙）
  const capped = await stickers.syncFavorites(failing, { limit: 1 })
  assert.equal(capped.added + capped.failed, 1)
  assert.equal(calls, 1, 'limit 只许处理一张')

  // 剩下的继续跑：乙仍然失败并如实进 errors，甲照常成功。
  const rest = await stickers.syncFavorites(failing, {})
  assert.equal(rest.ok, false)
  assert.equal(rest.added, 1)
  assert.equal(rest.failed, 1)
  assert.equal(rest.errors.length, 1)
  assert.equal(rest.errors[0].id, b.id)
  assert.equal(rest.errors[0].error, '协议端拒了这张（假错误）')
  assert.equal(stickers.get(b.id).emojiId, undefined, '失败的那张不该被写上 emojiId（不假成功）')
  assert.equal(stickers.get(a.id).emojiId, EMOJI_A)
  assert.equal(stickers.summary().synced, 1)
})

test('syncFavorites：没接 QQ 服务时如实报错；send 把 emojiId 交给 sendSticker', async () => {
  const { stickers } = makeStickers()
  const item = await stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { name: '甲' })

  const none = await stickers.syncFavorites(undefined, {})
  assert.equal(none.ok, false)
  assert.match(none.errors[0].error, /未接入/)

  const seen = []
  const qq = {
    addCustomFace: async () => ({ ok: true, emojiId: EMOJI_A, via: 'response' }),
    sendSticker: async (chatKey, sticker) => { seen.push({ chatKey, sticker }); return { ok: true } },
  }
  await stickers.syncFavorites(qq, {})
  const receipt = await stickers.send(qq, 'group:20002', item.id)
  assert.equal(receipt.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].chatKey, 'group:20002')
  assert.equal(seen[0].sticker.emojiId, EMOJI_A, '同步过的表情要把 emojiId 交出去，sendSticker 才能走收藏表情')
  assert.ok(seen[0].sticker.localPath, '本地路径仍然带着：关掉 useCustomFace 时还要能回退')
  assert.equal(stickers.get(item.id).useCount, 1, '发成功照样记使用次数')
})
