// 内置角色卡预设。
//
// 为什么放代码里而不是预置到 $DSH_HOME：
// 预设是"随插件一起发出去的文案"，属于代码资产；主人的自定义人设才落盘。
// 这样卸载重装、换机器都不会把预设弄丢，也不会在没选之前就写一堆文件。
export const PERSONA_PRESETS = Object.freeze([
  {
    id: 'blue-whale',
    name: '蓝鲸娘',
    subtitle: 'DeepSeek 小鲸鱼',
    summary: '傲娇、嘴硬、毒舌但心软的鲸鱼娘。能短就短，不说 AI 套话。',
    // 正文不内置：全局人设只有一份，在 $DSH_HOME/fish-world-personas/default.md。
    // 这里只留 id / 名字 / 摘要，点开时由后端读真实人设卡（见 lib/http.mjs）。
    dynamic: true,
    text: '',
  },
])

export function personaPresetList() {
  return PERSONA_PRESETS.map((item) => ({
    id: item.id,
    name: item.name,
    subtitle: item.subtitle,
    summary: item.summary,
    bytes: Buffer.byteLength(item.text),
    chars: item.text.length,
  }))
}

export function personaPreset(id) {
  const key = String(id || '')
  return PERSONA_PRESETS.find((item) => item.id === key) || null
}
