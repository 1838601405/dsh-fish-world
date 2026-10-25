// 协议端守护：先探活、连续失败才拉、拉着有冷却、切到 AstrBot 就不掺和。
//
// 关键约束：**测试不许真去连本机端口**。守护现在用「OneBot HTTP 端口通不通」
// 判断进程在不在，而主人这台机器上 3000 通常是通的 —— 不注入 probe 的话，
// 同一份测试在「协议端开着」和「没开」两种情况下结果不同，那是假测试。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  COOLDOWN_MS, FAILS_BEFORE_START, createProtocolSupervisor, findProtocolDir, oneBotPort, probePort,
} from '../lib/protocol-supervisor.mjs'

function fakeQq(results) {
  let i = 0
  return { loginInfo: async () => results[Math.min(i++, results.length - 1)] }
}

/** 固定的「进程在不在」：测试里一律说不在，好让拉起逻辑真的被走到。 */
const notRunning = () => false

test('找不到协议端目录就不假装守护', async () => {
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: '', probe: notRunning, spawnImpl: () => { throw new Error('不该被调用') },
  })
  assert.equal(sup.status().enabled, false)
  const ticked = await sup.tick()
  assert.equal(ticked.skipped, 'no-dir')
})

test('连续失败够次数才拉起，成功就清零', async () => {
  const spawns = []
  const spawnImpl = (exe, args, opts) => { spawns.push({ exe, args, opts }); return { unref() {}, on() {} } }
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', spawnImpl, probe: notRunning, now: () => 1000,
  })

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
  assert.equal(spawns[0].opts.windowsHide, true, '不许弹窗')
  assert.equal(sup.status().started, 1)
})

test('进程还在跑但还没登录完成：不再拉第二个，也不装没事', async () => {
  const spawns = []
  const spawnImpl = () => { spawns.push(1); return { unref() {}, on() {} } }
  const warns = []
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', spawnImpl,
    // 端口通（进程活着）但 loginInfo 一直失败（还没登录完）
    probe: () => true, failsBeforeStart: 1,
    logger: { info() {}, warn: (m) => warns.push(String(m)) },
  })
  const r = await sup.tick()
  assert.equal(r.launched, false, '不该再拉')
  assert.equal(r.running, true, '要如实说它在跑')
  assert.equal(r.alive, false, '但确实还没应答')
  assert.equal(spawns.length, 0)
  assert.ok(warns.some((w) => /还没应答/.test(w)), '要留下提醒，不能静默')
})

test('活着的时候什么都不做；切到 AstrBot 通道也什么都不做', async () => {
  const spawns = []
  const spawnImpl = () => { spawns.push(1); return { unref() {}, on() {} } }
  const alive = createProtocolSupervisor({ qq: fakeQq([{ ok: true }]), dir: 'D:/fake/snowluma', spawnImpl, probe: notRunning })
  const r = await alive.tick()
  assert.equal(r.alive, true)
  assert.equal(spawns.length, 0)

  const viaBot = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', spawnImpl, probe: notRunning, isDirectTransport: () => false,
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
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', spawnImpl, probe: notRunning, now: () => clock, failsBeforeStart: 1,
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
    probe: notRunning, spawnImpl: () => { throw new Error('EPERM') },
  })
  const r = await sup.tick()
  assert.equal(r.ok, false)
  assert.match(sup.status().lastError, /EPERM/)
})

test('findProtocolDir 只认真正含 node.exe + index.mjs 的目录', () => {
  // 不碰本机真实安装目录：用临时目录造一个「像协议端」的，再断言能认出来。
  // （原先写死 D:/deepseek-qq/snowluma，换台机器就没这条断言了 —— AGENTS.md §6.3。）
  assert.equal(findProtocolDir(['D:/definitely/not/here']), '')

  const fake = mkdtempSync(join(tmpdir(), 'fw-proto-'))
  assert.equal(findProtocolDir([fake]), '', '只有 index.mjs 不算：缺 node.exe')
  writeFileSync(join(fake, 'index.mjs'), '// fake\n', 'utf8')
  assert.equal(findProtocolDir([fake]), '', '只有 index.mjs 还是不算')
  writeFileSync(join(fake, 'node.exe'), 'fake', 'utf8')
  assert.equal(findProtocolDir([fake]), fake, '两个都在才认')
})

test('启动检查：活着就什么都不做，也不等', async () => {
  let waits = 0
  const spawns = []
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: true }]), dir: 'D:/fake/snowluma', probe: notRunning,
    spawnImpl: () => { spawns.push(1); return { unref() {}, on() {} } },
  })
  const r = await sup.checkAtBoot({ sleep: async () => { waits += 1 } })
  assert.equal(r.alive, true)
  assert.equal(r.launched, false)
  assert.equal(spawns.length, 0)
  assert.equal(waits, 0, '活着不该等确认')
})

test('启动检查：端口通但还没登录完，也不拉第二个', async () => {
  const spawns = []
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', probe: () => true,
    spawnImpl: () => { spawns.push(1); return { unref() {}, on() {} } },
  })
  const r = await sup.checkAtBoot({ sleep: async () => {} })
  assert.equal(r.launched, false, '进程在跑就别拉')
  assert.equal(r.alive, true)
  assert.equal(r.waitingLogin, true, '要如实说还在登录')
  assert.equal(spawns.length, 0)
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
    qq, dir: 'D:/fake/snowluma', probe: notRunning,
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
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', isDirectTransport: () => false, probe: notRunning,
    spawnImpl: () => { spawns.push(1); return { unref() {}, on() {} } },
  })
  const r = await sup.checkAtBoot({ sleep: async () => {} })
  assert.equal(r.skipped, 'not-direct')
  assert.equal(spawns.length, 0)
})

test('启动检查：拉不起来要报错，不许假装在线', async () => {
  const sup = createProtocolSupervisor({
    qq: fakeQq([{ ok: false }]), dir: 'D:/fake/snowluma', probe: notRunning,
    spawnImpl: () => { throw new Error('EPERM') },
  })
  const r = await sup.checkAtBoot({ sleep: async () => {} })
  assert.equal(r.ok, false)
  assert.match(r.error, /EPERM/)
})

// —— 端口判据本身 ——

test('oneBotPort 从桥配置取端口，取不到按 3000', () => {
  assert.equal(oneBotPort({ NapCat: 'http://127.0.0.1:3000' }), 3000)
  assert.equal(oneBotPort({ NapCat: 'http://127.0.0.1:3011/' }), 3011)
  assert.equal(oneBotPort({ NapCat: '127.0.0.1:3050' }), 3050, '没写协议也要能认')
  assert.equal(oneBotPort({ NapCat: 'https://example.com' }), 443)
  assert.equal(oneBotPort({}), 3000, '桥里没填就用协议端默认口')
  assert.equal(oneBotPort(null), 3000)
})

test('probePort：非法端口直接 false，不真去连', async () => {
  // 端口号不合法时连 socket 都不该建 —— 这条是纯函数判断，跨机器稳定。
  assert.equal(await probePort({ port: 0 }), false, '非法端口当作不通')
  assert.equal(await probePort({ port: 999999 }), false)
  assert.equal(await probePort({ port: 'abc' }), false)
  assert.equal(await probePort({}), false)
})

test('probePort：连本机一个刚关掉的端口，结果为 false 且不抛', async (t) => {
  // 不写死「端口 1 谁都连不上」那种碰运气的断言（有的机器 1 端口确实有人用）。
  // 做法：先占一个随机空闲端口，再关掉它，然后探这个已经没人监听的端口。
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  t.after(() => { try { server.close() } catch {} })
  assert.equal(await probePort({ port, timeoutMs: 1500 }), false)
})
