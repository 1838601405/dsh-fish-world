// 鱼卡 v3 惦记档判据（施工单 §5 + 判据 #7）。
//
// #7 原文：「惦记三条：24h 未被注入必过期；接上后下一轮 grep 为 0；20 轮内主动重提 ≤ 1 次」
// 全用 tmpdir（AGENTS 6.3：不依赖本机世界根）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  THOUGHT_FILE, MAX_THOUGHTS, EXPIRE_MS, MAX_PICKS,
  hookThought, listThoughts, markPicked, closeThought, countThoughts,
} from '../lib/fishcard-thought.mjs'

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fct-'))
  mkdirSync(join(root, '鱼的状态'), { recursive: true })
  return root
}

const HOUR = 60 * 60 * 1000

test('★ 落点与结构：`鱼的状态/惦记.json`，字段按施工单原样', () => {
  const root = mkRoot()
  const r = hookThought({ worldRoot: root, who: '小明', topic: '他上次问我会不会打游戏', now: 1000 })
  assert.equal(r.ok, true)
  const file = join(root, THOUGHT_FILE)
  assert.equal(existsSync(file), true, '★ 落在主人拍板的位置')
  const arr = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(arr.length, 1)
  const it = arr[0]
  for (const k of ['who', 'topic', 'hookedAt', 'expiryAt', 'picked']) {
    assert.ok(k in it, `★ 字段 ${k} 必须有（施工单原样）`)
  }
  assert.equal(it.picked, 0, '★ 初始 0 次（用次数不是 boolean ——「最多再捡一次」要计数）')
  assert.equal(it.expiryAt - it.hookedAt, EXPIRE_MS, '★ 24h 过期')
})

test('★★ 判据#7-①：24 小时没动必过期，且 onExpire 被调（§5「过期并记 activity」）', () => {
  const root = mkRoot()
  const t0 = 1_000_000
  hookThought({ worldRoot: root, who: 'a', topic: '没说完的那句', now: t0 })

  const seen = []
  // 没到 24h：还在
  const early = listThoughts({ worldRoot: root, now: t0 + 23 * HOUR, onExpire: (x) => seen.push(x) })
  assert.equal(early.thoughts.length, 1, '★ 23 小时还没过期')
  assert.equal(seen.length, 0)

  // 超过 24h：必过期 + 回调 + 落盘移除
  const late = listThoughts({ worldRoot: root, now: t0 + EXPIRE_MS + 1, onExpire: (x) => seen.push(x) })
  assert.equal(late.thoughts.length, 0, '★★ 过期了就不注入')
  assert.equal(late.expired.length, 1)
  assert.equal(seen.length, 1, '★ onExpire 被调（调用方拿去记 activity）')
  assert.equal(countThoughts(root), 0, '★ 落盘移除了')
  // 第二次查不会重复回调
  listThoughts({ worldRoot: root, now: t0 + EXPIRE_MS + 2, onExpire: (x) => seen.push(x) })
  assert.equal(seen.length, 1, '★ 只过期一次，不重复记账')
})

test('★★ 判据#7-②：接上后下一轮 grep 为 0（当轮不注入 + 落盘移除）', () => {
  const root = mkRoot()
  const topic = '会不会打游戏'
  hookThought({ worldRoot: root, who: '小明', topic, now: 1000 })

  // 还没接上：注入
  const before = listThoughts({ worldRoot: root, now: 2000, text: '今天好累' })
  assert.equal(before.thoughts.length, 1, '★ 没撞词就还在')
  assert.equal(before.thoughts[0].topic, topic)

  // 这一轮**接上了**（文本撞到话题）
  const after = listThoughts({ worldRoot: root, now: 3000, text: '会啊，我打得可好了' + topic + '吗' })
  assert.equal(after.thoughts.length, 0, '★★ 接上那一轮就不注入（grep = 0）')
  assert.equal(after.closed.length, 1, '★ 标成接上')
  assert.equal(countThoughts(root), 0, '★ 落盘移除 —— 下一轮更不会再出现')

  const next = listThoughts({ worldRoot: root, now: 4000, text: '随便聊聊' })
  assert.equal(next.thoughts.length, 0, '★★ 下一轮也是 0')
})

test('★★ 判据#7-③：20 轮内主动重提 ≤ 1 次（最多注入 2 次，第 3 次起不捡）', () => {
  const root = mkRoot()
  const topic = '没答上来的问题'
  hookThought({ worldRoot: root, who: 'b', topic, now: 1000 })

  let injected = 0
  // 模拟 20 轮：每轮注入 + 标记 picked（接不上，所以文本一直不撞词）
  for (let round = 1; round <= 20; round++) {
    const r = listThoughts({ worldRoot: root, now: 1000 + round * 1000, text: `第${round}轮说的别的` })
    if (r.thoughts.length) {
      injected += 1
      markPicked({ worldRoot: root, topic, now: 1000 + round * 1000 })
    }
  }
  // 第 1 次注入 + 第 2 次（重提 1 次）→ 之后 picked>=MAX_PICKS 不再注入
  assert.ok(injected <= 2, `★★ 20 轮内注入 ≤2 次（= 重提 ≤1 次），实为 ${injected}`)
  assert.ok(injected >= 1, '★ 至少注入过一次')
  assert.equal(MAX_PICKS, 2, '★ 契约：最多捡 2 次（第 1 次提 + 1 次重提）')
  // 捡够了但**没丢**（留着等过期，别丢信息）
  assert.equal(countThoughts(root), 1, '★ 捡够了不删，等 24h 过期')
})

test('★ 上限 3 条，超了按时间淘汰（最旧的先走）', () => {
  const root = mkRoot()
  hookThought({ worldRoot: root, who: 'a', topic: '最旧的', now: 1000 })
  hookThought({ worldRoot: root, who: 'b', topic: '次旧的', now: 2000 })
  hookThought({ worldRoot: root, who: 'c', topic: '第三', now: 3000 })
  assert.equal(countThoughts(root), 3)

  const r = hookThought({ worldRoot: root, who: 'd', topic: '最新', now: 4000 })
  assert.equal(r.list.length, 3, '★ 超了就裁到 3')
  assert.equal(r.evicted, '最旧的', '★★ 按时间淘汰：最旧的先走')
  const topics = r.list.map((x) => x.topic)
  assert.equal(topics.includes('最旧的'), false)
  assert.equal(topics.includes('最新'), true)
})

test('★ 同人同话题不重复挂（惦记不是清单）+ 空 topic 拒收', () => {
  const root = mkRoot()
  hookThought({ worldRoot: root, who: 'a', topic: '同一句', now: 1000 })
  hookThought({ worldRoot: root, who: 'a', topic: '同一句', now: 2000 })
  assert.equal(countThoughts(root), 1, '★ 重复挂不叠')

  const empty = hookThought({ worldRoot: root, who: 'a', topic: '   ' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /topic/)
})

test('★ closeThought 主动闭合（答上了但字面没撞词）+ 排查用 countThoughts', () => {
  const root = mkRoot()
  hookThought({ worldRoot: root, who: 'a', topic: '某个话题', now: 1000 })
  assert.equal(countThoughts(root), 1)
  const r = closeThought({ worldRoot: root, topic: '某个话题' })
  assert.equal(r.ok, true)
  assert.equal(countThoughts(root), 0, '★ 落盘移除')
  assert.equal(closeThought({ worldRoot: root, topic: '不存在的' }).ok, false, '★ 关不存在的不算成功')
})

test('★ 边界：没给 worldRoot / 文件坏了 → 不炸', () => {
  assert.equal(hookThought({ topic: 'x' }).ok, false)
  assert.deepEqual(listThoughts({}).thoughts, [])
  assert.equal(markPicked({}).ok, false)

  const root = mkRoot()
  writeFileSync(join(root, THOUGHT_FILE), '{不是 json', 'utf8')
  assert.deepEqual(listThoughts({ worldRoot: root }).thoughts, [], '★ 坏文件当空，不抛')
  assert.equal(hookThought({ worldRoot: root, topic: '新话题' }).ok, true, '★ 坏文件能被覆盖修好')
})
