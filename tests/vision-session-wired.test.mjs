// ★★ 生产调用点判据：装配在 lib/index.js 里，光测模块本身证明不了它真的装上了。
//
// 为什么需要这一条（2026-11-22/23 的教训）：
//   · `tests/vision-session.test.mjs` 那 15 条测的是**模块** —— 模块没问题不代表调用点写对了；
//   · 第一次装配我把签名写成两个位置参数（模块收单个解构对象），15 条全绿、生产却误报
//     「没有 ctx」，拦住它的是既有的 `adapter.test.mjs`「环境正常时启动不应写警告」；
//   · 而那条也只在**警告**层面：`fakeCtx` 没有 `ctx.get`，我的模块会走静默分支直接 return false —
//     于是「没警告」既可能=装上了，也可能=压根没装。**这两种情况它分不开。**
//
// 这条判据补的正是那个洞：给 ctx 一个真的 `get('attachments')`，然后断言
// `admitPromptContent` **真的被包上了**（`isWrapped` 读的是包装层的标记）。
// 将来谁把装配删了、或又写错调用形状，这条必红。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAdapter } from '../lib/index.js'
import { isWrapped } from '../lib/core-plugins/read-animation/patch.js'

/** 一个带 get 的 ctx：能交出 attachments 服务，且看得出包装层。 */
function ctxWithAttachments() {
  const calls = { admit: 0 }
  const attachments = {
    // 宿主的 admitPromptContent：把 parts 原样交出去（形状从 admission.js 抄的）
    async admitPromptContent(content) {
      calls.admit += 1
      return (Array.isArray(content) ? content : []).map((part, i) => ({
        ...part,
        attachment: { attachmentId: 'att-' + i },
      }))
    },
    imageLimits: { maxImagesPerMessage: 20, maxImagePixels: 4096 * 4096 },
    saveImages: async () => [],
  }
  const warnings = []
  const ctx = {
    logger: { info() {}, warn: (l) => warnings.push(String(l)), error() {}, debug() {} },
    tools: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    effect(fn) { return fn() },
    inject(names, callback) {
      if (names.includes('attachments')) callback(ctx)
      return () => {}
    },
    get: (name) => (name === 'attachments' ? attachments : undefined),
  }
  return { ctx, attachments, calls, warnings }
}

test('★★ 生产调用点：ctx.get 交得出 attachments 时，admitPromptContent 真的被包上', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-wired-'))
  const profileDir = join(home, 'profiles', 'desktop')
  const modules = join(profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const pluginRoot = join(import.meta.dirname, '..')
  try {
    const { symlinkSync } = await import('node:fs')
    symlinkSync(pluginRoot, join(modules, 'dsh-fish-world'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch { /* 已存在就跳过 */ }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'p', private: true,
    dependencies: { 'dsh-fish-world': 'link:' + pluginRoot.replace(/\\/g, '/') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-fish-world'] } },
  }, null, 2), 'utf8')
  // 前置插件装齐，免得 env-check 的警告混进来
  for (const name of ['dsh-qq-bridge', 'dsh-feiyu-mood', 'dsh-fish-memory', 'dsh-bili-whale', 'dsh-bili-subagent']) {
    const dir = join(modules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '9.9.9' }), 'utf8')
  }

  const { ctx, attachments, calls, warnings } = ctxWithAttachments()
  const before = attachments.admitPromptContent

  const adapter = createAdapter(ctx, { home })
  try {
    // ★ 核心断言：方法被包装层替换了（读的是 patch.js 的 LEVEL 标记，不是函数引用 —
    //   cordis 代理每次读都会重包，比 `===` 可靠）
    assert.equal(isWrapped(attachments.admitPromptContent), true,
      '★ 装配没生效：admitPromptContent 没被包上（调用点写错了？签名？还是装配被删了？）')
    assert.notEqual(attachments.admitPromptContent, before, '包装层应当替换了原方法')

    // ★ 装上之后原实现照常工作：返回值一个字都不改
    const input = [{ type: 'text', text: '看这个' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }]
    const out = await attachments.admitPromptContent(input)
    assert.equal(calls.admit, 1, '原实现要被调到')
    assert.equal(out[0].text, '看这个', '★ 返回值原样（消息是主人写的就还是他写的）')
    assert.equal(out[1].mediaType, 'image/png')

    // 没有 ctx.get 缺失类警告（那属于正常降级，不该喊）
    assert.equal(warnings.filter((w) => /会话视觉层/.test(w)).length, 0,
      '★ 生产 ctx 有 get，不该出现「装不上」警告：' + warnings.join(' | '))
  } finally {
    await adapter.dispose()
  }
})

test('★ 对照组：ctx 没有 get 方法时静默降级（不喊、不包）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qce-wired-nget-'))
  const { ctx, warnings } = ctxWithAttachments()
  delete ctx.get                      // 模拟老宿主 / 测试替身形态
  const attachments = ctx.get
  const adapter = createAdapter(ctx, { home })
  try {
    assert.equal(warnings.filter((w) => /会话视觉层/.test(w)).length, 0,
      '★ 没有 get 是正常降级，一个字都不许喊')
  } finally {
    await adapter.dispose()
  }
  void attachments
})
