# UI 工程约束

## 风格定位

深色极简（Dark Minimalism）+ 便当盒网格 + 控制台结构。参考 Linear / Vercel / GitHub 的暗色模式标准。

- **深灰而非纯黑**：画布 `#18181b`，卡片 `#1f1f23`，靠色阶差划分层级，不用纯黑压暗。
- **无装饰**：没有装饰性渐变、发光、彩色阴影。层级只来自背景色阶、发丝边框和留白。
- **结构**：左侧固定侧边栏（毛玻璃）+ 右侧 12 列便当盒网格。
- **圆角收敛**：通用表面只有 `--radius-sm: 8px` / `--radius-md: 12px` 两级。
  例外是 `--radius-pill`，只允许用于「药丸形物理控件」——开关与进度条；扩散到卡片或按钮即视为违规，`scripts/check-ui.mjs` 会拦下。

## 硬性规则

- 视觉颜色、间距、圆角、阴影使用语义 token；没有对应 token 时先扩展主题 schema/default/resolution，不用近似 token 代替。
- 错误色统一用 `--feedback-error`；`--text-feedback-error` 只作别名，组件层不得直接使用。
- 禁止位移 hover、渐变文字、彩色光晕和高对比渐变块。
- hover 只做一级背景亮度变化，不得同时改颜色、边框、阴影。
- 卡片是信息容器而不是可点击控件：默认不响应 hover，只有 `[data-interactive="true"]` 才给反馈，避免整片网格随鼠标闪动。
- 焦点环必须带 offset（`--ring-focus` 先垫一圈画布色），不贴边。

## 可读性下限

- 深色正文 ≥ 4.5:1 对比度；正文字号 ≥ 13px，辅助信息 ≥ 12px；正文行高 ≥ 1.5。
- 第三级文字（`--text-tertiary`）是最容易踩线的位置：深色下不要低于 `#8b8b95`。
- 点击热区 ≥ 32×32px。
- 大标题白色加粗，辅助说明小一号灰色，数据指标放大加粗——层级靠字重、字号与留白，不靠彩色。

## 组件约定

- **开关**：iOS / macOS 药丸形，36×20，关闭深灰+灰滑块，开启低饱和绿（`--accent-subtle`）+ 浅色滑块。强调色只用于「已开启」状态，不做品牌装饰。
- **进度条**：纯净圆角灰底 + 单色条 + 右侧纯文本数值，不用渐变、不加发光。
- **侧栏选中态**：只用略微提亮的灰块（`--bg-surface-selected`），不用品牌色。
- **毛玻璃**：只用于左侧栏与浮层，`blur(12px) saturate(1.1)`（saturate ≤ 1.2）；背后不得有鲜艳渐变或彩色光球。
- **浮层提示（Tooltip）**：唯一允许的中性深色反色毛玻璃，用 `--bg-tooltip` / `--text-tooltip`，不得引入彩色。

## 便当盒与卡片层级

12 列网格（`repeat(12, minmax(0, 1fr))`），卡片按重要性分配跨度，**不允许所有卡片一样大**：

| 层级 | 跨度 | 用途 |
|---|---|---|
| 主数据卡 | `span 6` | 运行状态、鱼的状态 |
| 次级卡 | `span 4` | 日记、请求、成长、设置 |
| 紧凑卡 | `span 3` | 平台、收藏、AstrBot 接入 |
| 通栏 | `span 12` | 模式切换条 |

- 同一行卡片默认高度对齐（`align-items: stretch`，卡片本身 `display:flex; flex-direction:column`）。
  **例外**：内容长短差很多的几列用 `card({ naturalHeight: true })`，让它按内容收缩，不强行拉伸成空壳（见「鱼的设定」三张卡）。
- 卡片**不设 `min-height`**：高度一律跟随内容，矮卡不许被撑成空壳。
- 卡片内边距统一 `16px`（`--space-4`），跨度不同也不改；卡片间距同为 `--space-4`。
- 卡片标题 `16px` 加粗，辅助文字 `13px` 常规。
- **卡片内按钮必须沉底**：`body` 用 `flex:1`，操作区 `margin-top: auto`，保证同行卡片按钮对齐。

## 按钮：只准幽灵样式

- 卡片内按钮**禁止纯白底**。默认 `background: transparent` + `1px var(--border-subtle)` 边框 + `var(--text-secondary)` 文字（类名 `fw-btn-ghost`）。
- **主操作只有一对**：「保存信息」「保存角色」用 `--text-primary` 反色填充（类名 `fw-btn-primary`，hover `--btn-primary-hover`）；其余保存/提交一律降为幽灵，避免一屏三四个实心按钮。
- 卡片行内的次要操作（换图 / 置顶 / 删除）用**无边框纯文字幽灵**：`.fw-role-actions .fw-btn { border-color: transparent }`，hover 仍只改背景。
- hover 只改背景到 `--bg-surface-hover`，不同时改边框或文字色。
- 顶部的模式切换用**文本 tabs**：仅靠底部 2px 下划线区分选中，不用方块按钮。

## 状态表达：灰阶圆点

- 状态文字一律用灰阶 token（`--text-secondary` / `--text-primary`），不用大色块。
- 需要区分状态时用 **4px 圆点** + 文字：`ok` 用语义 token `--status-success` 并叠 `--status-success-glow`（4px / 40% 外发光，深色下才看得清），`warn` / `error` 用 feedback 色，但圆点之外不铺色。
  `check-ui.mjs` 的「禁彩色光晕」对这两个 token 例外——和 `--ring-focus`（蓝色焦点环）同例：约束的是「不许随手写裸色值」，不是「不许有 token 化的语义色」。
- 总览等摘要区域**不用彩色 emoji**。

## 列表：靠留白分层

- 摘要列表项取消多余边框与底纹，仅用 `padding` 与行距区分。
- 每行严格两端对齐：左侧标题、右侧数值或状态。

## 拖拽重排

面板是原生 DOM（无 React），所以**没有引入 dnd-kit / react-grid-layout**，改用 CSS Grid + DOM 顺序交换 + FLIP：

- **抓手隔离**：只有卡片头部的 `⠿` 能发起拖拽（`pointerdown` 只认 `.fw-grip`）。卡片正文保持 `user-select: text`，文字可正常选中、按钮可正常点击。
- **平滑让位**：用 FLIP（记录旧位置 → 改 DOM → 反向 `transform` 补偿 → 下一帧归零），时长 160ms `ease-out`。禁止重叠或跳跃。
- **占位符**：拖起后原地只留 `1px dashed var(--border-strong)`，无背景、无发光。
- **瞬间吸附**：松手时清掉过渡直接落位，不用弹簧或惯性。
- **键盘重排**：抓手可 Tab 聚焦，`Alt + 方向键` 交换位置；焦点环带 `outline-offset: 2px`。
- **顺序持久化**：按分区分别写入 `dshcp.cardOrder.<分区>`，刷新后保持；无 key 的卡片（如模式切换条）固定在首位，不参与排序。
- **钉在末尾的卡**：`card({ pinLast: true })`（如「关于」）。恢复存档、拖拽落盘、键盘重排三条路径都会把它排到最后，
  并且**不渲染抓手**（能给抓手却拖不走等于骗人一次）。只改源码顺序不够——旧存档会把它塞回中间。
- 设置页内嵌模式（`__DSH_FISH_WORLD_SETTINGS_MODE__`）不启用拖拽。

## 极端状态

- **超长标题**：`white-space: nowrap` + `text-overflow: ellipsis`，并带 `title` 属性；绝不换行撑高卡片。
- **空状态**：统一灰阶文字「暂无数据」，不用笑脸或彩色插画。
- **数值溢出**：进度条 `>100%` 时填满并转 `--feedback-error`，数值仍显示真实百分比并保留一位小数（如 `128.0`）。

## 图表

当前面板没有引入图表库；若将来加：
- 隐藏网格线与图表边框，坐标轴用 `--border-subtle`
- 折线下方填充一律用主线条色、透明度 < 5%，禁止鲜艳渐变
- 图表 `width: 100%` 随卡片自适应，不允许溢出或变形

## 不改动约束

- 不改现有 `id`、`class` 或语义；视觉调整通过独立覆盖层实现，便于单独回滚。
- 组件探针必须渲染真实生产组件，以计算样式断言状态；变更后检查窄窗口截图、空态/加载/错误状态和对比度。

## 自检

```sh
npm run check   # 含 scripts/check-ui.mjs：token 语义化、零位移、圆角、字号、对比度、毛玻璃范围、hover 单轨
npm run preview:ui   # 起本地预览，检查真实渲染
```
