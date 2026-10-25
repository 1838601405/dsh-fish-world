// 鱼的世界工作区数据仓。记忆/心情旧插件通过兼容目录 junction 写入本仓，
// 日记、关系和心情状态都直接落在 DSH 工作区内的「鱼的世界」目录。
import { randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DSH_HOME } from './paths.mjs'
import { readJson, writeJson, clampNumber } from './util.mjs'

export const WORLD_FOLDER = '鱼的世界'
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

export function createWorldStore({ home = DSH_HOME, qq, registry, sessions, agents, sessionTitle, logger } = {}) {
  let workspaceRegistry = registry
  let sessionService = sessions
  let agentService = agents
  // DSH 的会话标题服务：面板要列出「能绑哪些房间」，靠它才有可读的名字。
  let titleService = sessionTitle
  let root = ''
  let workspacePath = ''
  let ownerSession = ''
  let ownerQQ = ''
  let ready = false
  let lastError = ''
  let relData = null
  let chatsData = null

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
      // 心情数据目录：只用于把旧版 $DSH_HOME/feiyu-mood 的数据迁进工作区。
      // 日常读写走 dsh-feiyu-mood，这里不再维护一份心情状态。
      mood: join(worldRoot, '鱼的状态', '心理'),
      relations: join(worldRoot, '鱼的关系'),
      security: join(worldRoot, '安全与审计'),
      config: join(worldRoot, '世界设置.json'),
    }
    for (const dir of [paths.root, paths.diary, paths.state, paths.relations, paths.security]) mkdirSync(dir, { recursive: true })

    // 桥是唯一真源：世界设置与关系表里的 owner 都是它的影子。
    // 以前只在「文件不存在」时写一次，于是桥换了目标会话后影子一直是旧 id，
    // 而那个旧会话会被 DSH 清掉 —— 表现为日记/请求/成长全空，只能靠翻三个文件猜。
    // 现在每次进工作区都对齐一次：影子过期就跟着桥走（这是修数据，不是覆盖主人的设置）。
    const configured = readJson(paths.config, null)
    const wantSession = String(sessionId)
    const wantQQ = String(ownerQQ || '')
    if (!configured) {
      writeJson(paths.config, {
        version: 1,
        scope: 'workspace-only',
        workspacePath: cwd,
        ownerSession: wantSession,
        ownerQQ: wantQQ,
        strangerPolicy: 'fish-decides',
        createdAt: new Date().toISOString(),
      })
    } else {
      // 只补 owner 这两项；scope / strangerPolicy / createdAt 等是主人的设置，不动。
      const patch = {}
      if (String(configured.ownerSession || '') !== wantSession) patch.ownerSession = wantSession
      if (wantQQ && String(configured.ownerQQ || '') !== wantQQ) patch.ownerQQ = wantQQ
      if (Object.keys(patch).length) {
        writeJson(paths.config, { ...configured, ...patch })
        try {
          logger?.info?.(`fish-world: 世界设置里的主人绑定已跟桥对齐（${Object.keys(patch).join(', ')}）`)
        } catch {}
      }
    }
    const relationFile = join(paths.relations, 'people.json')
    if (!existsSync(relationFile)) {
      writeJson(relationFile, {
        version: 1,
        owner: { qqId: wantQQ, sessionId: wantSession },
        people: [],
        updatedAt: new Date().toISOString(),
      })
    } else {
      // 关系表的 owner 同样只是影子：会话或 QQ 与桥不一致时跟着桥走，别让旧 id 留在这里。
      const rel = readJson(relationFile, null)
      const owner = (rel && rel.owner) || {}
      if (rel && (String(owner.sessionId || '') !== wantSession || (wantQQ && String(owner.qqId || '') !== wantQQ))) {
        writeJson(relationFile, {
          ...rel,
          owner: { ...owner, qqId: wantQQ || String(owner.qqId || ''), sessionId: wantSession },
          updatedAt: new Date().toISOString(),
        })
        try { logger?.info?.('fish-world: 关系表里的主人会话已跟桥对齐') } catch {}
      }
    }
    // Old plugins continue using their published paths, but those paths become
    // junctions into the active workspace so the actual JSON data lives there.
    const conflictRoot = join(worldRoot, '迁移备份')
    migrateLegacyDirectory(join(home, 'fish-memory'), paths.memory, join(conflictRoot, 'fish-memory'), logger)
    migrateLegacyDirectory(join(home, 'fish-memory-backup'), join(paths.memory, '备份'), join(conflictRoot, 'fish-memory-backup'), logger)
    migrateLegacyDirectory(join(home, 'feiyu-mood'), paths.mood, join(conflictRoot, 'feiyu-mood'), logger)

    root = worldRoot
    workspacePath = cwd
    ownerSession = String(sessionId)
    relData = readJson(relationFile, { version: 1, owner: { qqId: String(ownerQQ || ''), sessionId: String(sessionId) }, people: [] })
    // 换工作区要重读聊天目标，否则鱼还在往上一个工作区的房间投消息。
    chatsData = null
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

  // —— 聊天目标（鱼能在哪些群 / 好友那里说话）——
  //
  // 为什么不塞进 people.json：群不是「人」。people.json 里每条都要 QQ 号、关系等级，
  // 把群当人存会破坏那些校验，也会让「鱼认识谁」和「鱼能在哪说话」两件事互相纠缠。
  // 这里单独一份 chats.json，只管一句话：这个 QQ 会话 ↔ 投进哪个 DSH 房间。
  function chatsFile() { requireReady(); return join(root, '鱼的关系', 'chats.json') }
  function loadChats() {
    if (chatsData) return chatsData
    chatsData = readJson(chatsFile(), { version: 1, items: [] })
    return chatsData
  }
  function saveChats(items) {
    requireReady()
    const data = { version: 1, items, updatedAt: new Date().toISOString() }
    writeJson(chatsFile(), data)
    chatsData = data
    return data
  }

  const CHAT_KEY = /^(private|group):\d{4,15}$/

  /**
   * 白名单：哪些群 / 好友允许鱼说话。
   *
   * 这里只是「允许名单」，**不要求先挑房间**：先允许，再决定投到哪一间，
   * 两件事分开做。没有房间的条目先记着（`sessionId` 留空），收信时会跳过它、
   * 并在面板上标「还没选房间」，而不是直接拒绝整次保存 ——
   * 以前那样会在勾第一个群时就抛错，连白名单都加不进去。
   */
  function normalizeChats(input) {
    if (!Array.isArray(input) || input.length > 200) throw new Error('聊天目标最多 200 个')
    const seen = new Set()
    const out = []
    const ownerKey = ownerQQ ? `private:${ownerQQ}` : ''
    for (const item of input) {
      if (!item || typeof item !== 'object') throw new Error('聊天目标格式错误')
      const key = String(item.chatKey || '').trim()
      const sessionId = String(item.sessionId || '').trim()
      if (!CHAT_KEY.test(key)) throw new Error(`聊天目标无效：${key || '（空）'}`)
      // 主人自己的私聊由 QQ 桥直接负责（那是主人跟鱼说话的那条线），
      // 重复授权会让同一条消息投两次。只拦主人本人，不是拦所有私聊。
      if (ownerKey && key === ownerKey) throw new Error('主人自己的私聊由 QQ 桥负责，不需要加进白名单')
      if (sessionId && !SESSION_ID.test(sessionId)) throw new Error(`会话 id 格式不对：${sessionId}`)
      if (seen.has(key)) throw new Error(`聊天目标重复：${key}`)
      seen.add(key)
      const previous = loadChats().items.find((row) => row.chatKey === key)
      out.push({
        chatKey: key,
        kind: key.startsWith('group:') ? 'group' : 'private',
        id: key.split(':')[1],
        sessionId,
        name: safeText(item.name || '', 48),
        enabled: item.enabled !== false,
        cursorAt: Number(previous?.cursorAt || item.cursorAt) || 0,
        cursorMessageId: String(previous?.cursorMessageId || item.cursorMessageId || ''),
      })
    }
    return out
  }

  /**
   * 真正能收信的目标：白名单里启用**且已选好房间**的。
   * 没选房间的仍在名单里（面板会提示），但不参与收信 —— 否则消息投进空房间，
   * 看起来就是「加了白名单但鱼不理人」。
   */
  function chatTargets() {
    return loadChats().items.filter((item) => item.enabled !== false && item.sessionId)
  }

  /** 白名单全量（含还没选房间的）：面板要显示「已允许，待选房间」。 */
  function chatWhitelist() {
    return loadChats().items.slice()
  }

  /** 某个 DSH 会话对应哪个 QQ 目标（回话时按这个发回去）。 */
  function chatTargetForSession(sessionId) {
    const id = cleanSessionId(sessionId)
    if (!id) return null
    return chatTargets().find((item) => cleanSessionId(item.sessionId) === id) || null
  }

  /** 整体替换聊天目标：一次改完，不留半成品。 */
  function updateChats(input) {
    return saveChats(normalizeChats(input))
  }

  /** 把某个目标的读信游标推到最新一条；只改已有条目。 */
  function markChatSeen(chatKey, { at = 0, messageId = '' } = {}) {
    const key = String(chatKey || '')
    const items = loadChats().items
    let touched = false
    const next = items.map((item) => {
      if (String(item.chatKey) !== key) return item
      touched = true
      return {
        ...item,
        cursorAt: Number(at) || item.cursorAt || 0,
        cursorMessageId: String(messageId || item.cursorMessageId || ''),
      }
    })
    if (touched) saveChats(next)
    return touched
  }

  function relationForQQ(qqId) {
    return (loadRelations().people || []).find((person) => person.qqId === String(qqId) && person.enabled !== false) || null
  }

  /**
   * 本工作区的会话清单（id + 标题）。
   *
   * 标题不能读 agent.session.title —— 那里通常是空的，结果面板里一排「未命名会话」，
   * 主人根本认不出该绑哪一间。DSH 的标题由 sessionTitle 服务给出（宿主自己生成的
   * 一句话摘要），QQ 桥也是这么取的：`sessionTitle.get(session)` → `.title`。
   *
   * `all: true` 时不按工作区过滤：主人换绑「主人会话」时，要能把**所有**会话都列出来
   * —— 否则一旦眼下的主人会话失效（工作区都绑不上），清单是空的，就没法把它改回来。
   * 同时带上 `inWorkspace`，面板据此标「不在本工作区」。
   */
  function sessions({ all = false } = {}) {
    const result = []
    const seen = new Set()
    // 已归档的会话不列：归档只是藏起来，list() 里还在，混进来会让人挑到看不见的房间。
    const archived = new Set()
    try {
      for (const id of (workspaceRegistry && workspaceRegistry.archivedSessionIds) || []) archived.add(String(id))
    } catch {}
    try {
      const list = sessionService && typeof sessionService.list === 'function' ? sessionService.list() : []
      for (const session of list || []) {
        const id = String(session?.id || '')
        if (!id || seen.has(id) || archived.has(id)) continue
        const owner = workspacePath ? pathForSession(id) === workspacePath : null
        if (!all && !owner) continue
        seen.add(id)
        let title = ''
        try {
          const snapshot = titleService && typeof titleService.get === 'function' ? titleService.get(session) : undefined
          title = snapshot && snapshot.title ? String(snapshot.title) : ''
        } catch {}
        // 兜底：sessionTitle 没给（新会话还没起标题）时，用 agent 上可能存在的标题。
        if (!title) {
          try {
            const agent = agentService && typeof agentService.get === 'function' ? agentService.get(id) : null
            title = String(agent?.session?.title || '')
          } catch {}
        }
        let createdAt = 0
        try { createdAt = Number(session?.createdAt || 0) || 0 } catch {}
        const row = { id, title, createdAt }
        if (all) row.inWorkspace = owner === true
        result.push(row)
      }
    } catch {}
    return result
  }

  /**
   * 主人绑定的三处真源，一次摊开给面板看：
   *   ① 桥的「私聊 QQ 号」—— 实际收发靠它，是真源
   *   ② 世界设置.json 的 ownerQQ / ownerSession
   *   ③ 鱼的关系/people.json 的 owner
   * 三处应当一致。不一致不会立刻崩，但 2026-10-25 真断过一次
   * （世界设置里的 ownerSession 指向的会话在会话目录里已经不存在），所以必须看得见。
   */
  function ownerBinding() {
    requireReady()
    const config = worldConfig()
    const relations = loadRelations()
    const bridge = qq && typeof qq.bridgeConfig === 'function' ? qq.bridgeConfig() : {}
    const pick = (value) => String(value || '').trim()
    const qqValues = {
      bridge: pick(bridge.私聊QQ),
      config: pick(config.ownerQQ),
      relation: pick(relations.owner && relations.owner.qqId),
    }
    const sessionValues = {
      bridge: pick(bridge.目标会话),
      config: pick(config.ownerSession),
      relation: pick(relations.owner && relations.owner.sessionId),
    }
    const agree = (group) => {
      const list = Object.values(group).filter(Boolean)
      return list.length > 0 && new Set(list).size === 1
    }
    // 主人会话还活不活得下来：桥里那个 id 在 DSH 会话目录里还在不在。
    // 不在就说明这条绑定已经失效（日记/请求/成长会全空），面板要当场说出来。
    const bound = sessionValues.bridge
    let sessionAlive = null
    if (bound) {
      try {
        const alive = sessionService && typeof sessionService.get === 'function' ? sessionService.get(bound) : null
        sessionAlive = Boolean(alive)
      } catch { sessionAlive = null }
    }
    return {
      qq: qqValues,
      session: sessionValues,
      qqAgree: agree(qqValues),
      sessionAgree: agree(sessionValues),
      sessionAlive,
    }
  }

  function worldConfig() {
    requireReady()
    return readJson(join(root, '世界设置.json'), { scope: 'workspace-only', strangerPolicy: 'fish-decides' })
  }

  /**
   * 设「主人」：写 QQ 桥（真源），再重新绑定工作区让两处影子自动跟过来。
   *
   * 为什么不直接写世界设置：真源是桥——实际收发靠它的「私聊QQ / 目标会话」。
   * 直接改影子，下次进工作区会被桥又覆盖回去，等于白改。
   *
   * 校验（在写盘之前做完，写一半失败比报错更糟）：
   *   · 主人私聊号写进去就代表鱼把它当主人，必须是数字 QQ 号；
   *   · 目标会话必须是**真实存在**的会话 id —— 2026-10-25 真断过一次，
   *     主人会话指向一个已被 DSH 清掉的 id，表现是日记/请求/成长全空。
   */
  function setOwner({ privateQQ, targetSession } = {}) {
    if (!qq || typeof qq.setOwnerBinding !== 'function') throw new Error('QQ 桥不可用，改不了主人绑定')
    const wantQQ = privateQQ == null ? null : String(privateQQ).trim()
    const wantSession = targetSession == null ? null : String(targetSession).trim()
    if (wantQQ != null && wantQQ && !/^\d{5,12}$/.test(wantQQ)) throw new Error('主人私聊号要填数字 QQ 号')
    if (wantSession != null) {
      if (!wantSession) throw new Error('请选一个 DSH 会话当主人会话')
      const known = sessionService && typeof sessionService.get === 'function' ? sessionService.get(wantSession) : null
      if (!known) throw new Error('这个会话已经不存在了，换一个（DSH 会清理旧会话）')
    }
    // 写桥
    qq.setOwnerBinding({
      privateQQ: wantQQ == null ? undefined : wantQQ,
      targetSession: wantSession == null ? undefined : wantSession,
    })
    if (wantQQ != null) ownerQQ = wantQQ
    // 重新绑定：ensureWorkspace 会把世界设置与关系表里的 owner 对齐到桥，
    // 并重读聊天白名单（换工作区后旧房间不该继续收信）。
    const nextSession = wantSession != null ? wantSession : String(qq.bridgeConfig?.()?.目标会话 || ownerSession || '')
    if (!nextSession) throw new Error('还没有主人会话：世界数据建不起来')
    try {
      return ensureWorkspace(nextSession)
    } catch (error) {
      // 桥已经改了，但世界数据没跟着走 —— 这时候不能只说「失败」，否则主人以为没改。
      // 如实报「桥改了、工作区没绑上」，并说下一步该做什么。
      const reason = String(error?.message || error)
      throw new Error('QQ 桥已改成新的主人绑定，但世界数据没能重新绑定：' + reason)
    }
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

  /**
   * 请求历史。按天一个文件，天然就是归档：不删、不改旧文件，裁决结果写回原行。
   * `date` 传 'YYYY-MM-DD' 只读那一天；不传则读全部（新→旧）。
   */
  function listWishes({ status = '', limit = 60, date = '' } = {}) {
    requireReady()
    const dir = join(root, '鱼的请求')
    const day = String(date || '').trim()
    let files = []
    try { files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse() } catch {}
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) files = files.filter((name) => name.startsWith(day))
    let records = files.flatMap((name) => readLines(join(dir, name)))
    if (status) records = records.filter((item) => item && item.status === status)
    return records
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 60, 300)))
  }

  /** 请求历史里出现过哪几天（新→旧）：面板用它做日期筛选。 */
  function wishDays() {
    requireReady()
    const dir = join(root, '鱼的请求')
    let files = []
    try { files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) } catch { return [] }
    return files
      .map((name) => {
        const day = name.slice(0, 10)
        let count = 0
        try { count = readLines(join(dir, name)).length } catch {}
        return { day, count }
      })
      .filter((item) => item.count > 0)
      .sort((a, b) => b.day.localeCompare(a.day))
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
      relations: ready ? listRelations().people.length : 0,
      error: lastError,
    }
  }

  return {
    setServices({ registry, sessions, agents, sessionTitle } = {}) {
      if (registry) workspaceRegistry = registry
      if (sessions) sessionService = sessions
      if (agents) agentService = agents
      if (sessionTitle) titleService = sessionTitle
      return initialize()
    },
    initialize,
    status,
    pathForSession,
    isOwnerSession: (id) => cleanSessionId(id) === cleanSessionId(ownerSession),
    isInWorkspace: (id) => pathForSession(id) === workspacePath,
    ownerSession: () => ownerSession,
    ownerQQ: () => ownerQQ,
    ownerBinding,
    setOwner,
    listRelations,
    updateRelations,
    relationForSession,
    relationForQQ,
    chatTargets,
    chatWhitelist,
    chatTargetForSession,
    updateChats,
    markChatSeen,
    sessions,
    worldConfig,
    updateWorldConfig,
    appendDiary,
    listDiary,
    reviewDiarySuggestion,
    commentDiary,
    listDiaryComments,
    pendingDiaryComments,
    markDiaryCommentResponded,
    appendWish,
    listWishes,
    wishDays,
    decideWish,
    wishSummary,
    interactionTimeline,
    workspacePath: () => workspacePath,
    root: () => root,
  }
}

export const __test = { safeText, cleanSessionId, copyTreeNoOverwrite, migrateLegacyDirectory }
