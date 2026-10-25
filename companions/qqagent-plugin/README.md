# fishworld-borrow（QQ-agent 侧配套插件）

把 QQ-agent 里的插件工具交给 DSH 里的鱼用 —— **只借手，不借嘴**：
工具执行在 QQ-agent，理解与说话仍在 DSH 那侧的同一条鱼。

## 契约

| 路由 | 说明 |
|---|---|
| `GET /health` | 免鉴权，回 `{ ok:true, version, tools }` |
| `GET /tools` | 需 `Authorization: Bearer <token>`，回 `{ ok:true, tools:[{name,description}] }` |
| `POST /tool` | 需同上，body `{ name, params }`，回 `{ ok:true, output }` 或 `{ ok:false, error }` |

默认监听 `127.0.0.1:3211`（可用 `FISHWORLD_BRIDGE_PORT` 改），token 由
`FISHWORLD_BRIDGE_TOKEN` 给（没给就拒绝启动，不留无鉴权端口）。

## 状态

- **HTTP 这一半**照 DSH 侧已测过的契约写（`tests/qqagent.test.mjs` 用假桥验过同一套形状）。
- **宿主这一半未验证**：本机没装 QQ-agent，`registerTools()` 里怎么取它的工具表要按
  QQ-agent 实际版本的插件 API 补。装好后先用 `/tools` 看列表对不对，再从鱼那边
  `fish_world(action="qqagent-tools")` 验一次。

## 为什么需要它

QQ-agent 和 DSH 是两个宿主，插件加载器互不相认；共用同一个 SnowLuma 只代表
连着同一个 QQ 号，**不代表插件能互通**。这条 HTTP 通道就是那根额外的线。
