// 本地 HTTP 面：给设置页 / 手工调试 / 其它插件用。
// 写操作只允许 loopback（和 bridge 的设置页同一台机器）。
import { oneLine } from './util.mjs'
import { normalizeMessage } from './qq.mjs'
import { environmentView } from './env.mjs'
import { capabilityCatalog } from './capabilities.mjs'
import { dependencyCheck, updateCheck } from './doctor.mjs'
import { declareDependencies, declaredStatus, runInstall, uninstall } from './install.mjs'
import { listDir, listRoots } from './fspick.mjs'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress || '')
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function reply(res, status, value) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(value))
}

export function buildRoutes({ loader, qq, whale, world, configStore, market, stickers, links, environment, personaStore, growth, sandbox, platforms, voice, portrait, astrbot, bus, deliverInbound, home, profile, storage, activity, records }) {
  const prefix = '/dsh-fish-world'

  const state = {
    kind: 'exact',
    path: `${prefix}/state`,
    handler: async (req, res) => reply(res, 200, await loader.status()),
  }

  const capabilities = {
    kind: 'exact',
    path: `${prefix}/capabilities`,
    handler: async (_req, res) => reply(res, 200, { ok: true, ...capabilityCatalog() }),
  }

  const extensions = {
    kind: 'exact',
    path: `${prefix}/extensions`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      reply(res, 200, { ok: true, extensions: loader.list() })
    },
  }

  const persona = {
    kind: 'exact',
    path: `${prefix}/persona`,
    handler: async (req, res) => reply(res, 200, { ok: true, persona: whale.persona(), summary: whale.summary() }),
  }

  const health = {
    kind: 'exact',
    path: `${prefix}/health`,
    handler: async (req, res) => reply(res, 200, {
      ok: true,
      ready: loader.isReady(),
      bridge: qq.snapshot(),
      extensions: loader.list().length,
      environment: environmentView(environment?.status?.() || null),
    }),
  }

  // 面板的「重新检查」按钮和手工排查用。完整结构含本机路径，只给 loopback。
  const env = {
    kind: 'exact',
    path: `${prefix}/env`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'POST') {
        try {
          return reply(res, 200, { ok: true, environment: environment?.check?.() || null })
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error?.message || error) })
        }
      }
      reply(res, 200, { ok: true, environment: environment?.status?.() || null })
    },
  }

  const reload = {
    kind: 'exact',
    path: `${prefix}/reload`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      await loader.reload()
      reply(res, 200, { ok: true, extensions: loader.list() })
    },
  }

  const toggle = {
    kind: 'exact',
    path: `${prefix}/enable`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const id = String(body.id || '').trim()
        if (!id) return reply(res, 400, { ok: false, error: '缺少 id' })
        await loader.setEnabled(id, body.enabled !== false)
        reply(res, 200, { ok: true, extensions: loader.list() })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const send = {
    kind: 'exact',
    path: `${prefix}/send`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 256 * 1024)
        const text = String(body.text || '')
        const image = String(body.image || '')
        if (!text && !image) return reply(res, 400, { ok: false, error: '需要 text 或 image' })
        const options = { force: body.force === true }
        // HTTP 面同样只允许鱼箱内的本机图片；URL 照常。
        const receipt = text
          ? await qq.send(body.chat || '', [{ type: 'text', text }], options)
          : await qq.sendImage(body.chat || '', { url: /^https?:\/\//i.test(image) ? image : '', localPath: /^https?:\/\//i.test(image) ? '' : image }, options)
        reply(res, receipt.ok ? 200 : 502, {
          ok: receipt.ok,
          dryRun: receipt.dryRun === true,
          reason: receipt.reason,
          sent: receipt.sent,
          failed: receipt.failed,
          preview: oneLine(text || image, 120),
        })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const config = {
    kind: 'exact',
    path: `${prefix}/config`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'GET') return reply(res, 200, { ok: true, config: configStore.getConfig(), path: configStore.configPath })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const saved = configStore.saveConfig(body)
        reply(res, 200, { ok: true, config: saved })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const extensionDetail = {
    kind: 'exact',
    path: `${prefix}/extension`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const id = String(url.searchParams.get('id') || '').trim()
      if (!id) return reply(res, 400, { ok: false, error: '缺少扩展 id' })
      const detail = loader.detail(id)
      if (!detail) return reply(res, 404, { ok: false, error: `没有找到扩展：${id}` })
      reply(res, 200, { ok: true, extension: detail })
    },
  }

  const extensionSettings = {
    kind: 'exact',
    path: `${prefix}/extension/settings`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 128 * 1024)
        const id = String(body.id || '').trim()
        if (!id) return reply(res, 400, { ok: false, error: '缺少扩展 id' })
        loader.saveExtensionSettings(id, body.settings || {}, body.clearSecrets || [])
        if (body.reload !== false) await loader.reloadOne(id)
        reply(res, 200, { ok: true, extension: loader.detail(id) })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const marketLinks = {
    kind: 'exact',
    path: `${prefix}/market`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      try {
        const result = await market.links(String(url.searchParams.get('kind') || 'plugin'))
        reply(res, 200, result)
      } catch (error) {
        reply(res, error.status || 502, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const marketInstall = {
    kind: 'exact',
    path: `${prefix}/market/install`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 16 * 1024)
        const result = await market.install({ kind: String(body.kind || ''), url: String(body.url || '') })
        reply(res, 200, result)
      } catch (error) {
        reply(res, error.status || 502, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const stickerList = {
    kind: 'exact',
    path: `${prefix}/stickers`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const items = stickers.search(String(url.searchParams.get('q') || '')).map((item) => stickers.toView(item))
      reply(res, 200, { ok: true, items, summary: stickers.summary() })
    },
  }

  const stickerImage = {
    kind: 'exact',
    path: `${prefix}/sticker-image`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const item = stickers.get(String(url.searchParams.get('id') || ''))
      if (!item) return reply(res, 404, { ok: false, error: '没有找到表情图片' })
      const got = stickers.imageBytes(item.id)
      if (!got) return reply(res, 404, { ok: false, error: '没有找到表情图片' })
      const mime = got.format === 'gif' ? 'image/gif'
        : got.format === 'jpg' ? 'image/jpeg'
          : got.format === 'webp' ? 'image/webp'
            : 'image/png'
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' })
      res.end(got.bytes)
    },
  }

  const stickerCollect = {
    kind: 'exact',
    path: `${prefix}/stickers/collect`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 256 * 1024)
        const item = await stickers.add(
          { url: body.url, localPath: body.localPath, base64: body.base64, dataUrl: body.dataUrl },
          { tags: body.tags, name: body.name, note: body.note },
        )
        reply(res, 200, { ok: true, item: stickers.toView(item), summary: stickers.summary() })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 表情收藏目录：方便用户把自己的图片放进去给鱼用。
  const stickerDir = {
    kind: 'exact',
    path: `${prefix}/stickers/dir`,
    handler: async (_req, res) => {
      try {
        reply(res, 200, stickers.directoryInfo())
      } catch (error) {
        reply(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  const stickerSend = {
    kind: 'exact',
    path: `${prefix}/stickers/send`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const item = stickers.get(body.id || body.name || '')
        if (!item) return reply(res, 404, { ok: false, error: '没有找到表情' })
        const receipt = await qq.sendSticker(body.chat || '', { localPath: stickers.fileFor(item), url: '' }, { note: body.note })
        if (receipt.ok) stickers.markUsed(item.id)
        reply(res, receipt.ok ? 200 : 502, { ok: receipt.ok, dryRun: receipt.dryRun === true, reason: receipt.reason, receipt })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const stickerUpdate = {
    kind: 'exact',
    path: `${prefix}/stickers/update`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const item = stickers.get(body.id || body.name || '')
        if (!item) return reply(res, 404, { ok: false, error: '没有找到表情' })
        let updated = item
        if (Array.isArray(body.tags)) updated = stickers.updateTags(item.id, body.tags)
        if (typeof body.name === 'string') updated = stickers.updateName(item.id, body.name)
        reply(res, 200, { ok: true, item: stickers.toView(updated) })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const stickerRemove = {
    kind: 'exact',
    path: `${prefix}/stickers/remove`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const item = stickers.get(body.id || body.name || '')
        if (!item) return reply(res, 404, { ok: false, error: '没有找到表情' })
        const removed = stickers.remove(item.id)
        reply(res, 200, { ok: true, removed, summary: stickers.summary() })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const stickerLimit = {
    kind: 'exact',
    path: `${prefix}/stickers/limit`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'GET') return reply(res, 200, { ok: true, limit: stickers.limit(), remaining: stickers.remainingThisHour() })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 16 * 1024)
        const value = stickers.setLimit(body.limit)
        configStore.saveConfig({ stickers: { hourlyLimit: value } })
        reply(res, 200, { ok: true, limit: value, remaining: stickers.remainingThisHour() })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const worldStatus = {
    kind: 'exact',
    path: `${prefix}/world`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      reply(res, 200, world.status())
    },
  }

  const worldRelations = {
    kind: 'exact',
    path: `${prefix}/world/relations`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'POST') {
        try {
          const body = await readBody(req, 256 * 1024)
          const saved = world.updateRelations(body.people || body)
          reply(res, 200, { ok: true, relations: saved })
        } catch (error) {
          reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
        }
        return
      }
      reply(res, 200, { ok: true, ...world.listRelations() })
    },
  }

  const worldDiary = {
    kind: 'exact',
    path: `${prefix}/world/diary`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method !== 'GET') {
        // 日记由鱼自己写：主人只查看、阅览并加批语，不代笔。
        return reply(res, 405, { ok: false, error: '日记由鱼自己写，管理页只支持查看、阅览与批语。' })
      }
      const date = url.searchParams.get('date') || ''
      reply(res, 200, {
        ok: true,
        suggestions: world.listDiary({ suggestions: true }),
        entries: world.listDiary({ date }),
        comments: world.listDiaryComments({ date }),
        // 主人与鱼：批阅互动的时间线（不按日期过滤，始终给最近的全部互动）
        interactions: world.interactionTimeline({ limit: 40 }),
      })
    },
  }

  // 主人对日记的批语：只追加评语，不改动鱼写的原文。
  const worldDiaryComment = {
    kind: 'exact',
    path: `${prefix}/world/diary/comment`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 32 * 1024)
        const saved = world.commentDiary(String(body.id || ''), body.text, {
          actorName: body.actorName || '主人',
          quote: body.quote || '',
        })
        reply(res, 200, saved)
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const worldDiaryReview = {
    kind: 'exact',
    path: `${prefix}/world/diary/review`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 16 * 1024)
        reply(res, 200, world.reviewDiarySuggestion(String(body.id || ''), body.accept === true))
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const worldState = {
    kind: 'exact',
    path: `${prefix}/world/state`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      reply(res, 200, world.status())
    },
  }

  // 鱼的成长：可修正的理解，账本为源，索引可校验。
  const worldGrowth = {
    kind: 'exact',
    path: `${prefix}/world/growth`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 30)
        const offset = Number(url.searchParams.get('offset') || 0)
        return reply(res, 200, {
          ...growth.status(),
          ...growth.list({ limit, offset }),
          check: growth.verify(),
          materials: growth.materials({ world, limit: 12 }),
        })
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const action = String(body.action || 'record')
        if (action === 'revise') return reply(res, 200, growth.revise(String(body.id || ''), { text: body.text }))
        if (action === 'retract') return reply(res, 200, growth.retract(body.day))
        if (action === 'restore') return reply(res, 200, growth.restore(body.day))
        if (action === 'rebuild') return reply(res, 200, { ok: true, index: growth.rebuildIndex() })
        return reply(res, 200, growth.record({
          text: body.text,
          kind: body.kind,
          quote: body.quote,
          source: body.source,
        }))
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 鱼的请求：鱼提出，主人同意/拒绝，附带的语气会反馈到心情。
  const worldWishes = {
    kind: 'exact',
    path: `${prefix}/world/wishes`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET') {
        return reply(res, 200, world.wishSummary())
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 32 * 1024)
        if (body.id) {
          const result = world.decideWish(String(body.id), body.accept === true, {
            reply: body.reply || '',
            tone: body.tone || '',
          })
          return reply(res, 200, result)
        }
        const created = world.appendWish({ text: body.text, kind: body.kind, urgency: body.urgency })
        reply(res, 200, created)
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 鱼的发言 API：独立端点 + 独立密钥。读接口永不返回明文密钥。
  const fishVoice = {
    kind: 'exact',
    path: `${prefix}/fish/voice`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'GET') return reply(res, 200, voice.view())
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 32 * 1024)
        if (body.action === 'test') return reply(res, 200, await voice.test())
        const saved = voice.save({
          enabled: body.enabled,
          baseUrl: body.baseUrl,
          model: body.model,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          timeoutMs: body.timeoutMs,
          stylePrompt: body.stylePrompt,
          scenarios: body.scenarios,
          ...(Object.prototype.hasOwnProperty.call(body, 'apiKey') ? { apiKey: body.apiKey } : {}),
        })
        reply(res, 200, { ok: true, ...saved })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 鱼的头像：按心理状态选图（主人放的情绪图优先，否则角色图加滤镜）。
  const fishPortrait = {
    kind: 'exact',
    path: `${prefix}/fish/portrait`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        // 心理状态由调用方传入（面板已从 /dsh-feiyu-mood/state 取到），
        // 这样头像模块不需要依赖心情插件的内部路径。
        const dims = []
        for (const [key, value] of url.searchParams.entries()) {
          if (key.startsWith('d_')) dims.push({ key: key.slice(2), value: Number(value) })
        }
        const moodParam = url.searchParams.get('mood')
        const score = moodParam == null || moodParam === '' ? null : Number(moodParam)
        reply(res, 200, portrait.resolve({
          mood: score,
          dims,
          role: whale?.persona?.().role,
        }))
      } catch (error) {
        reply(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  // 情绪图：只在鱼世界的 mood 目录内按白名单名字取，不接受任意路径。
  const moodImage = {
    kind: 'exact',
    path: `${prefix}/mood-image`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const name = String(url.searchParams.get('name') || '').toLowerCase()
      const found = portrait.customImages()[name]
      if (!found) return reply(res, 404, { ok: false, error: '没有这个情绪图' })
      const file = join(portrait.dir(), found.file)
      try {
        const bytes = readFileSync(file)
        const mime = found.ext === 'gif' ? 'image/gif'
          : found.ext === 'webp' ? 'image/webp'
            : found.ext === 'jpg' || found.ext === 'jpeg' ? 'image/jpeg'
              : 'image/png'
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' })
        res.end(bytes)
      } catch {
        reply(res, 404, { ok: false, error: '读取情绪图失败' })
      }
    },
  }

  // 情绪图上传：把用户选的图存进情绪图目录，按情绪 key 命名。
  const portraitUpload = {
    kind: 'exact',
    path: `${prefix}/fish/portrait/upload`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 12 * 1024 * 1024)
        const saved = portrait.saveImage(String(body.emotion || ''), {
          dataUrl: body.dataUrl,
          base64: body.base64,
        })
        reply(res, 200, { ...saved, portrait: portrait.resolve({ mood: null, dims: [], role: whale?.persona?.().role }) })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const portraitRemove = {
    kind: 'exact',
    path: `${prefix}/fish/portrait/remove`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 8 * 1024)
        reply(res, 200, portrait.removeImage(String(body.emotion || '')))
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 链接收藏（资源链接）。默认来源是 StyleKit 风格库。
  const linkList = {
    kind: 'exact',
    path: `${prefix}/links`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 PUT' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      try {
        reply(res, 200, {
          ok: true,
          items: links.list({
            query: url.searchParams.get('q') || '',
            kind: url.searchParams.get('kind') || '',
          }),
          summary: links.summary(),
        })
      } catch (error) {
        reply(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  const linkCollect = {
    kind: 'exact',
    path: `${prefix}/links/collect`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 32 * 1024)
        const saved = links.add({
          url: body.url,
          title: body.title,
          note: body.note,
          tags: body.tags,
          kind: body.kind,
          source: body.source,
        })
        reply(res, 200, { ...saved, summary: links.summary() })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const linkUpdate = {
    kind: 'exact',
    path: `${prefix}/links/update`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 32 * 1024)
        reply(res, 200, links.update(String(body.id || ''), body))
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const linkRemove = {
    kind: 'exact',
    path: `${prefix}/links/remove`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      try {
        const body = await readBody(req, 8 * 1024)
        const result = links.remove(String(body.id || ''))
        reply(res, 200, { ...result, summary: links.summary() })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 一键安装依赖：声明缺失依赖并调用包管理器安装。
  const depsInstall = {
    kind: 'exact',
    path: `${prefix}/deps/install`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const resolvedHome = home || process.env.DSH_HOME || ''
      const resolvedProfile = profile || process.env.DSH_PROFILE || 'desktop'
      if (req.method === 'GET') {
        try {
          return reply(res, 200, declaredStatus({ home: resolvedHome, profile: resolvedProfile }))
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message || error) })
        }
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 8 * 1024)
        if (body.action === 'uninstall') {
          const result = uninstall({ home: resolvedHome, profile: resolvedProfile })
          return reply(res, 200, { ok: true, uninstall: result })
        }
        // 先把声明补齐（不动用户已有版本），再跑安装
        const declared = declareDependencies({
          home: resolvedHome,
          profile: resolvedProfile,
          includeOptional: body.includeOptional === true,
        })
        const installed = await runInstall({
          home: resolvedHome,
          profile: resolvedProfile,
          includeOptional: body.includeOptional === true,
        })
        reply(res, installed.ok ? 200 : 502, {
          ok: installed.ok,
          declared,
          install: installed,
          status: declaredStatus({ home: resolvedHome, profile: resolvedProfile }),
        })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  // 存储位置：鱼的工作区在哪、里面各目录是什么。主人可以在这里换根目录。
  const storageInfo = {
    kind: 'exact',
    path: `${prefix}/storage`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!storage) return reply(res, 200, { ok: false, error: '存储层未接入' })
      if (req.method === 'GET') {
        try { return reply(res, 200, storage.describe()) }
        catch (error) { return reply(res, 500, { ok: false, error: String(error?.message || error) }) }
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 8 * 1024)

        // 一键建目录：把「鱼之宝库 / 图库 / 网站链接 / 鱼与世界 / 鱼的成长」全部建出来。
        // 单独做成一个显式动作，而不是"打开面板就建"——只来看一眼不该在磁盘上留东西。
        if (body.action === 'mkdir') {
          try {
            const described = storage.describe({ create: true })
            return reply(res, 200, { ...described, created: true })
          } catch (error) {
            return reply(res, 500, {
              ok: false,
              error: '建立目录失败：' + String(error?.message || error),
            })
          }
        }

        // 三个键都只接受绝对路径；空字符串 = 恢复默认（跟随工作区 / 按根目录推导）。
        const patch = {}
        for (const key of ['root', 'gallery', 'sites']) {
          if (body[key] == null) continue
          const value = String(body[key]).trim()
          if (value && !isAbsolute(value)) return reply(res, 400, { ok: false, error: '请选择绝对路径的目录' })
          patch[key] = value
        }
        if (!Object.keys(patch).length) return reply(res, 400, { ok: false, error: '没有要保存的目录' })
        // create=true：主人刚指定完目录，顺手把结构建出来，省得还要再点一次。
        configStore.saveConfig({ storage: patch })
        let described
        try { described = storage.describe({ create: true }) } catch { described = storage.describe() }
        return reply(res, 200, { ok: true, ...described })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  // 目录选择：面板里「选择目录」用它列出本机目录树（只读、只列目录）。
  const fsRoots = {
    kind: 'exact',
    path: `${prefix}/fs/roots`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      reply(res, 200, listRoots())
    },
  }

  const fsList = {
    kind: 'exact',
    path: `${prefix}/fs/list`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const result = listDir(url.searchParams.get('path') || '')
      reply(res, result.ok ? 200 : 400, result)
    },
  }

  // 鱼的记录：主人让它记下的东西，一条一条；可改可删。
  // 另有小本本：没被回复的请求，只有主人解释且鱼认可才划掉。
  const worldRecords = {
    kind: 'exact',
    path: `${prefix}/world/records`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!records) return reply(res, 200, { ok: false, error: '记录未接入' })
      if (req.method === 'GET') {
        try {
          // 读之前先补记过期的请求：面板看到的就是最新的小本本。
          if (world && typeof records.sweepPendingWishes === 'function') {
            try { records.sweepPendingWishes(() => world.listWishes({ limit: 300 })) } catch {}
          }
          return reply(res, 200, {
            ...records.summary(),
            items: records.listMemos({ limit: 300 }),
            grudges: records.listGrudges({ limit: 200 }),
          })
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message || error) })
        }
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const action = String(body.action || 'add')
        let result
        if (action === 'update') result = records.updateMemo(String(body.id || ''), { text: body.text })
        else if (action === 'remove') result = records.removeMemo(String(body.id || ''))
        else if (action === 'explain') result = records.explainGrudge(String(body.id || ''), body.text)
        else if (action === 'accept') result = records.acceptGrudge(String(body.id || ''), { note: body.note })
        else if (action === 'add') result = records.addMemo({ text: body.text, source: body.source })
        else return reply(res, 400, { ok: false, error: `未知 action：${action}` })
        return reply(res, 200, { ...result, ...records.summary() })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  // 鱼与外界的往来留存：本地工作区里的浏览 / 互动记录。
  const worldActivity = {
    kind: 'exact',
    path: `${prefix}/world/activity`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!activity) return reply(res, 200, { ok: false, error: '留档未接入' })
      if (req.method === 'GET') {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        try {
          return reply(res, 200, {
            ...activity.status(),
            items: activity.list({
              platform: url.searchParams.get('platform') || '',
              limit: Number(url.searchParams.get('limit') || 30),
            }),
          })
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message || error) })
        }
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 32 * 1024)
        const saved = activity.append({
          platform: body.platform,
          kind: body.kind,
          text: body.text,
          url: body.url,
          ref: body.ref,
          actor: body.actor,
        })
        reply(res, 200, saved)
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  // 三个平台（QQ / B站 / 抖音）的连接状态、账号情况与开关。
  const worldPlatforms = {
    kind: 'exact',
    path: `${prefix}/platforms`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      // QQ 桥的真实账号信息：登录号、目标会话、图片方向等
      const bridgeState = (() => {
        try { return qq && typeof qq.snapshot === 'function' ? qq.snapshot() : null } catch { return null }
      })()
      const extra = { qqBridge: bridgeState }

      if (req.method !== 'POST') {
        // 登录信息需要一次真实的 OneBot 查询；失败也不影响其它字段
        let login = null
        try {
          if (qq && typeof qq.loginInfo === 'function') {
            const result = await qq.loginInfo()
            login = result && result.ok ? result : { ok: false, error: result?.error || '拿不到登录信息' }
          }
        } catch (error) {
          login = { ok: false, error: String(error?.message || error) }
        }
        return reply(res, 200, platforms.status({ ...extra, qqBridge: bridgeState ? { ...bridgeState, login } : null }))
      }

      try {
        const body = await readBody(req, 64 * 1024)
        // 安全开关（总开关 / 试运行）直接写桥的配置文件
        if (body.action === 'bridge-switch') {
          const saved = qq.setSafetySwitch(String(body.name || ''), body.value === true)
          return reply(res, 200, { ok: true, bridge: saved, ...platforms.status(extra) })
        }
        const id = String(body.id || '').trim()
        if (!id) return reply(res, 400, { ok: false, error: '缺少平台 id' })
        const saved = platforms.update(id, body.config || body.patch || {})
        reply(res, 200, { ...saved, ...platforms.status(extra) })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 体检：依赖体检离线，更新体检联网；两者都不自动安装任何东西。
  const doctorDependency = {
    kind: 'exact',
    path: `${prefix}/doctor/dependency`,
    handler: async (_req, res) => {
      try {
        const result = dependencyCheck({ home, profile, configStore })
        // 鱼箱隔离检查：确认它存在且不与任何工作区/代码目录重叠。
        const tank = sandbox ? sandbox.describe() : { root: '', exists: false }
        const worldStatus = (() => { try { return world.status() } catch { return null } })()
        const tankProblems = []
        if (!tank.root) tankProblems.push('鱼箱未初始化')
        else if (!tank.exists) tankProblems.push('鱼箱目录还不存在，首次读写时会创建')
        if (tank.root && worldStatus?.workspacePath) {
          const normalizedTank = tank.root.toLowerCase()
          const normalizedWs = String(worldStatus.workspacePath).toLowerCase()
          if (normalizedTank === normalizedWs) tankProblems.push('鱼箱不能和主人工件目录是同一个目录')
          if (normalizedWs.startsWith(normalizedTank + '\\') || normalizedWs.startsWith(normalizedTank + '/')) {
            tankProblems.push('主人工件目录落在鱼箱内，隔离不成立')
          }
        }
        reply(res, 200, {
          ...result,
          tank: {
            root: tank.root,
            exists: tank.exists,
            ok: tankProblems.length === 0,
            problems: tankProblems,
            policy: '鱼只能读写鱼箱内的相对路径；绝对路径、盘符、UNC、.. 穿越与符号链接逃逸一律拒绝',
          },
        })
      } catch (error) {
        reply(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  const doctorUpdate = {
    kind: 'exact',
    path: `${prefix}/doctor/update`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const force = url.searchParams.get('force') === '1' || req.method === 'POST'
        reply(res, 200, await updateCheck({ home, profile, configStore, force }))
      } catch (error) {
        reply(res, 500, { ok: false, error: String(error?.message || error) })
      }
    },
  }

  // 人设卡：按当前角色 id 存取，读取时一并返回角色列表便于切换。
  const fishPersona = {
    kind: 'exact',
    path: `${prefix}/fish/persona`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET') {
        const current = whale.persona().role
        const roleId = String(url.searchParams.get('role') || current?.id || 'default')
        const card = personaStore?.get(roleId) || null
        return reply(res, 200, {
          ok: true,
          roleId,
          current: current || null,
          text: card?.text || '',
          bytes: card?.bytes || 0,
          cards: personaStore?.list?.() || [],
        })
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 128 * 1024)
        const roleId = String(body.roleId || whale.persona().role?.id || 'default')
        const saved = personaStore.set(roleId, body.text)
        reply(res, 200, { ...saved, roleId })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 基础设置：鱼的名字、对主人的称呼、外显角色卡。
  const fishProfile = {
    kind: 'exact',
    path: `${prefix}/fish/profile`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method !== 'POST') {
        const cfg = configStore.getConfig()
        return reply(res, 200, {
          ok: true,
          fish: cfg.fish,
          current: whale.persona().role,
          roles: whale.summary().roles,
          ownerTitle: cfg.fish?.ownerTitle || '主人',
        })
      }
      try {
        const body = await readBody(req, 32 * 1024)
        const patch = {}
        if (body.name != null) patch.name = String(body.name).trim().slice(0, 32)
        if (body.ownerTitle != null) patch.ownerTitle = String(body.ownerTitle).trim().slice(0, 16)
        if (body.persona != null) patch.persona = String(body.persona)
        const saved = configStore.saveConfig({ fish: patch })
        reply(res, 200, {
          ok: true,
          fish: saved.fish,
          current: whale.persona().role,
          roles: whale.summary().roles,
        })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // AstrBot 接入：设置、连通性测试、token 轮换、工具清单，以及入站消息。
  const astrbotConfig = {
    kind: 'exact',
    path: `${prefix}/astrbot`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!astrbot) return reply(res, 500, { ok: false, error: 'AstrBot 模块不可用' })
      if (req.method === 'GET') return reply(res, 200, astrbot.view())
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 16 * 1024)
        if (body.action === 'rotate-token') return reply(res, 200, astrbot.rotateToken())
        if (body.action === 'test') {
          const health = await astrbot.health()
          return reply(res, health.ok ? 200 : 502, { ...astrbot.view(), health })
        }
        if (body.action === 'tools') {
          const result = await astrbot.tools()
          return reply(res, result.ok ? 200 : 502, { ok: result.ok, error: result.error || '', tools: result.tools })
        }
        const saved = astrbot.save(body.patch || body.config || body)
        reply(res, 200, saved)
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // AstrBot 桥把收到的 QQ 消息推进来。
  //
  // 这条路由和别的写接口不同：它不是「本机就等于可信」——能访问本机端口的进程很多，
  // 所以额外要求 bridge token。token 只在主人轮换时明文出现一次。
  // 主路径其实是轮询（见 index.js 的 AstrBot 收件箱），这条是给愿意配 webhook 的人用的。
  const astrbotInbound = {
    kind: 'exact',
    path: `${prefix}/astrbot/inbound`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 POST' })
      if (!astrbot) return reply(res, 500, { ok: false, error: 'AstrBot 模块不可用' })
      const expected = astrbot.token()
      if (!expected) return reply(res, 403, { ok: false, error: '还没有配置 bridge token' })
      const provided = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
      if (provided !== expected) return reply(res, 403, { ok: false, error: 'token 不正确' })
      try {
        const body = await readBody(req, 512 * 1024)
        const chatKey = String(body.chatKey || '').trim()
        const message = body.message && typeof body.message === 'object' ? body.message : null
        if (!message) return reply(res, 400, { ok: false, error: '缺少 message' })
        // 复用与 QQ 桥完全相同的归一化逻辑，入站消息在两套通道下长得一样。
        const normalized = normalizeMessage(message, chatKey)
        const event = {
          id: normalized.id,
          sessionId: String(body.sessionId || ''),
          chatKey,
          text: normalized.text,
          images: normalized.images.map((seg) => ({
            url: String(seg?.data?.url || ''),
            file: String(seg?.data?.file || ''),
          })),
          at: normalized.at || Date.now(),
          source: 'qq',
          via: 'astrbot',
          userId: normalized.userId,
          nickname: normalized.nickname,
          parts: normalized.parts,
        }
        bus?.emit?.('message.in', event)
        bus?.emit?.('session.update', { sessionId: event.sessionId, kind: 'message.in', at: event.at })
        // 真正投递给鱼：只有投递成功才算收到，否则桥插件会重试。
        let delivered = { ok: false, error: '投递未启用' }
        try {
          if (typeof deliverInbound === 'function') delivered = await deliverInbound(event)
        } catch (error) {
          delivered = { ok: false, error: String(error?.message || error) }
        }
        reply(res, delivered.ok ? 200 : 202, {
          ok: true,
          accepted: true,
          delivered: delivered.ok === true,
          deliveryError: delivered.ok ? '' : String(delivered.error || ''),
          id: event.id,
        })
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  return [state, capabilities, extensions, persona, health, env, reload, toggle, send, config, extensionDetail, extensionSettings, marketLinks, marketInstall, stickerList, stickerImage, stickerCollect, stickerSend, stickerUpdate, stickerRemove, stickerLimit, stickerDir, linkList, linkCollect, linkUpdate, linkRemove, worldStatus, worldRelations, worldDiary, worldDiaryComment, worldDiaryReview, worldWishes, worldGrowth, worldPlatforms, worldActivity, worldRecords, storageInfo, fsRoots, fsList, depsInstall, doctorDependency, doctorUpdate, fishProfile, fishPersona, fishVoice, fishPortrait, portraitUpload, portraitRemove, moodImage, worldState, astrbotConfig, astrbotInbound]
}
