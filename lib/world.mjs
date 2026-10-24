// 鱼的世界工作区数据仓。记忆/心情旧插件通过兼容目录 junction 写入本仓，
// 新增日记、关系和生理状态都直接落在 DSH 工作区内的「鱼的世界」目录。
import { randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DSH_HOME } from './paths.mjs'
import { readJson, writeJson, clampNumber } from './util.mjs'

export const WORLD_FOLDER = '鱼的世界'
const DEFAULT_PHYSICAL = {
  version: 1,
  updatedAt: null,
  lastActivityAt: null,
  values: { energy: 72, sleepiness: 24, hunger: 22, comfort: 66, stress: 18 },
  dailyEffects: {},
  history: [],
}
const PHYSICAL_LABELS = {
  energy: '精力', sleepiness: '困倦', hunger: '饱腹', comfort: '舒适', stress: '压力',
}
const RELATION_ROLES = new Set(['trusted', 'guest', 'blocked'])
const QQ_ID = /^\d{4,15}$/
const SESSION_ID = /^(?:session-)?[a-zA-Z0-9_-]{8,96}$/

function safeText(value, max = 1200) {
  return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max)
}

function cleanSessionId(value) {
  const id = String(value || '').trim()
  if (!id) return ''
  return id.startsWith('session-') ? id.slice(8) : id
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

function appendJsonLine(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const line = JSON.stringify(value) + '\n'
  let size = 0
  try { size = statSync(file).size } catch {}
  if (size + Buffer.byteLength(line) > 5 * 1024 * 1024) throw new Error('日记文件超过 5MB，请先在管理面板归档')
  writeFileSync(file, line, { encoding: 'utf8', flag: 'a' })
}

function copyTreeNoOverwrite(source, target, conflictRoot) {
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const src = join(source, name)
    const dest = join(target, name)
    const stat = lstatSync(src)
    if (stat.isSymbolicLink()) throw new Error(`旧数据包含符号链接，停止迁移以免越界：${name}`)
    if (stat.isDirectory()) {
      copyTreeNoOverwrite(src, dest, conflictRoot)
      continue
    }
    if (!stat.isFile()) continue
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, readFileSync(src), { flag: 'wx' })
      continue
    }
    const oldBytes = readFileSync(src)
    const newBytes = readFileSync(dest)
    if (oldBytes.equals(newBytes)) continue
    const conflict = join(conflictRoot, name + '.' + randomUUID() + '.legacy')
    mkdirSync(dirname(conflict), { recursive: true })
    writeFileSync(conflict, oldBytes, { flag: 'wx' })
  }
}

function migrateLegacyDirectory(source, target, conflictRoot, logger) {
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(source)) {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) {
      let pointsTo = ''
      try { pointsTo = resolve(realpathSync(source)) } catch {}
      if (pointsTo !== resolve(target)) unlinkSync(source)
    } else if (!stat.isDirectory()) {
      throw new Error(`旧数据路径不是目录，未改动：${source}`)
    } else if (resolve(source).toLowerCase() !== resolve(target).toLowerCase()) {
      // Move on the same volume when possible; otherwise copy+verify before
      // removing the old directory. Conflicts are preserved under Fish World.
      if (!existsSync(target)) {
        try { renameSync(source, target) }
        catch {
          copyTreeNoOverwrite(source, target, conflictRoot)
          rmSync(source, { recursive: true, force: true })
        }
      } else {
        copyTreeNoOverwrite(source, target, conflictRoot)
        rmSync(source, { recursive: true, force: true })
      }
      try { logger?.info?.(`fish-world: 已将旧目录迁入工作区：${source}`) } catch {}
    }
  }
  mkdirSync(target, { recursive: true })
  if (existsSync(source)) {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) {
      let pointsTo = ''
      try { pointsTo = resolve(realpathSync(source)) } catch {}
      if (pointsTo === resolve(target)) return
      unlinkSync(source)
    } else {
      throw new Error(`迁移后旧路径仍被占用，未覆盖：${source}`)
    }
  }
  try {
    symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    throw new Error(`无法建立工作区数据联接 ${source} → ${target}：${error.message}`)
  }
}

function workspaceRecords(registry) {
  try {
    const list = registry && typeof registry.list === 'function' ? registry.list() : []
    return Array.isArray(list) ? list.filter((item) => item && typeof item.path === 'string' && isAbsolute(item.path)) : []
  } catch { return [] }
}

export function createWorldStore({ home = DSH_HOME, qq, registry, sessions, agents, logger } = {}) {
  let workspaceRegistry = registry
  let sessionService = sessions
  let agentService = agents
  let root = ''
  let workspacePath = ''
  let ownerSession = ''
  let ownerQQ = ''
  let ready = false
  let lastError = ''
  let relData = null
  let physicalData = null

  function pathForSession(sessionId) {
    const id = String(sessionId || '')
    if (!id) return ''
    for (const workspace of workspaceRecords(workspaceRegistry)) {
      const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : []
      if (ids.includes(id) || ids.includes(cleanSessionId(id)) || ids.includes('session-' + cleanSessionId(id))) {
        return resolve(workspace.path)
      }
    }
    try {
      const session = sessionService && typeof sessionService.get === 'function' ? sessionService.get(id) : null
      if (session && typeof session.cwd === 'string' && isAbsolute(session.cwd)) return resolve(session.cwd)
    } catch {}
    try {
      const agent = agentService && typeof agentService.get === 'function' ? agentService.get(id) : null
      const cwd = agent?.session?.cwd
      if (typeof cwd === 'string' && isAbsolute(cwd)) return resolve(cwd)
    } catch {}
    return ''
  }

  function ensureWorkspace(sessionId) {
    const cwd = pathForSession(sessionId)
    if (!cwd) throw new Error('找不到目标会话所属的 DSH 工作区；请先在「设置 → 鱼的世界」里选择主人会话')
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('目标工作区目录不可用')
    // 主人已经把工作区本身命名成「鱼的世界」时，直接用它，
    // 不再套一层 鱼的世界/鱼的世界——那是重复嵌套，也是主人找不到文件的原因。
    const worldRoot = basename(cwd) === WORLD_FOLDER ? cwd : join(cwd, WORLD_FOLDER)
    const paths = {
      root: worldRoot,
      memory: join(worldRoot, '鱼的记忆'),
      diary: join(worldRoot, '鱼的日记'),
      state: join(worldRoot, '鱼的状态'),
      mood: join(worldRoot, '鱼的状态', '心理'),
      physical: join(worldRoot, '鱼的状态', '生理.json'),
      relations: join(worldRoot, '鱼的关系'),
      security: join(worldRoot, '安全与审计'),
      config: join(worldRoot, '世界设置.json'),
    }
    for (const dir of [paths.root, paths.diary, paths.state, paths.relations, paths.security]) mkdirSync(dir, { recursive: true })

    const configured = readJson(paths.config, null)
    if (!configured) writeJson(paths.config, {
      version: 1,
      scope: 'workspace-only',
      workspacePath: cwd,
      ownerSession: String(sessionId),
      ownerQQ: String(ownerQQ || ''),
      strangerPolicy: 'fish-decides',
      createdAt: new Date().toISOString(),
    })
    if (!existsSync(paths.physical)) writeJson(paths.physical, { ...DEFAULT_PHYSICAL, updatedAt: Date.now() })
    const relationFile = join(paths.relations, 'people.json')
    if (!existsSync(relationFile)) writeJson(relationFile, {
      version: 1,
      owner: { qqId: String(ownerQQ || ''), sessionId: String(sessionId) },
      people: [],
      updatedAt: new Date().toISOString(),
    })
    // Old plugins continue using their published paths, but those paths become
    // junctions into the active workspace so the actual JSON data lives there.
    const conflictRoot = join(worldRoot, '迁移备份')
    migrateLegacyDirectory(join(home, 'fish-memory'), paths.memory, join(conflictRoot, 'fish-memory'), logger)
    migrateLegacyDirectory(join(home, 'fish-memory-backup'), join(paths.memory, '备份'), join(conflictRoot, 'fish-memory-backup'), logger)
    migrateLegacyDirectory(join(home, 'feiyu-mood'), paths.mood, join(conflictRoot, 'feiyu-mood'), logger)

    root = worldRoot
    workspacePath = cwd
    ownerSession = String(sessionId)
    physicalData = readJson(paths.physical, { ...DEFAULT_PHYSICAL })
    relData = readJson(relationFile, { version: 1, owner: { qqId: String(ownerQQ || ''), sessionId: String(sessionId) }, people: [] })
    ready = true
    lastError = ''
    return status()
  }

  function initialize() {
    const bridge = qq && typeof qq.bridgeConfig === 'function' ? qq.bridgeConfig() : {}
    ownerQQ = String(bridge.私聊QQ || '').trim()
    const configuredSession = String(bridge.目标会话 || '').trim()
    if (!configuredSession) {
      lastError = '还没有配置主人会话；数据尚未创建。'
      return status()
    }
    try { return ensureWorkspace(configuredSession) }
    catch (error) {
      lastError = String(error.message || error)
      try { logger?.warn?.(`fish-world: ${lastError}`) } catch {}
      return status()
    }
  }

  function requireReady() {
    if (!ready || !root) throw new Error(lastError || '鱼的世界尚未绑定到工作区')
  }

  function relationFile() { requireReady(); return join(root, '鱼的关系', 'people.json') }
  function loadRelations() {
    if (relData) return relData
    relData = readJson(relationFile(), { version: 1, owner: { qqId: ownerQQ, sessionId: ownerSession }, people: [] })
    return relData
  }
  function saveRelations(data) {
    requireReady()
    data.updatedAt = new Date().toISOString()
    writeJson(relationFile(), data)
    relData = data
    return data
  }

  function listRelations() {
    const data = loadRelations()
    return {
      owner: data.owner || { qqId: ownerQQ, sessionId: ownerSession },
      people: Array.isArray(data.people) ? data.people.map((person) => ({
        id: person.id,
        qqId: person.qqId,
        name: person.name,
        role: person.role,
        chatKey: person.chatKey,
        sessionId: person.sessionId,
        enabled: person.enabled !== false,
        allowDiarySuggestion: person.allowDiarySuggestion === true,
        updatedAt: person.updatedAt || null,
      })) : [],
    }
  }

  function updateRelations(input) {
    requireReady()
    if (!Array.isArray(input) || input.length > 100) throw new Error('关系列表最多 100 人')
    const seen = new Set()
    const people = input.map((item) => {
      if (!item || typeof item !== 'object') throw new Error('关系条目格式错误')
      const qqId = String(item.qqId || '').trim()
      const role = String(item.role || 'guest')
      const name = safeText(item.name || qqId, 48)
      const chatKey = String(item.chatKey || `private:${qqId}`).trim()
      const sessionId = String(item.sessionId || '').trim()
      if (!QQ_ID.test(qqId)) throw new Error(`QQ号无效：${qqId}`)
      if (qqId === ownerQQ) throw new Error('主人 QQ 已由桥接配置识别，不应重复加入关系表')
      if (!RELATION_ROLES.has(role)) throw new Error(`关系等级无效：${role}`)
      if (seen.has(qqId)) throw new Error(`QQ号重复：${qqId}`)
      seen.add(qqId)
      if (!SESSION_ID.test(sessionId)) throw new Error(`请为 ${name} 填写独立的 DSH 会话 ID`)
      if (pathForSession(sessionId) !== workspacePath) throw new Error(`会话 ${sessionId} 必须属于当前工作区，避免跨工作区混合记忆`)
      let chat
      if (/^private:\d{4,15}$/.test(chatKey)) chat = chatKey
      else if (/^group:\d{4,15}$/.test(chatKey)) chat = chatKey
      else throw new Error(`聊天目标无效：${chatKey}`)
      const previous = loadRelations().people.find((person) => person.qqId === qqId)
      return {
        id: `qq-${qqId}`,
        qqId,
        name,
        role,
        chatKey: chat,
        sessionId,
        enabled: item.enabled !== false,
        allowDiarySuggestion: item.allowDiarySuggestion === true,
        createdAt: previous?.createdAt || item.createdAt || new Date().toISOString(),
        cursorAt: Number(previous?.cursorAt || item.cursorAt) || Date.now(),
        cursorMessageId: String(previous?.cursorMessageId || item.cursorMessageId || ''),
        lastReplyAt: Number(previous?.lastReplyAt) || 0,
        lastTurnAt: Number(previous?.lastTurnAt) || 0,
        dailyInfluence: previous?.dailyInfluence || {},
      }
    })
    return saveRelations({ ...loadRelations(), version: 1, owner: { qqId: ownerQQ, sessionId: ownerSession }, people })
  }

  function relationForSession(sessionId) {
    const id = String(sessionId || '')
    return (loadRelations().people || []).find((person) => person.sessionId === id && person.enabled !== false) || null
  }

  function relationForQQ(qqId) {
    return (loadRelations().people || []).find((person) => person.qqId === String(qqId) && person.enabled !== false) || null
  }

  function sessions() {
    const result = []
    const seen = new Set()
    try {
      const list = agentService && typeof agentService.list === 'function' ? agentService.list() : []
      for (const agent of list || []) {
        const id = String(agent?.session?.id || agent?.id || '')
        if (!id || seen.has(id) || pathForSession(id) !== workspacePath) continue
        seen.add(id)
        let title = ''
        try { title = String(agent?.session?.title || '') } catch {}
        result.push({ id, title })
      }
    } catch {}
    return result
  }

  function worldConfig() {
    requireReady()
    return readJson(join(root, '世界设置.json'), { scope: 'workspace-only', strangerPolicy: 'fish-decides' })
  }

  function updateWorldConfig(patch) {
    requireReady()
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('世界设置格式无效')
    const current = worldConfig()
    if (typeof patch.strangerPolicy === 'string') {
      if (!['fish-decides', 'ignore'].includes(patch.strangerPolicy)) throw new Error('陌生人策略无效')
      current.strangerPolicy = patch.strangerPolicy
    }
    if (typeof patch.workspaceOnly === 'boolean') current.workspaceOnly = patch.workspaceOnly
    current.updatedAt = new Date().toISOString()
    writeJson(join(root, '世界设置.json'), current)
    return current
  }

  function applyActivity({ actorId = '', role = 'owner', text = '', kind = 'message' } = {}) {
    requireReady()
    const file = join(root, '鱼的状态', '生理.json')
    const data = readJson(file, { ...DEFAULT_PHYSICAL })
    const now = Date.now()
    const previousAt = Number(data.lastActivityAt) || now
    const hours = Math.max(0, Math.min(24, (now - previousAt) / 3600000))
    const values = { ...DEFAULT_PHYSICAL.values, ...(data.values || {}) }
    values.energy = clampNumber(Number(values.energy) + hours * 1.2 - (kind === 'turn' ? 0.25 : 0), 0, 100, 72)
    values.sleepiness = clampNumber(Number(values.sleepiness) + hours * 0.75 + (kind === 'turn' ? 0.1 : 0), 0, 100, 24)
    values.hunger = clampNumber(Number(values.hunger) + hours * 1.1, 0, 100, 22)
    values.comfort = clampNumber(Number(values.comfort) - hours * 0.15, 0, 100, 66)
    values.stress = clampNumber(Number(values.stress) - hours * 0.35 + (kind === 'turn' ? 0.1 : 0), 0, 100, 18)

    const day = new Date(now).toISOString().slice(0, 10)
    if (role === 'trusted' && actorId) {
      const key = `${day}:${actorId}`
      const used = Number(data.dailyEffects?.[key]) || 0
      if (used < 5) {
        values.comfort = clampNumber(values.comfort + 0.5, 0, 100, 66)
        values.stress = clampNumber(values.stress - 0.25, 0, 100, 18)
        data.dailyEffects = { ...(data.dailyEffects || {}), [key]: used + 1 }
      }
    }
    data.values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value * 10) / 10]))
    data.lastActivityAt = now
    data.updatedAt = now
    data.history = [...(Array.isArray(data.history) ? data.history : []), {
      at: now, kind: safeText(kind, 24), actorId: String(actorId || ''), role: String(role || 'owner'),
      values: { ...data.values },
    }].slice(-500)
    for (const key of Object.keys(data.dailyEffects || {})) if (!key.startsWith(day + ':')) delete data.dailyEffects[key]
    writeJson(file, data)
    physicalData = data
    return data
  }

  function appendDiary({ actorId = '', actorName = '主人', role = 'owner', text = '', kind = 'entry' } = {}) {
    requireReady()
    const clean = safeText(text, 1200)
    if (!clean) throw new Error('日记内容不能为空')
    const date = new Date().toISOString().slice(0, 10)
    const isSuggestion = role === 'trusted' && kind !== 'owner-entry'
    const directory = isSuggestion ? join(root, '鱼的日记', '待主人确认') : join(root, '鱼的日记')
    const file = join(directory, `${date}.jsonl`)
    const record = {
      id: randomUUID(),
      at: new Date().toISOString(),
      actorId: String(actorId || ''),
      actorName: safeText(actorName || '主人', 48),
      sourceRole: String(role || 'owner'),
      status: isSuggestion ? 'pending' : 'approved',
      text: clean,
    }
    appendJsonLine(file, record)
    appendJsonLine(join(root, '安全与审计', `${date}.jsonl`), {
      at: record.at,
      actorId: record.actorId,
      role: record.sourceRole,
      action: isSuggestion ? 'diary-suggestion' : 'diary-write',
      recordId: record.id,
    })
    return { ok: true, suggestion: isSuggestion, record }
  }

  function listDiary({ date = '', suggestions = false, limit = 80 } = {}) {
    requireReady()
    const dir = suggestions ? join(root, '鱼的日记', '待主人确认') : join(root, '鱼的日记')
    let files = []
    try { files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse() } catch {}
    if (date) files = files.filter((name) => name === `${date}.jsonl`)
    let records = files.flatMap((name) => readLines(join(dir, name)))
    if (suggestions) records = records.filter((item) => item && item.status === 'pending')
    return records.slice(0, Math.max(1, Math.min(Number(limit) || 80, 200)))
  }

  function reviewDiarySuggestion(id, accept) {
    requireReady()
    const records = listDiary({ suggestions: true, limit: 2000 })
    const record = records.find((item) => item.id === String(id))
    if (!record || record.status !== 'pending') throw new Error('待确认日记不存在或已经处理')
    const day = String(record.at).slice(0, 10)
    const file = join(root, '鱼的日记', '待主人确认', `${day}.jsonl`)
    const all = readLines(file)
    const next = all.map((item) => item.id === record.id
      ? { ...item, status: accept === true ? 'approved' : 'rejected', reviewedAt: new Date().toISOString() }
      : item)
    writeFileSync(file, next.map((item) => JSON.stringify(item)).join('\n') + (next.length ? '\n' : ''), 'utf8')
    if (accept === true) {
      const approved = { ...record, status: 'approved', approvedAt: new Date().toISOString() }
      appendJsonLine(join(root, '鱼的日记', `${day}.jsonl`), approved)
    }
    return { ok: true, accepted: accept === true }
  }

  // 批语：主人阅览日记后留下的评语。独立文件追加写入，不修改鱼写的原文，
  // 保证日记本身始终是鱼的第一人称记录。
  //
  // 支持两种粒度：
  //  - 整篇批语：只给 text
  //  - 片段批语：给 quote（从原文截取的片段）+ text，片段必须能在原文里找到，
  //    这样鱼下次写日记时知道主人具体指的是哪一句。
  function commentDiary(id, text, { actorName = '主人', quote = '' } = {}) {
    requireReady()
    const clean = safeText(text, 500)
    if (!clean) throw new Error('批语内容不能为空')
    const target = String(id || '').trim()
    if (!target) throw new Error('缺少日记 id')
    const entry = listDiary({ limit: 2000 }).find((item) => item.id === target)
    if (!entry) throw new Error('日记不存在或还未通过确认')

    // 片段必须真实存在于原文，避免记录一段并不存在的引用。
    const source = String(entry.text || '')
    const quoted = safeText(quote, 300)
    if (quoted && !source.includes(quoted)) throw new Error('截取的片段不在日记原文里')

    const day = String(entry.at).slice(0, 10)
    const comment = {
      id: randomUUID(),
      diaryId: target,
      day,
      at: new Date().toISOString(),
      actorName: safeText(actorName, 48),
      text: clean,
      quote: quoted,
      // 鱼还没回应过；它在下次写日记时可以读走并回填 respondedAt。
      respondedAt: null,
    }
    appendJsonLine(join(root, '鱼的日记', '批语', `${day}.jsonl`), comment)
    appendJsonLine(join(root, '安全与审计', `${day}.jsonl`), {
      at: comment.at,
      actorId: '',
      role: 'owner',
      action: quoted ? 'diary-comment-quote' : 'diary-comment',
      recordId: target,
      commentId: comment.id,
      quoteLength: quoted ? quoted.length : 0,
    })
    return { ok: true, comment }
  }

  // 鱼在写下一篇日记前读这些批语：只返回还没回应过的，并附上被引用片段。
  function pendingDiaryComments({ limit = 20 } = {}) {
    requireReady()
    return listDiaryComments({}).filter((item) => item && !item.respondedAt).slice(0, limit)
  }

  // 鱼回应批语后回填 respondedAt，避免同一条批语被反复回应。
  function markDiaryCommentResponded(commentId, note = '') {
    requireReady()
    const id = String(commentId || '').trim()
    if (!id) throw new Error('缺少批语 id')
    const dir = join(root, '鱼的日记', '批语')
    let files = []
    try { files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) } catch {}
    for (const name of files) {
      const file = join(dir, name)
      const rows = readLines(file)
      const index = rows.findIndex((row) => row && row.id === id)
      if (index < 0) continue
      rows[index] = {
        ...rows[index],
        respondedAt: new Date().toISOString(),
        responseNote: safeText(note, 300),
      }
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
      return { ok: true, comment: rows[index] }
    }
    throw new Error('批语不存在')
  }

  function listDiaryComments({ date = '', diaryId = '' } = {}) {
    requireReady()
    const dir = join(root, '鱼的日记', '批语')
    let files = []
    try { files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse() } catch {}
    if (date) files = files.filter((name) => name === `${date}.jsonl`)
    let records = files.flatMap((name) => readLines(join(dir, name)))
    if (diaryId) records = records.filter((item) => item && item.diaryId === String(diaryId))
    return records.slice(0, 500)
  }

  // ---- 鱼的请求 ----
  // 鱼可以主动向主人提出请求（想做什么、想要什么）。主人同意或拒绝时，
  // 态度（解释、安慰、冷漠）会反馈到鱼的心情上。
  const WISH_VERDICTS = new Set(['approved', 'rejected'])
  // 每天最多提 3 个请求：够它表达，又不会变成刷屏。
  const DAILY_WISH_LIMIT = 3

  function wishDir(day) {
    return join(root, '鱼的请求', day || '')
  }

  function dayKeyShanghai(date = new Date()) {
    return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  }

  /** 老数据没有 day 字段，用 at 兜底，保证"今天的额度"算得对。 */
  function wishDay(item) {
    const day = String(item?.day || '').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day
    return dayKeyShanghai(new Date(item?.at || Date.now()))
  }

  function appendWish({ text, kind = 'wish', urgency = 'normal' } = {}) {
    requireReady()
    const clean = safeText(text, 600)
    if (!clean) throw new Error('请求内容不能为空')
    const now = new Date()
    const day = dayKeyShanghai(now)
    // 每天重置：只看今天已经提了几条，今天没提过就重新有 3 次。
    const todayCount = listWishes({ limit: 300 }).filter((item) => wishDay(item) === day).length
    if (todayCount >= DAILY_WISH_LIMIT) {
      throw new Error(`今天已经提了 ${DAILY_WISH_LIMIT} 个请求，明天再说吧`)
    }
    const wish = {
      id: randomUUID(),
      at: now.toISOString(),
      day,
      kind: safeText(kind, 24) || 'wish',
      urgency: ['low', 'normal', 'high'].includes(urgency) ? urgency : 'normal',
      status: 'pending',
      text: clean,
      verdict: null,
      reply: '',
      tone: '',
      decidedAt: null,
    }
    appendJsonLine(join(root, '鱼的请求', `${day}.jsonl`), wish)
    appendJsonLine(join(root, '安全与审计', `${day}.jsonl`), {
      at: wish.at,
      actorId: '',
      role: 'fish',
      action: 'wish-open',
      recordId: wish.id,
    })
    return { ok: true, wish }
  }

  function listWishes({ status = '', limit = 60 } = {}) {
    requireReady()
    const dir = join(root, '鱼的请求')
    let files = []
    try { files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse() } catch {}
    let records = files.flatMap((name) => readLines(join(dir, name)))
    if (status) records = records.filter((item) => item && item.status === status)
    return records
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 60, 300)))
  }

  // 主人裁决一条请求。tone 决定对心情的影响：
  //  - explained：有解释 -> 即使拒绝也不算伤
  //  - comforted：有安慰 -> 拒绝也能安抚
  //  - curt：冷淡打发 -> 拒绝会明显拉低
  function decideWish(id, accept, { reply = '', tone = '' } = {}) {
    requireReady()
    const target = String(id || '').trim()
    if (!target) throw new Error('缺少请求 id')
    const dir = join(root, '鱼的请求')
    let files = []
    try { files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) } catch {}
    for (const name of files) {
      const file = join(dir, name)
      const rows = readLines(file)
      const index = rows.findIndex((row) => row && row.id === target)
      if (index < 0) continue
      if (rows[index].status !== 'pending') throw new Error('这条请求已经处理过了')
      const effectiveTone = ['explained', 'comforted', 'curt'].includes(tone) ? tone : ''
      rows[index] = {
        ...rows[index],
        status: accept === true ? 'approved' : 'rejected',
        verdict: accept === true ? 'approved' : 'rejected',
        reply: safeText(reply, 300),
        tone: effectiveTone,
        decidedAt: new Date().toISOString(),
      }
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
      appendJsonLine(join(root, '安全与审计', `${name}`), {
        at: rows[index].decidedAt,
        actorId: '',
        role: 'owner',
        action: accept === true ? 'wish-approved' : 'wish-rejected',
        recordId: target,
        tone: effectiveTone,
      })
      return { ok: true, wish: rows[index], moodImpact: wishMoodImpact(accept === true, effectiveTone) }
    }
    throw new Error('请求不存在')
  }

  // 请求结果对心情的影响（0~100 的增减），用于面板展示与提醒鱼。
  function wishMoodImpact(accepted, tone) {
    if (accepted) return tone === 'comforted' ? 6 : 4
    if (tone === 'explained') return -2
    if (tone === 'comforted') return -1
    if (tone === 'curt') return -8
    return -5
  }

  function wishSummary() {
    requireReady()
    const all = listWishes({ limit: 300 })
    const pending = all.filter((item) => item.status === 'pending')
    const today = dayKeyShanghai()
    const todayWishes = all.filter((item) => wishDay(item) === today)
    // 「还没有被解释」的旧请求：过了当天还挂着 pending，就是鱼会记进小本本的那种。
    const overdue = all.filter((item) => item.status === 'pending' && wishDay(item) < today)
    return {
      ok: true,
      pending: pending.length,
      total: all.length,
      wishes: all,
      today: todayWishes.length,
      dailyLimit: DAILY_WISH_LIMIT,
      remainingToday: Math.max(0, DAILY_WISH_LIMIT - todayWishes.length),
      overdue: overdue.length,
      limitNote: `每天最多 ${DAILY_WISH_LIMIT} 个请求，零点重置。`,
    }
  }

  // ---- 主人与鱼：把主人做过的批阅互动汇成一条时间线 ----
  // 只读汇总，不产生新数据：日记批语（含片段引用）与请求裁决（含语气与答复）。
  function interactionTimeline({ limit = 40 } = {}) {
    requireReady()
    const items = []

    // 日记批语
    try {
      for (const comment of listDiaryComments({})) {
        items.push({
          id: comment.id,
          kind: 'diary-comment',
          at: comment.at || '',
          // 主人当时批的那句话
          quote: comment.quote || '',
          text: comment.text || '',
          actorName: comment.actorName || '主人',
          // 鱼是否已经回应过这条批语
          responded: comment.respondedAt != null,
          respondedAt: comment.respondedAt || null,
          diaryId: comment.diaryId || '',
        })
      }
    } catch {}

    // 请求裁决
    try {
      for (const wish of listWishes({ limit: 300 })) {
        if (wish.status === 'pending') continue
        items.push({
          id: wish.id,
          kind: wish.status === 'approved' ? 'wish-approved' : 'wish-rejected',
          at: wish.decidedAt || wish.at || '',
          quote: '',
          text: wish.text || '',
          actorName: '主人',
          reply: wish.reply || '',
          tone: wish.tone || '',
          wishStatus: wish.status,
        })
      }
    } catch {}

    items.sort((a, b) => String(b.at).localeCompare(String(a.at)))

    const counts = {
      total: items.length,
      diaryComments: items.filter((item) => item.kind === 'diary-comment').length,
      approved: items.filter((item) => item.kind === 'wish-approved').length,
      rejected: items.filter((item) => item.kind === 'wish-rejected').length,
      pendingReply: items.filter((item) => item.kind === 'diary-comment' && !item.responded).length,
    }

    return {
      ok: true,
      counts,
      items: items.slice(0, Math.max(1, Math.min(Number(limit) || 40, 200))),
    }
  }

  function status() {
    return {
      ok: ready,
      ready,
      workspacePath,
      worldPath: root,
      ownerSession,
      ownerQQ,
      scope: ready ? worldConfig().scope || 'workspace-only' : 'unbound',
      physical: ready ? readJson(join(root, '鱼的状态', '生理.json'), physicalData || DEFAULT_PHYSICAL) : null,
      relations: ready ? listRelations().people.length : 0,
      error: lastError,
    }
  }

  return {
    setServices({ registry, sessions, agents } = {}) {
      if (registry) workspaceRegistry = registry
      if (sessions) sessionService = sessions
      if (agents) agentService = agents
      return initialize()
    },
    initialize,
    status,
    pathForSession,
    isOwnerSession: (id) => cleanSessionId(id) === cleanSessionId(ownerSession),
    isInWorkspace: (id) => pathForSession(id) === workspacePath,
    ownerSession: () => ownerSession,
    ownerQQ: () => ownerQQ,
    listRelations,
    updateRelations,
    relationForSession,
    relationForQQ,
    sessions,
    worldConfig,
    updateWorldConfig,
    applyActivity,
    appendDiary,
    listDiary,
    reviewDiarySuggestion,
    commentDiary,
    listDiaryComments,
    pendingDiaryComments,
    markDiaryCommentResponded,
    appendWish,
    listWishes,
    decideWish,
    wishSummary,
    interactionTimeline,
    workspacePath: () => workspacePath,
    root: () => root,
  }
}

export const __test = { safeText, cleanSessionId, copyTreeNoOverwrite, migrateLegacyDirectory, PHYSICAL_LABELS }
