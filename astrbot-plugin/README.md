# 鱼世界桥（astrbot_plugin_fish_world_bridge）

让 [DSH](https://github.com/deepseek-ai) 里的「鱼的世界」把 AstrBot 当作 QQ 通道，
并能借用 AstrBot 的 Agent 能力。

## 它做什么

装在你的 AstrBot 里，起一个只监听 `127.0.0.1:6210` 的 HTTP 服务，
把鱼世界发来的 OneBot 请求转给 AstrBot 的 aiocqhttp 适配器。

用 `bot.call_action()` 转发，属于**全量透传**，所以：

| 鱼世界要的能力 | 是否支持 |
|---|---|
| 发私聊 / 群消息 | ✅ |
| 群历史、好友历史 | ✅ |
| 展开合并转发 | ✅ |
| 戳一戳 | ✅ |
| `get_cookies`（QQ 空间登录态） | ✅ |

> 这也是它比「直接调 AstrBot OpenAPI」更好的原因：OpenAPI 只覆盖发消息，
> 群历史、合并转发、戳一戳、空间 cookies 全都没有。

## 安装

1. 在 AstrBot 的插件市场搜索「鱼世界桥」安装；
   或把本目录打包成 zip，从「插件 → 安装 → 上传」装进来。
2. 重载插件。

## 配置

首次启动会自动生成一个 `fw_` 开头的 token 并写进插件配置。去 AstrBot 的
「插件 → 鱼世界桥 → 配置」里复制它。

然后在 DSH 的**鱼的世界 → AstrBot 接入**里：

1. 桥地址填 `http://127.0.0.1:6210`
2. 粘贴 token
3. 点「测试连通」——显示登录号就说明通了
4. 打开「把 AstrBot 当作 QQ 通道」

## 安全

- 只监听 `127.0.0.1`，不对外网开放。
- 每个请求都要 `Authorization: Bearer <token>`，用常量时间比较。
- AstrBot 的登录态不离开它自己的进程：鱼世界只发 OneBot 动作，拿不到账号密码。
- 没有 token 时**不启动**服务，宁可不可用也不裸奔。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 连通性与登录号 |
| POST | `/onebot` | 转发 `{action, params}` 到 `bot.call_action` |
| GET | `/events?since=N` | 取游标之后的新消息 |
| GET | `/tools` | 列出可借用的插件工具（只读） |
| POST | `/agent` | 借用 AstrBot 的模型生成一段文本 |

## 已知边界

- **消息队列在内存里**：AstrBot 重启后游标归零，不会补发历史消息。这是有意的——
  刚接上不该把一屋子旧消息全灌给鱼。
- **`/agent` 不执行工具**：只调 `llm_generate`。让它顺手执行别的插件风险太大，
  需要时再单独设计权限开关。
- **只支持 aiocqhttp**：QQ 官方机器人、Telegram 等适配器没有 `call_action`，不在支持范围。
