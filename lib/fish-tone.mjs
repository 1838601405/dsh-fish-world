// 鱼的风格：只读看 dsh-fish-tone 现在是什么档。
//
// 为什么单开一层：说话风格（去 AI 味）由 dsh-fish-tone 自己管——它注册了系统提示词段
// `fish-tone:voice` 和 fish_tone / fish_judge 两个工具，配置也有它自己的设置页。
// 鱼世界不复制它的规则、不写它的配置，只把「现在用的是哪一档」读出来给面板看。
//
// 三条纪律：
//  · 只读：这里不建 config.json、不改它任何东西；
//  · 不猜：读不到就说读不到（坏 JSON 如实报），不拿默认值冒充「读到了」；
//  · 默认值与上游对齐：上游 dsh-fish-tone 的 DEFAULTS 就是这几个值，别自己另定一套。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDependency } from './env.mjs'

/** 与 dsh-fish-tone@0.3.0 的 DEFAULTS 同一份口径（配置文件不存在时它就用这些）。 */
export const TONE_DEFAULTS = Object.freeze({
  enabled: true,
  strength: 'light',
  seed: 7,
  grammar: true,
  marks: 'light',
})

/** 上游认的档位：off / light / normal / max。别的地方传了别的值就当没写。 */
const LEVELS = new Set(['off', 'light', 'normal', 'max'])

/** 面板与接口共用的一句说明：改设置在它自己的页面里，鱼世界只读。 */
export const TONE_NOTE = '设置在 dsh-fish-tone 自己的页面里改（/api/fish-tone）；鱼世界只读显示'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/**
 * 造一个「鱼的风格」只读视图。
 *
 * @param {object} options
 * @param {string} options.home       $DSH_HOME
 * @param {string} [options.profile]  用哪个 profile 找包
 * @param {object} [options.logger]   预留：读失败按调用方决定要不要记
 * @param {Function} [options.locate] 找包位置的替身（默认 env.mjs 的 resolveDependency）；
 *                                    测试靠它避开本机装了什么
 * @param {object} [options.env]      环境变量替身（默认 process.env）
 */
export function createFishTone({ home, profile, logger, locate = resolveDependency, env = process.env } = {}) {
  /**
   * 读一次现状。每次都重新读盘：主人在 dsh-fish-tone 设置页改完，面板刷新就能看见。
   */
  function status() {
    // 找安装位置：找不到就是没装，不往别处硬找（也不假装「装了就绪」）。
    let found = null
    try {
      found = locate('dsh-fish-tone', { home, profile })
    } catch (error) {
      logger?.warn?.(`fish-world: 查 dsh-fish-tone 安装位置失败：${error?.message || error}`)
      found = null
    }
    if (!found || found.found !== true || !found.path) {
      return { ok: false, installed: false, error: '未安装 dsh-fish-tone' }
    }

    // 配置路径：上游自己优先认 DSH_FISH_TONE_CONFIG，否则是「插件根/config.json」。
    // 两处口径必须一致，否则面板显示的会是另一份配置。
    const override = String(env?.DSH_FISH_TONE_CONFIG || '').trim()
    const configPath = override || join(String(found.path), 'config.json')
    const version = String(found.version || '')

    // 文件不存在不算错：上游本来就用默认值跑，这里也只是把默认值报出来（但不建文件）。
    if (!existsSync(configPath)) {
      return {
        ok: true,
        installed: true,
        version,
        ...TONE_DEFAULTS,
        configPath,
        configExists: false,
        source: '默认值',
        note: TONE_NOTE,
      }
    }

    let raw = null
    try {
      raw = readJson(configPath)
    } catch (error) {
      // 坏 JSON = 上游那边写入被中断或手改坏了。如实报，别用默认值盖过去。
      return {
        ok: false,
        installed: true,
        version,
        configPath,
        configExists: true,
        error: `dsh-fish-tone 的 config.json 读不出来：${String(error?.message || error)}`,
        note: TONE_NOTE,
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        installed: true,
        version,
        configPath,
        configExists: true,
        error: 'dsh-fish-tone 的 config.json 不是一个 JSON 对象',
        note: TONE_NOTE,
      }
    }

    // 只认上游也认的字段与取值：写坏的值（比如 strength: 'strong'）按「没写」处理，
    // 因为上游 loadConfig 也是这么忽略的——两边显示同一档才不会打架。
    const values = { ...TONE_DEFAULTS }
    if (typeof raw.enabled === 'boolean') values.enabled = raw.enabled
    if (typeof raw.grammar === 'boolean') values.grammar = raw.grammar
    if (LEVELS.has(raw.strength)) values.strength = raw.strength
    if (LEVELS.has(raw.marks)) values.marks = raw.marks
    if (Number.isFinite(raw.seed)) values.seed = raw.seed

    return {
      ok: true,
      installed: true,
      version,
      ...values,
      configPath,
      configExists: true,
      source: 'config.json',
      note: TONE_NOTE,
    }
  }

  return { status }
}
