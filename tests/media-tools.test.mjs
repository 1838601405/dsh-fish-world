// 视频工具的外壳：不跑真 ffmpeg，只验「鱼世界额外加的那三层」——
// 沙箱、额度、串行，以及「没装就如实说没装」。
//
// 上游 dsh-ffmpeg 的工具实现用假 loadTools 代替：这里测的不是它怎么编 ffmpeg 参数
// （那是它的单测），而是我们有没有把参数原样透传、路径有没有先过沙箱。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSandbox } from '../lib/sandbox.mjs'
import { createMediaTools, createRunner, OUTPUT_FOLDER } from '../lib/media-tools.mjs'
import { normalizeConfig } from '../lib/config.mjs'

/** 与上游 tools.js 同名同参数的最小替身：只记录调用、返回约定好的形状。 */
const PROPERTIES = {
  probe: { input: { type: 'string' } },
  cut: { input: {}, start: {}, end: {}, duration: {}, output: {}, reencode: {} },
  concat: { inputs: { type: 'array' }, output: {}, reencode: {} },
  encode: { input: {}, preset: {}, crf: {}, fps: {}, scale: {}, output: {} },
  subtitle: { input: {}, subtitle: {}, output: {} },
  gif: { input: {}, start: {}, duration: {}, fps: {}, width: {}, output: {} },
  frames: { input: {}, every: {}, times: {}, maxFrames: {}, outputDir: {}, format: {} },
  adjust: { input: {}, speed: {}, volume: {}, mute: {}, rotate: {}, output: {} },
  health: {},
}

const TOOL_NAMES = {
  probe: 'ffmpeg_probe', cut: 'ffmpeg_cut', concat: 'ffmpeg_concat', encode: 'ffmpeg_encode',
  subtitle: 'ffmpeg_subtitle', gif: 'ffmpeg_gif', frames: 'ffmpeg_frames', adjust: 'ffmpeg_adjust',
  health: 'ffmpeg_health',
}

function fakeLoader({ calls = [], onExecute = null } = {}) {
  return {
    buildFfmpegTools(config) {
      return Object.entries(TOOL_NAMES).map(([op, name]) => ({
        name,
        description: '',
        parameters: { type: 'object', properties: PROPERTIES[op] },
        async execute(args) {
          calls.push({ op, args, config })
          if (onExecute) return await onExecute(op, args)
          if (op === 'health') {
            return { ok: true, plugin: 'dsh-ffmpeg', checks: [{ name: 'ffmpeg', ok: true, version: 'ffmpeg version test' }] }
          }
          if (op === 'probe') return { ok: true, input: args.input, summary: 'mp4，10 秒' }
          if (op === 'frames') {
            return { outputDir: args.outputDir, mode: 'every', every: 1, count: 2, files: ['frame-001.png', 'frame-002.png'] }
          }
          return { output: args.output, start: 0, duration: 1 }
        },
      }))
    },
  }
}

function setup({ media = {}, loader, locate, loadCalls = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-media-'))
  const sandbox = createSandbox({ home: join(home, 'home') })
  sandbox.ensureRoot()
  const worldRoot = join(home, 'workspace', '鱼的世界')
  mkdirSync(worldRoot, { recursive: true })
  const calls = []
  const mediaTools = createMediaTools({
    sandbox,
    world: { root: () => worldRoot },
    config: () => ({ media }),
    locate: locate || (() => ({ found: true, path: join(home, 'fake-dsh-ffmpeg'), version: '0.4.5' })),
    loadTools: async (dir) => {
      loadCalls.push(dir)
      return loader || fakeLoader({ calls })
    },
    logger: { warn() {} },
  })
  return { home, sandbox, tankRoot: sandbox.root(), worldRoot, calls, media: mediaTools, loadCalls }
}

function writeInput(tankRoot, name = 'source.mp4', bytes = 32) {
  const file = join(tankRoot, name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes, 1))
  return file
}

test('沙箱：绝对路径、盘符、.. 一律拒绝，输入与输出都过鱼箱', async () => {
  const { tankRoot, media, calls } = setup()
  writeInput(tankRoot)

  const absolute = await media.run({ op: 'probe', input: 'C:\\Windows\\win.ini' })
  assert.equal(absolute.ok, false)
  assert.match(absolute.error, /鱼箱|盘符|绝对路径/)

  const traversal = await media.run({ op: 'probe', input: '../outside.mp4' })
  assert.equal(traversal.ok, false)
  assert.match(traversal.error, /鱼箱|跳出/)

  const badOutput = await media.run({ op: 'cut', input: 'source.mp4', start: '0', duration: '1', output: 'C:/out.mp4' })
  assert.equal(badOutput.ok, false)
  assert.match(badOutput.error, /output 只能写在鱼箱里/)

  const escapingOutput = await media.run({ op: 'cut', input: 'source.mp4', start: '0', duration: '1', output: '..\\out.mp4' })
  assert.equal(escapingOutput.ok, false)
  assert.match(escapingOutput.error, /output 只能写在鱼箱里/)
  assert.equal(calls.length, 0, '路径没过沙箱就不该调用上游工具')
})

test('没给 output：统一写到 <世界>/鱼的产出，不回写输入同目录', async () => {
  const { tankRoot, worldRoot, media, calls } = setup()
  writeInput(tankRoot)

  const result = await media.run({ op: 'cut', input: 'source.mp4', start: '0', duration: '1' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const expected = join(worldRoot, OUTPUT_FOLDER, 'source.cut.mp4')
  assert.equal(result.output, expected)
  assert.equal(result.op, 'cut')
  assert.equal(typeof result.durationMs, 'number')
  assert.match(result.content, /视频已处理好/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.output, expected, '透传给上游的 output 也必须是这个绝对路径')
  assert.ok(existsSync(join(worldRoot, OUTPUT_FOLDER)), '产出目录要建出来')
})

test('frames：默认建 <世界>/鱼的产出/<名字>-frames；output 是 outputDir 的别名', async () => {
  const { tankRoot, worldRoot, media, calls } = setup()
  writeInput(tankRoot)

  const plain = await media.run({ op: 'frames', input: 'source.mp4', every: 2 })
  assert.equal(plain.ok, true, JSON.stringify(plain))
  assert.equal(plain.output, join(worldRoot, OUTPUT_FOLDER, 'source-frames'))
  assert.equal(plain.outputDir, plain.output)
  assert.equal(calls[0].args.outputDir, plain.output)

  const alias = await media.run({ op: 'frames', input: 'source.mp4', output: '抽帧结果' })
  assert.equal(alias.ok, true, JSON.stringify(alias))
  assert.equal(alias.output, join(tankRoot, '抽帧结果'), '模型显式给的 output 落在鱼箱里')
  assert.equal(calls[1].args.outputDir, alias.output)

  const both = await media.run({ op: 'frames', input: 'source.mp4', output: 'a', outputDir: 'b' })
  assert.equal(both.ok, false)
  assert.match(both.error, /只能给 output 或 outputDir/)
})

test('额度：输入超过 media.maxInputMB 直接拒绝，不启动任务', async () => {
  const { tankRoot, media, calls } = setup({ media: { maxInputMB: 1 } })
  writeInput(tankRoot, 'big.mp4', Math.round(1.5 * 1024 * 1024))

  const result = await media.run({ op: 'probe', input: 'big.mp4' })
  assert.equal(result.ok, false)
  assert.match(result.error, /太大/)
  assert.match(result.error, /1 MB/)
  assert.equal(calls.length, 0)
})

test('未知 op 与未知参数都拒绝（不发明语义、不接受任意 ffmpeg 参数）', async () => {
  const { tankRoot, media, calls } = setup()
  writeInput(tankRoot)

  const unknownOp = await media.run({ op: 'extract', input: 'source.mp4' })
  assert.equal(unknownOp.ok, false)
  assert.match(unknownOp.error, /不认识的视频操作/)

  const emptyOp = await media.run({})
  assert.equal(emptyOp.ok, false)
  assert.match(emptyOp.error, /不认识的视频操作/)

  const unknownArg = await media.run({ op: 'probe', input: 'source.mp4', vf: '-vf scale=1:1' })
  assert.equal(unknownArg.ok, false)
  assert.match(unknownArg.error, /不认识的参数：vf/)
  assert.equal(calls.length, 0)
})

test('未安装 dsh-ffmpeg：如实报没装，不假装成功', async () => {
  const loadCalls = []
  const { media } = setup({ locate: () => ({ found: false, path: '', version: '' }), loadCalls })

  const result = await media.run({ op: 'health' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'dsh-ffmpeg 没装，视频工具不可用')
  assert.equal(loadCalls.length, 0, '没装就不要再尝试 import')

  const status = media.status()
  assert.equal(status.installed, false)
  assert.equal(status.ok, false)
  assert.equal(status.error, 'dsh-ffmpeg 没装，视频工具不可用')
})

test('status：装了就报版本、额度、产出目录', () => {
  const { media, worldRoot } = setup()
  const status = media.status()
  assert.equal(status.ok, true)
  assert.equal(status.installed, true)
  assert.equal(status.version, '0.4.5')
  assert.equal(status.maxInputMB, 500)
  assert.equal(status.timeoutMs, 300000)
  assert.equal(status.outputDir, join(worldRoot, OUTPUT_FOLDER))
  assert.ok(status.ops.includes('probe'))
  assert.ok(status.ops.includes('health'))
  assert.equal(status.busy, false)
})

test('上游 execute 抛错：转成中文 {ok:false,error}，不把异常甩给模型', async () => {
  const calls = []
  const loader = fakeLoader({
    calls,
    onExecute: () => { throw new Error('ffmpeg 剪辑失败（退出码 1）：Invalid data found') },
  })
  const { tankRoot, media } = setup({ loader })
  writeInput(tankRoot)

  const result = await media.run({ op: 'cut', input: 'source.mp4', start: '0', duration: '1' })
  assert.equal(result.ok, false)
  assert.match(result.error, /视频 cut 没做成/)
  assert.match(result.error, /Invalid data found/)
  assert.equal(result.op, 'cut')
})

test('串行：同时只跑一个 ffmpeg 任务，第二个立刻被拒绝（选择拒绝，不排队）', async () => {
  const calls = []
  let release = null
  const loader = fakeLoader({
    calls,
    onExecute: (op) => {
      if (op !== 'cut') return null
      return new Promise((resolvePromise) => {
        release = () => resolvePromise({ output: 'ok.mp4' })
      })
    },
  })
  const { tankRoot, media } = setup({ loader })
  writeInput(tankRoot)

  const first = media.run({ op: 'cut', input: 'source.mp4', start: '0', duration: '1' })
  // 第一个任务已经进入执行（await 上游前 busy 已置位），第二个必须被拒。
  const second = await media.run({ op: 'cut', input: 'source.mp4', start: '0', duration: '1' })
  assert.equal(second.ok, false)
  assert.match(second.error, /已经有一个视频任务在跑/)
  assert.equal(media.status().busy, true)

  // 等第一个真正走到上游 execute，拿到放行钩子。
  for (let i = 0; i < 20 && typeof release !== 'function'; i += 1) {
    await new Promise((next) => setImmediate(next))
  }
  assert.equal(typeof release, 'function')
  release()
  const done = await first
  assert.equal(done.ok, true)
  assert.equal(media.status().busy, false, '跑完要解锁，不能把后面的任务永远挡在外面')
})

test('health 不需要媒体文件，跑完把自检结果带回来', async () => {
  const { media, calls } = setup()
  const result = await media.run({ op: 'health' })
  assert.equal(result.ok, true)
  assert.equal(result.op, 'health')
  assert.match(result.content, /自检/)
  assert.equal(calls[0].op, 'health')
  assert.deepEqual(calls[0].args, {}, 'health 不该收到 input 之类的东西')
})

test('ffmpeg 自检不通过时不当成功：说清是哪个可执行文件不行', async () => {
  const loader = fakeLoader({
    onExecute: (op) => (op === 'health'
      ? { ok: false, checks: [{ name: 'ffprobe', ok: false, detail: '找不到可执行文件 ffprobe' }] }
      : null),
  })
  const { media } = setup({ loader })
  const result = await media.run({ op: 'health' })
  assert.equal(result.ok, false)
  assert.match(result.error, /ffmpeg 自检没通过/)
  assert.match(result.error, /ffprobe/)
})

test('runner：argv 数组、shell:false，超时会杀进程并报中文超时', async () => {
  const captured = []
  const children = []
  const spawn = (bin, argv, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    captured.push({ bin, argv, options, child })
    children.push(child)
    return child
  }

  const runner = createRunner({ spawn })

  // 1) 正常跑完：argv 原样分开传，不经过 shell。
  const run = runner.run(['ffmpeg', '-version'], { timeoutMs: 1000 })
  const child = children[0]
  child.stdout.emit('data', Buffer.from('ffmpeg version test\n'))
  child.emit('close', 0, null)
  const result = await run
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'ffmpeg version test')
  assert.equal(captured[0].bin, 'ffmpeg')
  assert.deepEqual(captured[0].argv, ['-version'])
  assert.equal(captured[0].options.shell, false, '绝不允许 shell:true')

  // 2) 超时：kill 被调用，Promise 以中文错误失败。
  const timed = runner.run(['ffmpeg', '-i', '慢任务.mp4'], { timeoutMs: 10 })
  await assert.rejects(timed, /秒还没跑完，已终止/)
  assert.equal(children[1].killed, true)
})

test('配置归一化：media 段有默认值，额度只许往小里调', () => {
  const cfg = normalizeConfig({
    media: { timeoutMs: 99999999, maxInputMB: 99999, outputDir: 'relative/dir', ffmpegPath: ' ffmpeg ' },
  })
  assert.equal(cfg.media.timeoutMs, 300000, '单次不能超过 5 分钟')
  assert.equal(cfg.media.maxInputMB, 500, '输入不能超过 500MB')
  assert.equal(cfg.media.outputDir, '', '相对路径不接受，退回默认产出目录')
  assert.equal(cfg.media.ffmpegPath, 'ffmpeg')
  assert.equal(cfg.media.ffprobePath, '')

  const absolute = normalizeConfig({ media: { outputDir: 'X:/fish-output', timeoutMs: 60000 } })
  assert.equal(absolute.media.outputDir.replace(/\\/g, '/'), 'X:/fish-output')
  assert.equal(absolute.media.timeoutMs, 60000)

  const empty = normalizeConfig({})
  assert.equal(empty.media.timeoutMs, 300000)
  assert.equal(empty.media.maxInputMB, 500)
})

test('输入上限的判据是磁盘上的真实大小，不是模型说的数字', async () => {
  const { tankRoot, media } = setup({ media: { maxInputMB: 1 } })
  const file = writeInput(tankRoot, 'exact.mp4', 1024 * 1024)
  assert.equal(statSync(file).size, 1024 * 1024)
  const ok = await media.run({ op: 'probe', input: 'exact.mp4' })
  assert.equal(ok.ok, true, '刚好等于上限要放行')
})
