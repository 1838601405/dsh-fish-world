// 协议端守护：先探活、连续失败才拉、拉着有冷却、切到 AstrBot 就不掺和。
import assert from 'node:assert/strict'
import test from 'node:test'
import { COOLDOWN_MS, FAILS_BEFORE_START, createProtocolSupervisor, findProtocolDir } from '../lib/protocol-supervisor.mjs'

function fakeQq(results) {
  let i = 0
  return { loginInfo: async () => results[Math.min(i++, results.length - 1)] }
}

test('找不到协议端目录就不假装守护', async () => {
  const sup = createProtocolSupervisor({ qq: fakeQq([{ ok: false }]), dir: '', spawnImpl: () => { throw new Error('不该被调用') } })
  assert.equal(sup.status().enabled, false)
  const ticked = await sup.tick()
  assert.equal(ticked.skipped, 'no-dir')
})

test('连续失败够次数才拉起，成功就清零', async () => {
  const spawns = []
  const spawnImpl = (exe, args, opts) => { spawns.push({ exe, args, opts }); return { unref() {}, on() {} } }
  const sup = createProtocolSupervisor({ qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', spawnImpl, now: () => 1000 })

  for (let i = 1; i < FAILS_BEFORE_START; i++) {
    const r = await sup.tick()
    assert.equal(r.launched, undefined, '没到阈值不许拉')
  }
  const third = await sup.tick()
  assert.equal(third.launched, true)
  assert.equal(spawns.length, 1)
  assert.match(spawns[0].exe, /node\.exe$/)
  assert.deepEqual(spawns[0].args, ['index.mjs'])
  assert.equal(spawns[0].opts.cwd, 'D:/fake/snowluma')
  assert.equal(spawns[0].opts.detached, true, '要脱离宿主，别被会话带走')
  assert.equal(sup.status().started, 1)
})

test('活着的时候什么都不做；切到 AstrBot 通道也什么都不做', async () => {
  const spawns = []
  const spawnImpl = () => { spawns.push(1); return { unref() {}, on() {} } }
  const alive = createProtocolSupervisor({ qq: fakeQq([{ ok: true }]), dir: 'D:/fake/snowluma', spawnImpl })
  const r = await alive.tick()
  assert.equal(r.alive, true)
  assert.equal(spawns.length, 0)

  const viaBot = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', spawnImpl, isDirectTransport: () => false,
  })
  const r2 = await viaBot.tick()
  assert.equal(r2.skipped, 'not-direct')
  assert.equal(spawns.length, 0)
})

test('拉起之后进冷却，别反复 spawn', async () => {
  const spawns = []
  const spawnImpl = () => { spawns.push(1); return { unref() {}, on() {} } }
  let clock = 5000
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', spawnImpl, now: () => clock, failsBeforeStart: 1,
  })
  await sup.tick()
  assert.equal(spawns.length, 1)
  clock += 1000
  const again = await sup.tick()
  assert.equal(again.launched, false)
  assert.match(again.error, /冷却/)
  clock += COOLDOWN_MS + 1
  const later = await sup.tick()
  assert.equal(later.launched, true)
  assert.equal(spawns.length, 2)
})

test('spawn 本身失败要如实记下来，不能假装拉起来了', async () => {
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', failsBeforeStart: 1, now: () => 1,
    spawnImpl: () => { throw new Error('EPERM') },
  })
  const r = await sup.tick()
  assert.equal(r.ok, false)
  assert.match(sup.status().lastError, /EPERM/)
})

test('findProtocolDir 只认真正含 node.exe + index.mjs 的目录', () => {
  assert.equal(findProtocolDir(['D:/definitely/not/here']), '')
  // 本机真目录（不存在就跳过这条断言）
  const real = findProtocolDir(['D:/deepseek-qq/snowluma'])
  if (real) assert.match(real, /snowluma/)
})

test('启动检查：活着就什么都不做，也不等', async () => {
  let waits = 0
  const spawns = []
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: true }]), dir: 'D:/fake/snowluma',
    spawnImpl: () => { spawns.push(1); return { unref() {}, on() {} } },
  })
  const r = await sup.checkAtBoot({ sleep: async () => { waits += 1 } })
  assert.equal(r.alive, true)
  assert.equal(r.launched, false)
  assert.equal(spawns.length, 0)
  assert.equal(waits, 0, '活着不该等确认'
  )
})

test('启动检查：没在跑就拉一次，再确认一次', async () => {
  const spawns = []
  let probe = 0
  const qq = {
    loginInfo: async () => {
      probe += 1
      // 第一次说没在，拉起之后（第二次探）说在
      return { ok: probe > 1 }
    },
  }
  const waited = []
  const sup = createProtocolSupervisor({
    qq, dir: 'D:/fake/snowluma',
    spawnImpl: () => { spawns.push(1); return { unref() {}, on() {} } },
  })
  const r = await sup.checkAtBoot({ sleep: async (ms) => { waited.push(ms) } })
  assert.equal(r.launched, true)
  assert.equal(r.alive, true)
  assert.equal(spawns.length, 1)
  assert.equal(waited.length, 1)
})

test('启动检查：切到 AstrBot 通道就完全不掺和', async () => {
  const spawns = []
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', isDirectTransport: () => false,
    spawnImpl: () => { spawns.push(1); return { unref() {}, on() {} } },
  })
  const r = await sup.checkAtBoot({ sleep: async () => {} })
  assert.equal(r.skipped, 'not-direct')
  assert.equal(spawns.length, 0)
})

test('启动检查：拉不起来要报错，不许假装在线', async () => {
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma',
    spawnImpl: () => { throw new Error('EPERM') },
  })
  const r = await sup.checkAtBoot({ sleep: async () => {} })
  assert.equal(r.ok, false)
  assert.match(r.error, /EPERM/)
})
