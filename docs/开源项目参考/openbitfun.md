# OpenBitFun

返回[开源项目参考](README.md)。本文是外部项目的参考记录，不是 pi-desk 的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [GCWing/OpenBitFun](https://github.com/GCWing/OpenBitFun) |
| 官网 | [openbitfun.com](https://openbitfun.com)（中文：[openbitfun.com/zh](https://openbitfun.com/zh)） |
| 文档 | [官方文档站](https://openbitfun.com/docs)、[使用手册 Playbook](https://playbook.openbitfun.com/) |
| 定位 | 面向编码、多设备互联、微应用与长任务的开源 Agent 工作台，采用高性能 Rust Agent Runtime 与 Tauri 跨平台桌面客户端 |
| 主语言（仓库统计） | Rust / TypeScript |
| 默认分支 | `main` |
| 最新 Release | `v1.0.7`（2026-10-21 发布）/ Nightly `1.0.7-nightly.20261027+c8b6746b6`；`Cargo.toml` 工作区版本为 `1.0.8` |
| Star / Fork | 3,194 / 279 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 121（含 Issue 与 PR） |
| 分发形态 | Tauri 跨平台桌面端（Windows x64 安装包、macOS Apple Silicon / Intel dmg、Linux x64/ARM64 AppImage 及 DEB）；移动端源码（iOS / Android / HarmonyOS）与 Web 访问；CLI/TUI 二进制工具；Relay Server 自部署服务；MiniApp Shell 独立窗口程序 |

以上版本、统计与产物核实于 **2026-10-31**，仅为快照，数据源于[仓库 API][obf-repo]、[Release 列表][obf-release]及官网。

## 界面截图

![OpenBitFun 桌面端首页](https://raw.githubusercontent.com/GCWing/OpenBitFun/main/png/openbitfun-desktop.png)

*桌面端首页（官方 README alt 文本）。*

![OpenBitFun 桌面端多 Agent 会话](https://raw.githubusercontent.com/GCWing/OpenBitFun/main/png/openbitfun-desktop-session.png)

*桌面端多 Agent 会话（官方 README alt 文本）。*

## 许可证

根目录 [`LICENSE`][obf-license] 为 **MIT License**，版权方为 CWing（2026）。README 声明 `Core code: MIT`，第三方依赖与资源遵循各自开源许可证（如 `third_party/` 与部分专用工具）。

**代码复用结论**：OpenBitFun 核心代码（包括 Rust Agent Runtime、Tauri 桌面端应用、CLI、MiniApp Shell 架构与多生态适配层）遵循 MIT License，可供开源或商业项目合法借鉴与复用源码；第三方组件保留其原有开源许可证。

## 技术栈

| 运行层 | 组成与作用 |
| --- | --- |
| 桌面外壳与前端 | Tauri 2.11（结合 wry 与 tao 平台补丁）、React、TypeScript、Tailwind CSS，采用基于 schema-first 的 TypeScript 类型绑定（`ts-rs`） |
| 核心运行时（Rust） | 采用 4+1 架构的高性能 Rust Workspace：包含 Execution 层的 `agent-runtime`、`agent-workflows`、`agent-stream`、`tool-contracts`；Services 层的 `services-core`、`terminal`、`computer-use`；Assembly 层的组装管理 |
| 微应用体系（Mini App） | 独立编译的 `miniapp-shell` 轻量窗口程序（只包含系统窗口与通信能力，不链接完整 Core），支持 Agent 动态生成 HTML/CSS/JS 微应用，配合独立 Worker 运行 |
| 终端与 CLI | `portable-pty`、`vte`、`clap`、`ratatui`、`crossterm`，支持原生终端模拟与交互式 TUI 直接运行模式 |
| 跨设备与网络 | 基于 `axum`、`tokio-tungstenite`、`sioc` 提供 HTTP 与 WebSocket 通信；提供可独立部署的 `relay-server`；采用 `x25519-dalek` 与 `aes-gcm` 进行端到端加密通信；集成 `russh` 支持远程主机与跳板机 SSH 连接 |
| 生态适配与扩展 | 内置 OpenCode、Claude Code、Codex、Cursor、Pi、DSH 等多种适配器（`crates/adapters/*`）；插件运行时（Bun 子进程监督）支持 Package Plugin；支持 MCP 协议与 Agent Hooks 流程拦截 |

依据：[根目录 Cargo.toml][obf-cargo]、[产品架构文档][obf-arch]与 [README][obf-readme]。

## 能力清单

按官方 README、使用手册及产品架构文档分组呈现：

| 官方分组 | 能力及实现边界 |
| --- | --- |
| 四种 Harness 协作模式 | 提供四档执行框架：**极简（Minimal）**（轻量即时协作，AI 直接执行，用户快速介入反馈）、**标准（Standard）**（日常任务逐步规划、执行与自检）、**极致（Ultimate）**（复杂多路径任务，多 Agent 分工协同与整合）、**创造（Creative）**（面向 Mini App 创作与系统定制） |
| 跨设备互联与远程控制 | 支持在桌面端一键切换多台已连接电脑的工作区与会话；手机端作为远程控制端，自适应单屏、双屏、三屏折叠屏布局，支持跨广域网发送指令、查看进度、处理权限审批；支持自部署 Relay Server 桥接；支持 SSH 连接远程主机或容器工作区 |
| Mini App 微应用生态 | 支持通过自然语言对话即时构建专用交互应用；每个 Mini App 具备独立 UI 与专属 Agent 会话；配套独立轻量 `miniapp-shell` 窗口运行；提供官方 Mini App 市场与皮肤市场 |
| 计算机操控（Computer Use） | 借助系统辅助功能 API（macOS Accessibility、Windows UI Automation、Linux AT-SPI）与原生截屏，支持 Agent 模拟鼠标点击、键盘输入与多显示器定位，直接操控桌面应用 |
| 深度代码与长任务执行 | 包含 `flashgrep` 驻留索引加速大型代码库符号与全文检索；内置上下文压缩与长期记忆机制，支持持久会话与中断恢复；在 DeepSWE v1.1 基准评测中验证了长程复杂任务推进效率 |
| 扩展体系与生态兼容 | 支持 MCP 工具集成、Skills 规范发现；提供 Agent Hooks 机制拦截任务流程并注入自定义规则；底层提供多生态 Adapter 桥接外部 Agent 格式 |

## 与本项目的对照

对照基准为 pi-desk 当前内置实现（基于 Electron 桌面外壳 + Vue 3 / TypeScript + 独立 SDK 宿主 + 独立终端守护进程）。

### 实质重合

输入、输出与核心目标一致，两者均为本地优先、面向开发者的全功能 Agent 桌面工作区：

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| **会话与聊天交互** | 交互式会话（Conversation / Session） | **pi-desk** 会话经独立 utilityProcess 拉起 `sdk-host` 运行，基于 Pi 官方 SDK 规范驱动多轮对话与流式渲染；**OpenBitFun** 会话由 Rust 内置的 `agent-runtime` 统一调度，提供流式 Chunk 组装、用量结算及 Checkpoint 快照机制。 |
| **终端与命令行集成** | 终端服务（`crates/services/terminal`） | **pi-desk** 通过独立的 `terminal-daemon` 守护进程维持持久 PTY 会话，支持应用重启后的流控恢复与终端气泡；**OpenBitFun** 基于 `portable-pty` 构建 Rust 终端抽象，既作为桌面内置终端面板，又支持在 CLI 下以 Ratatui 渲染交互式 TUI。 |
| **文件与 Git 工作区** | 文件与 Git 操作（`core.git` / `services-core`） | 两者均提供工作区文件树导航、编辑器、Git 状态检查、差异对比与提交功能。差异在于 pi-desk 编辑器集成 CodeMirror 与 Markdown 深度编辑，OpenBitFun 还结合了 `flashgrep` 常驻索引服务。 |
| **MCP 与扩展接入** | MCP 客户端与 Skills 发现 | 两者均原生支持 MCP（Model Context Protocol）工具发现与调用，并支持解析项目级与用户级 Skills 目录。 |

### 部分重合

功能在局部环节重叠，但在机制设计、输入输出范围或处理深度上存在差异：

| 本项目能力 | 对方对应 | 差异 |
| --- | --- | --- |
| **移动端远程控制** | 手机远程控制（Remote Connect / Relay） | **pi-desk** 采用轻量化局域网 HTTP 扫码直连，手机打开网页即可控制，无需公网服务器或中继服务；**OpenBitFun** 依赖中心化自部署 Relay Server + WebSocket 转发，支持跨广域网多设备接入，且移动端专门针对折叠屏单/双/三屏做了响应式适配与原生客户端。 |
| **生成式界面 / 微应用** | Mini App 微应用生态 | **pi-desk** 的 `genui` 采用声明式 JSON 控件协议，在当前对话流中即时渲染卡片、表格、图表与参数控件，双向回填上下文；**OpenBitFun** 的 `MiniApp` 则是让 Agent 生成完整的前端应用代码（HTML/JS/CSS），在独立的 `miniapp-shell` 原生窗口进程中作为持久微应用运行，并支持分发到市场。 |
| **外部生态与运行时兼容** | 多生态适配器（`crates/adapters/*`） | **pi-desk** 专精于 Pi 官方 SDK 的深度集成与生命周期管理；**OpenBitFun** 在系统底层抽象了适配层，同时桥接 Pi、Claude Code、Codex、OpenCode 等外部工具规范。 |

### 无对应（本项目独有）

| 本项目能力 | 说明 |
| --- | --- |
| **受管内置浏览器自动化（CDP）** | pi-desk 内置受管 Chrome/Chromium 浏览器，支持无障碍树快照、自动化点击输入、浏览器与编辑器自动双屏分屏、悬浮网页批注直接交付对话草稿、终端 URL 自动路由。OpenBitFun 虽有 WebDriver 适配但无内置受管浏览器产品闭环。 |
| **零配置免中继局域网扫码直连** | pi-desk 局域网模式由本机直接启动 HTTP 服务并动态生成二维码与凭据，完全不依赖公网服务器、账户系统或外部中继即可让局域网手机访问。 |

### 对方独有

| 类别 | 能力 |
| --- | --- |
| **协作模式分层** | 明确划分 Minimal、Standard、Ultimate、Creative 四种 Agent Harness 模式，根据任务复杂度灵活调配单 Agent 即时协作或多 Agent 分工整合，配备专用任务看板。 |
| **独立微应用窗口与市场** | 拥有独立编译的 `miniapp-shell` 轻量窗口运行时，支持用户通过自然语言创作完整的独立桌面微应用，并配备 Mini App 与皮肤官方市场。 |
| **计算机操控（Computer Use）** | 借助操作系统底层辅助功能与截屏直接操控桌面原生应用与键鼠，超出普通工作区文件与命令操作边界。 |
| **跨网络多设备工作区切换** | 在桌面客户端内支持多台物理机（办公室电脑、家庭电脑、远程服务器）之间的工作区与会话实时切换。 |
| **高性能 Rust 统一内核** | Agent Runtime 完全由 Rust 编写，支持 Embedded 与 Shared 模式，提供统一的 CLI/TUI/Desktop 执行语义，并在 DeepSWE 等长任务基准上进行了长期验证。 |

### 形态对比

| 维度 | pi-desk | OpenBitFun |
| --- | --- | --- |
| **桌面外壳** | Electron 43 + Node.js 运行时 | Tauri 2.11 + Rust 原生二进制 |
| **前端技术栈** | Vue 3 + TypeScript + Pinia + Tailwind CSS v4 | React + TypeScript + Tailwind CSS |
| **核心执行引擎** | Node.js utilityProcess 隔离的 Pi SDK 宿主 | 纯 Rust 编写的嵌入式/共享 Agent Runtime |
| **移动端通信** | 局域网同源 HTTP / SSE 扫码直连（免部署中继） | WebSocket / HTTP 经自部署 Relay Server 中转（支持广域网） |
| **交互式产物形态** | GenUI 声明式 JSON 控件流式渲染 | Mini App 独立 HTML/JS 应用 + 独立 Shell 窗口 |

## 可借鉴方向

借鉴范围限于公开产品功能方向与架构设计，核心代码可在 MIT 许可下参考：

| 方向 | 可行性 | 说明 |
| --- | --- | --- |
| **Agent Harness 协作模式分层** | **高** | 借鉴其 Minimal（即时协作）、Standard（日常规划推进）、Ultimate（复杂多 Agent 分工）的预设分层思路。pi-desk 现有 prompt 编排与会话机制完全可覆盖，有助于帮助用户在快速问答与复杂任务规划间按需切换。 |
| **交互式产物沙箱（微应用形态）** | **中** | 在 pi-desk 现有 `genui` 声明式组件协议基础上，评估支持 Agent 交付包含独立 HTML/JS 的沙箱微应用视图（如通过受限 iframe 或 Webview 容器展示），增强轻量数据可视化与专用工具的可玩性。 |
| **跨网络多设备中继协议** | **中** | 当前 pi-desk 仅支持局域网直连。可参考 OpenBitFun 的 Relay 转发设计与端到端加密机制，未来若用户需要跨公网远程控制桌面端，可作为架构参考方案。 |

## 信息来源

- [OpenBitFun 官方网站][obf-home]与[中文站][obf-home-zh]
- [OpenBitFun 使用手册 Playbook][obf-playbook]
- [OpenBitFun 产品架构文档（docs/architecture/product-architecture.md）][obf-arch]
- [OpenBitFun 仓库根目录 LICENSE][obf-license] 与 [Cargo.toml][obf-cargo]
- [OpenBitFun 仓库 API][obf-repo] 与 [Release 列表][obf-release]（核实于 2026-10-31）
- 截图来源：[仓库截图素材目录 `png/`][obf-shots]（raw 直链，核实于 2026-11-06）
- 本项目侧事实依据：`docs/项目结构文档.md`、`docs/modules/sessions-chat.md`、`docs/modules/workspace-tabs.md`、`docs/modules/genui.md`、`docs/modules/lan-remote.md`

[obf-home]: https://openbitfun.com
[obf-home-zh]: https://openbitfun.com/zh
[obf-playbook]: https://playbook.openbitfun.com/
[obf-arch]: https://github.com/GCWing/OpenBitFun/blob/main/docs/architecture/product-architecture.md
[obf-license]: https://github.com/GCWing/OpenBitFun/blob/main/LICENSE
[obf-cargo]: https://github.com/GCWing/OpenBitFun/blob/main/Cargo.toml
[obf-readme]: https://github.com/GCWing/OpenBitFun/blob/main/README.md
[obf-repo]: https://github.com/GCWing/OpenBitFun
[obf-release]: https://github.com/GCWing/OpenBitFun/releases
[obf-shots]: https://github.com/GCWing/OpenBitFun/tree/main/png
