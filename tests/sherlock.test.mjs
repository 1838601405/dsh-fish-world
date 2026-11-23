// Sherlock 借手：CSV 解析、四态归一、以及「查一次」的命令行与失败说法。
//
// ★ 这里最重要的一条断言是 argv 必须带 --print-all：
//   上游 CSV 默认只落**已占用**的站点，只存命中 → 账本里「查过的站」全是已占用，
//   主人看到的是一张假表。这条一旦被改回 --print-found，本文件必须红。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SHERLOCK_STATUS,
  createSherlock,
  normalizeExists,
  parseCsv,
  statusLabel,
  summarize,
} from '../lib/sherlock.mjs'

const CSV_SAMPLE = [
  'username,name,url_main,url_user,exists,http_status,response_time_s',
  'alice,GitHub,https://www.github.com/,https://www.github.com/alice,Claimed,200,2.5',
  'alice,"Some Site, Inc.",https://some.site/,https://some.site/alice,Available,200,1.0',
  'alice,Reddit,https://www.reddit.com/,https://www.reddit.com/user/alice,Unknown,?,',
  'alice,GitLab,https://gitlab.com/,,Illegal,,',
].join('\r\n')

test('CSV 解析：表头对齐、引号里的逗号不断列、CRLF 不多出空行', () => {
  const rows = parseCsv(CSV_SAMPLE)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].name, 'GitHub')
  assert.equal(rows[0].exists, 'Claimed')
  // 站点名里带逗号：手写解析最容易在这里把一列拆成两列。
  assert.equal(rows[1].name, 'Some Site, Inc.')
  assert.equal(rows[1].status ?? rows[1].exists, 'Available')
  assert.equal(rows[3].exists, 'Illegal')
  assert.equal(rows[3].url_user, '', '没查到的站 url_user 是空串，不是 undefined')
})

test('空 CSV / 只有表头 → 空数组，不抛', () => {
  assert.deepEqual(parseCsv(''), [])
  assert.deepEqual(parseCsv('username,name,url_main,url_user,exists,http_status,response_time_s\n'), [])
  // BOM 要吃掉，否则第一列列名对不上。
  assert.deepEqual(parseCsv('\uFEFFusername,name\nalice,GitHub\n').length, 1)
})

test('exists 归一成四态；认不出的一律是 unknown，不当成 available', () => {
  assert.equal(normalizeExists('Claimed'), SHERLOCK_STATUS.CLAIMED)
  assert.equal(normalizeExists('claimed'), SHERLOCK_STATUS.CLAIMED)
  assert.equal(normalizeExists('Available'), SHERLOCK_STATUS.AVAILABLE)
  assert.equal(normalizeExists('Illegal'), SHERLOCK_STATUS.ILLEGAL)
  // 关键：查不出来 ≠ 没有。混成 available 就是替主人做了个假判断。
  assert.equal(normalizeExists('Unknown'), SHERLOCK_STATUS.UNKNOWN)
  assert.equal(normalizeExists('?'), SHERLOCK_STATUS.UNKNOWN)
  assert.equal(normalizeExists(''), SHERLOCK_STATUS.UNKNOWN)
  assert.equal(normalizeExists('SomethingNew'), SHERLOCK_STATUS.UNKNOWN)
  assert.equal(statusLabel('unknown'), '未知')
})

test('汇总四态各自计数，unknown 单独一栏', () => {
  const counts = summarize(parseCsv(CSV_SAMPLE).map((row) => ({ status: normalizeExists(row.exists) })))
  // 四态必须各自有数：unknown 混进 available 就是替主人把「没测出来」说成了「没有」。
  assert.deepEqual(counts, { claimed: 1, available: 1, unknown: 1, illegal: 1, total: 4 })
  assert.equal(counts.claimed + counts.available + counts.unknown + counts.illegal, counts.total)
})

test('用户名不合法直接拒：不进流程、不落临时目录', async () => {
  const sherlock = createSherlock({ config: () => ({ sherlock: {} }), locate: () => ({ found: true, python: 'python', version: '1', error: '' }) })
  await assert.rejects(() => sherlock.check({ username: '' }), /不能为空/)
  await assert.rejects(() => sherlock.check({ username: 'has space' }), /字母、数字/)
  await assert.rejects(() => sherlock.check({ username: 'x'.repeat(65) }), /最长 64/)
  // 注入符号也不放行：虽然走 argv 不拼 shell，形状这一道还是要拦。
  await assert.rejects(() => sherlock.check({ username: 'a&b' }), /字母、数字/)
})

test('没装 sherlock 时如实报「没装」并给安装命令，不假装查过', async () => {
  const sherlock = createSherlock({
    config: () => ({ sherlock: {} }),
    locate: () => ({ found: false, python: 'python', version: '', error: 'No module named sherlock_project' }),
  })
  const result = await sherlock.check({ username: 'alice' })
  assert.equal(result.ok, false)
  assert.equal(result.platforms.length, 0)
  assert.match(result.error, /没装/)
  assert.match(result.error, /No module named sherlock_project/, '原文照抄上游报错，别换成自己的说法')
  assert.match(result.error, /pip install sherlock-project/, '要给出怎么装')

  const status = await sherlock.status()
  assert.equal(status.installed, false)
  assert.match(status.note, /pip install sherlock-project/)
})

test('★ argv 必须 --print-all：只存命中会造出「查过的站全是已占用」的假表', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'fw-sherlock-'))
  let seenArgv = null
  const fakeRunner = {
    async run(argv) {
      seenArgv = argv
      // 按上游真实行为：把 CSV 写进 --folderoutput 指定的目录。
      const dir = argv[argv.indexOf('--folderoutput') + 1]
      writeFileSync(join(dir, 'alice.csv'), CSV_SAMPLE, 'utf8')
      return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1200 }
    },
  }
  const sherlock = createSherlock({
    config: () => ({ sherlock: { enabled: true, timeoutSec: 15, sites: ['github', 'gitlab'] } }),
    locate: () => ({ found: true, python: 'python', version: '0.16.2', error: '' }),
    runner: fakeRunner,
    tempRoot,
  })

  const result = await sherlock.check({ username: 'alice' })
  assert.equal(result.ok, true)
  assert.ok(seenArgv.includes('--print-all'), '必须 --print-all，否则 Available/Unknown 整行不写')
  assert.ok(!seenArgv.includes('--print-found'), '--print-found 会把 CSV 裁成只剩命中')
  assert.ok(seenArgv.includes('--local'), '用本地站点表，不每次联网拉 data.json')
  assert.equal(seenArgv[seenArgv.indexOf('--timeout') + 1], '15', '超时读配置')
  assert.equal(seenArgv.filter((item) => item === '--site').length, 2, '站点白名单逐个透传')

  // 四种结局都要落到账里，缺一种就是假表。
  assert.deepEqual(result.counts, { claimed: 1, available: 1, unknown: 1, illegal: 1, total: 4 })
  assert.equal(result.platforms[1].site, 'Some Site, Inc.')
  assert.equal(result.durationMs, 1200)

  // 临时目录要清掉：里面是查询结果原文件，不该留在系统临时区。
  const left = readdirSync(tempRoot)
  assert.deepEqual(left, [], `临时目录没清：${left.join(', ')}`)
})

test('查不到结果时说清退出码，不把失败说成「一个都没有」', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'fw-sherlock-empty-'))
  const fakeRunner = {
    async run(argv) {
      // 只写表头：上游在全站失败时就是这样。
      writeFileSync(join(argv[argv.indexOf('--folderoutput') + 1], 'bob.csv'),
        'username,name,url_main,url_user,exists,http_status,response_time_s\n', 'utf8')
      return { exitCode: 1, signal: null, stdout: '', stderr: 'boom\nsite down', durationMs: 500 }
    },
  }
  const sherlock = createSherlock({
    config: () => ({ sherlock: {} }),
    locate: () => ({ found: true, python: 'python', version: '', error: '' }),
    runner: fakeRunner,
    tempRoot,
  })
  const result = await sherlock.check({ username: 'bob' })
  assert.equal(result.ok, false)
  assert.match(result.error, /退出码 1/)
  assert.match(result.error, /site down/, '上游 stderr 要带出来，便于判断是网络还是别的')
  assert.equal(result.counts.total, 0)
})

test('同一时间只许一个查询在跑（串行闸）', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'fw-sherlock-busy-'))
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const fakeRunner = {
    async run(argv) {
      writeFileSync(join(argv[argv.indexOf('--folderoutput') + 1], 'a.csv'),
        'username,name,url_main,url_user,exists,http_status,response_time_s\nalice,GitHub,,,Claimed,200,1\n', 'utf8')
      await gate
      return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 10 }
    },
  }
  const sherlock = createSherlock({
    config: () => ({ sherlock: {} }),
    locate: () => ({ found: true, python: 'python', version: '', error: '' }),
    runner: fakeRunner,
    tempRoot,
  })

  const first = sherlock.check({ username: 'a' })
  // 第二个必须立刻被拒，而不是排队叠着打站点。
  await assert.rejects(() => sherlock.check({ username: 'b' }), /已经有一次查询在跑/)
  release()
  const done = await first
  assert.equal(done.ok, true)
  // 跑完之后闸门要放行。
  const again = await sherlock.check({ username: 'c' })
  assert.equal(again.ok, true)
})

test('开关与站点白名单从同一份配置读', () => {
  const off = createSherlock({ config: () => ({ sherlock: { enabled: false } }) })
  assert.equal(off.enabled(), false)
  const on = createSherlock({ config: () => ({ sherlock: { enabled: true, sites: [' github ', '', 'gitlab'] } }) })
  assert.equal(on.enabled(), true)
  assert.deepEqual(on.sites(), ['github', 'gitlab'], '空白项要去掉')
  // 没配置时是关的，不是开的：默认关才是安全默认。
  assert.equal(createSherlock({ config: () => ({}) }).enabled(), false)
  assert.equal(createSherlock({ config: () => null }).enabled(), false)
})

test('临时目录根没给就用系统临时区；给了就用给的', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'fw-sherlock-root-'))
  assert.ok(existsSync(tempRoot))
  const sherlock = createSherlock({ config: () => ({ sherlock: {} }), tempRoot })
  assert.ok(sherlock, '构造不抛即可（真正落目录由上面的 check 用例验）')
})
