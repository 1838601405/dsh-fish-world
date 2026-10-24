import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SandboxError, createSandbox } from '../lib/sandbox.mjs'

function tank() {
  const home = mkdtempSync(join(tmpdir(), 'fw-tank-'))
  const sandbox = createSandbox({ home })
  sandbox.ensureRoot()
  return { home, sandbox, root: sandbox.root() }
}

test('sandbox allows ordinary relative paths inside the tank', () => {
  const { sandbox, root } = tank()
  writeFileSync(join(root, 'note.txt'), 'hello')

  const file = sandbox.resolveInside('note.txt', { mustExist: true })
  assert.match(file, /note\.txt$/)
  assert.equal(sandbox.contains(file), true)

  // 未存在的写入位置也允许（父目录在箱内）
  const writeTarget = sandbox.resolveInside('sub/new.txt', { forWrite: true })
  assert.match(writeTarget, /new\.txt$/)
})

test('sandbox rejects absolute, drive, UNC and protocol paths', () => {
  const { sandbox } = tank()

  for (const bad of [
    'C:\\Windows\\System32\\config\\SAM',
    'C:/Users/secret.txt',
    '/etc/passwd',
    '\\\\server\\share\\file',
    'file:///etc/passwd',
    'https://example.com/x.png',
  ]) {
    assert.throws(
      () => sandbox.resolveInside(bad),
      (error) => error instanceof SandboxError || /鱼箱|路径/.test(error.message),
      `应拒绝：${bad}`,
    )
  }
})

test('sandbox rejects .. traversal in every form', () => {
  const { sandbox } = tank()
  for (const bad of ['..', '../outside.txt', 'a/../../outside.txt', 'a/b/../../../x', '..\\..\\windows']) {
    assert.throws(() => sandbox.resolveInside(bad), /跳出鱼箱|路径/)
  }
})

test('sandbox rejects symlinks that point outside the tank', () => {
  const { home, sandbox, root } = tank()
  const outside = join(home, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'secret')

  const linkPath = join(root, 'escape.txt')
  try {
    symlinkSync(join(outside, 'secret.txt'), linkPath, 'file')
  } catch {
    return // 某些环境不允许建符号链接，跳过
  }

  assert.throws(
    () => sandbox.resolveInside('escape.txt', { mustExist: true }),
    /鱼箱外|符号链接/,
  )
})

test('sandbox refuses empty paths and null bytes', () => {
  const { sandbox } = tank()
  assert.throws(() => sandbox.resolveInside(''), /不能为空/)
  assert.throws(() => sandbox.resolveInside('  '), /不能为空/)
  assert.throws(() => sandbox.resolveInside('a\0b'), /非法字符/)
})

test('sandbox reports missing files when mustExist is set', () => {
  const { sandbox } = tank()
  assert.throws(() => sandbox.resolveInside('nope.txt', { mustExist: true }), /找不到/)
  // 不要求存在时给出可写路径
  assert.ok(sandbox.resolveInside('nope.txt'))
})

test('toOneBotSegment refuses local images outside the tank', async () => {
  const { toOneBotSegment } = await import('../lib/qq.mjs')
  const { sandbox, root } = tank()

  // 箱外路径：无沙箱时一律拒绝
  assert.throws(
    () => toOneBotSegment({ type: 'image', localPath: 'C:\\Windows\\win.ini' }),
    /鱼箱未初始化|盘符/,
  )

  // 有沙箱时，箱外绝对路径也拒绝
  assert.throws(
    () => toOneBotSegment({ type: 'image', localPath: 'C:\\Windows\\win.ini' }, { sandbox }),
    /盘符|绝对路径/,
  )

  // 箱内文件放行
  writeFileSync(join(root, 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const seg = toOneBotSegment({ type: 'image', localPath: 'ok.png' }, { sandbox })
  assert.equal(seg.type, 'image')
  assert.match(seg.data.file, /^base64:\/\//)

  // 内部可信路径（插件自己的文件）不受限
  const external = join(root, '..', 'plugin-owned.png')
  writeFileSync(external, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const trusted = toOneBotSegment({ type: 'image', localPath: external }, { sandbox, trusted: true })
  assert.match(trusted.data.file, /^base64:\/\//)
})

test('sandbox root is a dedicated directory, not the workspace', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-tank-root-'))
  const sandbox = createSandbox({ home })
  const root = sandbox.root()
  assert.match(root, /fish-tank$/, '鱼箱必须是独立的 fish-tank 目录')
  assert.notEqual(root, home)
  assert.equal(sandbox.describe().exists, false, '未初始化前不存在')
  sandbox.ensureRoot()
  assert.equal(sandbox.describe().exists, true)
})
