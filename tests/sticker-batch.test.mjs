// 图片收藏的批量操作（打标签 / 整理 / 删除）与「索引 file 偏移」自愈。
//
// 全部用临时目录 + 假 storage / 假 vision：不碰真实图库、不碰真视觉接口。
// 覆盖：
//   · 批量加标签：合并去重、保留原有标签、未知 id 进 failed、重复 id 只算一次
//   · 批量整理：复用 organizeOne、部分失败不中断、未接入时如实报
//   · 批量删除：逐张删、失败可见、磁盘文件真的删掉
//   · ids 校验：不是数组 / 空数组 / 超过上限
//   · 路由：loopback-only、只接受 POST、三个动作各写一行审计
//   · 自愈：索引 file 偏移时按 name 兜底读得到，落盘改回真名，再跑一次不变
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildRoutes } from '../lib/http.mjs'
import { createStickers } from '../lib/stickers.mjs'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])

/** 一份「假图库」：临时目录里一个 gallery，storage 只负责报目录与接审计。 */
function makeGallery() {
  const root = mkdtempSync(join(tmpdir(), 'fw-sticker-batch-'))
  const gallery = join(root, 'gallery')
  mkdirSync(gallery, { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  return { root, home: join(root, 'home'), gallery }
}

/**
 * 建一个图库实例。
 * vision 不传 = 视觉整理未接入；传了就只用于 batchOrganize / organizeOne。
 * ready() 一律回 false，避免「入库即整理」在 add 之后异步改数据、把断言搅乱。
 */
function makeStickers({ home, gallery, vision } = {}) {
  const audits = []
  const storage = {
    layout: () => ({ gallery }),
    appendSecurity: (entry) => { audits.push(entry) },
  }
  const stickers = createStickers({
    home,
    config: () => ({ stickers: { enabled: true, hourlyLimit: 100 } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    storage,
    vision,
  })
  return { stickers, audits }
}

function fakeVision(over = {}) {
  return {
    ready: () => ({ ok: false, reason: '测试里不自动整理' }),
    describe: async () => ({ ok: true, name: '模型给的名字', tags: ['补充'], note: '模型给的说明' }),
    ...over,
  }
}

async function addItem(stickers, name, tags = []) {
  return stickers.add({ base64: PNG_BYTES.toString('base64'), hint: 'png' }, { name, tags })
}

// ---------- 批量加标签 ----------

test('批量追加标签：并集去重、原有标签保留、未知 id 进 failed', async () => {
  const { home, gallery } = makeGallery()
  const { stickers } = makeStickers({ home, gallery })
  const a = await addItem(stickers, '歪头', ['已有', '可爱'])
  const b = await addItem(stickers, '贴贴', ['乖'])

  // a.id 传两次：去重后只算一张。
  const result = stickers.batchUpdateTags([a.id, b.id, a.id, 'stk_不存在'], ['新标签', '可爱', ' '])
  assert.equal(result.updated, 2)
  assert.equal(result.ok, false, '有失败就不算全成功')
  assert.deepEqual(result.failed.map((row) => row.id), ['stk_不存在'])
  assert.match(result.failed[0].error, /没有找到/)

  // 原有标签在前、新标签在后，重复的「可爱」只留一份。
  assert.deepEqual(stickers.get(a.id).tags, ['已有', '可爱', '新标签'])
  assert.deepEqual(stickers.get(b.id).tags, ['乖', '新标签', '可爱'])

  // 标签为空：直接拒绝，不写盘。
  assert.throws(() => stickers.batchUpdateTags([a.id], []), /标签不能为空/)
  assert.deepEqual(stickers.get(a.id).tags, ['已有', '可爱', '新标签'])
})

test('ids 校验：不是数组 / 空数组 / 超过 200 张都直接拒绝', async () => {
  const { home, gallery } = makeGallery()
  const { stickers } = makeStickers({ home, gallery })
  const one = await addItem(stickers, '只有一张')

  assert.throws(() => stickers.batchUpdateTags('stk_x', ['t']), /ids 需要是数组/)
  assert.throws(() => stickers.batchUpdateTags([], ['t']), /没有选中任何图片/)
  assert.throws(() => stickers.batchRemove([null, '  ']), /没有选中任何图片/)
  const tooMany = Array.from({ length: 201 }, (_, i) => `stk_many_${i}`)
  assert.throws(() => stickers.batchRemove(tooMany), /一次最多处理 200 张/)
  assert.equal(stickers.get(one.id).name, '只有一张', '被拒绝的调用不能动数据')
})

// ---------- 批量整理 ----------

test('批量整理：逐张走组织流程、部分失败不中断、结果按入参顺序', async () => {
  const { home, gallery } = makeGallery()
  const { stickers } = makeStickers({ home, gallery, vision: fakeVision() })
  const a = await addItem(stickers, '第一张')
  const b = await addItem(stickers, '第二张')
  const c = await addItem(stickers, '第三张')
  // 把第三张的文件从磁盘拿掉：模拟「图不在了」，它必须进 failed，且不影响前两张。
  rmSync(stickers.fileFor(stickers.get(c.id)), { force: true })

  const result = await stickers.batchOrganize([a.id, b.id, c.id], { concurrency: 2 })
  assert.equal(result.total, 3)
  assert.equal(result.done, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.ok, false)
  assert.deepEqual(result.results.map((row) => row.id), [a.id, b.id, c.id], '并发跑完也要按入参顺序摆结果')

  const failedRow = result.results.find((row) => row.id === c.id)
  assert.equal(failedRow.ok, false)
  assert.match(failedRow.error, /不在了/)

  // 复用 organizeOne 的证据：成功的那两张真的被写了标签与已整理标记；
  // 手填过的名字保持不动（applyOrganization 只补空缺，不跟主人抢名字）。
  assert.ok(stickers.get(a.id).tags.includes('补充'))
  assert.equal(stickers.get(a.id).organized, true)
  assert.equal(stickers.get(a.id).name, '第一张')
  assert.equal(stickers.get(b.id).organized, true)
  assert.equal(stickers.get(c.id).organized, undefined, '失败的不能被打上已整理')
})

test('批量整理：视觉整理没接入时如实报，不假装整理了 0 张', async () => {
  const { home, gallery } = makeGallery()
  const { stickers } = makeStickers({ home, gallery })
  const a = await addItem(stickers, 'A')
  const b = await addItem(stickers, 'B')

  const result = await stickers.batchOrganize([a.id, b.id])
  assert.equal(result.ok, false)
  assert.match(result.error, /未接入/)
  assert.equal(result.total, 2)
  assert.equal(result.done, 0)
  assert.equal(result.failed, 2, 'done + failed 必须等于 total')
  assert.ok(result.results.every((row) => row.ok === false && /未接入/.test(row.error)))
  assert.equal(stickers.get(a.id).organized, undefined, '没接入时一个字都不该改')
})

// ---------- 批量删除 ----------

test('批量删除：逐张删、磁盘文件一并删掉、未知 id 进 failed', async () => {
  const { home, gallery } = makeGallery()
  const { stickers } = makeStickers({ home, gallery })
  const a = await addItem(stickers, '要删的')
  const b = await addItem(stickers, '留着的')
  const fileA = stickers.fileFor(stickers.get(a.id))
  assert.ok(existsSync(fileA))

  const result = stickers.batchRemove([a.id, 'stk_已经没了'])
  assert.equal(result.removed, 1)
  assert.equal(result.ok, false)
  assert.deepEqual(result.failed.map((row) => row.id), ['stk_已经没了'])
  assert.equal(stickers.get(a.id), null)
  assert.equal(existsSync(fileA), false, '磁盘文件要真的删掉')
  assert.ok(stickers.get(b.id), '没选中的不能被牵连')
})

// ---------- 路由 + 审计 ----------

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(value) { this.body = String(value || '') },
    json() { return JSON.parse(this.body) },
  }
}

function request({ method = 'POST', url = '/dsh-fish-world/stickers/batch', remoteAddress = '127.0.0.1', body = null } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(JSON.stringify(body)) },
  }
}

function makeRoutes({ stickers, world }) {
  const routes = buildRoutes({
    loader: { status: async () => ({}), list: () => [] },
    market: { links: async () => ({ ok: true, links: [] }), install: async () => ({ ok: true }) },
    qq: {},
    roles: { current: () => ({ id: 'default', name: '鱼' }), list: () => [], summary: () => ({}) },
    world,
    configStore: {},
    stickers,
  })
  const route = routes.find((item) => item.path === '/dsh-fish-world/stickers/batch')
  assert.ok(route, '批量路由必须注册进 buildRoutes 的返回数组')
  return route
}

test('批量路由：loopback-only、只接受 POST、三个动作各写一行审计', async () => {
  const { home, gallery } = makeGallery()
  const { stickers } = makeStickers({ home, gallery, vision: fakeVision() })
  const a = await addItem(stickers, '甲')
  const b = await addItem(stickers, '乙')
  const audits = []
  const world = { appendSecurity: (entry) => { audits.push(entry) } }
  const route = makeRoutes({ stickers, world })

  // 非本机调用：403，且一条审计都不该写。
  const blocked = response()
  await route.handler(request({ remoteAddress: '192.0.2.4', body: { action: 'tags', ids: [a.id], tags: ['x'] } }), blocked)
  assert.equal(blocked.statusCode, 403)
  assert.equal(audits.length, 0)

  const notPost = response()
  await route.handler(request({ method: 'GET' }), notPost)
  assert.equal(notPost.statusCode, 405)

  const unknown = response()
  await route.handler(request({ body: { action: 'rename', ids: [a.id] } }), unknown)
  assert.equal(unknown.statusCode, 400)
  assert.match(unknown.json().error, /action 只能是/)

  const tagged = response()
  await route.handler(request({ body: { action: 'tags', ids: [a.id, b.id], tags: ['批量'] } }), tagged)
  assert.equal(tagged.statusCode, 200)
  assert.equal(tagged.json().updated, 2)
  assert.deepEqual(audits.map((row) => row.action), ['sticker-batch-tags'])
  assert.equal(audits[0].recordId, '2 张', '审计只记数量，不抄标签正文')
  assert.equal(audits[0].role, 'owner')

  const organized = response()
  await route.handler(request({ body: { action: 'organize', ids: [a.id, b.id] } }), organized)
  assert.equal(organized.statusCode, 200)
  assert.equal(organized.json().done, 2)
  assert.deepEqual(audits.map((row) => row.action), ['sticker-batch-tags', 'sticker-batch-organize'])
  assert.match(audits[1].recordId, /成功 2\/2 张/)

  const removed = response()
  await route.handler(request({ body: { action: 'remove', ids: [a.id] } }), removed)
  assert.equal(removed.statusCode, 200)
  assert.equal(removed.json().removed, 1)
  assert.deepEqual(audits.map((row) => row.action), ['sticker-batch-tags', 'sticker-batch-organize', 'sticker-batch-remove'])
  assert.equal(audits[2].recordId, '1 张')

  // 一张都没成功就不写审计：不能在时间线上留下「其实没做成」的一行。
  const nothing = response()
  await route.handler(request({ body: { action: 'remove', ids: ['stk_不存在'] } }), nothing)
  assert.equal(nothing.statusCode, 400)
  assert.equal(audits.length, 3)
})

// ---------- 索引 file 偏移的自愈 ----------

/** 把索引里某一条的 file 改成一个「差一个序号」的旧名字，磁盘上的文件仍叫 name。 */
function shiftFileIndex({ gallery, id, staleFile }) {
  const indexPath = join(gallery, 'stickers.json')
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  const record = index.stickers.find((row) => row.id === id)
  assert.ok(record, '索引里要有这一条')
  record.file = staleFile
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
}

test('缩略图自愈：索引 file 偏移时按 name 兜底读到，并把 file 改回磁盘真名（幂等）', async () => {
  const { home, gallery } = makeGallery()
  const { stickers, audits } = makeStickers({ home, gallery })
  const item = await addItem(stickers, '蓝鲸娘·无辜特写', ['可爱'])
  // 名字落到磁盘（改名同时改文件）：磁盘名 = name，和线上那种形状一致。
  stickers.updateName(item.id, '蓝鲸娘·无辜特写')

  const before = readdirSync(gallery).filter((name) => name.endsWith('.png'))
  assert.equal(before.length, 1)
  const diskFile = before[0]
  const diskBase = diskFile.replace(/\.png$/, '')
  // 索引里的 file 改成差一个序号的旧名（磁盘上并不存在这个名字）。
  shiftFileIndex({ gallery, id: item.id, staleFile: `${diskBase}-000` })

  // 读：file 拼出来的路径不存在，但按 name 兜底找得到（缩略图不再 404）。
  const got = stickers.imageBytes(item.id)
  assert.ok(got, '按 name 兜底必须能读到 bytes')
  assert.equal(got.bytes.length, PNG_BYTES.length)
  assert.equal(got.format, 'png')
  assert.equal(got.path, join(gallery, diskFile))

  // 自愈：索引里的 file 变成磁盘上的真名，其它字段不动。
  const healedIndex = JSON.parse(readFileSync(join(gallery, 'stickers.json'), 'utf8'))
  const healed = healedIndex.stickers.find((row) => row.id === item.id)
  assert.equal(healed.file, diskBase)
  assert.equal(healed.name, '蓝鲸娘·无辜特写', '不能顺手改名字')
  assert.deepEqual(healed.tags, ['可爱'])
  // 磁盘上不能多出文件（自愈只改索引，不复制、不改名）。
  assert.deepEqual(readdirSync(gallery).filter((name) => name.endsWith('.png')), before)

  // 幂等：再读、再读一次，索引不变，也不产生新的审计噪声。
  const again = stickers.imageBytes(item.id)
  assert.ok(again)
  const second = JSON.parse(readFileSync(join(gallery, 'stickers.json'), 'utf8')).stickers.find((row) => row.id === item.id)
  assert.equal(second.file, diskBase)
  assert.deepEqual(readdirSync(gallery).filter((name) => name.endsWith('.png')), before)
  assert.equal(audits.filter((row) => row.action === 'sticker-remove').length, 0, '自愈不该写出删除类审计')

  // 体检：一致了就不再报「对不上」，也不再多写盘。
  const judged = stickers.fileAudit({ repair: true })
  assert.equal(judged.total, 1)
  assert.equal(judged.missing, 0)
  assert.equal(judged.mismatched, 0)
  assert.equal(judged.healed, 0)
})

test('缩略图自愈：两边都没有就返回 null（不编路径），体检报 missing + 自愈条数', async () => {
  const { home, gallery } = makeGallery()
  const { stickers, audits } = makeStickers({ home, gallery })
  const healthy = await addItem(stickers, '好的一张')
  const broken = await addItem(stickers, '丢的一张')

  // 丢的那张：磁盘文件删掉，索引还在 → 应该报 missing，而不是「找到了一张」。
  rmSync(stickers.fileFor(stickers.get(broken.id)), { force: true })
  assert.equal(stickers.imageBytes(broken.id), null)
  assert.equal(stickers.fileForRead(stickers.get(broken.id)), '')

  // 另一张把索引 file 挪偏（磁盘名 = name）：体检要能数出「对不上」，
  // repair 时修正并只写**一条**审计。
  stickers.updateName(healthy.id, '好的一张')
  shiftFileIndex({ gallery, id: healthy.id, staleFile: '好的一张-009' })

  const judged = stickers.fileAudit({ repair: true })
  assert.equal(judged.total, 2)
  assert.equal(judged.missing, 1, '真丢的那张算 missing')
  assert.equal(judged.mismatched, 1)
  assert.equal(judged.healed, 1)
  const healLines = audits.filter((row) => row.action === 'sticker-file-heal')
  assert.equal(healLines.length, 1, '一次体检只写一行，不逐张刷时间线')
  assert.match(healLines[0].recordId, /索引矫正 1 张/)
  assert.ok(stickers.imageBytes(healthy.id), '修好之后读得到')

  // 再跑一次：什么都不用改，也不再写审计。
  const second = stickers.fileAudit({ repair: true })
  assert.equal(second.mismatched, 0)
  assert.equal(second.healed, 0)
  assert.equal(audits.filter((row) => row.action === 'sticker-file-heal').length, 1)
})
