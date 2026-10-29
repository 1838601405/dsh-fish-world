import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply as applyAnimation } from '../lib/core-plugins/read-animation/index.js'

const temp = mkdtempSync(join(tmpdir(), 'fish-world-animation-'))
const require = createRequire(import.meta.url)
// sharp 是可选的重型原生依赖：显式路径优先，否则走插件自己的 loadSharp()（会查
// DSH_HOME 各 profile 的 node_modules）；都拿不到就置 undefined，交给 sharpAvailable
// 跳过依赖它的用例，而不是让整份文件在模块加载期抛 MODULE_NOT_FOUND。
const { loadSharp } = await import('../lib/core-plugins/read-animation/sharp.js')
let sharp
try {
  sharp = process.env.FISH_WORLD_TEST_SHARP
    ? require(process.env.FISH_WORLD_TEST_SHARP)
    : loadSharp()
} catch {
  sharp = undefined
}
if (process.env.FISH_WORLD_TEST_SHARP) process.env.DSH_READ_ANIMATION_SHARP = process.env.FISH_WORLD_TEST_SHARP
const sharpAvailable = typeof sharp === 'function'
/** 生成 GIF 需要本机 ffmpeg；没有就跳过依赖它的用例。 */
function hasExecutable(name) {
  try { execFileSync(name, ['-version'], { stdio: 'ignore' }); return true }
  catch { return false }
}
const ffmpegAvailable = hasExecutable(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const animationModule = await import('../lib/core-plugins/read-animation/animation.js')

test('GIF 动图采样保留多帧和帧时间标注', { skip: !(sharpAvailable && ffmpegAvailable) && '需要 sharp 与 ffmpeg 测试运行时' }, async () => {
  const gif = join(temp, 'generated.gif')
  execFileSync('ffmpeg.exe', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=5:duration=1', '-vf', 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', gif])
  const gifBytes = readFileSync(gif)

  const metadata = await animationModule.probeAnimation(sharp, gifBytes)
  assert.equal(metadata.format, 'gif')
  assert.ok(metadata.frameCount >= 2)
  const plan = animationModule.planFrames(metadata, { maxFrames: Math.min(metadata.frameCount, 3) })
  assert.ok(plan.plan.length >= 2)
  const rendered = await animationModule.renderFrames(sharp, gifBytes, plan.plan, { maxEdge: 64, background: 'white' })
  assert.equal(rendered.length, plan.plan.length)
  assert.ok(rendered.every((frame) => frame.timeMs >= 0 && frame.delayMs > 0 && frame.data.length > 0))
})

test('内置工具用 Harness 注入式 schema 注册，不公开底层解码 helper', () => {
  let mounted
  let registered
  const attachments = { imageLimits: { maxImagesPerMessage: 10, maxImagePixels: 16_000_000 } }
  const baseCtx = {
    inject(_services, callback) { mounted = callback; return () => {} },
    get(name) { return name === 'attachments' ? attachments : undefined },
    attachments,
    effect() { return () => {} },
    tools: { register(tool) { registered = tool; return () => {} } },
  }
  const ctx = { ...baseCtx, inject(_services, callback) { callback(baseCtx); return () => {} } }
  const dispose = applyAnimation(ctx)
  assert.equal(typeof mounted, 'function')
  mounted({ ...baseCtx, inject(_services, callback) { callback(baseCtx); return () => {} }, effect(fn) { return fn() } })
  assert.equal(registered.name, 'read_animation')
  assert.match(registered.description, /GIF|WebP/)
  assert.equal(typeof registered.execute, 'function')
  assert.equal(typeof dispose, 'function')
})

test('附件准入先留原始 GIF，再将采样帧胶片条交给模型并让 UI 继续播放原件', { skip: !(sharpAvailable && ffmpegAvailable) && '需要 sharp 与 ffmpeg 测试运行时' }, async () => {
  const gifPath = join(temp, 'integration.gif')
  execFileSync('ffmpeg.exe', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=5:duration=1', '-vf', 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', gifPath])
  const gif = readFileSync(gifPath)
  const fallbackPng = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png().toBuffer()
  const savedFrames = new Map()
  const savedFiles = new Map()
  let nextId = 0
  const warnings = []
  const baseContent = [{ type: 'text', text: '看看这个动图' }, { type: 'image', data: gif.toString('base64'), mediaType: 'image/gif', name: 'dance.gif' }]
  const attachments = {
    root: join(temp, 'attachments', 'v1'),
    imageLimits: { maxImagesPerMessage: 12, maxMessageImageBytes: 8 * 1024 * 1024, maxImagePixels: 16_000_000 },
    async admitPromptContent(content) {
      return content.map((part, index) => part.type === 'image'
        ? { type: 'image', attachment: { attachmentId: `source-${index}` } }
        : part)
    },
    async saveImages(images) {
      return images.map((image) => {
        const attachmentId = `frame-${++nextId}`
        savedFrames.set(attachmentId, Buffer.from(image.data))
        return { attachmentId, mediaType: image.mediaType, bytes: image.data.length, width: 32, height: 24, name: image.name }
      })
    },
    async saveFile(file) {
      const id = `original-${++nextId}`
      savedFiles.set(id, Buffer.from(file.data))
      return id
    },
    async *readFileStream(file) { yield savedFiles.get(file) },
    async readImage(ref) { return { ref, data: savedFrames.get(ref.attachmentId) } },
    async readImageRequest(ref) { return { ref, data: fallbackPng, variantId: 'sha256:' + '0'.repeat(64) } },
    fileHostPath() { return '' },
  }
  let registerTool
  const cleanup = []
  const ctx = {
    tools: { register(tool) { registerTool = tool; return () => {} } },
    fs: {},
    get(name) { return name === 'attachments' ? attachments : undefined },
    inject(_services, callback) { callback(ctx); return () => {} },
    effect(fn) { cleanup.push(fn()); return () => {} },
    emit() {},
    logger: { warn(message) { warnings.push(message) } },
  }
  const dispose = applyAnimation(ctx)
  const admitted = await attachments.admitPromptContent(baseContent)
  assert.equal(savedFiles.size, 1, warnings.join('\n') || '原始动图已在准入阶段保存')
  assert.ok(savedFrames.size >= 2, warnings.join('\n') || '采样得到多帧')
  assert.equal(admitted[1].attachment.attachmentId, 'source-1', '正文及宿主返回值保持不变')
  const original = await attachments.readImage(admitted[1].attachment)
  assert.equal(original.ref.mediaType, 'image/gif', JSON.stringify(original.ref) + '\n' + warnings.join('\n'))
  assert.deepEqual(Buffer.from(original.data), gif, '界面拿到未改写的原始 GIF 字节')

  const modelImage = await attachments.readImageRequest(admitted[1].attachment, { width: 900, height: 900, maxBytes: 2_000_000 })
  assert.match(modelImage.variantId, /^sha256:[0-9a-f]{64}$/)
  assert.ok(Buffer.isBuffer(modelImage.data), `模型图不是 Buffer：${JSON.stringify({ ...modelImage, data: String(modelImage.data).slice(0, 50) })}`)
  const modelMetadata = await sharp(modelImage.data).metadata().catch((error) => { throw new Error(`${error.message}; bytes=${modelImage.data.length}; head=${modelImage.data.subarray(0, 16).toString('hex')}`) })
  assert.equal(modelMetadata.format, 'png')
  assert.ok(modelMetadata.height > modelMetadata.width / 2, '模型收到的是多帧时间轴胶片条，不是 GIF 第一帧')
  assert.equal(typeof registerTool.execute, 'function')
  dispose()
  for (const off of cleanup.reverse()) if (typeof off === 'function') off()
})

test('引入上游 MIT 许可证并遵循 DSH_HOME sharp 查找', () => {
  const license = readFileSync(new URL('../lib/core-plugins/read-animation/LICENSE', import.meta.url), 'utf8')
  assert.match(license, /Copyright \(c\) 2026 NeoHotaru/)
  assert.match(readFileSync(new URL('../lib/core-plugins/read-animation/sharp.js', import.meta.url), 'utf8'), /profiles.*node_modules.*sharp/s)
})
