// 知识库向量模块：分词、门槛、索引作废、降级。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULTS,
  loadTransformersLibrary,
  packageEntryUrl,
  buildIndex,
  cosine,
  createEmbedder,
  lexicalScores,
  buildLexicon,
  normalizeConfig,
  search,
  tokenize,
  tokensOf,
  validateIndex,
} from '../lib/kb-vector.mjs'

const ITEMS = [
  { id: 'poke', type: 'rule', name: '被戳就戳回去', aliases: ['戳一戳', 'poke', '拍一拍'],
    meaning: '别人戳我一两下就戳回去；第三下开始哈气；再戳就不理', usage: '收到戳一戳时按次数分级回应', avoid: '别被连戳带着走' },
  { id: 'claude', type: 'meme', name: '克劳德 / Claude', aliases: ['克劳德', '黄头发那个', '橙发'],
    meaning: '群里那条黄橙发的鱼是 Claude；蓝发那条才是我', usage: '认同人图时', avoid: '别把黄发的认成我' },
  { id: 'kfc', type: 'meme', name: 'v我50 / 疯狂星期四', aliases: ['v我50', '疯狂星期四', 'KFC'],
    meaning: '肯德基疯狂星期四的促销梗，装可怜要 50 块去吃炸鸡', usage: '周四玩梗', avoid: '别真跟人要钱' },
]

test('normalizeConfig：开着却没后端要报出来，不能假装能用', () => {
  const { problems, usable } = normalizeConfig({ enabled: true, mode: 'off' })
  assert.equal(usable, false)
  assert.ok(problems.some((p) => p.includes('没选后端')))
})

test('normalizeConfig：外网地址必须 https，本机可以 http', () => {
  const local = normalizeConfig({ enabled: true, mode: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' })
  assert.deepEqual(local.problems, [])
  const remote = normalizeConfig({ enabled: true, mode: 'openai', baseUrl: 'http://api.example.com/v1', model: 'm' })
  assert.ok(remote.problems.some((p) => p.includes('https')))
})

test('normalizeConfig：关着就是关着，默认值不动', () => {
  const { config } = normalizeConfig({})
  assert.equal(config.enabled, false)
  assert.equal(config.mode, 'off')
  assert.equal(config.budgetTokens, DEFAULTS.budgetTokens)
})

test('分词：中文带二元组，单字降权', () => {
  assert.deepEqual(tokenize('戳我'), ['戳', '戳我', '我'])
  const uni = tokensOf('戳我').filter((x) => x.t === '戳')
  assert.equal(uni[0].w, 0.35)
  assert.deepEqual(tokenize('KFC'), ['kfc'])
})

test('字面档：该中的中，蹭字的不要', () => {
  const lex = buildLexicon(ITEMS)
  const hit = lexicalScores(lex, '黄头发那个是谁')
  assert.ok(hit.get('claude').coverage >= 0.25)
  const miss = lexicalScores(lex, '今天天气怎么样')
  const passed = [...miss.entries()].filter(([, v]) => v.coverage >= 0.25 || v.absolute >= 5)
  assert.deepEqual(passed, [])
})

test('关着的时候就是字面档，不吃向量', async () => {
  const { config } = normalizeConfig({ enabled: false, mode: 'off' })
  const out = await search('疯狂星期四', { items: ITEMS, config, limit: 3 })
  assert.equal(out.backend, 'lexical')
  assert.equal(out.hits[0].id, 'kfc')
})

test('索引：模型换了、维度混了都要作废', () => {
  const good = { version: 1, model: { id: 'a', dim: 3 }, items: [{ id: 'x', vec: [1, 2, 3] }] }
  assert.equal(validateIndex(good, { id: 'a' }).ok, true)
  const changed = validateIndex(good, { id: 'b' })
  assert.equal(changed.ok, false)
  assert.ok(changed.reasons.some((r) => r.includes('模型变了')))
  const broken = validateIndex({ version: 1, model: { id: 'a', dim: 4 }, items: [{ id: 'x', vec: [1, 2, 3] }] })
  assert.equal(broken.ok, false)
})

test('余弦：正交为 0，同向为 1', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
})

test('打开后走混合档；服务挂了退回字面档并写原因', async () => {
  let fail = false
  const fetchImpl = async (url, init) => {
    if (fail) return { ok: false, status: 503, json: async () => ({}) }
    const body = JSON.parse(init.body)
    const rows = body.input.map((text, index) => ({ index, embedding: [String(text).length, 1] }))
    return { ok: true, status: 200, json: async () => ({ data: rows }) }
  }
  const { config } = normalizeConfig({ enabled: true, mode: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 't' })
  const embedder = await createEmbedder(config, { fetchImpl })
  const index = await buildIndex(ITEMS, embedder)
  assert.equal(index.model.dim, 2)

  const on = await search('疯狂星期四', { items: ITEMS, index, embedder, config })
  assert.equal(on.backend, 'hybrid')

  fail = true
  const off = await search('疯狂星期四', { items: ITEMS, index, embedder, config })
  assert.equal(off.backend, 'lexical')
  assert.ok(off.notes.some((n) => n.includes('503')))
})

test('预算裁剪要标出来，不许静默截断', async () => {
  const { config } = normalizeConfig({ enabled: false, mode: 'off', budgetTokens: 100 })
  const out = await search('戳 克劳德 肯德基', { items: ITEMS, config, limit: 10 })
  assert.equal(out.truncated, true)
  assert.ok(out.notes.some((n) => n.includes('截断')))
})

test('本地模型配置：没填模型回落到默认，相对路径不收', () => {
  // 语义变了：以前「没填模型名」算问题，现在回落到默认模型；只有真的没模型可选才算错。
  const missing = normalizeConfig({ enabled: true, mode: 'local', localModel: '' })
  assert.deepEqual(missing.problems, [])
  assert.equal(missing.config.localModel, DEFAULTS.localModel)
  const rel = normalizeConfig({ enabled: true, mode: 'local', localModel: 'x/y', localModule: '相对/目录' })
  assert.ok(rel.problems.some((p) => p.includes('绝对路径')))
  const bad = normalizeConfig({ enabled: true, mode: 'local', localModel: 'x/y', localDtype: 'bf16' })
  assert.ok(bad.problems.some((p) => p.includes('localDtype')))
  const ok = normalizeConfig({ enabled: true, mode: 'local', localModel: 'x/y' })
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.config.localDtype, 'q8')
  // 没填模型名要回落到默认，不能拿空串去问模型（那会变成上网拉一个叫 "" 的模型）
  const fallback = normalizeConfig({ enabled: true, mode: 'local' })
  assert.deepEqual(fallback.problems, [])
  assert.equal(fallback.config.localModel, DEFAULTS.localModel)
})

test('本地模型后端：走 feature-extraction + cls 池化，模型名进 id', async () => {
  const calls = []
  const fakeLib = {
    env: {},
    pipeline: async (task, model, options) => {
      calls.push({ task, model, options })
      return async (texts, opts) => {
        calls.push({ texts, opts })
        return { tolist: () => texts.map((t) => [String(t).length, 1]) }
      }
    },
  }
  const { config } = normalizeConfig({ enabled: true, mode: 'local', localModel: 'x/y' })
  const embedder = await createEmbedder(config, { loadLibrary: async () => fakeLib })
  assert.equal(embedder.id, 'local:x/y')
  assert.equal(embedder.source, 'local')
  const vectors = await embedder.embed(['abcd'])
  assert.deepEqual(vectors, [[4, 1]])
  assert.equal(embedder.dim, 2)
  assert.deepEqual(calls[0], { task: 'feature-extraction', model: 'x/y', options: { dtype: 'q8' } })
  assert.deepEqual(calls[1].opts, { pooling: 'cls', normalize: true })
})

test('本地模型返回条数不对要报错，不许拿错位的向量去算', async () => {
  const fakeLib = {
    env: {},
    pipeline: async () => async () => ({ tolist: () => [] }),
  }
  const { config } = normalizeConfig({ enabled: true, mode: 'local', localModel: 'x/y' })
  const embedder = await createEmbedder(config, { loadLibrary: async () => fakeLib })
  await assert.rejects(() => embedder.embed(['a']), /条数对不上/)
})

test('缺运行时：loadTransformersLibrary 把试过的地方说出来', async () => {
  const failing = async () => { throw new Error('Cannot find package') }
  await assert.rejects(
    () => loadTransformersLibrary({ localModule: 'C:/definitely/not/here.mjs' }, { importLib: failing }),
    (error) => /没找到 @huggingface\/transformers/.test(error.message) && /localModule:/.test(error.message),
  )
  // 显式路径先试，失败才往下走：注入了失败的 importLib 就一条都拿不到
  await assert.rejects(() => loadTransformersLibrary({}, { importLib: failing }), /直接 import: Cannot find package/)
})

test('包入口解析：条件嵌套要剥到字符串，别把 .d.ts 当代码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-entry-'))
  mkdirSync(join(dir, 'pkg', 'dist'), { recursive: true })
  writeFileSync(join(dir, 'pkg', 'package.json'), JSON.stringify({
    type: 'module',
    main: './dist/fallback.cjs',
    exports: {
      node: { import: { types: './types/x.d.ts', default: './dist/node.mjs' }, require: { default: './dist/node.cjs' } },
      default: { types: './types/x.d.ts', default: './dist/web.js' },
    },
  }), 'utf8')
  const url = packageEntryUrl(join(dir, 'pkg'))
  assert.ok(url.endsWith('/dist/node.mjs'), url)
  assert.ok(!url.endsWith('.d.ts'))
  // 只有 exports['.'] 的老写法也要认
  writeFileSync(join(dir, 'pkg', 'package.json'), JSON.stringify({ exports: { '.': { import: './dist/dot.mjs' } } }), 'utf8')
  assert.ok(packageEntryUrl(join(dir, 'pkg')).endsWith('/dist/dot.mjs'))
})
