// Stable UI catalog for the capabilities shipped with fish-world.
// This is presentation metadata only; it never becomes a model-callable tool.
export const CAPABILITY_CATALOG = Object.freeze({
  builtIn: [
    { id: 'local-storage', name: '本地数据仓', description: '支撑：记忆、日记、关系与安全审计', is_hidden: true, execution_mode: 'local' },
    { id: 'config', name: '配置服务', description: '支撑：设置归一化、额度与权限策略', is_hidden: true, execution_mode: 'local' },
    { id: 'qq-bridge', name: 'QQ 桥适配', description: '支撑：安全读取消息与 QQ 操作', is_hidden: true, execution_mode: 'local' },
    { id: 'animation-reader', name: '动图解码器', description: '支撑：GIF 与动态 WebP 多帧采样（并入 MIT 上游 dsh-read-animation@0.1.1）', is_hidden: true, execution_mode: 'local' },
    { id: 'sharp', name: '图像解码库', description: '支撑：按需解码 GIF / 动态 WebP；随鱼世界包自动安装', is_hidden: true, execution_mode: 'local' },
    { id: 'request-cache', name: '帧图缓存', description: '支撑：重复视觉请求复用采样结果', is_hidden: true, execution_mode: 'local' },
    { id: 'secret-store', name: '凭证读取', description: '支撑：通过宿主附件服务读取媒体，不向模型暴露凭证', is_hidden: true, execution_mode: 'local' },
  ],
  plugins: [
    { id: 'fish-world-core', name: '鱼世界核心', description: '[本地-极速] 提供状态、访问控制、额度和本地记忆', depends_on: ['本地数据仓', '配置服务'], execution_mode: 'local' },
    { id: 'qq-media', name: 'QQ 媒体读取', description: '[本地-极速] 分类消息媒体并安全展开转发', depends_on: ['QQ 桥适配'], execution_mode: 'local' },
    { id: 'animation-frames', name: '动图帧采样', description: '[本地-极速] 为动画采样时间标记帧并生成胶片条', depends_on: ['动图解码器', 'sharp', '帧图缓存'], execution_mode: 'local' },
    { id: 'stickers', name: '表情收藏', description: '[本地-极速] 收藏、检索与管理图片/GIF', depends_on: ['本地数据仓'], execution_mode: 'local' },
    { id: 'qzone', name: '空间互动', description: '[本地-极速] 在主人隔离会话中按额度管理空间', depends_on: ['QQ 桥适配', '本地数据仓'], execution_mode: 'local' },
  ],
  skills: [
    { id: 'animation-understanding', name: '理解动图', description: '[云端-轻] 结合已采样时序帧解释动作与变化', depends_on: ['动图帧采样'], execution_mode: 'cloud' },
    { id: 'forward-summary', name: '总结聊天记录', description: '[云端-轻] 总结主人指定的合并转发，不虚构缺失内容', depends_on: ['QQ 媒体读取'], execution_mode: 'cloud' },
    { id: 'qzone-writing', name: '撰写空间日记', description: '[云端-轻] 基于已批准本地素材生成日记草稿', depends_on: ['空间互动', '本地数据仓'], execution_mode: 'cloud' },
  ],
})

export function capabilityCatalog() {
  const value = JSON.parse(JSON.stringify(CAPABILITY_CATALOG))
  return { built_in: value.builtIn, plugins: value.plugins, skills: value.skills }
}
