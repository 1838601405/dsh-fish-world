// 整合包账本：把 profile 里装着的插件当成 mod，标清楚它在「养鱼」这件事里的位置。
//
// 为什么要有这一层：插件各自都能跑，但**没人知道谁和谁在做同一件事**。
// 于是同一件事被装了三遍（B 站三套、记忆两套、心情两套、算钱四处），
// 每条鱼都以为自己才是正主。账本把这些摊在桌面上：谁接管、谁借手、谁该退役、谁不动。
//
// 三条边界：
//  · 只读：这里不装、不卸、不改任何插件，只把现状读出来说清楚；
//  · 不猜：认不出来的包标成「未归类」，不硬塞进某一类；
//  · 单一真源：分类写在这张表里（MODPACK），面板不另写一份判断。
import { basename, dirname, join, resolve } from 'node:path'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEPENDENCIES, detectProfile, resolveSelfLink } from './env.mjs'
import { PLATFORMS } from './platforms.mjs'
import { DSH_HOME } from './paths.mjs'

/** 本插件自己的源码目录：用来判断 profile 里那个 link 到底指向谁。 */
const SELF_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一个 mod 在整合包里的位置。 */
export const ROLES = Object.freeze({
  core: { label: '核心', note: '鱼的世界自己，其余 mod 都围着它转' },
  absorbed: { label: '接管', note: '能力并进鱼的世界，原插件可退役' },
  borrowed: { label: '借手', note: '保留，经鱼的世界统一调用' },
  retired: { label: '退役', note: '与别的 mod 撞同一件事，只能留一个' },
  infra: { label: '不动', note: '宿主基础设施，跟养鱼无关' },
  other: { label: '未归类', note: '账本里还没有它，需要人工认领' },
})

/** 能力位的中文名。面板直接显示它，不要在 ui 里再写一份对照表。 */
export const CAPABILITY_LABELS = Object.freeze({
  fish: '鱼本体',
  memory: '长期记忆',
  mood: '心情',
  bili: 'B 站',
  speak: '主动开口',
  cost: '口粮（token）',
  desktop: '桌面挂饰',
  qq: 'QQ 通道',
  wechat: '微信通道',
  douyin: '抖音',
  tts: '朗读',
  voice: '说话风格',
  av: '音视频',
  card: '聊天卡片',
  image: '图像解码',
  context: '上下文',
  input: '输入增强',
  ui: '界面',
  provider: '供应商',
  vision: '视觉桥',
  market: '插件市场',
  session: '会话管理',
  subagent: '子代理',
  host: '宿主',
})

/**
 * 整合包清单（单一真源）。
 *
 * capabilities 是「这件事叫什么」——同一件事上站着两个 mod 就是重复项，不管包名差多远。
 * 鱼的世界自己也会出现在里面：记忆、心情、B 站、主动开口、口粮这几件事它本来就在做，
 * 所以对应插件都算重复——这正是账本要摊开的那句话。
 * purpose 写它在养鱼里干什么，而不是复述插件自述。
 */
export const MODPACK = Object.freeze([
  // ---- 核心 ----
  { name: 'dsh-fish-world', role: 'core', capabilities: ['fish', 'memory', 'mood', 'bili', 'speak', 'cost'], purpose: '鱼本体：记忆、日记、关系、平台中转' },
  { name: 'sharp', role: 'core', capabilities: ['image'], purpose: '动图解码，已随鱼的世界安装' },

  // ---- 接管：能力要并进鱼的世界 ----
  { name: 'dsh-fish-memory', role: 'absorbed', capabilities: ['memory'], purpose: '长期记忆与淡忘', retireTo: '鱼的记忆（鱼的世界）' },
  { name: 'dsh-feiyu-mood', role: 'absorbed', capabilities: ['mood'], purpose: '心情涨跌与时间线', retireTo: '鱼的状态（鱼的世界）' },
  // B 站的真源已切到 bili-whale（目标把主前置改成它），所以它从「退役」挪到「借手」：
  // 它提供字幕 + 弹幕 + 热评 + 抽帧，鱼世界只经它去刷。bili-subagent 退成可选的那条。
  { name: 'dsh-bili-whale', role: 'borrowed', capabilities: ['bili'], purpose: '刷 B 站 + 两本日记（字幕 / 弹幕 / 热评 / 抽帧）' },
  { name: 'dsh-speak-up', role: 'absorbed', capabilities: ['speak'], purpose: '没人说话时自己起话头', retireTo: '主动开口（鱼的世界）' },

  // ---- 借手：留着，经鱼的世界调用 ----
  { name: 'dsh-qq-bridge', role: 'borrowed', capabilities: ['qq'], purpose: 'QQ 收发与空间通道' },
  // 微信：收发、扫码、绑定、人格与行为都由 dsh-wechat-plugin 管（与 platforms.mjs 的
  // PLATFORMS.wechat.plugins 同一份口径）。没装 = 微信这条只是摆着。鱼世界没有自己的
  // 协议实现，所以只能算「借手」。
  { name: 'dsh-wechat-plugin', role: 'borrowed', capabilities: ['wechat'], purpose: '微信收发与扫码登录（设置 → 微信）' },
  { name: 'dsh-bili-subagent', role: 'borrowed', capabilities: ['bili'], purpose: '派子代理刷 B 站、读字幕' },
  { name: 'dsh-douyin-browser-local', role: 'borrowed', capabilities: ['douyin'], purpose: '鱼自己刷抖音、看真实画面' },
  { name: 'dsh-tts-bridge', role: 'borrowed', capabilities: ['tts'], purpose: '把话念出来' },
  // 说话风格（去 AI 味）：它自己有 prompt 段与 fish_tone / fish_judge，鱼世界不接管、
  // 也不抄它的规则，只借它的手——所以归「借手」，不留第二份风格清单。
  { name: 'dsh-fish-tone', role: 'borrowed', capabilities: ['voice'], purpose: '把话往人的方向掰一点点（prompt 段 + fish_tone / fish_judge）' },
  { name: 'dsh-ffmpeg', role: 'borrowed', capabilities: ['av'], purpose: '音视频处理' },
  { name: 'dsh-genui', role: 'borrowed', capabilities: ['card'], purpose: '聊天里画卡片/图表' },
  { name: 'dsh-cost-meter', role: 'borrowed', capabilities: ['cost'], purpose: '口粮：花了多少 token' },
  { name: 'dsh-token-diet', role: 'retired', capabilities: ['cost'], purpose: '按会话预算，与口粮账撞车', retireTo: '口粮（鱼的世界）' },
  { name: 'dsh-pet', role: 'borrowed', capabilities: ['desktop'], purpose: '桌面上那条大肥鱼' },
  { name: 'dsh-whale-widget', role: 'retired', capabilities: ['desktop'], purpose: '余额挂件，与桌宠撞车', retireTo: '桌宠（dsh-pet）或口粮卡' },

  // ---- 不动：宿主基础设施 ----
  { name: 'billion-context', role: 'infra', capabilities: ['context'], purpose: '上下文压缩' },
  { name: 'dsh-context', role: 'infra', capabilities: ['context'], purpose: '上下文洞察面板' },
  { name: 'dsh-at-file', role: 'infra', capabilities: ['input'], purpose: '@ 文件引用（聊天输入框那一层，界面类）' },
  { name: 'dsh-better-sidebar', role: 'infra', capabilities: ['ui'], purpose: '聊天窗口的侧栏：文件树 / 改动 / 任务 / 侧聊（界面类，还给别的插件开页签）' },
  { name: 'dsh-ptc-plus', role: 'infra', capabilities: ['input'], purpose: 'PTC 模式的 REPL' },
  { name: 'dsh-providers-hub', role: 'infra', capabilities: ['provider'], purpose: '供应商与账号池' },
  { name: '@liustack/modlens', role: 'infra', capabilities: ['vision'], purpose: '纯文本模型的视觉桥' },
  { name: 'dshmarket', role: 'infra', capabilities: ['market'], purpose: '插件市场' },
  { name: 'dsh-purge-archived', role: 'infra', capabilities: ['session'], purpose: '彻底删除归档会话' },
  { name: '@deepseek-ai/dsh-subagent-codex', role: 'infra', capabilities: ['subagent'], purpose: '子代理运行时' },
  { name: '@deepseek-ai/dsh-base', role: 'infra', capabilities: ['host'], purpose: '宿主基础 bundle' },
  { name: '@deepseek-ai/dsh-web-app', role: 'infra', capabilities: ['host'], purpose: '宿主 Web 界面' },
])

const BY_NAME = new Map(MODPACK.map((item) => [item.name, item]))

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function versionOf(dir) {
  const pkg = readJsonFile(join(dir, 'package.json'))
  return pkg ? String(pkg.version || '') : ''
}

/**
 * 读一份整合包现状。
 *
 * 数据来源只有两个：profile 的 package.json（声明了什么）与 node_modules（真的装没装）。
 * 不扫全盘、不联网——面板每开一次就调一次，慢一点都会显得整页卡住。
 */
export function readModpack({ home = DSH_HOME, profile } = {}) {
  const resolvedProfile = detectProfile(home, profile)
  const profileDir = join(home, 'profiles', resolvedProfile)
  const manifestPath = join(profileDir, 'package.json')
  const manifest = readJsonFile(manifestPath)

  const declared = manifest && typeof manifest.dependencies === 'object' && manifest.dependencies
    ? Object.keys(manifest.dependencies)
    : []
  const bundles = manifest && Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.map((name) => String(name))
    : []
  // bundles 里可能装着 dependencies 没写的（宿主自带），两边合起来才是「装着的全部」。
  const names = [...new Set([...declared, ...bundles])].sort((a, b) => a.localeCompare(b))

  const mods = names.map((name) => {
    const known = BY_NAME.get(name) || null
    const dir = join(profileDir, 'node_modules', name)
    const installed = existsSync(dir)
    return {
      name,
      version: installed ? versionOf(dir) : '',
      installed,
      // 装的是哪一份：`link:` 装的插件在 node_modules 里是个联接，指向真正的源码目录。
      // 这个字段只对「链接型安装」有意义（其它包读出来就是同一条路径），但它能把
      // 「node_modules 指向 A、正在跑的是 B」这种接线错位摊开——账本原来只看在不在，
      // 于是本机这种「测试副本改了半天，跑的还是桌面那份」的事，账本一句话都不说。
      realpath: (() => {
        try {
          return realpathSync(dir)
        } catch {
          return ''
        }
      })(),
      // listed = 宿主 bundles 里点着名。它不等于「正在跑」：
      // 实测 fish-memory 不在 bundles 里却确实在运行，所以这两个概念不能混着说。
      listed: bundles.includes(name),
      role: known ? known.role : 'other',
      capabilities: known ? known.capabilities.slice() : [],
      purpose: known ? known.purpose : '',
      retireTo: known ? String(known.retireTo || '') : '',
    }
  })

  // 同一件事上站着两个以上「装着的」mod，就是重复项。
  //
  // 为什么按「装着」而不是按「bundles 里列着」判：实测对不上——dsh-fish-memory 不在
  // bundles 里，但它此刻正在跑（它自己的 diag 日志每分钟还在写）。宿主到底按什么加载
  // 依赖我没能从源码核实，所以这里只断言**已经装在这台机器上**，不冒充「正在运行」。
  // 装了就已经占着同一个能力位，冲突照样成立。
  const byCapability = new Map()
  for (const mod of mods) {
    // absorbed = 能力已并进鱼世界、包本身是必需依赖（如 dsh-fish-memory）。
    // 它和 core 同站一个能力位是「接管」这个动作的结果，不是冲突——
    // 算成重复会建议主人停用必需依赖（memory-recall / memory-merge 会哑掉），
    // 这正是 2026-10-29 主人指出的误报。真要找的冲突只有 retired（撞同一件事）。
    if (mod.role === 'infra' || mod.role === 'absorbed' || !mod.installed) continue
    for (const capability of mod.capabilities) {
      if (!byCapability.has(capability)) byCapability.set(capability, [])
      byCapability.get(capability).push(mod)
    }
  }
  const duplicates = [...byCapability.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([capability, list]) => ({
      capability,
      label: CAPABILITY_LABELS[capability] || capability,
      members: list.map((mod) => mod.name),
      // 每个成员的加载状态：停用只是移出 bundles、包还在磁盘上，所以它仍占着能力位（照旧算冲突），
      // 但面板要能看出「已经停了」——否则主人停掉一个包，卡上它还赖着不走，像没停一样。
      listed: Object.fromEntries(list.map((mod) => [mod.name, Boolean(mod.listed)])),
      // 建议留下的那个：核心 > 借手 > 接管 > 退役。核心永远不动。
      keep: (list.find((mod) => mod.role === 'core')
        || list.find((mod) => mod.role === 'borrowed')
        || list.find((mod) => mod.role === 'absorbed')
        || list[0]).name,
    }))
    .sort((a, b) => a.capability.localeCompare(b.capability))

  const count = (role) => mods.filter((mod) => mod.role === role).length
  const counts = {
    total: mods.length,
    installed: mods.filter((mod) => mod.installed).length,
    listed: mods.filter((mod) => mod.listed).length,
    core: count('core'),
    absorbed: count('absorbed'),
    borrowed: count('borrowed'),
    retired: count('retired'),
    infra: count('infra'),
    other: count('other'),
    duplicates: duplicates.length,
  }

  // 鱼的世界自己要用到的依赖（env.mjs 的 DEPENDENCIES）单独列一遍：
  // 账本关心「装了什么」，这里关心「鱼要用的那几个在不在」。
  const needs = DEPENDENCIES.map((dep) => {
    const mod = mods.find((item) => item.name === dep.name)
    return {
      name: dep.name,
      label: dep.label,
      optional: dep.optional === true,
      installed: mod ? mod.installed : existsSync(join(profileDir, 'node_modules', dep.name)),
      listed: mod ? mod.listed : false,
    }
  })

  // 接线错位：node_modules 里那份「鱼的世界」是不是就是**现在正在跑的这份**？
  // 本机实测踩到：测试副本改了半晚，profile 的 link 仍指向桌面那份正式版，
  // 于是体检/环境自检一直报「接线异常」，而账本一句话都没说。
  // 判定只走 env.mjs 的 resolveSelfLink 一处：体检与账本必须给同一个答案，
  // 各写一遍迟早出现「体检说错了、账本说对了」。
  const link = resolveSelfLink({ home, profile: resolvedProfile, sourceDir: SELF_DIR })
  const selfLink = {
    ok: link.ok,
    status: link.status,
    target: link.target || '',
    expected: link.expected || SELF_DIR,
    ...(link.status === 'missing' ? { missing: true } : {}),
    // 没装的时候，「profile 有没有声明它」决定了「修联接」有没有意义：
    // 没写进 dependencies/bundles 的包，建了联接宿主也不会加载。面板据此决定给按钮还是给说明。
    declared: link.status === 'missing'
      ? {
        dependency: Boolean(manifest?.dependencies?.['dsh-fish-world']),
        bundle: Array.isArray(manifest?.dsh?.profile?.bundles)
          && manifest.dsh.profile.bundles.includes('dsh-fish-world'),
      }
      : null,
  }

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    profile: resolvedProfile,
    profileDir,
    manifestFound: Boolean(manifest),
    mods,
    duplicates,
    selfLink,
    // 账本还不认识的包（新装的）：面板要能直接看见名字，而不是只看到一个「未归类 N」。
    // 以前只算了数，人得自己去 node_modules 里翻，等于没看见。
    unknown: mods.filter((mod) => mod.role === 'other').map((mod) => ({ name: mod.name, version: mod.version || '' })),
    counts,
    needs,
    roles: ROLES,
    capabilityLabels: CAPABILITY_LABELS,
  }
}

/**
 * 账本里还认不出来的包（新装的东西）。面板要能看见它们，而不是静默吞掉。
 */
export function unknownMods(report) {
  return (report?.mods || []).filter((mod) => mod.role === 'other').map((mod) => mod.name)
}

/** 保留几份 package.json 的备份。改坏了能回退，但不会堆一屏。 */
const KEEP_BACKUPS = 5

/** 角色中文名。写在这里而不是 ui 里：面板与后端说同一套话。 */
const ROLE_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(ROLES).map(([key, value]) => [key, value.label]),
))

function backupManifest(file) {
  const stamp = Date.now()
  const target = `${file}.bak-hub-${stamp}`
  copyFileSync(file, target)
  // 只留最近几份：这些备份是「刚才改坏了」用的，不是版本库。
  try {
    const dir = dirname(file)
    const base = basename(file) + '.bak-hub-'
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

/**
 * 把 profile 里 `node_modules/dsh-fish-world` 那个联接重新指到**当前这份源码**。
 *
 * 场景：改了 A 目录、profile 装的却是 B——重启也不会生效，体检与账本都在报错位，
 * 但一直到这一步之前，没有任何地方能动手修。
 *
 * 三条纪律（跟改造 bundles 开关同一套）：
 *  · 必须显式 `confirm: true`：这会动主人真实 profile 里的东西，随手调一下不该写；
 *  · 只动**联接/软链**：如果那里是个实体目录（有人把插件整份拷进去了），一律拒绝——
 *    删实体目录是不可逆的，不在这个函数该做的事里；
 *  · 写后回读：用同一份 resolveSelfLink 再判一次，不是「我以为指过去了」。
 */
export function repairSelfLink({ home = DSH_HOME, profile, sourceDir = SELF_DIR, confirm = false } = {}) {
  const steps = []
  const step = (label, detail, tone) => steps.push({ label, detail: String(detail == null ? '' : detail), tone: tone || '' })

  if (confirm !== true) {
    return { ok: false, error: '要真改请显式传 confirm: true（这会动 profile 里那个联接）', steps }
  }

  const resolvedProfile = detectProfile(home, profile)
  const profileDir = join(home, 'profiles', resolvedProfile)
  const target = join(profileDir, 'node_modules', 'dsh-fish-world')
  const before = resolveSelfLink({ home, profile: resolvedProfile, sourceDir })
  step('看现在指着哪', before.status === 'ok' ? '已经指向当前这份，不用改' : `${before.status}：${before.target || '（没有）'}`)

  if (before.ok) {
    step('跳过', '本来就是对的不写盘', 'ok')
    return { ok: true, changed: false, status: 'ok', target: before.target, expected: before.expected, steps, note: '联接本来就指向当前这份，没动。' }
  }
  if (before.status === 'not-link') {
    step('拒绝', '那里是个实体目录，不删', 'error')
    return { ok: false, error: 'node_modules/dsh-fish-world 是个实体目录（不是联接），这里不删实体目录；请手动处理。', steps }
  }
  if (before.status === 'unreadable') {
    step('拒绝', '读不动，先查权限', 'error')
    return { ok: false, error: 'node_modules/dsh-fish-world 读不动（可能是权限或正被占用）', steps }
  }
  if (!existsSync(sourceDir)) {
    step('拒绝', '当前源码目录不存在', 'error')
    return { ok: false, error: `当前源码目录不存在：${sourceDir}`, steps }
  }

  // 「没装进 node_modules」这种情况要先看 profile 有没有声明它：
  // 没写进 dependencies 的包，建了联接宿主也不会加载它 —— 那等于修了个假的。
  // 这一步**不改 package.json**（那要另外一套备份+回读），缺什么就明说要手动加什么。
  if (before.status === 'missing') {
    const manifest = readJsonFile(join(profileDir, 'package.json'))
    if (!manifest) {
      step('拒绝', 'profile 的 package.json 读不出来', 'error')
      return { ok: false, error: 'profile 的 package.json 读不出来，先别动联接。', steps }
    }
    const declared = Boolean(manifest?.dependencies?.['dsh-fish-world'])
    const bundled = Array.isArray(manifest?.dsh?.profile?.bundles)
      && manifest.dsh.profile.bundles.includes('dsh-fish-world')
    step('看声明', `dependencies ${declared ? '有' : '没有'} · bundles ${bundled ? '有' : '没有'}`)
    if (!declared || !bundled) {
      const missing = []
      if (!declared) missing.push('dependencies 里加 "dsh-fish-world": "link:<源码目录>"')
      if (!bundled) missing.push('dsh.profile.bundles 里加 "dsh-fish-world"')
      step('拒绝', 'profile 还没声明它，建联接也不会被加载', 'error')
      return {
        ok: false,
        error: `profile 还没声明 dsh-fish-world（${missing.join('；')}）。这一步不替你改 package.json，请手动加上再回来修联接。`,
        steps,
      }
    }
  }

  try {
    // 旧联接先摘掉；只在确认它确实是联接/软链之后才摘。
    if (existsSync(target) || before.status === 'wrong-target') {
      const stat = (() => {
        try {
          return lstatSync(target)
        } catch {
          return null
        }
      })()
      if (stat && !stat.isSymbolicLink()) {
        step('拒绝', '临到动手发现不是联接', 'error')
        return { ok: false, error: 'node_modules/dsh-fish-world 不是联接，已停手没删。', steps }
      }
      rmSync(target, { force: true })
      step('摘掉旧联接', before.target || '（空）')
    }
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(sourceDir, target, process.platform === 'win32' ? 'junction' : 'dir')
    step('新建联接', `${target} → ${sourceDir}`)
  } catch (error) {
    step('写的时候出错', String(error?.message || error), 'error')
    return { ok: false, error: '改联接失败：' + String(error?.message || error), steps }
  }

  const after = resolveSelfLink({ home, profile: resolvedProfile, sourceDir })
  if (!after.ok) {
    step('回读校验', `还是对不上：${after.status}`, 'error')
    return { ok: false, error: `改完回读仍然对不上（${after.status}），原来的指向：${before.target || '（空）'}`, steps }
  }
  step('回读校验', '现在指向当前这份', 'ok')
  step('生效时机', '重启 DSH 后才会加载新目录（这一步我不会替你重启）')
  return {
    ok: true,
    changed: true,
    status: after.status,
    target: after.target,
    expected: after.expected,
    backup: before.target,
    steps,
    note: '联接已指向当前这份；重启 DSH 后生效。',
  }
}

/**
 * 把 `dsh-fish-world` 写进 profile 的清单（`dependencies` 一条 + `dsh.profile.bundles` 一条）。
 *
 * 为什么要单独一个函数：`repairSelfLink` 只管联接，「没声明」时建联接没意义。
 * 声明要改 `package.json`，跟改联接是两件事——分开做、各自可回读，出问题才说得清是哪一步坏。
 * 规矩同 `setModEnabled`：`confirm` 必填、写前备份、原子写、写后回读。
 */
export function declareSelf({ home = DSH_HOME, profile, sourceDir = SELF_DIR, confirm = false } = {}) {
  const steps = []
  const step = (label, detail, tone) => steps.push({ label, detail: String(detail == null ? '' : detail), tone: tone || '' })

  if (confirm !== true) {
    return { ok: false, error: '要真改请显式传 confirm: true（这会改 profile 的 package.json）', steps }
  }
  if (!existsSync(sourceDir)) {
    return { ok: false, error: `源码目录不存在：${sourceDir}`, steps }
  }

  const resolvedProfile = detectProfile(home, profile)
  const manifestPath = join(home, 'profiles', resolvedProfile, 'package.json')
  const manifest = readJsonFile(manifestPath)
  if (!manifest) return { ok: false, error: `读不到 profile 的 package.json：${manifestPath}`, steps }
  step('读 profile', manifestPath)

  const spec = `link:${sourceDir.replace(/\\/g, '/')}`
  const hasDep = Boolean(manifest?.dependencies?.['dsh-fish-world'])
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.map(String) : []
  const hasBundle = bundles.includes('dsh-fish-world')
  step('看现状', `dependencies ${hasDep ? '有' : '没有'} · bundles ${hasBundle ? '有' : '没有'}`)

  if (hasDep && hasBundle) {
    step('跳过写盘', '两处都声明过了，没有动文件', 'ok')
    return { ok: true, changed: false, steps, note: 'profile 已经声明过 dsh-fish-world，没动文件。' }
  }

  const backup = backupManifest(manifestPath)
  step('写前备份', basename(backup))

  const patched = {
    ...manifest,
    dependencies: { ...(manifest.dependencies || {}), ...(hasDep ? {} : { 'dsh-fish-world': spec }) },
    dsh: {
      ...(manifest.dsh || {}),
      profile: {
        ...(manifest?.dsh?.profile || {}),
        // 与宿主一致：新 bundle 追加到末尾（顺序决定 patch 叠加次序）。
        bundles: hasBundle ? bundles : [...bundles, 'dsh-fish-world'],
      },
    },
  }
  const tmp = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(patched, null, 2) + '\n', 'utf8')
  renameSync(tmp, manifestPath)
  step('写入', [hasDep ? '' : 'dependencies 加了 link 记录', hasBundle ? '' : 'bundles 追加了一条'].filter(Boolean).join('；'))

  const after = readJsonFile(manifestPath)
  const okDep = Boolean(after?.dependencies?.['dsh-fish-world'])
  const okBundle = Array.isArray(after?.dsh?.profile?.bundles) && after.dsh.profile.bundles.includes('dsh-fish-world')
  if (!okDep || !okBundle) {
    step('回读校验', `dependencies ${okDep ? '有' : '没有'} · bundles ${okBundle ? '有' : '没有'}`, 'error')
    return { ok: false, error: `写进 package.json 后回读对不上，备份在 ${backup}`, backup, steps }
  }
  step('回读校验', '两处都在了', 'ok')
  return { ok: true, changed: true, backup, spec, steps, note: '已写进 profile 清单（dependencies + bundles）；重启 DSH 后生效。' }
}

/**
 * 把某个 mod 真正写进 / 移出宿主的加载列表（profile 的 `dsh.profile.bundles`）。
 *
 * 「面板上的开关必须真的落到插件上」——所以这里：
 *  · 写的是宿主自己读的那一份清单，不是另存一份影子；
 *  · 写前备份、写后**回读文件**确认真的落盘了，回读对不上就报错，不假成功；
 *  · 不卸载包：停用只是移出加载列表，随时能开回来（卸载是不可逆的另一件事）。
 *
 * 与宿主自己的行为对齐（从 dsh 安装目录里的实现读出来的，不是猜的）：
 *  · `dsh.profile.bundles` 是**有序**合成列表，顺序决定各 bundle 的 patch 叠加次序；
 *  · 停用 = 从列表移除，但**保留 dependencies 记录**（这样还能再开回来）；
 *  · 启用 = 追加到列表**末尾**——宿主自己安装后也是这么加的。
 */
export function setModEnabled({ home = DSH_HOME, profile, name, enabled = true } = {}) {
  // 「所有具体操作都要看得见」：返回里除结论外，还要带上**每一步真正做了什么**。
  // 面板照着 steps 画时间线，不做二次推断——写没写、备份在哪、回读对不对，都是这里的原话。
  const steps = []
  const step = (label, detail, tone) => steps.push({ label, detail: String(detail == null ? '' : detail), tone: tone || '' })
  const target = String(name || '').trim()
  if (!target) throw new Error('缺少包名')
  const resolvedProfile = detectProfile(home, profile)
  const profileDir = join(home, 'profiles', resolvedProfile)
  const manifestPath = join(profileDir, 'package.json')
  step('找到 profile', `${resolvedProfile} · ${manifestPath}`)
  const manifest = readJsonFile(manifestPath)
  if (!manifest) throw new Error(`找不到 profile 的 package.json：${manifestPath}`)

  const report = readModpack({ home, profile: resolvedProfile })
  const mod = report.mods.find((item) => item.name === target)
  if (!mod) throw new Error(`账本里没有这个包：${target}`)
  const wanted = Boolean(enabled)
  step('查账本', `${target} · ${ROLE_LABELS[mod.role] || mod.role}${mod.installed ? ' · 已装 ' + (mod.version || '') : ' · 未装'}`)
  // 停用自己 = 面板和工具一起消失，没有第二次机会点回来。开着它当然可以。
  if (!wanted && target === 'dsh-fish-world') throw new Error('不能停用鱼的世界自己：停了这个面板也没了')
  if (wanted && !mod.installed) throw new Error(`这个包没装，开不了：${target}`)
  step('过守卫', !wanted ? '不是鱼的世界自己，可以停' : '已装，可以开')

  const current = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.map(String)
    : []
  if (current.includes(target) === wanted) {
    // 已经是要的状态：不写文件（少一次写就少一次坏的机会），但仍把现状回给调用方。
    step('跳过写盘', '加载列表里本来就是这个状态，没有动文件')
    return {
      ok: true,
      changed: false,
      name: target,
      listed: mod.listed,
      installed: mod.installed,
      bundles: current,
      steps,
      note: '本来就是这个状态，没有改文件',
    }
  }

  const next = wanted ? [...current, target] : current.filter((item) => item !== target)
  const backup = backupManifest(manifestPath)
  step('写前备份', basename(backup))
  const patched = {
    ...manifest,
    dsh: { ...(manifest.dsh || {}), profile: { ...(manifest?.dsh?.profile || {}), bundles: next } },
  }
  // 先写临时文件再改名：中途断电不会留下半份 package.json（那是整个 profile 都起不来）。
  const tmp = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(patched, null, 2) + '\n', 'utf8')
  renameSync(tmp, manifestPath)
  step(wanted ? '追加到加载列表末尾' : '从加载列表移除', `${current.length} 项 → ${next.length} 项`)

  // 回读确认：真落盘了才算成功。读回来不对就当场说，不留「以为改好了」。
  const after = readJsonFile(manifestPath)
  const landed = Array.isArray(after?.dsh?.profile?.bundles)
    ? after.dsh.profile.bundles.map(String)
    : []
  if (landed.includes(target) !== wanted) {
    step('回读校验', '对不上', 'error')
    throw new Error(`写进 ${basename(manifestPath)} 后又读回来对不上，已保留备份：${backup}`)
  }
  step('回读校验', `${basename(manifestPath)} 里已经是目标状态`, 'ok')

  // 停掉鱼的世界自己要用的依赖，得先说清代价，而不是等它下次不工作。
  const need = DEPENDENCIES.find((dep) => dep.name === target)
  const warning = !wanted && need && need.optional !== true && need.core !== true
    ? `「${need.label}」停用后，${need.feature}会不可用。`
    : ''
  if (warning) step('提醒代价', warning, 'warn')
  step('生效时机', '重启 DSH 后生效（这一步我不会替你重启）')

  return {
    ok: true,
    changed: true,
    name: target,
    listed: wanted,
    installed: mod.installed,
    bundles: landed,
    backup,
    warning,
    steps,
    note: wanted
      ? '已写进宿主的加载列表，重启 DSH 后生效'
      : '已移出宿主的加载列表，重启 DSH 后生效；包还在，随时能开回来',
  }
}

/**
 * 鱼自己的工具盘：fish_world 这一个工具下挂着的全部动作，按「做什么」归类。
 *
 * 为什么要有（P3 读取侧）：账本现在能回答「装了哪些插件」，但回答不了
 * 「我手上到底有哪些手」。这两件事不一样——插件装了不等于鱼能用它；
 * 鱼真正能动的，是 fish_world 这个工具的动作表。
 *
 * 这张表只做展示，不收参数、不调任何东西：真正的调用入口在 lib/tool.mjs。
 * actions 里列的动作名必须都能在 lib/tool.mjs 的 ACTIONS 里找到（tests 会核）。
 */
/**
 * 鱼世界**自己另外注册**、但不走 `fish_world` 动作枚举的独立工具。
 *
 * 为什么单列：这张动作清单是按 `ACTIONS` 枚举画的，`read_animation` 注册的是独立工具，
 * 不在枚举里——于是「鱼手上有什么」这张卡对它自己的一部分手是瞎的。
 * 只列已知的，不猜：`read_image` 是**宿主内置**的，不算在鱼世界名下。
 */
export const OWN_TOOLS = Object.freeze([
  { name: 'read_animation', label: '读动图', note: '把 GIF / 动态 WebP 采样成带时间戳的帧', source: 'fish-world 核心' },
])

export const TOOL_GROUPS = Object.freeze([  {
    id: 'chat',
    label: '说话与看聊天',
    note: '对外的嘴：发消息、翻历史、展开转发',
    actions: [
      { name: 'send', note: '发一条消息（文字 + 可选图片）', require: ['dsh-qq-bridge'], gate: 'qqSend' },
      { name: 'history', note: '读某个人的最近消息', require: ['dsh-qq-bridge'], gate: 'qqRead' },
      { name: 'forward', note: '摊开一条合并转发', require: ['dsh-qq-bridge'], gate: 'qqRead' },
      { name: 'qq-status', note: 'QQ 通道还好着没', require: ['dsh-qq-bridge'] },
    ],
  },
  {
    id: 'memory',
    label: '记忆',
    note: '她记着什么、能想起什么',
    actions: [
      { name: 'know', note: '查知识库；rebuild=true 顺手重建索引' },
      { name: 'record', note: '读记录 / 带 text 就记一条' },
      { name: 'growth', note: '记下一点自己的变化' },
    ],
  },
  {
    id: 'world',
    label: '自己的日子',
    note: '日记、请求、心情、关系',
    actions: [
      { name: 'diary', note: '写日记 / 读日记' },
      { name: 'diary-comment-ack', note: '回应主人在日记上的批语' },
      { name: 'wish', note: '提一个请求' },
      { name: 'world', note: '世界总览' },
      { name: 'relations', note: '关系表' },
      { name: 'platforms', note: '各平台开关与状态' },
      { name: 'activity', note: '鱼在各平台的活动' },
    ],
  },
  {
    id: 'collect',
    label: '收藏',
    note: '表情、网站',
    actions: [
      { name: 'stickers', note: '看表情库（同 sticker-list）' },
      { name: 'sticker-list', note: '列表情，可按关键词/标签筛' },
      { name: 'sticker-collect', note: '收一张表情' },
      { name: 'sticker-send', note: '发一张表情', require: ['dsh-qq-bridge'], gate: 'qqSend' },
      { name: 'sticker-tags', note: '改表情标签（按 id / 名称）' },
      { name: 'sticker-remove', note: '删一张表情' },
      { name: 'link-list', note: '看收藏的网站' },
      { name: 'link-collect', note: '存一个网站' },
      { name: 'link-remove', note: '删一个网站' },
    ],
  },
  {
    id: 'video',
    label: '视频',
    note: '剪辑、抽帧、转码、烧字幕（借 dsh-ffmpeg 的手）',
    actions: [
      { name: 'video', note: '剪片 / 转 GIF / 抽帧 / 转码 / 烧字幕 / 自检', require: ['dsh-ffmpeg'] },
    ],
  },
  {
    id: 'qzone',
    label: '空间',
    note: '鱼自己的 QQ 空间（只在主人会话里能动）',
    actions: [
      { name: 'qzone-status', note: '今天写过没、额度剩多少', require: ['dsh-qq-bridge'] },
      { name: 'qzone-feeds', note: '看最近的动态', require: ['dsh-qq-bridge'] },
      { name: 'qzone-comments', note: '看评论', require: ['dsh-qq-bridge'] },
      { name: 'qzone-post', note: '发一条动态', require: ['dsh-qq-bridge'], gate: 'qqQzone' },
      { name: 'qzone-diary', note: '发一篇空间日记', require: ['dsh-qq-bridge'], gate: 'qqQzone' },
      { name: 'qzone-like', note: '点赞', require: ['dsh-qq-bridge'], gate: 'qqQzone' },
      { name: 'qzone-comment', note: '评论', require: ['dsh-qq-bridge'], gate: 'qqQzone' },
      { name: 'qzone-reply', note: '回复评论', require: ['dsh-qq-bridge'], gate: 'qqQzone' },
    ],
  },
  {
    id: 'borrow',
    label: '借来的手',
    note: '别的插件出工具，鱼自己说',
    actions: [
      { name: 'astrbot-tools', note: '看 AstrBot 里有什么工具可借', gate: 'astrbotBorrow' },
      { name: 'astrbot-tool', note: '借 AstrBot 的一个工具执行', gate: 'astrbotBorrow' },
      { name: 'qqagent-tools', note: '看 QQ Agent 里有什么工具可借', gate: 'qqagent' },
      { name: 'qqagent-tool', note: '借 QQ Agent 的一个工具执行', gate: 'qqagent' },
    ],
  },
  {
    id: 'self',
    label: '她自己与体检',
    note: '状态、人设、自检',
    actions: [
      { name: 'status', note: '自己的状态' },
      { name: 'list', note: '看有哪些扩展' },
      { name: 'enable', note: '开一个扩展' },
      { name: 'disable', note: '关一个扩展' },
      { name: 'reload', note: '重载扩展' },
      { name: 'persona', note: '人设当前是什么' },
      { name: 'doctor', note: '体检；ok=跑完，healthy=结论' },
      { name: 'env-check', note: '环境自检' },
    ],
  },
])

/**
 * 把工具盘和真账本、以及**运行时闸门**对一遍：哪些动作现在真能用、用不了是因为缺插件还是没开开关。
 *
 * 判定很朴素：
 *  · `require` —— 背后那个包装没装 → 报「缺 X」；
 *  · `gate` —— 装了但闸门没过（平台关闭、外发开关没开、借手没授权）→ 报「闸门没过」并带上原因；
 *  · 两者都没有的动作是鱼自己的（读写本地），一律可用。
 *
 * gates 由调用方（HTTP 面）现算，不在这里读配置：这一层要能离线跑测试。
 * gates 缺项按「没过」处理还是「不管」？—— 不管。调用方没给的闸门说明它不清楚这件事，
 * 与其瞎报一个「不可用」，不如只按 require 判。
 */
export function toolInventory({ report, toolGroups = TOOL_GROUPS, gates = {} } = {}) {
  const installed = new Map((report?.mods || []).map((mod) => [mod.name, mod.installed]))
  const groups = toolGroups.map((group) => {
    const actions = group.actions.map((action) => {
      const needs = Array.isArray(action.require) ? action.require : []
      const missing = needs.filter((name) => !installed.get(name))
      const gate = action.gate ? gates[action.gate] : null
      const blockedByGate = Boolean(gate) && gate.ok !== true
      // 调用方没给这个闸门（预览、单测、老接线）：不能当成「闸门过了」，
      // 报「能用」就是假读数。标出来，面板照实写「闸门未核」。
      const gateUnknown = Boolean(action.gate) && !gate
      return {
        name: action.name,
        note: action.note || '',
        require: needs,
        gate: action.gate || '',
        available: missing.length === 0 && !blockedByGate,
        missing,
        gateUnknown,
        // 闸门给的原因原样带回去（「QQ 当前处于关闭状态」这类），不在这一层重写一遍话术。
        blocked: missing.length ? 'plugin' : (blockedByGate ? 'gate' : ''),
        reason: blockedByGate && !missing.length ? String(gate.reason || '闸门没过') : '',
      }
    })
    return {
      id: group.id,
      label: group.label,
      note: group.note || '',
      actions,
      total: actions.length,
      available: actions.filter((action) => action.available).length,
    }
  })
  const all = groups.flatMap((group) => group.actions)
  return {
    ok: true,
    groups,
    // 鱼世界自己另外注册、不走 fish_world 动作枚举的独立工具（目前就一个）。
    ownTools: OWN_TOOLS,
    counts: {
      total: all.length,
      available: all.filter((action) => action.available).length,
      noPlugin: all.filter((action) => action.blocked === 'plugin').length,
      noGate: all.filter((action) => action.blocked === 'gate').length,
      // 有闸门但这次没取到闸门状态：既不是「能用」也不是「不能用」，得单列一个数。
      unverified: all.filter((action) => action.gateUnknown).length,
      blocked: all.filter((action) => !action.available).length,
    },
  }
}

/**
 * 退役影响预演：把某个包当成「没装」，重算一遍动作清单，看会失去哪些手。
 *
 * 只算不写：这是给「要不要停用它」提供数字，不是替人做决定。
 * 为什么值得算：插件之间不是孤立地重复——停掉 B 站那个，鱼可能还有别的动作要跟着哑；
 * 光看「重复能力位」那一行，人根本不知道自己会失去什么。
 */
export function retireImpact({ report, gates = {}, name, toolGroups = TOOL_GROUPS } = {}) {
  const target = String(name || '').trim()
  if (!target) return { ok: false, error: '缺少包名' }
  const mod = (report?.mods || []).find((item) => item.name === target)
  if (!mod) return { ok: false, error: `账本里没有这个包：${target}` }
  // 把目标当作未安装，其余照旧。
  const simulated = {
    ...report,
    mods: (report.mods || []).map((item) => (item.name === target ? { ...item, installed: false } : item)),
  }
  const after = toolInventory({ report: simulated, gates, toolGroups })
  // 「失去」是**增量**：本来就因为闸门没过而不可用的动作，不该算到退役头上。
  // （第一版就是直接拿 after 的不可用列表，结果每个候选都报「失去 4 个」，8 个候选凑出 32，
  //  看着像停掉任意一个都会塌半边天。）
  const baseline = new Set(
    toolInventory({ report, gates, toolGroups })
      .groups.flatMap((group) => group.actions)
      .filter((action) => !action.available)
      .map((action) => action.name),
  )
  const lost = after.groups
    .flatMap((group) => group.actions)
    .filter((action) => !action.available && !baseline.has(action.name))
    .map((action) => ({ name: action.name, missing: action.missing, reason: action.reason }))
  // 这个包有没有被动作清单里的某个动作依赖？
  // 没有的话「失去 0 个」是**真话但不是全部**：它的能力（比如 bili_scan）走的是别的工具，
  // 这张清单本来就看不见。分开说，别让人以为「停了一点影响都没有」。
  const usedBy = toolGroups
    .flatMap((group) => group.actions)
    .filter((action) => Array.isArray(action.require) && action.require.includes(target))
    .map((action) => action.name)
  return {
    ok: true,
    name: target,
    // 退役它之后会失去的手：空数组说明「清单上的动作不靠它」，不等于「它没用」。
    lost,
    lostCount: lost.length,
    usedBy,
    reach: usedBy.length ? 'in-inventory' : 'elsewhere',
    // 最硬的一条：它是不是鱼世界在 env.mjs 里声明的依赖（且非 optional）。
    // 是的话「停用」等于拆自己的承重墙——账本必须说，不能只报「失去 0 个动作」。
    // 本机就踩过：dsh-fish-memory / dsh-feiyu-mood 都不在动作清单里，却都是必需依赖
    //（记忆桥直接写它的会话库；心情卡直接读它的 /state）。
    requiredBy: (() => {
      const dep = (DEPENDENCIES || []).find((item) => item.name === target)
      if (!dep || dep.optional === true) return null
      return { label: dep.label, feature: dep.feature || dep.label }
    })(),
    // 还有一条更隐蔽的依赖：SCOPE 里点名要的某件事（比如「鱼的状态」没有 action，但整页读它的 /state）。
    // 动作清单看不见这种，必须从整合范围那张表反过来数。
    scopeLost: SCOPE
      .flatMap((group) => group.items)
      .filter((item) => (item.by || []).includes(target))
      .map((item) => ({ id: item.id, label: item.label })),
    counts: after.counts,
  }
}

/** 所有「重复能力位」里被建议退役的那些，各自的退役影响。 */
export function retireAdvice({ report, gates = {} } = {}) {
  const groups = (report?.duplicates || []).map((dup) => {
    const retiring = dup.members.filter((name) => name !== dup.keep)
    return {
      capability: dup.capability,
      label: dup.label,
      keep: dup.keep,
      retiring: retiring.map((name) => {
        const impact = retireImpact({ report, gates, name })
        // 撑着 scope 的那件事（动作清单上看不见的依赖）从 retireImpact 里取，别在这里再算一遍。
        const scopeLost = impact.scopeLost || []
        return impact.ok
          ? {
            name,
            lostCount: impact.lostCount,
            lost: impact.lost,
            usedBy: impact.usedBy,
            // in-inventory = 清单上有动作靠它；elsewhere = 清单上的动作都不靠它，
            // 但它的本事走别的工具（比如 B 站的 bili_scan），这份清单看不见。
            reach: impact.reach,
            // 非空 = 它是鱼世界的必需依赖，不该退役（除非先做出接管）。
            requiredBy: impact.requiredBy || null,
            // 非空 = 点名要的某件事就靠它撑着（比如「鱼的状态」现在全靠 dsh-feiyu-mood）。
            // 动作清单看不见这种依赖，因为那条没有 action。
            scopeLost,
          }
          : { name, lostCount: 0, lost: [], usedBy: [], reach: 'unknown', requiredBy: null, scopeLost: [], error: impact.error }
      }),
    }
  })
  const totalLost = groups.reduce((sum, group) => sum + group.retiring.reduce((n, item) => n + item.lostCount, 0), 0)
  const elsewhere = groups.flatMap((group) => group.retiring)
    // 必需依赖已经单独说了，不再混进「清单看不见」那一串里——同一件事说两遍就成了噪音。
    .filter((item) => item.reach === 'elsewhere' && !item.requiredBy)
  const required = groups.flatMap((group) => group.retiring).filter((item) => item.requiredBy)
  // 点名要的事有没有靠它撑着：动作清单上看不出来，但停了就是一片空。
  const scopeDependent = groups.flatMap((group) => group.retiring).filter((item) => (item.scopeLost || []).length)
  const parts = []
  if (totalLost) parts.push(`有 ${totalLost} 个动作会跟着这些重复项一起哑掉，停之前先看清楚`)
  // 「必需依赖」这条最要紧，放前面说：它比「清单上看不出影响」严重得多。
  if (required.length) {
    parts.push(
      `其中 ${required.length} 个是鱼世界的必需依赖（${required.map((item) => item.name + ' → ' + item.requiredBy.feature).join('、')}），`
      + '退了会直接缺功能，建议先留着',
    )
  }
  if (scopeDependent.length) {
    parts.push(
      `另外 ${scopeDependent.length} 个撑着点名要的东西（${scopeDependent.map((item) => item.name + ' → ' + item.scopeLost.map((lost) => lost.label).join('/')).join('、')}），`
      + '停了这几件事就没着落，不是「清单看不见」那种轻的',
    )
  }
  if (elsewhere.length) {
    parts.push(
      `另外 ${elsewhere.length} 个（${elsewhere.map((item) => item.name).join('、')}）在动作清单上看不出影响——`
      + '它们的本事走别的工具（比如 B 站的 bili_scan），这张清单本来就看不见，不等于停了一点事没有',
    )
  }
  return {
    ok: true,
    groups,
    note: parts.length ? parts.join('；') + '。' : '把这些重复项停掉，鱼手上的动作一个都不会少。',
  }
}

export const __test = { readJsonFile, BY_NAME, factNote }
/**
 * 「这次要整合的到底是哪些事」——单一真源。
 *
 * 为什么单列一张表而不是从 MODPACK 推：目录是按**插件**分的，这张是按**要的功能**分的。
 * 主人点名要的是右边这些；账本得能直接回答「这七件事各就位了没」，
 * 而不是让人自己从二十几个包名里推。
 */
export const SCOPE = Object.freeze([
  {
    id: 'fish',
    label: '养鱼本身',
    items: [
      { id: 'diary', label: '鱼的日记', detail: '写日记、批语、一句一句回应', by: ['dsh-fish-world'], actions: ['diary'] },
      { id: 'wishes', label: '鱼的请求', detail: '她想做什么，等主人点头', by: ['dsh-fish-world'], actions: ['wish'] },
      { id: 'growth', label: '鱼的成长', detail: '想通的事、下一步、里程碑', by: ['dsh-fish-world'], actions: ['growth'] },
      { id: 'status', label: '鱼的状态', detail: '心情读 dsh-feiyu-mood 的 /state，鱼自己还不存', by: ['dsh-fish-world', 'dsh-feiyu-mood'], missingNote: '心情只存在 dsh-feiyu-mood 里——它不在，状态页就是空的。想并进来，得先让鱼自己存心情。' },
      // 说话风格不并进鱼世界：它由 dsh-fish-tone 自己管（prompt 段 + 两个工具），
      // 抄一份规则进来必然和它的 fish-tone:voice 段打架。这里只登记「谁在管」。
      { id: 'voice', label: '鱼的风格', detail: '说话风格（去 AI 味）：prompt 段 fish-tone:voice + fish_tone / fish_judge 工具', by: ['dsh-fish-tone'] },
    ],
  },
  {
    id: 'memory',
    label: '鱼的记忆',
    items: [
      { id: 'knowledge', label: '知识库', detail: '记下来的知识条目，按字面也能搜', by: ['dsh-fish-world'], actions: ['know'] },
      { id: 'vector', label: '小模型（向量）', detail: '本机小模型算语义，搜得动近义词', by: ['dsh-fish-world'], actions: ['know'] },
      { id: 'stickers', label: '图片收藏', detail: '表情包与图库，认得每张是干什么用的', by: ['dsh-fish-world'], actions: ['sticker-list'] },
      { id: 'links', label: '网站链接', detail: '存过的站，带说明', by: ['dsh-fish-world'], actions: ['link-list'] },
      { id: 'digest', label: '每日记忆摘要', detail: '按天压缩的全局记忆，进所有平台的提示词', by: ['dsh-fish-memory', 'dsh-fish-world'] },
    ],
  },
  {
    id: 'platform',
    label: '四个平台',
    items: [
      { id: 'qq', label: 'QQ', detail: '私聊、群、空间', by: ['dsh-qq-bridge'], actions: ['send', 'history'], activityId: 'qq' },
      {
        id: 'wechat',
        label: '微信',
        detail: '第四个平台：收发、扫码、绑定、人格都在 dsh-wechat-plugin 那边，鱼世界只做只读展示与闸门',
        // 与 platforms.mjs 的 PLATFORMS.wechat.plugins 同一份口径：只有 dsh-wechat-plugin 一条。
        // 抄一份列表会漂，所以直接取上游那一份。
        by: PLATFORMS.wechat.plugins.slice(),
        missingNote: '没装 dsh-wechat-plugin（装它：dsh plugin --profile desktop add dsh-wechat-plugin，装完重启 DSH），这条现在只是摆着，别当成能用了。'
          + '微信收发、扫码登录、绑定、人格与行为都在 dsh-wechat-plugin 里（设置 → 微信），'
          + '鱼世界只读展示通道 / 账号 / 连接状态，并保留自己的读 / 发闸门，不实现微信协议、也不保存凭证。',
      },
      { id: 'douyin', label: '抖音', detail: '自己刷、记下看到的', by: ['dsh-douyin-browser-local'], activityId: 'douyin' },
      {
        id: 'bili',
        label: 'B 站',
        detail: '挑视频、读字幕、写笔记',
        // 主前置改成 bili-whale（字幕 / 弹幕 / 热评 / 抽帧），bili-subagent 退成可选的那条。
        // 同样是「任装一条就就位」，与 PLATFORMS.bili.plugins 一致。
        by: PLATFORMS.bili.plugins.slice(),
        anyOf: true,
        activityId: 'bili',
      },
    ],
  },
])

/**
 * 这张范围表「现在能不能用」——按插件真的装了没判，不按愿望判。
 * 一条要几个插件就算几个，缺一个也算没就位（半拉子最坑人）。
 *
 * 但「装了」不等于「现在能用」：闸门关着（比如 QQ 桥没开、协议端没起来），
 * 动作清单那边会说这些动作不可用。两处要是各说各的，这张卡就成了自我矛盾。
 * 所以传了 gates 就顺手对一遍：装了但动作被闸挡住 → 算「待开」，不算「缺」。
 */
/**
 * 知识库 / 向量这两条的真实状态。
 * 只判「插件装没装」会把「库还没建」「向量关着」「索引过期」全说成绿——那正是面板最会骗人的地方。
 * 没有 knowledge.status() 就返回 null，调用方退回「只核装没装」，并在 gatesChecked 之外如实说明。
 */
function judgeBackend(id, knowledge) {  const kb = knowledge && typeof knowledge === 'object' ? knowledge : null
  if (!kb) return null
  if (id === 'knowledge') {
    if (!kb.ok) return { state: 'blocked', note: `知识库读不出来：${kb.error || '未知原因'}` }
    return { state: 'ready', note: `知识库 ${kb.items ?? 0} 条` }
  }
  if (id === 'vector') {
    if (!kb.enabled || kb.mode === 'off') return { state: 'blocked', note: '向量检索关着，现在按字面查（知识库设置里能开）' }
    const problems = Array.isArray(kb.problems) ? kb.problems : []
    if (problems.length) return { state: 'blocked', note: `向量后端有问题：${problems.join('；')}` }
    if (!kb.index) return { state: 'blocked', note: '还没有向量索引，先点「重建索引」' }
    const index = kb.index || {}
    if (!kb.indexFresh) return { state: 'blocked', note: `索引过期：${kb.indexWhy || '要重建'}` }
    return { state: 'ready', note: `向量检索：${kb.mode || '本地'} / ${index.model || '未知模型'}，${index.dim || 0} 维` }
  }
  return null
}

/**
 * 收藏/链接这两条的「里面到底有没有东西」。
 * 绿点只说明能打开；空库和有 100 张在卡上是同一颗绿点，所以把数量也说出来。
 * 拿不到就 null，一个字都不写。
 */
function factNote(id, facts) {
  if (!facts || typeof facts !== 'object') return ''
  const n = facts[id]
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  // 图库除了「有几张」，还要报「索引和磁盘对不对得上」——对不上说明有东西在悄悄丢。
  if (id === 'stickers') {
    const base = n > 0 ? `收藏 ${n} 张` : '一张都还没有'
    const audit = facts.stickersAudit
    if (audit && typeof audit === 'object') {
      if (audit.missing) return `${base} · 但索引里有 ${audit.missing} 张，磁盘上已经没了（可能被手删过）`
      if (audit.orphan) return `${base} · 磁盘上有 ${audit.orphan} 张没进索引（收了但没登记）`
    }
    return base
  }
  if (id === 'links') return n > 0 ? `存过 ${n} 个站` : '一个都还没存'
  return ''
}

export function readScope({ report, gates = null, toolGroups = TOOL_GROUPS, usage = null, knowledge = null, facts = null } = {}) {
  const installed = new Set()
  for (const mod of (report && report.mods) || []) {
    if (mod.installed) installed.add(mod.name)
  }
  // 动作能不能用：只在真的给了闸门时才算——没给就是「不知道」，别假装通过。
  const blockedBy = new Map()
  if (gates) {
    let inv = { groups: [] }
    try {
      inv = toolInventory({ report, gates, toolGroups })
    } catch {
      inv = { groups: [] }
    }
    for (const group of inv.groups || []) {
      for (const action of group.actions || []) {
        if (!action.available) blockedBy.set(action.name, action.reason || action.missing || '现在用不了')
      }
    }
  }
  const groups = SCOPE.map((group) => {
    const items = group.items.map((item) => {
      // 两种口径：
      //  · 默认「全都要」——一条能力要几个插件就算几个，缺一个也算没就位（半拉子最坑人）；
      //  · anyOf=true 的是「二选一」（微信两条通道、B 站两条）——装了任一条就算就位，
      //    与 platforms.mjs 的 availability / PLATFORMS.*.plugins 同一套判断。
      const missing = item.anyOf
        ? (item.by.some((name) => installed.has(name)) ? [] : item.by.slice())
        : item.by.filter((name) => !installed.has(name))
      const wanted = item.actions || []
      const blocked = gates ? wanted.filter((name) => blockedBy.has(name)).map((name) => ({ action: name, reason: blockedBy.get(name) })) : []
      // 知识库这条光看「插件装了没」是骗人的：库可能还没建，向量可能关着、缺 key、索引过期。
      // 所以交给 knowledge.status() 的真状态判，拿不到就退回只看装没装，别编。
      const judged = judgeBackend(item.id, knowledge)
      const state = missing.length
        ? 'missing'
        : ((blocked.length || (judged && judged.state === 'blocked')) ? 'blocked' : 'ready')
      // 「就位」只说明能接上；「用没用过」是另一件事，别把两者混成一个绿点。
      const used = item.activityId && usage ? (usage[item.activityId] || null) : null
      return {
        id: item.id,
        label: item.label,
        detail: item.detail,
        by: item.by.slice(),
        actions: wanted.slice(),
        missing,
        blocked,
        ready: state === 'ready',
        state,
        usage: used,
        note: missing.length
          ? (item.missingNote || `缺：${missing.join('、')}`)
          : (judged && judged.note
            ? judged.note
            : (blocked.length ? `装了，但「${blocked[0].action}」现在用不了：${blocked[0].reason}` : factNote(item.id, facts))),
      }
    })
    return { id: group.id, label: group.label, items }
  })
  const flat = groups.flatMap((group) => group.items)
  return {
    ok: true,
    // gatesChecked=false 的意思是：这张卡只核了「装没装」，没核闸门。
    gatesChecked: Boolean(gates),
    groups,
    counts: {
      total: flat.length,
      ready: flat.filter((item) => item.state === 'ready').length,
      blocked: flat.filter((item) => item.state === 'blocked').length,
      missing: flat.filter((item) => item.state === 'missing').length,
    },
  }
}
