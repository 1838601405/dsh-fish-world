// 「你记得的事」那段的**唯一**排版实现。
//
// 为什么要单独一个文件：这段文字是真正插进系统提示词的（`qq-inbox.systemMemoryBrief`），
// 面板上又要能「看看提示词里那段原文」。两处各写一遍格式，迟早出现
// 「面板上长的是一样、实际注入的是另一样」——那比看不到还坏。
//
// 只做排版，不决定取哪几条：取哪几条是 recall() 的事，调用方给 entries。
import { oneLine } from './util.mjs'

/**
 * @param {Array} entries recall() 的 picked 数组
 * @returns {string} 空数组时返回空串（提示词里不留空章节）
 */
export function formatMemoryBrief(entries = []) {
  const lines = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const when = String(entry?.at || '').slice(0, 10)
      const who = entry?.person ? `（${entry.person}）` : ''
      const text = oneLine(entry?.text, 90)
      if (!text) return ''
      return `· ${when ? when + ' ' : ''}${who}${text}`
    })
    .filter(Boolean)
  if (!lines.length) return ''
  return '【你记得的事】下面这些是你记下来的，不分平台、不分会话——群里认得的人，私聊里也该认得。' +
    '需要细节时用 fish_world（action=know 或 history）去查，别凭这几行编。\n' + lines.join('\n')
}
