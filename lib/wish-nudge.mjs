// 鱼的请求：什么时候在提示词里轻轻推她一句。
//
// 为什么需要：请求是鱼主动提的，不是面板生成的。原来提示词只有一句
// 「你可以提请求」，模型很容易一直不提（实测 10-25 之后再没提过）。
// 这里按「额度还有 + 确实很久没提」给一句具体的开口，同时明确「没有就不提」，
// 不逼她凑数——请求必须是她真想说的，不能为了出现而出现。

const DAY_MS = 86400000

/**
 * @param {{ remainingToday?: number, wishes?: Array<{ at?: string }> }} summary world.wishSummary() 的返回
 * @param {{ now?: number, minDays?: number }} [options]
 * @returns {string} 要接在提示词里的一句话；不该推的时候返回空串
 */
export function wishNudge(summary, { now = Date.now(), minDays = 2 } = {}) {
  const remaining = Number(summary?.remainingToday)
  if (!Number.isFinite(remaining) || remaining <= 0) return ''
  const list = Array.isArray(summary?.wishes) ? summary.wishes : []
  const lastAt = list.reduce((max, item) => {
    const at = Date.parse(String(item?.at || ''))
    return Number.isFinite(at) ? Math.max(max, at) : max
  }, 0)
  if (!lastAt) {
    return '你还没提过请求。如果确实有想做的事、想要的东西、或想改的相处方式，可以提一条；没有就不必提。'
  }
  const days = Math.floor((Number(now) - lastAt) / DAY_MS)
  if (!Number.isFinite(days) || days < minDays) return ''
  return `你已经 ${days} 天没提过请求了。如果确实有想做的事、想要的东西、或想改的相处方式，可以提一条；没有就不提，别为了凑数编。`
}
