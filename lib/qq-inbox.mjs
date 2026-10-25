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
const MAX_TEXT = 400

function safeText(value) {
  return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim().slice(0, MAX_TEXT)
}

function cleanId(value) {
  return String(value == null ? '' : value).replace(/\D/g, '')
}

export function createQQInbox({ qq, platforms, world, activity, logger, deliver } = {}) {
  let running = false
  let lastError = ''
  let lastTickAt = 0
  // 本轮收进来的消息属于哪个房间，回复时按这张表发回去。
  const boundSessions = new Map()

  function cfg() {
    try {
      return platforms.platform('qq') || {}
    } catch {
      return {}
    }
  }

  /** 群消息里有没有 @ 到鱼自己。用归一化后的段判断，不猜协议端字段。 */
  function mentionsMe(message, selfId) {
    if (!selfId) return false
    return (message.parts || []).some((part) => part && part.kind === 'at' && cleanId(part.id) === cleanId(selfId))
  }

  /** 这条消息要不要开口回。群聊按主人选的档位决定，私聊一律算找她。 */
  function shouldReply(message, target, selfId) {
    if (target.kind !== 'group') return true
    const mode = cfg().groupReplyMode || 'mention'
    if (mode === 'never') return false
    if (mode === 'always') return true
    return mentionsMe(message, selfId)
  }

  function logActivity(kind, text) {
    if (!activity) return
    try { activity.append({ platform: 'qq', kind, actor: kind === 'send' ? 'fish' : 'other', text }) } catch {}
  }

  /**
   * 跑一轮：读授权目标 → 只留游标之后的新消息 → 推进游标 → 该回的投进对应房间。
   * 游标存在关系条目上，所以重启、重新加载插件都不会把旧消息重放一遍。
   */
  async function tick() {
    if (running) return { ok: true, skipped: 'already-running' }
    const chat = cfg()
    if (chat.enabled !== true || chat.readHistory !== true) return { ok: true, skipped: 'disabled' }
    const targets = (() => {
      try { return world.chatTargets() || [] } catch { return [] }
    })()
    if (!targets.length) return { ok: true, skipped: 'no-targets', read: 0, delivered: 0 }
    running = true
    lastTickAt = Date.now()
    let readCount = 0
    let deliveredCount = 0
    try {
      const login = await qq.loginInfo().catch(() => ({ ok: false }))
      const selfId = login && login.ok ? String(login.userId || '') : ''
      for (const target of targets) {
        const limit = Number(chat.historyLimit) || 20
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
        const fresh = messages.filter((item) => (Number(item.at) || 0) > cursor)
        const newest = messages.reduce((max, item) => Math.max(max, Number(item.at) || 0), cursor)
        if (fresh.length) world.markChatSeen(target.chatKey, { at: newest, messageId: String(fresh[fresh.length - 1].id || '') })
        for (const message of fresh) {
          readCount += 1
          if (selfId && cleanId(message.userId) === cleanId(selfId)) continue
          if (qq.isMuted(message.userId)) continue
          if (!shouldReply(message, target, selfId)) {
            logActivity('read', `旁听 ${message.nickname || message.userId || '某人'} 在 ${target.chatKey}：${safeText(message.text) || '（图片/非文字）'}`)
            continue
          }
          try {
            const sent = await deliver({
              chatKey: target.chatKey,
              sessionId: target.sessionId,
              kind: target.kind,
              text: message.text,
              images: message.images,
              parts: message.parts,
              userId: message.userId,
              nickname: message.nickname,
            })
            if (sent && sent.ok) {
              deliveredCount += 1
              boundSessions.set(String(target.sessionId).replace(/^session-/, ''), {
                chatKey: target.chatKey,
                kind: target.kind,
              })
              logActivity('receive', `${message.nickname || message.userId || '某人'} 在 ${target.chatKey} 说：${safeText(message.text) || '（图片/非文字）'}`)
            } else {
              lastError = `${target.chatKey} 投递失败：${(sent && sent.error) || '会话不可用'}`
            }
          } catch (error) {
            lastError = `${target.chatKey} 投递失败：${error?.message || error}`
          }
        }
      }
      return { ok: true, read: readCount, delivered: deliveredCount, targets: targets.length }
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
  async function onTurnEnd({ sessionId, text }) {
    const bound = chatKeyForSession(sessionId)
    if (!bound) return { ok: false, skipped: 'not-bound' }
    if (cfg().sendMessage !== true) return { ok: false, skipped: 'send-disabled' }
    const clean = String(text || '').trim()
    if (!clean) return { ok: false, skipped: 'empty' }
    const receipt = await qq.send(bound.chatKey, [{ type: 'text', text: clean }])
    if (receipt.ok && !receipt.dryRun) logActivity('send', `回到 ${bound.chatKey}：${clean.slice(0, 200)}`)
    return receipt
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
      pollSeconds: Number(chat.pollSeconds) || 4,
      historyLimit: Number(chat.historyLimit) || 20,
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

  return { tick, onTurnEnd, chatKeyForSession, status }
}
