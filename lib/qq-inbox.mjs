// 鱼在群聊和好友私聊里聊天：按「鱼的关系」授权的目标轮询消息，投进各自的 DSH 会话。
//
// 为什么需要这一层：dsh-qq-bridge 只盯「一个目标会话 + 一个私聊号 + 一个群号」，
// 所以鱼此前只能在私聊里说话。要多群多好友聊天，就得多读几个会话的历史、
// 各投各的房间。读取用现成的 qq.recent()，目标与房间用现成的 world.chatTargets()
// （来源就是「鱼的关系」），游标用关系条目上本来就有的 cursorAt——不新增配置文件。
//
// 边界（与插件整体的默认拒绝风格一致）：
//  · 只读关系表里启用、且没被拉黑的目标；
//  · 首次碰到某个目标只推进游标、不回历史消息，否则一开功能就把旧消息全回一遍；
//  · 群里默认「被 @」才算找她（可在面板改档），其余只旁听留存；
//  · 回复只发给自己收进来的会话，桥盯着的那个会话仍由桥发，绝不重发。
//
// 攒批（思路取自 reply-pacing，但落点在我们自己的收信层，不必改宿主）：
//  同一个人连发三条，是「一件事的三段」，不是三次提问。原来的逐条 deliver 会把它们
//  变成三轮回答，表现出来就像她在抢话、还打断人。所以按**会话**攒桶（按人分桶会出现
//  「甲一句乙一句 → 两个桶 → 还是两轮」），等他安静一会儿再整批投一次，并且只回最后
//  说话的那个人。
//
// 攒批带来的新风险要一起管住，否则等于换个方式丢消息：
//  · 桶里还等着的消息，游标不能先越过它——这时崩溃/重载话就没了；
//  · 所以游标只推到「连续的已处理前缀」，投递失败时桶保留、下一轮重试；
//  · 重试有上限（MAX_ATTEMPTS），放弃时如实记一笔留存与 lastError，绝不静默丢弃；
//  · 按消息 key 去重，重读同一条不会重复留档、也不会重复回话。
const MAX_TEXT = 400
const MAX_BATCH_CHARS = 3000
// 一个桶最多攒多少条：对方一直刷屏时也要有个上限，超了就丢最旧的并如实报错。
const MAX_BATCH_MESSAGES = 40
// 每条消息最多投递几次，之后放弃并把游标推过去（避免坏房间永远堵住这个会话）。
const MAX_ATTEMPTS = 3
// 每个会话记住多少条「已处理」的消息，防止重读导致重复留档。
const MAX_REMEMBERED = 300

function safeText(value) {
  return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim().slice(0, MAX_TEXT)
}

function cleanId(value) {
  return String(value == null ? '' : value).replace(/\D/g, '')
}

/**
 * 一条消息看着像没说完：收在省略号 / 破折号 / 逗号 / 顿号 / 波浪号上，句尾是语气词，
 * 或短到不像一句完整话。判定保守：宁可多等一秒，也不打断人（与 reply-pacing 同口径）。
 */
export function looksUnfinished(text) {
  const s = String(text || '').trim()
  if (!s) return false
  if (/(…|\.\.\.|——|—|~|，|、|,)$/.test(s)) return true
  if (/[啊呀呢吧嘛哦嗯]$/.test(s)) return true
  return s.replace(/\s/g, '').length < 12
}

/** 数值配置：0 是合法值（意思是「不等 / 不额外等」），所以不能写 `Number(x) || 默认`。 */
function numOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : fallback
}

export function createQQInbox({ qq, platforms, world, activity, logger, deliver, now = () => Date.now() } = {}) {
  let running = false
  let lastError = ''
  let lastTickAt = 0
  // 本轮收进来的消息属于哪个房间，回复时按这张表发回去。
  const boundSessions = new Map()
  // 攒批中的桶：key = chatKey，value = { target, messages, firstAt, lastAt, lastSpeaker }
  const batches = new Map()
  // chatKey → Set(已处理的消息 key)：旁听 / 被拉黑 / 鱼自己说的 / 已投成功的都算处理过。
  const handled = new Map()
  // chatKey → Map(消息 key → 已尝试次数)：投递失败时用来决定还要不要重试。
  const attempts = new Map()

  function cfg() {
    try {
      return platforms.platform('qq') || {}
    } catch {
      return {}
    }
  }

  /**
   * 消息的稳定标识：优先用协议端的 id，没有就用「时间 + 谁 + 内容」凑一个。
   * 有 id 却没有去重，等于默认丢弃；两者都没有才可能重复，所以宁可凑。
   */
  function messageKey(message) {
    const id = String(message.id == null ? '' : message.id).trim()
    if (id) return `#${id}`
    return `t${Number(message.at) || 0}|u${cleanId(message.userId)}|${safeText(message.text).slice(0, 60)}`
  }

  function keySet(chatKey) {
    let set = handled.get(chatKey)
    if (!set) {
      set = new Set()
      handled.set(chatKey, set)
    }
    return set
  }

  function remember(chatKey, key) {
    const set = keySet(chatKey)
    set.add(key)
    if (set.size > MAX_REMEMBERED) {
      // Set 按插入顺序迭代：丢掉最早记住的那些即可。
      let drop = set.size - MAX_REMEMBERED
      for (const old of set) {
        set.delete(old)
        if (--drop <= 0) break
      }
    }
  }

  /** 这条消息投递失败过几次了；到上限就放弃并如实记录。 */
  function noteFailure(chatKey, key) {
    let map = attempts.get(chatKey)
    if (!map) {
      map = new Map()
      attempts.set(chatKey, map)
    }
    const count = (map.get(key) || 0) + 1
    map.set(key, count)
    if (count >= MAX_ATTEMPTS) {
      map.delete(key)
      remember(chatKey, key)
      lastError = `${chatKey} 连续 ${count} 次投递失败，已放弃这条（本地留存记为丢失）`
      try { logger?.warn?.(`fish-world: ${lastError}`) } catch {}
      logActivity('lost', `${key} 投不进会话，已放弃：${lastError}`)
      return true
    }
    return false
  }

  /** 群消息里有没有 @ 到鱼自己。用归一化后的段判断，不猜协议端字段。 */
  function mentionsMe(message, selfId) {
    if (!selfId) return false
    return (message.parts || []).some((part) => part && part.kind === 'at' && cleanId(part.id) === cleanId(selfId))
  }

  // 群里怎么算「在说她」：叫到名字、@ 她、或者提到这几个称呼。
  // 单字「鱼」太泛，容易把整场对话都算进来，所以不放。
  const SELF_WORDS = ['小鲸鱼', '鲸鱼娘', '蓝鲸娘', '大肥鱼', '肥鱼', '鲸']

  function namesMe(message) {
    const text = safeText(message.text)
    if (!text) return false
    return SELF_WORDS.some((word) => text.includes(word))
  }

  /** 这条消息要不要开口回。群聊按主人选的档位决定，私聊一律算找她。 */
  function shouldReply(message, target, selfId) {
    if (target.kind !== 'group') return true
    const mode = cfg().groupReplyMode || 'mention'
    if (mode === 'never') return false
    // 「每条都回」也收紧了：只回跟她有关的（@ 她、或话里提到她），
    // 免得群里聊别人的事她每句都插一嘴。
    if (mode === 'always') return mentionsMe(message, selfId) || namesMe(message)
    return mentionsMe(message, selfId)
  }

  function logActivity(kind, text) {
    if (!activity) return
    try { activity.append({ platform: 'qq', kind, actor: kind === 'send' ? 'fish' : 'other', text }) } catch {}
  }

  function stagedKeys(chatKey) {
    const batch = batches.get(chatKey)
    return new Set((batch ? batch.messages : []).map(messageKey))
  }

  /**
   * 「此刻群里的现场」：把刚在聊的几句别人的发言当背景摆出来。
   *
   * 为什么需要：原来的投递只把「@ 她的那句」送进会话，她看不到前一句在聊什么，
   * 于是答得驴唇不对马嘴。数据本来就在 qq.recent() 里，不必另外抓。
   *
   * 只取别人的发言（不含她自己、不含这一批里的消息），按消息时间取最近 N 条。
   * 刻意不按「本机时间 - 10 分钟」筛：协议端的消息时间是另一个时钟，两边差几秒
   * 就会把现场全筛没（本项目吃过一次这种静默失效的亏）。recent() 本身已经只返回
   * 最近 historyLimit 条，用它当窗口就够了。
   */
  function buildContext(messages, excludeKeys, selfId, chat) {
    const count = numOr(chat.liveContextCount, 5)
    if (!count) return []
    return messages
      .slice()
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
      .filter((message) => {
        if (excludeKeys.has(messageKey(message))) return false
        if (selfId && cleanId(message.userId) === cleanId(selfId)) return false
        if (qq.isMuted?.(message.userId)) return false
        return true
      })
      .slice(-count)
      .map((message) => {
        const who = safeText(message.nickname) || String(message.userId || '某人')
        const what = safeText(message.text) || describeParts(message.parts) || '（图片/非文字）'
        return `${who}：${what}`
      })
  }

  /** 非文字段的人话描述：只写类型，不猜内容。 */
  function describeParts(parts) {
    const labels = { image: '图片', face: '表情', mface: '表情包', record: '语音', video: '视频', file: '文件', json: '卡片', forward: '聊天记录' }
    const names = []
    for (const part of Array.isArray(parts) ? parts : []) {
      const label = labels[part && part.kind]
      if (label && !names.includes(label)) names.push(label)
    }
    return names.length ? `[${names.join('][')}]` : ''
  }

  function pushBatch(target, message, context) {
    const key = target.chatKey
    // 安静窗口按「我们观察到这条的时间」算，不按消息自带的 at：
    // 对端时钟可能比本机慢（at 远在过去 → 立刻误判成「早该回了」）也可能快（永远差负数）。
    const at = now()
    const existing = batches.get(key)
    if (existing) {
      existing.messages.push(message)
      // 本轮的 fresh 已按消息时间升序排过，所以最后推进来的就是最后说话的人。
      existing.lastAt = at
      existing.lastSpeaker = message
      // 现场跟着刷新：等得越久，背景越应该是「最近」的那几句。
      if (context) existing.context = context
      if (existing.messages.length > MAX_BATCH_MESSAGES) {
        // 刷屏时不能无限攒：丢最旧的并如实说明，而不是假装什么都没发生。
        const over = existing.messages.splice(0, existing.messages.length - MAX_BATCH_MESSAGES)
        for (const m of over) remember(key, messageKey(m))
        lastError = `${key} 攒批超过 ${MAX_BATCH_MESSAGES} 条，放弃最早的 ${over.length} 条`
        try { logger?.warn?.(`fish-world: ${lastError}`) } catch {}
      }
      return
    }
    batches.set(key, { target, messages: [message], firstAt: at, lastAt: at, lastSpeaker: message, context: context || [] })
  }

  /** 把一桶消息合成一次投递：同一个人连着说的几句 = 一件事的几段。 */
  function mergeBatch(batch) {
    const { target, messages } = batch
    const last = batch.lastSpeaker || messages[messages.length - 1]
    const lastId = cleanId(last.userId)
    const images = messages.flatMap((message) => (Array.isArray(message.images) ? message.images : []))
    const parts = messages.flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
    const speakers = new Set(messages.map((message) => cleanId(message.userId)))
    let text
    if (messages.length === 1) {
      text = safeText(messages[0].text)
    } else {
      // 明说这是连着说的几句，让她整体回应而不是逐条回；换人说话时点名只回谁。
      const who = last.nickname || last.userId || '最后说话的人'
      const head = speakers.size > 1
        ? `〔这一轮只回一个人：${who}。这批里他连着说的几句是一件事的几段，合起来回应，别逐条回；`
          + '别人的话只是背景，不要接，也不要把别人的话当成他说的〕'
        : `〔同一个人连着说了 ${messages.length} 句，是一件事的几段，合起来回应，别逐条回〕`
      text = `${head}\n${messages.map((message, i) => {
        const tag = cleanId(message.userId) === lastId ? '他' : (safeText(message.nickname) || message.userId || '别人')
        return `${i + 1}. [${tag}] ${safeText(message.text) || '（图片/非文字）'}`
      }).join('\n')}`
    }
    if (text.length > MAX_BATCH_CHARS) text = text.slice(0, MAX_BATCH_CHARS)
    // 「此刻的现场」只当背景：明说不要回应他们，避免她把别人的话缝进回答里。
    const context = Array.isArray(batch.context) ? batch.context : []
    if (context.length) {
      text = `${text}\n〔此刻群里的现场（只是背景，别回应这些人，也别把他们的话当成他说的）〕\n${context.join('\n')}`
    }
    return {
      chatKey: target.chatKey,
      sessionId: target.sessionId,
      kind: target.kind,
      text,
      images,
      parts,
      userId: last.userId,
      nickname: last.nickname,
      count: messages.length,
    }
  }

  /**
   * 这个桶到时间了吗：安静够了，或等太久了。
   * 最后一条看着像没说完时再多等一会儿——这正是「等他打完字」的那半步；
   * 「等太久」那条上限仍然兜底，不会永远不开口。
   */
  function readyToFlush(batch, settings) {
    const baseSec = numOr(settings.batchQuietSec, 5)
    const last = batch.lastSpeaker || batch.messages[batch.messages.length - 1]
    const extra = looksUnfinished(last && last.text) ? numOr(settings.batchUnfinishedExtraSec, 0) : 0
    const quietMs = (baseSec + extra) * 1000
    const maxMs = Math.max(quietMs, numOr(settings.batchMaxWaitSec, 45) * 1000)
    const at = now()
    return (at - batch.lastAt >= quietMs) || (at - batch.firstAt >= maxMs)
  }

  /** 投递成功后才让游标越过这批消息；失败时桶保留，下一轮重试。 */
  async function flushBatch(chatKey) {
    const batch = batches.get(chatKey)
    if (!batch) return 0
    try {
      const sent = await deliver(mergeBatch(batch))
      if (!sent || !sent.ok) throw new Error((sent && sent.error) || '会话不可用')
    } catch (error) {
      lastError = `${chatKey} 投递失败：${error?.message || error}`
      // 整批算一次失败；到上限就丢掉最旧的一条让队列能往前走，其余继续等。
      const oldest = batch.messages[0]
      const gaveUp = noteFailure(chatKey, messageKey(oldest))
      if (gaveUp) batch.messages.shift()
      if (!batch.messages.length) batches.delete(chatKey)
      else batch.lastSpeaker = batch.messages[batch.messages.length - 1]
      return 0
    }
    batches.delete(chatKey)
    const ordered = batch.messages.slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    for (const message of ordered) {
      remember(chatKey, messageKey(message))
      logActivity('receive', `${message.nickname || message.userId || '某人'} 在 ${chatKey} 说：${safeText(message.text) || '（图片/非文字）'}`)
    }
    const newest = ordered[ordered.length - 1] || {}
    try {
      world.markChatSeen(chatKey, { at: Number(newest.at) || batch.lastAt, messageId: String(newest.id || '') })
    } catch { /* 关系表写不进去不影响这次投递已完成 */ }
    boundSessions.set(String(batch.target.sessionId).replace(/^session-/, ''), {
      chatKey,
      kind: batch.target.kind,
    })
    return 1
  }

  /** 到期的桶整批投出去。传 null 表示「不等了，现在全投」。 */
  async function flushReady(settings) {
    let delivered = 0
    for (const chatKey of [...batches.keys()]) {
      const batch = batches.get(chatKey)
      if (!batch) continue
      if (settings === null || readyToFlush(batch, settings)) delivered += await flushBatch(chatKey)
    }
    return delivered
  }

  /**
   * 游标只推到「连续的已处理前缀」：桶里还等着的、这次没投成的消息都不能先越过，
   * 否则这时崩溃 / 重载话就丢了。已投出与旁听过的都算处理过，可以越过。
   */
  function advanceCursor(chatKey, messages, cursor) {
    const staged = stagedKeys(chatKey)
    const done = handled.get(chatKey) || new Set()
    const sorted = messages.slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    let newest = cursor
    let newestId = ''
    for (const message of sorted) {
      const at = Number(message.at) || 0
      if (at <= cursor) continue // 早就过去了，不参与本次判断
      const key = messageKey(message)
      if (staged.has(key) || !done.has(key)) break
      if (at >= newest) {
        newest = at
        newestId = String(message.id || '') || newestId
      }
    }
    if (newest > cursor) {
      try { world.markChatSeen(chatKey, { at: newest, messageId: newestId }) } catch {}
    }
    return newest
  }

  /**
   * 跑一轮：到期的先整批投出去 → 读授权目标 → 只留游标之后、且没处理过的新消息
   * → 该回的进桶（攒批开着）或直接投（关掉攒批就是原来的逐条语义）→ 推进游标。
   */
  async function tick() {
    if (running) return { ok: true, skipped: 'already-running' }
    const chat = cfg()
    if (chat.enabled !== true || chat.readHistory !== true) return { ok: true, skipped: 'disabled' }
    const targets = (() => {
      try { return world.chatTargets() || [] } catch { return [] }
    })()
    running = true
    lastTickAt = Date.now()
    let readCount = 0
    let deliveredCount = 0
    let pendingCount = 0
    try {
      if (!targets.length) return { ok: true, skipped: 'no-targets', read: 0, delivered: 0, pending: 0 }
      deliveredCount += await flushReady(chat)
      const batching = chat.batchEnabled !== false
      const login = await qq.loginInfo().catch(() => ({ ok: false }))
      const selfId = login && login.ok ? String(login.userId || '') : ''
      for (const target of targets) {
        const limit = numOr(chat.historyLimit, 20)
        const result = await qq.recent(target.chatKey, limit)
        if (!result.ok) {
          lastError = `${target.chatKey} 读取失败：${result.reason || '未知原因'}`
          continue
        }
        const messages = result.messages || []
        // 首次碰到这个目标：只把游标推到最新一条，一条都不回。
        const cursor = Number(target.cursorAt) || 0
        if (!cursor) {
          const newest = messages.reduce((max, item) => Math.max(max, Number(item.at) || 0), 0)
          world.markChatSeen(target.chatKey, { at: newest || Date.now() })
          continue
        }
        const staged = stagedKeys(target.chatKey)
        const done = handled.get(target.chatKey) || new Set()
        const fresh = messages
          .filter((item) => (Number(item.at) || 0) > cursor)
          .filter((item) => !staged.has(messageKey(item)) && !done.has(messageKey(item)))
          .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
        if (!fresh.length) continue
        readCount += fresh.length

        // 这一批之外的、别人刚说的话，当「此刻的现场」摆给她看。
        // 注意排除的只能是「要回的那几条」，不能把全部 fresh 都排掉——
        // 那样连旁听的话也进不了现场，等于现场永远是空的。
        const batchKeys = new Set(fresh
          .filter((message) => {
            if (selfId && cleanId(message.userId) === cleanId(selfId)) return false
            if (qq.isMuted(message.userId)) return false
            return shouldReply(message, target, selfId)
          })
          .map(messageKey))
        const context = buildContext(messages, batchKeys, selfId, chat)
        let blocked = false
        for (const message of fresh) {
          const key = messageKey(message)
          if (selfId && cleanId(message.userId) === cleanId(selfId)) { remember(target.chatKey, key); continue }
          if (qq.isMuted(message.userId)) { remember(target.chatKey, key); continue }
          if (!shouldReply(message, target, selfId)) {
            logActivity('read', `旁听 ${message.nickname || message.userId || '某人'} 在 ${target.chatKey}：${safeText(message.text) || '（图片/非文字）'}`)
            remember(target.chatKey, key)
            continue
          }
          if (!batching) {
            // 攒批关着：完全恢复原本的逐条语义，投成功才认这条处理过。
            const sent = await deliver({
              chatKey: target.chatKey,
              sessionId: target.sessionId,
              kind: target.kind,
              text: message.text,
              images: message.images,
              parts: message.parts,
              userId: message.userId,
              nickname: message.nickname,
            }).catch((error) => ({ ok: false, error: String(error?.message || error) }))
            if (sent && sent.ok) {
              deliveredCount += 1
              remember(target.chatKey, key)
              boundSessions.set(String(target.sessionId).replace(/^session-/, ''), {
                chatKey: target.chatKey,
                kind: target.kind,
              })
              logActivity('receive', `${message.nickname || message.userId || '某人'} 在 ${target.chatKey} 说：${safeText(message.text) || '（图片/非文字）'}`)
            } else {
              // 投不成就把游标停在这儿，下一轮还会看到它——不静默丢消息。
              lastError = `${target.chatKey} 投递失败：${(sent && sent.error) || '会话不可用'}`
              if (noteFailure(target.chatKey, key)) continue
              blocked = true
              break
            }
            continue
          }
          // 攒批：进桶，等他说完。桶里的消息不算已处理，游标也不会越过它。
          pushBatch(target, message, context)
        }
        if (!blocked) advanceCursor(target.chatKey, messages, cursor)
        pendingCount += batches.get(target.chatKey)?.messages.length || 0
      }
      return { ok: true, read: readCount, delivered: deliveredCount, pending: batches.size, pendingMessages: pendingCount, targets: targets.length }
    } catch (error) {
      lastError = String(error?.message || error)
      return { ok: false, error: lastError }
    } finally {
      running = false
    }
  }

  /** 这个 DSH 会话是不是鱼世界替它收 QQ 消息的（桥自己那一间不在表里）。 */
  function chatKeyForSession(sessionId) {
    const id = String(sessionId || '').replace(/^session-/, '')
    if (!id) return null
    const bound = boundSessions.get(id)
    if (bound) return bound
    // 服务重启后 boundSessions 是空的：再按关系表查一次，避免回话找不到目标。
    try {
      const target = world.chatTargetForSession(id)
      if (!target) return null
      boundSessions.set(id, { chatKey: target.chatKey, kind: target.kind })
      return boundSessions.get(id)
    } catch {
      return null
    }
  }

  /**
   * 会话结束一轮后把鱼说的话发回原 QQ 会话。
   * 只处理鱼世界自己收信的房间；主人那一间由 QQ 桥发，这里跳过，否则一条回复发两遍。
   */
  const cleanSid = (id) => String(id || '').replace(/^session-/, '')

  async function onTurnEnd({ sessionId, text }) {
    const cleanText = String(text || '').trim()
    if (!cleanText) return { ok: false, skipped: 'empty' }
    let isOwner = false
    try { isOwner = world?.isOwnerSession?.(sessionId) === true } catch {}

    // 主人这一间：只发私聊，绝不发群。
    // 桥自己盯着的那个会话由桥发（否则一条回复发两遍），其余情况插件补发私聊。
    if (isOwner) {
      if (cfg().sendMessage !== true) return { ok: false, skipped: 'send-disabled' }
      let bridgeSession = ''
      try { bridgeSession = String(qq?.bridgeConfig?.().目标会话 || '') } catch {}
      if (bridgeSession && cleanSid(bridgeSession) === cleanSid(sessionId)) {
        return { ok: false, skipped: 'bridge-handles' }
      }
      let ownerQQ = ''
      try { ownerQQ = String(world?.listRelations?.().owner?.qqId || '') } catch {}
      if (!ownerQQ) return { ok: false, skipped: 'no-owner-qq' }
      return qq.send('private:' + ownerQQ, [{ type: 'text', text: cleanText }])
    }

    const bound = chatKeyForSession(sessionId)
    if (!bound) return { ok: false, skipped: 'not-bound' }
    if (cfg().sendMessage !== true) return { ok: false, skipped: 'send-disabled' }
    const clean = String(text || '').trim()
    if (!clean) return { ok: false, skipped: 'empty' }
    // 发送记账统一在 qq.send 里做（那里才计得到「今日已发几条」的额度）。
    // 这里再写一条会让同一次回复在本地留存里出现两遍，额度也会多算一倍。
    return qq.send(bound.chatKey, [{ type: 'text', text: clean }])
  }

  function status() {
    const chat = cfg()
    let targets = []
    try { targets = world.chatTargets() || [] } catch { /* 工作区还没绑定时就是空 */ }
    return {
      ok: true,
      enabled: chat.enabled === true && chat.readHistory === true,
      canSend: chat.sendMessage === true,
      groupReplyMode: chat.groupReplyMode || 'mention',
      pollSeconds: numOr(chat.pollSeconds, 4),
      historyLimit: numOr(chat.historyLimit, 20),
      batchEnabled: chat.batchEnabled !== false,
      batchQuietSec: numOr(chat.batchQuietSec, 5),
      batchMaxWaitSec: numOr(chat.batchMaxWaitSec, 45),
      batchUnfinishedExtraSec: numOr(chat.batchUnfinishedExtraSec, 0),
      pending: batches.size,
      pendingMessages: [...batches.values()].reduce((sum, batch) => sum + batch.messages.length, 0),
      targets: targets.map((target) => ({
        chatKey: target.chatKey,
        kind: target.kind,
        id: target.id,
        name: target.name,
        sessionId: target.sessionId,
        cursorAt: Number(target.cursorAt) || 0,
      })),
      lastTickAt,
      lastError,
    }
  }

  return {
    tick,
    onTurnEnd,
    chatKeyForSession,
    status,
    // 主人想「现在就回」时用这个：不等安静窗口，把攒着的桶整批投出去。
    flushAll: () => flushReady(null),
  }
}
