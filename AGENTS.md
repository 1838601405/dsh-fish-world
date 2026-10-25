# dsh-fish-world 维护规则

给后续改动的贡献者（含 AI）立的规矩。每条都是这里真实踩过或查证过的，不是通用套话。
UI 细节规则另见 [`ui/AGENTS.md`](ui/AGENTS.md)。

---

## 0. 三条不可让步的底线

**① 鱼必须始终是同一条鱼。**
外部能力（AstrBot 工具、QQ 桥、任何插件）只能当「手」，不能当「嘴」。
AstrBot 侧只提供 `/tool`（执行一个工具、返回原始结果），**永远不要加 `/agent`** 这种
「让外部模型生成回复」的接口。鱼的模型、人设、记忆、语气全部留在 DSH 侧。
工具结果必须标注来源（`[通过 AstrBot 的 xxx 得到]`），不能让鱼误当成自己的观察。

**② 默认拒绝，默认关闭。**
所有外部写入（QQ 发消息、B 站评论点赞、抖音分享、空间发帖）默认关闭，且需要逐项打开。
权限：主人全权；信任者只能聊天、有限影响状态、提交待审核日记；其他人禁止读写私人数据。
越界默认拒绝，不要"看起来能用"。

**③ 出问题时说实话。**
查不到版本就显示「查不到」，不编版本号；缺依赖就报缺哪个；没装挂件就写「当前窗口没有这个挂件」。
不允许用默认值掩盖失败，也不允许静默丢弃数据。

---

## 1. 改动前：先读，再动

- 改任何函数前先 `grep` 它的**所有调用点**。本项目最贵的错误就是删掉 `lib/voice.mjs`
  却漏了 `lib/index.js` 里还在 `voice.view()`——语法检查全过，一运行就崩。
- **删除一个模块要一次删干净**：模块文件、构造与 import、路由注册表项、`buildRoutes` 形参、
  配置默认块与归一化、面板视图与 state 字段、预览 mock、`scripts/check.mjs` 清单、
  README / CHANGELOG / `ui/AGENTS.md` 措辞、`.gitignore`。用第 6 节的扫描命令确认归零。
- **删配置或路径字段前先确认它有没有被复用**。例：`world.mjs` 的 `paths.mood` 看着是心情状态
  的死数据，实际被旧数据迁移 `migrateLegacyDirectory(..., paths.mood, ...)` 用着——删了
  迁移会静默失效。
- **不凭包名猜用途**。`dsh-mnemon` 是通用上下文框架（keywords 全是 `agent-memory`、
  `project-memory`），和鱼无关；鱼的记忆是 `dsh-fish-memory`（「蓝鲸娘 / 大肥鱼」那条鱼）。
  曾经把 mnemon 当鱼的记忆，导致依赖装错、体检误报。

## 2. 优先复用，不要自己写

- **有上游数据就用上游的**。心情维度不再自己维护 `PSY_KEYS` 列表——`/dsh-feiyu-mood/state`
  已经返回 `dims: [{key,label,value}]`，直接渲染。自己抄一份必然和上游漂移。
- **阈值/档位对齐上游**。`portrait.mjs` 的 `bandOf` 用 80/62/42/25，与上游
  `moodLabel`/`moodEmoji` 完全一致；曾经是 80/65/45/30，挂饰说「开心」而头像显示「一般」。
- **读依赖插件的配置/状态时直接读它的文件与路由**（`qq-bridge-config.json`、
  `/dsh-feiyu-mood/state`、`/dsh-tts-bridge/status`），不要另造一份镜像配置。
- 新工具优先复用 `fish_world` 的 action 分发（`lib/tool.mjs` 的 `ACTIONS`），
  而不是注册新工具名把模型的工具列表撑爆。

## 3. 接口契约（最容易改坏的地方）

- **返回体形状必须唯一**。`rotateToken()` 不返回明文；要明文只有 `rotateTokenWithSecret()`。
  以前两者混在一个函数里，改一次就撞测试。任何"有时带、有时不带"的字段都按这个拆。
- **视图函数（`view*`）只返回卡片数组**，统一由 `render()` 交给 `relayout()` 排布。
  不要在视图里写布局或 `document` 操作。
- **路由结构固定**：`{ kind: 'exact', path, handler(req, res) }`，由
  `buildRoutes()` 返回数组、`index.js` 注册。新增路由**必须同时**：定义 const、加进末尾
  `return [...]`、在 `index.js` 的 `buildRoutes({...})` 形参里传依赖。
- **QQ 通道只走 `createQQ` 里的 `call()` 一处**。换 transport（bridge ↔ AstrBot）
  只改 `transportMode()` 的分支，上层 `send/recent/forward/poke/loginInfo` 一行都不用动，
  因为返回结构都是 OneBot 11 的 `{status, retcode, data, message}`。
- **DSH 宿主服务必须显式声明**：`inject = ['tools','webServer','agents','sessions','workspaceRegistry']`。
  漏了拿不到服务，世界绑定会**永久失败**（日记/请求/成长全废）。所以启动时还有每 4 秒、
  最多 30 次的重试兜底。
- **浏览器端文件不能 `import()`**：`client.js`、`lib/panel.js`、`lib/mood-badge.js`、
  `ui/panel.js` 依赖 `window`/`document`；在 Node 里报未定义是正常的，别当 bug 修。
- **顶层可执行脚本不要 import**：`scripts/install-desktop.mjs`、`scripts/doctor.mjs`、
  `scripts/preview-ui.mjs` 一被导入就执行（会写 profile）。曾经误 import 导致重装了真实环境。

## 4. 存储与目录

- 所有落盘路径集中在 `lib/paths.mjs`；工作区目录结构集中在 `lib/storage.mjs`
  （`ROOT_FOLDER`/`COLLECTION_FOLDER`/…）。**不要在别处拼路径。**
- 目录名用中文（Node 三平台都按 UTF-8 处理）；只有 ID 之类内部标识保持 ASCII。
- **默认不建目录**：`describe()` 只报告，`ensure()` 才写盘；面板只做只读检查。
  只有「第一次使用」或主人显式点「建立或修复」时才创建。
- **换目录 ≠ 搬家**。`ensure({ adopt: false })` 只建目录；`adopt: true` 会把旧位置历史数据
  复制过来——实测曾因默认 adopt，让主人换个位置就多塞进 100 个收藏文件。
  只有首次自动创建才该迁移。
- 改名要留兼容：`LEGACY_COLLECTION_FOLDER`（鱼的收藏 → 鱼之宝库）、
  `LEGACY_GALLERY_FOLDERS`/`LEGACY_SITES_FOLDERS`。改名失败就继续用旧目录，**绝不丢数据**；
  两个名字同时存在时不合并、不覆盖。
- **索引文件损坏要报出来**（JSON 解析失败 = 写入被中断）；不存在不算问题（全新环境本来就没有）。
- **敏感数据**：`fish-world-config.json`、`fish-world-astrbot.json`（token）、
  `fish-world-voice.json`、personas/moods/growth/links/fish-tank 全在 `.gitignore`。
  **新增任何落盘密钥或个人数据文件，必须同时加进 `.gitignore`**，并确认
  `git ls-files` 里没有它。

## 5. 依赖与发布

- **`dependencies` 里不能出现异源依赖**（`github:` / `git+` / `file:` / `link:`）。
  DSH 的 pnpm 开着 `blockExoticSubdeps`，异源子依赖会直接
  `ERR_PNPM_EXOTIC_SUBDEP`，插件装不上。5 个 GitHub 配套插件放在
  `peerDependencies` + `peerDependenciesMeta.optional: true`，由安装器/面板装到 profile 顶层。
  （`tests/package-metadata.test.mjs` 会拦住回归。）
- **`dsh-whale-widget` 永远是可选集成**，不得进 dependencies（自检会拦）。
- 装 AstrBot 通道时 `dsh-qq-bridge` 自动降为可选，体检不再误报缺失。
- 版本号有**三处**：`package.json`、`lib/version.mjs`、桥插件 `metadata.yaml`。
  前两处不一致 `npm run check` 就失败。
- 发布：AstrBot 官方市场要求插件在**独立仓库**且以 `astrbot_plugin_` 开头
  （本仓库的子目录不会被市场扫到）。桥插件在
  `github.com/1838601405/astrbot_plugin_fishworld_bridge`。
- 许可证 `GPL-3.0-only`；并入的 MIT 代码（`lib/core-plugins/read-animation/`）
  **必须原样保留其 LICENSE**，`THIRD-PARTY-NOTICES.md` 说明来源。
  「仅借鉴设计」的（`dsh-bili-humanism`、`dsh-douyin-agent`）也要列出，别把参考说成原创。

## 6. 验证（改完必跑）

```sh
npm test            # node --test tests/*.test.mjs
npm run check       # 文件齐全 + 模块可导入 + 版本号一致 + UI 规范
node scripts/preview-ui.mjs 55901   # 真实渲染，浏览器看布局/对比度/溢出
```

测试需要 sharp 时给环境变量，别改代码：

```powershell
$env:DSH_READ_ANIMATION_SHARP='<profile>\node_modules\sharp'
```

**结构性检查用命令，别靠肉眼**：

```powershell
# 删干净了没有
Select-String -Path lib\*,ui\*,scripts\*,tests\* -Pattern '被删符号名'
# 导出与调用是否对齐
node -e "import('./lib/xxx.mjs').then(m=>console.log(Object.keys(m)))"
# 语法（浏览器文件会报 window 未定义，正常）
node --check <file>
```

**浏览器实测看这些**：`undefined`/`NaN`/`[object Object]`、横向溢出（`scrollWidth >
clientWidth`）、卡片跨度是否填满一行（不留视觉真空）、开关是否**即时**生效（不等 2 秒兜底）、
12px 文字对比度 ≥4.5:1。

## 7. 安全

- 写操作路由一律 `isLoopback(req)`；入站推送（AstrBot → 鱼）**不能只信 loopback**，
  额外要求 Bearer token（本机可访问端口的进程很多）。
- token/密钥：单独落盘 + `chmod 0600`；读接口只返回 `hasToken` 与打码预览；
  不进主配置、不进日志、不进提示词；保存语义「空字符串=不改，`null`=清除」；
  失败只报状态码，不回显响应体；比较用 `hmac.compare_digest(bytes, bytes)`
  （`secrets.compare_digest` 遇非 ASCII 字符串会抛 TypeError）。
- 地址只允许 http(s)，非本机必须 https；拒绝 URL 里夹带账号密码。
- 鱼箱（`lib/sandbox.mjs`）：默认拒绝；拒绝绝对路径/盘符/UNC/`..`/空字节；
  先 `resolve` 再 `realpath` 比对（挡符号链接）；空路径不等于"鱼箱根目录"。
  只读操作也走同一套校验。**不允许鱼越过工作区执行任何命令**。
- 不可逆操作（解除安装）两步确认：先说明后果，再要求手打「解除」二字。
- 发给模型的文本必须裁剪长度，不要把整篇日记或原始响应贴出去。
- 市场只做「用户自行搜索 + 粘贴原始链接安装」：**不托管、不镜像、不代抓正文**；
  链接只存 URL/标题/标签/来源，拒绝本机、内网、`.local`/`.internal`、非 http 协议。

## 8. 提交流程

- **破坏性 git 操作前必须先验证备份存在**（`git bundle` 或复制目录）。
  这里犯过一次：备份命令语法错了却照样 `reset --hard`，本地文件一度只剩 `LICENSE`，
  靠 `git reflog` 才找回。
- 提交信息含中文/引号时用 `-F <文件>`，别在 PowerShell 里塞 `-m "多行"`（会被拆成 pathspec）。
- 写文件用 UTF-8 **无 BOM**。`Set-Content -Encoding UTF8` / `Out-File -Encoding utf8`
  在 Windows 上带 BOM，会弄坏 profile 的 `package.json` 让 DSH 起不来。
- 工作区里可能同时有**别人/别的会话的改动**。提交前 `git status` + `git diff` 看清范围，
  不确定就问，别一把 `git add -A` 把在制品打包进去。
- 提交前跑第 6 节验证；CHANGELOG 记对应的 0.x.0 段落。

## 9. 已知的上游/环境限制（不是本项目 bug）

- 实时合并转发的聊天记录会被 `dsh-qq-bridge` 丢弃；鱼靠 `history`/`forward` 回查。
  要实时得改 bridge。
- 官方 AstrBot 市场：`publish_enabled=true`、`zip_upload_enabled=false`（只能走 GitHub 仓库）、
  需要 hCaptcha、**24 小时最多 3 次提交**。hCaptcha 走代理常失败。
- 本机代理（如 `127.0.0.1:7897`）：`Invoke-WebRequest` 走系统代理能通，
  **git 不读系统代理**会超时；pnpm 解析 `github:` 用的是 git，需要
  `$env:HTTPS_PROXY` 才通。这是环境配置，别改代码去绕。
- DSH 会清理会话目录：`qq-bridge-config.json` 里的「目标会话」可能某天失效，
  表现为世界绑定失败、日记/请求/成长全空。面板目前**没有**改主人会话的入口，
  只能改该 json（改善项见第 10 节）。

## 10. 待办 / 可改进

- 面板加「主人会话」选择器（列 DSH 现有会话），避免第 9 节那个手工改 json。
- 桥插件未在真实 AstrBot 上端到端跑过：`bot.call_action` 返回结构、
  `FuncTool.call(ctx, **kwargs)` 签名只做过源码级核实与替身测试。
- `lib/qq-inbox.mjs`（QQ 收件箱）仍在开发中，没有对应测试，不要对外描述为已完成。
  注意 `lib/index.js` 已经 import 它，**提交时别只提 index.js 漏掉它**（会让远程断链）。
- 左侧导航仍叫「鱼的状态」，里面是头像卡 + 「鱼的心情」+ 挂饰开关。
  若要改名，需一并改 `NAV`、`viewOverview*` 的 `title`/`navigate('status')` 与 README。
- 官方市场上架未完成（卡在 GitHub App 授权 + hCaptcha + 额度）。
