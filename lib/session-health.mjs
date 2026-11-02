// 会话健康：上一轮到底成没成功。
//
// 为什么要单独管：宿主 turn/end 失败时，如果我们照旧把「忙」清掉，下一批消息
// 又会 followup 进会话队列；而失败的一轮可能**每一轮都失败**（比如上下文已经
// 超过模型窗口：重试只会再发一遍同样超长的历史）。结果是队列越堆越多、
// 一条都发不出去。这里把「失败」也当成一种「先别投」的状态：
//   · 普通失败：冷却一段时间，期间消息继续攒在同一个桶里（合并），冷却后只投一批；
//   · 上下文超限：直接 blocked，不再投，等主人换会话；
// 冷却/阻塞期间都不往宿主队列塞新消息，所以不会再分开堆积。
const OVERSIZE = /context\s*(?:window|length)|oversize|too\s+large|exceed(?:s|ed)?\s+(?:the\s+)?(?:model\s+)?context|超出.{0,12}上下文|上下文.{0,12}(?:超|溢出)|token.{0,16}(?:exceed|超)/i

export const FAIL_COOLDOWN_MS = 60_000

/** 这段错误文本是不是「上下文超限」——这种失败重试没有意义。 */
export function isOversizeError(text) {
  return OVERSIZE.test(String(text || ''))
}

/**
 * 由 turn/end 的 reason 生成健康记录。
 * @param {unknown} reason 宿主给的 reason（对象/字符串都认）
 * @param {{ at?: number, cooldownMs?: number }} [options]
 */
export function failureHealth(reason, { at = Date.now(), cooldownMs = FAIL_COOLDOWN_MS } = {}) {
  let text = ''
  try {
    text = typeof reason === 'string' ? reason : JSON.stringify(reason == null ? {} : reason)
  } catch {
    text = String(reason == null ? '' : reason)
  }
  const message = String(text || '').slice(0, 400)
  return {
    ok: false,
    at: Number(at) || Date.now(),
    error: message,
    blocked: isOversizeError(message),
    cooldownMs: Number(cooldownMs) || FAIL_COOLDOWN_MS,
  }
}

/** 这条健康记录现在要不要「先别投」。 */
export function shouldHold(health, { now = Date.now(), cooldownMs = FAIL_COOLDOWN_MS } = {}) {
  if (!health || health.ok !== false) return false
  if (health.blocked) return true
  const at = Number(health.at) || 0
  const window = Number(health.cooldownMs) || Number(cooldownMs) || FAIL_COOLDOWN_MS
  return Number(now) - at < window
}
