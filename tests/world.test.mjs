import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorldStore } from '../lib/world.mjs'

function fakeQq(ownerQQ = '1838601405', targetSession = 'session-owner-1') {
  return { bridgeConfig: () => ({ 私聊QQ: ownerQQ, 目标会话: targetSession }) }
}

function fakeServices(workspacePath, ownerSession) {
  const registry = { list: () => [{ path: workspacePath, sessionIds: [ownerSession] }] }
  const sessions = { get: () => null }
  const agents = { list: () => [], get: () => null }
  return { registry, sessions, agents }
}

test('world store binds to workspace and lays out 鱼的世界 directories', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws-'))
  const owner = 'session-owner-1'
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
  const status = world.setServices(fakeServices(workspace, owner))
  assert.equal(status.ok, true)
  const root = join(workspace, '鱼的世界')
  assert.ok(existsSync(root))
  for (const name of ['鱼的记忆', '鱼的日记', '鱼的状态', '鱼的关系', '安全与审计']) {
    assert.ok(existsSync(join(root, name)), name + ' 应存在')
  }
  assert.ok(existsSync(join(root, '鱼的状态', '生理.json')))
  assert.ok(existsSync(join(root, '鱼的关系', 'people.json')))
  assert.equal(world.status().workspacePath, workspace)
})

test('relations reject invalid QQ, cross-workspace session, and owner duplication', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home2-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws2-'))
  const owner = 'session-owner-2'
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
  world.setServices(fakeServices(workspace, owner))

  assert.throws(() => world.updateRelations([{ qqId: 'abc', name: 'x', role: 'trusted', chatKey: 'private:1', sessionId: 'session-a' }]), /QQ号无效/)
  assert.throws(() => world.updateRelations([{ qqId: '1838601405', name: 'x', role: 'trusted', chatKey: 'private:1838601405', sessionId: 'session-a' }]), /主人/)
  assert.throws(() => world.updateRelations([{ qqId: '10002', name: 'x', role: 'trusted', chatKey: 'private:10002', sessionId: 'session-elsewhere' }]), /必须属于当前工作区/)

  const ok = world.updateRelations([{ qqId: '10003', name: '阿鱼', role: 'trusted', chatKey: 'private:10003', sessionId: 'session-owner-2' }])
  assert.equal(ok.people.length, 1)
  assert.equal(ok.people[0].role, 'trusted')
})

test('diary: fish writes approved; trusted writes suggestion pending review', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home3-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws3-'))
  const owner = 'session-owner-3'
  const world = createWorldStore({ home, qq: fakeQq('1838601405', owner) })
  world.setServices(fakeServices(workspace, owner))

  const entry = world.appendDiary({ text: '今天很开心', actorName: '鱼', role: 'owner' })
  assert.equal(entry.suggestion, false)
  assert.equal(entry.record.actorName, '鱼')

  const suggestion = world.appendDiary({ text: '我想让鱼多睡一点', actorName: '阿鱼', role: 'trusted' })
  assert.equal(suggestion.suggestion, true)
  assert.equal(suggestion.record.status, 'pending')

  const pending = world.listDiary({ suggestions: true })
  assert.equal(pending.length, 1)

  const reviewed = world.reviewDiarySuggestion(suggestion.record.id, true)
  assert.equal(reviewed.accepted, true)
  assert.equal(world.listDiary({ suggestions: true }).length, 0)
  assert.equal(world.listDiary({}).length, 2)
})

test('physical state is clamped to 0..100', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-home4-'))
  const workspace = mkdtempSync(join(tmpdir(), 'fw-ws4-'))
  const world = createWorldStore({ home, qq: fakeQq('1838601405', 'session-owner-4') })
  world.setServices(fakeServices(workspace, 'session-owner-4'))
  const state = world.applyActivity({ kind: 'turn' })
  for (const value of Object.values(state.values)) assert.ok(value >= 0 && value <= 100)
})
