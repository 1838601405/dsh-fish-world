// 视觉实现收口审计（2026-11-22 主人方案 P5）。
//
// ── 这条判据要回答什么 ──
// 方案 P5：「全仓 grep：除 vision.mjs 外不许有第二处直接调 ffmpeg 抽帧或调视觉模型」。
// 但字面执行会把**语义不同**的两件事一起删掉：
//   · media-tools 的 op=frames 是「导出帧文件给用户看」，不是「抽帧拿描述」
//   · 剪辑/转码是「处理」不是「看」
// 所以这里按**语义**分类 + 豁免表，只把真正重复的标成待收口。
//
// ── 怎么算红 ──
// 出现**未豁免**的文件在起 ffmpeg 或调视觉模型 ⇒ 红。
// 也就是说：新加一处视觉实现而不登记豁免理由，这条就会失败（P5 要的「能真红」）。
//
// 跑法：node tools/vision-audit.mjs        （只跑不改）
//       node tools/vision-audit.mjs --list （把每处都列出来）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIST = process.argv.includes('--list')

// backups/ 是构建历史快照、ui/ 是 Flutter 产物、.bak- 是备份 —— 都不是现行实现。
// ★ 本文件自己也要排除：EXEMPT 与 PATTERN 的正则字面量里就写着触发词
//   （/image_url/ 这种），不排除的话检查器会抓到自己（M59：扫描器自身也算输入）。
const EXCLUDE = /node_modules|\/\.git\/|\/ui\/|\/backups\/|\.bak-|\.retired$|tools\/vision-audit\.mjs$/

function walk(dir, out = []) {
  let names = []
  try { names = readdirSync(dir) } catch { return out }
  for (const n of names) {
    const p = join(dir, n)
    if (EXCLUDE.test(p.replace(/\\/g, '/'))) continue
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(mjs|js|cjs)$/.test(n)) out.push(p)
  }
  return out
}

/** import 了 child_process 的执行函数 —— 只有这些文件才可能自己起进程。 */
const CHILD_PROCESS_IMPORT =
  /import\s*\{[^}]*\b(execFile|execFileSync|spawn|spawnSync|exec|execSync)\b[^}]*\}\s*from\s*'node:child_process'/

/** 字面量形式的 ffmpeg 调用（变量传命令名的走文件级判定）。 */
const FFMPEG_PATTERNS = [
  /\bexecFileSync?\(\s*['"`]ffmpeg['"`]/,
  /\bspawn\(\s*['"`]ffmpeg['"`]/,
  /\bspawnSync\(\s*['"`]ffmpeg['"`]/,
  /\bexecFileSync?\(\s*ffmpegPath\s*\(/,
  /\bspawn\(\s*ffmpegPath\s*\(/
]

/** 视觉模型调用：OpenAI 兼容端点 + 图片入参（只有 image_url 才算「看图」）。 */
const VISION_PATTERNS = [/\/chat\/completions/, /image_url/]

/**
 * 豁免表。**每条都要写清为什么不算「看」** ——
 * 写不出理由的就不该在这张表里（否则这张表就成了藏污纳垢的地方）。
 */
const EXEMPT = [
  { re: /^lib\/vision\.mjs$/, why: '★ 方案指定的唯一一处（P1 管线）' },
  { re: /^lib\/vision-omni\.mjs$/, why: '★ P2 后端适配层：调 omni 的 lib，自己不起 ffmpeg' },
  { re: /^lib\/vision-input\.mjs$/, why: '归一化：只下载/落盘/算 sha256，不起进程、不调模型' },
  { re: /^lib\/vision-voice\.mjs$/, why: '语音转写：转给管线，自己不调模型' },
  { re: /^lib\/vision-wire\.mjs$/, why: '装配层：只建实例' },
  { re: /^lib\/vision-platforms\.mjs$/, why: '平台适配器：只摊结构' },
  { re: /^lib\/media-tools\.mjs$/, why: '★ 豁免：剪辑/转码/导出帧是「处理」不是「看」；op=frames 导出文件给用户自己看' },
  { re: /^lib\/video\.mjs$/, why: '⚠ 待收口：抽帧拼胶片条 =「看」，应下沉 vision 后端（但产物是图，直换会降级）' },
  { re: /^lib\/video-frames\.mjs$/, why: '⚠ 待收口：调 video.mjs；外壳（下载/落盘/缓存）可留' },
  { re: /^lib\/sticker-vision\.mjs$/, why: '⚠ 待收口：本仓唯一真调视觉模型处，但出参 {name,tags,note}，直换会断图库整理' },
  { re: /^tests\//, why: '测试：造数据 / 源码级断言，不是产品实现' },
  { re: /^lib\/sherlock\.mjs$/, why: '跑 python 查账号，与视觉无关' },
  { re: /^lib\/core-plugins\/read-animation\//, why: '用 sharp 解码拼帧，不调 ffmpeg、不调视觉模型' },
  { re: /^lib\/protocol-supervisor\.mjs$|^lib\/install\.mjs$|^lib\/bridge-patch\.mjs$/, why: 'powershell / 装包 / node --check，与视觉无关' },
  { re: /^lib\/whale-task\.mjs$/, why: '模型通道是文字对话，不是看图' },
  { re: /^lib\/chat-api\.mjs$|^lib\/local-model\.mjs$|^lib\/model-api\.mjs$/, why: '文字对话接口，没有图片入参' }
]

function exemptOf(rel) {
  for (const e of EXEMPT) if (e.re.test(rel)) return e.why
  return null
}

const files = walk(ROOT)
const rows = []

for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/')
  const src = readFileSync(f, 'utf8')
  const lines = src.split(/\r?\n/)

  // ① 文件级：import 了 child_process 且提到 ffmpeg = 自己在起 ffmpeg
  //    （video.mjs 是 execFile(exe, …)，exe 是变量，字面量正则抓不到）
  if (CHILD_PROCESS_IMPORT.test(src) && /\bffmpeg\b/i.test(src)) {
    let at = 0
    lines.forEach((line, i) => {
      if (at) return
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*')) return
      if (/\b(execFile|execFileSync|spawn|spawnSync)\s*\(/.test(line)) at = i + 1
    })
    rows.push({ kind: 'ffmpeg', rel, line: at, how: 'child_process+ffmpeg' })
  }

  // ② 行级：字面量调用 / 视觉模型端点
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    if (FFMPEG_PATTERNS.some((re) => re.test(line))) {
      rows.push({ kind: 'ffmpeg', rel, line: i + 1, how: 'execFile/spawn(ffmpeg)' })
    }
    if (VISION_PATTERNS.some((re) => re.test(line))) {
      rows.push({ kind: 'vision', rel, line: i + 1, how: '视觉模型端点' })
    }
  })
}

// 去重（同一文件可能被文件级与行级各命中一次）
const seen = new Set()
const unique = rows.filter((r) => {
  const k = `${r.kind}|${r.rel}|${r.line}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

const unexempted = unique.filter((r) => !exemptOf(r.rel))
const pending = [...new Set(unique.filter((r) => /待收口/.test(exemptOf(r.rel) || '')).map((r) => r.rel))]

if (LIST) {
  for (const r of unique) {
    const why = exemptOf(r.rel)
    console.log(`${why ? (why.startsWith('★') ? '  ' : why.startsWith('⚠') ? '⚠ ' : '  ') : '★'} [${r.kind}] ${r.rel}:${r.line}  ${r.how}`)
    if (why) console.log(`      ${why}`)
  }
}

console.log(`扫描 ${files.length} 个文件（已排除 node_modules / ui / backups / .bak-*）`)
console.log(`ffmpeg 起进程: ${unique.filter((r) => r.kind === 'ffmpeg').length} 处`)
console.log(`视觉模型调用: ${unique.filter((r) => r.kind === 'vision').length} 处`)
console.log(`待收口（语义是「看」但还没下沉）: ${pending.length ? pending.join(', ') : '无'}`)
console.log(`未豁免: ${unexempted.length ? unexempted.map((r) => r.rel + ':' + r.line).join(', ') : '0'}`)

if (unexempted.length) {
  console.log('')
  console.log('★ 红：下面这些直接调 ffmpeg / 视觉模型，既不在 vision 层、也没写豁免理由。')
  console.log('  要么改成走 lib/vision.mjs，要么在 tools/vision-audit.mjs 的 EXEMPT 里')
  console.log('  写清为什么它不算「看」。')
  for (const r of unexempted) console.log(`   ${r.rel}:${r.line} [${r.kind}] ${r.how}`)
  process.exit(1)
}

console.log('PASS：没有第二处未登记的视觉实现。')
