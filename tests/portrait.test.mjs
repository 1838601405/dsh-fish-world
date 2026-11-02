import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bandOf, createPortrait, dominantEmotion, pickStickerForEmotion } from '../lib/portrait.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-portrait-'))
  return { home, portrait: createPortrait({ home }) }
}

test('mood bands map the score to five levels', () => {
  assert.equal(bandOf(95), 'great')
  assert.equal(bandOf(80), 'great')
  assert.equal(bandOf(70), 'good')
  assert.equal(bandOf(50), 'ok')
  assert.equal(bandOf(35), 'low')
  assert.equal(bandOf(10), 'bad')
  assert.equal(bandOf(NaN), 'neutral')
})

test('dominant emotion prefers positive dims and needs a floor', () => {
  // 82 开心 vs 70 难过：正面维度权重高，选开心
  assert.equal(dominantEmotion(81, [
    { key: 'happy', value: 82 },
    { key: 'sad', value: 70 },
  ]), 'happy')

  // 只有低分负面维度时，回落到总分档位
  assert.equal(dominantEmotion(40, [{ key: 'sad', value: 10 }]), 'low')

  // 维度全空时用档位
  assert.equal(dominantEmotion(85, []), 'great')
  assert.equal(dominantEmotion(null, null), 'neutral')
})

test('without custom images the portrait falls back to the role image plus a filter', () => {
  const { portrait } = fresh()
  const result = portrait.resolve({
    mood: 81,
    dims: [{ key: 'happy', value: 82 }],
    role: { avatar: '/dsh-whale/image.png', displayName: '泡泡' },
  })
  assert.equal(result.source, 'role')
  assert.equal(result.imageUrl, '/dsh-whale/image.png')
  assert.match(result.filter, /saturate/)
  assert.equal(result.emotionLabel, '开心')
  assert.equal(result.displayName, '泡泡')
  assert.deepEqual(result.available, [])
})

test('custom mood images take priority over the role image', () => {
  const { home, portrait } = fresh()
  const dir = join(home, 'fish-world-moods')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sad.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const result = portrait.resolve({
    mood: 20,
    dims: [{ key: 'sad', value: 70 }],
    role: { avatar: '/role.png', displayName: '鱼' },
  })
  assert.equal(result.emotion, 'sad')
  assert.equal(result.source, 'custom')
  assert.match(result.imageUrl, /mood-image\?name=sad/)
  assert.equal(result.filter, 'none', '用专属情绪图时不再叠加滤镜')
  assert.deepEqual(result.available, ['sad'])
  assert.match(result.note, /情绪图/)
})

test('portrait dir points at its own folder and lists nothing when absent', () => {
  const { home, portrait } = fresh()
  assert.match(portrait.dir(), /fish-world-moods$/)
  assert.notEqual(portrait.dir(), home)
  assert.deepEqual(portrait.customImages(), {}, '目录不存在时安静返回空')
})

test('users can upload their own portrait and it becomes the custom source', () => {
  const { portrait } = fresh()
  // 最小合法 PNG（1x1）
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    + '1f15c4890000000a49444154789c6300010000050001',
    'hex',
  )

  const saved = portrait.saveImage('happy', { bytes: png })
  assert.equal(saved.ok, true)
  assert.equal(saved.format, 'png')
  assert.equal(saved.emotion, 'happy')

  const found = portrait.customImages()
  assert.equal(found.happy.file, 'happy.png')

  // 上传后 resolve 应该用自定义图，不再叠滤镜
  const result = portrait.resolve({
    mood: 81,
    dims: [{ key: 'happy', value: 82 }],
    role: { avatar: '/role.png' },
  })
  assert.equal(result.source, 'custom')
  assert.equal(result.filter, 'none')

  // 移除后回到角色图
  const removed = portrait.removeImage('happy')
  assert.equal(removed.ok, true)
  assert.deepEqual(portrait.customImages(), {})
  assert.equal(portrait.resolve({ mood: 81, dims: [{ key: 'happy', value: 82 }] }).source, 'role')
})

test('upload rejects unknown emotions and non-image bytes', () => {
  const { portrait } = fresh()
  const png = Buffer.from('89504e470d0a1a0a', 'hex')

  assert.throws(() => portrait.saveImage('furious', { bytes: png }), /不支持的情绪名称/)
  assert.throws(() => portrait.saveImage('happy', { bytes: Buffer.from('hello world') }), /只支持 PNG/)
  assert.throws(() => portrait.saveImage('happy', { bytes: Buffer.alloc(0) }), /图片内容为空/)

  const huge = Buffer.alloc(9 * 1024 * 1024, 1)
  huge[0] = 0x89; huge[1] = 0x50; huge[2] = 0x4e; huge[3] = 0x47
  assert.throws(() => portrait.saveImage('sad', { bytes: huge }), /超过/)
})

test('upload detects real format from bytes rather than trusting the name', () => {
  const { portrait } = fresh()
  const gif = Buffer.from('GIF89a' + '0'.repeat(20), 'ascii')
  const saved = portrait.saveImage('calm', { bytes: gif })
  assert.equal(saved.format, 'gif', '文件头是 GIF 就按 gif 存，不看扩展名')
  assert.equal(portrait.customImages().calm.file, 'calm.gif')

  // 同一情绪换格式时，旧格式会被清掉，避免两份并存
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  portrait.saveImage('calm', { bytes: png })
  const files = Object.values(portrait.customImages()).filter((v) => v.file.startsWith('calm'))
  assert.equal(files.length, 1, '同一情绪只应保留一份')
  assert.equal(files[0].ext, 'png')
})

test('only whitelisted emotion filenames are picked up', () => {  const { home, portrait } = fresh()
  const dir = join(home, 'fish-world-moods')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'happy.png'), Buffer.from([1]))
  writeFileSync(join(dir, 'notes.txt'), 'ignore')
  writeFileSync(join(dir, 'evil.svg'), '<svg/>')

  const found = portrait.customImages()
  assert.deepEqual(Object.keys(found), ['happy'])
})


// 2026-11-02 主人：头像要会自己从表情库里找情绪相关的图。
// 优先级：主人放的情绪图 > 表情库按标签自动挑 > 角色图 + 滤镜。
test('表情库挑选：标签完全相等 > 标签包含 > 名字包含', () => {
  const items = [
    { id: 'a', name: '随便', tags: ['开心'] },
    { id: 'b', name: '开心的鱼', tags: [] },
    { id: 'c', name: '笑一笑', tags: ['微笑'] },
  ]
  const hit = pickStickerForEmotion(items, 'happy', { dayKey: '2026-11-02' })
  assert.equal(hit.id, 'a')
  assert.equal(hit.url, '/dsh-fish-world/sticker-image?id=a')
  assert.equal(hit.name, '随便')
})

test('表情库挑选：没有匹配就返回 null，不随便拿一张不相干的', () => {
  assert.equal(pickStickerForEmotion([{ id: 'x', name: '风景', tags: ['天空'] }], 'happy'), null)
  assert.equal(pickStickerForEmotion([], 'sad'), null)
  assert.equal(pickStickerForEmotion(null, 'sad'), null)
})

test('表情库挑选：同一天稳定，隔天能轮到另一张', () => {
  const ties = [
    { id: 'x', name: '', tags: ['笑'] },
    { id: 'y', name: '', tags: ['笑'] },
  ]
  const first = pickStickerForEmotion(ties, 'happy', { dayKey: '2026-11-02' }).id
  assert.equal(pickStickerForEmotion(ties, 'happy', { dayKey: '2026-11-02' }).id, first, '同一天不许闪')
  const ids = new Set(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']
    .map((day) => pickStickerForEmotion(ties, 'happy', { dayKey: day }).id))
  assert.equal(ids.size, 2, '几天内应该轮到两张')
})

test('没有专属情绪图时，头像自动从表情库挑', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-portrait-sticker-'))
  const stickers = {
    list: () => [
      { id: 's1', name: '开心比耶', tags: ['比耶', '开心'] },
      { id: 's2', name: '哭哭', tags: ['哭'] },
    ],
  }
  const portrait = createPortrait({
    home,
    stickers: () => stickers,
    now: () => Date.parse('2026-11-02T12:00:00+08:00'),
  })
  const r = portrait.resolve({ mood: 81, dims: [{ key: 'happy', value: 82 }], role: { avatar: '/role.png' } })
  assert.equal(r.source, 'sticker')
  assert.equal(r.imageUrl, '/dsh-fish-world/sticker-image?id=s1')
  assert.equal(r.filter, 'none', '表情图本身已经表达情绪，不再叠滤镜')
  assert.equal(r.sticker.name, '开心比耶')
  assert.match(r.note, /表情库/)
})

test('主人放的专属情绪图优先于表情库', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-portrait-priority-'))
  const dir = join(home, 'fish-world-moods')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'happy.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const portrait = createPortrait({
    home,
    stickers: () => ({ list: () => [{ id: 's1', name: '开心比耶', tags: ['开心'] }] }),
    now: () => Date.parse('2026-11-02T12:00:00+08:00'),
  })
  const r = portrait.resolve({ mood: 81, dims: [{ key: 'happy', value: 82 }] })
  assert.equal(r.source, 'custom')
  assert.match(r.imageUrl, /mood-image\?name=happy/)
})

test('表情库没匹配时退回角色图 + 滤镜', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-portrait-nomatch-'))
  const portrait = createPortrait({
    home,
    stickers: () => ({ list: () => [{ id: 'x', name: '风景', tags: ['天空'] }] }),
    now: () => Date.parse('2026-11-02T12:00:00+08:00'),
  })
  const r = portrait.resolve({ mood: 81, dims: [{ key: 'happy', value: 82 }], role: { avatar: '/role.png' } })
  assert.equal(r.source, 'role')
  assert.equal(r.imageUrl, '/role.png')
  assert.match(r.filter, /saturate/)
})


// 2026-11-02 实数据发现：mood=72 时 dominantEmotion 返回档位 good，
// 但 EMOTION_STYLE 没有 good，标签回落成「平静」，而上游显示「开心」。
test('五档兜底也有正确的中文名（与 dsh-feiyu-mood 对齐）', () => {
  const { portrait } = fresh()
  const labelOf = (mood) => portrait.resolve({ mood, dims: [], role: { avatar: '/r.png' } })
  assert.equal(labelOf(85).emotion, 'great')
  assert.equal(labelOf(85).emotionLabel, '欢喜')
  assert.equal(labelOf(72).emotionLabel, '开心')
  assert.equal(labelOf(50).emotionLabel, '一般')
  assert.equal(labelOf(30).emotionLabel, '心疼')
  assert.equal(labelOf(10).emotionLabel, '难过')
})
