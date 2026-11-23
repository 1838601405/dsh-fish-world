// 鲸鲸任务（whale-task）· 移植版
//
// 来源：`<下载目录>\鲸鲸任务-交付包.rar` 里的 `whale-task/index.js`
// （v1.0.0，1920 行，QQA 技能插件）。本文件是**移植**，不是重写：
// 行为、闸门顺序、时间轴、两次模型调用、注入文案、以及源码注释里记着的
// 那些「实测踩到」的约束，都按原样搬过来。
//
// ── 与原版的差异（都是为了嵌进 fish_world）──────────────────────────
// 1. 数据根：原版用 `data/whale-task/`；我们落到 `<世界根>/鱼的任务/`，
//    和日记/记忆/状态并列，主人能在「鱼的家」里直接看到。
// 2. 工具注册：原版 `api.registerTool({id, name, description, parameters, execute})`；
//    我们导出 `createWhaleTask()`，由 index.js 注册成 fish_world 的 action
//    （宿主那边的工具接口是 tools.register，形状不同，见 buildWhaleTaskTools）。
// 3. 注入：原版用 QQA 的 `before-llm-messages` hook；我们导出 `promptText()`，
//    由 index.js 挂到 systemPrompt 的 section 里。
// 4. 模型：原版自带 doFetch/onebot 调用；我们复用宿主的 chatApi 与 qq，
//    不重复造一套密钥/超时逻辑。
//
// ── 保持不变的关键约束（源码注释里记着「实测踩到」）──────────────────
// · 不注入剩余分钟数：每分钟变会毁掉前缀缓存。用恒定句「还没到结束时间」。
// · 说「执行任务」不说「在外面」：任务不只有外出（做饭/收拾/洗漱）。
// · 规划那次调用**不带人设**（约 1200 字），写日志那次**带人设**（约 7600 字）。
// · 必须给「月份 + 季节主词」，只给「秋天」时模型会在 11 月写出桂花（9-10 月意象）。
// · 天气只进 weather 字段，不在正文里要求「体现天气」——那是「硬加风向描写」。

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 北京时区偏移：原版统一用北京时间，不依赖系统时区。 */
const BJ_OFFSET_MS = 8 * 3600 * 1000

/** 口令词。原版写死「去吧」。 */
export const PASSWORD_WORD = '去吧'

/** 2 分钟防抖：刚出发过不许再出发。 */
const DEBOUNCE_MS = 2 * 60 * 1000

/** 时长上下限（分钟）。上限 600 = 10 小时，主人指名要的。 */
const MIN_DURATION = 5
const MAX_DURATION = 600

/** 默认延迟出发：先说「那我走啦」，60 秒后才算正式出门。 */
const DEFAULT_LEAVE_DELAY_SEC = 60

/** 召回后多久回来（分钟）。 */
const DEFAULT_COMEBACK_MINUTES = 3

/** 结束后注入「最近出去过」的窗口与条数。 */
const RECENT_WINDOW_MS = 24 * 3600 * 1000
const RECENT_LIMIT = 3

/** 重启后过期超过这个时长 → 只补记日志，不汇报（原版默认 120 分钟）。 */
const OVERDUE_REPORT_LIMIT_MIN = 120

// ───────────────────────────── 小工具 ─────────────────────────────

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function randInt(min, max) {
  const lo = Math.ceil(min)
  const hi = Math.floor(max)
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

function cap(text, maxChars) {
  const s = String(text == null ? '' : text)
  if (!maxChars || maxChars <= 0) return s
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '…'
}

/** 北京时间下的小时:分钟（原版 hhmm）。 */
export function hhmm(ts) {
  const d = new Date(Number(ts) + BJ_OFFSET_MS)
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0')
}

/** 「YYYY-MM-DD HH:mm」（北京时间）。 */
function stampFull(ts) {
  const d = new Date(Number(ts) + BJ_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
}

/** 「刚刚 / N 分钟前 / N 小时前」。 */
export function agoLabel(ts, now = Date.now()) {
  const diff = Math.max(0, Number(now) - Number(ts))
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

/**
 * 季节主词。**必须带月份**——原版注释记着：只给「秋天」时，
 * 模型在 11 月写出了「桂花」（那是 9-10 月的意象）。
 */
export function seasonLabel(ts) {
  const d = new Date(Number(ts) + BJ_OFFSET_MS)
  const m = d.getUTCMonth() + 1
  return m + '月，' + seasonOf(m)
}

export function seasonOf(month) {
  if (month >= 3 && month <= 5) return '春天'
  if (month >= 6 && month <= 8) return '夏天'
  if (month >= 9 && month <= 11) return '秋天'
  return '冬天'
}

/** 当月常见天气候选（给模型挑，避免它写不合时令的天气）。 */
export function weatherCandidates(month) {
  const table = {
    1: ['干冷', '阴天', '小寒', '起风'],
    2: ['微冷', '阴天', '回暖', '小雨'],
    3: ['回暖', '阴晴不定', '小雨', '起风'],
    4: ['转暖', '晴', '小雨', '柳絮'],
    5: ['暖和', '晴', '阵雨', '风大'],
    6: ['闷热', '阵雨', '晴', '梅雨'],
    7: ['炎热', '雷阵雨', '晴', '闷'],
    8: ['酷热', '雷阵雨', '晴', '台风'],
    9: ['转凉', '晴', '秋雨', '起风'],
    10: ['凉爽', '晴', '干燥', '起风'],
    11: ['起风', '转凉', '阴天', '初霜'],
    12: ['寒冷', '阴天', '下雪', '干冷']
  }
  return table[month] || ['晴', '阴天', '起风']
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim()
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function appendLine(file, line) {
  appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf8')
}

// ───────────────────────────── 数据层 ─────────────────────────────

/**
 * 任务数据目录：`<世界根>/鱼的任务/`。
 * 四个文件与原版一一对应，只是换了根：
 *   state.json    当前任务 + 计数
 *   events.jsonl  每行一条（小日志 + 摘要），只追加
 *   日志.md       给人看的纯文本
 *   世界设定.md   世界书（环境）
 */
export function createWhaleTaskStore({ worldRoot }) {
  const dir = () => join(String(worldRoot || ''), '鱼的任务')
  const file = (name) => join(dir(), name)

  function ensureDir() {
    const d = dir()
    if (!d || !worldRoot) return ''
    try {
      mkdirSync(d, { recursive: true })
      return d
    } catch {
      return ''
    }
  }

  function readState() {
    return readJson(file('state.json'), { activeTask: null, lastTaskStartedAt: 0, counters: {} })
  }

  function writeState(state) {
    if (!ensureDir()) return false
    try {
      writeJson(file('state.json'), state)
      return true
    } catch {
      return false
    }
  }

  /** events.jsonl：只追加不覆盖。坏了跳过坏行，不让一条坏记录毁掉整份历史。 */
  function readEvents() {
    const f = file('events.jsonl')
    if (!existsSync(f)) return []
    const out = []
    try {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          out.push(JSON.parse(t))
        } catch {
          // 单行坏掉就跳过（原版同口径）
        }
      }
    } catch {}
    return out
  }

  function appendEvent(event) {
    if (!ensureDir()) return false
    try {
      appendLine(file('events.jsonl'), JSON.stringify(event))
      return true
    } catch {
      return false
    }
  }

  /** 日志.md：纯文本，记事本可读。按时间倒序（新的插在最前）。 */
  function appendJournalMarkdown(text) {
    if (!ensureDir()) return false
    const f = file('日志.md')
    try {
      const old = existsSync(f) ? readFileSync(f, 'utf8') : ''
      const header = '# 鱼的日志\n\n> 每次任务结束自动追加，新的在最上面。\n\n'
      const body = old.startsWith('# 鱼的日志') ? old.slice(header.length) : old
      writeFileSync(f, header + text.trimEnd() + '\n\n' + body, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /**
   * 世界设定.md：第一次用时建一份空模板。
   *
   * ★ 原版坑 4/5 记着两件事，这里都照做：
   *   · 只读 data 那份（这里是 `<世界根>/鱼的任务/`），不读插件模板；
   *   · 模板里的示例写在 HTML 注释里，解析时过滤掉——否则示例会被当成真实环境注入。
   */
  function ensureWorldbook() {
    if (!ensureDir()) return false
    const f = file('世界设定.md')
    if (existsSync(f)) return true
    const tpl = [
      '# 鱼的世界设定',
      '',
      '> 写她住在哪、周围有什么。用 `##` 分段，每段一个主题。',
      '> 全空也能正常跑，她只是不知道自己在什么环境里。',
      '> 改完不用重启，下一次任务就用新内容。',
      '',
      '<!-- 例：',
      '## 住所',
      '三居室，客厅有张大沙发，厨房朝南',
      '',
      '## 外面的环境',
      '住在海边，走十分钟有菜市场，楼下有便利店，晚上路灯有点暗',
      '-->',
      ''
    ].join('\n')
    try {
      writeFileSync(f, tpl, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** 读世界设定并过滤 HTML 注释（示例不能被当成真实环境）。 */
  function parseWorldbook() {
    // 首次自动建（幂等）——否则模板永远不会落地，环境注入永远是空。
    // 这是真机跑出来的：startTask 只调 parseWorldbook（只读），没建文件。
    ensureWorldbook()
    const f = file('世界设定.md')
    if (!existsSync(f)) return ''
    try {
      const raw = readFileSync(f, 'utf8')
      return raw
        .replace(/<!--[\s\S]*?-->/g, '')
        .split('\n')
        .map((line) => line.replace(/^#\s*鱼的世界设定\s*$/, ''))
        .filter((line) => !/^>\s/.test(line))
        .join('\n')
        .trim()
    } catch {
      return ''
    }
  }

  return {
    dir,
    file,
    ensureDir,
    ensureWorldbook,
    parseWorldbook,
    readState,
    writeState,
    readEvents,
    appendEvent,
    appendJournalMarkdown
  }
}

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 闂搁棬锛堜唬鐮佸眰锛岄浂 token锛?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€


// ───────────────────────── 闸门（代码层，零 token） ─────────────────────────

/**
 * 五道闸，顺序与原版一致：
 *   ⓪ 只认主人 → ① 总开关 → ② 可选口令 → ③ 已有任务 → ④ 2 分钟防抖
 *
 * 返回 null = 放行；返回字符串 = 拦下原因（会原样告诉模型）。
 *
 * ★ 为什么必须放代码层：原版注释写得明白——判定靠意图而不是关键词，
 *   但「是不是主人」「有没有任务」这类硬条件不能交给模型，否则群里任何人
 *   说「你出去玩会儿」都能把她支走。
 */
export function gateCheck({ isOwner, enabled, requirePassword, userText, state, now = Date.now() }, opts = {}) {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS

  // ⓪ 只认主人
  if (!isOwner) return '只有主人本人的命令才能触发'

  // ① 总开关
  if (enabled === false) return '总开关关着'

  // ② 可选口令
  if (requirePassword === true) {
    const text = String(userText || '')
    if (!text.includes(PASSWORD_WORD)) return `主人还没说「${PASSWORD_WORD}」`
  }

  // ③ 已有任务
  if (state && state.activeTask) return `你已经在执行任务了（${state.activeTask.what}）`

  // ④ 2 分钟防抖
  if (state && state.lastTaskStartedAt && now - Number(state.lastTaskStartedAt) < debounceMs) {
    return '刚出发过，别急'
  }

  return null
}

// ───────────────────── 时间轴：createdAt → leaveAt → dueAt ─────────────────────

/**
 * 算三个时间点。原版口径：
 *   createdAt = 现在
 *   leaveAt   = createdAt + 延迟秒（默认 60，可设 0）
 *   dueAt     = leaveAt + 时长
 *
 * 时长夹在 [5, 600]；模型没给就用默认区间随机。
 */
export function computeTimeline({ now = Date.now(), durationMin, leaveDelaySec = DEFAULT_LEAVE_DELAY_SEC, range = { min: 20, max: 60 } } = {}) {
  let mins = Number(durationMin) || 0
  if (!(mins > 0)) mins = randInt(range.min, range.max)
  mins = Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(mins)))
  const delay = Math.max(0, Math.min(300, Number(leaveDelaySec) || 0))
  const leaveAt = now + delay * 1000
  return { createdAt: now, leaveAt, dueAt: leaveAt + mins * 60000, durationMin: mins, leaveDelaySec: delay }
}

/** 当前处在哪个阶段：'prep' 还没出门 / 'running' 执行中 / null 没任务。 */
export function taskPhase(task, now = Date.now()) {
  if (!task) return null
  return now < Number(task.leaveAt || 0) ? 'prep' : 'running'
}

// ───────────────────────── 注入文本 ─────────────────────────

/**
 * 任务进行中的注入。
 *
 * 三条硬约束（都来自原版注释里的实测踩坑）：
 *  1. **不注入剩余分钟数** —— 每分钟都在变，会让提示词前缀缓存失效。
 *     用恒定句「任务还没到结束时间」代替。
 *  2. 那句恒定句不能省 —— 实测：主人说「洗好了就回来吧」，她直接答「洗好啦」，
 *     但实际还有 12 分钟。因为不给她任何进度信号，她就顺着主人话编。
 *  3. 说「执行任务」不说「在外面」 —— 任务不只有外出，还有做饭、收拾、洗漱。
 */
export function buildTaskInjection(task) {
  if (!task) return ''
  const what = String(task.what || '一件事')
  const plan = String(task.plan || '').trim()

  if (taskPhase(task) === 'prep') {
    const lines = ['【你正准备开始】', `你马上要去做【${what}】，正在准备。`]
    if (plan) lines.push(`你出门前的打算：${plan}`)
    lines.push('主人这时候发消息，你还没开始，正常回他就行。')
    return lines.join('\n')
  }

  const lines = ['【你正在执行任务】', `你现在正在【${what}】。`]
  if (plan) lines.push(`你出门前的打算：${plan}`)
  lines.push('主人这时候给你发消息，是在手机上跟你发短信，或者隔空跟你喊话。')
  lines.push('注意：任务还没到结束时间，你现在还没做完，不要说「已经做好了/做完了」。')
  return lines.join('\n')
}

/**
 * 任务结束后注入「最近出去过」。
 * 只取窗口内（默认 24h）最近 N 条（默认 3）；没有就返回空串。
 */
export function buildRecentInjection(events, { now = Date.now(), windowMs = RECENT_WINDOW_MS, limit = RECENT_LIMIT } = {}) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && Number(e.dueAt || e.at || 0) > 0)
    .filter((e) => now - Number(e.dueAt || e.at) <= windowMs)
    .sort((a, b) => Number(b.dueAt || b.at) - Number(a.dueAt || a.at))
    .slice(0, limit)
  if (!list.length) return ''
  const lines = ['【你最近出去过】']
  for (const e of list) {
    const at = Number(e.dueAt || e.at)
    const d = new Date(at + BJ_OFFSET_MS)
    const p = (n) => String(n).padStart(2, '0')
    const when = p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
    lines.push(`· ${when} ${e.what || '一件事'}：${String(e.summary || '').trim()}`)
  }
  lines.push('')
  lines.push('主人问起的时候可以自然提到，但不用每次都主动说。')
  return lines.join('\n')
}

/**
 * 提示词总成：任务中给任务 + 环境；任务结束后给「最近出去过」。
 *
 * ★ 环境只在任务期间注入（结束就撤），结束后靠小日志和摘要回忆 —— 原版口径。
 */
export function buildPromptText({ state, events, worldbook, now = Date.now() }) {
  const parts = []
  const task = state && state.activeTask
  if (task) {
    const inj = buildTaskInjection(task)
    if (inj) parts.push(inj)
    const wb = String(worldbook || '').trim()
    if (wb) parts.push('【你所在的环境】\n' + wb)
  } else {
    const recent = buildRecentInjection(events, { now })
    if (recent) parts.push(recent)
  }
  return parts.join('\n\n')
}

// ───────────────────────── 执行层：任务生命周期 ─────────────────────────

/**
 * 鲸鲸任务服务。
 *
 * 依赖全部通过参数注入，不直接 import 宿主模块——这样单测能拿假实现跑，
 * 也不会和现有模块互相纠缠（主人要求「新模块，不改现有」）。
 *
 * @param {object} deps
 * @param {object} deps.store        createWhaleTaskStore 的返回
 * @param {() => object} deps.config 取设置（enabled / requirePassword / …）
 * @param {(opts) => Promise<{ok:boolean,text?:string,error?:string}>} deps.plan  第一次模型调用（不带人设）
 * @param {(opts) => Promise<{ok:boolean,text?:string,error?:string}>} deps.write <br>第二次模型调用（带人设）
 * @param {(text) => Promise<{ok:boolean,error?:string}>} deps.send  发 QQ
 * @param {() => string} deps.ownerQQ   主人 QQ
 * @param {(msg) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createWhaleTask({ store, config, plan, write, send, ownerQQ, log, now = () => Date.now() }) {
  const logger = typeof log === 'function' ? log : () => {}
  const cfg = () => (typeof config === 'function' ? config() || {} : {})

  /** 主人 QQ（去空白）。空 = 没配，任务功能不启动。 */
  function owner() {
    return String(typeof ownerQQ === 'function' ? ownerQQ() : ownerQQ || '').trim()
  }

  function ownerChatKey() {
    const q = owner()
    return q ? 'private:' + q : ''
  }

  // ── 闸门 ──
  function checkGate({ isOwner, userText }) {
    const s = cfg()
    return gateCheck({
      isOwner,
      enabled: s.enabled !== false,
      requirePassword: s.requirePassword === true,
      userText,
      state: store.readState(),
      now: now()
    })
  }

  // ── 开始任务 ──
  async function startTask({ what, durationMin, userText, isOwner } = {}) {
    const blocked = checkGate({ isOwner, userText })
    if (blocked) {
      return { content: `现在还不能出发：${blocked}。如果你只是回应主人，就正常说话，不用调用这个工具。`, ok: false }
    }
    const s = cfg()
    const word = String(what || '出去转转').trim().slice(0, 40) || '出去转转'

    // 第一次模型调用：规划（**不带人设**，输入很轻）
    let planned = { plan: '', durationMin: 0 }
    try {
      const r = await plan({
        what: word,
        worldbook: store.parseWorldbook(),
        month: new Date(now() + BJ_OFFSET_MS).getUTCMonth() + 1,
        season: seasonLabel(now()),
        now: now()
      })
      // ★ 模型调用失败**必须留痕**：真机跑过一次——chatApi 被关时这里返回
      //   {ok:false,reason:'disabled'}，旧代码直接吞掉，表现为「计划为空、
      //   日志为空」却查不出为什么。失败照跑（不阻断任务），但原因要能查。
      if (r && r.ok && r.text) {
        planned = parsePlan(r.text)
      } else {
        logger('规划调用没拿到内容：' + (r ? (r.error || r.reason || '返回空文本') : '无返回') + '（继续用默认时长）')
      }
    } catch (e) {
      logger('规划调用失败（继续用默认时长）：' + (e?.message || e))
    }

    // 时长：主人说了用主人的，没说用模型估的，再没有就区间随机
    const allowCustom = s.allowCustomDuration !== false
    const wanted = allowCustom
      ? Number(durationMin) || Number(planned.durationMin) || 0
      : 0
    const range = parseRange(s.durationRange, 20, 60)
    const t = computeTimeline({
      now: now(),
      durationMin: wanted,
      leaveDelaySec: num(s.leaveDelaySeconds, DEFAULT_LEAVE_DELAY_SEC, 0, 300),
      range
    })

    const st = store.readState()
    st.activeTask = {
      chatKey: ownerChatKey(),
      what: word,
      plan: planned.plan,
      createdAt: t.createdAt,
      leaveAt: t.leaveAt,
      dueAt: t.dueAt,
      durationMin: t.durationMin,
      comeBackUsed: false
    }
    st.lastTaskStartedAt = t.createdAt
    if (!store.writeState(st)) {
      return { content: '出发失败：任务状态写不进磁盘（检查世界目录权限）。', ok: false }
    }
    logger(`任务开始：「${word}」${t.durationMin} 分钟｜计划：${planned.plan || '(无)'}｜dueAt=${hhmm(t.dueAt)}`)
    return {
      ok: true,
      content: `任务已开始，${t.durationMin} 分钟后回来。你出门前的打算：${planned.plan || '(还没想好，边做边看)'}`
    }
  }

  // ── 提前召回 ──
  function comeBack({ minutes, isOwner } = {}) {
    if (!isOwner) return { content: '只有主人本人的命令才能召回。', ok: false }
    const st = store.readState()
    if (!st.activeTask) return { content: '你现在没有在执行的安排。', ok: false }
    if (st.activeTask.comeBackUsed) {
      return { content: '已经改过一次回来的时间了，这次按已经定下的来。', ok: false }
    }
    const s = cfg()
    const mins = num(minutes, num(s.comeBackMinutes, DEFAULT_COMEBACK_MINUTES, 1, 60), 1, 60)
    const at = now()
    // 召回后 dueAt = 现在 + N 分钟。leaveAt 若还在未来（还没正式出门）就一起拉到现在。
    st.activeTask.dueAt = at + mins * 60000
    if (Number(st.activeTask.leaveAt || 0) > at) st.activeTask.leaveAt = at
    st.activeTask.comeBackUsed = true
    store.writeState(st)
    logger(`召回：「${st.activeTask.what}」改为 ${mins} 分钟后回来`)
    return { ok: true, content: `好，${mins} 分钟后回来。` }
  }

  // ── 取消 ──
  function cancelTask({ isOwner } = {}) {
    if (!isOwner) return { content: '只有主人本人的命令才能取消。', ok: false }
    const st = store.readState()
    if (!st.activeTask) return { content: '你现在没有在执行的安排。', ok: false }
    const what = st.activeTask.what
    // ★ 取消 = 不汇报、不留记录：任务本身清空，但 lastTaskStartedAt 保留（防抖仍生效）。
    st.activeTask = null
    store.writeState(st)
    logger(`取消任务：「${what}」（不汇报、不留记录）`)
    return { ok: true, content: '取消掉了，这次不算数。' }
  }

  /** 到点结算：写日志 + 摘要 + 汇报。返回 {reported, logged}。 */
  async function finishTask({ task, lateMinutes = 0 } = {}) {
    const t = task || store.readState().activeTask
    if (!t) return { ok: false, error: '没有进行中的任务' }
    const st = store.readState()
    const finishedAt = now()

    // 第二次模型调用：写小日志 + 摘要 + 汇报（**带人设**）
    let result = { journal: '', summary: '', report: [] }
    try {
      const r = await write({
        what: t.what,
        plan: t.plan,
        worldbook: store.parseWorldbook(),
        month: new Date(finishedAt + BJ_OFFSET_MS).getUTCMonth() + 1,
        season: seasonLabel(finishedAt),
        weather: weatherCandidates(new Date(finishedAt + BJ_OFFSET_MS).getUTCMonth() + 1),
        recentEvents: store.readEvents(),
        now: finishedAt,
        lateMinutes
      })
      if (r && r.ok && r.text) {
        result = parseResult(r.text)
      } else {
        // 同上：失败必须留痕，否则「没写日志」和「写了但空」分不出来。
        logger('写日志调用没拿到内容：' + (r ? (r.error || r.reason || '返回空文本') : '无返回'))
      }
    } catch (e) {
      logger('写日志调用失败：' + (e?.message || e))
    }

    const event = {
      id: 'task-' + finishedAt,
      what: t.what,
      plan: t.plan || '',
      createdAt: t.createdAt,
      leaveAt: t.leaveAt,
      dueAt: finishedAt,
      durationMin: t.durationMin,
      journal: result.journal || '',
      summary: result.summary || '',
      lateMinutes: Math.max(0, Math.round(lateMinutes))
    }
    store.appendEvent(event)

    // 人看的 Markdown（内容取自 event，坏了能从这里重建）
    const md = [
      '## ' + stampFull(finishedAt) + '　' + t.what,
      '',
      '季节：' + seasonLabel(finishedAt),
      '时长：' + t.durationMin + ' 分钟',
      '',
      result.journal || '（模型没有写出正文）',
      '',
      '> 摘要：' + (result.summary || '（无）')
    ].join('\n')
    store.appendJournalMarkdown(md)

    // 清任务
    st.activeTask = null
    store.writeState(st)

    // 汇报（除非超期太久——原版：过期 > 阈值只补记日志不汇报）
    let reported = false
    if (lateMinutes <= OVERDUE_REPORT_LIMIT_MIN && result.report.length) {
      const chatKey = t.chatKey || ownerChatKey()
      for (const line of result.report) {
        const sent = await send(line, { chatKey }).catch((e) => ({ ok: false, error: String(e?.message || e) }))
        if (sent && sent.ok === false) {
          logger('这条没发出去：' + (sent.error || '未知'))
          break
        }
        reported = true
      }
    } else if (lateMinutes > OVERDUE_REPORT_LIMIT_MIN) {
      logger(`任务过期 ${Math.round(lateMinutes)} 分钟 > ${OVERDUE_REPORT_LIMIT_MIN}，只补记日志不汇报`)
    }

    logger(`任务结束：「${t.what}」｜汇报=${reported}｜日志=${result.journal ? '有' : '无'}`)
    return { ok: true, event, reported }
  }

  /**
   * 启动时补记：重启后如果任务已过期，按阈值决定汇报还是只记日志。
   * 原版坑 6：半夜关机、第二天开机不该收到「我买菜回来了」。
   */
  async function resumeOnBoot() {
    const st = store.readState()
    const t = st.activeTask
    if (!t) return { ok: true, resumed: false }
    const at = now()
    const overdue = at - Number(t.dueAt || 0)
    if (overdue < 0) {
      logger(`恢复进行中的任务：「${t.what}」，还有 ${Math.round(-overdue / 60000)} 分钟`)
      return { ok: true, resumed: true, pending: true }
    }
    const lateMinutes = overdue / 60000
    logger(`重启后发现过期任务：「${t.what}」过期 ${Math.round(lateMinutes)} 分钟`)
    const r = await finishTask({ task: t, lateMinutes })
    return { ok: true, resumed: true, finished: true, reported: r.reported }
  }

  // ── 提示词 ──
  function promptText() {
    return buildPromptText({
      state: store.readState(),
      events: store.readEvents(),
      worldbook: store.parseWorldbook(),
      now: now()
    })
  }

  return { startTask, comeBack, cancelTask, finishTask, resumeOnBoot, promptText, ownerChatKey, checkGate }
}

// ───────────────────────── 解析模型输出 ─────────────────────────

/** 规划输出：第一行可能是「时长：N」，其余是打算。 */
export function parsePlan(text) {
  const raw = String(text || '').trim()
  if (!raw) return { plan: '', durationMin: 0 }
  let durationMin = 0
  const planLines = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(/(?:时长|分钟)[：: ]*\s*(\d{1,4})/)
    if (m && !durationMin) {
      durationMin = Number(m[1]) || 0
      continue
    }
    planLines.push(t)
  }
  return { plan: planLines.join(' ').slice(0, 200), durationMin }
}

/**
 * 写日志输出：约定三段（天气/心情/正文）+ 摘要 + 汇报。
 * 用宽松解析：模型不一定严格照格式，缺哪段就留空，不让整次结算失败。
 */
export function parseResult(text) {
  const raw = String(text || '').trim()
  if (!raw) return { journal: '', summary: '', report: [] }

  let journal = ''
  let summary = ''
  let report = []

  // 摘要：找「摘要：」行
  const sm = raw.match(/摘\s*要[：:]\s*(.+)/)
  if (sm) summary = sm[1].trim()

  // 汇报：找「汇报：」之后的行，按行拆（每行一条气泡）
  const ri = raw.search(/汇\s*报[：:]/)
  if (ri >= 0) {
    const body = raw.slice(ri).replace(/^汇\s*报[：:]/, '')
    report = body
      .split('\n')
      // 每行还可能带「汇报：」前缀（模型常写成多行各带一遍），一并剥掉
      .map((l) => l.replace(/^[\s·\-*]+/, '').replace(/^汇\s*报[：:]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
  }

  // 正文：去掉「汇报」段和「摘要」行之后剩下的
  let body = ri >= 0 ? raw.slice(0, ri) : raw
  body = body.replace(/摘\s*要[：:].*/g, '')
  journal = body.trim()

  // 正文里如果混进了「天气：/心情：」字段行，保留（那是日志格式的一部分）
  if (!summary) {
    const firstLine = journal.split('\n').find((l) => l.trim())
    summary = firstLine ? cap(firstLine.trim(), 80) : ''
  }
  if (!report.length && summary) report = [summary]

  return { journal, summary, report }
}

/** 「20-60」→ {min:20,max:60}；坏值落回默认。 */
export function parseRange(value, defMin, defMax, min = 5, max = 600) {
  const m = String(value || '').match(/(\d+)\s*[-~到]\s*(\d+)/)
  if (m) {
    let a = Number(m[1])
    let b = Number(m[2])
    if (a > b) [a, b] = [b, a]
    return { min: Math.max(min, a), max: Math.min(max, b) }
  }
  return { min: defMin, max: defMax }
}

// ───────────────────────── 接到 fish_world 工具 ─────────────────────────

/**
 * 三个工具的定义（形状照宿主 tools.register 的约定：
 * `{ id, name, description, parameters, execute }`）。
 *
 * 原版是 QQA 技能插件，`api.registerTool({id, name, description, parameters, execute})`
 * —— 形状几乎一样，这里只把 execute 的签名换成宿主的 `(args, ctx)`。
 */
export function buildWhaleTaskTools({ task, worldRoot }) {
  const ownerOf = () => String(task.ownerChatKey() || '').replace(/^private:/, '')

  /** 判断这次调用是不是主人本人在对鱼说话。 */
  function isOwnerCall(ctx, args) {
    // 宿主把「谁在说话」放在 ctx.actor / ctx.chatKey；拿不到就按 args 里的提示。
    // ★ 宁可判错成「不是主人」（拦下），也不要判错成「是主人」（谁都能支走她）。
    const explicit = args && typeof args.__isOwner === 'boolean' ? args.__isOwner : undefined
    if (explicit !== undefined) return explicit
    const key = String((ctx && (ctx.chatKey || ctx.chat)) || '')
    const owner = ownerOf()
    if (!owner) return false
    return key === 'private:' + owner
  }

  /** 从最近一条主人消息里取原文（口令模式要用）。 */
  function userTextOf(ctx, args) {
    if (args && typeof args.__userText === 'string') return args.__userText
    return String((ctx && (ctx.lastUserText || ctx.userText)) || '')
  }

  const tools = [
    {
      id: 'start_task',
      name: '出门去做一件事',
      description:
        '你决定暂时离开去做点事，过一会儿回来汇报。'
        + '主人让你「出去玩会儿」「出去走走」「去做个饭」「去忙点啥」这类'
        + '让你暂时离开、之后要回来跟他讲的话时用它。',
      parameters: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            description: '你要去做什么，比如「出去玩」「做饭」「去趟超市」「散步」'
          },
          durationMin: {
            type: 'integer',
            description: '大概要多久（分钟）。主人说了就用他的；没说就留空，你自己估。'
          }
        },
        required: ['what']
      },
      async execute(args, ctx) {
        return task.startTask({
          what: args?.what,
          durationMin: args?.durationMin,
          isOwner: isOwnerCall(ctx, args),
          userText: userTextOf(ctx, args)
        })
      }
    },
    {
      id: 'come_back',
      name: '叫她回来',
      description:
        '主人让你提前结束当前任务、尽快回来时调用。'
        + '典型说法：「回来吧」「现在回来」「快回来」「差不多得了」「做完就回来」「早点回来」。'
        + '判断标准：只要是「让你提前结束、尽快回来」的意思就调用，不要求固定句式。'
        + '注意：只问进度（「洗好了吗」）不算；带了「回来」这个要求就算（「洗好了就回来吧」算）。',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'integer', description: '几分钟后回来，不传就用默认值。' }
        }
      },
      async execute(args, ctx) {
        return task.comeBack({
          minutes: args?.minutes,
          isOwner: isOwnerCall(ctx, args)
        })
      }
    },
    {
      id: 'cancel_task',
      name: '取消任务',
      description:
        '主人在你执行任务时明确说「取消任务」或「任务取消」时，取消当前任务。'
        + '取消后不会回来汇报，这次任务也不留任何记录。',
      parameters: { type: 'object', properties: {} },
      async execute(args, ctx) {
        return task.cancelTask({ isOwner: isOwnerCall(ctx, args) })
      }
    }
  ]

  return tools
}
