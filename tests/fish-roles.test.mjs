// 鱼世界自己的角色数据（替代原来读 dsh-whale-widget 的 roles.json）。
//
// 这层存在的理由：以前「鱼长什么样、叫什么」全靠挂件，挂件不在就整片空；
// 而且为了合并界面还要改写它注入的脚本行。现在角色是鱼世界自己的一等数据，
// 挂件在不在，鱼都还是同一张脸、同一个名字。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFishRoles, DEFAULT_ROLE } from '../lib/fish-roles.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fw-roles-'))
  return { home, roles: createFishRoles({ home, logger: { warn() {} } }) }
}

/** 造一张 1×1 PNG，用来测「按文件头认格式」。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('全新环境就有默认角色，不该是「没有角色」', () => {
  const { roles } = fresh()
  const cur = roles.current()
  assert.equal(cur.id, 'default')
  assert.equal(cur.name, DEFAULT_ROLE.name)
  assert.equal(cur.hasImage, false, '没图就如实说没图，不伪造')
  assert.equal(cur.avatar, '', '没有图就不给 URL，别给一个 404')

  const list = roles.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'default')
})

test('新建角色、切当前、置顶排序', () => {
  const { roles } = fresh()
  const a = roles.create('蓝鲸娘')
  assert.equal(a.name, '蓝鲸娘')
  assert.ok(a.id)

  const b = roles.create('小海豚')
  assert.notEqual(b.id, a.id, 'id 不能撞')

  // 新角色排在前面（createdAt 新的在前）
  assert.equal(roles.list()[1].id, a.id)

  roles.setCurrent(a.id)
  assert.equal(roles.current().id, a.id, '切过之后 current 要跟着变')

  roles.pin(a.id, true)
  assert.equal(roles.list()[0].id, a.id, '置顶的排最前')
  assert.equal(roles.current().pinned, true)

  roles.pin(a.id, false)
  assert.equal(roles.current().pinned, false)
})

test('同名角色自动加后缀，不覆盖已有', () => {
  const { roles } = fresh()
  const first = roles.create('小明')
  const second = roles.create('小明')
  assert.notEqual(first.id, second.id)
  assert.equal(roles.list().length, 3, '默认 + 两个小明')
})

test('角色图按文件头认格式（不信扩展名），换格式清掉旧文件', () => {
  const { home, roles } = fresh()
  const role = roles.create('测试')
  const dir = join(home, 'fish-world-roles')

  // 故意存成 .txt，内容是 PNG —— 必须靠文件头认出来
  const src = join(home, 'src.txt')
  writeFileSync(src, PNG_1PX)

  const saved = roles.saveImage(role.id, src)
  assert.equal(saved.ok, true)
  assert.equal(saved.format, 'png', '按文件头认成 png，不是按扩展名 txt')

  const image = roles.imageFor(role.id)
  assert.equal(image.ext, 'png')
  assert.ok(existsSync(image.path))

  // 同一个角色再传一次：不能留下两份
  roles.saveImage(role.id, src)
  const files = readdirSync(dir).filter((n) => n.startsWith(role.id + '.'))
  assert.equal(files.length, 1, '换格式/重传之后只留一份，否则下次随机读到旧的')

  assert.match(roles.current().avatar, /dsh-fish-world\/role-image/, '头像走鱼世界自己的路由，不用挂件端点')
})

test('非图片内容被拒绝，并说清为什么', () => {
  const { home, roles } = fresh()
  const role = roles.create('测试')
  const bad = join(home, 'bad.bin')
  writeFileSync(bad, Buffer.from('this is definitely not an image at all'))
  assert.throws(() => roles.saveImage(role.id, bad), /只能是 PNG \/ JPEG \/ GIF \/ WebP/)
})

test('超限图片被拒绝', () => {
  const { home, roles } = fresh()
  const role = roles.create('测试')
  const big = join(home, 'big.png')
  // 9MB 的「PNG 头 + 填充」
  const buf = Buffer.alloc(9 * 1024 * 1024)
  PNG_1PX.copy(buf, 0)
  writeFileSync(big, buf)
  assert.throws(() => roles.saveImage(role.id, big), /超过 8MB/)
})

test('默认角色不能删；删角色顺手删它的图并把 current 退回 default', () => {
  const { home, roles } = fresh()
  assert.throws(() => roles.remove('default'), /默认角色不能删/)

  const role = roles.create('临时')
  const src = join(home, 'src.png')
  writeFileSync(src, PNG_1PX)
  roles.saveImage(role.id, src)
  roles.setCurrent(role.id)
  assert.equal(roles.current().id, role.id)

  roles.remove(role.id)
  assert.equal(roles.current().id, 'default', '删掉当前角色要退回默认，不能指向不存在的 id')
  assert.equal(existsSync(join(home, 'fish-world-roles', `${role.id}.png`)), false, '图也删掉，别留孤儿文件')
})

test('索引文件损坏时按空处理并留一条警告，不炸整个面板', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-roles-bad-'))
  const dir = join(home, 'fish-world-roles')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'roles.json'), '{ this is not json', 'utf8')

  const warns = []
  const roles = createFishRoles({ home, logger: { warn: (m) => warns.push(String(m)) } })
  const cur = roles.current()
  assert.equal(cur.id, 'default', '坏索引退回默认角色')
  assert.ok(warns.some((w) => /角色索引读不出来/.test(w)), '要如实报出来，不静默吞')
})

test('没有索引文件不算问题（全新环境本来就没有）', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-roles-none-'))
  const warns = []
  const roles = createFishRoles({ home, logger: { warn: (m) => warns.push(String(m)) } })
  assert.equal(roles.current().id, 'default')
  assert.deepEqual(warns, [], '缺文件不该报警')
})

test('summary 给面板的快照字段齐全', () => {
  const { roles } = fresh()
  roles.create('蓝鲸娘')
  const s = roles.summary()
  assert.ok(s.dir)
  assert.equal(s.count, 2)
  assert.ok(s.current && s.current.id)
  assert.equal(s.roles.length, 2)
  for (const r of s.roles) {
    assert.ok(typeof r.id === 'string')
    assert.ok(typeof r.name === 'string')
    assert.ok(typeof r.hasImage === 'boolean')
  }
})
