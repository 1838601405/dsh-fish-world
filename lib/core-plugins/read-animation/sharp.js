/**
 * Lazy `sharp` acquisition.
 *
 * Prefer an explicitly configured module or a host-provided copy, then resolve
 * the package-local dependency. Keep resolution lazy: static images and text-only
 * startup must not load the native decoder.
 *
 * The order:
 *
 * 1. `$DSH_READ_ANIMATION_SHARP`, an explicit module path — for tests and for
 *    deployments whose layout defeats the steps below;
 * 2. the host attachment store, when its package is resolvable;
 * 3. the running process entry;
 * 4. the plugin's own resolution chain (package install).
 *
 * Resolution is cached after the first success: the loader runs once per
 * process, and `sharp` is expensive to re-require.
 *
 * @module dsh-read-animation/sharp
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

const requireFromPlugin = createRequire(import.meta.url)

/** Environment variable naming an explicit `sharp` module path. */
export const SHARP_PATH_ENV = 'DSH_READ_ANIMATION_SHARP'

/** @type {import('sharp') | undefined} */
let cached

/**
 * Resolve and cache the `sharp` module.
 * @returns the `sharp` callable.
 * @throws when no resolution step can find a loadable `sharp`.
 */
export function loadSharp() {
  if (cached !== undefined) return cached
  /** @type {string[]} */
  const failures = []

  const override = process.env[SHARP_PATH_ENV]
  if (typeof override === 'string' && override.trim().length > 0) {
    try {
      cached = requireFromPlugin(override.trim())
      return cached
    } catch (error) {
      failures.push(`${SHARP_PATH_ENV}: ${message(error)}`)
    }
  }

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profiles = [...new Set([process.env.DSH_PROFILE, 'desktop', 'web'].filter(Boolean))]
  for (const profile of profiles) {
    try {
      // A local fish-world checkout may be junctioned into node_modules, while
      // its runtime dependencies are installed beside the DSH profile.
      cached = createRequire(join(home, 'profiles', profile, 'node_modules', '__fish_world__.cjs'))('sharp')
      return cached
    } catch (error) {
      failures.push(`${profile} profile: ${message(error)}`)
    }
  }

  try {
    cached = createRequire(join(home, 'node_modules', '__fish_world__.cjs'))('sharp')
    return cached
  } catch (error) {
    failures.push(`DSH_HOME: ${message(error)}`)
  }

  try {
    const anchor = requireFromPlugin.resolve('@deepseek-ai/dsh-attachment-local/package.json')
    cached = createRequire(anchor)('sharp')
    return cached
  } catch (error) {
    failures.push(`host attachment store: ${message(error)}`)
  }

  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    try {
      cached = createRequire(entry)('sharp')
      return cached
    } catch (error) {
      failures.push(`host process entry: ${message(error)}`)
    }
  }

  try {
    cached = requireFromPlugin('sharp')
    return cached
  } catch (error) {
    failures.push(`plugin resolution: ${message(error)}`)
  }

  throw new Error(
    'dsh-read-animation could not load "sharp". It is a declared dependency, so this usually means ' +
      'the package was installed without one (a "link:"ed checkout needs its own install), or the ' +
      'native binary failed to build. Set ' +
      `${SHARP_PATH_ENV} to an explicit module path to override. Tried — ${failures.join('; ')}`,
  )
}

/** Render one caught value as a single line for the diagnostic above. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
