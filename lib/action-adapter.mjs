// 协议端动作适配（2026-11-20 主人要求四点五之一、之二、之三）。
//
// ── 为什么需要这一层 ──
// OneBot 11 是**协议**，不是实现。同一个动作在不同实现里叫法不一样：
//   拍一拍：SnowLuma / NapCat 都认 `friend_poke` / `group_poke`（标准扩展），
//           但 go-cqhttp 时代普遍用 `send_poke`（靠 group_id 区分群/私聊）。
//   贴表情：`set_msg_emoji_like`（标准），个别实现叫 `set_emoji_like`。
//
// 主人原话：「不支持 → 报「协议端不支持 XXX」，不照抄一个实现的命名硬调」。
//
// ── ★ 探测必须无副作用（2026-11-20 自己踩的）──
//   我最初想「调一次看看行不行」。试 `set_qq_avatar` 时传了个假 base64，
//   它返回 ok=true —— 如果协议端真接受，头像就被我探没了。
//   所以这里**不做主动探测**，改成：
//     · 首次用某个动作时按候选顺序试；
//     · 成功就缓存（下次直接用这个名）；
//     · 失败就试下一个候选；全失败才报「协议端不支持」。
//   也就是「懒探测」：只在真正要用的时候才碰，且失败信息如实抄出来。
//
// ── 自省接口 ──
// 试过 `get_supported_actions` / `get_impl_info`，SnowLuma 都不支持（ok=false）。
// 所以只能靠 get_version_info 认实现 + 上面那套懒探测。

/** 各动作的候选 action 名（按优先级）。 */
export const ACTION_CANDIDATES = Object.freeze({
  // 拍一拍：群/私聊分开（标准扩展优先，send_poke 兜底）
  pokeGroup: ['group_poke', 'send_poke'],
  pokePrivate: ['friend_poke', 'send_poke'],
  like: ['send_like'],
  recall: ['delete_msg'],
  emoji: ['set_msg_emoji_like', 'set_emoji_like'],
  card: ['set_group_card'],
  title: ['set_group_special_title'],
  avatar: ['set_qq_avatar'],
  profile: ['set_qq_profile'],
  online: ['set_online_status'],
  historyGroup: ['get_group_msg_history'],
  historyPrivate: ['get_friend_msg_history'],
  forward: ['get_forward_msg'],
  groupMembers: ['get_group_member_list'],
  groupMemberInfo: ['get_group_member_info']
})

/** 动作的中文名（报错时用）。 */
const ACTION_LABEL = Object.freeze({
  pokeGroup: '拍一拍（群）',
  pokePrivate: '拍一拍（私聊）',
  like: '点赞名片',
  recall: '撤回消息',
  emoji: '贴表情回应',
  card: '改群名片',
  title: '改群头衔',
  avatar: '换头像',
  profile: '改昵称签名',
  online: '改在线状态',
  historyGroup: '读群聊天记录',
  historyPrivate: '读私聊记录',
  forward: '展开合并转发',
  groupMembers: '读群成员列表',
  groupMemberInfo: '读群成员信息'
})

function clean(v) { return String(v == null ? '' : v).trim() }

/**
 * 这条错误像不像「不认识这个 action」。
 *
 * 各家实现的措辞不一样，这里只认最常见的几种；
 * 认不出来就当作普通失败（不去瞎试下一个候选，免得同一个动作跑两遍）。
 */
export function looksLikeUnknownAction(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return false
  return /unknown[ _-]?action|unsupported[ _-]?action|no such action|not implemented|action not found|未知[动作]|不支持的动作|未实现/.test(t)
}

/**
 * @param {object} deps
 * @param {object} deps.qq
 * @param {(line:string)=>void} [deps.log]
 */
export function createActionAdapter({ qq, log } = {}) {
  const logger = typeof log === 'function' ? log : () => {}

  /** 每种动作最终用哪个 action 名（懒探测成功后缓存）。 */
  const resolved = new Map()
  /** 彻底失败过的动作：错误信息，避免每次重试都白跑一遍。 */
  const unsupported = new Map()
  /** 协议端信息（缓存）。 */
  let protoCache = null

  /** 问协议端是谁（只读，无副作用）。 */
  async function protocol({ force = false } = {}) {
    if (protoCache && !force) return protoCache
    try {
      const r = await qq.call('get_version_info', {})
      const d = r?.data || {}
      protoCache = {
        ok: r?.ok !== false,
        name: clean(d.app_name) || 'unknown',
        version: clean(d.app_version) || '',
        protocol: clean(d.protocol_version) || ''
      }
    } catch (error) {
      protoCache = { ok: false, name: 'unknown', version: '', protocol: '', error: String(error?.message || error) }
    }
    return protoCache
  }

  /**
   * 执行一个动作：按候选名依次试，成功就记下这个名字。
   *
   * @param {string} key ACTION_CANDIDATES 里的键
   * @param {(actionName:string) => object} makeBody 给定 action 名，返回请求体
   *        （拍一拍的 send_poke 和 group_poke 参数不一样，所以是函数不是对象）
   * @returns {{ok:boolean, data:any, action:string, error:string, say:string, unsupported:boolean}}
   */
  async function run(key, makeBody) {
    const label = ACTION_LABEL[key] || key
    const candidates = ACTION_CANDIDATES[key] || []
    if (!candidates.length) {
      return { ok: false, data: null, action: '', error: 'no-candidate', say: '不认识这个动作：' + key, unsupported: true }
    }

    // 已经确认不支持的，直接报，不再白跑
    const known = unsupported.get(key)
    if (known) {
      return { ok: false, data: null, action: '', error: known, say: `协议端不支持${label}`, unsupported: true }
    }

    // 之前成功过的名字排到最前面
    const order = (() => {
      const hit = resolved.get(key)
      if (!hit) return candidates.slice()
      return [hit, ...candidates.filter((c) => c !== hit)]
    })()

    let lastError = ''
    for (const name of order) {
      let body = {}
      try {
        body = makeBody(name) || {}
      } catch (error) {
        lastError = String(error?.message || error)
        continue
      }
      let r = null
      try {
        r = await qq.call(name, body)
      } catch (error) {
        r = { ok: false, error: String(error?.message || error) }
      }
      if (r && r.ok !== false) {
        resolved.set(key, name)
        return { ok: true, data: r.data ?? null, action: name, error: '', say: '', unsupported: false }
      }

      const why = clean(r?.error) || clean(r?.data?.wording) || clean(r?.data?.message) || ''
      lastError = why || lastError

      // 只有「明确不认识这个 action」才换下一个候选；
      // 其它失败（没权限/参数不对/被拦）说明名字是对的，别重复调。
      if (!looksLikeUnknownAction(why)) {
        return { ok: false, data: r?.data ?? null, action: name, error: why, say: '', unsupported: false }
      }
    }

    // 所有候选都像"不认识" ⇒ 判定这个协议端不支持
    unsupported.set(key, lastError || 'all-candidates-rejected')
    logger(`协议端不支持${label}（试过：${candidates.join(' / ')}）`)
    return {
      ok: false, data: null, action: '', error: lastError, say: `协议端不支持${label}`, unsupported: true
    }
  }

  /** 排查用：现在认定了哪些动作名、哪些不支持。 */
  function snapshot() {
    return {
      protocol: protoCache,
      resolved: Object.fromEntries(resolved),
      unsupported: Object.fromEntries(unsupported),
      candidates: ACTION_CANDIDATES
    }
  }

  /** 换协议端了要清缓存（比如从 SnowLuma 切到 AstrBot）。 */
  function reset() {
    resolved.clear()
    unsupported.clear()
    protoCache = null
  }

  return { protocol, run, snapshot, reset, ACTION_CANDIDATES, ACTION_LABEL }
}

/**
 * 群成员反查 QQ 号（主人要求之二：@ 某人要能按昵称找号）。
 *
 * 「群里通常只有昵称/群名片，先用 get_group_member_list 反查 qq；
 *  查不到就不 @，并说「不知道是哪个，说下号」。」
 *
 * @param {object} deps
 * @param {object} deps.qq
 * @param {object} [deps.adapter] createActionAdapter 的实例（用它跑候选名）
 */
export function createMemberLookup({ qq, adapter, log } = {}) {
  const logger = typeof log === 'function' ? log : () => {}
  /** groupId → { at, list } 缓存：群成员列表不常变，缓存 5 分钟 */
  const cache = new Map()
  const TTL_MS = 5 * 60 * 1000

  async function list(groupId, { force = false } = {}) {
    const gid = clean(groupId)
    if (!gid) return []
    const hit = cache.get(gid)
    if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.list

    let r = null
    if (adapter && typeof adapter.run === 'function') {
      const out = await adapter.run('groupMembers', () => ({ group_id: Number(gid) }))
      r = out.ok ? { ok: true, data: out.data } : { ok: false, error: out.error }
    } else {
      try { r = await qq.call('get_group_member_list', { group_id: Number(gid) }) } catch (error) {
        r = { ok: false, error: String(error?.message || error) }
      }
    }
    if (!r || r.ok === false) {
      logger(`读群成员列表失败：${r?.error || ''}`)
      return []
    }
    const raw = Array.isArray(r.data) ? r.data : []
    const rows = raw.map((m) => ({
      qq: clean(m?.user_id),
      nickname: clean(m?.nickname),
      card: clean(m?.card),
      // 群名片优先（群里大家看到的就是这个）
      display: clean(m?.card) || clean(m?.nickname)
    })).filter((x) => x.qq)
    cache.set(gid, { at: Date.now(), list: rows })
    return rows
  }

  /**
   * 按名字找 QQ 号。
   *
   * @returns {{ok:true, qq:string, exact:boolean, candidates:object[]} | {ok:false, say:string, candidates:object[]}}
   */
  async function resolve(groupId, name) {
    const want = clean(name)
    if (!want) return { ok: false, say: '要 @ 谁？给我个名字', candidates: [] }
    // 已经是纯数字 ⇒ 直接当 QQ 号
    if (/^\d{5,}$/.test(want)) return { ok: true, qq: want, exact: true, candidates: [] }

    const rows = await list(groupId)
    if (!rows.length) {
      return { ok: false, say: '读不到群成员，不知道是哪个，说下号', candidates: [] }
    }

    // ① 群名片 / 昵称精确匹配
    const exact = rows.filter((x) => x.card === want || x.nickname === want)
    if (exact.length === 1) return { ok: true, qq: exact[0].qq, exact: true, candidates: exact }

    // ② 包含匹配（「小鲸鱼」→「小鲸鱼🐳」）
    const partial = rows.filter((x) => x.card.includes(want) || x.nickname.includes(want))
    if (partial.length === 1) return { ok: true, qq: partial[0].qq, exact: false, candidates: partial }
    if (partial.length > 1) {
      // ★ 有歧义就不猜（@ 错人比不 @ 更糟）
      return {
        ok: false,
        say: `「${want}」可能是 ${partial.length} 个人：${partial.slice(0, 3).map((x) => x.display).join('、')}，说下号`,
        candidates: partial
      }
    }

    return { ok: false, say: `群里没找到「${want}」，不知道是哪个，说下号`, candidates: [] }
  }

  function reset() { cache.clear() }

  return { list, resolve, reset }
}