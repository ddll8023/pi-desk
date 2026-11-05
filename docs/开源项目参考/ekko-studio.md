# Ekko Studio

返回[开源项目参考](README.md)。本文记录 `EKKOLearnAI/ekko-studio` 的公开产品能力，不是 pi-desk 的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [EKKOLearnAI/ekko-studio](https://github.com/EKKOLearnAI/ekko-studio) |
| 官网 | [ekkostudio.xyz](https://ekkostudio.xyz) |
| 文档 | [官方使用文档](https://ekkostudio.xyz/#/docs/getting-started) |
| 定位 | 本地优先的 AI 工作区，支持多 Agent 聊天、编码和可视化工作流；提供桌面应用和自托管 Web 控制台，支持 Hermes Agent、Ekko Agent 及 14 种 Coding Agent 集成，统一管理对话、群组协作、语音、文件与设备 |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `main` |
| 最新 Release | `v0.8.14`，2026-11-03 发布 |
| Star / Fork | 11,648 / 1,448 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 520~539；包含未关闭 Issue 与 PR（PR 约 148） |
| 桌面分发形态 | Electron 桌面应用（macOS arm64/x64、Windows x64/arm64、Linux）；内置独立轻量 Python/Hermes Runtime、Node.js 与 MinGit |
| 服务端与自托管形态 | npm 全局 CLI 包（`ekko-studio`，启动命令 `ekko-studio-web start`；保留 `hermes-web-ui` 兼容别名）；单容器 Docker 镜像（`ekkoye8888/hermes-web-ui`） |

以上版本、统计与产物核实于 **2026-11-03**，仅为快照，来源为仓库 API、Release 页面与官方包声明。

## 许可证

[根 LICENSE][e-license] 为 **Business Source License 1.1（BSL 1.1）**，版权方为 EKKOLearnAI。

- **许可范围与限制**：附加使用许可（Additional Use Grant）仅明确授权非商业目的（包括个人日常使用、教育与学术研究）。任何商业使用（包括但不限于销售、商业许可、SaaS 托管收费或嵌入到商业软件产品）均须向版权方获取单独商业许可证。
- **变更条款（Change Date）**：自 2029-05-10 起，该许可证将自动转换为 Apache License 2.0，届时所有用户可在 Apache 2.0 条款下使用。
- **复用结论**：Ekko Studio 当前属于**非开源、源码可用（Source-Available）许可**。其源码不能作为自由复用的开源代码直接移植或合并到本项目代码中。仅可用于宏观产品功能规划、交互形态参考与技术选型对照；具体技术实现需回到其引用的开源依赖自身文档独立设计。

## 技术栈

| 运行层 | 组成与作用 |
| --- | --- |
| 桌面／分发 | Electron、electron-builder；分发包捆绑独立 Node.js、MinGit 以及独立虚拟环境的 Python / Hermes Runtime，提供系统命令 Shim（`ekko-studio`、`ekko-studio-mcp`） |
| 服务端／引擎 | Node.js (>=23.0.0)、Koa 2、Koa Router、Socket.IO (`/chat-run`)、SQLite（自建 Studio 本地会话库）、node-pty（终端进程管理）、Pino 日志、TSOA / OpenAPI 生成；通过 Socket/IPC Bridge 与 Hermes Agent Python 进程通信 |
| 前端与可视化 | Vue 3 (Composition API, `<script setup lang="ts">`)、Naive UI、Pinia、Vue Router、Vite、TypeScript、SCSS、vue-i18n；`@vue-flow/core`（可视化工作流有向图画布与执行回放）、Monaco Editor（代码编辑）、markdown-it + highlight.js + KaTeX + Mermaid（Markdown 渲染与数学公式/图表） |
| 文件预览扩展 | docx-preview、pdfjs-dist、read-excel-file、@aiden0z/pptx-renderer（本地解析渲染 Word、PDF、Excel 多 Sheet 与 PPTX 幻灯片） |
| 外部集成与工具 | `@modelcontextprotocol/client`（MCP 客户端，暴露 `ekko-studio-*` 工具集）、`agent-browser`（桌面受管浏览器自动化操控）、`sherpa-onnx-node` / `node-edge-tts`（离线 STT 引擎与多云端 TTS 语音支持）、10 种平台 Gateway（飞书、钉钉、微信、企微、Telegram、Discord、Slack、WhatsApp、Matrix、QQBot） |

依据：[根 package.json][e-package]、[ARCHITECTURE.md][e-arch] 与官方功能文档。

## 能力清单

按官方 README 与功能文档结构组织，具体能力来源于官方已公开的发布事实与文档说明：

| 官方分组 | 已公开能力及边界 |
| --- | --- |
| AI 聊天（AI Chat） | 多 Agent 卡片启动、Socket.IO 实时流式响应、多会话管理与 SQLite 存储、多平台来源分组、会话置顶与活跃指示器、Markdown 渲染与富文件预览（HTML/PDF/DOCX/PPTX/XLSX/CSV/图片/代码）、工具调用详情展开、Ctrl+K 会话全局搜索、会话分类与消息引用、持久化任务卡片（步骤进度、审批与澄清）、Token/费用与生成速度监控、上下文压缩控制 |
| 平台渠道（Platform Channels） | 单页面配置 10 大 IM/协作平台（Telegram、Discord、Slack、WhatsApp、Matrix、飞书、钉钉、QQBot、微信扫码登录、企业微信）；凭证与行为写入所选 Hermes Profile |
| 可视化工作流（Visual Workflows） | 基于 Vue Flow 的多 Agent 有向图画布；支持单/多 Agent 节点连线、结构化条件分支、成功/失败路由、循环、人工审批门、运行预算控制与冻结快照执行回放 |
| Coding Agents 集成 | 内置与适配 14 种 Coding Agent CLI（Claude Code、Codex、Pi、Grok、OpenCode、DSH、Qwen Code、Kimi Code、CodeBuddy、Copilot CLI、ZCode、Cursor、Qoder、Antigravity）；支持 Studio 隔离模式与原生全局模式、工作区选择、图片输入与文件 Diff |
| 桌面 Agent 浏览器（Desktop Agent Browser） | 桌面端多标签受管浏览器；通过 MCP Server (`agent-browser`) 提供导航、点击、无障碍快照、局部查询、截图与控制台日志捕获 |
| 群聊协作（Group Chat） | 多 Agent 聊天房间；支持在同一房间添加多个不同 Agent，通过 `@提及` 路由驱动上下文回复，支持历史消息超限自动压缩摘要 |
| 语音交互（Voice / TTS / STT） | 回合制语音输入与全屏实时语音舞台；TTS 适配 Edge、OpenAI、豆包、ElevenLabs、Gemini、xAI、MiniMax 等；STT 适配浏览器、OpenAI、豆包、Groq、Mistral 等，支持基于 sherpa-onnx 的离线语音 |
| 移动 App 与会话分享（Mobile App & Sharing） | 支持通过局域网、鉴权直连或云端中转连接移动端 App；支持 iOS Live Activities 实时活动跟踪；支持生成细粒度权限控制的会话分享 Token |
| 任务看板与定时任务（Kanban & Cron） | 按 Profile 管理的 Hermes Kanban 看板；基于 Cron 表达式的定时任务与手动立即触发 |
| 记忆与技能（Memory & Skills） | 技能浏览与搜索、Skill Bundles 安装管理、持久记忆与学习轨迹关系图（Journey graph） |
| Web 终端（Web Terminal） | 基于 node-pty 与 @xterm/xterm 的多会话终端，支持 WebSocket 实时 PTY 传输与窗口尺寸自适应 |
| 用量分析与系统管理（Usage, Logs & Admin） | Token 与费用 30 天趋势（柱状图与明细表格）、结构化日志过滤查看、基于 Token 与多角色的账号登录权限管理 |

## 与本项目的对照

对照基准为 `pi-desk` 当前内置产品能力。

### 实质重合

| 本项目能力 | Ekko Studio 对应 | 关键差异 |
| --- | --- | --- |
| 多会话 AI 聊天与流式渲染 | AI Chat（Socket.IO `/chat-run`） | pi-desk 深度集成 Pi SDK 宿主，主进程持有会话实例，内置声明式 GenUI 系统并支持双向参数回填；Ekko Studio 基于 Koa 服务分发至各运行时适配器，支持以卡片形态切换不同 Agent 运行时。见[会话模块][p-sessions]与[GenUI 模块][p-genui] |
| Web 终端与多会话管理 | Web Terminal（node-pty + @xterm/xterm） | pi-desk 采用独立 PTY 守护进程、会话快照与序号确认接回，且支持终端链接动作气泡（内置浏览器/系统浏览器/复制链接）；Ekko Studio 作为后台 Koa 服务内的 WebSocket 终端管道，支持远程后端（SSH/Docker/Singularity）执行。见[终端模块][p-terminal] |
| 多模型 Provider 与凭据配置 | 模型管理（Provider & Models） | 双方均支持云端模型 Provider 凭据管理、模型列表发现与可见性配置；Ekko Studio 另外将语音（STT/TTS）Provider 并入同一管理体系。见[供应商模块][p-providers] |

### 部分重合

| 本项目能力 | Ekko Studio 对应 | 差异说明 |
| --- | --- | --- |
| Coding Agent 接入 | 14 种 Coding Agent CLI 集成 | pi-desk 深度内置 Pi SDK 完整生态（含 Pi Tools、MCP 与 Skill 门禁），以 Pi 为深度整合的执行核心；Ekko Studio 外层包装 14 种 CLI（包含 Pi、Claude Code、Codex 等），提供隔离与全局配置，偏向外部 CLI 适配层。 |
| 受管浏览器操控 | 桌面 Agent 浏览器（Desktop Agent Browser） | pi-desk 采用内置受限 Webview，侧重于网页点框批注提取 HTML/CSS 并注入对话草稿；Ekko Studio 提供独立桌面 Agent 浏览器面板，通过 MCP (`agent-browser`) 执行无障碍快照、点击、填表与控制台日志捕获。见[工作区标签][p-workspace] |
| 移动端/远程接续 | 移动 App 与会话分享（Mobile App & Relay） | pi-desk 提供免安装的局域网扫码直连 Web 页面，桌面开启即用，手机访问全部项目对话；Ekko Studio 提供独立移动 App 客户端，支持局域网、鉴权直连与云端 Relay 中转，支持 iOS Live Activities 与会话分享 Token。见[手机访问][p-lan] |
| 文件浏览与查看 | 文件浏览器（File Browser） | pi-desk 聚焦本地工作区文件树，深度结合 CodeMirror 源码编辑、Tiptap 富 Markdown 编辑与 Git 差异联动，内置 Excel/CSV/TSV 表格解析与 PDF/DOCX 排版预览；Ekko Studio 重点支持远程后端文件管理，并在聊天中支持 DOCX/PPTX/XLSX/PDF 等生成文件的本地预览。见[文件模块][p-files] |

### 本项目独有

| 本项目能力 | 说明 |
| --- | --- |
| 声明式生成式界面（GenUI） | pi-desk 具备完整的声明式 UI 工具协议（`ui_render` / `ui_patch`，支持 11 种受限节点、可调参数控件、图表、机制图解与用户参数回填）；Ekko Studio 无等价的动态组件渲染与双向参数交互系统（仅有固定任务步骤卡片与静态文件预览）。见[GenUI 模块][p-genui] |
| 任务工作树物理隔离（Task Workspaces） | pi-desk 为会话、Git、终端和文件提供基于 Git worktree 的物理执行根隔离，合入与清理时联动终端安全收敛；Ekko Studio 仅按配置路径或会话目录执行，无内置 Git 工作树全生命周期编排。见[工作区标签][p-workspace] |

### 对方独有

| 类别 | Ekko Studio 已公开能力 |
| --- | --- |
| 可视化工作流画布 | 基于 Vue Flow 的多 Agent 有向连线、结构化分支、人工审批门与历史执行回放 |
| 平台渠道网关 | 内置对飞书、钉钉、企微、微信、Telegram、Discord、Slack 等 10 大协同/通讯平台的 Bot 网关配置与消息路由 |
| 多 Agent 群聊房间 | 房间内支持添加多个不同 Agent，通过 `@提及` 路由与自动上下文压缩实现多 Agent 协同 |
| 实时语音交互 | 全屏实时语音舞台与回合制语音输入，支持 sherpa-onnx 本地离线引擎及十余种云端语音 Provider |
| PPTX 生成物预览 | 内置 `@aiden0z/pptx-renderer` 实现 PPTX 幻灯片在 Web 端的直接解析渲染（本项目目前覆盖 DOCX、PDF 与电子表格，无 PPTX 预览） |
| Hermes Agent 控制面 | Hermes Profile 隔离、Hermes Bridge 通信、Kanban 任务看板与 Cron 定时调度 |

## 可借鉴方向

仅针对产品形态与功能设计进行借鉴，不使用其 BSL 1.1 专有代码；技术实现需依托开源生态自身组件设计。

| 方向 | 可行性 | 依据与依赖代价 |
| --- | --- | --- |
| PPTX 演示文稿富格式预览 | 中 | pi-desk 已内置 `docx-preview`、`pdfjs-dist` 与 `xlsx`，形成了成熟的文件预览视图体系（`FileDocumentPreview.vue` 与 `FileTablePreview.vue`）；引入 `@aiden0z/pptx-renderer` 即可补齐 PPTX 预览能力。代价为适度增加前端打包体积，无架构变更风险 |
| 桌面受管浏览器无障碍快照与日志捕获 | 中 | pi-desk 已有受管 Webview、CDP 桥接与隔离环境注入；可参考其通过标准无障碍树快照和控制台错误捕获增强 Agent 网页感知能力的机制，结合现有 `browser-cdp-adapter` 演进，无须引入重型外部依赖 |
| 多 Agent 协同群聊或顺序编排 | 低 | 需要独立的产品级设计。当前 pi-desk 专注于深度 Pi SDK 交互体验与任务工作区，引入多 Agent 消息路由与上下文调度会显著增加状态复杂度 |
| 基于 Vue Flow 的工作流节点图解 | 低 | 需引入 `@vue-flow/core` 等流程画布库并设计独立的状态机引擎，与当前聚焦交互式会话的工作区形态差异较大 |

## 信息来源

- 官方仓库：[EKKOLearnAI/ekko-studio](https://github.com/EKKOLearnAI/ekko-studio)
- 根目录许可证：[LICENSE][e-license]（Business Source License 1.1）
- 根目录包配置：[package.json][e-package]（v0.8.14）
- 架构设计文档：[ARCHITECTURE.md][e-arch]
- 中文文档：[README_zh.md][e-readme-zh]
- 版本与统计快照：2026-11-03 核实，Release `v0.8.14`，Star 11,648 / Fork 1,448
- 本项目侧事实依据：
  - [项目结构文档](../项目结构文档.md)
  - [会话模块](../modules/sessions-chat.md)
  - [生成式界面模块](../modules/genui.md)
  - [终端与快捷命令模块](../modules/terminal-commands.md)
  - [工作区标签模块](../modules/workspace-tabs.md)
  - [文件与编辑器模块](../modules/files-editor.md)
  - [手机访问模块](../modules/lan-remote.md)
  - [模型供应商模块](../modules/providers-auth.md)

[e-license]: https://github.com/EKKOLearnAI/ekko-studio/blob/main/LICENSE
[e-package]: https://github.com/EKKOLearnAI/ekko-studio/blob/main/package.json
[e-arch]: https://github.com/EKKOLearnAI/ekko-studio/blob/main/ARCHITECTURE.md
[e-readme-zh]: https://github.com/EKKOLearnAI/ekko-studio/blob/main/README_zh.md
[p-sessions]: ../modules/sessions-chat.md
[p-genui]: ../modules/genui.md
[p-terminal]: ../modules/terminal-commands.md
[p-workspace]: ../modules/workspace-tabs.md
[p-files]: ../modules/files-editor.md
[p-lan]: ../modules/lan-remote.md
[p-providers]: ../modules/providers-auth.md
