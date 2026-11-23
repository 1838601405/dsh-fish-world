// DSH 会话粘图 → 视觉管线的判据（2026-11-22 主人方案 P3 第三个平台）。
//
// 这层最怕两件事，所以下面的大头是这两条：
//   ① 改了宿主的返回值 —— 主人粘的图会变成别的东西；
//   ② 旁路失败拖垮消息 —— 算缓存坏了，图就粘不进去了。
// 其余验：装不上如实说、动图不进、没工作区不猜路径、拆得干净。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  // ★ 分两档：压根没给 ctx = 调用方写错 ⇒ warn；
  //   ctx 给了但没有 get = 宿主形态差异 ⇒ **静默降级，不许写警告**
  //   （adapter.test.mjs「环境正常时启动不应写警告」抓到过我把后者喊出来）。
  const warns = []
  const silent = { warn: (m) => warns.push(m) }

  const cases = [
    { name: '没有 ctx', ctx: undefined, expect: /没有 ctx/, warn: true },
    { name: '没有 attachments 服务', ctx: fakeCtx(undefined), expect: /没有 attachments 服务/, warn: true },
    { name: '没有 admitPromptContent', ctx: fakeCtx({}), expect: /没有 admitPromptContent/, warn: true },
    { name: 'ctx.get 不是函数（宿主形态差异）', ctx: { get: 1 }, expect: null, warn: false },
  ]
  for (const c of cases) {
    warns.length = 0
    const ok = installSessionVision({ ctx: c.ctx, getWire: () => null, logger: silent })
    assert.equal(ok, false, c.name + ' 应当装不上')
    if (c.warn) {
      assert.match(warns.join('\n'), c.expect, c.name + ' 要说清缺什么')
    } else {
      assert.equal(warns.length, 0, `★ ${c.name} 是正常降级，不许写警告：${warns.join(' / ')}`)
    }
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

// ══════════ ★★ 与 read-animation 的包装共存（复用同一套栈的前提） ══════════
//
// 我复用了 `core-plugins/read-animation/patch.js` 的 wrapServiceMethod，
// 理由是它的注释写明「shared rather than copied three times」。
// 但**复用的前提是两层真的能叠**：叠不起来或拆卸互相打死，装上就会把
// read-animation 的动图展开弄坏 —— 那比不装还糟。所以这条必须验。

test('★★ 与另一层包装共存：两层都跑、拆一层不打死另一层、全拆回原样', async () => {
  const { wrapServiceMethod } = await import('../lib/core-plugins/read-animation/patch.js')

  const attachments = fakeAttachments()
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()

  // 第一层：模拟 read-animation 的包装（它包的是采样，这里只记一次调用）
  const layerA = wrapServiceMethod(attachments, 'admitPromptContent', (base) =>
    async function admitPromptContentAnimation(content) {
      const out = await base(content)
      out.forEach((p) => { p.__fromA = true })   // 留个记号证明 A 跑过
      return out
    },
  )
  assert.equal(layerA.installed, true, '第一层要装上')

  // 第二层：我的
  const ok = installSessionVision({ ctx, getWire: () => wire })
  assert.equal(ok, true, '★ 第二层要能叠上去（复用同一套栈）')

  const out = await attachments.admitPromptContent(PARTS)
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(attachments.calls.admit, 1, '★ 原实现只被调一次')
  assert.ok(out.every((p) => p.__fromA === true), '★ 第一层要跑过（没被打死）')
  assert.equal(wire.calls.ingest.length, 1, '★ 第二层也要跑过')

  // 拆第二层 → 第一层仍在
  const disposeB = ctx.effects[0].fn()
  disposeB()
  const out2 = await attachments.admitPromptContent(PARTS)
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(out2.every((p) => p.__fromA === true), '★ 拆掉我之后第一层还在工作')
  assert.equal(wire.calls.ingest.length, 1, '★ 拆掉我之后不再算缓存')

  // 拆第一层 → 回到原实现
  layerA.remove()
  const out3 = await attachments.admitPromptContent(PARTS)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(out3.every((p) => p.__fromA === undefined), true, '★ 全拆后回到原实现，不留死包装')
  assert.equal(attachments.calls.admit, 3, '★ 原实现三次都跑了')
})

// ══════════ 引用形态：2026-11-23 生产实测的根因（data=null） ══════════
//
// 宿主给的 image part 有两种：内联 base64（动图是这种）与**引用**（`data:null`、
// 只给 `attachment:{attachmentId}` —— 数据在宿主存储里）。不解析引用就恒 0/1。
// 取字节的正路（宿主源码）：`attachments.imageHostPath(ref)` → 绝对路径 | undefined。

test('★★ 引用形态（data 空 + attachment）→ 取宿主路径读字节 → 送进 ingest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refimg-'))
  const file = join(dir, 'a.png')
  // PNG 魔数 + 一点长度（够 normalizeFile 走通；这里只断言字节被搬过去了）
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]))

  const attachments = fakeAttachments()
  attachments.imageHostPath = (ref) => (ref && ref.attachmentId === 'att-0' ? file : undefined)
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  const warns = []
  installSessionVision({ ctx, getWire: () => wire, logger: { warn: (m) => warns.push(m) } })

  // 生产形状：内联字段全空，只有引用（2026-11-23 日志实测 `data=null`）
  const refParts = [{ type: 'image', data: null, mediaType: null, name: null, attachment: { attachmentId: 'att-0' } }]
  await attachments.admitPromptContent(refParts)

  assert.equal(wire.calls.ingest.length, 1, '★ 引用形态也要触发 ingest（之前恒 0/1 就卡在这）')
  const sent = wire.calls.ingest[0].files[0]
  assert.equal(typeof sent.data, 'string', '★ 字节要变成 base64 交给管线')
  assert.ok(sent.data.length > 0, '★ 读到真字节')
  assert.equal(sent.mediaType, 'image/png', '★ mediaType 从扩展名推（原值是空）')
  assert.equal(sent.name, 'a.png', '★ name 也用路径补（原值是空）')
  assert.deepEqual(warns, [], '★ 正常解析不该有警告')
})

test('★ 引用解析不出来（imageHostPath 返回 undefined）→ 不炸、ingest 不被调、不写警告', async () => {
  const attachments = fakeAttachments()
  attachments.imageHostPath = () => undefined      // 后端不是 host-file-backed
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  const warns = []
  installSessionVision({ ctx, getWire: () => wire, logger: { warn: (m) => warns.push(m) } })

  const refParts = [{ type: 'image', data: null, attachment: { attachmentId: 'att-9' } }]
  const out = await attachments.admitPromptContent(refParts)   // 不许抛

  assert.equal(wire.calls.ingest.length, 0, '★ 没字节就不送（不能送个空的进去）')
  assert.equal(out.length, 1, '★ 宿主返回值原样（旁路失败不影响消息）')
  assert.deepEqual(warns, [], '★ 这是正常降级不是错误 —— 不写警告（M6）')
  // 具体原因落在 vision-session.log（record），此处只断言没炸
})

test('★ 引用指向的文件读不到 → 不炸、宿主返回值原样（旁路绝不拖垮消息）', async () => {
  const attachments = fakeAttachments()
  attachments.imageHostPath = () => join(tmpdir(), '根本不存在的图.png')
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  const warns = []
  installSessionVision({ ctx, getWire: () => wire, logger: { warn: (m) => warns.push(m) } })

  const refParts = [{ type: 'image', data: null, attachment: { attachmentId: 'att-0' } }]
  const out = await attachments.admitPromptContent(refParts)

  assert.equal(wire.calls.ingest.length, 0, '★ 读不到就不送')
  assert.equal(out[0].attachment.attachmentId, 'att-0', '★ 宿主返回值原样')
  assert.deepEqual(warns, [], '★ 读失败是旁路的事，不写警告（消息照常）')
})

test('★★ 内联与引用混在一条消息里 → 各走各的，只送能拿到字节的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'miximg-'))
  const file = join(dir, 'b.png')
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]))

  const attachments = fakeAttachments()
  attachments.imageHostPath = () => file
  const ctx = fakeCtx(attachments)
  const wire = fakeWire()
  installSessionVision({ ctx, getWire: () => wire, logger: { warn: () => {} } })

  const mixed = [
    { type: 'text', text: '看这两张' },
    { type: 'image', data: PNG_B64, mediaType: 'image/png', name: 'inline.png' },      // ① 内联
    { type: 'image', data: null, attachment: { attachmentId: 'att-1' } },               // ② 引用
    { type: 'image', data: null },                                                      // ③ 两头都没有 → 跳过
  ]
  await attachments.admitPromptContent(mixed)

  assert.equal(wire.calls.ingest.length, 1, '★ 有能算的就触发一次')
  const files = wire.calls.ingest[0].files
  assert.equal(files.length, 2, '★ 内联 + 引用各一（text 与无字节那条不算）')
  assert.equal(files[0].name, 'inline.png', '★ 内联那条原样（没被动过）')
  assert.equal(files[1].mediaType, 'image/png', '★ 引用那条补出了 mediaType')
})

// ══════════ 仓库红线 ══════════

test('★ 源码里不许出现本机绝对路径（AGENTS 0⑤）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/vision-session.mjs', import.meta.url), 'utf8')
  const bad = src.match(/C:\\\\Users\\\\[A-Za-z0-9]+|\/home\/[A-Za-z]+|D:\\\\[A-Za-z]/g)
  assert.equal(bad, null, '★ 不许写死本机路径：' + JSON.stringify(bad))
})
