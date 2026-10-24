// 依赖体检与 AstrBot 通道的联动：AstrBot 承担 QQ 时不该再要求装 QQ 桥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEnvironment } from '../lib/env.mjs'

// 造一个"什么都没装"的干净 home，让 dsh-qq-bridge 必然缺失。
function bareHome() {
  const home = mkdtempSync(join(tmpdir(), 'fw-env-astrbot-'))
  mkdirSync(join(home, 'profiles', 'desktop', 'node_modules'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ name: 'desktop', dependencies: {} }),
    'utf8',
  )
  return home
}

function check(home, astrbot) {
  return checkEnvironment({
    home,
    profile: 'desktop',
    configStore: {
      getConfig: () => ({ astrbot }),
      configPath: join(home, 'fish-world-config.json'),
    },
  })
}

test('没有 AstrBot 时，缺 QQ 桥会被当成缺失依赖', () => {
  const home = bareHome()
  try {
    const result = check(home, { enabled: false, useForQQ: false })
    const bridge = result.packages.find((p) => p.name === 'dsh-qq-bridge')
    assert.equal(bridge.found, false)
    assert.equal(result.missing.includes('dsh-qq-bridge'), true, '应该报告缺失')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('AstrBot 承担 QQ 通道后，QQ 桥不再是必需依赖', () => {
  const home = bareHome()
  try {
    const result = check(home, { enabled: true, useForQQ: true })
    const bridge = result.packages.find((p) => p.name === 'dsh-qq-bridge')
    assert.equal(bridge.found, false, '确实没装')
    assert.equal(bridge.optional, true, '应被标记为可选')
    assert.equal(result.missing.includes('dsh-qq-bridge'), false, '不应再报告缺失')
    assert.match(String(bridge.note || ''), /AstrBot/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('只开 AstrBot 但没打开 QQ 通道时，QQ 桥仍然必需', () => {
  const home = bareHome()
  try {
    const result = check(home, { enabled: true, useForQQ: false })
    assert.equal(result.missing.includes('dsh-qq-bridge'), true, '没接管 QQ 就还得装桥')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('AstrBot 接管 QQ 时不会连带放宽其他必需依赖', () => {
  const home = bareHome()
  try {
    const result = check(home, { enabled: true, useForQQ: true })
    // 心情、记忆这些和 QQ 通道无关，缺了还是要报。
    assert.equal(result.missing.includes('dsh-feiyu-mood'), true)
    assert.equal(result.missing.includes('dsh-fish-memory'), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
