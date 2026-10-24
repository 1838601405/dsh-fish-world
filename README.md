# dsh-fish-world · 鱼的世界

一个面向 DeepSeek Harness（DSH）的开源整合插件。用户只需安装 **一个 DSH bundle**；QQ、记忆、心情、B 站和朗读能力由包管理器作为依赖安装、由本包的 composition patch 统一装配。`dsh-whale-widget` 是可选项：已安装时自动与右侧面板联动，未安装时鱼世界面板独立显示。不要把这些内部子插件作为 profile 顶层 bundle 重复启用。

## 兼容性

- 操作系统：Windows、macOS、Linux；运行时路径使用 Node.js `os.homedir()`、`path.join()` 和 DSH 提供的 `DSH_HOME`，不绑定某台电脑的盘符或用户名。
- Node.js：`>=20`。
- DSH：使用公开的 `dsh.bundle.patch` / client injection / `webServer` 接口。语音能力为可选子依赖；未提供该能力的 DSH 版本仍可使用其它功能。
- 默认 DSH 数据目录为 `~/.dsh`；自定义安装位置请设置环境变量 `DSH_HOME`。

## 安装

### 从 GitHub 安装

在 DSH 的插件管理器中安装仓库 `github:<GitHub 用户或组织>/dsh-fish-world`。插件管理器会根据 `package.json` 安装需要的依赖。安装后只启用 `dsh-fish-world` 这个顶层 bundle；其它能力由它内部装配。

### 从源码安装到 desktop profile

```sh
git clone https://github.com/<GitHub 用户或组织>/dsh-fish-world.git
cd dsh-fish-world
node scripts/install-desktop.mjs
```

脚本默认使用 `~/.dsh/profiles/desktop`，也支持 `--profile=<名称>`、`--home=<DSH_HOME>`。也可通过 `DSH_HOME` 环境变量指定目录：

```powershell
$env:DSH_HOME = '你的 DSH 数据目录'
node scripts/install-desktop.mjs
```

```sh
DSH_HOME="$HOME/.dsh" node scripts/install-desktop.mjs
```

安装器会备份 profile `package.json`，登记本地源码和依赖、将重复的子 bundle 从顶层列表移除，并记录原位置以便卸载时恢复。完成依赖安装后，完整退出并重开 DSH。

卸载：

```sh
node scripts/install-desktop.mjs --uninstall
```

## 依赖自检

本插件依赖 5 个独立发布的前置插件：QQ 桥、心情面板、鱼的记忆、长期记忆（`dsh-mnemon`）、B 站能力；朗读桥是可选能力，默认关闭。缺少必需依赖时，插件会在启动、打开面板、调用工具和渲染系统提示词时提醒；依赖装齐后**完全安静**。

GIF / 动态 WebP 的多帧采样已从 `dsh-read-animation` 合并进鱼世界主包（MIT，保留上游许可证）；用户无需再单独安装动画插件。主程序带 `sharp` 解码依赖，在原始附件准入阶段本地采样时间轴帧，模型接收带时序标注的帧胶片条；普通图片仍走原生图像链路。朗读桥保留为可选能力，但自动朗读默认关闭；右侧齿轮中的「显示朗读桥卡（默认关闭）」只控制卡片显隐，可随时重新打开，不会开启自动朗读。设置页与主界面通过 `BroadcastChannel`/`storage` 实时同步显隐状态。若确需自动朗读，可在 `$DSH_HOME/fish-world-config.json` 设置 `{ "tts": { "auto": true } }`。

"鱼的日记"入口位于面板「鱼的日记」区，**由主人查看鱼写的日记**：主人只能按日期浏览、审批信任者投稿，不能代笔。鱼通过 `fish_world` 工具的 `diary` action 写自己的日记，默认署名为当前外显角色名；信任者提交的内容进入「待主人确认」，主人可在面板逐条通过或拒绝。面板的本地 HTTP 日记路由只允许 GET，POST 一律 405。

检查结果出现在这些地方，内容一致：

- 主界面右侧面板顶部的环境提示条（13px，含逐项安装命令和「重新检查」按钮）；
- Harness 设置页「鱼的世界」同一位置；
- 工具 `fish_world` 的 `action: "env-check"`（以及 QQ 相关动作在缺 QQ 桥时直接返回安装命令，不必等超时）；
- 系统提示词里的【运行环境】一节（仅异常时出现）；
- 本机 HTTP：`GET /dsh-fish-world/env` 读缓存，`POST` 强制重查；`/health` 带脱敏后的环境视图。两者都只允许 loopback。

检查有 60 秒缓存，面板打开时每分钟刷新一次；装好前置插件并重启 DSH 后，提示会自动消失。除 `dsh-mnemon` 走 npm 外，其余五项只在 GitHub 发布，安装命令必须用仓库地址而不是裸包名：

```sh
dsh plugin --profile <profile> add github:Yuuyuko-uu/dsh-qq-bridge
dsh plugin --profile <profile> add github:Yuuyuko-uu/dsh-feiyu-mood
dsh plugin --profile <profile> add github:Yuuyuko-uu/dsh-fish-memory
dsh plugin --profile <profile> add dsh-mnemon
dsh plugin --profile <profile> add github:Yuuyuko-uu/dsh-bili-subagent
dsh plugin --profile <profile> add github:Yuuyuko-uu/dsh-tts-bridge
```

`<profile>` 就是正在使用的 profile 名（桌面端默认 `desktop`，Web 端为 `web`），提示条会直接给出填好的命令。安装完成后完整退出并重开 DSH。

## 能力与数据

- **QQ 与扩展生态**：适配 QQ Agent 0.5 / 0.4 扩展；发信仍遵循 QQ 桥的总开关、试运行和目标限制。保留旧工具 `qq_ecosystem` 作为兼容别名。
- **看得懂 QQ 消息里有什么**：`fish_world` 的 `action: "history"` 会标出每段内容的类型——图片、**动图（GIF / 动画表情）**、表情包、语音、视频、卡片、回复、@ 以及**合并转发的聊天记录**，不再只剩文字；遇到 `[聊天记录:id]` 会顺手展开前 2 条记录（每条最多 20 行、合计 40 行），没展开的用 `action: "forward"` + `forwardId` 单独读。GIF / 动态 WebP 在进模型前本地采样为带帧号和时间标记的胶片条，界面仍显示原动图；仅在抽样不足或链路不支持时说明限制，不猜帧间动作。
- **面板兼容**：`dsh-whale-widget` 是可选插件。未检测到它时，主界面右侧显示独立鱼世界面板；检测到时把心情（以及正在朗读的状态）合并成鲸鱼身上的一个徽标，同时收起 `dsh-feiyu-mood` 的心情挂饰和 `dsh-tts-bridge` 的朗读桥小卡，主界面只留鲸鱼和它的余额气泡，不再有三个挂件叠在右下角。两个原挂件没有删除，可在 Harness 设置 →「鱼的世界」→ 齿轮里单独放出来（`dshcp.showMood` / `dshcp.showTts`），改完立即生效。**「设置 → 鱼的世界」这个入口本身不可隐藏**：它是恢复其它挂件的唯一入口，旧版本遗留的 `dshcp.showSettings='0'` 会被自动纠正为显示。独立面板的悬浮按钮可拖动、点击可开关面板；面板可从边角手柄拖拽调整大小，位置和尺寸会记住。
- **鱼的世界工作区**：在当前 DSH 工作区下创建 `鱼的世界/`，用于记忆、日记、关系、心理/生理状态和审计记录。信任者日记进入待主人审核区。
- **表情收藏**：收藏库在 `$DSH_HOME/fish-world/stickers/`，独立于鲸鱼挂件泡泡图；默认每小时最多 5 张，可在设置页修改。
- **QQ 空间**：鱼用 QQ 桥登录的**自己的 QQ 号**打理和发布**自己的空间**，不是主人的空间；所有读写只允许在主人隔离会话里发起。可读自己空间的好友动态、发说说/日记、点赞、评论和回复。动态/日记共用每天 2 次；点赞、评论、回复各每天 2 次，均可在设置页修改，0 表示禁用对应操作。计时器每 15 分钟检查日记是否到期；到期后只向已打开的主人会话投递写作提醒，由鱼调用受限工具发布，不直接生成或发布内容。主人会话不可用时会等它恢复。
- **扩展安装**：不托管、不镜像下载。你自己搜索扩展，把作者原始的 https 链接（GitHub 仓库主页或 ZIP 直链）粘到设置页即可一键安装；面板同时提供 GitHub / npm 搜索入口。压缩包会做安全解包与清单校验，新扩展保持禁用，启用前需确认。npm 包请改用其 GitHub 仓库或 ZIP。

**权限边界说明：**QQ 空间工具在执行时会校验 DSH execution session 必须匹配 QQ 桥配置的主人会话；缺失会话上下文时默认拒绝。操作身份始终是 QQ 桥登录的鱼账号，不会切换成主人 QQ，也只能读写鱼自己空间里的内容。世界日记/关系数据层虽支持信任者待审，但完整的 QQ 身份贯穿和联系人会话隔离仍在完善，不能把模型传入的 `role` 当认证。loopback 限制也不等于身份认证；不要把本机管理端口暴露给网络。

## 路径与配置

所有运行时数据以 `DSH_HOME` 为根目录，不要求采用下列任何固定盘符：

- 配置：`$DSH_HOME/fish-world-config.json`
- 扩展：`$DSH_HOME/plugin-ecosystem/{skills,plugins}/`
- 扩展状态：`$DSH_HOME/plugin-ecosystem/fish-world/.state.json`
- 表情收藏：`$DSH_HOME/fish-world/stickers/`
- 工作区资料：当前 DSH 工作目录下的 `鱼的世界/`
- 空间互动状态/额度：当前工作区 `鱼的世界/安全与审计/qzone-actions.json`

不设置 `DSH_HOME` 时，默认根目录是 Node.js 报告的用户主目录下 `.dsh`。
NapCat / OneBot 有访问令牌时，通过 `DSH_ONEBOT_ACCESS_TOKEN` 环境变量提供；令牌不会写入桥配置、鱼世界状态、工具返回值或日志。无令牌的本机 OneBot 可继续使用默认配置。

## 开发与验证

```sh
npm test
npm run check
# 检查 desktop profile 是否真的把插件当作 bundle 加载，并列出缺失的前置插件与逐项安装命令
npm run doctor -- --home=<DSH_HOME> --profile=desktop
# 已启动 DSH 时，再探测页面注入、设置页和市场接口
npm run doctor -- --home=<DSH_HOME> --probe=<dsh web 输出的 URL>
```

`npm run doctor` 在接线之外还会做一次依赖自检：全部装齐时输出 `✔ 依赖环境就绪` 并以 0 退出，缺项时逐条打印安装命令并以 1 退出，便于脚本和排查共用同一份判断。

离线测试使用临时目录和模拟服务，不会访问真实 QQ 或用户工作区。真实 DSH 验证仍需在目标 DSH 版本中检查插件列表、设置页、鲸鱼徽标和 QQ 桥接。

## 故障排查

**设置里看不到「鱼的世界」，或主界面没有面板。** DSH 在包操作后会按 `dsh.profile.bundles` 重写 profile `package.json`；如果 bundle 条目丢失，`client.js` 仍会加载，但服务端路由和工具都不会注册。先完整退出 DSH，再运行：

```sh
npm run doctor -- --home=<DSH_HOME> --profile=desktop --fix
```

修复后重开 DSH。安装器本身是幂等的，重复运行不会覆盖已有配置。

**启动时提示 `desktop welcome: Web authentication failed`。** 桌面端每次启动都会向 Chromium 写入一条 `127.0.0.1` 的 `dsh-auth-*` Cookie；累积过多后，桌面壳无法再认证自己的本地 host。只清理回环地址的 Cookie，不会动 DeepSeek 账号数据：

```sh
npm run repair:auth
```

安装器在写入 profile 后会自动执行一次该清理。若 DSH 仍在运行，Cookie 库会被锁定，需先完整退出。

**面板顶部提示「运行环境需要处理」。** 说明前置插件没装齐，或插件接线异常。提示条会列出缺失的包和可直接执行的安装命令；装好后完整退出并重开 DSH，再点「重新检查」确认变为「已就绪」。接线异常时用下面的 `doctor --fix` 修复。

**扩展装好了但没有出现。** 安装后默认保持禁用，需要在「已安装」里手动启用；启用后仍受宿主权限和扩展清单约束。

## 支持边界

本插件使用 DSH 的公开插件、工具、系统提示词、web server 和客户端 slots 接口。QQ Agent 扩展以独立扩展形式运行；不支持任意进程执行、原始 OneBot socket 或自动执行未审核的市场代码。插件兼容性问题请附上 DSH 版本、操作系统、脱敏后的 profile bundle 清单和启动日志。
