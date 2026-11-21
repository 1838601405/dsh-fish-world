# 鱼的世界新版（桌面/插件双端 app）· 扩展接入

> 这个目录是**接入说明**，不是产物本体。app 的构建产物走 GitHub Releases，不进 git。

## 它是什么

「鱼的世界新版」（别名「大肥鱼」）是**独立的 Flutter 程序**，不是本插件的模块，
也不是 DSH 面板的一部分。它和本插件的关系只有一层：**读同一份数据**。

| 端 | 产物 | 数据来源 |
|---|---|---|
| **插件版**（web） | `ui/fishworld/`（本仓，`flutter build web`） | 走 DSH 的 `/dsh-fish-world/*` 路由 |
| **桌面版**（Windows） | `FishWorld.exe` + `data/`（**Release 附件**） | 直接读 `%APPDATA%\大肥鱼` 和本地 JSON |

两份产物**同一套源码、两次构建**，差异只在「窗口外壳 / 数据落点 / 协议端」。

## 为什么产物不进 git

两边各约 29MB（web 57 个文件 / Windows 24 个文件），而且是**可再生的构建产物**：
进版本库会让每次小改动都塞一个 58MB 的 blob，仓库很快没法用。

所以：
- **源码**在 app 仓（`E:\WhaleGirl`，含 `flutter/`）
- **产物**走 GitHub Releases，按 tag 归档
- **本目录**只放：怎么装、怎么验、版本记录

## 怎么装桌面版

1. 从 Releases 下 `鱼的世界新版-<版本>-便携版.zip`
2. 解压到任意目录（便携版，不写注册表）
3. 双击 `FishWorld.exe`
4. 首次打开会读 `%APPDATA%\大肥鱼\` —— 如果本插件装好了，数据已经在那儿

## 怎么用插件版

插件版就是本仓的 `ui/fishworld/`，随插件一起发布，**不需要单独装**。
DSH 面板里打开「鱼的世界」即是。

## 两端差异（唯一允许的差异）

| 项 | 桌面版 | 插件版 |
|---|---|---|
| 窗口外壳 | 原生 Win32 窗口 | Flutter web + CanvasKit（本地 `canvaskit/`） |
| 数据落点 | 直接读本机文件 | 走 `/dsh-fish-world/*` HTTP 路由 |
| 上传类输入（头像等） | 本地文件路径 | base64 |
| 协议端 | 同一个 QQ 桥 | 同一个 QQ 桥 |

**除这三处之外必须行为一致。** 判据：`node tools/deploy-check.mjs` 会同时查两边
（HEAD 落后 / 构建时间 / sha256 / 两边时间差）。

## 验收

```bash
# 插件仓根目录
node tools/deploy-check.mjs
```

期望输出含：

```
OK   [web] .../ui/fishworld           built ... sha256 ...
OK   [sync] 两版构建时间差 0 分钟（同一次交付）
OK   [deps] 插件依赖闭包（N 个模块）
```

## 版本对应

桌面版产物版本必须和本插件 tag 对齐。查当前对应关系：

```bash
cd E:/dsh_fish_world && git describe --tags --abbrev=0
```

`release-manifest.json` 里记着每次发布的文件数与 sha。

## 未验证

- 桌面版在**没有装插件**的机器上能否启动（它的降级路径没测过）
- 便携版解压到中文路径外的目录（如 `D:\Program Files\`）时的权限行为
