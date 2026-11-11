// 能力声明机检：只读 pill 的文件里不得出现写桥调用；旧 banner 字段必须归零。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const fish = join(root, '..', 'WhaleGirl', 'flutter', 'lib', 'fish')
if (!existsSync(fish)) {
  console.log('跳过能力机检：找不到 Flutter 源')
  process.exit(0)
}
const writeCalls = /bridge(FishWishDecision|FishDiaryDecision|FishDiaryComment|FishGrowthRevise|FishGrowthRetract|FishMemoryAction|KbUpdate|StickerUpdate|FishGalleryRemove)\s*\(/
const problems = []
for (const name of readdirSync(fish).filter((n) => n.endsWith('.dart'))) {
  const text = readFileSync(join(fish, name), 'utf8')
  if (/bannerText|fishReadonlyHint/.test(text)) problems.push(name + ' 仍有旧 banner 字段')
  if (/FishCapabilityPill|FishAccess/.test(text)) problems.push(name + ' 仍有能力 pill 残留')
  if (/FishCapabilityPill\(\s*access:\s*FishAccess\.readOnly/.test(text) && writeCalls.test(text)) {
    problems.push(name + ' 标了只读却出现写桥调用')
  }
}
if (problems.length) {
  console.error('能力机检失败：\n' + problems.map((p) => ' - ' + p).join('\n'))
  process.exit(1)
}
console.log('能力机检通过：无 pill / 旧 banner，只读页无写桥调用')
