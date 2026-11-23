// 投递兜底的模型通道判据。
//
// 2026-11-20 真机踩到：platforms.chatApi.enabled=false（主人故意关掉群聊 API，
// 让群聊走 DSH 会话）⇒ deliverViaChatApi 里的 chatApi.enabled() 一票否决
// ⇒ 场景 B（会话说没打开）永远回不了，错误只说「聊天 API 已关闭」。
//
// 语义区分：
//   platforms.chatApi.enabled = 「群聊/好友私聊由鱼世界直接调 API」—— 可以关
//   主人私聊的 API 兜底        = 「会话不在时别让人白等」—— 必须有
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('lib/index.js', 'utf8')

/** 取 `deliverViaChatApi` 的函数体（到下一个同缩进函数为止，自适应长度）。 */
function bodyOf(fnName) {
  const i = src.indexOf(`async function ${fnName}`)
  assert.ok(i > 0, `要能找到 ${fnName}`)
  const m = /\n  (?:async )?function /g
  m.lastIndex = i
  const nx = m.exec(src)
  return src.slice(i, nx ? nx.index : i + 12000)
}

test('deliverViaChatApi 用独立实例，不看 chatApi.enabled（源码级）', () => {
  const i = src.indexOf('async function deliverViaChatApi')
  assert.ok(i > 0, '要能找到 deliverViaChatApi')
  // ★ 窗口取**到下一个同缩进函数**为止，别写死字符数：
  //   2026-11-23 接鱼卡 v3 的 11 步装配后函数体变长，`deliverApi.reply` 距起点
  //   3405 字符（旧窗口 3000）⇒ 正确的代码被判红。函数边界是自适应的。
  const m = /\n  (?:async )?function /g
  m.lastIndex = i
  const nx = m.exec(src)
  const body = src.slice(i, nx ? nx.index : i + 8000)
  assert.ok(body.length > 3000, '函数体应该比旧窗口长（确认边界取对了）')

  // 不许用被开关控制的 chatApi 实例
  assert.doesNotMatch(body, /chatApi\.cfg\(\)/, '不许读 chatApi.cfg()（会带上 enabled=false）')
  assert.doesNotMatch(body, /await chatApi\.reply\(/, '不许调 chatApi.reply（会被 enabled 挡）')
  // 必须用投递专用实例
  assert.match(body, /deliverApi\.cfg\(\)/, '要用 deliverApi.cfg()')
  assert.match(body, /await deliverApi\.reply\(/, '要调 deliverApi.reply')
})

test('deliverApi 实例把 enabled 强制为 true（源码级）', () => {
  const i = src.indexOf('const deliverApi = createChatApi(')
  assert.ok(i > 0, '要有 deliverApi 实例')
  const block = src.slice(i, i + 400)
  assert.match(block, /enabled:\s*true/, 'deliverApi 必须强制 enabled=true')
  // 仍要复用同一份配置（不另存密钥）
  assert.match(block, /configStore\.getConfig\(\)\.chatApi/, '要复用同一份 chatApi 配置')
})

test('群聊路由判断仍用原 chatApi（没有被顺手改掉）', () => {
  // shouldUseChatApi 的 enabled 判断是「群聊走不走 API」，这条语义不能变
  const i = src.indexOf('function shouldUseChatApi')
  assert.ok(i > 0)
  const body = src.slice(i, i + 900)
  assert.match(body, /if \(!chatApi\.enabled\(\)\) return false/,
    '群聊路由要仍受 platforms.chatApi.enabled 控制')
})

// ══════════ 验收 1（多端①）：QQ 那条路的输出与改动前逐字节一致 ══════════
//
// ★ 「逐字节」在测试里**没法直接比对**：`deliverAny` / `deliverViaChatApi` 都在闭包里，
//   拿不到返回值。所以验收 1 落在三层（已向主人说明是弱化验收，未被否决）：
//   ① **发逻辑一行没改**：qq 通道的 send 就是 `deliverAny`（不是另写的一套）
//   ② **入口收拢**：qq-inbox 只认识「通道 qq」，不再直接引用 deliverAny
//   ③ **既有 QQ 行为判据不退**（deliver-channel 4 条 + 全量 1839）
// ★ M59：被扫的是 `lib/index.js` 的**代码行**（注释不算，注释里说明性文字是允许的）
test('★ 验收1：QQ 投递经 registry 走，且发逻辑就是原来的 deliverAny（源码级）', () => {
  const whole = src.split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')

  assert.match(whole, /const channelRegistry = createChannelRegistry\(/, '★ 要有通道 registry')
  assert.match(whole, /channelRegistry\.register\(/, '★ 注册通道')
  assert.match(whole, /id:\s*'qq'/, '★ 注册了 qq 通道')
  assert.match(whole, /async send\(reply\)\s*\{\s*return deliverAny\(reply\)/,
    '★★ 发就是原来的 deliverAny —— 没有另写一套投递逻辑（这是「逐字节一致」的前提）')
  assert.match(whole, /deliver:\s*\(payload\)\s*=>\s*channelRegistry\.send\('qq', payload\)/,
    '★★ qq-inbox 的出口走 registry（不再直接引用 deliverAny —— 平台判断收拢了）')
})
//
// ★ 为什么是源码级：`deliverViaChatApi` 是闭包，测试拿不到它的返回值去断言；
//   但**接线被删/退回占位**是真实风险（这两条判据单测全绿、生产却不生效就是这么来的）。
// ★ M59：被扫的 `lib/index.js` 注释也算输入 ⇒ 源码里刻意不写被禁的占位字面。
test('★ §5 接线：round / state / 惦记都要真的调用，且不许退回占位（源码级）', () => {
  const body = bodyOf('deliverViaChatApi')

  // 每会话状态（主人选 A：chatContext 存 round + cooldowns）
  assert.match(body, /chatContext\.state\(chatKey\)/, '★ 要读每会话状态（轮号 + 冷却）')
  assert.match(body, /chatContext\.patchState\(/, '★ 要回写 —— 不回写 cooldown 永远不生效（判据 #5）')
  assert.match(body, /const round = st\.round \+ 1/, '★ 轮号要 +1（语料只在前 3 轮也靠它）')

  // 惦记（§5；落点主人拍板）
  assert.match(body, /listThoughts\(/, '★ 要取惦记（判据 #7 的注入来源）')
  assert.match(body, /markPicked\(/, '★ 注入过的惦记要计数 —— 不计数「最多再捡一次」就是空话')

  // 不许退回占位（字面刻意没写在注释里 —— M59）
  assert.doesNotMatch(body, /round:\s*99/, '★ 轮号占位要去掉')
  assert.doesNotMatch(body, /state:\s*\{\s*\}/, '★ 冷却占位要去掉')
  // conditionIds 是回写冷却的键（装配必须交出来）
  assert.match(body, /built\.used\.conditionIds/, '★ 要用装配交出的 conditionIds 回写')
})
