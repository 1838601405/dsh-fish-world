// QQ 空间配图的判据（2026-11-22 主人方案 P4）。
//
// ★ 这份的特殊之处：**上游结构未验证**。2026-11-22 真机问协议端
//   `get_qzone_feeds`，确认有 `images` 字段、类型是 array，但本机唯一那条动态
//   是空数组 —— 元素长什么样看不到。所以这里对**三种可能的元素形态**都下判据，
//   保证无论上游是哪种都不丢图；等有真带图的动态，回来把范围收窄。
//
// 其余验：过滤垃圾、上限、不影响既有字段（content/likes/comments 一个都不能少）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { __test } from '../lib/qzone.mjs'

const { feedImages, normalizeFeed } = __test

const UIN = 23456789
const TID = '0123456789abcdef01234567'

function row(over = {}) {
  return {
    uin: UIN,
    tid: TID,
    time: 1792771200,
    content: '一条动态',
    nickname: '朋友',
    like_count: 1,
    comment_count: 2,
    ...over
  }
}

// ══════════ ★★ 三种可能的元素形态都不能丢图 ══════════

test('★★ 形态A：元素是裸 url 字符串', () => {
  const urls = feedImages({ images: ['https://例子.test/a.jpg', 'https://例子.test/b.png'] })
  assert.deepEqual(urls, ['https://例子.test/a.jpg', 'https://例子.test/b.png'])
})

test('★★ 形态B：元素是 {url} 对象', () => {
  const urls = feedImages({ images: [{ url: 'https://例子.test/a.jpg' }, { url: 'https://例子.test/b.png' }] })
  assert.deepEqual(urls, ['https://例子.test/a.jpg', 'https://例子.test/b.png'])
})

test('★★ 形态C：元素是 {pic} / {src} 等别的字段名 —— 也要认出来', () => {
  // 真机没看到结构，所以这几种都得接住，不能因为猜错字段名就把配图整条丢掉
  const got = feedImages({
    images: [
      { pic: 'https://例子.test/pic.jpg' },
      { src: 'https://例子.test/src.jpg' },
      { image: 'https://例子.test/img.jpg' },
      { big: 'https://例子.test/big.jpg' },
      { original: 'https://例子.test/orig.jpg' }
    ]
  })
  assert.equal(got.length, 5, '★ 五种字段名都要认出来')
  assert.ok(got.every((u) => u.startsWith('https://')))
})

// ══════════ 过滤垃圾 ══════════

test('★ 非 http(s) 的一律丢掉（不放进上下文的地址）', () => {
  const urls = feedImages({
    images: [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'ftp://例子.test/a.jpg',
      '/相对路径.jpg',
      '',
      null,
      undefined,
      'https://例子.test/ok.jpg'
    ]
  })
  assert.deepEqual(urls, ['https://例子.test/ok.jpg'])
})

test('★ 对象里没有任何像地址的字段 → 跳过，不塞 undefined', () => {
  const urls = feedImages({ images: [{ foo: 1 }, { bar: '不是地址' }, 42, true] })
  assert.deepEqual(urls, [])
})

test('★ 不是数组（null / 对象 / 字符串）→ 空数组，不炸', () => {
  assert.deepEqual(feedImages({}), [])
  assert.deepEqual(feedImages({ images: null }), [])
  assert.deepEqual(feedImages({ images: 'https://例子.test/a.jpg' }), [])
  assert.deepEqual(feedImages({ images: { url: 'https://例子.test/a.jpg' } }), [])
  assert.deepEqual(feedImages(null), [])
})

// ══════════ 上限 ══════════

test('★ 一次最多 9 张（空间一发动态最多九图）', () => {
  const many = Array.from({ length: 20 }, (_, i) => `https://例子.test/${i}.jpg`)
  assert.equal(feedImages({ images: many }).length, 9)
})

// ══════════ ★★ 不许因为新增字段破坏既有归一 ══════════

test('★★ 既有字段一个都不能少（content/likes/comments/nickname/at）', () => {
  const f = normalizeFeed(row())
  assert.ok(f, '要能归一')
  assert.equal(f.content, '一条动态')
  assert.equal(f.likes, 1)
  assert.equal(f.comments, 2)
  assert.equal(f.nickname, '朋友')
  assert.equal(f.at, 1792771200 * 1000)
  assert.equal(f.uin, String(UIN))
  assert.equal(f.tid, TID)
})

test('★★ 带图的动态照样归一，images 一并带出来', () => {
  const f = normalizeFeed(row({ images: ['https://例子.test/x.jpg'] }))
  assert.ok(f)
  assert.equal(f.content, '一条动态', '★ 加了 images 不许影响 content')
  assert.deepEqual(f.images, ['https://例子.test/x.jpg'])
})

test('★★ 没图的动态 images 是空数组（不是 undefined —— 下游不用判空）', () => {
  const f = normalizeFeed(row())
  assert.ok(Array.isArray(f.images), '★ 必须是数组')
  assert.deepEqual(f.images, [])
})

test('★ 归不出来（缺 tid / 没内容）仍然返回 null，行为不变', () => {
  assert.equal(normalizeFeed({ uin: UIN, content: 'x' }), null, '缺 tid')
  assert.equal(normalizeFeed({ tid: TID, content: 'x' }), null, '缺 uin')
  assert.equal(normalizeFeed(row({ content: '', html: '' })), null, '没内容')
})

// ══════════ 真机对齐 ══════════

test('★ 真机字段名都在（uin/nickname/time/tid/content/images/like_count/comment_count）', () => {
  // 这些是 2026-11-22 真机问 get_qzone_feeds 拿到的字段名，别改回去
  const real = {
    uin: 457310173,
    nickname: '某人',
    time: 1792662480,
    tid: 'ddff411bd0dbd96a889f0500',
    content: '一条动态',
    images: [],
    like_count: 3,
    comment_count: 4,
    html: '<div>兜底用</div>'
  }
  const f = normalizeFeed(real)
  assert.ok(f, '真机形状要能归一')
  assert.equal(f.likes, 3)
  assert.equal(f.comments, 4)
  assert.deepEqual(f.images, [])
})
