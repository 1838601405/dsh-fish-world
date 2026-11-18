// 自动拆槽（P1）：一张图 → 2–4 个候选槽 → 待审 → 确认入库。
//
// 为什么先待审：拆错比不拆更糟（错槽会被检索命中，等于把「会学」变成「会乱」）。
// 有本地生成模型时让它拆；没有时退回「图上已有的锚点词 + 名称词」——这是**半自动**，
// 语义比模型弱，但不会编出图上没有的东西。
import { KIND, makeSlotAsync } from './slots.mjs'

const SCENES = ['说累', '催进度', '自嘲', '被嘲', '闲聊', '求助', '深夜', '早上', '摆烂', '没话说', '看戏', '求饶', '认错', '道谢', '庆祝', '安慰']
const EMOTIONS = ['累', '难过', '开心', '生气', '委屈', '兴奋', '平静', '烦']
const ACTIONS = ['发图', '接梗', '催', '自嘲', '安慰', '吐槽', '问', '答', '摆烂', '看戏', '求饶', '认错', '道谢', '庆祝']

function pickWords(text, pool) {
  const s = String(text || '')
  return pool.filter((word) => s.includes(word)).slice(0, 3)
}

/**
 * 给一张图生成候选槽。
 * item: { id, name, origin, use, role, tagWords:[...] }
 * generator: 可选本地模型（runner）；有就让它出候选，没有就按锚点词拼。
 * 返回 { via, candidates:[{semantic, tags, response, vId}] }
 */
export async function proposeSlotsForImage({ item = {}, generator = null, encoder = null, sceneThreshold = 0.4 } = {}) {
  const id = String(item.id || item.name || '')
  const name = String(item.name || '')
  const words = [
    ...(Array.isArray(item.tagWords) ? item.tagWords : []),
    ...String(item.use || '').split(/[、,，/]/),
    ...String(item.origin || '').split(/[，,。\s]/),
  ].map((w) => String(w).trim()).filter(Boolean)
  const text = [name, item.origin, item.use, item.role, words.join(' ')].filter(Boolean).join(' ')

  if (generator && generator.ok) {
    try {
      const prompt = [
        '看这张表情包的描述，给它在不同情境下起 2-4 个用途槽。',
        '只回 JSON 数组，每项 {"场景":"","情绪":"","动作":""}，场景/情绪/动作只能从下列里选：',
        '场景=' + SCENES.join('/') + '；情绪=' + EMOTIONS.join('/') + '；动作=' + ACTIONS.join('/'),
        '描述：' + text.slice(0, 300),
      ].join('\n')
      const out = await generator.generate(prompt, { maxTokens: 160 })
      const m = String(out || '').match(/\[[\s\S]*\]/)
      if (m) {
        const arr = JSON.parse(m[0]).filter((x) => x && typeof x === 'object').slice(0, 4)
        const candidates = arr
          .filter((x) => SCENES.includes(x.场景) || EMOTIONS.includes(x.情绪) || ACTIONS.includes(x.动作))
          .map((x) => ({
            semantic: [name, x.场景 || x.情绪 || x.动作].filter(Boolean).join(' '),
            tags: { 形态: '表情包', 场景: SCENES.includes(x.场景) ? x.场景 : '', 情绪: EMOTIONS.includes(x.情绪) ? x.情绪 : '', 动作: ACTIONS.includes(x.动作) ? x.动作 : '' },
            response: '',
            vId: id,
          }))
        if (candidates.length >= 2) return { via: 'generator', candidates }
      }
    } catch { /* 落到锚点 */ }
  }

  // 语义半自动（有 encoder 时优先）：note 与锚点词表的余弦，达线的前几个才算
  if (encoder && typeof encoder.encodeMany === 'function') {
    try {
      const pool = [...new Set([...SCENES, ...EMOTIONS, ...ACTIONS])]
      const vecs = await encoder.encodeMany([text, ...pool])
      const noteVec = vecs[0]
      const scoreOf = (word) => {
        const idx = pool.indexOf(word)
        if (idx < 0) return 0
        const v = vecs[idx + 1]
        let d = 0
        let nx = 0
        let ny = 0
        for (let i = 0; i < noteVec.length; i += 1) {
          d += noteVec[i] * v[i]
          nx += noteVec[i] * noteVec[i]
          ny += v[i] * v[i]
        }
        return d / (Math.sqrt(nx) * Math.sqrt(ny) || 1)
      }
      const rank = (words) => words.map((w) => ({ w, s: scoreOf(w) })).sort((a, b) => b.s - a.s)
      const scenes = rank(SCENES).filter((x) => x.s >= sceneThreshold).slice(0, 3)
      const emotions = rank(EMOTIONS).filter((x) => x.s >= sceneThreshold).slice(0, 2)
      const actions = rank(ACTIONS).filter((x) => x.s >= sceneThreshold).slice(0, 2)
      const out = []
      scenes.forEach((scene, i) => {
        out.push({
          semantic: [name, scene.w].filter(Boolean).join(' '),
          tags: { 形态: '表情包', 场景: scene.w, 情绪: emotions[i]?.w || '', 动作: actions[i]?.w || '' },
          response: '',
          vId: id,
          evidence: 'scene=' + scene.s.toFixed(3),
        })
      })
      if (out.length >= 2) return { via: 'encoder', candidates: out }
      if (out.length === 1) return { via: 'encoder', candidates: out }
    } catch { /* 落到锚点 */ }
  }

  // 半自动：图上已有的词命中哪几个场景，就出几个槽
  const scenes = pickWords(text, SCENES)
  const emotions = pickWords(text, EMOTIONS)
  const actions = pickWords(text, ACTIONS)
  const candidates = []
  const pairs = Math.max(scenes.length, emotions.length, actions.length, 1)
  for (let i = 0; i < Math.min(4, pairs); i += 1) {
    const scene = scenes[i] || ''
    const emotion = emotions[i] || ''
    const action = actions[i] || ''
    if (!scene && !emotion && !action) continue
    candidates.push({
      semantic: [name, scene || emotion || action].filter(Boolean).join(' '),
      tags: { 形态: '表情包', 场景: scene, 情绪: emotion, 动作: action },
      response: '',
      vId: id,
    })
  }
  return { via: candidates.length ? 'anchors' : 'none', candidates }
}

/** 候选进待审队列（不直接入库）。 */
export function enqueueProposals({ store, candidates = [], source = '', person = '', at = '' } = {}) {
  const queued = []
  for (const candidate of candidates) {
    const item = { ...candidate, source, person, at, kind: KIND.STICKER, proposedAt: new Date().toISOString() }
    store.addPending(item)
    queued.push(item)
  }
  return queued
}

/**
 * 待审 → 入库。ids 是待审队列里的 vId（同一个 id 的多条候选一起放）。
 * 返回 { promoted:[slotId], skipped:[原因] }
 */
export async function promotePending({ store, vIds = [], encoder, source = 'qq', person = '', at = '', limit = 4 } = {}) {
  const list = store.pending()
  const promoted = []
  const skipped = []
  for (const vId of vIds) {
    const candidates = list.filter((p) => p && p.vId === vId).slice(0, limit)
    if (!candidates.length) {
      skipped.push(vId + ': 待审里没有')
      continue
    }
    for (const candidate of candidates) {
      if (!encoder) {
        skipped.push(vId + ': 没有 encoder（不许静默降级）')
        continue
      }
      const slot = await makeSlotAsync({
        kind: candidate.kind || KIND.STICKER,
        semantic: candidate.semantic,
        tags: candidate.tags || {},
        source: candidate.source || source,
        person: candidate.person || person,
        at: candidate.at || at,
        vId,
        encoder,
      })
      store.upsert(slot)
      promoted.push(slot.id)
    }
  }
  return { promoted, skipped }
}

/** 回退：被推翻的槽标 superseded（不删数据，能恢复）。 */
export function revokeSlot({ store, slotId = '' } = {}) {
  const updated = store.update(slotId, { status: 'superseded' })
  return { ok: Boolean(updated), slotId }
}