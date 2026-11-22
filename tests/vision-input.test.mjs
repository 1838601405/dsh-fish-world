// 平台适配与归一化的判据（2026-11-22 主人方案 P3）。
//
// P3 的验收原话：「三处同一张图描述一致，且只算一次」+ 方案 (f)
// 「新增一个假平台适配器（不动视觉代码）→ 图片能被识别，证明平台无关」。
//
// 这两份都在这里验：全程用假管线与假 fetch，不碰本机 omni / 网络（AGENTS 6.3）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_FILE_BYTES,
  createVisionInput,
  kindOfName,
  makeEntry,
  normalizeFile
} from '../lib/vision-input.mjs'

function mkDir() {
  return mkdtempSync(join(tmpdir(), 'fw-vin-'))
}

/** 一份「图」的字节（PNG 头 + 一堆填充，够当文件）。 */
function pngBytes(tag = 'A') {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('内容-' + tag)
  ])
}

/** 计数的假管线：按内容算 key，模拟 vision.mjs 的 sha256 缓存语义。 */
function mkVision() {
  const seen = new Map()
  const calls = { describe: 0 }
  const vision = {
    calls,
    cache: seen,
    async describe(file, { focus = '' } = {}) {
      const bytes = readFileSync(file)
      const key = createHash('sha256').update(bytes).digest('hex') + '|' + focus
      const hit = seen.get(key)
      // ★ 只有真去算才计数 —— 命中缓存不调模型，这正是要验的那件事。
      if (hit) return { ...hit, cached: true }
      calls.describe += 1
      const result = {
        id: key.slice(0, 16),
        kind: 'image',
        text: '描述-' + seen.size,
        tags: [],
        cached: false,
        model: 'fake',
        at: 1
      }
      seen.set(key, result)
      return { ...result }
    }
  }
  return vision
}

// ══════════ 归一化：三种形态必须算出同一个 sha256 ══════════

test('★★ 同一份内容：本地路径 / 字节 / dataURL → 同一个 sha256', async () => {
  const dir = mkDir()
  const bytes = pngBytes('same')
  const file = join(dir, 'a.png')
  writeFileSync(file, bytes)

  const fromPath = await normalizeFile({ path: file }, { inputDir: dir })
  const fromBytes = await normalizeFile({ bytes }, { inputDir: dir })
  const fromDataUrl = await normalizeFile(
    'data:image/png;base64,' + bytes.toString('base64'),
    { inputDir: dir }
  )

  assert.equal(fromPath.sha256, fromBytes.sha256, '★ 路径与字节必须同一个 sha256')
  assert.equal(fromPath.sha256, fromDataUrl.sha256, '★ dataURL 也要算成同一个')
  assert.equal(fromPath.kind, 'image')
  assert.equal(fromBytes.kind, 'image')
})

test('★★ url 下载后与本地文件同 sha256（跨平台共享缓存的前提）', async () => {
  const dir = mkDir()
  const bytes = pngBytes('from-url')
  const local = join(dir, 'local.png')
  writeFileSync(local, bytes)

  const fetchImpl = async () => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png' }
  })

  const fromUrl = await normalizeFile({ url: 'https://例子.test/a.png' }, { inputDir: dir, fetchImpl })
  const fromPath = await normalizeFile({ path: local }, { inputDir: dir })

  assert.equal(fromUrl.sha256, fromPath.sha256, '★ 下载来的和本地的必须同一个 sha256')
  assert.equal(fromUrl.kind, 'image')
  assert.ok(existsSync(fromUrl.path), '★ url 形态要落盘成文件（管线只认路径）')
  assert.equal(readFileSync(fromUrl.path).toString('hex'), bytes.toString('hex'))
})

test('★ 同一份内容落盘只留一份（文件名就是 sha256）', async () => {
  const dir = mkDir()
  const bytes = pngBytes('once')
  const a = await normalizeFile({ bytes }, { inputDir: dir })
  const b = await normalizeFile({ bytes }, { inputDir: dir })
  assert.equal(a.path, b.path, '★ 同内容同路径，重复下载不越积越多')
})

test('★★ 换内容 → sha256 必须变（否则缓存会串）', async () => {
  const dir = mkDir()
  const a = await normalizeFile({ bytes: pngBytes('1') }, { inputDir: dir })
  const b = await normalizeFile({ bytes: pngBytes('2') }, { inputDir: dir })
  assert.notEqual(a.sha256, b.sha256)
})

// ══════════ 归一化：认不出就拒，不猜 ══════════

test('★ kindOfName 按扩展名判，认不出返回空串', () => {
  assert.equal(kindOfName('a.PNG'), 'image')
  assert.equal(kindOfName('b.mp4'), 'video')
  assert.equal(kindOfName('c.m4a'), 'audio')
  assert.equal(kindOfName('d.xyz'), '')
  assert.equal(kindOfName(''), '')
})

test('★★ 认不出类型的文件 → 明确报错，不进管线', async () => {
  const dir = mkDir()
  await assert.rejects(
    () => normalizeFile({ path: join(dir, 'nope.xyz') }, { inputDir: dir }),
    /文件不存在/
  )
  // 内容是字节、但没有任何可判类型的头与扩展名
  await assert.rejects(
    () => normalizeFile({ bytes: Buffer.from('随便一段字'), name: 'x.bin' }, { inputDir: dir }),
    /看不出这是什么类型的文件/
  )
})

test('★★ 超大文件 → 拒，不整块读进内存', async () => {
  const dir = mkDir()
  const small = join(dir, 'big.png')
  writeFileSync(small, pngBytes('big'))
  await assert.rejects(
    () => normalizeFile({ path: small }, { inputDir: dir, maxBytes: 4 }),
    /文件太大/
  )
  // 远端声明超限：连下载都不该开始
  let fetched = false
  const fetchImpl = async () => {
    fetched = true
    return new Response(pngBytes(), {
      status: 200,
      headers: { 'content-length': String(1024 * 1024) }
    })
  }
  await assert.rejects(
    () => normalizeFile({ url: 'https://例子.test/big.png' }, {
      inputDir: dir, fetchImpl, maxBytes: 4
    }),
    /文件太大/
  )
  assert.equal(fetched, true, 'fetch 会被调到（先问再下）')
  // 关键是**没把响应体读完**就拒了 —— 用一个读 body 就炸的实现来证
  let bodyRead = false
  const fetchNoBody = async () => {
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(1024 * 1024) : null) },
      arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(0) }
    }
  }
  await assert.rejects(
    () => normalizeFile({ url: 'https://例子.test/big2.png' }, {
      inputDir: dir, fetchImpl: fetchNoBody, maxBytes: 4
    }),
    /文件太大/
  )
  assert.equal(bodyRead, false, '★ 远端声明超限就别把响应体读进来')
})

test('★ 非 HTTP(S) 地址拒掉（不让内网地址溜进来）', async () => {
  const dir = mkDir()
  await assert.rejects(
    () => normalizeFile({ url: 'file:///C:/Windows/win.ini' }, { inputDir: dir }),
    /只认 HTTP\(S\) 地址/
  )
})

test('★ 下载失败要报状态码，不返回空', async () => {
  const dir = mkDir()
  const fetchImpl = async () => new Response('', { status: 404 })
  await assert.rejects(
    () => normalizeFile({ url: 'https://例子.test/gone.png' }, { inputDir: dir, fetchImpl }),
    /下载失败（HTTP 404）/
  )
})

test('★ 没给落盘目录 → 明确报错', async () => {
  await assert.rejects(() => normalizeFile({ bytes: pngBytes() }, {}), /inputDir/)
})

// ══════════ 统一结构 ══════════

test('★ makeEntry 补默认值、拒掉没有 source 的', () => {
  const e = makeEntry({ source: 'qq', who: '小明', files: [{ path: '/a.png' }, null] })
  assert.equal(e.source, 'qq')
  assert.equal(e.who, '小明')
  assert.equal(e.when, 0)
  assert.equal(e.text, '')
  assert.equal(e.raw_id, '')
  assert.equal(e.files.length, 1, 'null 项要滤掉')
  assert.throws(() => makeEntry({ who: 'x' }), /source/)
})

// ══════════ ★★ P3 验收：三处同一张图，描述一致且只算一次 ══════════

test('★★ 三个平台送来同一张图 → 描述一致 + 只调一次模型', async () => {
  const dir = mkDir()
  const bytes = pngBytes('三处同一张')
  const local = join(dir, 'qq-收到.png')
  writeFileSync(local, bytes)

  const vision = mkVision()
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })

  // 三个互不认识的平台适配器：一个给路径、一个给字节、一个给 dataURL
  input.register('qq', (raw) => ({ source: 'qq', who: raw.from, files: [{ path: raw.path }] }))
  input.register('session', (raw) => ({ source: 'session', who: raw.who, files: [{ bytes: raw.bytes }] }))
  input.register('desktop', (raw) => ({
    source: 'desktop',
    files: ['data:image/png;base64,' + raw.b64]
  }))

  const r1 = await input.ingest('qq', { from: '小明', path: local })
  const r2 = await input.ingest('session', { who: '小明', bytes })
  const r3 = await input.ingest('desktop', { b64: bytes.toString('base64') })

  assert.equal(vision.calls.describe, 1, '★ 同一张图三个入口只调一次模型')
  assert.equal(r1.results[0].result.text, r2.results[0].result.text, '★ 描述要一致')
  assert.equal(r2.results[0].result.text, r3.results[0].result.text, '★ 描述要一致')
  assert.equal(r1.results[0].sha256, r2.results[0].sha256)
  assert.equal(r2.results[0].sha256, r3.results[0].sha256)

  // 上下文行的**正文**要一致；「（缓存）」标记不同是诚实的（第一次真算了，后两次没算）。
  const body = (line) => String(line).replace(/（[^）]*）$/, '')
  assert.equal(body(r1.lines[0]), body(r2.lines[0]), '★ 进上下文的正文要一致')
  assert.equal(body(r2.lines[0]), body(r3.lines[0]), '★ 进上下文的正文要一致')
  assert.doesNotMatch(r1.lines[0], /缓存/, '★ 第一次没缓存')
  assert.match(r2.lines[0], /缓存/, '★ 第二次命中要标出来')
  assert.match(r3.lines[0], /缓存/, '★ 第三次命中要标出来')
})

test('★★ 不同平台的 source 只进 entry，不进描述正文', async () => {
  const dir = mkDir()
  const bytes = pngBytes('不带平台')
  const vision = mkVision()
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })
  input.register('qq', () => ({ source: 'qq', files: [{ bytes }] }))
  input.register('qzone', () => ({ source: 'qzone', files: [{ bytes }] }))

  const a = await input.ingest('qq', {})
  const b = await input.ingest('qzone', {})

  assert.equal(a.entry.source, 'qq')
  assert.equal(b.entry.source, 'qzone')
  // 描述来自同一条缓存，所以正文完全一致，且里面没有平台词
  assert.equal(a.results[0].result.text, b.results[0].result.text)
  const json = JSON.stringify(a.results[0].result)
  for (const w of ['qq', 'qzone', 'QQ', '空间']) {
    assert.equal(json.includes(w), false, '★ 描述里不许出现平台名：' + w)
  }
})

// ══════════ ★★ 方案验收 (f)：新增假平台不动视觉代码 ══════════

test('★★ 新增一个假平台适配器 → 不改视觉代码就能识别', async () => {
  const dir = mkDir()
  const bytes = pngBytes('假平台')
  const vision = mkVision()
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })

  // 加这个「假平台」时没有碰 vision.mjs / vision-input.mjs 的任何一行
  input.register('假平台', (raw) => ({ source: '假平台', files: [{ bytes: raw }] }))

  assert.equal(input.has('假平台'), true)
  assert.ok(input.platforms().includes('假平台'))

  const r = await input.ingest('假平台', bytes)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].result.text, '描述-0')
  assert.equal(r.results[0].kind, 'image')
  assert.ok(r.lines[0].includes('[图 '), '★ 走的是同一套上下文格式')
})

// ══════════ 失败要如实带出来 ══════════

test('★★ 没登记的平台 → 报错并列出已登记的，不静默', async () => {
  const dir = mkDir()
  const input = createVisionInput({ vision: mkVision(), inputDir: join(dir, 'in') })
  input.register('qq', () => ({ source: 'qq', files: [] }))
  await assert.rejects(() => input.ingest('抖音', {}), /没登记平台「抖音」[\s\S]*qq/)
})

test('★★ 一个附件坏了不拖垮整条消息（其余照走，坏的带原因）', async () => {
  const dir = mkDir()
  const good = pngBytes('好')
  const vision = mkVision()
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })
  input.register('qq', () => ({
    source: 'qq',
    files: [{ path: join(dir, '不存在.png') }, { bytes: good }]
  }))

  const r = await input.ingest('qq', {})
  assert.equal(r.files.length, 2)
  assert.equal(r.files[0].ok, false)
  assert.match(r.files[0].error, /文件不存在/)
  assert.equal(r.files[1].ok, true, '★ 后面那个要照常走完')
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].result.text, '描述-0')
})

test('★★ 管线抛错 → 结果里带原话，不当成没发生', async () => {
  const dir = mkDir()
  const vision = {
    async describe() { throw new Error('缺 ffmpeg / ffprobe，读不了这个文件。') }
  }
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })
  input.register('qq', () => ({ source: 'qq', files: [{ bytes: pngBytes() }] }))

  const r = await input.ingest('qq', {})
  assert.equal(r.results.length, 1)
  assert.match(r.results[0].error, /缺 ffmpeg/)
  assert.equal(r.results[0].result, undefined, '★ 失败了就不假装有结果')
  assert.deepEqual(r.lines, [], '★ 失败的不进上下文')
})

test('★ focus 不同 → 不互相顶掉（进了缓存键）', async () => {
  const dir = mkDir()
  const bytes = pngBytes('focus')
  const vision = mkVision()
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })
  input.register('qq', () => ({ source: 'qq', files: [{ bytes }] }))

  await input.ingest('qq', {}, { focus: '有没有文字' })
  await input.ingest('qq', {}, { focus: '画风' })
  assert.equal(vision.calls.describe, 2, '★ 不同问题要分别算')
  await input.ingest('qq', {}, { focus: '有没有文字' })
  assert.equal(vision.calls.describe, 2, '★ 同问题第二次吃缓存')
})

test('★ 没接管线 / 没给落盘目录 → 建的时候就报，不等到用', () => {
  assert.throws(() => createVisionInput({ inputDir: '/x' }), /视觉管线实例/)
  assert.throws(() => createVisionInput({ vision: mkVision() }), /inputDir/)
})

test('★ 附件一次最多处理 8 个（别被一条爆炸消息拖死）', async () => {
  const dir = mkDir()
  const vision = mkVision()
  const input = createVisionInput({ vision, inputDir: join(dir, 'in') })
  input.register('qq', () => ({
    source: 'qq',
    files: Array.from({ length: 20 }, (_, i) => ({ bytes: pngBytes(String(i)) }))
  }))
  const r = await input.ingest('qq', {})
  assert.equal(r.files.length, 8)
  assert.equal(vision.calls.describe, 8)
})

test('★ 上限常量是 40MB（与 QQ 视频口径一致）', () => {
  assert.equal(MAX_FILE_BYTES, 40 * 1024 * 1024)
})
