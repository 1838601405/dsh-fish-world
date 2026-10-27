// 本地 HTTP 面：给设置页 / 手工调试 / 其它插件用。
// 写操作只允许 loopback（和 bridge 的设置页同一台机器）。
import { oneLine } from './util.mjs'
import { normalizeMessage } from './qq.mjs'
import { personaPreset, personaPresetList } from './persona-presets.mjs'
import { environmentView } from './env.mjs'
import { capabilityCatalog } from './capabilities.mjs'
import { clearUpdateCache, dependencyCheck, updateCheck } from './doctor.mjs'
import { declareDependencies, declaredStatus, runInstall, uninstall } from './install.mjs'
import { listDir, listRoots } from './fspick.mjs'
import { writeKnowledgeSecret } from './knowledge.mjs'
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
  // 头已经写出去就不能再 writeHead 第二次（会变成 ERR_STREAM_WRITE_AFTER_END，
  // 比原来那个错更难查）。典型场景：图片路由 writeHead(200) + end(bytes) 时
  // 主人中途关窗口，end() 抛错，catch 里又想 reply(404)。
  // 在这里统一防一次，比让每条路由自己记得判断可靠。
  if (res.headersSent) {
    try { res.end() } catch {}
    return
  }
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(value))
}

export function buildRoutes({ loader, qq, roles, world, configStore, market, stickers, links, environment, personaStore, growth, sandbox, platforms, portrait, astrbot, bus, deliverInbound, home, profile, storage, activity, records, knowledge, qqagent, qqInbox, stickerWishes, protocolSupervisor, qzone }) {
  const prefix = '/dsh-fish-world'

  // 角色数据是必需依赖：以前它来自可选的 whale 挂件，挂件不在就整片空
  // （头像、日记署名、人设当前角色全崩）。现在它是鱼世界自己的一等数据，
  // 缺了就是接线错误 —— 当场说清楚，不要用 ?. 把错误盖成 undefined。
  const fishRoles = roles && typeof roles.current === 'function'
    ? roles
    : {
      current: () => { throw new Error('角色服务未接上（buildRoutes 缺少 roles）') },
      list: () => [],
      summary: () => ({ current: null, roles: [] }),
    }

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
    // roles 用装饰后的那份：面板读的是 pinned / avatar / hasImage，
    // list() 给的是原始条目（pinnedAt），直接发过去面板上「置顶」永远不亮。
    handler: async (req, res) => reply(res, 200, { ok: true, role: fishRoles.current(), roles: fishRoles.summary().roles }),
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

  // QQ 空间的运行时状态：今天写过日记没、今天发过空间日记没、各额度还剩多少。
  // 面板要照着这个说话，不能让主人凭记忆猜「她今天到底发没发」。
  // 只读：开关与额度仍走 /config（qzone 那一段）与平台配置，这里不接受写。
  const qzoneStatus = {
    kind: 'exact',
    path: `${prefix}/qzone/status`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!qzone) return reply(res, 200, { ok: false, error: '空间模块未接入' })
      return reply(res, 200, { ok: true, ...qzone.status() })
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
        // ?date=YYYY-MM-DD 只读那一天的历史；不带就是全部（新→旧）。
        // 每天一个文件、从不改写旧文件，所以历史本身就是归档。
        const date = String(url.searchParams.get('date') || '').trim()
        const summary = world.wishSummary()
        const days = (() => {
          try { return world.wishDays() } catch { return [] }
        })()
        if (!date) return reply(res, 200, { ...summary, days })
        return reply(res, 200, {
          ...summary,
          days,
          date,
          wishes: world.listWishes({ date, limit: 300 }),
        })
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

  // 鱼想收藏：鱼挑中的图先排队，主人在面板里点「收下」才进图库。
  const worldStickerWishes = {
    kind: 'exact',
    path: `${prefix}/world/sticker-wishes`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'GET') {
        if (!stickerWishes) return reply(res, 200, { ok: true, items: [] })
        return reply(res, 200, stickerWishes.list())
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      if (!stickerWishes) return reply(res, 500, { ok: false, error: '审批通道没接上' })
      try {
        const body = await readBody(req, 16 * 1024)
        const id = String(body.id || '')
        if (!id) return reply(res, 400, { ok: false, error: '缺少 id' })
        const result = body.accept === true ? stickerWishes.approve(id) : stickerWishes.reject(id)
        reply(res, result.ok === false ? 400 : 200, result)
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  const stickerWishImage = {
    kind: 'exact',
    path: `${prefix}/sticker-wish-image`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!stickerWishes) return reply(res, 404, { ok: false, error: '没有这张图' })
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const got = stickerWishes.imageBytes(String(url.searchParams.get('id') || ''))
      if (!got) return reply(res, 404, { ok: false, error: '没有这张图' })
      const ext = String(got.file || '').toLowerCase().split('.').pop()
      const mime = ext === 'gif' ? 'image/gif'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'webp' ? 'image/webp'
            : 'image/png'
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' })
      res.end(got.bytes)
    },
  }

  // 鱼的头像：按心情选图（主人放的情绪图优先，否则角色图加滤镜）。
  const fishPortrait = {
    kind: 'exact',
    path: `${prefix}/fish/portrait`,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        // 心情由调用方传入（面板已从 /dsh-feiyu-mood/state 取到），
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
          role: fishRoles.current(),
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

  // 角色卡：建 / 删 / 换图 / 置顶 / 设为当前。以前面板只能从「已有的角色」里挑，
  // 而角色从哪来没有任何入口——只能手改 fish-world-roles 目录。
  const fishRolesRoute = {
    kind: 'exact',
    path: `${prefix}/fish/roles`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (req.method === 'GET') return reply(res, 200, { ok: true, ...fishRoles.summary() })
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 12 * 1024 * 1024)
        const action = String(body.action || '').trim()
        const id = String(body.id || '').trim()
        if (action === 'create') {
          const role = fishRoles.create(body.name)
          return reply(res, 200, { ok: true, role, ...fishRoles.summary() })
        }
        if (action === 'remove') {
          const out = fishRoles.remove(id)
          return reply(res, 200, { ...out, ...fishRoles.summary() })
        }
        if (action === 'current') {
          const role = fishRoles.setCurrent(id)
          return reply(res, 200, { ok: true, current: role, ...fishRoles.summary() })
        }
        if (action === 'pin') {
          const role = fishRoles.pin(id, body.pinned !== false)
          return reply(res, 200, { ok: true, role, ...fishRoles.summary() })
        }
        if (action === 'image') {
          const saved = fishRoles.saveImageData(id, { dataUrl: body.dataUrl, base64: body.base64 })
          return reply(res, 200, { ...saved, ...fishRoles.summary() })
        }
        if (action === 'remove-image') {
          const out = fishRoles.removeImage(id)
          return reply(res, 200, { ...out, ...fishRoles.summary() })
        }
        return reply(res, 400, { ok: false, error: '不认识的操作：' + (action || '（空）') })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 角色图：鱼世界自己存的那份（fish-world-roles/<id>.<ext>）。
  // 不再走 /dsh-whale/* —— 那是挂件的端点，它没装或改了路径我们就取不到。
  const roleImage = {
    kind: 'exact',
    path: `${prefix}/role-image`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const id = String(url.searchParams.get('id') || 'default')
      let found
      try {
        found = fishRoles.imageFor ? fishRoles.imageFor(id) : null
      } catch {
        found = null
      }
      if (!found || !found.path) return reply(res, 404, { ok: false, error: '这个角色没有图' })
      try {
        const bytes = readFileSync(found.path)
        const mime = found.ext === 'gif' ? 'image/gif'
          : found.ext === 'webp' ? 'image/webp'
            : found.ext === 'jpg' || found.ext === 'jpeg' ? 'image/jpeg'
              : 'image/png'
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' })
        res.end(bytes)
      } catch {
        reply(res, 404, { ok: false, error: '读取角色图失败' })
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
        reply(res, 200, { ...saved, portrait: portrait.resolve({ mood: null, dims: [], role: fishRoles.current() }) })
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
          // 依赖变了，之前查到的版本结果就过期了：不清掉会让不带 force 的调用读到 10 分钟前的旧数。
          clearUpdateCache()
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
        if (installed.ok) clearUpdateCache()
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

  // 目录与索引体检：目录在不在、能不能写、索引文件是否完好。
  // GET 只读审计；POST action=repair 建立/修复；POST root=... 换位置。
  const doctorStorage = {
    kind: 'exact',
    path: `${prefix}/doctor/storage`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!storage) return reply(res, 200, { ok: false, error: '存储层未接入' })

      const growthCheck = () => {
        try { return growth?.verify?.() || null } catch (error) {
          return { ok: false, problems: [String(error?.message || error)] }
        }
      }

      if (req.method === 'GET') {
        try {
          // 第一次使用（根目录还不存在、也没自定义位置）时自动建好结构，
          // 免得主人一进来就看到一排「缺失」。已存在就只读，不写盘。
          let autoCreated = false
          const before = storage.audit()
          if (!before.exists && !before.configured) {
            try { storage.ensure(); autoCreated = !storage.audit().problems.length } catch {}
          }
          const audit = storage.audit()
          const growthState = growthCheck()
          return reply(res, 200, { ok: true, autoCreated, audit, growth: growthState })
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message || error) })
        }
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })

      try {
        const body = await readBody(req, 8 * 1024)

        // 换目录：先校验绝对路径，再保存并建立结构。
        // 只建目录，不搬旧数据 —— 实测过：带上 adopt 会把 $DSH_HOME 下的历史收藏
        // 整份复制进新目录，主人只是想换个位置，不该凭空多出上百个文件。
        if (Object.prototype.hasOwnProperty.call(body, 'root')) {
          const value = String(body.root || '').trim()
          if (value && !isAbsolute(value)) return reply(res, 400, { ok: false, error: '请选择绝对路径的目录' })
          configStore.saveConfig({ storage: { root: value } })
          try { storage.ensure({ adopt: false }) } catch {}
          return reply(res, 200, { ok: true, audit: storage.audit(), growth: growthCheck() })
        }

        // 建立 / 修复：建目录；成长索引与账本不一致时重建。
        // 这里同样不搬历史数据（adopt=false）——修目录不等于搬家。
        if (body.action === 'repair' || body.action === 'mkdir') {
          const created = []
          const auditBefore = storage.audit()
          for (const dir of auditBefore.dirs) if (!dir.exists) created.push(dir.label)
          try { storage.ensure({ adopt: false }) } catch (error) {
            return reply(res, 500, { ok: false, error: '建立目录失败：' + String(error?.message || error) })
          }
          let rebuilt = false
          try {
            const state = growthCheck()
            if (state && state.ok === false && typeof growth?.rebuildIndex === 'function') {
              growth.rebuildIndex()
              rebuilt = true
            }
          } catch {}
          return reply(res, 200, {
            ok: true,
            created,
            rebuilt,
            audit: storage.audit(),
            growth: growthCheck(),
          })
        }

        return reply(res, 400, { ok: false, error: '没有要执行的动作' })
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

  // 知识库：看状态、开关向量档、重建索引。密钥不进这里，只在 status 里回 hasKey。
  const worldKnowledge = {
    kind: 'exact',
    path: `${prefix}/world/knowledge`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!knowledge) return reply(res, 200, { ok: false, error: '知识库未接入' })
      if (req.method === 'GET') {
        try {
          return reply(res, 200, { ok: true, ...knowledge.status(), config: configStore.getConfig ? configStore.getConfig().knowledge : null })
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message || error) })
        }
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 32 * 1024)
        // 索引的三个动作分开：
        //   check   只看：索引在不在、新不新、为什么不新（不建、不写盘）
        //   update  按需：还新就什么都不做，过期了才重建
        //   rebuild 强制：不管新旧都重算一遍
        // 以前只有一个「重建索引」，想确认状态也只能硬建一遍，既慢又没必要。
        if (body && (body.action === 'check' || body.action === 'update' || body.action === 'rebuild' || body.rebuild === true)) {
          const action = body.action || 'rebuild'
          if (action === 'check') {
            const status = knowledge.status()
            return reply(res, 200, {
              ok: true,
              action,
              fresh: status.indexFresh === true,
              reason: status.indexFresh ? '' : (status.indexWhy || ''),
              index: status.index,
              ...status,
            })
          }
          if (action === 'update') {
            const made = await knowledge.ensureIndex({ force: false })
            return reply(res, made.ok ? 200 : 400, {
              action,
              rebuilt: made.rebuilt === true,
              message: made.ok ? (made.rebuilt ? '索引已更新' : '索引本来就是最新的，没有重建') : '',
              ...made,
              ...knowledge.status(),
            })
          }
          const made = await knowledge.rebuild()
          return reply(res, made.ok ? 200 : 400, { action, ...made, ...knowledge.status() })
        }
        // 远程 key 单独落盘（0600），不进主配置：空串=不改，null=清除，非空=替换。
        if (body.apiKey === null) writeKnowledgeSecret('', { home })
        else if (typeof body.apiKey === 'string' && body.apiKey.trim()) writeKnowledgeSecret(body.apiKey.trim(), { home })
        // 只认 knowledge 这一段，别让面板顺手改到别处。
        const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : (body || {})
        const current = configStore.getConfig ? configStore.getConfig().knowledge || {} : {}
        const known = ['enabled', 'mode', 'baseUrl', 'model', 'vectorsFile', 'localModel', 'localModule', 'localDir', 'localDtype', 'limit', 'weightLexical', 'weightVector', 'budgetTokens']
        const merged = { ...current }
        for (const key of known) if (patch[key] !== undefined) merged[key] = patch[key]
        configStore.saveConfig({ knowledge: merged })
        return reply(res, 200, { ok: true, ...knowledge.status() })
      } catch (error) {
        return reply(res, 400, { ok: false, error: String(error?.message || error) })
      }
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
            // 和主人相处：从同一份 QQ 留存里算，不另建台账。
            owner: activity.withOwnerStats ? activity.withOwnerStats() : null,
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
        // 抖音设置要现读一次上游（它的当前值与「读不到」的原因），失败不影响其它字段。
        await platforms.refresh()
        return reply(res, 200, platforms.status({ ...extra, qqBridge: bridgeState ? { ...bridgeState, login } : null }))
      }

      try {
        const body = await readBody(req, 64 * 1024)
        // 安全开关（总开关 / 试运行）直接写桥的配置文件
        if (body.action === 'bridge-switch') {
          const saved = qq.setSafetySwitch(String(body.name || ''), body.value === true)
          return reply(res, 200, { ok: true, bridge: saved, ...platforms.status(extra) })
        }
        // 「账号情况」那几行要能直接改（发送到 / 目标会话 / 图片收·发）。
        // 只认 lib/qq.mjs 里那份白名单，别的一律 400，错误原因原样返回给面板。
        if (body.action === 'bridge-field') {
          const saved = qq.setBridgeField(String(body.name || ''), body.value)
          return reply(res, 200, { ok: true, bridge: saved, ...platforms.status(extra) })
        }
        const id = String(body.id || '').trim()
        if (!id) return reply(res, 400, { ok: false, error: '缺少平台 id' })
        const patch = body.config || body.patch || {}
        // 先推上游：推失败就整次报错，不把本地先改成一个上游没接受的值。
        await platforms.pushUpstream(id, patch)
        const saved = platforms.update(id, patch)
        await platforms.refresh()
        reply(res, 200, { ...saved, ...platforms.status(extra) })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // 鱼与 QQ 的聊天窗口：哪些群 / 好友可以让鱼说话，各自投进哪个 DSH 会话。
  // 唯一来源是 world 的聊天目标表（鱼的关系/chats.json）——群不是「人」，
  // 所以不复用 people.json，但同在一处真相：这里读写，qq 发送白名单也只认它。
  const qqChatRoute = {
    kind: 'exact',
    path: `${prefix}/qq/chat`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!qqInbox) return reply(res, 200, { ok: false, error: '群聊模块未启用' })
      const chat = () => platforms.platform('qq')
      const view = () => ({
        ok: true,
        chat: qqInbox.status(),
        config: chat(),
        // 面板直接读这份白名单（含还没选房间的）：允许是允许，投递是投递，分开显示。
        targets: (() => {
          try { return world.chatWhitelist() } catch { return [] }
        })(),
        // 主人要从「自己已有的会话」里挑，不手填 id。
        sessions: (() => {
          try { return world.sessions() } catch { return [] }
        })(),
        ownerSession: (() => {
          try { return world.ownerSession() } catch { return '' }
        })(),
        // 主人绑定三处真源（桥 / 世界设置 / 关系表）：主人改用「鱼的设定 → 主人」，
        // 绑错了要能当场看出来，所以这份仍是只读的对照，不是第二个编辑入口。
        owner: (() => {
          try { return world.ownerBinding() } catch { return null }
        })(),
      })
      if (req.method === 'GET') return reply(res, 200, view())
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 64 * 1024)
        const action = String(body.action || '').trim()

        // 整体保存白名单：加一个群、去掉一个群、换房间，都走这一次写入。
        if (action === 'save') {
          const saved = world.updateChats(body.targets || [])
          return reply(res, 200, { ...view(), saved: saved.items })
        }

        // 重置：把白名单清空，回到「一个都没加」的初始状态。
        // 出错卡住时要有条退路，不能只能靠改文件才能恢复。
        if (action === 'reset') {
          const cleared = world.updateChats([])
          return reply(res, 200, { ...view(), saved: cleared.items })
        }

        // 直接问协议端要「鱼自己有哪些群和好友」，主人在这里勾选，不用查号。
        if (action === 'targets') {
          const [groups, friends] = await Promise.all([
            qq.call('get_group_list', {}),
            qq.call('get_friend_list', {}),
          ])
          return reply(res, 200, {
            ok: true,
            groups: groups.ok
              ? (groups.data || []).map((row) => ({
                id: String(row.group_id ?? ''),
                name: String(row.group_name || row.name || ''),
                members: Number(row.member_count) || 0,
              })).filter((row) => row.id)
              : [],
            friends: friends.ok
              ? (friends.data || []).map((row) => ({
                id: String(row.user_id ?? ''),
                name: String(row.nickname || row.card_name || ''),
                remark: String(row.remark || ''),
              })).filter((row) => row.id)
              : [],
            errors: {
              groups: groups.ok ? '' : String(groups.error || '读取失败'),
              friends: friends.ok ? '' : String(friends.error || '读取失败'),
            },
          })
        }

        if (action === 'mode') {
          platforms.update('qq', { groupReplyMode: String(body.groupReplyMode || 'shy') })
          return reply(res, 200, view())
        }

        if (action === 'tick') {
          const result = await qqInbox.tick()
          return reply(res, 200, { ...view(), tick: result })
        }

        return reply(res, 400, { ok: false, error: `不支持的操作：${action || '（空）'}` })
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

  // 协议端（SnowLuma）：面板上那个按钮走这里。
  // 不做自动守护（主人 2026-10-26）：点按钮 → 没在跑就拉起来 → 把 WebUI 地址回给
  // 面板，由它直接打开页面让人自己登录。GET 只回状态与地址，不动手。
  const protocol = {
    kind: 'exact',
    path: `${prefix}/protocol`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!protocolSupervisor) return reply(res, 200, { ok: false, error: '协议端没有配置' })
      // WebUI 端口：协议端自己的 config/webui.json；读不到就用默认 5099。
      const webui = (() => {
        try {
          const dir = String(protocolSupervisor.dir || '')
          if (!dir) return 'http://127.0.0.1:5099'
          const raw = JSON.parse(readFileSync(join(dir, 'config', 'webui.json'), 'utf8'))
          const port = Number(raw && raw.port) || 5099
          return `http://127.0.0.1:${port}`
        } catch {
          return 'http://127.0.0.1:5099'
        }
      })()
      try {
        if (req.method !== 'POST') {
          return reply(res, 200, { ok: true, status: protocolSupervisor.status(), webui })
        }
        // 点按钮：没在跑就拉起来；已经在跑就什么都不做，只把页面给出去。
        let result = { ok: true, alreadyRunning: true }
        try {
          const alive = await protocolSupervisor.tick()
          if (!alive.alive && !alive.launched && !alive.running) {
            result = await protocolSupervisor.launch({ force: true })
          }
        } catch (error) {
          result = { ok: false, error: String(error?.message || error) }
        }
        reply(res, 200, { ok: true, status: protocolSupervisor.status(), result, webui })
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
        // ?preset=<id>：取内置预设的正文（还没保存时也能先看/先填）。
        const presetId = String(url.searchParams.get('preset') || '').trim()
        if (presetId) {
          const preset = personaPreset(presetId)
          if (!preset) return reply(res, 404, { ok: false, error: '没有这个预设' })
          // 动态预设（人设只存一份）：正文取当前人设卡，不在代码里再留副本。
          const liveText = preset.dynamic ? String(personaStore?.get?.('default')?.text || '') : preset.text
          if (preset.dynamic && !liveText) {
            return reply(res, 409, { ok: false, error: '人设卡还没有内容：先在面板里写一份，或确认 default.md 存在' })
          }
          return reply(res, 200, {
            ok: true,
            presetId: preset.id,
            presetName: preset.name,
            text: liveText,
            bytes: Buffer.byteLength(liveText),
            presets: personaPresetList(),
          })
        }
        const current = fishRoles.current()
        const roleId = String(url.searchParams.get('role') || current?.id || 'default')
        const card = personaStore?.get(roleId) || null
        return reply(res, 200, {
          ok: true,
          roleId,
          current: current || null,
          text: card?.text || '',
          bytes: card?.bytes || 0,
          cards: personaStore?.list?.() || [],
          presets: personaPresetList(),
        })
      }
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 128 * 1024)
        const roleId = String(body.roleId || fishRoles.current().id || 'default')
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
      // 主人绑定（QQ 号 + 会话）与「能选哪些会话」一起给：
      // 主人是在「鱼的设定」里改这两样的，不该为了它再跑去「鱼与世界」看只读的。
      const ownerBlock = () => {
        try { return world.ownerBinding() } catch { return null }
      }
      const sessionList = () => {
        try {
          // 换主人会话时要把所有会话都列出来：万一眼下的绑定已经失效，
          // 只列本工作区的会话就是一张空表，反而没法改回来。
          return world.sessions({ all: true })
        } catch { return [] }
      }
      if (req.method !== 'POST') {
        const cfg = configStore.getConfig()
        return reply(res, 200, {
          ok: true,
          fish: cfg.fish,
          current: fishRoles.current(),
          roles: fishRoles.summary().roles,
          ownerTitle: cfg.fish?.ownerTitle || '主人',
          owner: ownerBlock(),
          sessions: sessionList(),
        })
      }
      try {
        const body = await readBody(req, 32 * 1024)
        const patch = {}
        if (body.name != null) patch.name = String(body.name).trim().slice(0, 32)
        if (body.ownerTitle != null) patch.ownerTitle = String(body.ownerTitle).trim().slice(0, 16)
        if (body.persona != null) patch.persona = String(body.persona)
        const saved = configStore.saveConfig({ fish: patch })
        // 主人绑定走另一条路：真源是 QQ 桥。传了才改，没传就不碰。
        let owner = null
        if (body.ownerQQ != null || body.ownerSession != null) {
          if (!world || typeof world.setOwner !== 'function') throw new Error('鱼的世界尚未绑定到工作区')
          world.setOwner({
            privateQQ: body.ownerQQ == null ? undefined : String(body.ownerQQ).trim(),
            targetSession: body.ownerSession == null ? undefined : String(body.ownerSession).trim(),
          })
          owner = ownerBlock()
        }
        reply(res, 200, {
          ok: true,
          fish: saved.fish,
          current: fishRoles.current(),
          roles: fishRoles.summary().roles,
          owner,
          // 改完把会话清单一起带回：会话 id 可能刚换过（旧会话被 DSH 清理）。
          sessions: sessionList(),
        })
      } catch (error) {
        reply(res, error.status || 400, { ok: false, error: String(error.message || error) })
      }
    },
  }

  // AstrBot 接入：设置、连通性测试、token 轮换、工具清单，以及入站消息。
  // QQ Agent 借手通道：配地址/token、试连、生成 token。只认本机。
  const qqagentConfig = {
    kind: 'exact',
    path: `${prefix}/qqagent`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return reply(res, 403, { ok: false, error: '只允许本机调用' })
      if (!qqagent) return reply(res, 500, { ok: false, error: 'QQ Agent 通道不可用' })
      if (req.method === 'GET') return reply(res, 200, qqagent.view())
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: '请用 GET 或 POST' })
      try {
        const body = await readBody(req, 16 * 1024)
        if (body.action === 'rotate-token') return reply(res, 200, qqagent.rotateToken())
        if (body.action === 'test') {
          const health = await qqagent.health()
          const listing = health.ok ? await qqagent.tools() : { ok: false, tools: [] }
          return reply(res, health.ok ? 200 : 502, {
            ...qqagent.view(),
            health,
            tools: Array.isArray(listing.tools) ? listing.tools : [],
          })
        }
        return reply(res, 200, qqagent.save(body || {}))
      } catch (error) {
        return reply(res, 400, { ok: false, error: String(error?.message || error) })
      }
    },
  }

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
        if (body.action === 'rotate-token') return reply(res, 200, astrbot.rotateTokenWithSecret())
        // 通道切换：astrbot / snowluma 二选一。切不过去要如实报错，不能显示切好了其实没切。
        if (body.transport) {
          try {
            return reply(res, 200, astrbot.setTransport(body.transport))
          } catch (error) {
            return reply(res, 400, { ok: false, error: String(error?.message || error), ...astrbot.view() })
          }
        }
        if (body.action === 'test') {
          const health = await astrbot.health()
          return reply(res, health.ok ? 200 : 502, { ...astrbot.view(), health })
        }
        // 一键接入：没有 token 就生成 → 探测本机哪个端口有桥 → 探到就存地址并验证。
        // 返回值里的 step / next 是给界面直接显示的「现在该干什么」。
        if (body.action === 'connect') {
          if (!astrbot.view().hasToken) astrbot.rotateTokenWithSecret()
          const found = await astrbot.probe({ ports: body.ports })
          if (!found.ok) {
            // 没找到桥：不返回 token 明文。贴到没在跑的桥上没有意义，
            // 少一次明文外发就少一次泄露面。
            return reply(res, 200, {
              ...astrbot.view(),
              connect: {
                status: 'not-found',
                step: '没在本机找到桥插件',
                next: '先在 AstrBot 装「鱼世界桥」并重载插件，装好后回来再点一次。',
                tried: found.tried,
              },
            })
          }
          if (found.match === false) {
            // 探到了桥但 token 对不上：这一种必须主人动手把 token 送过去。
            // 旧的既然对不上就直接换一把新的，把新明文给出去，省得主人去猜哪把算数。
            const fresh = astrbot.rotateTokenWithSecret()
            return reply(res, 200, {
              ...astrbot.view(),
              connect: {
                status: 'token-mismatch',
                step: `在 ${found.base} 找到了桥，但 token 对不上`,
                next: '把下面这串新 token 复制进 AstrBot 的「鱼世界桥 → 配置 → token」，保存后回来再点一次。',
                base: found.base,
                token: fresh.token,
              },
            })
          }
          // 通了：地址、启用都顺手设好，QQ 通道留给主人决定。
          astrbot.save({ baseUrl: found.base, enabled: true })
          const who = found.nickname ? `${found.nickname}（${found.userId || '未知号'}）` : '已连接'
          return reply(res, 200, {
            ...astrbot.view(),
            connect: {
              status: 'connected',
              step: `已连上 ${found.base}`,
              account: who,
              hasAdapter: found.hasAdapter,
              next: found.hasAdapter
                ? '连通正常。想让大家改走 AstrBot，打开下面的「把 AstrBot 当作 QQ 通道」即可。'
                : '连通正常，但 AstrBot 里还没接入 OneBot（aiocqhttp）适配器，先在那边把 QQ 连上。',
            },
          })
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
          // normalizeMessage 已经把图片段归一成 {url,file}，这里原样交出去。
          images: normalized.images,
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

  const routes = [state, capabilities, extensions, persona, health, env, reload, toggle, send, config, extensionDetail, extensionSettings, marketLinks, marketInstall, stickerList, stickerImage, stickerCollect, stickerSend, stickerUpdate, stickerRemove, stickerLimit, stickerDir, linkList, linkCollect, linkUpdate, linkRemove, worldStatus, qzoneStatus, worldRelations, worldDiary, worldDiaryComment, worldDiaryReview, worldWishes, worldStickerWishes, stickerWishImage, worldGrowth, worldPlatforms, qqChatRoute, worldActivity, worldRecords, worldKnowledge, qqagentConfig, storageInfo, doctorStorage, fsRoots, fsList, depsInstall, doctorDependency, doctorUpdate, protocol, fishProfile, fishPersona, fishRolesRoute, fishPortrait, portraitUpload, portraitRemove, moodImage, roleImage, worldState, astrbotConfig, astrbotInbound]

  // 每条路由都过一道兜底：handler 里任何没接住的异常（最常见的是世界还没绑定工作区，
  // world.* 一律先 requireReady() 抛错）原本会一路冒到宿主，被包成一句干巴巴的
  // 「HTTP 400」——真实原因丢掉，主人只看到「读取失败：HTTP 400」，只能猜。
  // 放在这里而不是每条 handler 里写 try：以后新加的路由自动也有，不会漏。
  return routes.map((route) => ({
    ...route,
    // 具名函数：测试可以据此确认每条路由真的过了这层包装（匿名箭头函数看不出来）。
    handler: async function guardedRoute(req, res) {
      try {
        return await route.handler(req, res)
      } catch (error) {
        // 已经写出响应头就不能再写第二次（会变成更难查的 write-after-end）
        if (res.headersSent) {
          try { res.end() } catch {}
          return
        }
        const status = Number(error?.status) || 500
        reply(res, status, { ok: false, error: String(error?.message || error || '未知错误') })
      }
    },
  }))
}
