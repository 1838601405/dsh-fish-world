// 对人的记录：鱼查到「某个人在哪些平台上有账号」，一条一条存在本地。
//
// 和 lib/records.mjs（鱼的记录 / 小本本）是同一套形状：追加写、按 id 折叠、删除写墓碑。
// 为什么另开一个文件而不塞进 records.mjs：
//   · records.mjs 的一条 = 一句话（text），这里的一条 = 一个人 + 一份平台清单；
//   · 折叠规则也不同——这里「同一个人同一用户名」要能原地更新（重新查一遍覆盖旧的），
//     而不是堆出十条看起来一样的记录。
//
// 落盘：<根>/鱼的记录/对人的记录.jsonl
//   · 一行一条，追加写；修改与删除也各追加一行（修订链保留，便于回溯）。
//   · 只存「用户名 + 平台 + URL + 状态」，不存主页内容、不存头像、不存他人隐私细节。
//
// 隐私边界（与 AGENTS §0② 一致）：这是查公开账号的存在性，不是画像。
// 默认关闭，只有主人会话能写；记录只在本机，不上传、不镜像、不进提示词。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_FOLDER } from './storage.mjs'

const RECORDS_FOLDER = '鱼的记录'
const FILE_NAME = '对人的记录.jsonl'
const MAX_NAME = 64
const MAX_NOTE = 200
const MAX_PLATFORMS = 60
const MAX_RECORDS = 500

function safeText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function dayKey(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 一条平台结果只留我们声明会存的四个字段；上游多给的列一律不落盘。 */
function cleanPlatform(item) {
  const site = safeText(item?.site, 48)
  if (!site) return null
  return {
    site,
    url: String(item?.url == null ? '' : item.url).trim().slice(0, 300),
    status: ['claimed', 'available', 'unknown', 'illegal'].includes(item?.status) ? item.status : 'unknown',
    httpStatus: safeText(item?.httpStatus, 12),
  }
}

export function createPersonRecordStore({ storage, home, logger, now = () => new Date() } = {}) {
  function dirFor() {
    try {
      const paths = storage?.layout?.()
      if (paths?.root) return join(paths.root, RECORDS_FOLDER)
    } catch {}
    // 没有存储层时退回旧习惯：与运行目录并列的「鱼的记录」。
    return join(home || '.', ROOT_FOLDER, RECORDS_FOLDER)
  }

  function fileOf() {
    return join(dirFor(), FILE_NAME)
  }

  function readLines() {
    try {
      return readFileSync(fileOf(), 'utf8').split(/\r?\n/).filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
    } catch { return [] }
  }

  function append(row) {
    const dir = dirFor()
    mkdirSync(dir, { recursive: true })
    writeFileSync(fileOf(), JSON.stringify(row) + '\n', { encoding: 'utf8', flag: 'a' })
  }

  /** 账本按 id 折叠：后写的覆盖先写的，删除写成 deleted 墓碑。 */
  function collapse(rows) {
    const byId = new Map()
    for (const row of rows) if (row && row.id) byId.set(row.id, { ...(byId.get(row.id) || {}), ...row })
    return [...byId.values()]
  }

  function list({ limit = 200, keyword = '' } = {}) {
    const key = String(keyword || '').trim().toLowerCase()
    let items = collapse(readLines()).filter((row) => row.status !== 'deleted')
    if (key) {
      items = items.filter((row) => (
        String(row.subject || '').toLowerCase().includes(key)
        || String(row.username || '').toLowerCase().includes(key)
        || String(row.note || '').toLowerCase().includes(key)
      ))
    }
    items.sort((a, b) => String(b.checkedAt || b.at).localeCompare(String(a.checkedAt || a.at)))
    return items.slice(0, Math.max(1, Math.min(Number(limit) || 200, MAX_RECORDS)))
  }

  /**
   * 查一个人并落一条。
   *
   * 「同一个人 + 同一个用户名」已经存在时**原地更新那条**（新查的结果覆盖旧清单），
   * 而不是每次查询都堆一条——否则主人会看到一堆看起来一样的记录，分不清哪份是新的。
   */
  function save({ subject, username, note, platforms = [], source = 'sherlock', counts = null }) {
    const name = safeText(subject, MAX_NAME) || safeText(username, MAX_NAME)
    const user = safeText(username, MAX_NAME)
    if (!name) throw new Error('要记的人不能为空')
    if (!user) throw new Error('用户名不能为空')

    const clean = (Array.isArray(platforms) ? platforms : [])
      .map(cleanPlatform)
      .filter(Boolean)
      .slice(0, MAX_PLATFORMS)

    const existing = collapse(readLines())
      .find((row) => row.status !== 'deleted'
        && String(row.username || '').toLowerCase() === user.toLowerCase()
        && String(row.subject || '').toLowerCase() === name.toLowerCase())

    // 备注是人手写的，查询不该把它抹掉：不传 note 就保留旧的，传了（含空串）才覆盖。
    // 要清空备注走 updateNote(id, '')。
    const nextNote = note === undefined || note === null
      ? String(existing?.note || '')
      : safeText(note, MAX_NOTE)

    const stamp = now()
    const row = {
      id: existing?.id || 'per_' + randomUUID().slice(0, 8),
      at: existing?.at || stamp.toISOString(),
      day: existing?.day || dayKey(stamp),
      checkedAt: stamp.toISOString(),
      subject: name,
      username: user,
      note: nextNote,
      source: source === 'manual' ? 'manual' : 'sherlock',
      platforms: clean,
      counts: counts || null,
      revision: Number(existing?.revision || 0) + 1,
      status: 'active',
    }
    append(row)
    try { logger?.info?.(`[person-records] 记下 ${name}（${user}）：${clean.length} 个站点`) } catch {}
    return { ok: true, item: row, updated: Boolean(existing) }
  }

  function updateNote(id, note) {
    const target = String(id || '').trim()
    if (!target) throw new Error('缺少记录 id')
    const current = list({ limit: MAX_RECORDS }).find((item) => item.id === target)
    if (!current) throw new Error('没有找到这条记录')
    const clean = safeText(note, MAX_NOTE)
    if (clean === String(current.note || '')) throw new Error('备注和原来一样')
    const row = {
      ...current,
      note: clean,
      revision: Number(current.revision || 1) + 1,
      updatedAt: new Date().toISOString(),
    }
    append(row)
    return { ok: true, item: row, previous: current }
  }

  function remove(id) {
    const target = String(id || '').trim()
    const current = list({ limit: MAX_RECORDS }).find((item) => item.id === target)
    if (!current) return { ok: false, error: '没有找到这条记录' }
    append({ id: target, status: 'deleted', deletedAt: new Date().toISOString() })
    return { ok: true, removed: 1 }
  }

  function get(id) {
    const target = String(id || '').trim()
    return list({ limit: MAX_RECORDS }).find((item) => item.id === target) || null
  }

  function summary() {
    const items = list({ limit: MAX_RECORDS })
    // 按状态汇总：unknown 单独一栏，不和 available 混——那是「没测出来」，不是「没有」。
    const totals = { claimed: 0, available: 0, unknown: 0, illegal: 0 }
    for (const item of items) {
      for (const platform of item.platforms || []) {
        if (totals[platform.status] !== undefined) totals[platform.status] += 1
      }
    }
    return {
      ok: true,
      dir: dirFor(),
      file: fileOf(),
      exists: existsSync(fileOf()),
      people: items.length,
      platforms: totals,
      note: '只记「这个用户名在哪些公开站点已占用」；查不出来的记为未知，不当成没有。',
    }
  }

  return {
    dir: dirFor,
    file: fileOf,
    list,
    get,
    save,
    updateNote,
    remove,
    summary,
  }
}

export const __test = { dayKey, RECORDS_FOLDER, FILE_NAME, cleanPlatform }
