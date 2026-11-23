// scope 字段判据（主人 2026-11-24 三：**先留一个字段，但别用它做判断**）。
//
// 原话：
//   「现在只写不读——不要拿它去过滤任何查询。目前所有数据都是 home，
//     一旦按 scope 过滤，结果会全空，看起来就像"记忆丢了"。」
//   判据：① 新增/改动的条目 scope 都有值、没空值；
//         ② 现有一切查询结果与改前**逐字节一致**（因为还没启用过滤）。
//
// ★ 这里用**源码级**：数据在本机（`fish-memory` / 账本），测试不读它（AGENTS 6.3）；
//   「查询结果一致」的可自动化部分就是 —— **代码里不许出现按 scope 的比较/过滤**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mem = readFileSync(join(here, '..', 'lib', 'fish-memory-bridge.mjs'), 'utf8')
const growth = readFileSync(join(here, '..', 'lib', 'growth.mjs'), 'utf8')

/** 剥掉注释再扫 —— M59：注释里的说明文字也是输入，但那是「写法说明」不是实现。 */
function code(src) {
  return src.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  }).join('\n')
}

test('★★ 判据1：记忆与成长的写入点都有 scope，且值是 "home"', () => {
  const m = code(mem)
  const g = code(growth)
  assert.match(m, /scope:\s*'home'/, '★ 记忆条目（fish-memory-bridge 的 entry）要有 scope')
  assert.match(g, /scope:\s*'home'/, '★ 成长条目（growth 的 ledger entry）要有 scope')
  // 不许写空值 / undefined / null（判据1「没有空值」）
  assert.equal(/scope:\s*(undefined|null|''|"")/.test(m + g), false, '★ 不许空值')
})

test('★★ 判据2：**只写不读** —— 代码里不许出现按 scope 的比较或过滤', () => {
  const all = code(mem) + '\n' + '\n' + code(growth)
  // 任何形式的「用它做判断」都算启用过滤
  assert.equal(/\.scope\s*[=!]==/.test(all), false,
    '★★ 不许 `.scope ===` / `.scope !==` —— 那就是拿它过滤了')
  assert.equal(/scope\s*===\s*['"]/.test(all), false,
    '★★ 不许 `scope === "..."` 比较')
  assert.equal(/filter\s*\([^)]*\bscope\b/.test(all), false,
    '★★ 不许 `filter(...scope...)` —— 按它筛查询会让结果全空')
  assert.equal(/if\s*\([^)]*\bscope\b[^)]*\)\s*return\s+\[\]/.test(all), false,
    '★ 不许「按 scope 提前返回空」')
})

test('★ 两个模块互不影响：记忆只写在 bridge、成长只写在 growth', () => {
  // 防止有人把 scope 写到不相干的地方（改错文件时这条会红）
  assert.match(code(mem), /const entry = \{[\s\S]{0,200}?scope:\s*'home'/, '★ 记忆的 entry 里')
  assert.match(code(growth), /const entry = \{[\s\S]{0,200}?scope:\s*'home'/, '★ 成长的 entry 里')
})
