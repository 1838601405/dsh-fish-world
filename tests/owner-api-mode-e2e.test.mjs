import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldStore } from '../lib/world.mjs'
import { createQQ } from '../lib/qq.mjs'

// 端到端：只填主人 QQ、会话留空 → 真的保存成功，并按 api 模式返回。
// 不是读源码，是真调 setOwner。
test('端到端：只填主人 QQ、会话留空 → 保存成功 + mode=api + 号已写进桥', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-apimode-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-apimode-'))
  const first = 'session-api-1'
  const bridgeFile = join(home, 'qq-bridge-config.json')
  writeFileSync(
    bridgeFile,
    JSON.stringify({ 私聊QQ: '10000001', 目标会话: first, 群号: '20002', NapCat: 'http://127.0.0.1:3000' }),
    'utf8'
  )

  const services = (ids) => ({
    registry: { list: () => [{ path: workspace, sessionIds: ids }] },
    sessions: { get: (id) => (ids.includes(id) ? { id, cwd: workspace } : null), list: () => ids.map((id) => ({ id })) },
    agents: { list: () => [], get: () => null },
  })
  const world = createWorldStore({ home, qq: createQQ({ home }) })
  world.setServices(services([first]))

  // ★ 核心：会话留空，不抛错
  let result = null
  assert.doesNotThrow(() => {
    result = world.setOwner({ privateQQ: '1838601405', targetSession: '' })
  }, '只填 QQ、不选会话必须能保存')

  assert.equal(result.mode, 'api', '没会话就是 api 模式')
  assert.equal(result.workspace, false, '没会话时不重绑工作区')

  // 桥真的写进去了（号认了、会话清空）
  const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8'))
  assert.equal(bridge.私聊QQ, '1838601405', '主人号已写进桥')
  assert.equal(bridge.目标会话, '', '桥里的会话已清空')
  assert.equal(bridge.群号, '20002', '桥的其它字段原样保留')

  // 世界设置里的影子也跟着走
  const cfg = JSON.parse(readFileSync(join(workspace, '鱼的世界', '世界设置.json'), 'utf8'))
  assert.equal(String(cfg.ownerQQ), '1838601405', '世界设置的 ownerQQ 跟过来了')
})

test('端到端：选了会话 → mode=session（行为不变）', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-sessmode-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-sessmode-'))
  const sid = 'session-sess-1'
  writeFileSync(
    join(home, 'qq-bridge-config.json'),
    JSON.stringify({ 私聊QQ: '', 目标会话: '', NapCat: 'http://127.0.0.1:3000' }),
    'utf8'
  )
  const services = {
    registry: { list: () => [{ path: workspace, sessionIds: [sid] }] },
    sessions: { get: (id) => (id === sid ? { id, cwd: workspace } : null), list: () => [{ id: sid }] },
    agents: { list: () => [], get: () => null },
  }
  const world = createWorldStore({ home, qq: createQQ({ home }) })
  world.setServices(services)
  const result = world.setOwner({ privateQQ: '1838601405', targetSession: sid })
  assert.equal(result.mode, 'session')
  assert.equal(result.workspace, true, '有会话就要重绑工作区')
})

test('端到端：死会话仍然拒绝（这条不能放松）', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-dead2-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-dead2-'))
  const sid = 'session-alive'
  writeFileSync(
    join(home, 'qq-bridge-config.json'),
    JSON.stringify({ 私聊QQ: '', 目标会话: sid }),
    'utf8'
  )
  const services = {
    registry: { list: () => [{ path: workspace, sessionIds: [sid] }] },
    sessions: { get: (id) => (id === sid ? { id, cwd: workspace } : null), list: () => [{ id: sid }] },
    agents: { list: () => [], get: () => null },
  }
  const world = createWorldStore({ home, qq: createQQ({ home }) })
  world.setServices(services)
  assert.throws(
    () => world.setOwner({ targetSession: 'session-gone' }),
    /已经不存在/,
    '给了会话但它不存在 → 必须拒（那才是真错）'
  )
})
