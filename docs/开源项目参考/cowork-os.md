# CoWork OS

返回[开源项目参考](README.md)。本文是外部项目的参考记录，不是本项目的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [CoWork-OS/CoWork-OS](https://github.com/CoWork-OS/CoWork-OS) |
| 官网 | [coworkosapp.com](https://coworkosapp.com) |
| 文档 | [官方文档站](https://coworkosapp.com/docs/) |
| 定位 | 面向编码、知识工作、自动化与人机协作的本地优先、安全加固的个人 Agent 桌面操作系统与超级应用 |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `main` |
| 最新 Release | `v0.5.61`（2026-10-18） |
| Star / Fork | 514 / 93 |
| 未关闭 Issue | 17 |
| 分发形态 | macOS（.dmg/.zip）、Windows（安装器/便携包）与命令行 CLI（`cowork`）；Electron 桌面客户端随包携带运行时 |

以上数值核实于 **2026-10-27**，仅为快照，来源为官方发布清单与[公开统计数据](https://github.com/CoWork-OS/CoWork-OS/blob/main/docs/public-adoption-stats.md)。

## 许可证

[根 LICENSE](https://github.com/CoWork-OS/CoWork-OS/blob/HEAD/LICENSE) 为 **MIT License**，版权方为 `2025 CoWork-OSS Contributors`。

根许可未声明专有目录或商业例外，仓库 API 的 MIT 识别与实际文件一致。允许商业与非商业使用、修改和分发，需保留版权和许可声明；软件按现状提供。

**复用边界**：代码属于标准开源 MIT 许可，在遵循许可保留声明的前提下可自由复用与移植。

## 技术栈

| 运行层 | 组成与职责 |
| --- | --- |
| 桌面与主进程 | Electron、Node.js、TypeScript；负责窗口生命周期、`webContents.debugger` (CDP) 驱动、会话隔离分区与网络策略加固 |
| 核心运行时 | `SessionRuntime` 管理任务状态与上下文投影，`TurnKernel` 编排步骤流转，`ToolScheduler` 处理工具读写排队 |
| 前端 UI | React、Tailwind CSS；`BrowserWorkbenchView` 承载可见 Electron `<webview>`、工具栏、视口调节器、A11y 标注与接管控制 |
| 自动化适配层 | 统一抽象四大后端：`electron-workbench`（默认原生 CDP）、`playwright-local`（本地无头后备）、`browser-use-cloud`（远程云端）与 `external-cdp`（安全策略默认拒绝） |

## 能力清单

按官方架构与功能划分呈现：

### Agent & Tasks
- 多轮会话与规划模式、任务多计算机协同（Task Computers）、审批门禁与权限预设。

### Browser Workbench & Browser V2
- 可视化内置工作台：多标签 `<webview>`、视口预设仿真、控制台/网络/下载日志抽屉；
- 紧凑无障碍快照（Accessibility Snapshot）与短生命周期 Ref 生成；
- 真实键盘鼠标动作派发：`browser_click`、`browser_fill`、`browser_type`、`browser_hover`、`browser_drag`、`browser_upload_file`；
- 人机共态控制：动态操作光标浮层、接管控制条（Take Over / Resume banner）；
- 凭据保护与私密登录：隔离分区，敏感字段脱敏与人工密码交接。

### Coding & Terminal
- 工作区文件检索、读写与局部精准编辑；
- PTY 本地 Shell 交互与后台作业监控。

### Connectors & External
- 多模型接入（Claude、GPT、Gemini、本地 Ollama）；
- MCP 客户端支持；
- 外部通讯中继（Telegram、Discord、Slack 等）。

## 与本项目的对照

对照基准为 `pi-desk` 当前源码实现（Electron 44 + Vue 3 + pi-coding-agent 1.2.0）。

### 实质重合

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| 工作区内置浏览器视图 | Browser Workbench | 双方均使用 Electron `<webview>`，支持地址栏、多标签、后退/前进/刷新和视口内截图批注 |
| 终端与文件操作工具 | Coding & Terminal | 双方均提供受限目录的文件读写/编辑与本地 PTY Shell 会话执行 |

### 部分重合

| 本项目能力 | 对方对应 | 差异 |
| --- | --- | --- |
| 网页元素交互与感知 | Browser V2 Snapshot & Ref | `pi-desk` 仅支持人工在页面点击后注入脚本（`element-picker.ts`）拾取元素交付会话；CoWork OS 支持 AI 通过 CDP Accessibility Tree 自动提取结构化 Ref 节点并驱动操作 |
| 会话与工具流转 | SessionRuntime & TurnKernel | `pi-desk` 基于 `@earendil-works/pi-coding-agent` 的追加式事件流；CoWork OS 为自研多层会话调度器 |

### 无对应（本项目有、对方无）

| 本项目能力 | 说明 |
| --- | --- |
| 生成式原生界面（GenUI） | `pi-desk` 具备 DSL 驱动的动态卡片、图表、指标与参数调节界面引擎（`src/renderer/src/genui/`）；对方采用固定 UI 视图 |
| 局域网扫码移动端配对（lan-remote） | `pi-desk` 内置点对点局域网 Web 桥接；对方依赖第三方外部社交平台 Bot 中继 |

### 对方独有（本项目无）

| 类别 | 能力 |
| --- | --- |
| 浏览器自动化工具契约 | `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_fill`、`browser_type`、`browser_emulate` 等完整 AI 操控工具 |
| 人机共态接管 | AI 操作动态光标遮罩、Take Over / Resume 人机交接横幅 |
| 远程云端浏览器适配 | `browser-use-cloud` API 桥接 |

## 可借鉴方向

仅指功能方向与产品形态，技术方案基于 Electron 官方能力落地：

| 方向 | 可行性 | 说明 |
| --- | --- | --- |
| 基于 `webContents.debugger` 的 A11y 快照与 Ref 交互模型 | **高** | `pi-desk` 已有 Electron 主进程环境与受限 `<webview>`，可复用原生 CDP 构建无障碍快照与输入能力，不必额外捆绑独立浏览器内核，仍有代码体积与维护成本 |
| 人机共态接管条与可见动作浮层 | **高** | 在 `BrowserView.vue` 上方增加绝对定位透明交互层，由主进程 IPC 驱动，即可实现操作可视化与一键暂停接管 |
| 浏览器内输入事件派发（Input.dispatchMouseEvent / dispatchKeyEvent） | **高** | 可使用现有 CDP 能力向页面派发鼠标和键盘事件；不是操作系统级输入，仍受控件、焦点及页面状态限制，不保证覆盖所有复杂前端组件 |
| Browser Use Cloud 远程云端扩展 | **中** | 需额外引入云端 API 凭据管理与网络策略，适合作为二期可选后端 |

## 信息来源

- [CoWork OS 官方文档](https://coworkosapp.com/docs/)
- [Browser V2 架构文档](https://github.com/CoWork-OS/CoWork-OS/blob/main/docs/browser-v2-architecture.md)
- [根 LICENSE](https://github.com/CoWork-OS/CoWork-OS/blob/HEAD/LICENSE)
- [公共统计快照](https://github.com/CoWork-OS/CoWork-OS/blob/main/docs/public-adoption-stats.md)
- 本项目侧事实出处：`src/renderer/src/browser/components/BrowserView.vue`、`src/main/browser/ipc.ts`
