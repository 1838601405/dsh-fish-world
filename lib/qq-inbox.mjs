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

/**
 * 只认白名单会话：不在名单里的群/人，连"收到"都不算 —— 不回戳、不记账、不投递。
 * 协议端本身连着账号里的所有群，它的通知推送也是全量的；过滤必须在这里做，
 * 不能指望上游只推我们想要的。
 */
export function eventAllowed(chatKey, allowedKeys) {
  const key = String(chatKey || '')
  if (!key) return false
  const set = allowedKeys instanceof Set ? allowedKeys : new Set(Array.isArray(allowedKeys) ? allowedKeys : [])
  return set.has(key)
}

export function createQQInbox({ qq, platforms, world, activity, logger, deliver, now = () => Date.now(), videoFrames } = {}) {
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
  /**
   * 视频：抽成一张胶片条塞进 images —— 投递层本来就把 images 渲染成「[图片] <本地路径>」，
   * 模型的 read_image 直接能打开，不需要另造一条附件管线。
   * 抽帧失败只少一张图，不影响这条消息本身。
   */
  async function 补视频帧(message, chat) {
    const videos = Array.isArray(message.videos) ? message.videos : []
    if (!videos.length) return message
    if (chat.videoFrames !== true) {
      return { ...message, text: String(message.text || '') + '\n〔这条是视频；抽帧没开，看不到画面〕' }
    }
    if (!videoFrames || typeof videoFrames.fromUrl !== 'function') return message
    const images = [...(Array.isArray(message.images) ? message.images : [])]
    const 备注 = []
    for (const video of videos) {
      const made = await videoFrames.fromUrl(video).catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
      if (made && made.ok) {
        images.push({ file: made.path })
        备注.push(made.cached ? '〔视频帧已抽过〕' : '〔视频 ' + Number(made.durationSec || 0).toFixed(1) + 's，抽了 ' + (made.frames || 0) + ' 帧〕')
      } else {
        备注.push('〔视频没抽成：' + String((made && made.error) || '未知原因') + '〕')
      }
    }
    const text = [String(message.text || ''), ...备注].filter(Boolean).join('\n')
    return { ...message, text, images }
  }

  // 合并转发的聊天记录：协议端会把「实时那一条」丢掉，但历史里还在，用现成的 qq.forward() 展开。
  // 展开的是原文，不是摘要 —— 摘要是模型自己的活，插件只负责把它看得见。
  const FORWARD_LIMIT_ENTRIES = 20
  const FORWARD_LIMIT_CHARS = 1200

  function 转发文本(entries) {
    const 行 = []
    let 字数 = 0
    for (const entry of entries.slice(0, FORWARD_LIMIT_ENTRIES)) {
      const 内容 = safeText(entry.text) || describeParts(entry.parts) || '（非文字内容）'
      const 行文 = (entry.nickname || entry.userId || '某人') + '：' + 内容
      if (字数 + 行文.length > FORWARD_LIMIT_CHARS) break
      行.push(行文)
      字数 += 行文.length
    }
    const 还有 = Math.max(0, entries.length - 行.length)
    return 行.join('\n') + (还有 ? '\n（还有 ' + 还有 + ' 条没展开）' : '')
  }

  async function 补转发(message, chat) {
    const ids = (Array.isArray(message.parts) ? message.parts : [])
      .filter((part) => part && part.kind === 'forward' && part.id)
      .map((part) => String(part.id))
    if (!ids.length) return message
    if (chat.forwardExpand !== true) {
      return { ...message, text: String(message.text || '') + '\n〔这条带合并转发的聊天记录；展开没开，看不到内容〕' }
    }
    if (!qq || typeof qq.forward !== 'function') return message
    const 块 = []
    for (const id of ids.slice(0, 2)) {
      const result = await qq.forward(id).catch((error) => ({ ok: false, reason: String((error && error.message) || error) }))
      if (result && result.ok && Array.isArray(result.entries) && result.entries.length) {
        块.push('〔以下是合并转发的聊天记录，一共 ' + result.entries.length + ' 条；自己看，别逐条复述〕\n' + 转发文本(result.entries))
      } else {
        块.push('〔聊天记录展开失败：' + String((result && result.reason) || '未知原因') + '〕')
      }
    }
    return { ...message, text: [String(message.text || ''), ...块].filter(Boolean).join('\n') }
  }

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
    let noticeCount = 0
    try {
      // 顺手取一次通知（撤回 / 入退群 / 戳一戳…），跟收消息共用这一把锁。
      // 放在锁外、还不 await 的话，两轮会用同一个旧游标把同一批 notice 处理两遍。
      noticeCount += await 拉QQ事件().catch((error) => {
        lastError = `读通知事件失败：${error?.message || error}`
        return 0
      })
      if (!targets.length) return { ok: true, skipped: 'no-targets', read: 0, delivered: 0, pending: 0, notices: noticeCount }
      // 群公告：默认关（读别人的公告也是「往外看」，和收信一样要主人点头）。
      if (chat.groupNotice === true) {
        noticeCount += await 拉群公告(targets).catch((error) => {
          lastError = `读群公告失败：${error?.message || error}`
          return 0
        })
      }
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
        for (const raw of fresh) {
          const key = messageKey(raw)
          if (selfId && cleanId(raw.userId) === cleanId(selfId)) { remember(target.chatKey, key); continue }
          if (qq.isMuted(raw.userId)) { remember(target.chatKey, key); continue }
          // 协议端命令（#sl 查状态）：只有主人自己发才喂给鱼，别人发的一律不接。
          if (/^#sl\b/i.test(String(raw.text || '').trim())) {
            let 主人 = ''
            try { 主人 = String(world.listRelations().owner.qqId || '') } catch {}
            if (String(raw.userId || '') !== 主人) {
              remember(target.chatKey, key)
              continue
            }
          }
          if (!shouldReply(raw, target, selfId)) {
            logActivity('read', `旁听 ${raw.nickname || raw.userId || '某人'} 在 ${target.chatKey}：${safeText(raw.text) || '（图片/非文字）'}`)
            remember(target.chatKey, key)
            continue
          }
          const message = await 补转发(await 补视频帧(raw, chat), chat)
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
      return { ok: true, read: readCount, delivered: deliveredCount, pending: batches.size, pendingMessages: pendingCount, notices: noticeCount, targets: targets.length }
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

  // ---------- QQ 通知事件 ----------
  // 桥起了固定端口收协议端（SnowLuma）的 notice 上报，这里每轮顺手取一次：
  // 戳一戳按次数回；其它通知写进平台留存，要紧的再投进对应会话（标注不用回）。
  //
  // 游标必须「先对齐再消费」：桥的事件队列会攒着重启前发生的事（最多 200 条），
  // 从 0 开始拉等于把历史当成刚发生 —— 入退群、撤回会被重新投进会话一遍。
  // 这和收消息「首次碰到某个目标只推游标不回历史」是同一条规矩。
  const 事件游标 = { at: -1 }
  const 戳记录 = new Map()
  let 我的号 = ''
  let 我的号时间 = 0

  function 事件文案(事件) {
    const 谁 = 事件.nickname || 事件.userId || '某人'
    switch (String(事件.noticeType || '')) {
      case 'group_recall': {
        const 管理员撤的 = 事件.operatorId && 事件.operatorId !== 事件.userId
        return `[撤回] ${谁} 的一条消息被撤回${管理员撤的 ? '（管理员 ' + 事件.operatorId + ' 撤的）' : ''}`
      }
      case 'friend_recall': return '[撤回] 对方撤回了一条消息'
      case 'group_ban': {
        if (事件.subType === 'lift_ban') return `[禁言] ${谁} 被解除禁言`
        const 分钟 = Math.round((Number(事件.duration) || 0) / 60)
        return `[禁言] ${谁} 被禁言${分钟 ? ' ' + 分钟 + ' 分钟' : ''}`
      }
      case 'group_increase': return `[入群] ${谁} 进群了`
      case 'group_decrease': return `[退群] ${谁} 退群了`
      case 'group_card': return `[名片] ${谁} 改了群名片`
      case 'group_upload': return `[群文件] ${谁} 上传了 ${事件.fileName || '一个文件'}`
      case 'group_msg_emoji_like': return `[表情回应] ${谁} 给消息贴了个表情`
      default: return ''
    }
  }

  const 要紧的 = new Set(['group_recall', 'friend_recall', 'group_ban', 'group_increase', 'group_decrease'])

  function 事件归属(事件) {
    return 事件.groupId ? 'group:' + 事件.groupId : 'private:' + (事件.userId || '')
  }

  async function 取我的号() {
    if (我的号 && now() - 我的号时间 < 300000) return 我的号
    try {
      const 信息 = await qq.loginInfo()
      if (信息 && 信息.ok && 信息.userId) {
        我的号 = String(信息.userId)
        我的号时间 = now()
      }
    } catch {}
    return 我的号
  }

  // 谁跟我多近：主人和信任者不装死，其他人按次数来。
  function 关系等级(qq号) {
    try {
      const rel = world.listRelations()
      if (rel && rel.owner && String(rel.owner.qqId) === qq号) return 'owner'
      const 人 = (rel && rel.people ? rel.people : []).find((x) => String(x.qqId) === qq号 && x.enabled !== false)
      return (人 && 人.role) || 'stranger'
    } catch {
      return 'stranger'
    }
  }

  const 上次回戳 = new Map()

  async function 处理一次戳(事件) {
    // 默认关：被人戳一下就自动回戳，是会被真人看见的社交动作。
    // 和 QQ 空间发帖、B 站点赞一样，要主人在面板上逐项打开。
    if (cfg().autoPokeBack !== true) return
    if (cfg().sendMessage !== true) return
    const 我 = await 取我的号()
    if (我 && 事件.targetId && String(事件.targetId) !== 我) return
    const 谁 = String(事件.userId || '')
    if (!谁) return
    // 用可注入的时钟：计数窗口和防刷屏都要能在测试里拨表，
    // 不然只能真等 60 秒，或者靠「碰巧机器快」。
    const 现在 = now()
    const chatKey = 事件归属(事件)
    const 亲近 = ['owner', 'trusted'].includes(关系等级(谁))

    // 主人 / 信任者：不装死，戳回来就是了；只防刷屏（3 秒内不连发）。
    if (亲近) {
      const 上次 = 上次回戳.get(谁) || 0
      if (现在 - 上次 < 3000) return
      上次回戳.set(谁, 现在)
      await qq.poke(chatKey, { groupId: 事件.groupId, userId: 谁 })
      return
    }

    const 旧 = (戳记录.get(谁) || []).filter((t) => 现在 - t < 60000)
    旧.push(现在)
    戳记录.set(谁, 旧)
    const 次数 = 旧.length
    if (次数 > 3) return
    if (次数 === 3) {
      await qq.send(chatKey, [{ type: 'text', text: '别戳了，再戳就不理你了' }])
      return
    }
    await qq.poke(chatKey, { groupId: 事件.groupId, userId: 谁 })
  }

  async function 投系统事件(事件, 文字) {
    const chatKey = 事件归属(事件)
    let sessionId = ''
    try {
      const 目标 = (world.chatTargets() || []).find((t) => String(t.chatKey) === chatKey)
      if (目标) sessionId = String(目标.sessionId || '')
    } catch {}
    if (!sessionId) return false
    return deliver({
      chatKey,
      sessionId,
      kind: 事件.groupId ? 'group' : 'private',
      text: '〔系统事件，知道一下就行，不用回〕' + 文字,
      images: [],
      parts: [],
      userId: 事件.userId,
      nickname: 事件.nickname,
    }).catch(() => ({ ok: false }))
  }

  // 群公告：按群记住「看到过的最后一条公告时间」。
  // 和事件一样先对齐再消费：第一次碰到这个群只记时间、不投递，否则一开功能就把陈年公告刷进会话。
  const 公告游标 = new Map()

  async function 拉群公告(targets) {
    let 数 = 0
    for (const target of targets) {
      const chatKey = String(target && target.chatKey ? target.chatKey : '')
      if (!chatKey.startsWith('group:')) continue
      const groupId = chatKey.slice(6)
      if (!groupId) continue
      const result = await qq.groupNotices(groupId)
      if (!result.ok) {
        lastError = `${chatKey} 读群公告失败：${result.reason || '未知原因'}`
        continue
      }
      const 最新 = result.notices.reduce((max, notice) => Math.max(max, Number(notice.at) || 0), 0)
      const 已知 = 公告游标.get(chatKey)
      if (已知 === undefined) {
        公告游标.set(chatKey, 最新)
        continue
      }
      if (最新 <= 已知) continue
      公告游标.set(chatKey, 最新)
      const 新的 = result.notices
        .filter((notice) => Number(notice.at) > 已知)
        .sort((a, b) => a.at - b.at)
      for (const notice of 新的) {
        const 文字 = '[群公告] ' + (notice.text || '（无正文）') + (notice.pinned ? '（置顶）' : '')
        const 投进去 = await 投系统事件({ groupId, userId: notice.senderId, nickname: '群公告' }, 文字)
        if (投进去) 数 += 1
        if (activity) activity.append({ platform: 'qq', kind: 'notice', actor: 'other', text: 文字 })
      }
    }
    return 数
  }

  async function 拉QQ事件() {
    let 端口 = 3002
    try {
      const 桥配置 = qq?.bridgeConfig?.()
      if (桥配置 && 桥配置.事件端口) 端口 = Number(桥配置.事件端口) || 端口
    } catch {}
    let 数据 = null
    try {
      // 第一次还没有游标：拉全量但只用来对齐时间，一条都不处理。
      // 否则队列里重启前攒着的事件会被当成「刚发生」，回戳、投会话全跑一遍。
      const 响应 = await fetch(`http://127.0.0.1:${端口}/events?since=${事件游标.at < 0 ? 0 : 事件游标.at}`)
      数据 = await 响应.json()
    } catch {
      return 0
    }
    const 列表 = Array.isArray(数据 && 数据.events) ? 数据.events : []
    if (事件游标.at < 0) {
      // 对齐：把游标推到「现在」，本轮一条都不处理。
      事件游标.at = Number(数据 && 数据.now) || Date.now()
      return 0
    }
    // 白名单：鱼世界授权的会话 ＋ 主人私聊（桥配的群只在「转群」开着时才算）。
    const 允许 = (() => {
      const set = new Set()
      try { for (const target of world.chatTargets() || []) set.add(String(target.chatKey)) } catch {}
      try {
        const owner = String(world.listRelations?.().owner?.qqId || '')
        if (owner) set.add('private:' + owner)
        const 桥配置 = qq?.bridgeConfig?.() || {}
        if (桥配置.私聊QQ) set.add('private:' + String(桥配置.私聊QQ))
        if (桥配置.转群 && 桥配置.群号) set.add('group:' + String(桥配置.群号))
      } catch {}
      return set
    })()
    let 数 = 0
    for (const 事件 of 列表) {
      if (!事件 || !事件.at) continue
      if (事件游标.at < 事件.at) 事件游标.at = Number(事件.at)
      // 白名单外的群/人：跳过。游标照常前进，免得每轮重读同一批。
      if (!eventAllowed(事件归属(事件), 允许)) continue
      try {
        const 是戳 = String(事件.noticeType || '') === 'poke'
          || (String(事件.noticeType || '') === 'notify' && String(事件.subType || '') === 'poke')
        if (是戳) {
          await 处理一次戳(事件)
        } else {
          const 文字 = 事件文案(事件)
          if (文字) {
            try {
              if (activity) activity.append({ platform: 'qq', kind: 'notice', actor: 'other', text: 文字 })
            } catch {}
            if (要紧的.has(String(事件.noticeType || ''))) {
              await 投系统事件(事件, 文字)
            }
          }
        }
        数 += 1
      } catch {}
    }
    return 数
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
      // 事件游标 -1 表示「还没对齐」：面板据此说明通知通道现在的状态。
      noticeReady: 事件游标.at >= 0,
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
