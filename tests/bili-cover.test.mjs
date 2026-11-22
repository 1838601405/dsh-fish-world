// B 站封面 → 视觉管线的判据（2026-11-22 主人方案 P4）。
//
// ★ 判据核心：方案 P4 原话「B站封面和 QQ 里同一张图命中同一缓存」——
//   所以下面有一条**跨入口**的：同一份封面字节，从 B站入口和 QQ 入口各来一次，
//   只调一次模型。这才是「缓存跨平台共享」的实证，不是各算各的。
//
// 全程假 fetch（不打真网络）+ 假管线，符合 AGENTS 6.3「测试不许依赖本机状态」。
// 真机记录（真调 B 站、真下载、真描述）单独跑，见收口单。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertBv, createBiliCover, findBv } from '../lib/bili-cover.mjs'
import { createVisionInput } from '../lib/vision-input.mjs'
import { registerMainPlatforms } from '../lib/vision-platforms.mjs'

const BV = 'BV139HA6JEE6'          // 真实形态（10 位）
const COVER_URL = 'https://例子.test/cover.jpg'
const COVER_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),   // JPEG 头
  Buffer.from('封面内容-同一份字节'),
])

function mkDir() { return mkdtempSync(join(tmpdir(), 'bili-')) }

/** 造一个能答 B 站 API 的假 fetch。 */
function fakeBili({ code = 0, pic = COVER_URL, coverBytes = COVER_BYTES, httpOk = true } = {}) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push(String(url))
    const isApi = String(url).includes('/x/web-interface/view')
    if (isApi) {
      return {
        ok: true, status: 200,
        json: async () => (code === 0
          ? { code: 0, data: { title: '测试视频', pic, duration: 197, owner: { name: '某UP' } } }
          : { code, message: '啥都木有' })
      }
    }
    // 封面下载
    if (!httpOk) return { ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) }
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : '') },
      arrayBuffer: async () => coverBytes.buffer.slice(coverBytes.byteOffset, coverBytes.byteOffset + coverBytes.byteLength)
    }
  }
  return { impl, calls }
}

/** 计数的假管线：按内容算 key，命中就不调。
 *  ★ 必须同时给 describe 与 describeImage —— vision-input 的 ingest 调的是 describe，
 *    只给 describeImage 会让它抛 TypeError，测出来是一堆「result 为 undefined」。 */
function mkVision() {
  const seen = new Set()
  const calls = { describeImage: 0 }
  async function look(file, { focus = '' } = {}) {
    const key = createHash('sha256').update(readFileSync(file)).digest('hex') + '|' + focus
    if (seen.has(key)) return { id: key.slice(0, 16), kind: 'image', text: '同一句', tags: [], cached: true, model: 'fake', at: 1 }
    calls.describeImage += 1
    seen.add(key)
    return { id: key.slice(0, 16), kind: 'image', text: '封面描述-' + calls.describeImage, tags: [], cached: false, model: 'fake', at: 1 }
  }
  return { calls, describe: look, describeImage: look }
}

// ══════════ BV 号识别 ══════════

test('★★ findBv：从正文里抠出合法 BV，带尾巴的也能抠', () => {
  assert.equal(findBv('看这个 https://www.bilibili.com/video/BV139HA6JEE6?p=1'), 'BV139HA6JEE6')
  assert.equal(findBv('BV139HA6JEE6'), 'BV139HA6JEE6')
  assert.equal(findBv('BV139HA6JEE6/?spm_id_from=333'), 'BV139HA6JEE6')
  assert.equal(findBv('没有链接'), '')
  assert.equal(findBv(''), '')
  assert.equal(findBv(null), '')
})

test('★★ 形态不对的不当 BV（av号 / 少一位 / 多一位）', () => {
  assert.equal(findBv('av170001'), '', 'av 号先不接（要换算，另一件事）')
  assert.equal(findBv('BV139HA6JEE'), '', '少一位')
  assert.equal(findBv('BV139HA6JEE66'), '', '多一位——但注意它内含合法前缀，按边界应拒')
  assert.throws(() => assertBv('av170001'), /不是合法的 BV 号/)
  assert.throws(() => assertBv(''), /不是合法的 BV 号/)
  assert.equal(assertBv(' BV139HA6JEE6 '), 'BV139HA6JEE6', '前后空白要吃掉')
})

// ══════════ 拿元信息 ══════════

test('★★ 不带 cookie 也能拿到封面地址（公开视频）', async () => {
  const dir = mkDir()
  const { impl, calls } = fakeBili()
  const bili = createBiliCover({ fetchImpl: impl, inputDir: dir })

  const m = await bili.meta(BV)
  assert.equal(m.bv, BV)
  assert.equal(m.cover, COVER_URL)
  assert.equal(m.title, '测试视频')
  assert.equal(m.duration, 197)
  assert.equal(m.owner, '某UP')
  // 只发了一个请求（API），没读任何 credentials
  assert.equal(calls.length, 1)
  assert.match(calls[0], /x\/web-interface\/view\?bvid=BV139HA6JEE6/)
})

test('★★ B 站的失败是 HTTP 200 + code!=0 —— 不能只看 status', async () => {
  const dir = mkDir()
  const { impl } = fakeBili({ code: -404 })
  const bili = createBiliCover({ fetchImpl: impl, inputDir: dir })
  await assert.rejects(() => bili.meta(BV), (e) => {
    assert.match(e.message, /B 站说读不到这个视频/)
    assert.match(e.message, /code=-404/)
    assert.match(e.message, /BV=BV139HA6JEE6/, '★ 要带上是哪个 BV')
    return true
  })
})

test('★ 没给封面地址 → 明确报错，不猜一个', async () => {
  const dir = mkDir()
  const { impl } = fakeBili({ pic: '' })
  const bili = createBiliCover({ fetchImpl: impl, inputDir: dir })
  await assert.rejects(() => bili.meta(BV), /没给封面地址/)
})

test('★ 下载失败 / 空内容 → 各自带原因', async () => {
  const dir = mkDir()
  const down = createBiliCover({ fetchImpl: fakeBili({ httpOk: false }).impl, inputDir: dir })
  await assert.rejects(() => down.cover(BV), /下载封面失败（HTTP 404）/)

  const empty = createBiliCover({
    fetchImpl: fakeBili({ coverBytes: Buffer.alloc(0) }).impl,
    inputDir: dir
  })
  await assert.rejects(() => empty.cover(BV), /下载回来的封面是空的/)
})

test('★ 没给 inputDir → 建的时候就报（归一化层不猜路径）', () => {
  assert.throws(() => createBiliCover({}), /inputDir/)
})

// ══════════ 下载 → 归一化 ══════════

test('★★ 封面下载后归一化：JPEG 头保住、落盘、sha256 对', async () => {
  const dir = mkDir()
  const bili = createBiliCover({ fetchImpl: fakeBili().impl, inputDir: dir })

  const got = await bili.cover(BV)

  assert.equal(got.kind, 'image')
  assert.equal(got.path.endsWith('.jpg'), true, '★ 落盘名要带 .jpg（判类型靠它）')
  const onDisk = readFileSync(got.path)
  assert.equal(onDisk[0], 0xff, '★ JPEG 头不能被打烂（response.text() 会打烂，所以必须 arrayBuffer）')
  assert.equal(onDisk[1], 0xd8)
  assert.equal(got.sha256, createHash('sha256').update(COVER_BYTES).digest('hex'))
  assert.equal(got.meta.bv, BV, '★ 元信息要跟着带出来')
})

// ══════════ ★★ 方案 P4 判据：跨入口只算一次 ══════════

test('★★ 同一张封面字节：B站入口与 QQ 入口 → 同一个 sha256、只调一次模型', async () => {
  const dir = mkDir()
  const vision = mkVision()
  // ★ 两个入口必须用同一个 focus —— 方案 §三「各平台共用同一预算与格式」。
  //   focus 进缓存键，各平台口径不一致就各算各的，缓存共享直接落空。
  const FOCUS = '封面主体'

  // B站入口
  const bili = createBiliCover({ fetchImpl: fakeBili().impl, inputDir: join(dir, 'in') })
  const fromBili = await bili.describe(BV, { vision, focus: FOCUS })

  // QQ 入口：同一份字节（模拟群里直接发了同一张封面图）
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })
  registerMainPlatforms(input)
  const qqFile = join(dir, 'qq.png')
  writeFileSync(qqFile, COVER_BYTES)
  const fromQq = await input.ingest('desktop', qqFile, { focus: FOCUS })

  assert.equal(fromBili.sha256, fromQq.results[0].sha256, '★ 同一份字节必须同一个 sha256')
  assert.equal(vision.calls.describeImage, 1, '★ 两个入口只调一次模型（方案 P4 判据）')
  assert.equal(fromQq.results[0].result.cached, true, '★ 第二个入口要命中缓存')
  assert.match(fromBili.text, /封面描述-1/)
})

test('★★ 不同 focus 不互相顶掉（B站封面问主体、QQ问有没有文字 = 两次）', async () => {
  const dir = mkDir()
  const vision = mkVision()
  const bili = createBiliCover({ fetchImpl: fakeBili().impl, inputDir: dir })

  await bili.describe(BV, { vision, focus: '封面主体' })
  await bili.describe(BV, { vision, focus: '画面里有没有文字' })
  assert.equal(vision.calls.describeImage, 2, '★ 不同问题分别算')

  await bili.describe(BV, { vision, focus: '封面主体' })
  assert.equal(vision.calls.describeImage, 2, '★ 同问题第二次吃缓存')
})

test('★★ 没给 vision → 明确报错，不自己乱调', async () => {
  const dir = mkDir()
  const bili = createBiliCover({ fetchImpl: fakeBili().impl, inputDir: dir })
  await assert.rejects(() => bili.describe(BV, {}), /要给视觉管线实例/)
})

test('★ onCover 回调抛错 → 不影响「封面拿到了」，只记一笔', async () => {
  const dir = mkDir()
  const warns = []
  const bili = createBiliCover({
    fetchImpl: fakeBili().impl,
    inputDir: dir,
    logger: { warn: (m) => warns.push(m) },
    onCover: async () => { throw new Error('回调炸了') }
  })
  const got = await bili.cover(BV)
  assert.ok(got.path, '★ 封面照样拿到')
  assert.equal(warns.length, 1)
  assert.match(warns[0], /回调失败/)
})

// ══════════ 仓库红线 ══════════

/** 剥掉注释再扫 —— 否则「注释里解释为什么不读凭据」会被自己的断言命中（M59）。 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1')    // 行注释（避开 https:// 这种）
}

test('★ 源码里不许出现本机绝对路径（AGENTS 0⑤）', async () => {
  const src = readFileSync(new URL('../lib/bili-cover.mjs', import.meta.url), 'utf8')
  const bad = codeOnly(src).match(/C:\\\\Users\\\\[A-Za-z0-9]+|\/home\/[A-Za-z]+|D:\\\\[A-Za-z]/g)
  assert.equal(bad, null, '★ 不许写死本机路径：' + JSON.stringify(bad))
})

test('★ 不读任何 B 站凭据文件（公开接口就够，别背 cookie 依赖）', async () => {
  const src = codeOnly(readFileSync(new URL('../lib/bili-cover.mjs', import.meta.url), 'utf8'))
  // 只扫代码：注释里提到「为什么不读凭据」是应该的，不该被自己判红。
  assert.doesNotMatch(src, /credentials|SESSDATA|bili_jct|buvid3/, '★ 不许读凭据文件')
  assert.doesNotMatch(src, /cookie\s*:/i, '★ 不许设 cookie 头')
  assert.doesNotMatch(src, /readFileSync\([^)]*凭据|credentials\.json/, '★ 不许读凭据文件')
})
