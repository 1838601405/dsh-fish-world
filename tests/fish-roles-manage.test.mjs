// 角色卡：面板要能新建、换图、置顶、删除、设为当前。
//
// 主人 2026-10-27：「既然有保存角色卡就该有更换角色卡」——
// 以前 panel 只能从「已有的角色」里挑，而角色从哪来没有任何入口，
// 只能手改 fish-world-roles 目录。这条测试锁住那套增删改的能力。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFishRoles } from '../lib/fish-roles.mjs'
import { buildRoutes } from '../lib/http.mjs'

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'fish-roles-'))
  const roles = createFishRoles({ home, logger: { info() {} } })
  return { home, roles }
}

// 1x1 PNG：最小的合法图片，用来验证「按文件头判定格式」
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('角色卡：能新建，名字为空要拒绝', () => {
  const { roles } = fresh()
  const role = roles.create('蓝鲸娘')
  assert.equal(role.name, '蓝鲸娘')
  assert.ok(role.id)
  assert.ok(roles.list().some((r) => r.id === role.id))
  assert.throws(() => roles.create('  '), /不能为空/, '空名字不该建出一个无名角色')
})

test('角色卡：换了图能取到，换格式时旧文件会被清掉（不并存两份）', () => {
  const { roles } = fresh()
  const role = roles.create('测试角色')
  const saved = roles.saveImageData(role.id, { dataUrl: 'data:image/png;base64,' + PNG_1PX })
  assert.equal(saved.ok, true)
  assert.equal(saved.format, 'png')
  const image = roles.imageFor(role.id)
  assert.ok(image.path && existsSync(image.path), '图片要真的落盘')
  assert.ok(readFileSync(image.path).length > 0)
  // 删图之后取不到
  roles.removeImage(role.id)
  assert.equal(roles.imageFor(role.id).path, '', '删掉后不该还能取到旧图')
})

test('角色卡：乱传的图片要拒绝，不能悄悄存成坏文件', () => {
  const { roles } = fresh()
  const role = roles.create('测试角色')
  assert.throws(() => roles.saveImageData(role.id, { dataUrl: 'data:image/png;base64,bm90LWFuLWltYWdl' }), /PNG|JPEG|GIF|WebP/)
  assert.throws(() => roles.saveImageData(role.id, { dataUrl: 'not-a-data-url' }), /格式不对/)
  assert.throws(() => roles.saveImageData('no-such-role', { dataUrl: 'data:image/png;base64,' + PNG_1PX }), /没有这个角色/)
})

test('角色卡：能设为当前、能置顶、能删除，默认角色删不掉', () => {
  const { roles } = fresh()
  const role = roles.create('甲')
  roles.setCurrent(role.id)
  assert.equal(roles.current().id, role.id)
  const pinned = roles.pin(role.id, true)
  assert.equal(pinned.pinned, true)
  roles.pin(role.id, false)
  // list() 给的是原始条目（pinnedAt），装饰后的 pinned 在 summary() 里
  assert.equal(roles.summary().roles.find((r) => r.id === role.id).pinned, false)
  assert.throws(() => roles.remove('default'), /默认角色不能删/)
  roles.remove(role.id)
  assert.equal(roles.list().some((r) => r.id === role.id), false)
  assert.equal(roles.current().id, 'default', '删掉当前角色后要回到默认，不能悬空')
})

test('角色卡：路由发出去的是装饰后的角色（面板读 pinned，不是 pinnedAt）', () => {
  // 真实翻车点：/fish/profile 原来发 fishRoles.list()（原始条目，字段是 pinnedAt），
  // 而面板读的是 role.pinned —— 于是「置顶」徽标在真实环境里永远不亮。
  // 预览的假数据用的是 pinned，所以预览看不出来。这条断言把两边的形状钉住。
  const { roles } = fresh()
  const role = roles.create('置顶测试')
  roles.pin(role.id, true)
  const http = readFileSync(join(import.meta.dirname, '..', 'lib', 'http.mjs'), 'utf8')
  const sent = http.match(/roles:\s*fishRoles\.[^,\n]+/g) || []
  assert.ok(sent.length > 0, '找不到路由里发 roles 的地方')
  const raw = sent.filter((s) => /fishRoles\.list\(\)/.test(s))
  assert.deepEqual(raw, [], '路由不许发 list()（原始条目 pinnedAt），要发 summary().roles：' + raw.join(' / '))
  assert.ok(sent.every((s) => /summary\(\)\.roles/.test(s)), '路由发的角色形状不对：' + sent.join(' / '))
  // 面板确实读 pinned：两边必须对上
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  assert.match(panel, /role\.pinned/, '面板读 pinned，路由就得给 pinned')
})

test('角色卡：h() 把 on* 函数绑成监听器，不写进内联属性', () => {
  // 内联事件属性会被浏览器当代码解析，函数声明会报「Function statements require a
  // function name」，而且被 CSP 拦。曾发生在「当前角色卡」的 img onerror 上。
  const panel = readFileSync(join(import.meta.dirname, '..', 'ui', 'panel.js'), 'utf8')
  // 用字符串比对，不拿正则去匹配含 / 与 \ 的源码，省得两边转义打架。
  const line = panel.split('\n').find((l) => l.includes("typeof v === 'function'"))
  assert.ok(line, 'h() 里必须对函数值做特判')
  assert.ok(line.includes('addEventListener'), '函数值要绑成监听器：' + line.trim())
  // 按 on* 属性名识别，而不是把所有函数值都当监听器（那样 style 之类的回调会被误绑）
  assert.ok(line.includes('/^on[a-z]+$/'), '要按 on* 属性名识别事件：' + line.trim())
  assert.ok(line.includes('k.slice(2)'), '事件名要去掉 on 前缀：' + line.trim())
})

test('角色卡：HTTP 路由把增删改都接上了（面板点得到）', () => {
  const routes = buildRoutes({})
  const route = routes.find((r) => r.path === '/dsh-fish-world/fish/roles')
  assert.ok(route, '/fish/roles 路由必须存在，否则面板上的按钮没有落点')
  assert.equal(typeof route.handler, 'function')
})
