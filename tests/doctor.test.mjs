import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diagnoseDesktop } from '../scripts/doctor.mjs'

function profileFixture() {
  const home = mkdtempSync(join(tmpdir(), 'fish-world-doctor-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  return { home, profileDir }
}

function writeProfile(profileDir, { bundle = true, dependency = true } = {}) {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: dependency ? { 'dsh-fish-world': 'link:C:/elsewhere/dsh-fish-world' } : {},
    dsh: { profile: { bundles: bundle ? ['@deepseek-ai/dsh-base', 'dsh-fish-world'] : ['@deepseek-ai/dsh-base'] } },
  }, null, 2), 'utf8')
}

test('doctor reports a dropped bundle even when the dependency still exists', () => {
  const { home, profileDir } = profileFixture()
  writeProfile(profileDir, { bundle: false })
  const result = diagnoseDesktop({ home, sourceDir: join(home, 'source') })
  assert.equal(result.ok, false)
  const codes = result.issues.map((issue) => issue.code)
  assert.ok(codes.includes('bundle-missing'))
  assert.ok(codes.includes('link-missing'))
  assert.equal(result.issues.find((issue) => issue.code === 'bundle-missing').fixable, true)
})

test('doctor accepts a correctly wired profile', () => {
  const { home, profileDir } = profileFixture()
  const sourceDir = join(home, 'source')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
    name: 'dsh-fish-world',
    main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  writeProfile(profileDir)
  symlinkSync(sourceDir, join(profileDir, 'node_modules', 'dsh-fish-world'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = diagnoseDesktop({ home, sourceDir })
  assert.deepEqual(result.issues, [])
  assert.equal(result.ok, true)
})

test('doctor flags a package that no longer declares dsh.bundle', () => {
  const { home, profileDir } = profileFixture()
  const sourceDir = join(home, 'source')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: 'dsh-fish-world', main: 'lib/index.js' }), 'utf8')
  writeProfile(profileDir)
  symlinkSync(sourceDir, join(profileDir, 'node_modules', 'dsh-fish-world'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = diagnoseDesktop({ home, sourceDir })
  assert.ok(result.issues.some((issue) => issue.code === 'not-a-bundle'))
  assert.equal(result.ok, false)
})
