// 视觉管线 omni 后端的判据（2026-11-22 主人要求 P2）。
//
// P2 的核心判据两条：
//   ① 真材料能出结果 —— 视频出时序、语音出文字（在 tests/vision-omni-real.test.mjs 里跑真的）；
//   ② 缺依赖时明确报错，不静默 —— 没装 omni / 缺 ffmpeg / 转写失败，各自说清缺什么、怎么装。
//
// 这里全用替身（locate / loadLibs 注入），不碰本机的 omni 与 ffmpeg ——
// AGENTS 6.3：测试不许依赖本机状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOmniRecognize, DEFAULT_GRID_CELLS, MAX_GRID_CELLS, OMNI_PACKAGE } from '../lib/vision-omni.mjs'

/** 找得到包的替身。 */
const locateFound = () => ({ found: true, path: '/虚拟/包目录', version: '0.1.11' })
/** 找不到包的替身。 */
const locateMissing = () => ({ found: false, path: '', version: '', error: 'not installed' })

/** 一套够用的假 omni lib。想让它失败就覆盖其中一项。 */
function fakeLibs(overrides = {}) {
  return {
    version: '0.1.11',
    ffmpeg: {
      async probe(cfg, file) {
        if (overrides.probe) return overrides.probe(cfg, file)
        return {
          ok: true,
          file,
          duration: 8.064,
          video: { codec: 'h264', width: 1280, height: 720, fps: 24, frames: 193 },
          audio: { codec: 'aac', sampleRate: 32000, channels: 2 },
          hasVideo: true,
          hasAudio: true
        }
      }
    },
    scan: {
      async renderGrid(cfg, req) {
        if (overrides.renderGrid) return overrides.renderGrid(cfg, req)
        return {
          ok: true,
          path: join(mkdtempSync(join(tmpdir(), 'grid-')), 'grid-1.png'),
          timeline: [
            { n: 1, at: 0, label: '00:00:00.000' },
            { n: 2, at: 2.016, label: '00:00:02.016' },
            { n: 3, at: 4.032, label: '00:00:04.032' },
            { n: 4, at: 6.048, label: '00:00:06.048' }
          ],
          grid: { cols: 2, rows: 2, capacity: 4, used: 4 }
        }
      },
      formatClock(seconds) {
        const s = Number(seconds) || 0
        const mm = String(Math.floor(s / 60)).padStart(2, '0')
        const ss = (s % 60).toFixed(3).padStart(6, '0')
        return `00:${mm}:${ss}`
      }
    },
    audio: {
      async transcribeAudio(ctx, cfg, req) {
        if (overrides.transcribe) return overrides.transcribe(ctx, cfg, req)
        return {
          ok: true,
          route: 'local',
          text: '今天好累啊',
          segments: [{ start: 0, end: 4.6, text: '今天好累啊' }]
        }
      }
    }
  }
}

const VIDEO = '/虚拟/片子.mp4'
const AUDIO = '/虚拟/语音.mp3'

// ══════════ ② 缺依赖要明说 ══════════

test('★★ 没装 omni → 报「没装」并给装法，不静默', async () => {
  const back = createOmniRecognize({ locate: locateMissing })
  await assert.rejects(() => back.video(VIDEO), (error) => {
    assert.match(error.message, /没装/)
    assert.match(error.message, new RegExp(OMNI_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(error.message, /dsh plugin add/)
    return true
  })
  await assert.rejects(() => back.audio(AUDIO), /没装/)
})

test('★★ omni 装了但 import 失败 → 报「加载失败」带原始原因', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => { throw new Error('Cannot find module scan.js') }
  })
  await assert.rejects(() => back.video(VIDEO), /装了但加载失败[\s\S]*Cannot find module/)
})

test('★★ 缺 ffmpeg（ENOENT）→ 说清缺什么、怎么装', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({ probe: () => ({ ok: false, error: 'spawn ffprobe ENOENT' }) })
  })
  await assert.rejects(() => back.video(VIDEO), (error) => {
    assert.match(error.message, /缺 ffmpeg/)
    assert.match(error.message, /winget install Gyan\.FFmpeg/)
    return true
  })
})

test('★ ffmpeg 被系统拦（EPERM）→ 不谎报成「缺 ffmpeg」', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({ probe: () => ({ ok: false, error: 'spawn EPERM' }) })
  })
  await assert.rejects(() => back.video(VIDEO), (error) => {
    assert.match(error.message, /EPERM/)
    assert.doesNotMatch(error.message, /winget install/)
    return true
  })
})

test('★★ 看图通道没接 → describe 明说没接，不返回空串', async () => {
  const back = createOmniRecognize({ locate: locateFound, loadLibs: async () => fakeLibs() })
  await assert.rejects(() => back.describe(VIDEO), (error) => {
    assert.match(error.message, /没接看图通道/)
    assert.match(error.message, /不能读图/)
    return true
  })
})

test('★★ 抽帧失败 → 带上 ffmpeg 的 detail 尾巴', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({
      renderGrid: () => ({ ok: false, error: 'ffmpeg failed to build the grid', detail: 'Error opening output file\nInvalid argument' })
    })
  })
  await assert.rejects(() => back.video(VIDEO), (error) => {
    assert.match(error.message, /抽帧失败/)
    assert.match(error.message, /Invalid argument/)
    return true
  })
})

test('★★ 转写失败 → 报原因 + omni 给的 install/hint，一个都不吞', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({
      transcribe: () => ({
        ok: false,
        error: '找不到可用的 Python',
        install: 'pip install faster-whisper',
        hint: '运行 omni_env_check 查看每个解释器里有什么'
      })
    })
  })
  await assert.rejects(() => back.audio(AUDIO), (error) => {
    assert.match(error.message, /找不到可用的 Python/)
    assert.match(error.message, /pip install faster-whisper/)
    assert.match(error.message, /omni_env_check/)
    return true
  })
})

// ══════════ ① 真材料要能出结果（这里验形状，真的跑在 real 那份里） ══════════

test('★★ 视频 → 时间轴 + 一段话（没看图通道时报量出来的事实）', async () => {
  const back = createOmniRecognize({ locate: locateFound, loadLibs: async () => fakeLibs() })
  const r = await back.video(VIDEO)

  assert.ok(Array.isArray(r.timeline), '要有时间轴')
  assert.equal(r.timeline.length, 4)
  assert.equal(r.timeline[0].at, 0)
  assert.equal(typeof r.text, 'string')
  assert.ok(r.text.length > 0, '不许返回空串')
  // 没看图通道时必须写明「画面内容没识别」，不许编
  assert.match(r.text, /没接看图通道，画面内容没识别/)
  assert.match(r.text, /8\.1 秒/)
  assert.match(r.text, /1280×720/)
  assert.match(r.text, /抽 4 格/)
})

test('★★ 接了看图通道 → 话来自通道，且通道拿的是宫格图', async () => {
  const seen = []
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs(),
    describe: async (file, opts) => {
      seen.push({ file, focus: opts?.focus })
      return { text: '鲸鱼从左侧游过，第 2 秒转身', tags: ['鲸'] }
    }
  })
  const r = await back.video(VIDEO, { focus: '有没有文字' })

  assert.equal(r.text, '鲸鱼从左侧游过，第 2 秒转身')
  assert.deepEqual(r.tags, ['鲸'])
  assert.equal(seen.length, 1)
  assert.match(seen[0].file, /grid-1\.png$/, '要看的是抽出来的宫格')
  assert.equal(seen[0].focus, '有没有文字')
  assert.equal(r.timeline.length, 4, '看图不冲掉时间轴')
})

test('★ 看图通道没给 focus → 用默认的「按时间顺序说清」', async () => {
  let focus = null
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs(),
    describe: async (file, opts) => { focus = opts?.focus; return { text: 'x' } }
  })
  await back.video(VIDEO)
  assert.match(focus, /按时间顺序/)
})

test('★★ 看图通道抛错 → 退回报量出来的事实，抽帧结果不被否定', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs(),
    describe: async () => { throw new Error('视觉接口超时') },
    logger: { warn() {} }
  })
  const r = await back.video(VIDEO)

  assert.match(r.text, /没接看图通道，画面内容没识别/, '退路文案')
  assert.equal(r.timeline.length, 4, '★ 时间轴必须保住')
})

test('★★ 语音 → 文字 + 时间轴', async () => {
  const back = createOmniRecognize({ locate: locateFound, loadLibs: async () => fakeLibs() })
  const r = await back.audio(AUDIO)

  assert.equal(r.text, '今天好累啊')
  assert.ok(Array.isArray(r.timeline))
  assert.equal(r.timeline.length, 1)
  assert.equal(r.timeline[0].at, 0)
  assert.equal(r.timeline[0].label, '00:00:00.000')
})

test('★★ 转写回来是空的 → 说「没听出话」，不返回空串', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({ transcribe: () => ({ ok: true, text: '   ', segments: [] }) })
  })
  const r = await back.audio(AUDIO)
  assert.equal(r.text, '没听出话')
  assert.ok(r.text.length > 0)
  assert.deepEqual(r.timeline, [])
})

test('★ 转写段落里没有 start 的脏数据 → 滤掉，不产生 NaN 时间点', async () => {
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({
      transcribe: () => ({ ok: true, text: 'x', segments: [{ text: 'a' }, { start: 'abc', text: 'b' }, { start: 1.5, text: 'c' }] })
    })
  })
  const r = await back.audio(AUDIO)
  assert.equal(r.timeline.length, 1)
  assert.equal(r.timeline[0].at, 1.5)
})

// ══════════ 成本纪律：不逐帧 ══════════

test('★★ 帧数夹到 1..12（给了 999 也不逐帧）', async () => {
  let got = null
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({
      renderGrid: (cfg, req) => {
        got = req.maxCells
        return { ok: true, path: '/虚拟/g.png', timeline: [{ n: 1, at: 0, label: 'x' }] }
      }
    })
  })

  await back.video(VIDEO, { frames: 999 })
  assert.equal(got, MAX_GRID_CELLS, '★ 上限 12')

  await back.video(VIDEO, { frames: -5 })
  assert.equal(got, DEFAULT_GRID_CELLS, '★ 垃圾值落回默认 7')

  await back.video(VIDEO, { frames: 4 })
  assert.equal(got, 4, '正常值照给')
})

test('★ 不给 frames → 用默认 7', async () => {
  let got = null
  const back = createOmniRecognize({
    locate: locateFound,
    loadLibs: async () => fakeLibs({
      renderGrid: (cfg, req) => { got = req.maxCells; return { ok: true, path: '/虚拟/g.png', timeline: [] } }
    })
  })
  await back.video(VIDEO)
  assert.equal(got, DEFAULT_GRID_CELLS)
})

// ══════════ 缓存键：模型版本要跟着变 ══════════

test('★★ modelVersion 随「装没装 / 转写模型 / 接没接看图通道」变', () => {
  const a = createOmniRecognize({ locate: locateFound, loadLibs: async () => fakeLibs() })
  const b = createOmniRecognize({ locate: locateFound, loadLibs: async () => fakeLibs(), describe: async () => ({ text: 'x' }) })
  const c = createOmniRecognize({ locate: locateFound, loadLibs: async () => fakeLibs(), config: { asr: { localModel: 'large-v3' } } })
  const d = createOmniRecognize({ locate: locateMissing })

  const versions = [a.modelVersion(), b.modelVersion(), c.modelVersion(), d.modelVersion()]
  assert.equal(new Set(versions).size, 4, '★ 四种状态必须四个不同的缓存键：' + versions.join(' | '))
  assert.match(a.modelVersion(), /omni@0\.1\.11\+asr-small$/)
  assert.match(b.modelVersion(), /\+看图$/)
  assert.match(d.modelVersion(), /omni@未装/)
})

// ══════════ status：面板要能看见 ══════════

test('★ status 说清装没装、看图通道接没接，且不跑子进程', () => {
  const ok = createOmniRecognize({ locate: locateFound, loadLibs: async () => fakeLibs(), gridDir: '/虚拟/格子' })
  const s1 = ok.status()
  assert.equal(s1.ok, true)
  assert.equal(s1.version, '0.1.11')
  assert.equal(s1.describe, false)
  assert.equal(s1.gridDir, '/虚拟/格子')
  assert.equal(s1.error, '')

  const no = createOmniRecognize({ locate: locateMissing })
  const s2 = no.status()
  assert.equal(s2.ok, false)
  assert.equal(s2.error, 'not installed')
  assert.match(s2.version, /^$/, '没装就不编版本号')
})

// ══════════ 仓库红线：不写死本机路径 ══════════

test('★ 源码里不许出现本机绝对路径（AGENTS 0⑤）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/vision-omni.mjs', import.meta.url), 'utf8')
  const bad = src.match(/C:\\\\Users\\\\[A-Za-z0-9]+|\/home\/[A-Za-z]+|D:\\\\[A-Za-z]/g)
  assert.equal(bad, null, '★ 不许写死本机路径：' + JSON.stringify(bad))
})
