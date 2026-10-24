import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_SOURCES, LINK_KINDS, createLinkLibrary, validateLinkUrl } from '../lib/links.mjs'

function fresh(limit = 10) {
  const home = mkdtempSync(join(tmpdir(), 'fw-links-'))
  const lib = createLinkLibrary({ home, config: () => ({ linkLibrary: { hourlyLimit: limit } }) })
  return { home, lib }
}

test('default source is StyleKit', () => {
  assert.equal(DEFAULT_SOURCES.length >= 1, true)
  const stylekit = DEFAULT_SOURCES.find((item) => item.id === 'stylekit')
  assert.ok(stylekit)
  assert.equal(stylekit.url, 'https://www.stylekit.top/zh/styles')
})

test('link url validation rejects local, private and non-http targets', () => {
  assert.equal(validateLinkUrl('https://www.stylekit.top/zh/styles/bento-grid').ok, true)
  assert.equal(validateLinkUrl('http://example.com/a').ok, true)

  for (const bad of [
    '',
    'not-a-url',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'http://127.0.0.1/x',
    'http://localhost:3000/x',
    'http://192.168.1.5/x',
    'http://10.0.0.1/x',
    'http://172.16.0.1/x',
    'http://server.local/x',
  ]) {
    const result = validateLinkUrl(bad)
    assert.equal(result.ok, false, `应拒绝：${bad}`)
  }
})

test('collecting a link records kind, tags and host', () => {
  const { lib } = fresh()
  const saved = lib.add({
    url: 'https://www.stylekit.top/zh/styles/bento-grid',
    title: 'Bento Grid',
    note: '不规则网格',
    tags: ['bento', '布局', 'bento'],
    kind: 'design',
    source: 'stylekit',
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.item.host, 'www.stylekit.top')
  assert.equal(saved.item.kind, 'design')
  assert.deepEqual(saved.item.tags, ['bento', '布局'], '标签去重')
  assert.equal(saved.item.title, 'Bento Grid')
})

test('the same url is not collected twice', () => {
  const { lib } = fresh()
  lib.add({ url: 'https://example.com/a' })
  assert.throws(() => lib.add({ url: 'https://example.com/a' }), /已经收过了/)
})

test('unknown link kinds fall back to other instead of being stored raw', () => {
  const { lib } = fresh()
  const saved = lib.add({ url: 'https://example.com/b', kind: '恶意类型' })
  assert.equal(saved.item.kind, 'other')
  assert.equal(LINK_KINDS.includes(saved.item.kind), true)
})

test('hourly quota limits how many links can be collected', () => {
  const { lib } = fresh(2)
  lib.add({ url: 'https://example.com/1' })
  lib.add({ url: 'https://example.com/2' })
  assert.throws(() => lib.add({ url: 'https://example.com/3' }), /额度已用完/)
  assert.equal(lib.summary().remainingThisHour, 0)
})

test('list filters by query and kind, newest first', () => {
  const { lib } = fresh()
  lib.add({ url: 'https://a.example.com/1', title: '布局参考', kind: 'design', tags: ['bento'] })
  lib.add({ url: 'https://b.example.com/2', title: '一个工具', kind: 'tool' })

  assert.equal(lib.list({ kind: 'design' }).length, 1)
  assert.equal(lib.list({ query: 'bento' }).length, 1)
  assert.equal(lib.list({ query: '工具' }).length, 1)
  // 最新在前
  assert.match(lib.list()[0].url, /b\.example\.com/)
})

test('remove and update work on a stored link', () => {
  const { lib } = fresh()
  const saved = lib.add({ url: 'https://example.com/x', title: '原标题' })

  const updated = lib.update(saved.item.id, { title: '新标题', tags: ['新标签'], kind: 'tool' })
  assert.equal(updated.item.title, '新标题')
  assert.deepEqual(updated.item.tags, ['新标签'])
  assert.equal(updated.item.kind, 'tool')

  const removed = lib.remove(saved.item.id)
  assert.equal(removed.ok, true)
  assert.equal(lib.summary().total, 0)
  assert.equal(lib.remove('nope').ok, false)
})

test('summary reports counts and per-kind breakdown', () => {
  const { lib } = fresh()
  lib.add({ url: 'https://example.com/1', kind: 'design' })
  lib.add({ url: 'https://example.com/2', kind: 'design' })
  lib.add({ url: 'https://example.com/3', kind: 'tool' })

  const summary = lib.summary()
  assert.equal(summary.total, 3)
  assert.equal(summary.byKind.design, 2)
  assert.equal(summary.byKind.tool, 1)
  assert.ok(summary.dir.includes('fish-world-links'))
  assert.ok(summary.kinds.some((kind) => kind.id === 'design' && kind.code === 'A'))
})

test('every site gets a category number like A-01, numbered per category', () => {
  const { lib } = fresh()
  const first = lib.add({ url: 'https://example.com/a', kind: 'design' })
  const second = lib.add({ url: 'https://example.com/b', kind: 'design' })
  const tool = lib.add({ url: 'https://example.com/c', kind: 'tool' })

  assert.equal(first.item.no, 'A-01')
  assert.equal(second.item.no, 'A-02')
  assert.equal(tool.item.no, 'C-01')

  // 改分类会换编号：排到新分类队尾，旧编号不复活
  const moved = lib.update(first.item.id, { kind: 'tool' })
  assert.equal(moved.item.no, 'C-02')
  assert.equal(moved.item.kind, 'tool')
})

test('a readable 网站清单.md is written next to links.json', () => {
  const { lib } = fresh()
  lib.add({ url: 'https://example.com/a', title: '便当盒布局', kind: 'design', tags: ['bento'] })
  const manifest = lib.manifestFile()
  assert.ok(existsSync(manifest), '应生成 网站清单.md')
  const text = readFileSync(manifest, 'utf8')
  assert.match(text, /# 鱼的网站收藏/)
  assert.match(text, /## 设计/)
  assert.match(text, /A-01/)
  assert.match(text, /便当盒布局/)
})
