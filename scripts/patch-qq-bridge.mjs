#!/usr/bin/env node
// 给已安装的 dsh-qq-bridge 打/查/撤「出站闸」补丁。
//
//   node scripts/patch-qq-bridge.mjs          打补丁（幂等；改前备份、改后语法检查）
//   node scripts/patch-qq-bridge.mjs --check  只检查，不写盘
//   node scripts/patch-qq-bridge.mjs --revert 撤销补丁
//
// 为什么要这一步：桥插件自己监听 session/event、自己发 QQ，不经过本插件，
// 所以它那条路上的工具调用语法只能就地补。桥更新后重跑一次即可。
//
// 面板里也有同样的入口：「鱼与世界 → 鱼与 QQ → 设置 → 工具调用泄漏闸」。
import { bridgeGuardStatus, findBridgeHost, patchBridgeNow } from '../lib/bridge-patch.mjs'

const args = new Set(process.argv.slice(2))
const hostFile = findBridgeHost()

if (!hostFile) {
  console.log('没有找到已安装的 dsh-qq-bridge（看 DSH_HOME/profiles/*/node_modules）。')
  console.log('装好桥之后再跑一次；或者用 DSH_QQ_BRIDGE_DIR 指定桥的目录。')
  process.exit(args.has('--check') ? 0 : 1)
}

if (args.has('--check')) {
  const status = bridgeGuardStatus()
  console.log(`桥：${hostFile}`)
  console.log(status.patched ? '出站闸：已打' : '出站闸：未打（owner 会话的回复不经过泄漏清洗）')
  process.exit(0)
}

const action = args.has('--revert') ? 'revert' : 'apply'
const result = patchBridgeNow({ action })
if (!result.ok) {
  console.error(result.error || '操作失败')
  process.exit(1)
}
if (!result.changed) {
  console.log(action === 'revert' ? '当前没有补丁，不需要撤销。' : `已经是最新补丁，无需改动：${hostFile}`)
  process.exit(0)
}
console.log(`${action === 'apply' ? '已打补丁' : '已撤销补丁'}：${hostFile}`)
if (action === 'apply') console.log('以后更新了桥，重跑 `node scripts/patch-qq-bridge.mjs` 即可。')
