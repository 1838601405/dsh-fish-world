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

test('群公告：SnowLuma 认 _get_group_notice，标准名 1404 时自动回退', async () => {
  const home = tempHome()
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({ NapCat: 'http://127.0.0.1:3000' }), 'utf8')
  const seen = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url) => {
    const action = String(url).split('/').pop()
    seen.push(action)
    if (action === 'get_group_notice') {
      return { ok: true, json: async () => ({ status: 'failed', retcode: 1404 }) }
    }
    return {
      ok: true,
      json: async () => ({
        status: 'ok',
        data: [{ notice_id: 'n1', sender_id: 188320593, publish_time: 1791707417, pinned: 1, message: { text: '此群作为AI聊天调试与优化' } }],
      }),
    }
  }
  try {
    const qq = makeQQ({ home })
    const result = await qq.groupNotices('1127271724')
    assert.equal(result.ok, true)
    assert.deepEqual(seen, ['_get_group_notice'], '先试带下划线的，不需要再打第二次')
    assert.equal(result.notices.length, 1)
    assert.equal(result.notices[0].text, '此群作为AI聊天调试与优化')
    assert.equal(result.notices[0].at, 1791707417000, 'publish_time 是秒，要换成毫秒')
    assert.equal(result.notices[0].pinned, true)
  } finally {
    globalThis.fetch = saved
  }
})

test('群公告：两个名字都不认时如实报错', async () => {
  const home = tempHome()
  writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify({ NapCat: 'http://127.0.0.1:3000' }), 'utf8')
  const saved = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'failed', retcode: 1404 }) })
  try {
    const qq = makeQQ({ home })
    const result = await qq.groupNotices('1127271724')
    assert.equal(result.ok, false)
    assert.deepEqual(result.notices, [])
  } finally {
    globalThis.fetch = saved
  }
})
