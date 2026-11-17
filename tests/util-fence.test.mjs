// 出站闸：三条出口共用的同一套判据。测试数据只在这里，不进人设/提示词。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fenceText, looksLikeToolMarkup } from '../lib/util.mjs'
import { applyBridgePatch, revertBridgePatch, extractGuard } from '../lib/bridge-patch.mjs'

test('工具调用语法：整条拦下，代号 tool-markup', () => {
  const got = fenceText('<invoke name="fish_tone">\n<parameter name="text">嗯</parameter>\n</invoke>')
  assert.equal(got.ok, false)
  assert.equal(got.reason, 'tool-markup')
})

test('markdown 标题：拦下，代号 markdown', () => {
  const got = fenceText('## 今天总结\n吃了白饭')
  assert.equal(got.ok, false)
  assert.equal(got.reason, 'markdown')
})

test('markdown 列表：拦下，代号 markdown', () => {
  const got = fenceText('- 第一条\n- 第二条')
  assert.equal(got.ok, false)
  assert.equal(got.reason, 'markdown')
})

test('客服腔整段：拦下，代号 service-tone', () => {
  const got = fenceText('您好，请问有什么可以帮您？如有需要请随时告诉我，很高兴为您服务。')
  assert.equal(got.ok, false)
  assert.equal(got.reason, 'service-tone')
})

test('自我介绍式声明：拦下，代号 self-intro', () => {
  const got = fenceText('作为一个AI助手，我不能回答这个问题。')
  assert.equal(got.ok, false)
  assert.equal(got.reason, 'self-intro')
})

test('正常鱼话一律放行，文本原样', () => {
  for (const line of ['白饭', '才不是大肥鱼！是小鲸鱼', '哼 现在才发现']) {
    const got = fenceText(line)
    assert.equal(got.ok, true, line)
    assert.equal(got.text, line)
    assert.equal(got.reason, '')
  }
})

test('带数字和具体时间的正常话放行', () => {
  const got = fenceText('3 点 20 分才睡，现在困得要死')
  assert.equal(got.ok, true)
  assert.equal(got.text, '3 点 20 分才睡，现在困得要死')
})

test('行内标记只清标记、不拦整条', () => {
  const got = fenceText('这个 **挺好** 的，`能用`')
  assert.equal(got.ok, true)
  assert.equal(got.text, '这个 挺好 的，能用')
})

test('空串放行', () => {
  const got = fenceText('   ')
  assert.equal(got.ok, true)
  assert.equal(got.text, '')
})

test('桥补丁：可打、幂等、可原样撤掉，且补丁里带 fenceText', () => {
  const guard = extractGuard(readFileSync(join(import.meta.dirname, '..', 'lib', 'util.mjs'), 'utf8'))
  assert.ok(guard.includes('function fenceText'), '区域里要有 fenceText')
  assert.ok(!/^\s*import\s/m.test(guard), '区域必须自包含，不能有 import')
  const host = [
    "export const inject = ['session', 'tools']",
    '',
    'function 发消息() {',
    '  let 待发文字 = 标记.文字',
    '  记账(\'发\')',
    '}',
  ].join('\n')
  const patched = applyBridgePatch(host, guard)
  assert.ok(patched.includes('出站闸.fenceText'))
  assert.equal(applyBridgePatch(patched, guard), patched, '重复打补丁要幂等')
  assert.equal(revertBridgePatch(patched), host, '撤销后要和原文逐字一致')
})

test('整条都是语法就拦；语法旁边还有真话就剥掉语法放行', () => {
  assert.equal(looksLikeToolMarkup('<|tool_calls_section_begin|>'), true)
  const only = fenceText('<|tool_calls_section_begin|>\n{"name":"x","arguments":{}}\n<|tool_calls_section_end|>')
  assert.equal(only.ok, false)
  assert.equal(only.reason, 'tool-markup')
  const mixed = fenceText('先这样\n<|tool_calls_section_begin|>\n{"name":"x","arguments":{}}\n<|tool_calls_section_end|>')
  assert.equal(mixed.ok, true)
  assert.equal(mixed.text, '先这样')
})
