// 鱼的记忆账本：把散在几处的记忆读到一张表上，并给一个不分平台的召回入口。
//
// 现在的实况（2026-10-28 实测）：记忆散成三份，而且**互相不认识**——
//   1. dsh-fish-memory 的会话库：`<DSH_HOME>/fish-memory/session-<会话id>.json`
//      —— 一个会话一份。三个会话就是三份记忆，换个窗口它就不记得刚才说的话；
//   2. 鱼的世界按人存的群友记忆：`<根>/鱼的记忆/群友/<QQ>.json`
//      —— 按人不按会话，但只覆盖 QQ；
//   3. 知识库：`<根>/鱼的记忆/知识库.json`
//      —— 梗、角色、外观、约定，谁都能查。
//
// 这一层只做两件事：**把三份读成一张表**（看得见），**给一个按人召回的入口**（用得着）。
// 它不搬数据、不改那三份文件——迁移是另一件事，得先在面板上让人看清要迁什么。
//
// 淡忘公式照抄 dsh-fish-memory 的（2^(-天数/半衰期)，长期事实不淡）：
// 两套公式各算各的，同一条记忆在两边鲜活度不同，召回结果就会互相打架。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DSH_HOME } from './paths.mjs'
import { wardrobeStatus } from './fish-memory-bridge.mjs'
import { formatMemoryBrief } from './memory-brief.mjs'

const DAY = 24 * 60 * 60 * 1000
/** 普通的事多久淡一半。与 dsh-fish-memory 的默认值一致。 */
const BASE_HALF_LIFE_DAYS = 30
/** 没写时间的记忆按几成鲜活算。 */
const UNKNOWN_ACTIVATION = 0.5

export const MEMORY_FOLDER = '鱼的记忆'
export const PERSONS_FOLDER = '群友'
export const KNOWLEDGE_FILE = '知识库.json'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function listJson(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 鲜活度：与 dsh-fish-memory 同一套公式（长期事实不淡，其余按半衰期指数衰减）。 */
export function activationOf(entry, now = Date.now()) {
  if (entry.category === 'stable_profile') return 1
  const anchor = entry.at || entry.updatedAt || entry.createdAt || null
  const ms = anchor ? Date.parse(anchor) : NaN
  if (!Number.isFinite(ms)) return UNKNOWN_ACTIVATION
  const days = Math.max(0, (now - ms) / DAY)
  const importance = typeof entry.importance === 'number' ? entry.importance : 0
  const halfLife = BASE_HALF_LIFE_DAYS * (1 + 2 * importance)
  return Math.pow(2, -days / halfLife)
}

/** 字面相关度：问句里的二元词在记忆里命中几个。够用，不假装是语义检索。 */
export function lexicalOf(text, query) {
  const hay = String(text || '')
  const q = String(query || '').replace(/\s+/g, '')
  if (!hay || q.length < 2) return 0
  const seen = new Set()
  let hit = 0
  for (let i = 0; i + 2 <= q.length; i += 1) {
    const gram = q.slice(i, i + 2)
    if (seen.has(gram)) continue
    seen.add(gram)
    if (hay.includes(gram)) hit += 1
  }
  return seen.size ? hit / seen.size : 0
}

/**
 * 三处记忆读成一张表。
 *
 * rootDir 是鱼的世界根目录（storage.root()），home 是 DSH_HOME。
 * 两个都传进来而不是各自去猜：猜错了会读到别人的记忆，比读不到更糟。
 */
export function readMemoryLedger({ rootDir, home = DSH_HOME } = {}) {
  const memoryDir = rootDir ? join(rootDir, MEMORY_FOLDER) : ''
  const sources = []

  // ---- 1. 会话库（dsh-fish-memory）----
  // 它把记忆按会话 id 存。这里只报「几个会话、各几条」，不合并——
  // 合并要在迁移那一步做，先让人看见碎片化到什么程度。
  const storeDir = join(home, 'fish-memory')
  const sessionFiles = listJson(storeDir).filter((name) => name.startsWith('session-'))
  const sessions = sessionFiles.map((name) => {
    const data = readJson(join(storeDir, name)) || {}
    const memories = Array.isArray(data.memories) ? data.memories : []
    return {
      file: name,
      id: name.replace(/^session-/, '').replace(/\.json$/, ''),
      total: memories.length,
      stable: memories.filter((item) => item.category === 'stable_profile').length,
      latest: memories.reduce((max, item) => Math.max(max, Date.parse(item.at || item.createdAt || 0) || 0), 0),
    }
  })
  const sessionTotal = sessions.reduce((sum, item) => sum + item.total, 0)
  sources.push({
    id: 'fish-memory',
    label: '会话记忆库',
    kind: 'sessions',
    dir: storeDir,
    exists: existsSync(storeDir),
    count: sessionTotal,
    detail: sessions,
    // 这句是这套东西的病根：会话之间不共享，换个窗口就是另一条鱼。
    note: sessions.length > 1
      ? `${sessions.length} 个会话各存一份，互不相认`
      : '只有一份会话记忆',
  })

  // ---- 2. 群友记忆（鱼的世界按人存）----
  const personsDir = memoryDir ? join(memoryDir, PERSONS_FOLDER) : ''
  const personFiles = personsDir ? listJson(personsDir) : []
  const persons = personFiles.map((name) => {
    const data = readJson(join(personsDir, name)) || {}
    return {
      qq: String(data.qq || name.replace(/\.json$/, '')),
      nickname: String(data.nickname || ''),
      total: Number(data.total) || 0,
      hasSummary: Boolean(data.summary && data.summary.text),
      updatedAt: Number(data.updatedAt) || mtimeOf(join(personsDir, name)),
    }
  })
  sources.push({
    id: 'persons',
    label: '群友记忆',
    kind: 'persons',
    dir: personsDir,
    exists: Boolean(personsDir) && existsSync(personsDir),
    count: persons.length,
    detail: persons,
    note: persons.length ? `按人不按会话，覆盖 ${persons.length} 个人` : '还没有群友记忆',
  })

  // ---- 3. 知识库 ----
  const knowledgePath = memoryDir ? join(memoryDir, KNOWLEDGE_FILE) : ''
  const knowledge = knowledgePath ? readJson(knowledgePath) : null
  const items = Array.isArray(knowledge?.items) ? knowledge.items : []
  sources.push({
    id: 'knowledge',
    label: '知识库',
    kind: 'items',
    dir: knowledgePath,
    exists: Boolean(knowledge),
    count: items.length,
    detail: items.slice(0, 20).map((item) => ({
      id: String(item?.id || ''),
      title: String(item?.title || item?.name || ''),
      tags: Array.isArray(item?.tags) ? item.tags.slice(0, 4).map(String) : [],
    })),
    note: items.length ? `${items.length} 条，谁都能查` : '知识库还是空的',
  })

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    rootDir: rootDir || '',
    wardrobe: (() => {
      try {
        return wardrobeStatus({ home })
      } catch {
        return { available: false, file: '', count: 0, latestAt: '' }
      }
    })(),
    sources,
    // 并库的「只读草稿」：面板据此说「可以并几条、几条已经有了」，但一个字都不改。
    merge: planWardrobeImport({ rootDir, home }),
    totals: {
      sessions: sessions.length,
      sessionMemories: sessionTotal,
      persons: persons.length,
      knowledge: items.length,
    },
    // 面板直接把这几句摆出来，不用它自己再拼一遍判断。
    warnings: sessions.length > 1
      ? [`会话记忆分成 ${sessions.length} 份，换个会话就记不得另一个会话里说过的话。`]
      : [],
  }
}

/** 把三处读成一条条平铺的条目（召回与迁移都用它）。 */
export function unifiedEntries({ rootDir, home = DSH_HOME } = {}) {
  const out = []
  const storeDir = join(home, 'fish-memory')
  for (const name of listJson(storeDir).filter((item) => item.startsWith('session-'))) {
    const data = readJson(join(storeDir, name)) || {}
    const sessionId = name.replace(/^session-/, '').replace(/\.json$/, '')
    for (const item of Array.isArray(data.memories) ? data.memories : []) {
      out.push({
        id: String(item.id || ''),
        text: String(item.text || ''),
        at: String(item.at || item.createdAt || ''),
        category: String(item.category || 'event'),
        importance: typeof item.importance === 'number' ? item.importance : 0,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        person: '',
        source: 'fish-memory',
        sessionId,
        // 已被取代的记忆仍然读出来，但标上「作废」，召回时排到最后。
        superseded: Boolean(item['已被取代']),
      })
    }
  }

  const memoryDir = rootDir ? join(rootDir, MEMORY_FOLDER) : ''
  const personsDir = memoryDir ? join(memoryDir, PERSONS_FOLDER) : ''
  for (const name of personsDir ? listJson(personsDir) : []) {
    const data = readJson(join(personsDir, name)) || {}
    const qq = String(data.qq || name.replace(/\.json$/, ''))
    if (data.summary && data.summary.text) {
      out.push({
        id: `person:${qq}:summary`,
        text: String(data.summary.text),
        at: data.summary.at ? new Date(Number(data.summary.at)).toISOString() : '',
        category: 'profile',
        importance: 0.8,
        tags: [],
        person: qq,
        source: 'persons',
        sessionId: '',
        superseded: false,
      })
    }
  }

  const knowledgePath = memoryDir ? join(memoryDir, KNOWLEDGE_FILE) : ''
  const knowledge = knowledgePath ? readJson(knowledgePath) : null
  for (const item of Array.isArray(knowledge?.items) ? knowledge.items : []) {
    // 知识库的真字段是 name / meaning / usage / avoid（见 lib/knowledge.mjs 的 KIND_LABEL 那边）。
    // 之前按 title / content 读，等于把每条知识读成一个光秃秃的标题——召回时什么都对不上。
    const title = String(item?.name || item?.title || '')
    const body = [item?.meaning, item?.usage, item?.avoid].filter(Boolean).map(String).join('；')
    if (!title && !body) continue
    out.push({
      id: `kb:${String(item?.id || title)}`,
      text: [title, body].filter(Boolean).join('：'),
      at: item?.checkedAt ? new Date(Number(item.checkedAt)).toISOString() : String(item?.at || item?.updatedAt || ''),
      category: 'knowledge',
      importance: 0.9,
      tags: Array.isArray(item?.tags) ? item.tags.map(String) : (Array.isArray(item?.aliases) ? item.aliases.map(String) : []),
      person: '',
      source: 'knowledge',
      sessionId: '',
      superseded: false,
    })
  }

  return out
}

/**
 * 把衣柜（dsh-fish-memory 的会话库）里「跨会话都该记得」的事，列成一份**待并入知识库**的清单。
 *
 * 只读，一个文件都不改。并数据要先让人看清：并几条、哪些早就写过、哪些说法和知识库里的撞车。
 *
 * 目标选知识库而不是新造一份存储：`fish_world action=know` 读的就是它，向量索引会自己重建。
 * 再造一个目录，就是第四份互不相认的记忆——那正是这次要治的病。
 *
 * 判定口径：
 *  · new —— 知识库没有任何一条的标题/含义与这句重合，值得并；
 *  · dup —— 同一句话知识库已经有了，不重复并；
 *  · near —— 说法不同但明显是同一件事（关键词重合过半）：要人自己挑，不自动覆盖。
 */
export function planWardrobeImport({ rootDir, home = DSH_HOME } = {}) {
  const entries = unifiedEntries({ rootDir, home })
    // 只并会话库里的事；群友印象与知识库条目本来就在按人/全局那两份里。
    .filter((entry) => entry.source === 'fish-memory' && !entry.superseded)
  const memoryDir = rootDir ? join(rootDir, MEMORY_FOLDER) : ''
  const knowledge = memoryDir ? readJson(join(memoryDir, KNOWLEDGE_FILE)) : null
  const items = Array.isArray(knowledge?.items) ? knowledge.items : []

  const candidates = entries.map((entry) => {
    const text = String(entry.text || '').trim()
    // 每条都带上 kind，三种状态都要带：判成 dup/near 的那几条，人也要看得见它是规矩还是事实。
    // 归类先按话里的意思判——会话库里大量约定是按 event 存的，只看 category 会把规矩收成流水。
    const kind = isRuleLike(text) ? 'rule' : (entry.category === 'stable_profile' ? 'profile' : 'fact')
    // 说的是哪份会话库：并库时要人判断「这条是从哪个窗口记下来的」，不写出来就只能靠猜。
    const from = String(entry.sessionId || '').slice(0, 8)
    // 「已经有」按整句比对：把 name/meaning/usage 拼成一句再比，等于要求字面完全一样，
    // 真知识库里那条通常还多写了用途，判不出重复 —— 就会把同一件事并第二遍。
    const exact = items.find((item) => itemSaidOf(item).some((said) => normText(said) === normText(text)))
    if (exact) return { id: entry.id, text, at: entry.at, kind, from, state: 'dup', matched: String(exact.id || ''), matchedText: itemSaidOf(exact).filter(Boolean).join('；') }
    const near = items.find((item) => itemSaidOf(item).some((said) => overlapOf(text, said) >= 0.6))
    return {
      id: entry.id,
      text,
      at: entry.at,
      kind,
      from,
      importance: entry.importance,
      state: near ? 'near' : 'new',
      matched: near ? String(near.id || '') : '',
      // 撞车要把**两边原文**都给出来：只看衣柜这条，人没法判断知识库里那条是不是同一个意思。
      matchedText: near ? itemSaidOf(near).filter(Boolean).join('；') : '',
      // 说清「应用草稿会怎么处置它」：撞车一律跳过、不覆盖知识库那条。
      // 这不是替主人选版本，只是让「点下去会发生什么」当场可预期。
      action: near ? 'skip' : 'merge',
      actionNote: near ? '应用草稿会跳过这一条（不覆盖知识库里那条）' : '',
    }
  })

  const fresh = candidates.filter((item) => item.state === 'new')
  const dup = candidates.filter((item) => item.state === 'dup')
  const near = candidates.filter((item) => item.state === 'near')
  // 草稿覆盖了哪几个会话：这决定了「点一次应用草稿」是不是能把散在几个窗口里的记忆一次收拢。
  // 实测它本来就跨全部会话收集（unifiedEntries 读所有 session-*.json），但面板上一直没说，
  // 于是看的人会以为「只并最新那个会话」，不敢点。
  const sessions = [...new Set(candidates.map((item) => item.from).filter(Boolean))]
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    rootDir: rootDir || '',
    knowledgeCount: items.length,
    sessions,
    counts: { total: candidates.length, new: fresh.length, dup: dup.length, near: near.length, sessions: sessions.length },
    candidates,
    note: fresh.length + near.length === 0
      ? `衣柜里 ${candidates.length} 条，知识库都已经有了，没什么可并的。`
      : `可以并 ${fresh.length} 条（来自 ${sessions.length} 个会话）；另有 ${near.length} 条说法和知识库里的接近，要人自己挑；${dup.length} 条重复不并。这一步还没改任何文件。`,
  }
}

/** 知识库里那一条「说了什么」：name / meaning / usage 分开成三句，逐句比（拼一句判不出重复）。 */
function itemSaidOf(item) {
  return [item?.name, item?.meaning, item?.usage].filter(Boolean).map(String)
}

function normText(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase()
}

/** 关键词重合度：按二元词算，取两边较小集合做分母（一条长一句短时不虚高）。 */
function overlapOf(a, b) {
  const grams = (text) => {
    const clean = normText(text)
    const set = new Set()
    for (let i = 0; i + 2 <= clean.length; i += 1) set.add(clean.slice(i, i + 2))
    return set
  }
  const left = grams(a)
  const right = grams(b)
  if (!left.size || !right.size) return 0
  let hit = 0
  for (const gram of left) if (right.has(gram)) hit += 1
  return hit / Math.min(left.size, right.size)
}

/** 说法像「约定 / 规矩 / 别怎样」的归成 rule，其余算 fact。 */
function isRuleLike(text) {
  return /(约定|规矩|规定|不要|别|不许|只能|必须|默认)/.test(String(text || ''))
}

/**
 * 执行并库：把草稿里 `new` 的那些真写进知识库。
 *
 * 这是第一次真动主人的记忆文件，所以规矩跟插件开关一样：
 *  · 先备份（`知识库.json.bak-merge-<时间戳>`，只留最近 5 份）；
 *  · 先写临时文件再改名（断电不会留下半份知识库，那会让 `action=know` 直接读不出东西）；
 *  · 写完回读文件确认真有条数，对不上就报错并把备份路径说清楚；
 *  · 只并 `new`：`dup` 不重复并，`near`（说法撞车）留给人自己挑——自动覆盖等于替她改主人说过的话；
 *  · 每一步都进 steps，面板原样画（「所有具体操作都可视化」）。
 */
export function applyWardrobeImport({ rootDir, home = DSH_HOME, now = () => new Date(), confirm = false } = {}) {
  const steps = []
  const step = (label, detail, tone) => steps.push({ label, detail: String(detail == null ? '' : detail), tone: tone || '' })

  // ⚠️ 必须显式确认：这个函数会真写主人的知识库。2026-10-28 我在一次临时探针里直接调了它，
  // 把 15 条并进了真实知识库（当时靠 .bak-merge 备份原样还原）。加这道闸，让「随手调一下」
  // 直接失败而不是悄悄写盘——会改别人数据的函数，默认必须是安全的。
  if (confirm !== true) {
    return {
      ok: false,
      error: '要真并请显式传 confirm: true（这个函数会写主人真实的记忆文件）',
      steps,
    }
  }

  const memoryDir = rootDir ? join(rootDir, MEMORY_FOLDER) : ''
  if (!memoryDir) return { ok: false, error: '还没绑定工作区，知识库在哪都不知道', steps }
  const kbPath = join(memoryDir, KNOWLEDGE_FILE)
  step('找到知识库', kbPath)

  const plan = planWardrobeImport({ rootDir, home })
  const fresh = plan.candidates.filter((item) => item.state === 'new')
  step('重算草稿', `可并 ${fresh.length} 条 · 撞车 ${plan.counts.near} 条 · 已有 ${plan.counts.dup} 条`)
  if (!fresh.length) {
    step('跳过写盘', '没有要并的新条目，知识库一个字都没动')
    return {
      ok: true,
      changed: false,
      added: 0,
      skipped: plan.counts.near + plan.counts.dup,
      counts: plan.counts,
      steps,
      note: '没有要并的新条目（撞车与重复的一律不自动并）。',
    }
  }

  const store = readJson(kbPath) || { version: 1, items: [] }
  if (!Array.isArray(store.items)) store.items = []
  const before = store.items.length
  const backup = backupKnowledge(kbPath)
  step('写前备份', basename(backup))

  const stamp = now().toISOString()
  const added = []
  for (const item of fresh) {
    const id = `fw-${String(item.id || '').replace(/[^\w-]/g, '')}`
    if (store.items.some((row) => String(row?.id || '') === id)) continue
    const entry = {
      id,
      type: item.kind === 'rule' ? 'rule' : 'fact',
      name: titleOf(item.text),
      aliases: [],
      meaning: String(item.text || '').slice(0, 400),
      usage: '',
      avoid: '',
      // 来源要能追到具体哪份会话库：知识库条目以后被问起「这是哪来的」，
      // 只写「衣柜并入」等于答不出处；带上会话短 id 才查得回原件。
      source: `衣柜并入（${stamp.slice(0, 10)}${item.from ? ' · 会话 ' + item.from : ''}）`,
      addedAt: now().getTime(),
      checkedAt: now().getTime(),
    }
    store.items = [entry, ...store.items]
    added.push(entry)
  }
  step('逐条写入', `新增 ${added.length} 条（规矩 ${added.filter((row) => row.type === 'rule').length} · 事实 ${added.filter((row) => row.type === 'fact').length}）`)

  const tmp = `${kbPath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  renameSync(tmp, kbPath)

  // 回读确认：条数对得上才算成功。
  const after = readJson(kbPath)
  const landed = Array.isArray(after?.items) ? after.items.length : -1
  if (landed !== before + added.length) {
    step('回读校验', `条数对不上（应为 ${before + added.length}，读回 ${landed}）`, 'error')
    return {
      ok: false,
      error: `写进知识库后回读条数对不上，备份在 ${backup}`,
      backup,
      steps,
    }
  }
  step('回读校验', `${before} 条 → ${landed} 条`, 'ok')
  step('索引', '向量索引会跟着变旧；要语义检索请在「知识库」卡点一次「更新索引」')
  step('回滚', `要退回去就用这份备份：${basename(backup)}`)

  return {
    ok: true,
    changed: true,
    added: added.length,
    skipped: plan.counts.near + plan.counts.dup,
    // 跳过的是哪几条、为什么跳过：光说「N 条没动」，人不知道被跳过的是不是自己在意的那条。
    skippedNear: plan.candidates.filter((item) => item.state === 'near').map((item) => ({ text: item.text, matched: item.matched })),
    items: added.map((row) => ({ id: row.id, type: row.type, name: row.name })),
    counts: { ...plan.counts, new: added.length },
    backup,
    steps,
    note: `并进去 ${added.length} 条；撞车与重复的 ${plan.counts.near + plan.counts.dup} 条没动。`,
  }
}

const KEEP_BACKUPS = 5

function backupKnowledge(file) {
  const target = `${file}.bak-merge-${Date.now()}`
  copyFileSync(file, target)
  try {
    const dir = dirname(file)
    const base = `${basename(file)}.bak-merge-`
    const old = readdirSync(dir)
      .filter((name) => name.startsWith(base))
      .map((name) => ({ name, at: Number(name.slice(base.length)) || 0 }))
      .sort((a, b) => b.at - a.at)
    for (const item of old.slice(KEEP_BACKUPS)) rmSync(join(dir, item.name), { force: true })
  } catch {
    // 清理失败不影响这次写入：备份多留几份不会坏事。
  }
  return target
}

/** 取一条知识的小标题：正文第一句，最长 24 字；没有标题的条目在面板与召回里都很难指认。 */
function titleOf(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  const cut = clean.split(/[。；;\n]/)[0] || clean
  return cut.length > 24 ? cut.slice(0, 24) + '…' : cut
}

/**
 * 按人、按话题召回那份统一记忆。
 *
 * person 传了就优先这个人的条目——但**不排他**：知识库和长期事实对谁都适用，
 * 只按人筛会把「她叫什么」这种全局事实漏掉。
 */
export function recall({ rootDir, home = DSH_HOME, query = '', person = '', limit = 6 } = {}) {
  const now = Date.now()
  const entries = unifiedEntries({ rootDir, home })
  const scored = entries
    .map((entry) => {
      const lexical = lexicalOf(entry.text, query)
      const activation = activationOf(entry, now)
      const own = person && entry.person && String(entry.person) === String(person) ? 0.25 : 0
      const stable = entry.category === 'stable_profile' || entry.category === 'profile' ? 0.2 : 0
      const penalty = entry.superseded ? -1 : 0
      return { ...entry, lexical, activation, score: lexical + activation * 0.5 + own + stable + penalty }
    })
    // 问句一个词都没命中的，只有当它够鲜活（或本来就是长期事实）才留。
    .filter((entry) => entry.lexical > 0 || entry.activation >= 0.8 || entry.category === 'stable_profile')
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
  return { query, person, total: entries.length, picked: scored }
}
/**
 * 试召回：给定一句话，看会想起哪几条——**与真正注入提示词用的是同一个 recall()**。
 *
 * 为什么要有这个出口：记忆统一做完了，但「跨会话召回有没有真生效」原本只有重启 DSH
 * 之后才知道。这个只读预览让人当场就能试：「问这句，她会想起什么」。
 * 返回的每条带来源（哪一处记忆、哪个人、多鲜活），方便判断是不是想起对了。
 */
export function recallPreview({ rootDir, home = DSH_HOME, query = '', person = '', limit = 6 } = {}) {
  const got = recall({ rootDir, home, query, person, limit })
  return {
    ok: true,
    query: String(query || ''),
    person: String(person || ''),
    total: Number(got?.total) || 0,
    picked: (got?.picked || []).map((entry) => ({
      text: String(entry.text || '').slice(0, 160),
      at: String(entry.at || ''),
      source: String(entry.source || ''),
      person: String(entry.person || ''),
      category: String(entry.category || ''),
      score: Math.round((Number(entry.score) || 0) * 100) / 100,
      activation: Math.round((Number(entry.activation) || 0) * 100) / 100,
    })),
  }
}
/**
 * 「提示词里那段『你记得的事』长什么样」——用真正注入时的同一份排版。
 *
 * 为什么不在这里自己拼一句：排版一旦分叉，面板看到的就是假的。
 * 取哪几条也照注入时的规则（recall 同参数），只是话题由人给。
 */
export function briefPreview({ rootDir, home = DSH_HOME, query = '', person = '', limit = 8 } = {}) {
  const got = recall({ rootDir, home, query, person, limit })
  const entries = got?.picked || []
  return {
    ok: true,
    query: String(query || ''),
    count: entries.length,
    text: formatMemoryBrief(entries),
  }
}
