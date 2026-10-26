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

**④ 能在面板上操作的，就必须能在面板上看见、点到。**
任何功能（选后端、填 key、开关、重建、清除）都要有面板控件，并且把当前状态和配置问题直接显示在卡片上。
不许只能靠手改 json 或直接调接口才用得上；做不到面板化的功能，先说明缺口，不要悄悄只留后端入口。

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

### 2.1 参考外部插件时，只学机制、不搬边界

`插件参考/` 里那批 QQ Agent 插件是学习材料，不是要整包搬进来。取舍标准：

- **能搬**：纯本地机制（回话节奏、对话现场、表情的 `sub_type`）。
  搬的时候落在我们自己的层（收信层、`lib/qq.mjs`），**不改 DSH 宿主内核**。
- **不搬**：依赖宿主内核钩子的（`reply-pacing` 改的是它自己的 orchestrator，
  我们有完整的收信/投递控制权，不需要动宿主）。
- **不搬**：站外图库/抓取（`reply-meme` 抓 `aigengtu.com`）。与「链接只存 URL、
  不镜像不代抓」的既定边界冲突；我们用自己的图库 + 收藏额度。
- **不搬**：会另造一份记忆的（`live-context` 的 80 条已读框架）。语境由 DSH 侧
  与 `dsh-fish-memory` 负责，插件里再造一份必然打架。我们要的只是「开口前摆几句现场」，
  直接用 `qq.recent()` 已有的数据。
- **不搬**：需要协议端额外动作、而我们没验证过的（`msg-reaction` 的
  `set_msg_emoji_like`、`poke-hiss` 的拍一拍事件）。没端到端跑过就别声称支持。

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
- **浏览器端文件不能 `import()`**：`client.js`、`lib/panel.js`（兜底提示页）、
  `ui/panel.js` 依赖 `window`/`document`；在 Node 里报未定义是正常的，别当 bug 修。
- **`lib/panel.js` 只是兜底提示页，不是第二份 UI**：它只在 `ui/panel.js` 读不到时加载，
  只说明「缺了什么、怎么修」。不要再往里加功能——加功能请只加在 `ui/` 那份，
  两份并存已经造成过漂移（见 CHANGELOG「兜底面板降级」）。
- **顶层可执行脚本不要 import**：`scripts/install-desktop.mjs`、`scripts/doctor.mjs`、
  `scripts/preview-ui.mjs` 一被导入就执行（会写 profile）。曾经误 import 导致重装了真实环境。

### 3.1 回话节奏（攒批）的四条不变式

`lib/qq-inbox.mjs` 的攒批不是「加个定时器」那么简单，改之前先看懂这四条，
少一条就会退化成「丢消息」或「还是刷屏」：

1. **桶按会话分，不按人分**。按人分会出现「甲一句、乙一句 → 两个桶 → 两轮回答」，
   正是要修的毛病。同一会话一批只投一次，并且**只回最后说话的人**。
2. **游标只推进到「连续的已处理前缀」**。桶里还等着的消息不能先越过游标，
   否则这时重启/崩溃就把还没投出去的话弄丢了。已投出的、旁听过的才算处理过。
3. **投递失败不丢，但重试有上限**。失败时桶保留、游标不动；连续 3 次失败才放弃，
   并在本地留存写一条 `lost` + `lastError`——**放弃也要留痕**，不许静默丢。
4. **安静窗口按「我们观察到的时间」算**（`now()`），不按消息自带的 `at`。
   协议端时钟可能比本机快或慢，混用会让窗口要么立刻到期、要么永远不到期。

配套：按消息 key 去重（有 `id` 用 `id`，没有就用「时间+谁+内容」凑），
重读同一条不重复留档、不重复回话；`flushAll()` 是「主人想现在就回」的出口。

### 3.2 「从 0 开始的游标」是一类 bug，不是两处

任何「读上游增量」的地方，游标初值为 0/空 就等于**把上游攒着的历史当成刚发生**。
已踩过两次：

- 收消息：首次碰到某个目标只推游标、不回历史（否则一开功能对着旧账刷屏）。
- 通知事件：桥的队列会攒重启前的事（最多 200 条），首轮只对齐时间、一条都不处理。

新写这类逻辑时：**第一轮只对齐，第二轮才开始处理**，并写一条对应的测试
（构造「队列里已有历史」的场景）。同时注意处理要在轮询锁内、并且 `await`——
放在锁外不 await，两轮会用同一个旧游标把同一批数据重复跑一遍。

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

### 6.1 测试是交付的一部分，不是配菜

- **没跑过测试的改动不算完成**，不许说「基本做完」「应该没问题」。跑完把
  `tests/pass/fail` 三个数写出来；解析不到摘要就说明解析失败，不能当成通过。
- **语义变了，测试必须同批改**。例：收信从「逐条投递」改成「攒批投递」，
  `delivered: 1` 的含义就从「投了一条」变成「投了一批」，这时改断言是**对的**；
  但必须在提交信息与 CHANGELOG 里写清「这条语义变了」，不能悄悄改测试让它变绿。
- **不许为了让测试通过而关掉被测特性**。真要测旧行为，就显式写
  `batchEnabled: false` 单独测那条回落路径，而不是把默认值改回去。
- 依赖时间的逻辑必须能注入时钟（`now = () => Date.now()`），测试里拨表，
  不许 `setTimeout` 真等，也不许靠「碰巧现在的机器很快」。
- 新增行为要有对应断言。**只写实现不写测试的新功能，按未完成处理。**

### 6.2 「报告成功」不等于「真的做了」—— 以被操作方返回的数为准

两处真实翻车，模式是同一个：**返回值来自前置检查，而不是操作本身的结果**。

- `repair-desktop-auth.mjs` 的 `removed` 取自删除前的 `count(*)`，而删除用
  `db.exec('delete … where host_key in (?,?,?,?)')`。**`db.exec()` 不支持参数绑定**，
  未绑定的 `?` 按 NULL 比较、条件永假 → 删了 0 行，却报「已清理 71 条」。
  跑两轮「修复」都没治好，最后靠直接删才恢复。
  → 写操作一律用 `prepare(…).run(…)`，返回的条数取 `changes`，不要拿 count 顶替。
- 判「协议端在不在跑」原来只看 `loginInfo` 有没有应答。协议端起来后要登录、
  拿 token 才开始应答，这期间应答失败 → 以为没在跑 → 又拉一个，
  每次启动 DSH 就多一个窗口。
  → 「进程在不在」和「它能不能干活」是两个问题，**必须用两个不同判据**
  （前者探端口，后者问应答）。

自查一句：这个数字是我**做完事之后**问出来的，还是**动手之前**猜出来的？

### 6.3 测试不许依赖本机状态

`probePort` 这类会碰真实网络/端口/文件的判断，测试里**必须注入替身**。
本机 3000 平时是通的：不注入 `probe` 的话，同一份测试在「协议端开着」和「没开」
两种机器状态下结果不同——那不是测试，是碰运气。

同理：`Date.now()` 要能换成假时钟（见攒批的 `now`），
`process.env` 里可能被会话预先设好的键（如 `DSH_PROFILE`）要先摘掉再断言。

### 6.4 面板字段三处同步（漏一处就静默失效）

新增/改名一个平台配置项，必须同时改：

1. `lib/platforms.mjs` 的 `PLATFORMS.<id>.defaults`（默认值）；
2. 同文件的 `NUMERIC_RULES`（数值范围）或 `BOOLEAN_KEYS`（布尔白名单）——
   漏了会被归一化直接丢掉，存了也不生效；
3. `ui/panel.js` 的 `PLATFORM_FIELDS.<id>`（面板控件）；
4. `tests/` 里对归一化的断言。

`scripts/preview-ui.mjs` 的假数据要 **import 真实默认值**（如 `PLATFORMS`），
不要手抄一份会漂移的配置。

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

## 8.1 改动与发布的约定（2026-10-25）

多会话/多人同时改这个仓库时，靠下面几条避免「改了什么、哪版、怎么回滚」说不清。

1. **一处记录**：改动只记 `CHANGELOG.md` 的「未发布」段，不再另开 `CHANGES-*.md`。
   同一件事写两处，迟早对不上。
2. **版本三处同步**：`package.json`、`lib/version.mjs`、桥插件的 `metadata.yaml`；
   未发布期间保持同一版本号，发版时一起升。
3. **改前备份**：`<文件>.bak-YYYYMMDD-HHMMSS`，确认没问题再删。
4. **改完必跑**：`npm test`、`npm run check`（见第 6 节）。只跑 `node --check` 不算验证。
5. **打包命名**：`dsh-fish-world-<版本>-<日期>.zip`，不覆盖同名文件；旧包要么删、要么留档。
6. **数据不进包**：图库、人设、知识库、记忆都在 `$DSH_HOME` 或工作区，包里只有代码。
7. **一次一个主题**：不顺手重构无关代码；要重构另开一轮并单独记 CHANGELOG。

## 9. 已知的上游/环境限制（不是本项目 bug）

- 实时合并转发的聊天记录会被 `dsh-qq-bridge` 丢弃；鱼靠 `history`/`forward` 回查。
  要实时得改 bridge。插件侧的做法是：收到带 `forward` 段的消息时自己 `qq.forward(id)` 摊开原文（`docs` 见 CHANGELOG）。
- **我们跑的是 SnowLuma**：对外文案（面板、工具返回、README）一律写 SnowLuma / 协议端，不写 NapCat。
  `qq-bridge-config.json` 里的 `NapCat` 只是桥的字段名（地址），代码里读它、文案里别露出来——改字段名会把桥弄断。
  接口名有出入的地方实测过两处：
  群公告是 `_get_group_notice`（标准名 `get_group_notice` 回 `retcode 1404 UNKNOWN_ACTION`）；
  OneBot HTTP 在 **3000**、WS 在 3001、WebUI 在 5099、事件接收在 3002。调不到接口先看是不是名字或端口不对。
- **SnowLuma 会「正常退出」**：日志停在半句、无崩溃栈、事件日志无报告。源码里三条路径都不进文件日志：
  `bot_exit` 动作直接 `process.exit(0)`；**自更新**用新根目录再起一个自己（`[Update]` 只到 stderr，子进程退出码非 75 则父进程退出）；
  被 `launcher.bat` 拉起时关掉控制台 → `disconnect` → `shutdown('launcher disconnected')`。
  要定性只能记退出码：`D:\deepseek-qq\snowluma\supervise.mjs`（`--restart` 当看门狗、`--test` 自检）把退出码/信号/存活时长写 `exit-log.txt`。
- 官方 AstrBot 市场：`publish_enabled=true`、`zip_upload_enabled=false`（只能走 GitHub 仓库）、
  需要 hCaptcha、**24 小时最多 3 次提交**。hCaptcha 走代理常失败。
- 本机代理（如 `127.0.0.1:7897`）：`Invoke-WebRequest` 走系统代理能通，
  **git 不读系统代理**会超时；pnpm 解析 `github:` 用的是 git，需要
  `$env:HTTPS_PROXY` 才通。这是环境配置，别改代码去绕。
- DSH 会清理会话目录：`qq-bridge-config.json` 里的「目标会话」可能某天失效，
  表现为世界绑定失败、日记/请求/成长全空。面板目前**没有**改主人会话的入口，
  只能改该 json（改善项见第 10 节）。

## 10. 待办 / 可改进

- ~~面板加「主人会话」选择器（列 DSH 现有会话），避免第 9 节那个手工改 json。~~
  已做（2026-10-26）：在「鱼的设定 → 主人」，见 `world.setOwner()` 与 `ui/panel.js` 的 `ownerSessionPicker()`。
- 桥插件未在真实 AstrBot 上端到端跑过：`bot.call_action` 返回结构、
  `FuncTool.call(ctx, **kwargs)` 签名只做过源码级核实与替身测试。
- `lib/qq-inbox.mjs`（QQ 收件箱）仍在开发中，没有对应测试，不要对外描述为已完成。
  注意 `lib/index.js` 已经 import 它，**提交时别只提 index.js 漏掉它**（会让远程断链）。
- 左侧导航仍叫「鱼的状态」，里面是头像卡 + 「鱼的心情」+ 挂饰开关。
  若要改名，需一并改 `NAV`、`viewOverview*` 的 `title`/`navigate('status')` 与 README。
- 官方市场上架未完成（卡在 GitHub App 授权 + hCaptcha + 额度）。
- 视频抽帧（`lib/video.mjs`）与合并转发展开只跑过单测 + 合成片，**没在真 QQ 上端到端验过**；要验就发一条真视频/真聊天记录卡片再看投递文本。
- **协议端守护**（`lib/protocol-supervisor.mjs`）：**只在宿主启动时**探一次 `get_login_info`，没在跑就拉起（detached），8 秒后确认一次。**不要周期轮询、不要开机自启**（都是主人 2026-10-25 的明确要求）。目录靠 `SNOWLUMA_DIR` / `D:\deepseek-qq\snowluma` 自动找。
- **QQ Agent 借手通道只有一半**：DSH 侧（`lib/qqagent.mjs` + 两个动作 + 面板卡）已测；**QQ-agent 侧的配套插件 `companions/qqagent-plugin` 没跑过**（本机没装 QQ-agent），`registerTools()` 的宿主 API 要按它实际版本补。验收：装好后 `/tools` 能列出真插件工具，再从鱼那边 `qqagent-tools` 看到同一张表。
- 「表情回应（贴一下）」还没做：需要 `set_msg_emoji_like`，按本文件 §2.1 的标准，没端到端跑过不许声称支持。
- 图库目录里有 104 个多余文件（45.4MB，其中 100 个与在用文件字节完全相同，是重命名留下的旧副本），没删——删主人图库要他点头。
- 知识库向量档的模型缓存（`$DSH_HOME/fish-world-models`，23MB）与运行库（插件 `node_modules/@huggingface/transformers`）都不进仓库；换机器要重下。
