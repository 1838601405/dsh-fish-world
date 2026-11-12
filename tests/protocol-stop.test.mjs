import test from 'node:test'
import assert from 'node:assert/strict'
import { createProtocolSupervisor } from '../lib/protocol-supervisor.mjs'

test('stop 只按目录交给 stopProcesses，并回报剩余进程数', async () => {
  let usedDir = ''
  let remaining = 2
  const sup = createProtocolSupervisor({
    dir: 'E:\\deepseek-qq\\snowluma',
    stopProcesses: async (dir) => { usedDir = dir; remaining = 0; return { ok: true, stopped: 3 } },
    countProcesses: async () => remaining,
    probe: async () => false,
  })
  const r = await sup.stop()
  assert.equal(r.ok, true)
  assert.equal(r.stopped, 3)
  assert.equal(r.remaining, 0)
  assert.equal(usedDir, 'E:\\deepseek-qq\\snowluma')
})

test('stop 失败要原样报出来', async () => {
  const sup = createProtocolSupervisor({
    dir: 'D:\\x\\snowluma',
    stopProcesses: async () => ({ ok: false, error: '只支持 Windows' }),
    countProcesses: async () => 1,
    probe: async () => false,
  })
  const r = await sup.stop()
  assert.equal(r.ok, false)
  assert.match(r.error, /只支持 Windows/)
  assert.equal(r.remaining, 1)
})
