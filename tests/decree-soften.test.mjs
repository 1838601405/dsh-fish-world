// 治「拍板感」判据（主人 2026-11-24 五节）。
//
// 验收里能自动验的三条：
//   #2 她的短句、省主语、不打句号，**一条都没被改掉**（未命中 ⇒ changed=false、逐字节原样）
//   #3 误杀：判据是「有没有在拍板/收尾/不容置疑」，**不是句子短**（「哼」不算，「这事就这么定了」才算）
//   #1 命中降 ≥一半 —— 单测层验「命中 → 软化后不再命中」；真对话的降度由 var/ 脚本对历史数据跑
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectDecree, softenDecree } from '../lib/decree-soften.mjs'

// ── detect：四种形态要能数出来 ──

test('★★ 形态4：命令式收尾能识别', () => {
  // ★ 主人说的是**收尾**（"就这么办""别问了""按我说的来"）——
  //   样本必须是命令式落在**最后**（第一版我拿「别问了，直接改」当样本，
  //   命令式在句中、结尾是「直接改」（不在词表）⇒ 不命中，是样本错不是判据错）
  for (const t of ['行，那就这么办', '别问了', '按我说的来', '这事就这么定了']) {
    assert.ok(detectDecree(t).some((h) => h.startsWith('4')), `★ 应命中命令式收尾：「${t}」→ ${JSON.stringify(detectDecree(t))}`)
  }
  // 句中的命令式不算「收尾」（保持主人原意，别扩大打击面）
  assert.equal(detectDecree('别问了，直接改').some((h) => h.startsWith('4')), false,
    '★ 命令式在句中、结尾不是命令式 ⇒ 不算收尾（词表按主人给的）')
})

test('★★ 形态2：结尾补总结/建议能识别', () => {
  // ★ 同样要落在**最后**
  for (const t of ['建议你先备份', '这样就行了', '要不你先睡', '先这样']) {
    assert.ok(detectDecree(t).some((h) => h.startsWith('2')), `★ 应命中总结/建议收尾：「${t}」`)
  }
  // 「先这样吧，回头再说」——总结词在句中、结尾是「回头再说」⇒ 不算收尾
  assert.equal(detectDecree('先这样吧，回头再说').some((h) => h.startsWith('2')), false,
    '★ 总结词不在结尾 ⇒ 不算（保持收尾语义）')
})

test('★★ 形态3：四字对仗收尾 —— 只认整句恰好 4+4（别误杀）', () => {
  // 正例：整句就是「四字，四字」
  for (const t of ['进退两难，左右为难', '口是心非，表里不一']) {
    assert.ok(detectDecree(t).some((h) => h.startsWith('3')), `★ 应命中对仗：「${t}」`)
  }
  // ★ 负例（主人「别误杀」的样本）：逗号两侧**不是**恰好各 4 字
  for (const t of ['拿肝当麻醉剂，也真管用', '这个我上次没接，你再发一遍', '四个字，但前面还有话要说']) {
    assert.equal(detectDecree(t).some((h) => h.startsWith('3')), false,
      `★ 不该命中（6+5 或带前后文）：「${t}」→ ${JSON.stringify(detectDecree(t))}`)
  }
})

test('★★ 别误杀：她的短句、省主语、不打句号 —— 一条都不算拍板', () => {
  const innocent = [
    '哼', '？', '6', '草', '乐', '典', '难绷',
    '行，我改', '懂了，以后不评了', '哪个 galgame？',
    '这不就是「稳赚不赔」那一套', '对，全是模板',
    '说一声我去看看', '你聊，我接',
  ]
  for (const t of innocent) {
    assert.deepEqual(detectDecree(t), [], `★ 误杀：「${t}」被当成拍板 → ${JSON.stringify(detectDecree(t))}`)
  }
})

test('★ 形态1：句句收得住（多句、收句号、不留口气）', () => {
  assert.ok(detectDecree('这事我查过了。证据是齐的。就这么定。').includes('1 句句收得住'), '★ 应命中')
  // 留口气的（省略号/语气词/问号）不算
  assert.deepEqual(detectDecree('这事我查过了……证据是齐的。'), [], '★ 有省略号不算收得住')
  assert.deepEqual(detectDecree('这事我查过了吧。证据是齐的。'), [], '★ 语气词收尾不算')
  assert.deepEqual(detectDecree('这事查过了？证据齐吗？'), [], '★ 问句不算')
  assert.deepEqual(detectDecree('一句而已。'), [], '★ 单句不算（要 ≥2 分句）')
})

// ── soften：命中才动手，没命中一个字不动 ──

test('★★ 验收#2：未命中的文本 —— changed=false 且逐字节原样', () => {
  const samples = [
    '哼', '行，我改', '哪个 galgame？', '说一声我去看看',
    '这不就是「稳赚不赔」那一套', '你聊，我接', '',
    '原出处查不到，它本来就不是一篇完整原文',
  ]
  for (const t of samples) {
    const r = softenDecree(t)
    assert.equal(r.changed, false, `★ 不该动：「${t}」`)
    assert.equal(r.text, t, `★★ 必须逐字节原样：「${t}」`)
    assert.deepEqual(r.hits, [], `★ 根本没命中：「${t}」`)
  }
})

test('★★ 命中 → 软化后不再命中（或删空则原样发）', () => {
  const cases = ['行，那就这么办', '建议你先备份', '进退两难，左右为难', '这事就这么定了']
  for (const t of cases) {
    const r = softenDecree(t)
    assert.ok(r.hits.length, `前提：「${t}」应命中，实为 ${JSON.stringify(r.hits)}`)
    if (r.changed) {
      const after = detectDecree(r.text)
      assert.deepEqual(after, [], `★★ 改写后不该再命中：「${t}」→「${r.text}」`)
      assert.ok(r.text.trim().length > 0, '★ 不许改出空消息')
    } else {
      // 没改成功也必须说明（兜底：删空了 / 改不动）
      assert.match(r.action, /原样/, `★ 没改成功要走兜底并说明：${r.action}`)
    }
  }
})

test('★ 兜底：删空了就原样发（不发空消息 —— 误杀比拍板更糟）', () => {
  // 只有一句且整句就是命令式 → 删尾会变空 → 必须原样
  const r = softenDecree('就这么办')
  assert.equal(r.text, '就这么办', '★★ 删空了要原样发')
  assert.equal(r.changed, false)
  assert.match(r.action, /兜底|原样/)
})

test('★ 改写失败/出错 → 不影响（函数不抛）', () => {
  for (const t of [null, undefined, '', 123, { a: 1 }]) {
    const r = softenDecree(t)
    assert.equal(typeof r.text, 'string', `★ ${JSON.stringify(t)} 要返回字符串`)
    assert.equal(typeof r.changed, 'boolean')
  }
})

test('★ action 字段给得出（日志/判据用）', () => {
  const r = softenDecree('行，那就这么办')
  assert.ok(r.action && typeof r.action === 'string')
  assert.ok(r.hits.length > 0)
})
