# ZCode

返回 [开源项目参考](README.md)。本文是外部产品的参考记录，不是本项目的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 产品 | ZCode——Z.ai 官方 coding agent harness（GLM-5.3 官方宿主），官方描述「Z.ai's coding agent harness. Powerful, intelligent, extensible.」 |
| 仓库 | [zai-org/ZCode](https://github.com/zai-org/ZCode)，Apache-2.0 开源，TypeScript pnpm monorepo |
| 官网 | [zcode.z.ai](https://zcode.z.ai/) |
| 文档站 | [zcode.z.ai/docs](https://zcode.z.ai/en/docs/welcome)（中文版 `/cn/docs/` 路径） |
| 定位 | AI 编程工作台：桌面应用 + 浏览器界面 + 终端 Agent（TUI），以任务（Task）组织会话，面向 GLM-5.3 长上下文编码 |
| 形态 | 桌面（Electron，macOS arm64/x64、Windows arm64/x64）、Web（`zcode --web --workspace --port --token`）、CLI/TUI（tar.gz + install.sh，默认装 `~/.zcode/runtime`）、远程 server（SSH/WSL/Docker 工作区） |
| 版本快照 | GitHub 最新 Release v3.17.2（2026-11-04，附 SHA256SUMS）；文档站下载页显示 3.18.2（2026-11-12），两渠道版本不同步 |
| 统计快照 | 8,688 Star / 2,711 Fork / 11 open issues（含 PR）；主语言 TypeScript；默认分支 main；仓库建于 2026-09-20 |
| 模型绑定 | BigModel 与 Z.ai Coding Plan（GLM-5.3、GLM-5.3-Flash）+ API Key 模式 + 任意 Anthropic/OpenAI 兼容供应商 |

形态、版本与统计核实于 2026-11-15，仅为快照。`open_issues_count` 含未关闭 Issue 与 PR。

## 许可与来源性质

- 根 `LICENSE` 为 Apache-2.0（实读文件确认），版权行 Copyright 2026 Z.AI Co., Ltd，无附加例外条款。GitHub API `license` 字段同为 Apache-2.0，与根文件一致，无冲突。
- `NOTICE.md` 与 README 均未声明按子目录独立许可的例外目录，API 元数据无 `NOASSERTION`；未逐子目录核对 `LICENSE` 文件。
- NOTICE.md 的边界声明（对照与借鉴时需知）：
  - 各运行形态（桌面/CLI/Web/远端）的功能、权限、存储与网络行为不同，不能以一种形态的默认设置推断整体。
  - 共享 Agent 执行适配器**不提供默认操作系统沙箱**；CLI `--prompt` 非交互默认 `yolo`，共享配置默认 `build` 权限模式。
  - 数据发送范围逐场景列出（模型请求、OAuth、SSH/WSL 同步、会话分享、远程控制 relay、Bot 接入、更新检查等）；用户自配第三方组件不在官方审核覆盖内。
  - 凭据为本地加密文件、可派生密钥，Web OAuth 可存 localStorage，「并非系统钥匙串」；CLI 会话数据库默认 `~/.zcode/cli/db/db.sqlite`。
  - 开源构建默认不启用自动更新；受第三方版权与再分发条件约束，「不承诺提供官方产品的全部功能及活动政策」。
- 复用结论：第一方代码按 Apache-2.0 可使用、修改、再分发；订阅配额、官方推荐 MCP 服务与线上服务能力不在开源许可授予范围内。

## 技术栈

| 层 | 组成 |
| --- | --- |
| 桌面 | Electron（packages/desktop：Main/Host/Renderer 与桌面打包） |
| 前端 | React + Zustand 共享组件（packages/ui）、Web 客户端（packages/web） |
| 服务端 | HTTP/WebSocket 服务与远程连接（packages/server）、独立 server 启动与进程管理（packages/zcode-server-cli） |
| 协议 | 共享协议与类型（packages/shared）、RPC 框架（packages/rpc）、Agent 客户端 SDK（packages/client） |
| 供应商 | Provider 公共能力（packages/provider）与 Node 实现（packages/provider-node） |
| Agent 运行时 | apps/zcode-cli（Agent CLI、TUI、运行时与工具） |
| 工程链 | Node 24.14.0 + pnpm 10.33.2（版本以 mise.toml 为准）、Vitest、oxlint/oxfmt、release-it |

组件与能力的对应关系：Agent 执行集中在 CLI 运行时，桌面与 Web 都是同一运行时的宿主外壳；远程开发是把同一运行时装入 SSH/WSL/Docker 目标环境，桌面端只保留账号、模型配置与界面。执行适配器无默认 OS 沙箱（NOTICE 声明），权限控制走确认模式与 Hooks 协议，不依赖系统隔离。

## 能力清单

按官方文档站 22 个功能页分组记录（Get Started / Core Features / Integration 的官方结构），不自创分类。未单独抓取的 Support 页（keyboard-shortcuts、qa）不列。

| 页面 | 能力要点 |
| --- | --- |
| ZCode Agent（/en/docs/agents） | 默认自研 agent，GLM-5.3 深度适配（1M 稳定上下文、index-sharing 降低长上下文开销、反 hack 后训练）；`@`文件 `#`过往会话 `/`命令 `$`技能四种上下文符号，大段粘贴自动转附件；AGENTS.md 两层注入（用户级 `~/.zcode/AGENTS.md` 先追加 + 工作区主体；无子目录扫描、无 @import，CLAUDE.md 仅一次性迁移来源）；项目记忆（默认关、成功轮后台提取、子代理不读写）；侧边会话 `/side`（复用主会话历史作上下文、时间线空白、每任务一个）；Fork（干净完成的 assistant 回复制为新任务，继承历史与模型设置）；无项目模式（首启默认进入，文件留磁盘）；Thought level 三档（默认 Max） |
| Goal Mode（/en/docs/goal） | `/goal` 设目标后每轮结束单独跑校验，未达成自动开下一轮、达成收尾总结；校验要求真实证据（改动文件、命令输出、测试结果），存在未完成待办则阻止判定完成；`/goal pause/resume/clear`，状态跨会话存活；usage budget 达到即停；Plan 模式下不可设 goal |
| Browser Automation（/en/docs/browser-use） | 官方 Browser Use 插件（默认开启）驱动内置浏览器面板：打开 URL、点击、填表、滚动、截图、指定 viewport；面板实时跟随展示；tab 隔离（agent 只驱动自己打开的 tab，用户 tab 需显式认领）；Chrome cookies/localStorage 一次性快照导入（Windows 不支持、Chrome 运行中失败）；页面文本永不被当作指令；缓存与站点数据两级清理 |
| Task & File Management（/en/docs/task-management） | 任务侧栏三视图（Grouped 自定义分组带 7 色／Workspace／Timeline）+ 排序 + 搜索 + 自动归档（保留期 3/7/14/30 天可配）；文件树实时过滤、「只看变更文件」、Git 状态标记（目录聚合状态）、单击预览、双击用默认编辑器打开、拖入聊天插入引用；Git Graph 只读提交历史图；分支切换器（有未提交变更时可选一步提交并切换） |
| Wiki（/en/docs/repo-wiki） | 读代码库生成「架构指南」（分析→目录→逐页→存 `~/.zcode/v2/repo-wiki/<workspace-hash>/wiki.json`，仓库外纯 JSON）；每条论断链接源码路径 + 行区间；双栏阅读视图 + Mermaid 图表；每轮结束检查代码变化自动刷新；隐私排除（`.git`、依赖、构建产物、gitignore 内容、文件名含 secret/token 的文件、symlink 目标不给模型清单）；每仓库同时一个生成任务、只保留一个语言版本；每模型请求固定 3 分钟超时 |
| Memory（/en/docs/memory） | 项目级长期记忆，默认关闭（v3.6.4+）；后台审查每个成功轮，值得保留则写单事实 `.md` + 更新 `MEMORY.md` 索引，后续会话把索引载入上下文；四类（User/Feedback/Project/Reference）；对话指令 remember/forget 增删；排除代码结构、git 历史、项目指令已有内容、一次性细节；按项目隔离、不上传、文件可手动编辑删除；子代理不读不写；索引载入有大小上限（超大截断） |
| Automations（/en/docs/automations） | 定时任务：六种计划规则（Hourly/Daily/Every weekday/Weekly/Monthly/Custom）+ Ends 结束日期；三种创建（表单／会话内 Create in chat／四个只读分析模板）；任务绑本地项目 + 四执行模式 + 模型与思考档；全部项目合计 20 个上限（paused/completed/failed 也占槽）；History 记录每次触发（含电脑休眠跳过）；本机执行、依赖电脑唤醒与应用开启；Keep awake 全局开关 |
| Idle-time Task（/en/docs/idle-time-tasks） | 全局空闲队列先到先得、运行免费不耗订阅额度；实际模型由服务端临时分配（结束恢复）；到时限的长任务重入队、同会话续跑；需 Personal Coding Plan（Start Plan 与纯 API key 模式不支持）；Esc 中断即转付费会话；后台子代理（background: true）不支持；每日创建数量上限 |
| Edit History（/en/docs/edit-history） | 编辑最后一轮用户消息后基于更新上下文继续（保留 model/workspace/branch）；Reset chat + files 一次性恢复该轮文件改动并重发修订消息（无法安全恢复时明确报错，可选仅重置对话）；每条回复的文件变更 Undo/Reapply（all-or-nothing：无改动前快照、被用户手动编辑、被终端命令改动的文件不可撤）；排队消息可编辑 |
| Remote Development（/en/docs/remote-development） | 三类远程工作区：SSH（内置客户端；ssh config 别名仅预填参数、ProxyJump/ProxyCommand 不生效）、WSL（仅 Windows 桌面端）、Docker（docker exec/cp）；运行时资源两种准备（本地下载经 SFTP 上传装 `~/.zcode/server`／远程直连 CDN）；项目文件、命令执行、Agent runtime 留目标环境，账号、模型、全局设置与用量留桌面端；配置手动同步（Skill/MCP/Plugin 三项，marketplace 插件远程重装）；凭据加密存本地 |
| Remote Control（/en/docs/remote-control） | 二维码/链接把当前桌面窗口开放给手机（链接本身携带授权、刷新二维码即失效旧链接）；同时仅一个手机页；访问整个窗口（不限扫码时所在 workspace）；Task home（按 workspace/时间线整理、窗口内新建任务、重连已注册但断开的远程工作区）+ Session view（回复、执行步骤、发指令、复制、点赞点踩、fork）；桌面断开即不可用；手机不建立任何连接、不能浏览任意目录 |
| Bot Channel（/en/docs/bot-channel） | 微信（扫码登录自动绑定）与飞书（扫码 + 开放平台确认 + 限时 `/bind` 命令）；飞书命令面（查状态、建任务、切项目、切模型、切运行模式、调回复详细度）；飞书流式卡片就地更新、需决策时卡片冻结单独成卡；DingTalk/Discord/WeCom 写明后续版本支持；驱动的是桌面端已有会话，代码仍在原工作区运行 |
| Subagents（/en/docs/subagents） | 内置 general-purpose（全工具）与 Explore（只读、不注入 AGENTS.md）；自定义为单文件 `~/.zcode/agents/<name>.md`（frontmatter：model、thoughtLevel、tools/disallowedTools、maxTurns、injectAgentsMd 默认开、mcpServers 精确名匹配）；工具白名单穷举式——自定义列表下所有 MCP 工具不可用，需手写 `mcp__<server>__<tool>`，通配符被静默忽略；不可递归派生；只见主会话启动时已连接的 MCP；前台并行或后台运行（后台 Explore 仅保留只读工具）；仅用户级、改后需新会话生效 |
| Plugin（/en/docs/plugin） | 插件打包 commands/skills/agents/hooks/`.mcp.json` 五组件（清单 `.zcode-plugin/plugin.json`，兼容 `.claude-plugin/`）；marketplace.json 支持七种 source（相对路径/directory/github/git/file/url/npm）；userConfig 声明式参数（`sensitive` 暂不能在 UI 输入）；MCP 服务器键自动命名空间 `plugin:<name>:<server>`；启停需刷新 Agent 运行时；更新按 marketplace.json 版本比对；官方明示「启用插件即授予代码执行信任」 |
| Skill（/en/docs/skill） | `~/.zcode/skills/<name>/SKILL.md`（用户级）+ 项目级 + 插件级；frontmatter `name`/`description` 必填、description 超 1024 字符则整个技能丢弃；每轮把全部启用技能元数据（名称 + 250 字符摘录）注入上下文，共享固定预算、超限退化仅注入名称；`$` 标签调用；正文超 100KB 加载时截断；改后需 Settings→Skills Refresh；导入五来源（Claude Code、Codex CLI、OpenClaw、Augment、Windsurf，Symlink 或 Copy）；无独立技能市场，分发需打包为插件 |
| MCP Services（/en/docs/mcp-services） | User/Workspace 两级配置（`~/.zcode/cli/config.json` 与 `<project>/.zcode/config.json` 键 `mcp.servers`；`.agents/mcp.json` 仅在同 scope `.zcode` 无服务器时整体 fallback，面板写入只落 `.zcode`）；面板创建（Form/Full JSON）+ 编辑 + 启停；HTTP/SSE OAuth（跳系统浏览器授权，未及时完成标 failed 不阻塞会话）；外部四来源导入（Claude Code、Codex CLI、OpenCode、通用 `.agents/mcp.json`）；打开项目自动连接其全部 MCP 服务器；同名冲突用户级胜出 |
| Command（/en/docs/commands） | `/` 命令面板（Commands 与 Skills 两组）；用户级存 `~/.zcode/commands/*.md` + 工作区级；内置 `/goal` 与 `/compact`；Settings 创建（Scope/Name/Description/Argument hint/Prompt）；支持从外部 Agent 导入 |
| Hooks（/en/docs/hooks） | 七事件（SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop）本地子进程协议：stdin 一行 JSON、退出码 + stdout JSON 回复；PreToolUse 可 allow/ask/deny 并用 `updatedInput` 完全替换工具输入；Stop 可 block 让主模型继续（连续 ≤3 次）；process（argv）/command（shell，可 async）执行器；matcher 为精确列表或 JS 正则；用户级须 `hooks.enabled: true`，**项目级 hooks 整体被忽略不执行**；插件 `hooks/hooks.json` 自动发现；会话启动做配置快照、不热加载；deny > ask > allow，硬性限制不可被 hook allow 绕过 |
| Usage Stats（/en/docs/usage-stats) | App Usage（数据来自本机会话记录：token/会话/消息/活跃天数/当前与最长 streak/高峰时段；每日 token 趋势、活动热力图、模型用量排名；All Time/30/7 天）；Coding Plan 页（5 小时 prompt 池、周配额、月度 MCP 配额、按模型消耗、工具调用统计）；配额重置卡（3.8.1+，非高峰自动发卡需三条件、点击恢复 100%、仅登录且有 Coding Plan 的用户） |
| Safety Confirmation（/en/docs/safety-confirm） | 四执行模式 Shift+Tab 循环（Ask before changes 默认／Edit automatically／Plan／Full access）；确认工作流：任务暂停锁定输入框、展示确切命令/改动/动作、Allow/Always Allow/Reject/Always Reject（会话与项目粒度）；5 分钟倒计时超时自动继续（任何活动永久停止倒计时；权限请求与 plan 审批不受影响） |
| ADE Tools（/en/docs/ADE-tools) | 桌面定位为 Agent Development Environment：任务列表（归档/恢复）、Command Center（Cmd+K：命令、会话、文件统一入口）、内置浏览器（地址栏/DevTools/http(s)+file；元素选择器捕获 selector + 安全 HTML 摘要加入聊天；agent 驱动）、文件预览（PDF 页导航/缩放/复制文本但不可编辑；HTML 右键内置浏览器打开仅限本地工作区；Mermaid 缩放；图片画廊；表格复制 Markdown/下载 CSV）、终端（Cmd+J、长命令可后台）、Enhanced Find and Grep（更快 find/grep 替代实现、对新会话生效、Windows 仅替换 grep、远程工作区不支持） |
| Connect Models（/en/docs/configuration） | BigModel/Z.ai Coding Plan 授权登录（免配 URL）+ API Key 切换；内置端点清单（coding 与通用、OpenAI 与 Anthropic 双协议）+ 第三方（Anthropic/OpenRouter/Moonshot/OpenAI/MiniMax/小米/DeepSeek）；Add Provider 任意兼容服务；`~/.zcode/v2/config.json`（options 仅识别 apiKey/baseURL/headers 等连接字段）；上下文窗口、思考档、max output 可配（Coding Plan 模型窗口由服务端下发会还原）；HTTP 代理覆盖范围明确（模型 API/MCP/WebFetch/终端子进程/插件市场；不代理登录、repo Wiki、Web Remote Control、SSH）；自动压缩不可配置（预留约 34K tokens）；试用额度 5 天；团队计划条目切换 |

## 名词约定

| 术语 | 对方原文 | 含义 |
| --- | --- | --- |
| 执行模式 | Execution modes | Ask before changes／Edit automatically／Plan／Full access 四档，Shift+Tab 循环，决定多少动作需要确认 |
| 思考档位 | Thought level | GLM-5.3 推理强度 Low/High/Max（默认 Max） |
| 目标模式 | Goal Mode | `/goal` 设定后每轮结束自动校验并续跑的会话机制 |
| 空闲任务 | Idle-time task | 全局空闲队列的一次性任务，订阅专属免费通道 |
| 插件 | Plugin | 打包 commands/skills/agents/hooks/MCP 的分发单元，经 marketplace 安装 |
| 钩子 | Hook | 七事件的本地子进程协议（stdin/stdout JSON 行） |
| 命令 | Command | `/` 调用的保存 prompt（.md 文件），与 Skill 的区分：重复工作流用 Skill，简单 prompt 用 Command |
| 侧边会话 | Side Conversation | 复用主会话历史作上下文、时间线独立的右面板会话 |
| 三层远程 | — | Remote Development（代码在哪台机器跑）／Remote Control（手机操作桌面窗口）／Bot Channel（IM 驱动已有会话）的职责区分 |

## 与本项目的对照

总体结论：**9 项实质重合、5 项部分重合、6 类本项目独有、15 类对方独有**。对照基准是 pi-desk 当前内置产品能力；对方侧只依据官方文档 22 页与仓库元数据，未读实现源码、未运行，不写实现质量排名。未核实范围：对方 CLI/TUI 详细命令与批量评测（README 提及、文档站无独立 CLI 页）、终端面板深度（文档仅 Cmd+J 与长命令后台）、仓库 `UI_PLUGIN.md`（README 提及的插件页面 API，未读）。

### 实质重合

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| 会话聊天与 Agent 执行（SDK 宿主 utilityProcess 执行、流式投影、工具卡片、压缩） | ZCode Agent 任务 | 本项目会话由独立 SDK 宿主进程（`@earendil-works/pi-coding-agent`）执行，历史双路径解析宿主 JSONL；对方 Agent 执行在 CLI 运行时，桌面是宿主外壳。上下文符号基本对齐（`@`文件引用两边都有；对方多 `#`过往会话与 `$`技能入口）。项目指令注入同为两层；对方注入规则更简（无子目录扫描/@import）。对方多 Plan 执行模式、排队消息、大段粘贴转附件；本项目多图片编号标注与扩展卡片 |
| 子代理委派 `delegate_subagent`（四类任务画像、`tasks[]` 批内并行、独立子进程、`--tools` 白名单、写守卫、预算超时） | Subagents（Agent 工具派发 + 自定义定义文件） | 共同事实：子代理都在独立上下文工作、返回摘要、不能递归派生。机制差异：本项目一次委派带 `tasks[]` 批内并行（`BATCH_CONCURRENCY` 上限）、逐任务预算（TASK_PROFILES）与 `write_scope` 派发校验 + 子进程内写守卫；对方单个 Agent 调用可前台并行或后台，模型/思考档/工具白名单由定义文件 frontmatter 声明，白名单是穷举式（自定义列表下 MCP 工具全部不可用、通配符静默忽略）。本项目子代理不下发 bash、不继承配置；对方后台 Explore 强制只读、后台运行由 Agent 决定无开关 |
| 受管浏览器（webview 沙箱标签 + CDP 适配器、截图标注、元素选择、AI 自动化自动分屏 1:1 绑定 + 人工接管） | 内置浏览器 + Browser Use 插件 | 共同事实：桌面内置浏览器、agent 驱动、页面文本不被当指令、人工可实时观看。机制差异：本项目浏览器经 `webContents.debugger` 做 CDP 适配，不暴露任意脚本执行，按项目独立持久分区，自动化时自动分屏并 1:1 静默绑定、随时一键接管/恢复（双向控制状态机）；对方是官方插件实现，面板跟随 + tab 隔离（用户 tab 需显式认领），多 viewport 测试与 Chrome 登录态一次性导入（本项目无导入）。本项目元素选取产出标注批注流「交给对话」；对方元素选择器把 selector + HTML 摘要直接加入聊天 |
| 记忆（用户级全局 SQLite 库 + 受管 CPython 引擎、9 工具集、每轮常驻背景三段注入、reinforce 有用性标注、规则生命周期、注入审计卡片） | Memory（项目级文件制） | 共同事实：本地长期记忆、跨会话注入上下文、排除代码结构与一次性细节。机制差异：本项目库为 `~/.agents/memory-store/memory.db`（SQLite WAL）+ BM25 检索 + 显式标注加权（封顶 + 时间衰减）+ 写入闸门 + 预算结算的常驻注入 + 审计；对方为 `~/.zcode/cli/memories/projects/<project>/memory/` 文件制 + 后台自动提取 + 索引全量载入，无检索工具与排名、无管理 UI（需手编磁盘文件）、默认关闭。范围差异：本项目用户级全局库 + 项目归属（UUIDv5）；对方严格按项目隔离不跨工作区。子代理侧：本项目记忆工具受保护不裁剪；对方子代理不读不写记忆 |
| 技能（四来源、skill_guard_select 登记门禁、执行模式裁剪、输入坞预读） | Skill（`~/.zcode/skills/`） | 共同事实：SKILL.md 单文件指令、frontmatter 必填校验、会话内按需加载。机制差异：本项目带加载证据门禁（登记 + 必读引用全文核对 + 修改类工具阻断 + 沿用作废规则）；对方只有 frontmatter 校验与 description 长度丢弃，无加载核对，但多元数据注入预算策略（超限退化仅名称）与跨 Agent 导入（五来源、Symlink/Copy）。来源结构：本项目随包 + 产品 agent 目录 + 只读共享目录 + 项目级（项目技能不进专家候选）；对方用户级 + 项目级 + 插件级，无独立市场需打包为插件 |
| MCP 接入（配置只读列举 + 探测、运行中会话登录/退出/重连、专家许可集范围外标停用） | MCP Services（面板配置管理 + OAuth） | 共同事实：MCP 服务器接入会话、配置分用户/项目两级、外部格式兼容。机制差异：本项目桌面端只读（编辑不在产品面内，MCP 配置由 pi CLI 体系承载），专家能力范围决定哪些服务器在会话装配期标停用；对方是完整配置管理面（创建/编辑/启停/JSON 粘贴）+ HTTP/SSE OAuth 浏览器授权流 + `.agents/mcp.json` fallback 语义 + 打开项目自动连接。本项目 OAuth 对应「运行中会话的 MCP 登录/退出/重连」 |
| 用量统计（跨项目会话明细单一数据源、按日/模型×日/子代理×日、热力图近 53 周、下钻统一收敛、Codex 与 OpenCode Go 额度） | Usage Stats（App Usage + Coding Plan 页） | 共同事实：本地会话记录驱动的 token 统计、趋势 + 热力图 + 模型维度。机制差异：本项目会话明细数组为唯一数据源、聚合全在渲染层派生、子代理维度单列、费用只算上报价格不推算、下钻收敛到统一会话明细区；对方另有 streak/高峰时段/活跃天数维度，及订阅侧 Coding Plan 配额（5 小时池/周/月）与配额重置卡——订阅部分本项目无对应（无订阅体系） |
| 手机远程控制（lan-remote：局域网 HTTP 直连、设备登记/撤销、会话列表活跃标记、四类问题回应） | Remote Control（二维码/链接授权） | 共同事实：手机作为桌面会话的控制面、代码仍在电脑执行、手机不建运行时、桌面离线即断。机制差异：本项目局域网 HTTP 直连 + 一次性连接码 + HttpOnly Cookie 设备登记 + 撤销立即断连 + 默认关闭 + 明示无传输加密无公网中继；对方链接即授权（无设备管理）+ 同时仅一个手机页 + 可对已注册断开的远程工作区触发重连（底层传输组件页面未写，未核实）。本项目手机端有斜杠命令候选与图片标注只读展示；对方有 fork 与点赞点踩 |
| 模型供应商接入（供应商聚合清单、认证辅助进程、自定义 models.json + /models 探测、Codex/OpenCode Go 额度） | Connect Models（Coding Plan + 任意兼容 Provider） | 共同事实：多供应商接入、凭据本地管理、自定义模型条目。机制差异：本项目认证走独立辅助进程（stdin/stdout JSONL），密钥不回传页面（哨兵显示），额度按凭据指纹隔离缓存；对方 Coding Plan 授权登录 + 订阅配额体系（配额由服务端下发、本地改动被还原）+ 明确的 HTTP 代理覆盖边界。本项目 OpenCode Go 额度不推算金额；对方费用只在订阅页呈现 |

### 部分重合

| 本项目能力 | 对方对应 | 差异 |
| --- | --- | --- |
| 文件树与文件预览（目录监听、拖入输入坞、@ 引用、CodeMirror 编辑、Tiptap 富文本、HTML 隔离预览、表格/PDF/DOCX 预览） | 文件树 + ADE 文件预览 | 重叠部分：文件树浏览、聊天引用、多格式预览（PDF 页导航两边都有）。差异：本项目有完整源码编辑与富文本编辑、DOCX 结构提取与纸张排版；对方单击预览、双击用**默认编辑器打开**（内置源码编辑未见文档，未核实），文件树带 Git 状态标记与「只看变更」过滤（本项目 Git 状态在右侧源代码管理页签）；对方多 Mermaid 全屏查看 |
| Git 集成（右侧页签完整写操作：暂存/提交/拉取/推送/丢弃；任务工作区 worktree 隔离 + Squash 合入 + 清理；轮次提交式快照；盘点/修剪/GC） | Git Graph（只读）+ 分支切换器 | 对方面板层只读（历史图、提交详情、Load more）+ 分支切换/新建（可一步提交切换）；写操作靠终端与 agent 执行。本项目桌面内闭环写操作 + 任务级独立工作树与临时分支合入流。对方的 Git 写入不设桌面面板（作为对外功能），本项目轮次快照的代码硬重置同样未贯通 |
| 执行模式与权限（标准/快速两档：裁剪用户级 Skill 名单与记忆工具；项目信任对话框 + 信任门禁） | Safety Confirmation 四执行模式 + 确认工作流 | 两套机制作用对象不同：本项目两档作用于能力面裁剪（哪些工具激活），权限确认走 Pi SDK 既有机制 + 项目信任；对方四档作用于确认频率（哪些动作要确认）+ 细粒度 Allow always + 5 分钟超时自动继续。对方 Plan 模式（先规划后确认实现）本项目无对应档位；本项目「快速模式」的能力收缩语义对方没有 |
| 回退与编辑历史（回退基于官方条目身份建新分支、多分支归档；Git 轮次提交式快照） | Edit History（消息编辑重发 + 文件 all-or-nothing 撤销） | 重叠目标：对不满意的一轮重试。机制不同：本项目回退按条目身份建新分支并归档旧支，代码侧靠轮次快照（硬重置未贯通）；对方是原地编辑最后一轮消息重发 + 按回复聚合文件改动撤销（无改动前快照/手动编辑/终端改动不可撤、all-or-nothing）。对方的「Reset chat + files」在本项目无一一对应（回退不自动恢复文件） |
| 项目指令 AGENTS.md（桌面产品 agent 目录 + 只读共享目录 `PI_DESK_SHARED_AGENT_DIR`） | AGENTS.md 注入（用户级 + 工作区） | 都注入两层、无子目录扫描；差异在来源边界：本项目桌面 agent 目录只读加载共享目录（技能与规则共享、扩展与记忆不共享，另有首启导入幂等机制）；对方直接读用户级与工作区两个路径，子代理默认也注入（injectAgentsMd 可关）；CLAUDE.md 两边都只作迁移或兼容来源 |

### 本项目独有

| 能力 | 说明 |
| --- | --- |
| 专家体系 | 会话级角色绑定 + 三维能力范围（技能/MCP/工具各 inherit/only，全局基线 `capability-defaults.json`，受保护工具始终保留）+ 设置页编辑与会话内草案卡片创建。对方会话无角色化机制；最接近的是子代理定义文件的 tools/mcpServers 裁剪，但那是委派维度不是会话角色 |
| 技能加载门禁 skill-guard | 登记执行技能 + 必读引用全文核对 + 修改类工具阻断 + 沿用作废规则（版本/技术栈族/分支切换）。对方技能无加载证据核对机制 |
| 记忆 reinforce 有用性标注 | 模型按真实记录 ID 写标注事件，BM25 排序乘子（封顶 + 时间衰减），清空即回滚。对方记忆无检索排名机制（索引全量载入） |
| present_card 会话内卡片 | 宿主枚举类型（expert.draft/session.summary）+ 动作白名单（expert.save/copy.text），卡片列候选由用户勾改后经既有通道落地。对方 README 提及 UI Plugin 体系（插件自建页面，仓库 UI_PLUGIN.md 未读），文档站未见等价的「宿主枚举 + 动作白名单」交付卡片 |
| 任务工作区隔离与审阅合入 | 独立物理工作树（`.pi/worktrees/<uuid>` + 临时分支）+ 依赖软链接 + 审阅合并（Squash）+ 清理 + 仓库盘点。对方任务绑定 workspace 与分支选择器，无独立 worktree 隔离合入流 |
| 多格式文档编辑 | DOCX 结构提取与纸张排版预览、Markdown Tiptap 富文本编辑（目录/查找替换/公式/折叠块/图解）、表格排序筛选。对方 PDF 只读、表格仅复制 Markdown/下载 CSV |

### 对方独有

| 类别 | 能力 |
| --- | --- |
| 目标驱动执行 | Goal Mode：每轮校验 + 自动续轮 + 真实证据判定 + usage budget + 跨会话存活 |
| 仓库 Wiki | 读码生成架构指南、论断链接源码行区间、双栏阅读、自动刷新、隐私排除边界 |
| 定时与空闲任务 | Automations（六种计划、20 上限、History）与 Idle-time task（空闲队列免费通道、服务端临时分配模型） |
| IM Bot 接入 | Bot Channel：微信扫码、飞书绑定命令与流式卡片、命令面；驱动桌面已有会话 |
| 插件市场 | Plugin marketplace：五组件打包、七种 source、版本比对更新、userConfig、Claude Code 清单兼容 |
| 用户可配置 Hooks | 七事件子进程协议、PreToolUse allow/ask/deny + updatedInput、Stop block（≤3 次）、matcher 正则 |
| 远程开发 | SSH/WSL/Docker 三类远程工作区、运行时资源 SFTP/CDN 上传、配置手动同步三项 |
| 多形态分发 | Web（--web --port --token）、CLI/TUI、server 包（tar.gz + install.sh + SHA256SUMS）、远程 server CLI |
| 编辑历史 | 消息编辑重发、Reset chat + files、按回复聚合的文件改动 Undo/Reapply（all-or-nothing） |
| Fork 与侧边会话 | Fork 复制干净完成的回复为新任务（继承历史与模型设置）；侧边会话复用主会话历史、时间线独立 |
| 无项目模式 | Work outside a project：首启默认进入、文件留磁盘、首条消息后模式固定 |
| 浏览器登录态与视口 | Chrome cookies/localStorage 一次性导入（Windows 不支持）、agent 指定 viewport 测试 |
| 外部 Agent 生态导入 | 技能五来源、命令导入、MCP 四来源导入、hooks 只读迁移、CLAUDE.md 迁移 |
| 任务组织 | 分组（7 色）/Workspace/Timeline 三视图、自动归档（保留期可配）、Command Center（Cmd+K） |
| 订阅配额管理 | Coding Plan 配额页、配额重置卡（非高峰自动发卡）、Idle-time 免费通道 |

## 可借鉴方向

借鉴范围只指功能方向与产品形态，不参考对方实现代码；可行性分级依据现有依赖与架构。

| 方向 | 可行性 | 说明 |
| --- | --- | --- |
| 文件改动快照撤销（按回复聚合的 Undo/Reapply + all-or-nothing + 不可恢复时拒绝） | 高 | 已有轮次提交式快照（`src/main/git/turn-snapshot-service.ts`）与 Git 基础；缺的是「按回复聚合文件变更 + 快照判安全恢复 + 会话 UI 操作行」，不引入新组件。注意本项目轮次快照的代码硬重置链路尚未贯通，需先补齐该链路 |
| 外部 Agent 技能/命令/MCP 导入 | 中 | 技能同为 SKILL.md 格式，MCP 配置读取已有（`src/main/resources/mcp-config-reader.ts`）；缺的是其他 Agent 配置格式解析（`~/.claude/settings.json`、`~/.codex/config.toml` 等）与导入向导 UI。无运行时改动；边界：只读导入，不改外部原配置 |
| Hooks 式用户可配置事件 | 中 | 宿主扩展已有内部事件面（skill-guard 挂 before_agent_start/tool_call 等），缺的是把事件面开放为用户配置的外部子进程协议（stdin/stdout JSON 行 + 超时 + 输出上限）与「执行本地代码」的信任声明。需适配 macOS/Windows 进程差异；与现有扩展机制同职责面，需先判定归属避免双轨 |
| Goal Mode 目标驱动续轮 | 低 | 需目标状态机 + 每轮校验调用 + 真实证据判定 + 预算控制 + 暂停/恢复持久化，与现有回退/分支模型交互要重新设计，属独立产品级设计 |
| 定时任务 Automations | 低 | 需调度器（本机时区、错过即跳过语义）、任务生命周期（active/paused/completed/failed）、历史记录；应用未运行时的语义需定义。新增调度子系统与设置面 |
| 远程开发（SSH/WSL/Docker） | 低 | 需远程 runtime 分发与安装（资源上传/校验）、远程会话执行链路、配置同步；与现有单机 SDK 宿主模型差异大，属独立产品级设计 |

不建议照搬的部分：配额重置卡与 Idle-time 免费通道依赖订阅体系（本项目无订阅产品形态）；无项目模式与「链接即授权」的手机远程（本项目设备登记 + 局域网边界是明确的安全取舍）；CLI `--prompt` 默认 yolo 与无沙箱执行适配器的口径（本项目信任门禁 + 不提供 OS 沙箱的声明已覆盖同一风险面并有更明确的边界表述）。

## 信息来源

### 对方官方资料

- 仓库与 README（结构/安装/打包）：[github.com/zai-org/ZCode](https://github.com/zai-org/ZCode)（中文 README 与 README.en.md）
- LICENSE：[raw …/main/LICENSE](https://raw.githubusercontent.com/zai-org/ZCode/main/LICENSE)
- NOTICE.md：[raw …/main/NOTICE.md](https://raw.githubusercontent.com/zai-org/ZCode/main/NOTICE.md)
- Releases（v3.17.2 快照）：[github.com/zai-org/ZCode/releases](https://github.com/zai-org/ZCode/releases)
- 仓库元数据（Star/Fork/Issue/语言/分支）：[api.github.com/repos/zai-org/ZCode](https://api.github.com/repos/zai-org/ZCode)

官方文档站（22 页，均于 2026-11-15 核实）：

- 入门：[welcome](https://zcode.z.ai/en/docs/welcome)、[install](https://zcode.z.ai/en/docs/install)、[configuration](https://zcode.z.ai/en/docs/configuration)
- 核心功能：[agents](https://zcode.z.ai/en/docs/agents)、[goal](https://zcode.z.ai/en/docs/goal)、[browser-use](https://zcode.z.ai/en/docs/browser-use)、[task-management](https://zcode.z.ai/en/docs/task-management)、[repo-wiki](https://zcode.z.ai/en/docs/repo-wiki)、[memory](https://zcode.z.ai/en/docs/memory)、[automations](https://zcode.z.ai/en/docs/automations)、[idle-time-tasks](https://zcode.z.ai/en/docs/idle-time-tasks)、[edit-history](https://zcode.z.ai/en/docs/edit-history)、[remote-development](https://zcode.z.ai/en/docs/remote-development)、[remote-control](https://zcode.z.ai/en/docs/remote-control)、[bot-channel](https://zcode.z.ai/en/docs/bot-channel)、[subagents](https://zcode.z.ai/en/docs/subagents)、[plugin](https://zcode.z.ai/en/docs/plugin)、[skill](https://zcode.z.ai/en/docs/skill)、[mcp-services](https://zcode.z.ai/en/docs/mcp-services)、[commands](https://zcode.z.ai/en/docs/commands)、[hooks](https://zcode.z.ai/en/docs/hooks)、[usage-stats](https://zcode.z.ai/en/docs/usage-stats)
- 集成：[safety-confirm](https://zcode.z.ai/en/docs/safety-confirm)、[ADE-tools](https://zcode.z.ai/en/docs/ADE-tools)

### 本项目事实出处

- 会话、投影、用量统计、present_card、专家体系：`docs/modules/sessions-chat.md`；实现见 `src/main/sessions/session-manager.ts`、`src/main/usage/`、`src/shared/present-card-view.ts`
- 子代理委派：`docs/modules/sub-agent.md`；实现见 `src/sdk-host/sub-agent/delegation-extension.ts`、`write-guard.ts`、`src/shared/sub-agent-view.ts`
- 受管浏览器：`docs/modules/workspace-tabs.md`；实现见 `src/main/browser/browser-session-service.ts`、`browser-cdp-adapter.ts`、`src/sdk-host/browser/tools.ts`
- 记忆：`docs/modules/memory.md`；实现见 `src/main/memory/memory-manager.ts`、`resources/agent/extensions/pi-memory/`、`resources/agent/skills/memory/`
- 技能与 MCP：`docs/modules/skill-guard.md`、`docs/modules/resources-mcp.md`；实现见 `resources/agent/extensions/skill-guard/`、`src/main/resources/mcp-config-reader.ts`、`src/shared-process/mcp-session-config.ts`
- Git 与任务工作区：`docs/modules/git.md`；实现见 `src/main/git/worktree-service.ts`、`turn-snapshot-service.ts`
- 手机访问：`docs/modules/lan-remote.md`；实现见 `src/main/lan-remote/`、`src/lan-mobile/`
- 供应商与认证：`docs/modules/providers-auth.md`；实现见 `src/main/providers/auth-manager.ts`、`src/auth-helper/`
- 文件与编辑器：`docs/modules/files-editor.md`；实现见 `src/main/projects/project-file-content.ts`、`src/renderer/src/editor/`
- 终端：`docs/modules/terminal-commands.md`；实现见 `src/main/terminal/terminal-manager.ts`、`src/terminal-daemon/`
