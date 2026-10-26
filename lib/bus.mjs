// 扩展事件总线。事件名照 QQ Agent 0.5 的白名单，额外允许适配器自己的 adapter.*。
const QQ_AGENT_EVENTS = [
  'log',
  'server.ready',
  'plugin.loaded',
  'plugin.unloaded',
  'message.in',
  'session.start',
  'session.update',
  'session.end',
  'chat.update',
  'onebot.status',
  'transport.status',
  'reminder.fire',
  'feedback',
]

const ALLOWED_EVENTS = new Set([
  ...QQ_AGENT_EVENTS,
  'adapter.ready',
  'adapter.reload',
  'adapter.error',
  'message.out',
  'send.result',
])

/**
 * 极简同步派发器：
 * - 监听器异常只记日志，不影响其它监听器；
 * - 不 await 异步监听器（与 QQ Agent 的总线语义一致），调用方要自己 catch。
 */
export function createBus({ onError } = {}) {
  const map = new Map()

  function report(error, event) {
    if (typeof onError === 'function') {
      try { onError(error, event) } catch {}
    }
  }

  function on(name, fn, owner = '') {
    const event = String(name || '')
    if (!ALLOWED_EVENTS.has(event)) {
      report(new Error(`事件 ${event || '(空)'} 不在允许列表里`), event)
      return () => {}
    }
    if (typeof fn !== 'function') return () => {}
    let set = map.get(event)
    if (!set) map.set(event, (set = new Set()))
    const entry = { fn, owner }
    set.add(entry)
    return () => {
      const current = map.get(event)
      if (!current) return
      current.delete(entry)
      if (current.size === 0) map.delete(event)
    }
  }

  function emit(name, payload) {
    const event = String(name || '')
    if (!ALLOWED_EVENTS.has(event)) {
      report(new Error(`事件 ${event || '(空)'} 不在允许列表里`), event)
      return 0
    }
    const set = map.get(event)
    if (!set || set.size === 0) return 0
    let count = 0
    for (const entry of [...set]) {
      count += 1
      try {
        const result = entry.fn(payload)
        if (result && typeof result.catch === 'function') result.catch((error) => report(error, event))
      } catch (error) {
        report(error, event)
      }
    }
    return count
  }

  function removeOwner(owner) {
    for (const [event, set] of map) {
      for (const entry of [...set]) if (entry.owner === owner) set.delete(entry)
      if (set.size === 0) map.delete(event)
    }
  }

  function listenerCount(name) {
    const set = map.get(String(name || ''))
    return set ? set.size : 0
  }

  return { on, emit, removeOwner, listenerCount }
}
