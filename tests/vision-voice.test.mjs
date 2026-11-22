// QQ 语音转写的判据（2026-11-22 主人方案 P3）。
//
// 方案 §七 的原话：「语音转写受现有开关控制：开了才转，关着回落占位」。
// 所以这里的大头是**开关关着时一个字都不加**（AGENTS M6：默认关的新功能，
// 不许改变既有输出），以及「桥已经转过就别再花一次钱」。
//
// 全程假管线 + 假 fetch，不碰本机（AGENTS 6.3）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_VOICE_PER_MESSAGE, createVoiceTranscriber, shouldTranscribe, transcriptLine } from '../lib/vision-voice.mjs'

function mkDir() { return mkdtempSync(join(tmpdir(), 'fw-voice-')) }

const RECORD = { kind: 'record', label: '语音', url: 'https://例子.test/v.silk' }
const TEXT_ONLY = [{ kind: 'text', text: '你好' }]

// ══════════ ★★ 开关：关着就一个字都不加 ══════════

test('★★ 开关关着 → 不转（reason=switch-off），这是默认状态', () => {
  const r = shouldTranscribe({ parts: [RECORD], text: '', switchOn: false })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'switch-off')
})

test('★★ 开关没给 / 给了非 true → 一律不转（默认拒绝）', () => {
  assert.equal(shouldTranscribe({ parts: [RECORD], text: '' }).ok, false)
  assert.equal(shouldTranscribe({ parts: [RECORD], text: '', switchOn: 'true' }).ok, false)
  assert.equal(shouldTranscribe({ parts: [RECORD], text: '', switchOn: 1 }).ok, false)
  assert.equal(shouldTranscribe({ parts: [RECORD], text: '', switchOn: null }).ok, false)
})

test('★★ 开关关着时，转写器返回的正文行是空串（一个字都不加）', async () => {
  let called = 0
  const t = createVoiceTranscriber({
    getWire: () => { called += 1; return null },
    readSwitch: () => false
  })
  const r = await t.transcribe({ parts: [RECORD], text: '' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'switch-off')
  assert.equal(transcriptLine(r), '', '★ 关着时追加的行必须是空串')
  assert.equal(called, 0, '★ 关着时连管线都不该取')
})

// ══════════ 桥转过就别重复花钱 ══════════

test('★★ 正文里已有译文 → 跳过（同一句不花两次钱）', () => {
  const r = shouldTranscribe({
    parts: [RECORD],
    text: '[语音] 今天好累',
    switchOn: true
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'has-transcript')
})

test('★ 只有占位没有译文 → 照转', () => {
  const r = shouldTranscribe({ parts: [RECORD], text: '[语音]', switchOn: true })
  assert.equal(r.ok, true, '★ 空占位不算译文')
  assert.equal(r.url, 'https://例子.test/v.silk')
})

test('★ 正文里别的地方出现「语音」两字不算译文', () => {
  const r = shouldTranscribe({ parts: [RECORD], text: '他发了语音给我', switchOn: true })
  assert.equal(r.ok, true)
})

// ══════════ 拿不到音频就不硬转 ══════════

test('★★ QQ 给的是文件名不是地址 → 跳过（下不到，不猜）', () => {
  const r = shouldTranscribe({
    parts: [{ kind: 'record', url: '0abc123.silk' }],
    text: '',
    switchOn: true
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-downloadable')
  assert.equal(r.url, '0abc123.silk')
})

test('★ 没有语音段 → 跳过', () => {
  assert.equal(shouldTranscribe({ parts: TEXT_ONLY, text: '你好', switchOn: true }).reason, 'no-record')
  assert.equal(shouldTranscribe({ parts: [], text: '', switchOn: true }).reason, 'no-record')
  assert.equal(shouldTranscribe({ text: '', switchOn: true }).reason, 'no-record')
})

test('★ 有多个语音段 → 只转第一个（省额度）', () => {
  const r = shouldTranscribe({
    parts: [
      { kind: 'record', url: 'https://例子.test/1.silk' },
      { kind: 'record', url: 'https://例子.test/2.silk' }
    ],
    text: '',
    switchOn: true
  })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://例子.test/1.silk')
  assert.equal(MAX_VOICE_PER_MESSAGE, 1)
})

// ══════════ 转写链路 ══════════

test('★★ 开着开关 + 拿到管线 → 转出文字', async () => {
  const dir = mkDir()
  const t = createVoiceTranscriber({
    getWire: () => ({
      vision: { async transcribeAudio() { return { text: '今天好累', cached: false, id: 'abc' } } },
      backend: { status: () => ({ gridDir: join(dir, '宫格') }) }
    }),
    readSwitch: () => true,
    fetchImpl: async () => new Response(Buffer.from('RIFFfake'), { status: 200 })
  })
  const r = await t.transcribe({ parts: [RECORD], text: '' })
  assert.equal(r.ok, true, '★ 该转的时候要转出来')
  assert.equal(r.text, '今天好累')
  assert.equal(transcriptLine(r), '[语音] 今天好累', '★ 占位格式沿用协议端那套')
})

test('★★ 拿不到管线 → 如实说 no-wire，不假装转过', async () => {
  const t = createVoiceTranscriber({ getWire: () => null, readSwitch: () => true })
  const r = await t.transcribe({ parts: [RECORD], text: '' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-wire')
  assert.equal(transcriptLine(r), '')
})

test('★★ 管线抛错 → 带原因，不吞', async () => {
  const dir = mkDir()
  const t = createVoiceTranscriber({
    getWire: () => ({
      vision: { async transcribeAudio() { throw new Error('缺 ffmpeg / ffprobe') } },
      backend: { status: () => ({ gridDir: join(dir, '宫格') }) }
    }),
    readSwitch: () => true,
    fetchImpl: async () => new Response(Buffer.from('RIFFfake'), { status: 200 }),
    logger: { warn() {} }
  })
  const r = await t.transcribe({ parts: [RECORD], text: '' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /transcribe-failed:缺 ffmpeg/)
  assert.equal(transcriptLine(r), '')
})

test('★★ 下载失败 → 带 HTTP 状态码，不吞', async () => {
  const dir = mkDir()
  const t = createVoiceTranscriber({
    getWire: () => ({
      vision: { async transcribeAudio() { return { text: 'x' } } },
      backend: { status: () => ({ gridDir: join(dir, '宫格') }) }
    }),
    readSwitch: () => true,
    fetchImpl: async () => new Response('', { status: 404 }),
    logger: { warn() {} }
  })
  const r = await t.transcribe({ parts: [RECORD], text: '' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /download-failed:.*404/)
})

test('★★ 下载回来不是音频（QQ 给错类型）→ 不硬转', async () => {
  const dir = mkDir()
  let tried = false
  const t = createVoiceTranscriber({
    getWire: () => ({
      vision: { async transcribeAudio() { tried = true; return { text: 'x' } } },
      backend: { status: () => ({ gridDir: join(dir, '宫格') }) }
    }),
    readSwitch: () => true,
    // 造一个 PNG 头的响应，归一化会判成 image
    fetchImpl: async () => new Response(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { status: 200, headers: { 'content-type': 'image/png' } }
    )
  })
  const r = await t.transcribe({ parts: [{ kind: 'record', url: 'https://例子.test/a.png' }], text: '' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /not-audio:image/)
  assert.equal(tried, false, '★ 不是音频就别送去转写')
})

test('★★ 管线转回来是空的 → 说 blank，不返回空串冒充成功', async () => {
  const dir = mkDir()
  const t = createVoiceTranscriber({
    getWire: () => ({
      vision: { async transcribeAudio() { return { text: '   ' } } },
      backend: { status: () => ({ gridDir: join(dir, '宫格') }) }
    }),
    readSwitch: () => true,
    fetchImpl: async () => new Response(Buffer.from('RIFFfake'), { status: 200 })
  })
  const r = await t.transcribe({ parts: [RECORD], text: '' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'blank')
  assert.equal(transcriptLine(r), '')
})

// ══════════ 装配 ══════════

test('★ 没给 getWire → 建的时候就报，不等到用', () => {
  assert.throws(() => createVoiceTranscriber({ readSwitch: () => true }), /getWire/)
})

test('★ 开关读取抛错 → 当作关着（默认拒绝，不因为读不到就放开）', async () => {
  const t = createVoiceTranscriber({
    getWire: () => null,
    readSwitch: () => { throw new Error('配置读不到') }
  })
  assert.equal(t.switchOn(), false)
  const r = await t.transcribe({ parts: [RECORD], text: '' })
  assert.equal(r.reason, 'switch-off')
})

// ══════════ 仓库红线 ══════════

test('★ 源码里不许出现本机绝对路径（AGENTS 0⑤）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/vision-voice.mjs', import.meta.url), 'utf8')
  const bad = src.match(/C:\\\\Users\\\\[A-Za-z0-9]+|\/home\/[A-Za-z]+|D:\\\\[A-Za-z]/g)
  assert.equal(bad, null, '★ 不许写死本机路径：' + JSON.stringify(bad))
})

test('★ transcriptLine 对各种脏输入都不返回半截东西', () => {
  assert.equal(transcriptLine(null), '')
  assert.equal(transcriptLine(undefined), '')
  assert.equal(transcriptLine({ ok: false, text: 'x' }), '')
  assert.equal(transcriptLine({ ok: true, text: '' }), '')
  assert.equal(transcriptLine({ ok: true, text: '   ' }), '')
  assert.equal(transcriptLine({ ok: true, text: '  有字  ' }), '[语音] 有字')
})
