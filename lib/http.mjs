// 本地 HTTP 面：给设置页 / 手工调试 / 其它插件用。
// 写操作只允许 loopback（和 bridge 的设置页同一台机器）。
import { oneLine } from './util.mjs'
import { environmentView } from './env.mjs'
import { capabilityCatalog } from './capabilities.mjs'

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

export function buildRoutes({ loader, qq, whale, world, configStore, market, stickers, environment }) {
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
        // 日记由鱼自己写：面板只负责浏览与审批，不提供人工代写入口。
        return reply(res, 405, { ok: false, error: '日记由鱼自己写，管理页只提供浏览与审批。' })
      }
      reply(res, 200, {
        ok: true,
        suggestions: world.listDiary({ suggestions: true }),
        entries: world.listDiary({ date: url.searchParams.get('date') || '' }),
      })
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

  return [state, capabilities, extensions, persona, health, env, reload, toggle, send, config, extensionDetail, extensionSettings, marketLinks, marketInstall, stickerList, stickerImage, stickerCollect, stickerSend, stickerUpdate, stickerRemove, stickerLimit, worldStatus, worldRelations, worldDiary, worldDiaryReview, worldState]
}
