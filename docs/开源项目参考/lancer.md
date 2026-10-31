# Lancer

返回[开源项目参考](README.md)。本文记录 `raylee-ai/lancer` 的公开产品能力，不是 pi-desk 的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [raylee-ai/lancer](https://github.com/raylee-ai/lancer) |
| 官网 | 无独立官网，宣传网站代码在仓库 `apps/website` |
| 文档 | [仓库文档目录](https://github.com/raylee-ai/lancer/tree/main/docs)（包含架构、控制接口与扩展设计） |
| 定位 | 基于 pi-gui 和 pi 的桌面 AI 工作区，聚焦会话并行分支、任务事件拓扑图与交付物全链路追溯 |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `main` |
| 最新 Release | `v1.0.1`（Alpha），2026-10-31 08:02:05 UTC 发布 |
| Star / Fork | 19 / 4 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 0（含 Issue 与 PR） |
| 分发与构建形态 | Electron 桌面应用；Release 附带公开源码包 `lancer-v1.0.1-source.tar.gz` 与 SHA-256 清单，仓库提供 macOS 持久本地签名打包脚本，未发布公证独立安装包 |

以上版本、统计与产物核实于 **2026-10-31**，仅为快照，数据源于[仓库 API][l-meta]与[Release API][l-release]。

## 许可证

根目录 [`LICENSE`][l-license] 为 **MIT License**，版权方为 Matthew Lam（2026）。保留 upstream pi-gui 的原始版权声明与 [`NOTICE`][l-notice]，Lancer 的源码修改同样采用 MIT 许可发布。允许自由使用、修改、分发与商用，须保留版权与许可声明。仓库 API 的 `license` 字段识别为 MIT，与根文件一致。

**子目录与依赖例外**：
1. **`video/` 目录**：依据 [`docs/third-party-dependencies.md`][l-deps]，宣传视频项目使用 **Remotion License**（非商业免商业授权，商业使用需付费购买许可），不属于 MIT 许可范围，亦不包含在桌面应用或 Light UI 运行依赖中。
2. **素材与商标**：第三方模型商标、Fate 相关设计素材与用户头像未随源码 MIT 自动获得再分发许可，公开发布包需单独审计素材版权。
3. **字体**：桌面端内置 Inter 与 JetBrains Mono 字体，保留各自的 SIL Open Font License。

**代码复用结论**：桌面应用核心代码（`apps/desktop`）与独立光线 UI 包（`packages/light-ui`）遵循 MIT License，可供开源或商业项目合法借鉴与复用代码；`video/` 目录下视频渲染代码受 Remotion License 约束，不得直接作为自由开源代码移植。

## 技术栈

| 运行层 | 组成与作用 |
| --- | --- |
| 桌面外壳与进程 | Electron 43、electron-vite、Node >=22.19.0 <26、pnpm workspaces（10.34.9），采用 Electron 主进程 + Preload + React 渲染进程架构 |
| 前端界面 | React、TypeScript、Tailwind CSS；UI 包含自研工作台组件、时间线虚拟化滚动（`use-timeline-viewport`）及流动光线动效 |
| Agent 运行时 | 官方 upstream `@earendil-works/pi-coding-agent`，通过内部 `packages/pi-sdk-driver` 适配，共享 `~/.pi/agent` 配置目录 |
| 扩展体系 | Chord 0.87.0 + `@lancer/extension-ui`，通过沙箱 iframe + MessagePort + 自定义 `pi-extension://` 协议挂载桌面扩展前端 |
| 本地通信与接口 | 基于 Unix Domain Socket (`control.sock`) + 32 字节 Bearer Token 提供轻量 HTTP/1.1 Wire API (`lancer-ctl`) |
| 代码审阅与快照 | 原生 Git CLI 驱动，在应用专属 userData 维护 `turn-checkpoints/objects.git` bare 仓库用于交互回合（Turn）快照 |
| 外部工具链 | 视频工作流依赖系统级 FFmpeg、FFprobe、yt-dlp 执行解码与关键帧提取；测试采用 Playwright（`@playwright/test`） |

依据：[根目录 package.json][l-package]、[架构文档][l-arch]、[依赖说明][l-deps]及 [Control API 说明][l-ctl]。

## 能力清单

按官方 README、架构说明与文档分组呈现：

| 官方分组 | 能力及实现边界 |
| --- | --- |
| 会话与模块（Sessions & Modules） | 支持独立常态会话与模块会话；会话可独立配置运行阶段、指定模型、绑定 Skill、设定目标与交付要求；支持会话归档与恢复 |
| 并行工作与编排（Parallel Work & Recursive Branches） | 一个工作区可管理多个会话；任务支持递归派生子分支（child-threads）与孙分支；`OrchestrationOwner` 实施子分支监督，并在任务结束后向父会话汇总结果 |
| 任务事件图（GitTree） | 右侧可视化看板，实时展现多会话线、分支派生、合并节点及产物交付节点；以任务执行事件与 Turn 为节点拓扑，非单纯 Git 提交 |
| 运行动态反馈（Light UI） | 活动气泡与过程状态行具备流动边框；模型输出与交付动作向事件拓扑节点投射同色流动光线；已解耦为独立包 `@lancer/light-ui`，支持单独导出复用 |
| 多模型控制台（Models & Accounts） | 共享 `~/.pi/agent`，支持订阅账号、API Key 与自定义端点；支持会话内即时切换模型，支持动态调整会话思考强度（`thinkingLevel`：off 到 max 七档） |
| 审阅工作台与 Turn 快照（Workbench & Turn Checkpoints） | 提供 `DiffPanel` 审查变更（Uncommitted / Staged / Unstaged / Branch / Last turn）；通过独立 bare Git 仓库在每个交互回合（2 秒预算）记录增量快照，支持按任意历史 Turn 差异回溯；持久化 `reviewed-files.json` 审阅标记 |
| 自定义桌面扩展（Custom Desktop Extension Views） | 扩展基于 Pi Extension 机制声明，通过 `@lancer/extension-ui` 注册桌面前端视图；应用以 `allow-scripts` 沙箱 iframe 承载，经 MessagePort 与 Chord 协议同步状态；提供 PR Review 与 Test Runs 两套官方示例 |
| 本地控制接口（Local Control API / `lancer-ctl`） | 监听 Unix Domain Socket，提供 Bearer Token 鉴权的 HTTP/1.1 Wire API v1；配合 `./scripts/lancer-ctl` 支持外部程序列出会话、发送消息（send/queue/steer）、查询日志、订阅 ndjson 事件流、停止会话及等待结束 |
| 豆包接管（Doubao Takeover on macOS） | 在 macOS 上利用系统辅助功能（Accessibility API）与已打开的豆包桌面 App 建立通信，接收其回复内容与生成视频 |
| 视频工作流与交付物（Video Workflow） | 借助 FFmpeg、FFprobe、yt-dlp 进行视频下载、音频分离、关键帧截取与证据标注；通过 Remotion 渲染宣传/展示动画 |

## 与本项目的对照

对照基准为 pi-desk 当前内置实现（Vue 3 + TypeScript + 独立 SDK 宿主 + 独立终端守护进程）。

### 实质重合

输入、输出与核心目标一致，两者均以 Pi 为核心 Agent 引擎构建桌面应用：

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| **Pi 会话执行与集成** | 模型会话执行（`packages/pi-sdk-driver`） | **pi-desk** 使用 Electron `utilityProcess` 隔离拉起 `sdk-host` 独立进程，经 MessagePort 与主进程通信，主进程再经严格白名单 IPC 与 Vue 交互；**Lancer** 在 Electron 主进程内直接集成 Pi，通过内部扩展 hook（`agent_start`, `message_start`, `agent_settled`）拦截事件并驱动转录。 |
| **多分支与子线程管理** | 并行工作与子分支（`OrchestrationOwner` / Trajectory Lane） | **pi-desk** 目前基于 `subagents-design.md` 进行子代理设计；**Lancer** 已经落地基于 Pi 会话树的递归子分支与孙分支、父子会话结果汇总机制，并通过 `multi-lane-phase1-extension.md` 提供航道轨迹图。 |

### 部分重合

功能在局部环节重叠，但在机制设计、输入输出范围或处理深度上存在差异：

| 本项目能力 | 对方对应 | 差异 |
| --- | --- | --- |
| **运行可视化与排版** | GitTree 任务拓扑图 + Light UI 光线动效 | **pi-desk** 聚焦 Markdown、Mermaid 流程图、KaTeX 与富文本渲染；**Lancer** 建立了专用的任务事件拓扑图（GitTree），并配合 `@lancer/light-ui` 实现了模型和气泡向工作树投射流动同色光线的反馈机制。 |
| **代码审阅与 Diff 展示** | 审阅工作台（`Workbench`）与 Turn 级别快照（`TurnCheckpointStore`） | **pi-desk** 基于当前 Git 工作区提供常规 Diff 比对与编辑器查看；**Lancer** 除了 Uncommitted/Staged 之外，通过独立的 `objects.git` bare 仓库在每个交互回合保存快照，支持任意历史 Turn 维度的精准回溯，并持久化 `reviewed-files.json`。 |

### 无对应（本项目独有）

对方完全未实现或未作为对外产品功能暴露的能力：

| 本项目能力 | 说明 |
| --- | --- |
| **局域网手机端扫码入口（LAN Mobile Web）** | **pi-desk** 内置局域网 HTTP 服务与二维码配对通道，移动端无需安装 App，扫码即可直接访问并操控桌面 Agent；**Lancer** 仅面向本地桌面窗口与本地 CLI，无移动端网页接入机制。 |
| **终端持久守护进程（Terminal Daemon / PTY）** | **pi-desk** 采用独立的终端守护进程脱机持有 PTY 会话，桌面客户端重启或退出时终端任务不中断；**Lancer** 的终端深度绑定于桌面主进程生命周期，无独立常驻守护进程。 |

### 对方独有

对方具备独立产品入口，而本项目当前尚未实现的能力：

| 类别 | 具体能力 |
| --- | --- |
| **本地无头控制接口** | Unix Domain Socket + Bearer Token 的 Control API 与 `./scripts/lancer-ctl`，支持外部程序非交互式派发（send/queue/steer）、等待（wait）、订阅日志流（stream）与多泳道查看（lanes）。 |
| **自定义桌面扩展前端** | 基于 `pi-extension://` 协议、沙箱 iframe 与 Chord 0.87.0 的前端扩展挂载机制，允许 Pi 扩展携带独立的 GUI 操作面板（如 PR Review、Test Runs）。 |
| **macOS 豆包 App 接管** | 利用 macOS 辅助功能（Accessibility API）与本地豆包桌面应用挂接，接收外部生成内容。 |
| **视频分析与渲染工作流** | 结合 FFmpeg 关键帧提取、模型视频多模态分析以及基于 Remotion 的自动化视频剪辑渲染。 |

### 形态与架构对比

| 维度 | pi-desk（本项目） | Lancer（对方） |
| --- | --- | --- |
| **桌面外壳与前端** | Electron + Vue 3 + TypeScript + Pinia + Tailwind CSS v4 | Electron 43 + React + TypeScript + Tailwind CSS |
| **Pi 运行边界** | 独立 `utilityProcess` 托管 SDK 宿主，故障不波及主进程 | Electron 主进程内直接加载 Pi SDK 驱动 |
| **多线程支持** | 规划中的 Subagent 编排规范 | 已落地的递归子分支（child-threads）与航道视图 |
| **外部控制接入** | 局域网 HTTP 手机网页（受限 Cookie 认证） | 本地 Unix Domain Socket（Bearer Token Wire API + CLI） |
| **代码快照颗粒度** | 当前 Git 工作区与分支状态 | 独立 Bare Git 仓库管理的 Turn 级别快照（每交互回合） |
| **构建与包管理** | npm / electron-vite / electron-builder | pnpm workspaces (10.34.9) / electron-vite |

## 可借鉴方向

仅针对公开功能方向与产品架构进行借鉴，不采用对方 `video/` 专有许可目录下的实现；技术方案沿用本项目技术栈。

| 方向 | 可行性 | 说明 |
| --- | --- | --- |
| **本地 Unix Socket 控制接口（Control API）** | **高** | **本项目现有 Node 运行时即可完全覆盖**。利用 Node 原生 `net` 模块监听 Unix Domain Socket，以 Bearer Token 鉴权，复用主进程现有的会话派发与审批通道。能为用户本地自动化脚本、测试管道或多 Agent 协作提供标准输入通道，避免直接篡改 `~/.pi/agent/sessions/*.jsonl` 产生文件锁争抢。 |
| **基于独立 Bare Git 仓库的 Turn 级别审查快照** | **中** | **需在应用数据目录引入专用 Bare Git 仓库**。无需在用户项目生成 Git commit 即可在 Agent 交互回合前后记录快照，支持精准比对任意单轮指令产生的文件差异。依赖代价是需调用系统 Git CLI，必须实现严格的执行超时（建议 2 秒以内）、文件大小上限过滤与定期的 `git gc` 清理逻辑。 |
| **GitTree 任务事件拓扑图与 Light UI 动态反馈** | **中** | **需在前端进行 Vue 3 组件移植与重写**。将聊天流水线升级为直观的任务拓扑图（主线、派生分支、合并节点），配合流动光线增强思考与产出感知。对方的 `@lancer/light-ui` 已独立为 MIT 包，但基于 React 实现，pi-desk 需转译为 Vue 3 组件并适配现有样式体系。 |
| **桌面扩展前端沙箱挂载体系** | **低** | **需要独立的产品级体系设计**。需新增自定义协议（如 `pi-extension://`）、CSP 沙箱隔离 iframe、多进程间 MessagePort 管道以及状态双向同步机制。由于改动横跨主进程、preload 和渲染层，工程复杂度较高，短期内可优先完善标准 CLI 扩展与 MCP 支持。 |

## 信息来源

- **对方官方资料与仓库**：
  - GitHub 仓库主页与 README：[raylee-ai/lancer][l-repo]
  - 架构设计与状态边界：[`docs/architecture.md`][l-arch]
  - 本地控制接口规范：[`docs/lancer-control-api.md`][l-ctl]
  - 扩展前端设计与 Chord 集成：[`docs/chord-desktop-extension-design.md`][l-ext]
  - 多泳道航道扩展说明：[`docs/multi-lane-phase1-extension.md`][l-lane]
  - 许可证与版权通知：[`LICENSE`][l-license]、[`NOTICE`][l-notice]、[`docs/third-party-dependencies.md`][l-deps]
- **对方版本与元数据（2026-10-31 快照）**：
  - 仓库基础 API：`https://api.github.com/repos/raylee-ai/lancer`
  - Release 发布 API：`https://api.github.com/repos/raylee-ai/lancer/releases`
- **本项目侧事实依据**：
  - 项目全局架构与运行边界：[`docs/项目结构文档.md`][p-arch]
  - 子代理设计规划：[`docs/subagents-design.md`][p-subagent]
  - 开源参考索引：[`docs/开源项目参考/README.md`][p-index]

[l-repo]: https://github.com/raylee-ai/lancer
[l-meta]: https://api.github.com/repos/raylee-ai/lancer
[l-release]: https://api.github.com/repos/raylee-ai/lancer/releases
[l-license]: https://github.com/raylee-ai/lancer/blob/main/LICENSE
[l-notice]: https://github.com/raylee-ai/lancer/blob/main/NOTICE
[l-package]: https://github.com/raylee-ai/lancer/blob/main/package.json
[l-deps]: https://github.com/raylee-ai/lancer/blob/main/docs/third-party-dependencies.md
[l-arch]: https://github.com/raylee-ai/lancer/blob/main/docs/architecture.md
[l-ctl]: https://github.com/raylee-ai/lancer/blob/main/docs/lancer-control-api.md
[l-ext]: https://github.com/raylee-ai/lancer/blob/main/docs/chord-desktop-extension-design.md
[l-lane]: https://github.com/raylee-ai/lancer/blob/main/docs/multi-lane-phase1-extension.md
[p-arch]: ../项目结构文档.md
[p-subagent]: ../subagents-design.md
[p-index]: README.md
