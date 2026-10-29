// B 站人设同步：目标文件全部落在临时目录（targetDir 注入替身），
// 不碰真实的 ~/.bili-ai/persona.md —— 那是 bili-whale 正在读的文件。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBiliPersonaSync } from '../lib/bili-persona-sync.mjs'

const PERSONA_TEXT = '你是一条大肥鱼，说话像人，不许写成 AI。'

function fakePersonaStore(text = PERSONA_TEXT) {
  return {
    get: (roleId) => ({ roleId, text }),
    current: () => ({ id: 'default' }),
  }
}

function tempTarget() {
  return mkdtempSync(join(tmpdir(), 'fw-bili-persona-'))
}

test('未安装 dsh-bili-whale：sync 拒绝并如实说原因，status 报 installed=false', async () => {
  const target = tempTarget()
  const sync = createBiliPersonaSync({
    personaStore: fakePersonaStore(),
    locate: () => ({ found: false, path: '' }),
    targetDir: target,
  })
  const result = await sync.sync()
  assert.equal(result.ok, false)
  assert.match(result.error, /未安装 dsh-bili-whale/)
  const st = sync.status()
  assert.equal(st.installed, false)
  assert.equal(st.syncedAt, '')
  assert.equal(existsSync(join(target, 'persona.md')), false, '没装就不该写文件')
  rmSync(target, { recursive: true, force: true })
})

test('正常写入：UTF-8 无 BOM，正文与人设一致，返回字节数', async () => {
  const target = tempTarget()
  const sync = createBiliPersonaSync({
    personaStore: fakePersonaStore(),
    locate: () => ({ found: true, path: '/somewhere/dsh-bili-whale' }),
    targetDir: target,
  })
  const result = await sync.sync()
  assert.equal(result.ok, true)
  assert.ok(result.bytes > 0)
  assert.equal(result.path, join(target, 'persona.md'))
  const raw = readFileSync(join(target, 'persona.md'))
  assert.notEqual(raw[0], 0xef, '第一个字节不能是 BOM（EF BB BF）')
  assert.equal(raw.toString('utf8'), PERSONA_TEXT)
  rmSync(target, { recursive: true, force: true })
})

test('目录不存在时自动创建（~/.bili-ai 还没建过的全新环境）', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'fw-bili-parent-'))
  const target = join(parent, '.bili-ai')
  const sync = createBiliPersonaSync({
    personaStore: fakePersonaStore(),
    locate: () => ({ found: true, path: '/somewhere' }),
    targetDir: target,
  })
  const result = await sync.sync()
  assert.equal(result.ok, true)
  assert.ok(existsSync(join(target, 'persona.md')), '目录与文件都要建出来')
  rmSync(parent, { recursive: true, force: true })
})

test('sameAsCurrent：文件与人设一致才是 true；人设改过就是 false', async () => {
  const target = tempTarget()
  let text = PERSONA_TEXT
  const store = {
    get: () => ({ text }),
    current: () => ({ id: 'default' }),
  }
  const sync = createBiliPersonaSync({
    personaStore: store,
    locate: () => ({ found: true, path: '/somewhere' }),
    targetDir: target,
  })
  await sync.sync()
  assert.equal(sync.status().sameAsCurrent, true)
  // 人设改了：文件还是旧的 → 不同步。
  text = PERSONA_TEXT + '\n改了一句。'
  assert.equal(sync.status().sameAsCurrent, false)
  // 再同步一次：追上来了。
  await sync.sync()
  assert.equal(sync.status().sameAsCurrent, true)
  rmSync(target, { recursive: true, force: true })
})

test('空人设：不同步，也不写空文件过去', async () => {
  const target = tempTarget()
  const sync = createBiliPersonaSync({
    personaStore: fakePersonaStore(''),
    locate: () => ({ found: true, path: '/somewhere' }),
    targetDir: target,
  })
  const result = await sync.sync()
  assert.equal(result.ok, false)
  assert.match(result.error, /人设/)
  assert.equal(existsSync(join(target, 'persona.md')), false)
  rmSync(target, { recursive: true, force: true })
})

test('写入失败如实报错（目录只读/磁盘错），不抛异常不假成功', async () => {
  const target = tempTarget()
  const sync = createBiliPersonaSync({
    personaStore: fakePersonaStore(),
    locate: () => ({ found: true, path: '/somewhere' }),
    targetDir: target,
  })
  // 把 persona.md 变成一个目录：writeFileSync 会对它报错（Windows/Linux 都如此）。
  mkdirSync(join(target, 'persona.md'))
  const result = await sync.sync()
  assert.equal(result.ok, false)
  assert.ok(result.error, '要把错误原因带回来')
  rmSync(target, { recursive: true, force: true })
})

test('保存人设会触发自动同步：http 面的 fish/persona 保存路径里接了 sync（接线断不得）', () => {
  const http = readFileSync(join(import.meta.dirname, '..', 'lib', 'http.mjs'), 'utf8')
  const start = http.indexOf('const fishPersona = {')
  const end = http.indexOf('// B 站人设同步：GET', start)
  const block = http.slice(start, end)
  // 保存成功后异步旁路同步：失败只进日志，不影响保存本身（所以是 void + catch，不 await）。
  assert.match(block, /biliPersonaSync\?\.\s*sync\?\.\(\)/)
  assert.match(block, /void Promise\.resolve/)
  // buildRoutes 必须能拿到这个模块：形参里有它。
  assert.match(http.slice(0, http.indexOf('const prefix')), /biliPersonaSync/)
})

test('同步失败不影响人设保存本身：sync 是异步旁路，不挡 reply', async () => {
  // 直接调一个会失败的 sync（未安装），确认它返回结果对象而不是抛异常 ——
  // 这样 http 里的 `void Promise.resolve(sync())` 无论结果如何都不会打断保存。
  const target = tempTarget()
  const sync = createBiliPersonaSync({
    personaStore: fakePersonaStore(),
    locate: () => { throw new Error('locate 坏了') },
    targetDir: target,
  })
  const result = await sync.sync()
  assert.equal(result.ok, false)
  rmSync(target, { recursive: true, force: true })
})

test('currentRoleId 注入：按当前角色取人设，不是永远读 default', async () => {
  const target = tempTarget()
  const store = {
    get: (roleId) => ({ roleId, text: roleId === 'silver' ? '银色人设' : '默认人设' }),
    current: () => ({ id: 'default' }),
  }
  const sync = createBiliPersonaSync({
    personaStore: store,
    locate: () => ({ found: true, path: '/somewhere' }),
    currentRoleId: () => 'silver',
    targetDir: target,
  })
  await sync.sync()
  assert.equal(readFileSync(join(target, 'persona.md'), 'utf8'), '银色人设')
  rmSync(target, { recursive: true, force: true })
})

test('面板接线：B 站人设行与「同步人设」按钮都在，且返回的一组行要展开塞进账号区', () => {
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  // 人设行来自 biliPersonaRows（返回数组），必须展开进去——当成单个子节点会炸 appendChild
  // （2026-10-29 浏览器实测踩过）。
  assert.match(panel, /rows\.push\.apply\(rows, biliPersonaRows\(account\.persona\)\)/)
  assert.match(panel, /function biliPersonaRows\(persona\)/)
  assert.match(panel, /postJSON\('\/dsh-fish-world\/bili-persona', \{\}\)/)
  // 每日记忆摘要卡：状态行 + 立即重建 + 开关，三条都接到 /memory-digest。
  assert.match(panel, /key: 'memory-digest'/)
  assert.match(panel, /postJSON\('\/dsh-fish-world\/memory-digest', \{ force: true \}\)/)
  assert.match(panel, /postJSON\('\/dsh-fish-world\/memory-digest', \{ enabled: next \}\)/)
  // 摘要卡读的是 loadMemoryDigest（memory / stickers 两页都要拉）。
  assert.match(panel, /function loadMemoryDigest\(\)/)
  assert.match(panel, /loadMemoryHub\(\), loadMemoryDigest\(\), loadActions\(\)/)
})
