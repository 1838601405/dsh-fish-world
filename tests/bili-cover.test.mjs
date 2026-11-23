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
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
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

// ══════════ ★★ 方案 §五：平台信息只由 source 带，不进描述正文 ══════════
//
// 方案原文：「平台信息只由 source 带，不进描述正文——同一张图在哪看都是同一句话」。
// B站入口天生最容易漏：它的 meta 里带着 BV、UP 主、标题这些平台信息，
// 一不小心就会被拼进描述（比如「B站视频《xxx》的封面」）。
// 上面三个平台入口验过这条，这里补 B站入口。

test('★★ B站入口：平台信息只进 meta，不进描述正文', async () => {
  const dir = mkDir()
  const bili = createBiliCover({ fetchImpl: fakeBili().impl, inputDir: dir })

  // 管线回一句**不含平台词**的描述（真实网关也是这么回的，见真机记录）
  // id 要给成真实的 16 位 hex —— renderForContext 取前 8 位，给 'x' 会量不出形状。
  const vision = {
    async describeImage() {
      return {
        id: '607b8180d9c7c0c0',
        kind: 'image',
        text: '两个Q版女孩，橙发少女与蓝发鲸鱼娘。',
        tags: [], cached: false, model: 'fake', at: 1,
      }
    },
  }
  const r = await bili.describe(BV, { vision, focus: '封面主体' })

  // ★ 描述正文一个平台词都不许有
  for (const word of ['B站', 'bilibili', 'BV', 'UP主', '视频', '封面']) {
    assert.equal(r.text.includes(word), false, `★ 描述正文不许出现平台词「${word}」：${r.text}`)
  }
  assert.equal(r.text, '两个Q版女孩，橙发少女与蓝发鲸鱼娘。')

  // ★ 平台信息该在的地方：meta（额外字段）与 source 之外不进正文
  assert.equal(r.meta.bv, BV, 'BV 在 meta 里，调用方要拿得到')
  assert.equal(r.meta.title, '测试视频')
  assert.equal(r.meta.owner, '某UP')

  // ★ renderForContext 渲染时也不该把 meta 带进去（上下文只放摘要+id）
  const { renderForContext } = await import('../lib/vision.mjs')
  const line = renderForContext(r)
  assert.match(line, /^\[图 [0-9a-f]{8}\] /, '★ 上下文行是统一形状')
  for (const word of ['B站', 'BV', '测试视频', '某UP']) {
    assert.equal(line.includes(word), false, `★ 上下文行不许带平台信息：${line}`)
  }
})

// ══════════ ★★ 方案 P4 后半句：抽帧（看视频本身，不是只看封面） ══════════
//
// 主人 2026-11-23：「不能只看封面不看视频吧」—— 方案 P4 原文是「B站封面/**抽帧**」，
// 封面只是海报。这里验：复用 dsh-bili-whale 已下载的片 → 走视觉管线 → 出时间序列。

test('★★ 找到已下载的视频：按 BV 前缀 + 选最新的那个', () => {
  const home = mkDir()
  const vd = join(home, 'shots', 'video')
  mkdirSync(vd, { recursive: true })
  // 三个都命中 BV 前缀：选 mtime 最新的
  const older = join(vd, BV + '-2026-11-22T03-08-43-195Z.mp4')
  const newer = join(vd, BV + '-newer.mp4')
  writeFileSync(older, Buffer.from('old'))
  writeFileSync(newer, Buffer.from('newer'))
  writeFileSync(join(vd, 'BV1OTHER12345-x.mp4'), Buffer.from('别的片'))
  // ★ 2026-11-23：显式把两个文件的 mtime 拉开 1 小时。
  //   原来两个文件在同一秒内写完，mtime 相同 → 排序次序取决于文件系统返回顺序，
  //   这条用例**间歇性红**（实测连跑 4 次挂 2 次）。它要验的是「取最新」，
  //   就该把「最新」定义成确定的事实，而不是碰运气。
  const hour = 60 * 60 * 1000
  const now = Date.now()
  utimesSync(older, new Date(now - hour), new Date(now - hour))
  utimesSync(newer, new Date(now), new Date(now))

  const bili = createBiliCover({ home, inputDir: join(home, 'in') })
  const hit = bili.findVideo(BV)
  assert.ok(hit, '应该找到')
  assert.equal(hit.name, BV + '-newer.mp4', '★ 同一个 BV 多个文件时选最新的')
  assert.ok(hit.path.includes(vd), '★ 落在看片目录下')
})

test('★★ 没下载过 → findVideo 返回 null（不猜、不下载）', () => {
  const home = mkDir()
  mkdirSync(join(home, 'shots', 'video'), { recursive: true })
  const bili = createBiliCover({ home, inputDir: join(home, 'in') })
  assert.equal(bili.findVideo(BV), null, '目录里没这个 BV 就是 null，不自己去下')
})

test('★ 目录不存在 / 没给 home → 如实说，不猜路径', () => {
  const home = mkDir()
  // 没有 shots/video 目录
  const bili = createBiliCover({ home, inputDir: join(home, 'in') })
  assert.equal(bili.findVideo(BV), null, '目录不在 = 一条都没下载过，返回 null')

  // 既没 home 也没 videoDir
  const noHome = createBiliCover({ inputDir: join(home, 'in') })
  assert.throws(() => noHome.findVideo(BV), /home|videoDir/, '★ 不给看片目录要报错，不能猜')
})

test('★★ describeVideo：没给 vision 明说、片没下载明说（不静默）', async () => {
  const home = mkDir()
  mkdirSync(join(home, 'shots', 'video'), { recursive: true })
  const bili = createBiliCover({ home, inputDir: join(home, 'in') })

  // ① 没给 vision
  await assert.rejects(() => bili.describeVideo(BV, {}), /视觉管线实例/)
  // ② 给了 vision 但片没下载
  await assert.rejects(
    () => bili.describeVideo(BV, { vision: { async describeVideo() { return {} } } }),
    /还没下载到本地/,
    '★ 没片要说清楚是「没下载」，不能装作算过'
  )
})

test('★★ describeVideo：真走管线、时间序列带出来', async () => {
  const home = mkDir()
  const vd = join(home, 'shots', 'video')
  mkdirSync(vd, { recursive: true })
  writeFileSync(join(vd, BV + '.mp4'), Buffer.from('fake-video'))

  const calls = []
  const vision = {
    async describeVideo(path, opts) {
      calls.push({ path, opts })
      return {
        id: 'x'.repeat(16), kind: 'video',
        text: '按时间顺序：0s 画面 A → 15s 画面 B',
        timeline: [{ at: 0, text: '画面 A' }, { at: 15, text: '画面 B' }],
        tags: [], cached: false, model: 'fake', at: 1,
      }
    },
  }
  const bili = createBiliCover({ home, inputDir: join(home, 'in') })
  const r = await bili.describeVideo(BV, { vision, focus: '说清变化' })

  assert.equal(calls.length, 1, '★ 调一次管线')
  assert.equal(calls[0].path, join(vd, BV + '.mp4'), '★ 用的是本地已下载的片，不重新下载')
  assert.equal(calls[0].opts.focus, '说清变化', '★ focus 透传（进缓存键）')
  assert.equal(r.timeline.length, 2, '★ 时间序列带出来了')
  assert.equal(r.video, BV + '.mp4', '★ 把片名一起带出来，便于溯源')
  assert.match(r.text, /画面 B/)
})

test('★ 源码里不许出现本机绝对路径（AGENTS 0⑤）', async () => {
  const src = readFileSync(new URL('../lib/bili-cover.mjs', import.meta.url), 'utf8')
  const bad = src.match(/C:\\\\Users\\\\[A-Za-z0-9]+|\/home\/[A-Za-z]+|D:\\\\[A-Za-z]/g)
  assert.equal(bad, null, '★ 看片目录要从 home 派生，不许写死：' + JSON.stringify(bad))
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
