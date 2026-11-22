// DSH 会话粘图 → 视觉管线的判据（2026-11-22 主人方案 P3 第三个平台）。
//
// 这层最怕两件事，所以下面的大头是这两条：
//   ① 改了宿主的返回值 —— 主人粘的图会变成别的东西；
//   ② 旁路失败拖垮消息 —— 算缓存坏了，图就粘不进去了。
// 其余验：装不上如实说、动图不进、没工作区不猜路径、拆得干净。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installSessionVision, sessionVisionStatus } from '../lib/vision-session.mjs'

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

/** 一个像宿主 attachments 的替身：admitPromptContent 把 part 原样带上 attachment 交出去。 */
function fakeAttachments({ fail = false, readOnly = false } = {}) {
  const calls = { admit: 0 }
  const service = {
    calls,
    async admitPromptContent(content) {
      calls.admit += 1
      if (fail) throw new Error('宿主内部炸了')
      // ★ 原样透传 part、只加 attachment —— 这样断言能直接看出「有没有被改」。
      return (Array.isArray(content) ? content : []).map((part, i) => ({
        ...part,
        attachment: { attachmentId: 'att-' + i },
      }))
    },
  }
  if (readOnly) Object.defineProperty(service, 'admitPromptContent', { value: service.admitPromptContent, writable: false })
  return service
}

function fakeCtx(attachments, { captureEffect = true } = {}) {
  const effects = []
  return {
    effects,
    get(name) { return name === 'attachments' ? attachments : undefined },
    effect(fn, label) { effects.push({ fn, label }); return () => {} },
    ...(captureEffect ? {} : { effect: undefined }),
  }
}

/** 记录 ingest 被调了什么的假 wire。 */
function fakeWire({ throwOnIngest = false } = {}) {
  const calls = { ingest: [] }
  return {
    calls,
    input: {
      async ingest(source, files, opts) {
        if (throwOnIngest) throw new Error('归一化炸了')
        calls.ingest.push({ source, files, opts })
        return { entry: {}, files: [], results: [], lines: [] }
      },
    },
    vision: {},
  }
}

const PARTS = [
  { type: 'text', text: '看这个' },
  { type: 'image', data: PNG_B64, mediaType: 'image/png', name: 'a.png' },
]

// ══════════ 装配 ══════════

test('★★ 有 attachments 就装得上，返回 true', () => {
  const ctx = fakeCtx(fakeAttachments())
  const ok = installSessionVision({ ctx, getWire: () => null })
  assert.equal(ok, true)
  assert.equal(ctx.effects.length, 1, '★ 要登记 effect，插件停用时才拆得掉')
  assert.match(ctx.effects[0].label, /session vision/)
})

test('★★ 缺条件要如实返回 false 并说清缺什么，不假装装好', () => {
  const cases = [
    { name: '没有 ctx', ctx: undefined, expect: /没有 ctx/ },
    { name: 'ctx.get 不是函数', ctx: { get: 1 }, expect: /没有 ctx/ },
    { name: '没有 attachments 服务', ctx: fakeCtx(undefined), expect: /没有 attachments 服务/ },
    { name: '没有 admitPromptContent', ctx: fakeCtx({}), expect: /没有 admitPromptContent/ },
  ]
  const warns = []
  for (const c of cases) {
    warns.length = 0
    const ok = installSessionVision({ ctx: c.ctx, getWire: () => null, logger: { warn: (m) => warns.push(m) } })
    assert.equal(ok, false, c.name + ' 应当装不上')
    assert.match(warns.join('\n'), c.expect, c.name + ' 要说清缺什么')
  }
})

test('★ 属性只读（装不进去）→ 返回 false 并说明', () => {
  const warns = []
  const ok = installSessionVision({
    ctx: fakeCtx(fakeAttachments({ readOnly: true })),
    getWire: () => null,
    logger: { warn: (m) => warns.push(m) },
  })
  assert.equal(ok, false)
  assert.match(warns.join('\n'), /包装没生效|只读/)
})

// ══════════ ★★ 第一条硬规矩：返回值一个字都不改 ══════════

test('★★ 宿主的返回值原样交还（消息是主人写的就还是他写的）', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  installSessionVision({ ctx, getWire: () => wire })

  const input = [{ type: 'text', text: '看这个' }, { type: 'image', data: PNG_B64, mediaType: 'image/png' }]
  const out = await attachments.admitPromptContent(input)

  // 断言「逐字原样」：把 attachment 剥掉后，剩下的必须和入参完全相等。
  const stripped = out.map(({ attachment, ...rest }) => rest)
  assert.deepEqual(stripped, input, '★ 去掉 attachment 后必须与入参逐字相同（一个字段都没被改）')
  assert.equal(out[0].text, '看这个', '★ 文字原样')
  assert.equal(out[1].mediaType, 'image/png', '★ mediaType 原样')
  assert.equal(out[1].data, PNG_B64, '★ 字节原样')
  assert.equal(attachments.calls.admit, 1, '★ 原实现只被调一次')
})

test('★★ 没图的消息：原样返回，也不去动缓存', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  installSessionVision({ ctx, getWire: () => wire })

  const out = await attachments.admitPromptContent([{ type: 'text', text: '纯文字' }])
  assert.equal(out.length, 1)
  // 给一点时间让旁路跑完
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(wire.calls.ingest.length, 0, '★ 没图就不该去算缓存')
})

// ══════════ ★★ 第二条硬规矩：旁路失败不拖垮消息 ══════════

test('★★ 算缓存抛错 → 消息照样粘进去（不 await、有 catch）', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire({ throwOnIngest: true })
  const warns = []
  installSessionVision({ ctx, getWire: () => wire, logger: { warn: (m) => warns.push(m) } })

  const out = await attachments.admitPromptContent(PARTS)

  assert.equal(out.length, 2, '★ 消息没受影响')
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(warns.some((w) => /算缓存失败/.test(w)), '★ 失败要留痕，不静默')
  assert.ok(warns.every((w) => /不影响消息/.test(w)), '★ 措辞要说明不影响消息')
})

test('★★ getWire 返回 null（没绑工作区）→ 静默放弃，不报错不猜路径', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const warns = []
  installSessionVision({ ctx, getWire: () => null, logger: { warn: (m) => warns.push(m) } })

  await attachments.admitPromptContent(PARTS)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(warns.length, 0, '★ 没绑工作区是正常状态，不该刷警告')
})

test('★★ 宿主 admitPromptContent 自己抛错 → 原样往上抛（不吞宿主的错）', async () => {
  const attachments = fakeAttachments({ fail: true })
  const ctx = fakeCtx(attachments)
  installSessionVision({ ctx, getWire: () => fakeWire() })

  await assert.rejects(() => attachments.admitPromptContent(PARTS), /宿主内部炸了/)
})

// ══════════ 归一化口径 ══════════

test('★★ 图要被送进 ingest，且 source=session、focus 留空（与另两个入口同口径）', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  installSessionVision({ ctx, getWire: () => wire })

  await attachments.admitPromptContent(PARTS)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(wire.calls.ingest.length, 1, '★ 要算一次')
  const call = wire.calls.ingest[0]
  assert.equal(call.source, 'session')
  assert.equal(call.opts.focus, '', '★ focus 必须是空 —— 与 QQ / 桌面入口同口径，才撞得到同一缓存键')
  assert.equal(call.files.length, 1, '★ 文字块不算，只送图')
  // ★ 送进 ingest 的是**原始 part**（归一化在 ingest 内部做），所以这里验 base64 原文，
  //   不是验 bytes —— 上一版断言写成 bytes 就是把两层搞混了。
  assert.equal(call.files[0].type, 'image')
  assert.equal(call.files[0].data, PNG_B64, '★ 图的 base64 要原样送进去')
  assert.equal(call.files[0].mediaType, 'image/png')
})

test('★★ 动图不进这里（它的帧由 read-animation 展开，首帧描述是误导）', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  installSessionVision({ ctx, getWire: () => wire })

  await attachments.admitPromptContent([
    { type: 'image', data: PNG_B64, mediaType: 'image/gif' },
    { type: 'image', data: PNG_B64, mediaType: 'image/png' },
  ])
  await new Promise((r) => setTimeout(r, 30))

  const files = wire.calls.ingest[0].files
  assert.equal(files.length, 1, '★ gif 要被滤掉')
  assert.equal(files[0].mediaType, 'image/png')
})

test('★ 一次最多算 8 张（别让一条爆炸消息把预算打爆）', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  installSessionVision({ ctx, getWire: () => wire })

  const many = Array.from({ length: 20 }, (_, i) => ({
    type: 'image', data: PNG_B64, mediaType: 'image/png', name: i + '.png'
  }))
  await attachments.admitPromptContent(many)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(wire.calls.ingest[0].files.length, 8)
})

// ══════════ 拆卸 ══════════

test('★★ 拆掉包装后回到原实现（不留死包装 —— read-animation 踩过的坑）', async () => {
  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  assert.equal(installSessionVision({ ctx, getWire: () => wire }), true)

  // 走 effect 登记的拆卸
  const dispose = ctx.effects[0].fn()
  dispose()

  await attachments.admitPromptContent(PARTS)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(wire.calls.ingest.length, 0, '★ 拆掉后不再算缓存')
  assert.equal(attachments.calls.admit, 1, '★ 原实现照常工作')
})

// ══════════ 排查口 ══════════

test('★ sessionVisionStatus 报清三个条件', () => {
  const good = sessionVisionStatus(fakeCtx(fakeAttachments()))
  assert.deepEqual(good, { hasCtx: true, hasAttachments: true, hasAdmit: true })

  const noSvc = sessionVisionStatus(fakeCtx(undefined))
  assert.equal(noSvc.hasAttachments, false)
  assert.equal(noSvc.hasAdmit, false)

  assert.deepEqual(sessionVisionStatus(undefined), { hasCtx: false, hasAttachments: false, hasAdmit: false })
})

// ══════════ 仓库红线 ══════════

test('★ 源码里不许出现本机绝对路径（AGENTS 0⑤）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/vision-session.mjs', import.meta.url), 'utf8')
  const bad = src.match(/C:\\\\Users\\\\[A-Za-z0-9]+|\/home\/[A-Za-z]+|D:\\\\[A-Za-z]/g)
  assert.equal(bad, null, '★ 不许写死本机路径：' + JSON.stringify(bad))
})
