import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const installer = join(root, 'scripts', 'install-desktop.mjs')

function fixture() {
  // Simulates a profile installed before the two packages were merged into
  // dsh-fish-world, so the installer's upgrade migration gets exercised.
  const home = mkdtempSync(join(tmpdir(), 'fish-world-install-'))
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  mkdirSync(join(profile, 'companion'), { recursive: true })
  mkdirSync(join(profile, 'adapter'), { recursive: true })
  const modules = join(profile, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(join(profile, 'companion'), join(modules, 'dsh-companion-panel'), linkType)
  symlinkSync(join(profile, 'adapter'), join(modules, 'dsh-qq-ecosystem-adapter'), linkType)
  const packageJson = {
    name: 'test-profile',
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base',
      'dsh-qq-bridge',
      'dsh-companion-panel',
      'dsh-cost-meter',
      'dsh-qq-ecosystem-adapter',
      'dsh-whale-widget',
    ] } },
    dependencies: {
      'dsh-companion-panel': 'link:./companion',
      'dsh-qq-ecosystem-adapter': 'link:./adapter',
      'dsh-cost-meter': '^1.0.0',
      'dsh-whale-widget': '^0.4.2',
    },
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(packageJson, null, 2))
  return { home, profile, initialBundles: packageJson.dsh.profile.bundles }
}

function run(home, ...args) {
  execFileSync(process.execPath, [installer, ...args, '--no-auth-repair'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
  })
}

test('desktop installer keeps one user-facing bundle and restores profile state on uninstall', () => {
  const { home, profile, initialBundles } = fixture()
  const packagePath = join(profile, 'package.json')
  const target = join(profile, 'node_modules', 'dsh-fish-world')

  run(home)
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'))
  assert.deepEqual(installed.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', 'dsh-cost-meter', 'dsh-whale-widget', 'dsh-fish-world',
  ])
  assert.equal(installed.dependencies['dsh-cost-meter'], '^1.0.0')
  assert.equal(installed.dependencies['dsh-companion-panel'], undefined)
  assert.equal(installed.dependencies['dsh-qq-ecosystem-adapter'], undefined)
  assert.equal(installed.dependencies['dsh-fish-world'], `link:${resolve(root).replace(/\\/g, '/')}`)
  assert.ok(installed.dependencies['dsh-qq-bridge'])
  assert.equal(installed.dependencies['dsh-whale-widget'], '^0.4.2')
  assert.ok(existsSync(target))
  assert.equal(existsSync(join(profile, 'node_modules', 'dsh-companion-panel')), false)
  assert.equal(existsSync(join(profile, 'node_modules', 'dsh-qq-ecosystem-adapter')), false)

  run(home)
  const repeated = JSON.parse(readFileSync(packagePath, 'utf8'))
  assert.deepEqual(repeated.dsh.profile.bundles, installed.dsh.profile.bundles)

  run(home, '--uninstall')
  const restored = JSON.parse(readFileSync(packagePath, 'utf8'))
  assert.deepEqual(restored.dsh.profile.bundles, initialBundles)
  assert.equal(restored.dependencies['dsh-fish-world'], undefined)
  assert.equal(restored.dependencies['dsh-companion-panel'], 'link:./companion')
  assert.equal(restored.dependencies['dsh-qq-ecosystem-adapter'], 'link:./adapter')
  assert.equal(restored.dependencies['dsh-cost-meter'], '^1.0.0')
  assert.equal(existsSync(target), false)
})

test('installer restores a previously active optional whale bundle from older integration state', () => {
  const { home, profile } = fixture()
  const packagePath = join(profile, 'package.json')
  const original = JSON.parse(readFileSync(packagePath, 'utf8'))
  original.dsh.profile.bundles = original.dsh.profile.bundles.filter((name) => name !== 'dsh-whale-widget')
  writeFileSync(packagePath, JSON.stringify(original, null, 2))
  writeFileSync(join(profile, '.dsh-fish-world.install-state.json'), JSON.stringify({
    version: 1,
    addedBundles: [],
    addedDependencies: {},
    removedBundles: [{ name: 'dsh-whale-widget', index: 5 }],
    removedDependencies: {},
  }))

  run(home)
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'))
  assert.ok(installed.dsh.profile.bundles.includes('dsh-whale-widget'))
  const state = JSON.parse(readFileSync(join(profile, '.dsh-fish-world.install-state.json'), 'utf8'))
  assert.equal(state.removedBundles.some((entry) => entry.name === 'dsh-whale-widget'), false)
})
