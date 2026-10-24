// QQ 通道切换：确认 AstrBot 能当 transport，且默认仍然是 dsh-qq-bridge。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQQ } from '../lib/qq.mjs'
import { createAstrbot } from '../lib/astrbot.mjs'

const BASE_CONFIG = {
  qq: { enabled: true, respectBridgeSwitches: true, dryRun: false, allowForeignTargets: false, timeoutMs: 1000 },
  whale: {},
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'fw-transport-'))
}

function makeQQ({ home, astrbot = null, config = BASE_CONFIG }) {
  return createQQ({ home, config: () => config, logger: null, sandbox: null, astrbot })
}

test('没有 AstrBot 时默认走 bridge，snapshot 如实标注', () => {
  const home = tempHome()
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({ NapCat: 'http://127.0.0.1:3000' }), 'utf8')
  const qq = makeQQ({ home })
  assert.equal(qq.snapshot().transport, 'bridge')
})

test('AstrBot 配好之后 transport 切到 astrbot', () => {
  const home = tempHome()
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({ NapCat: 'http://127.0.0.1:3000' }), 'utf8')
  const astrbot = createAstrbot({ home })
  astrbot.save({ enabled: true, useForQQ: true, baseUrl: 'http://127.0.0.1:6210', token: 'fw_x' })
  const qq = makeQQ({ home, astrbot })
  // 关键：即使 qq-bridge-config.json 存在，也优先走 AstrBot。
  assert.equal(qq.snapshot().transport, 'astrbot')
})

test('AstrBot 开关关掉后回落到 bridge', () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ enabled: true, useForQQ: true, baseUrl: 'http://127.0.0.1:6210', token: 'fw_x' })
  const qq = makeQQ({ home, astrbot })
  assert.equal(qq.snapshot().transport, 'astrbot')

  astrbot.save({ useForQQ: false })
  assert.equal(qq.snapshot().transport, 'bridge')
})

test('AstrBot 通道下 call 交给 AstrBot，不再碰 NapCat', async () => {
  const home = tempHome()
  // 故意把 NapCat 指向一个不存在的地方：如果代码还在走 bridge，这里会超时。
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({ NapCat: 'http://127.0.0.1:59998', 总开关: true }), 'utf8')
  const astrbot = createAstrbot({ home })
  astrbot.save({ enabled: true, useForQQ: true, baseUrl: 'http://127.0.0.1:59999', token: 'fw_x', timeoutMs: 800 })
  const qq = makeQQ({ home, astrbot })

  const result = await qq.call('get_login_info', {})
  assert.equal(result.ok, false)
  assert.equal(result.action, 'get_login_info')
  // 报的是 AstrBot 桥的错误（连接失败/超时），不是 NapCat 的。
  assert.equal(typeof result.error, 'string')
})

test('AstrBot 通道下且没有 bridge 配置时，总开关不被默认值挡住', () => {
  const home = tempHome()
  const astrbot = createAstrbot({ home })
  astrbot.save({ enabled: true, useForQQ: true, baseUrl: 'http://127.0.0.1:6210', token: 'fw_x' })
  const qq = makeQQ({ home, astrbot })

  const snapshot = qq.snapshot()
  assert.equal(snapshot.bridgeMissing, true, '确实没有 bridge 配置文件')
  // 没有 bridge 文件时默认「总开关=false」，直接发会被静默拦掉。
  // AstrBot 通道下必须放行，否则主人明明授权了却什么都发不出去。
  assert.equal(snapshot.masterSwitch, true)
})

test('bridge 模式下没有配置文件仍然是关的（不放宽安全默认）', () => {
  const home = tempHome()
  const qq = makeQQ({ home })
  const snapshot = qq.snapshot()
  assert.equal(snapshot.bridgeMissing, true)
  assert.equal(snapshot.masterSwitch, false)
})
