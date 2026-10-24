// dsh-whale-widget 适配层：只读它的落盘文件，不修改挂件状态。
//
// 这样做的原因：whale-widget 没有对外暴露 cordis 服务或事件总线，唯一稳定的
// 交接面就是 $DSH_HOME 下的 roles.json / .dshw-usage.json / .dshw-size.json。
// 这些格式在 0.4.x 已经稳定；读失败时全部安静降级，不拖垮 QQ 桥。
import { join } from 'node:path'
import {
  WHALE_BUBBLE_DIRS,
  WHALE_BUBBLE_FILES,
  WHALE_ROLE_DIRS,
  WHALE_SIZE_FILES,
  WHALE_TURN_FILES,
  WHALE_USAGE_FILES,
  firstExistingDir,
  firstExistingFile,
  whalePackageDirs,
} from './paths.mjs'
import { fileExists, readJson } from './util.mjs'

const DEFAULT_ROLE = { id: 'default', name: '小鲸鱼', pinnedAt: 1, createdAt: 0 }
const BUILTIN_STICKERS = [
  { id: 'bimg_petpet', name: 'petpet', file: 'bubble-petpet.gif', format: 'gif', builtin: true },
  { id: 'bimg_money1', name: 'money1', file: 'bubble-money1.gif', format: 'gif', builtin: true },
]

export function createWhale({ home, config, logger }) {
  const roleDirs = home ? [join(home, 'whale-roles')] : WHALE_ROLE_DIRS
  const bubbleDirs = home ? [join(home, 'whale-bubble-imgs')] : WHALE_BUBBLE_DIRS
  const bubbleFiles = home ? [join(home, '.dshw-bubble.json')] : WHALE_BUBBLE_FILES
  const sizeFiles = home ? [join(home, '.dshw-size.json')] : WHALE_SIZE_FILES
  const usageFiles = home ? [join(home, '.dshw-usage.json')] : WHALE_USAGE_FILES
  const turnFiles = home ? [join(home, '.dshw-turn.json')] : WHALE_TURN_FILES

  function packageDir() {
    return whalePackageDirs()[0] || ''
  }

  function roleDir() {
    return firstExistingDir(roleDirs) || roleDirs[0]
  }

  function readRoles() {
    const dir = roleDir()
    const parsed = readJson(join(dir, 'roles.json'), null)
    const list = parsed && Array.isArray(parsed.roles) ? parsed.roles.filter((r) => r && r.id) : []
    if (!list.some((r) => r.id === 'default')) list.unshift({ ...DEFAULT_ROLE })
    return list
  }

  function sortedRoles() {
    return readRoles().slice().sort((a, b) => {
      const ap = Number(a.pinnedAt) || 0
      const bp = Number(b.pinnedAt) || 0
      if (ap && bp) return bp - ap
      if (ap) return -1
      if (bp) return 1
      return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
    })
  }

  function roleImagePath(role) {
    const id = String(role?.id || 'default')
    if (id === 'default') {
      const pkg = packageDir()
      if (pkg) {
        for (const name of ['DSniang1.png', 'DSniang02.png']) {
          const file = join(pkg, 'assets', name)
          if (fileExists(file)) return file
        }
      }
      return ''
    }
    const dir = roleDir()
    const format = String(role?.format || '').toLowerCase()
    const formats = format ? [format, 'png', 'gif', 'webp', 'apng'] : ['png', 'gif', 'webp', 'apng']
    for (const ext of [...new Set(formats)]) {
      const file = join(dir, `${id}.${ext}`)
      if (fileExists(file)) return file
    }
    return ''
  }

  function currentRole() {
    // fish.persona 是主人在「基础设置」里显式选的角色卡，优先级高于 whale.role。
    const fishPersona = String(config()?.fish?.persona || 'auto')
    const wanted = fishPersona !== 'auto' ? fishPersona : String(config().whale.role || 'auto')
    const list = sortedRoles()
    if (wanted !== 'auto') {
      const found = list.find((role) => String(role.id) === wanted || String(role.name) === wanted)
      if (found) return decorateRole(found)
    }
    return decorateRole(list[0] || DEFAULT_ROLE)
  }

  function decorateRole(role) {
    const name = String(role?.name || role?.id || '小鲸鱼')
    return {
      id: String(role?.id || 'default'),
      name,
      // 角色名默认是「鱼」；主人起过名字就用主人的命名。
      displayName: String(config()?.fish?.name || '').trim() || '鱼',
      pinned: !!(Number(role?.pinnedAt) > 0),
      createdAt: Number(role?.createdAt) || null,
      imagePath: roleImagePath(role),
      avatar: role?.id === 'default' ? '/dsh-whale/image.png' : `/dsh-whale/role-image.png?id=${encodeURIComponent(String(role?.id))}`,
    }
  }

  function sizeSettings() {
    return readJson(firstExistingFile(sizeFiles), null) || {}
  }

  function usageSummary() {
    const usage = readJson(firstExistingFile(usageFiles), null)
    if (!usage || typeof usage !== 'object') return null
    const history = usage.history && typeof usage.history === 'object' && !Array.isArray(usage.history)
      ? usage.history
      : {}
    const days = Object.keys(history).sort()
    return {
      date: String(usage.date || ''),
      currency: String(usage.lastCurrency || 'CNY'),
      balance: Number(usage.lastBalance) || 0,
      todayUsage: Number(usage.todayUsage) || 0,
      dayStart: Number(usage.dayStart) || 0,
      days: days.length,
      recent: days.slice(-7).map((day) => ({ day, amount: Number(history[day]) || 0 })),
    }
  }

  function lastTurn() {
    const turn = readJson(firstExistingFile(turnFiles), null)
    if (!turn || typeof turn !== 'object') return null
    return { seq: Number(turn.seq) || 0, updatedAt: String(turn.updatedAt || '') }
  }

  function bubbleQuips() {
    const cfg = readJson(firstExistingFile(bubbleFiles), null)
    const items = cfg && Array.isArray(cfg.items) ? cfg.items : []
    const out = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      if (item.kind === 'text' && typeof item.text === 'string' && item.text.trim()) {
        out.push(item.text.trim())
      }
    }
    return out
  }

  function stickers() {
    if (config().whale.exposeStickers === false) return []
    const pkg = packageDir()
    const dir = firstExistingDir(bubbleDirs) || bubbleDirs[0]
    const index = readJson(join(dir, 'bubble-imgs.json'), null)
    const custom = index && Array.isArray(index.images) ? index.images : []
    const out = []
    for (const def of BUILTIN_STICKERS) {
      const file = pkg ? join(pkg, 'assets', def.file) : ''
      out.push({
        id: def.id,
        name: def.name,
        format: def.format,
        builtin: true,
        path: file && fileExists(file) ? file : '',
        url: `/dsh-whale/bubble-img.png?id=${encodeURIComponent(def.id)}`,
      })
    }
    for (const image of custom) {
      if (!image || !image.id) continue
      const format = image.format === 'gif' ? 'gif' : 'png'
      const file = join(dir, `${image.id}.${format}`)
      out.push({
        id: String(image.id),
        name: String(image.name || image.id),
        format,
        builtin: false,
        path: fileExists(file) ? file : '',
        url: `/dsh-whale/bubble-img.png?id=${encodeURIComponent(String(image.id))}`,
      })
    }
    return out.filter((item) => item.path || item.url)
  }

  function findSticker(idOrName) {
    const key = String(idOrName || '').trim()
    if (!key) return null
    return stickers().find((item) => item.id === key || item.name === key) || null
  }

  /** 给扩展 / 提示词用的人格快照。 */
  function persona() {
    const role = currentRole()
    const usage = usageSummary()
    const quips = bubbleQuips()
    return {
      role,
      usage,
      quips,
      text: [
        `你现在的外显角色是「${role.name}」。`,
        role.imagePath ? `角色图片：${role.imagePath}` : '',
        quips.length ? `可以用的口癖/台词：${quips.slice(0, 8).map((x) => `「${x}」`).join('、')}` : '',
        usage ? `余额 ${usage.balance} ${usage.currency}，今日已用 ${usage.todayUsage}。` : '',
      ].filter(Boolean).join('\n'),
    }
  }

  function summary() {
    return {
      enabled: config().whale.enabled !== false,
      roleDir: roleDir(),
      roles: sortedRoles().map((role) => decorateRole(role)),
      current: currentRole(),
      usage: usageSummary(),
      size: sizeSettings(),
      lastTurn: lastTurn(),
      stickers: stickers().length,
      quips: bubbleQuips().length,
    }
  }

  return {
    roleDir,
    readRoles,
    sortedRoles,
    currentRole,
    roleImagePath,
    usageSummary,
    lastTurn,
    bubbleQuips,
    stickers,
    findSticker,
    persona,
    summary,
  }
}
