import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const UI = readFileSync(join(ROOT, 'ui', 'panel.js'), 'utf8')

test('主题默认跟随 DSH 宿主，不再只跟系统', () => {
  assert.match(UI, /function hostThemeMode\(\)/, '要有宿主主题探测')
  assert.match(UI, /window\.parent[\s\S]{0,120}document/, '要读父窗口文档')
  assert.match(UI, /function watchHostTheme\(\)/, '宿主切主题要即时跟随')
  assert.match(UI, /watchHostTheme\(\)/, '启动时要挂上监听')
  assert.match(UI, /跟随 DSH 主题/, '面板文案要写清跟随谁')
  const restore = UI.slice(UI.indexOf('function restoreTheme'), UI.indexOf('function currentTheme'))
  assert.match(restore, /else applyTheme\(''\)/, '没有手动选择时默认跟随 DSH')
})
