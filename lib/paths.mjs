// 所有落盘位置集中在这里。默认与 dsh-qq-bridge / dsh-whale-widget 使用同一份 DSH_HOME。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileExists } from './util.mjs'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

export const FISH_WORLD_CONFIG = join(DSH_HOME, 'fish-world-config.json')
export const FISH_WORLD_STATE = join(DSH_HOME, 'plugin-ecosystem', 'fish-world', '.state.json')
export const EXTENSION_ROOT = join(DSH_HOME, 'plugin-ecosystem')
export const DEFAULT_SKILL_DIR = join(EXTENSION_ROOT, 'skills')
export const DEFAULT_PLUGIN_DIR = join(EXTENSION_ROOT, 'plugins')
export const STORAGE_ROOT = join(EXTENSION_ROOT, '.storage')

export const BRIDGE_CONFIG = join(DSH_HOME, 'qq-bridge-config.json')
export const BRIDGE_RECEIVED = join(DSH_HOME, 'qq-bridge-received.json')

/** dsh-whale-widget 的落盘候选：桌面端只认 $DSH_HOME，web 端可能写在 profile 里。 */
export const WHALE_ROLE_DIRS = [
  join(DSH_HOME, 'whale-roles'),
  join(DSH_HOME, 'profiles', 'web', 'whale-roles'),
]
export const WHALE_BUBBLE_DIRS = [
  join(DSH_HOME, 'whale-bubble-imgs'),
  join(DSH_HOME, 'profiles', 'web', 'whale-bubble-imgs'),
]
export const WHALE_BUBBLE_FILES = [
  join(DSH_HOME, '.dshw-bubble.json'),
  join(DSH_HOME, 'profiles', 'web', '.dshw-bubble.json'),
]
export const WHALE_SIZE_FILES = [
  join(DSH_HOME, '.dshw-size.json'),
  join(DSH_HOME, 'profiles', 'web', '.dshw-size.json'),
]
export const WHALE_USAGE_FILES = [
  join(DSH_HOME, '.dshw-usage.json'),
  join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
]
export const WHALE_TURN_FILES = [
  join(DSH_HOME, '.dshw-turn.json'),
  join(DSH_HOME, 'profiles', 'web', '.dshw-turn.json'),
]

/** 找 whale-widget 安装包（内置角色图 / 内置表情图在它的 assets 里）。 */
export function whalePackageDirs() {
  const dirs = []
  for (const profile of ['desktop', 'web']) {
    dirs.push(join(DSH_HOME, 'profiles', profile, 'node_modules', 'dsh-whale-widget'))
  }
  dirs.push(join(DSH_HOME, 'node_modules', 'dsh-whale-widget'))
  return dirs.filter((dir) => fileExists(join(dir, 'package.json')))
}

export function firstExistingFile(files) {
  for (const file of files || []) {
    if (fileExists(file)) return file
  }
  return ''
}

export function firstExistingDir(dirs) {
  for (const dir of dirs || []) {
    if (fileExists(dir)) return dir
  }
  return ''
}
