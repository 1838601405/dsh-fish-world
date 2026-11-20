// 重启窗口内消息不丢 + 丢弃可见 + 补投（2026-11-20 主人要求 A/B/C）。
//
// 现场：09:13 重启，主人 08:47 发的「吃饭去了」，
//       09:14:07 桥判「27 分钟前，不再补投」直接丢掉 → 主人以为没回。
//
// 三处改动：
//   A. 丢弃可见：未投队列 + 面板显示 + 补投按钮
//   B. 重启窗口豁免：消息早于「桥活过来」且不超过 30 分钟 → 照常补投
//   C. 主人私聊也要有 API 兜底：fish-world 能看见桥的未投并补投
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createBridgeUndelivered } from '../lib/bridge-undelivered.mjs'

const BRIDGE = 'D:/DSH-home/profiles/desktop/node_modules/dsh-qq-bridge/lib/host.js'
const bridgeSrc = (() => {
  try { return readFileSync(BRIDGE, 'utf8') } catch { return '' }
})()

// ★ 剥掉注释后的「只有代码」版本。
//   教训（2026-11-20）：注释里写着「标『迟到的回复』」「已进未投队列」这类
//   描述性文字，直接对全文 match 会被注释命中 —— 删掉真代码也不会红。
//   所有「判某段逻辑在不在」的断言都该用这个。
const codeOnly = bridgeSrc
  .split(/\r?\n/)
  .filter((line) => {
    const t = line.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

// ─────────────── B：重启窗口豁免（桥侧源码级） ───────────────

test('B：桥有「重启豁免分」配置，默认 30 分钟', () => {
  assert.ok(bridgeSrc, '要能读到桥源码')
  assert.match(bridgeSrc, /重启豁免分:\s*30/, '默认值要是 30 分钟（主人要求）')
  // 归一化也要有，否则配置里改了不生效
  assert.match(bridgeSrc, /重启豁免分:\s*数\(混\.重启豁免分/, '要进归一化')
})

test('B：桥记录自己的启动时间（判定重启窗口要用）', () => {
  assert.match(bridgeSrc, /const 桥启动于 = Date\.now\(\)/, '模块级要记启动时刻')
})

test('B：超窗判定里真的有豁免分支', () => {
  // 关键三段必须同时出现，缺一段豁免就是假的
  assert.match(bridgeSrc, /落在重启窗口/, '要有「落在重启窗口」的判定')
  assert.match(bridgeSrc, /消息秒 < 桥活于秒/, '要判「消息早于桥活过来」')
  assert.match(bridgeSrc, /桥活于秒 - 消息秒\) <= 重启豁免分 \* 60/, '要判「距离不超过豁免窗口」')
  assert.match(bridgeSrc, /用窗口秒 = \(落在重启窗口 \? 重启豁免分 : 基础窗口分\) \* 60/,
    '落在重启窗口时窗口要放宽')
})

test('B：正常运行时窗口仍然是 10 分钟（不许被顺手放大）', () => {
  // 如果哪天把基础窗口直接改成 30，一打开会话就会冒一堆旧回复 —— 那是原设计要防的
  assert.match(bridgeSrc, /补投窗口分:\s*10/, '基础窗口仍是 10 分钟')
  assert.ok(!/补投窗口分:\s*(2[0-9]|30)/.test(bridgeSrc),
    '基础窗口不许被改成 20/30 分钟（豁免是另一条路）')
})

// ─────────────── A：丢弃可见 + 补投 ───────────────

test('A：被丢弃的消息要进「未投队列」，不是只记一行日志', () => {
  assert.match(bridgeSrc, /const 未投队列 = \[\]/, '要有未投队列')
  assert.match(bridgeSrc, /function 记未投\(/, '要有记录函数')
  // 丢弃分支里必须调它
  const dropIdx = bridgeSrc.indexOf('记未投(条, 年龄秒, 文字,')
  assert.ok(dropIdx > 0, '★ 丢弃时必须调 记未投 —— 否则还是只躺在日志里')
  // 且文案要改成「已进未投队列」，别再说「不再补投」
  assert.match(codeOnly, /已进未投队列，面板可手动补投/, '日志文案要指向面板（代码里）')
})

test('A：/state 返回未投队列，面板才看得到', () => {
  assert.match(bridgeSrc, /概\.未投 = 未投队列\.slice\(\)\.reverse\(\)/, '/state 要返回未投（新的在前）')
  assert.match(bridgeSrc, /概\.桥启动于 = 桥启动于/, '要暴露桥启动时间')
  // 读状态出错时的兜底返回也要有
  assert.match(bridgeSrc, /未投: 未投队列\.slice\(\)\.reverse\(\)/, '兜底返回也要带未投')
})

test('A：有手动补投接口', () => {
  assert.match(bridgeSrc, /路由前缀}\/redeliver/, '要有 /redeliver 路由')
  assert.match(bridgeSrc, /未投队列\.findIndex/, '补投成功要从队列移除（失败留着重试）')
  // 补投时要标明是迟到的，别冒充实时回复。
  assert.match(codeOnly, /迟到的回复·原消息/, '★ 补投必须标「迟到的回复」（代码里，不是注释里）')
})

// ─────────────── C：fish-world 侧能看见并补投 ───────────────

test('C：客户端能读桥的未投队列', async () => {
  const client = createBridgeUndelivered({ fileFirst: false,
    baseUrl: 'http://127.0.0.1:1234',
    fetchJson: async (url) => {
      assert.match(url, /\/dsh-qq-bridge\/state$/)
      return {
        ok: true,
        桥启动于: 1000,
        重启豁免分: 30,
        未投: [
          { id: 'm1', 时间: 1700000000, 秒: 1620, 文字: '吃饭去了', 昵称: '主人', 号码: 1838601405, 原因: '超过补投窗口（10 分钟）' }
        ]
      }
    }
  })
  const s = await client.status()
  assert.equal(s.ok, true)
  assert.equal(s.count, 1)
  assert.equal(s.items[0].text, '吃饭去了')
  assert.equal(s.items[0].nickname, '主人')
  assert.equal(s.supportsQueue, true, '要认出桥支持未投队列')
  assert.equal(s.exemptMinutes, 30)
})

test('C：桥是老版本（没有未投字段）→ 不当错误', async () => {
  const client = createBridgeUndelivered({ fileFirst: false,
    baseUrl: 'http://127.0.0.1:1234',
    fetchJson: async () => ({ ok: true, 日志: [] })
  })
  const s = await client.status()
  assert.equal(s.ok, true, '老桥也要返回 ok（不是错误）')
  assert.equal(s.supportsQueue, false, '要标出「这个桥没这能力」')
  assert.equal(s.count, 0)
  assert.equal(await client.summaryText(), '', '老桥不该刷出提示')
})

test('C：面板文案说清有几条（带摘要）', async () => {
  const client = createBridgeUndelivered({ fileFirst: false,
    baseUrl: 'http://x',
    fetchJson: async () => ({
      ok: true,
      未投: [{ id: 'm1', 文字: '吃饭去了', 秒: 1620 }]
    })
  })
  const t = await client.summaryText()
  assert.match(t, /1 条消息没投出去/)
  assert.match(t, /吃饭去了/)
})

test('C：补投能调桥的 redeliver 接口', async () => {
  let got = null
  const client = createBridgeUndelivered({ fileFirst: false,
    baseUrl: 'http://x',
    fetchJson: async (url, body) => {
      assert.match(url, /\/dsh-qq-bridge\/redeliver$/)
      got = body
      return { ok: true, 结果: [{ id: 'm1', ok: true }], 还剩: 0 }
    }
  })
  const r = await client.redeliver({ id: 'm1' })
  assert.equal(r.ok, true)
  assert.deepEqual(got, { id: 'm1' })
  assert.equal(r.remaining, 0)

  // 全部补投
  await client.redeliver({ all: true })
  assert.deepEqual(got, { 全部: true })
})

test('C：补投没给 id 也没 all → 明确报错', async () => {
  const client = createBridgeUndelivered({ fileFirst: false, baseUrl: 'http://x', fetchJson: async () => ({ ok: true }) })
  const r = await client.redeliver({})
  assert.equal(r.ok, false)
  assert.match(r.error, /id|all/)
})

test('C：桥连不上 → 返回 ok:false，不抛异常', async () => {
  const client = createBridgeUndelivered({ fileFirst: false,
    baseUrl: 'http://x',
    fetchJson: async () => { throw new Error('ECONNREFUSED') }
  })
  const s = await client.status()
  // fetchJson 抛错时 request 没包住 —— 这个要能兜住
  assert.equal(s.ok, false)
  assert.equal(s.count, 0)
})

// ─────────────── 读文件优先（2026-11-20 加） ───────────────
// 为什么要有这条：插件拿不到宿主 webServer 端口，纯 HTTP 那条路随时会断。
// 桥的状态文件就在 DSH_HOME 里，读文件最可靠。这条判据钉住「文件优先」不被改回去。

test('读文件优先：状态文件里有未投队列就直接用它，不打 HTTP', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  const file = join(dir, 'qq-bridge-state.json')
  writeFileSync(file, JSON.stringify({
    未投队列: [
      { id: 'm9', 时间: 1700000000, 秒: 1700, 文字: '吃饭去了', 昵称: '主人', 号码: 1838601405, 原因: '超过补投窗口（10 分钟）' }
    ],
    桥启动于: 1700001000000,
    重启豁免分: 30
  }), 'utf8')

  let httpCalled = 0
  const client = createBridgeUndelivered({
    baseUrl: 'http://127.0.0.1:1',   // 故意给个连不上的
    stateFile: file,
    fetchJson: async () => { httpCalled++; return { ok: false } }
  })
  const s = await client.status()
  assert.equal(httpCalled, 0, '★ 文件读到了就不该再打 HTTP')
  assert.equal(s.ok, true)
  assert.equal(s.count, 1)
  assert.equal(s.items[0].text, '吃饭去了')
  assert.equal(s.source, 'file', '要标出来源是文件')
})

test('文件不存在才退回 HTTP', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'bridge-none-'))
  let httpCalled = 0
  const client = createBridgeUndelivered({
    baseUrl: 'http://127.0.0.1:1',
    stateFile: join(dir, '不存在.json'),
    fetchJson: async () => { httpCalled++; return { ok: true, 未投: [{ id: 'x', 文字: 'y' }] } }
  })
  const s = await client.status()
  assert.equal(httpCalled, 1, '★ 文件没有时要用 HTTP 兜底')
  assert.equal(s.count, 1)
})

test('文件在但坏 JSON → 退回 HTTP，不炸', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'bridge-bad-'))
  const file = join(dir, 'qq-bridge-state.json')
  writeFileSync(file, '{ 坏掉的', 'utf8')
  let httpCalled = 0
  const client = createBridgeUndelivered({
    baseUrl: 'http://127.0.0.1:1',
    stateFile: file,
    fetchJson: async () => { httpCalled++; return { ok: true, 未投: [] } }
  })
  const s = await client.status()
  assert.equal(httpCalled, 1, '坏文件要退回 HTTP')
  assert.equal(s.ok, true)
})

test('生产默认 fileFirst=true（不显式关就优先读文件）', () => {
  const src = readFileSync('lib/bridge-undelivered.mjs', 'utf8')
  assert.match(src, /fileFirst = true/, '默认值必须是 true')
  assert.match(src, /const file = fileFirst \? resolveStateFile\(\) : ''/, '要真的按开关走')
})
