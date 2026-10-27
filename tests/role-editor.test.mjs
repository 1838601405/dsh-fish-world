// 角色卡编辑：站在角色卡前面，要能直接改这张卡的人设正文。
//
// 真实反馈（主人 2026-10-27）：「为什么没法编辑角色卡内容」——面板上只有下面
// 整栏那张「角色人设卡」，而且固定读写**当前**角色；每张卡自己没有入口，
// 于是主人以为角色卡不能编辑，接着提「应该再加一个编辑」。
//
// 这里锁住的是契约：入口挂在真卡上、读写都按这张卡的 id、编辑不顺手改「当前角色」。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const UI = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')
const CSS = readFileSync(join(ROOT, 'ui', 'panel.css'), 'utf8')
const HTTP = readFileSync(join(ROOT, 'lib', 'http.mjs'), 'utf8')
const PREVIEW = readFileSync(join(ROOT, 'scripts', 'preview-ui.mjs'), 'utf8')

test('每张真角色卡都带「编辑」，「跟随挂件」不带', () => {
  assert.match(UI, /ghostButton\('编辑'/, '角色卡操作行要有「编辑」')
  // 操作行整块只挂在 option.real 上：跟着挂件是虚拟项，没有可编辑的正文。
  const at = UI.indexOf("option.real ? h('div', { class: 'fw-role-actions' }")
  assert.ok(at > 0, '没找到角色卡操作行，结构该跟着改了')
  const body = UI.slice(at, UI.indexOf(']) : null', at))
  assert.match(body, /ghostButton\('编辑'/)
  assert.match(body, /openRoleEditor\(option\)/)
})

test('编辑层按这张卡的 id 取正文，保存带着同一个 roleId', () => {
  assert.match(UI, /function openRoleEditor\(role\)/)
  assert.match(UI, /\/dsh-fish-world\/fish\/persona\?role=' \+ encodeURIComponent\(roleId\)/)
  const at = UI.indexOf('function openRoleEditor(role)')
  const body = UI.slice(at, UI.indexOf('// 换图：', at))
  assert.match(body, /postJSON\('\/dsh-fish-world\/fish\/persona', \{ roleId: roleId, text: text \}\)/)
  // 「编辑」不等于「启用」：编辑层不许顺手改「当前角色」，否则点一下编辑就把卡切了。
  assert.equal(body.includes("postJSON('/dsh-fish-world/fish/profile'"), false, '编辑层不该改当前角色')
})

test('后端两条路都真的支持按角色取 / 存（不然面板按 id 请求会落回当前角色）', () => {
  assert.match(HTTP, /searchParams\.get\('role'\)/)
  assert.match(HTTP, /body\.roleId \|\| fishRoles\.current\(\)\.id/)
})

test('预览里也有角色卡与正文，否则「编辑」在预览里永远看不见', () => {
  assert.match(PREVIEW, /roles: \[\s*\{ id: 'default'/, '预览缺角色卡，编辑入口验不出来')
  assert.match(PREVIEW, /path === '\/dsh-fish-world\/fish\/persona'/, '预览缺人设卡写入，保存那一步验不出来')
})

test('编辑层样式走语义 token（遮罩不许写裸色值）', () => {
  assert.match(CSS, /\.fw-role-editor-layer \{[^}]*background: var\(--bg-scrim\)/)
  assert.match(CSS, /\.fw-role-editor-area/)
})
