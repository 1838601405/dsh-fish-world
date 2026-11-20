// 改她自己的资料（2026-11-20 主人要求三）。
//
// 能改三样：头像 / 昵称+签名 / 在线状态。
//
// ── 什么时候改（这条是行为约束，代码只能做一半）──
//   只有两种来源：**她自己想改**，或**主人要求**。
//   别人让她改 → 拒绝或装作没听懂。
//   不因为一句话就换头像。
//
//   代码能做的那一半：调用方必须显式给 `source`（self / owner），
//   其它值一律拒。这样"别人让我改"在接口层就没有位置可填 ——
//   模型想给那个人改，就得先把 source 写成假的，那是它主动违规，
//   而不是"没注意到规则"。
//
// ── 频控（主人定的）──
//   头像：每天 1 次；昵称/签名：每周 1 次。
//
// ── 失败 ──
//   权限/审核失败如实说（"头像没传上去，可能被拦了"），不假装成功。
//
// ★ 为什么频控状态要落盘（不像聊天动作那样放内存）：
//   头像/昵称是**跨重启**的约束 —— 重启一次就能再改一次，那频控等于没有。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 头像：每天 1 次。 */
export const AVATAR_WINDOW_MS = 24 * 60 * 60 * 1000
/** 昵称/签名：每周 1 次。 */
export const PROFILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** 头像文件上限 2MB（主人点名）。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
/** 允许的图片后缀。 */
const AVATAR_EXT = ['.png', '.jpg', '.jpeg']

function numOr(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * @param {object} deps
 * @param {object} deps.qq          qq 模块（call / loginInfo / snapshot）
 * @param {object} [deps.activity]
 * @param {object} [deps.gate]      outbound-gate（checkAction）
 * @param {string} [deps.stateFile] 频控状态落盘路径（不给就不落盘）
 * @param {(p:string)=>string} [deps.resolvePath] 把相对路径解析成绝对（鱼箱校验）
 * @param {() => number} [deps.now]
 * @param {(line:string)=>void} [deps.log]
 */
export function createProfileEdit({
  qq,
  activity,
  gate,
  stateFile = '',
  resolvePath,
  now = () => Date.now(),
  log
} = {}) {
  const logger = typeof log === 'function' ? log : () => {}

  // ── 频控状态：读盘（重启也记得上次什么时候改的）──
  let state = { avatarAt: 0, profileAt: 0, avatarFrom: '', nickname: '', signature: '' }
  function loadState() {
    try {
      if (!stateFile || !existsSync(stateFile)) return
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (raw && typeof raw === 'object') state = { ...state, ...raw }
    } catch {}
  }
  function saveState() {
    try {
      if (!stateFile) return
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(state), 'utf8')
    } catch (error) {
      logger('profile-edit 状态落盘失败：' + String(error?.message || error))
    }
  }
  loadState()

  function act({ kind = 'profile-change', text = '', ref = '', tone = '' }) {
    try {
      activity?.append?.({
        platform: 'qq',
        kind,
        actor: 'fish',
        text: String(text || '').slice(0, 200),
        ref: String(ref || ''),
        tone: String(tone || '')
      })
    } catch {}
    logger(`[${kind}] ${text}`)
  }

  function passGate({ kind, label }) {
    try {
      if (!gate || typeof gate.checkAction !== 'function') return { ok: true }
      return gate.checkAction({ chatKey: '', kind, label })
    } catch { return { ok: true } }
  }

  /** 只有 self / owner 两种来源。 */
  function checkSource(source) {
    const s = String(source || '').trim().toLowerCase()
    if (s === 'self' || s === 'owner') return { ok: true, source: s }
    return {
      ok: false,
      say: '这个不是我自己想改，也不是主人让我改的，不改'
    }
  }

  // ───────────────────────── 头像 ─────────────────────────

  /**
   * 换头像。
   *
   * @param {object} opts
   * @param {string} opts.path    图片路径（png/jpg，≤2MB）
   * @param {string} opts.source  'self' | 'owner'
   */
  async function setAvatar({ path = '', source = '' } = {}) {
    const src = checkSource(source)
    if (!src.ok) return { ok: false, say: src.say }

    const 剩 = AVATAR_WINDOW_MS - (now() - numOr(state.avatarAt, 0))
    if (state.avatarAt && 剩 > 0) {
      const 时 = Math.max(1, Math.ceil(剩 / 3600000))
      return { ok: false, say: `今天换过了，${时} 小时后才能再换` }
    }

    let target = String(path || '').trim()
    if (!target) return { ok: false, say: '用哪张图？给我图片路径' }

    // 鱼箱校验：不让它读工作区外面的任意文件
    if (typeof resolvePath === 'function') {
      try {
        target = resolvePath(target)
      } catch (error) {
        return { ok: false, say: '这张图读不到（要在鱼箱里）' }
      }
    }

    const ext = String(target).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''
    if (!AVATAR_EXT.includes(ext)) {
      return { ok: false, say: '头像只收 png / jpg' }
    }

    let size = 0
    try {
      const { statSync } = await import('node:fs')
      size = statSync(target).size
    } catch {
      return { ok: false, say: '找不到这张图' }
    }
    if (size > AVATAR_MAX_BYTES) {
      return { ok: false, say: '图太大了（超过 2MB），压一下再给我' }
    }

    const g = passGate({ kind: 'profile-change', label: '换头像' })
    if (!g.ok) return { ok: false, say: `现在不能换：${g.reason}` }

    // OneBot 11：file 支持本地路径 / base64 / URL
    let r = null
    try {
      r = await qq.call('set_qq_avatar', { file: target })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || r?.data?.message || '').slice(0, 100)
      act({ text: `换头像失败`, ref: target.slice(-30), tone: 'failed' })
      // ★ 主人要求：如实说，不假装成功
      return { ok: false, say: '头像没传上去，可能被拦了' + (why ? `（${why}）` : '') }
    }

    const 旧 = state.avatarFrom
    state.avatarAt = now()
    state.avatarFrom = String(target).split(/[\\/]/).pop() || ''
    saveState()
    act({ text: `换了头像：${旧 || '(空)'} → ${state.avatarFrom}`, ref: state.avatarFrom })
    return { ok: true, say: '头像换了' }
  }

  // ───────────────────────── 昵称 / 签名 ─────────────────────────

  /**
   * 改昵称和/或签名。两个都给就一起改。
   *
   * @param {object} opts
   * @param {string} [opts.nickname]
   * @param {string} [opts.signature]
   * @param {string} opts.source  'self' | 'owner'
   */
  async function setProfile({ nickname = '', signature = '', source = '' } = {}) {
    const src = checkSource(source)
    if (!src.ok) return { ok: false, say: src.say }

    const 名 = String(nickname || '').trim()
    const 签 = String(signature || '').trim()
    if (!名 && !签) return { ok: false, say: '要改成什么？昵称还是签名' }

    const 剩 = PROFILE_WINDOW_MS - (now() - numOr(state.profileAt, 0))
    if (state.profileAt && 剩 > 0) {
      const 天 = Math.max(1, Math.ceil(剩 / 86400000))
      return { ok: false, say: `一周只能改一次，还要等 ${天} 天` }
    }

    const g = passGate({ kind: 'profile-change', label: `改资料 ${名} ${签}` })
    if (!g.ok) return { ok: false, say: `现在不能改：${g.reason}` }

    const body = {}
    if (名) body.nickname = 名
    if (签) body.personal_note = 签

    let r = null
    try {
      r = await qq.call('set_qq_profile', body)
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || r?.data?.message || '').slice(0, 100)
      act({ text: `改资料失败（${名 || 签}）`, tone: 'failed' })
      return { ok: false, say: '资料没改上去，可能被拦了' + (why ? `（${why}）` : '') }
    }

    const 旧名 = state.nickname
    const 旧签 = state.signature
    const 变化 = []
    if (名) { state.nickname = 名; 变化.push(`昵称 ${旧名 || '(空)'} → ${名}`) }
    if (签) { state.signature = 签; 变化.push(`签名 ${旧签 || '(空)'} → ${签}`) }
    state.profileAt = now()
    saveState()
    act({ text: 变化.join('，') })
    return { ok: true, say: 变化.length === 1 ? '改好了' : '都改好了' }
  }

  // ───────────────────────── 在线状态 ─────────────────────────

  /**
   * 改在线状态（可选动作）。
   *
   * @param {object} opts
   * @param {number|string} opts.status  100=在线 30=离开 60=忙碌 10=隐身 等
   */
  async function setOnline({ status = 100, source = '' } = {}) {
    const src = checkSource(source)
    if (!src.ok) return { ok: false, say: src.say }

    const 值 = numOr(status, -1)
    if (值 < 0) return { ok: false, say: '状态给个数字（100 在线 / 30 离开 / 60 忙碌）' }

    let r = null
    try {
      r = await qq.call('set_online_status', { status: 值 })
    } catch (error) {
      r = { ok: false, error: String(error?.message || error) }
    }
    if (!r || r.ok === false) {
      const why = String(r?.error || '').slice(0, 80)
      act({ text: `改在线状态失败`, tone: 'failed' })
      return { ok: false, say: '状态改不了' + (why ? `（${why}）` : '') }
    }
    act({ text: `在线状态改成 ${值}` })
    return { ok: true, say: '改好了' }
  }

  /** 排查用。 */
  function snapshot() {
    return {
      avatarAt: state.avatarAt,
      avatarAgeHours: state.avatarAt ? Math.round((now() - state.avatarAt) / 3600000) : -1,
      profileAt: state.profileAt,
      profileAgeDays: state.profileAt ? Math.round((now() - state.profileAt) / 86400000) : -1,
      avatarFrom: state.avatarFrom,
      nickname: state.nickname,
      signature: state.signature
    }
  }

  return {
    setAvatar,
    setProfile,
    setOnline,
    snapshot,
    AVATAR_WINDOW_MS,
    PROFILE_WINDOW_MS,
    AVATAR_MAX_BYTES
  }
}