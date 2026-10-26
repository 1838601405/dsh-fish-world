// 所有落盘位置集中在这里。与 dsh-qq-bridge 使用同一份 DSH_HOME。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileExists } from './util.mjs'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

export const FISH_WORLD_CONFIG = join(DSH_HOME, 'fish-world-config.json')
export const FISH_WORLD_STATE = join(DSH_HOME, 'plugin-ecosystem', 'fish-world', '.state.json')
const EXTENSION_ROOT = join(DSH_HOME, 'plugin-ecosystem')
export const DEFAULT_SKILL_DIR = join(EXTENSION_ROOT, 'skills')
export const DEFAULT_PLUGIN_DIR = join(EXTENSION_ROOT, 'plugins')
export const STORAGE_ROOT = join(EXTENSION_ROOT, '.storage')

export const BRIDGE_CONFIG = join(DSH_HOME, 'qq-bridge-config.json')


