# 子代理自动委派机制（专题对照）

本文件是**专题对照**，不属于单项目记录：把多个成熟产品“主代理如何决定把任务交给子代理”的做法放在同一张表里比较，用于判断 pi-desk 现有设计是否需要调整。单项目明细仍以各项目文件与官方文档为准，索引见 [README](README.md)。

核实时间：2026 年 11 月。机制事实由 research 子代理逐条核对官方文档与仓库源码，来源逐项列在文末；标注“未核实”的部分没有找到可点开的官方依据，不以推测补全。

## 对照表

| 产品 | 派发入口 | 主动性来源 | 路由/策略层 | 并行与续派 |
| --- | --- | --- | --- | --- |
| Claude Code | `Agent`（早期 `Task`）工具 + `subagent_type` | 模型按请求描述、每个子代理的 `description`、当前上下文判断 | 无规则路由；`tools: Agent(worker, researcher)` 限制可派类型 | 默认后台启动（结果 `async_launched`）、并发上限、`agentId` 可 resume、`fork` 复制当前对话 |
| Cursor | `task` 工具 + 子代理清单 | 子代理 `description` 作为 “Task tool hints” 由父模型读取 | 无 | 同一轮发送多个 Task 调用即并行、`is_background`、按 agent ID resume |
| Codex CLI | `spawn_agent`（`agents.enabled` 默认 true） | 源码常量默认压制主动派发，需用户明说或 `AGENTS.md`/skill 指示 | 无 | `max_concurrent_threads_per_session`、`wait_agent` 汇总、`fork_turns` 控制继承上下文 |
| OpenCode | `task`（v1）/ `subagent`（v2） | description 写 “proactively” 时模型应主动使用 | 权限层：`action=subagent`、`resource=<agent-id>` 白名单 | `background=true` 立即返回、返回 sessionID 可续聊 |
| Gemini CLI | `invoke_agent` + `agent_name` | 主提示要求“任务匹配专长时使用子代理” | **策略层**：`agent_name` 作为虚拟工具别名参与规则匹配，规则可限定 `subagent` | 同步调用；禁止子代理再派生；max_turns 与超时预算 |
| Cline | `spawn_agent`（子代理）/ Agent Teams（协调者） | 子代理由模型判断；Teams 由 coordinator 拆任务 | **编排层**：任务板 + 邮箱 + mission log | 子代理可再派生；批准一次 `spawn_agent` 即批准其后续全部工具调用 |
| Amp | `Task` / `Read Thread` / 插件子代理（oracle 等） | 官方表述为 Amp 自行决定何时使用子代理 | 无 | 子代理之间不可通信、只回摘要，可续派任务 |
| DeepSeek Harness | `tool-subagent` / `-fork` / `-control` | 模型调用工具 | 宿主侧契约：`depthLimit`、`parent`/`caller` 两种投递、子代理目录持久化 | 受管激活、消息与中断权限、冷恢复 |
| Lancer | 会话内编排工具 | 模型调用 | 宿主侧 Orchestration owner 承担子分支策略与监督 | 递归子/孙分支，结果回父会话汇总 |

## 逐产品要点

**Claude Code**。判定主体是模型，载体是“请求文本 + 子代理 `description` + 上下文”，官方文档直接写明这条链路，没有关键词或规则表。调优手段只有两条：在 `description` 中写 “use proactively” 一类措辞，或由用户显式点名 / `--agent` 指定。官方为非内置子代理的描述给出总量告警阈值，说明描述是常驻上下文成本。隔离较细：子代理只拿到自己的 system prompt 与工具传入的 prompt，不继承父对话历史与父工具结果，可用 `tools`/`disallowedTools`、`isolation: worktree` 收窄。来源：[sub-agents](https://code.claude.com/docs/en/sub-agents)、[SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)。

**Cursor**。同样只有一个 `task` 工具，`description` 被定义为 “Task tool hints”，由 Agent 读取后决定；并行靠“同一轮多条 Task 调用”，后台过程写入本地目录，按 agent ID resume。权限比 Claude Code 粗：官方 FAQ 写明子代理继承父代理全部工具（含 MCP），只用一个 `readonly` 开关收窄。来源：[subagents](https://cursor.com/docs/subagents)、[SDK reference](https://cursor.com/docs/agent-sdk/reference/subagents)。

**Codex CLI**。默认开启多代理，但源码里有明确的缺席约束常量：`DEFAULT_MULTI_AGENT_V2_NO_SPAWN_HINT_TEXT` 要求“除非用户显式要求子代理、委派或并行工作，否则不要派生”。同一份提示里另有鼓励并行以省时间的表述，二者并存，实际行为取决于模型权衡。子代理继承父轮次的 sandbox 与 approval 设置，自定义 agent 文件不能覆盖。来源：[subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[spawn.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)。

**OpenCode**。派发工具的提示文本把它写成两条可用信号：`description` 里写了应主动使用，就应尽量主动；同时鼓励在一轮里并发多个子代理。权限是结构化路由：父代理 `permissions` 中用 `action=subagent`、`resource=<agent-id>` 决定能启动哪些；内建 `general` 子代理被禁止再派生。v1 `task` 与 v2 `subagent` 的工具名与参数不同，读旧资料会踩坑。来源：[tools](https://opencode.ai/docs/tools/)、[agents](https://opencode.ai/docs/agents/)、[task.txt](https://github.com/anomalyco/opencode/blob/03bba464/packages/opencode/src/tool/task.txt)。

**Gemini CLI**。唯一在“模型自主判断”之外还有可审计策略层的产品：`PolicyEngine` 在 `invoke_agent` 调用时读取 `args.agent_name` 并注入为虚拟工具别名参与规则匹配，规则可带 `subagent` 字段只对某个子代理发起的调用生效，内置 `agents.toml` 有一条 `invoke_agent → allow`。另有统一工具取代了早期“每个 agent 一个同名工具”的做法，而官方 `docs/core/subagents.md` 仍写旧形态，属于文档滞后于源码。来源：[agent-tool.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/agent-tool.ts)、[policy-engine.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/policy/policy-engine.ts)、[subagents 文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md)。

**Cline**。两层结构：一层是 `spawn_agent` 派生的会话级子代理（继承当前模式的内置工具，不获得 MCP 工具，可再派生）；另一层是 Agent Teams，由 coordinator 通过 `team_delegate_task` 一类工具给专家代理派活，共享任务板、邮箱与 mission log，可 `/team` 显式开启，也可能由产品自行组团。安全边界有明确取舍：批准一次 `spawn_agent` 即批准其后续全部工具调用。来源：[subagents](https://docs.cline.bot/features/subagents)、[agent teams](https://docs.cline.bot/cli/agent-teams)。

**Amp**。把子代理当作普通工具：`Task` 执行完整委派任务、`Read Thread` 读其他线程，插件式子代理（oracle 等）安装后以独立工具名出现。官方直接表述为 Amp 自行决定何时使用；子代理拿主代理给的指令而非整段会话，彼此不能通信，只回最终摘要，可继续追加任务。来源：[tools](https://ampcode.com/docs/tools)、[models-and-subagents](https://ampcode.com/docs/models-and-subagents)。

**DeepSeek Harness**。机制契约最完整：受管子代理树，有深度上限、命名规则、`parent` 与 `caller` 两种结果投递、持久子代理目录、消息与中断的祖先权限。触发仍是模型调用工具，Team 工具在其上叠加共享任务与策略。来源：[subagent.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)、本地记录 [deepseek-harness.md](deepseek-harness.md)。

**Lancer**。在产品层做递归子分支与父会话汇总，架构文档列出宿主侧 Orchestration owner 负责 child-thread 策略、监督与编排工具，属于“策略在宿主、触发在模型”。来源：[architecture.md](https://github.com/raylee-ai/lancer/blob/main/docs/architecture.md)、本地记录 [lancer.md](lancer.md)。

## 共性结论

1. **委派一律是普通工具**。九个产品里没有一个用关键词匹配或正则做路由；判定主体都是主模型，差异只在提示文本与是否额外加策略层。
2. **“何时用”写在两处**：系统/工具提示里的主动性与缺席约束（Codex 的常量、OpenCode 的 proactive 措辞、Gemini 的 instructed to use），以及每个子代理自己的 `description`（Claude Code、Cursor、OpenCode 都明确要求描述质量）。前者决定默认倾向，后者决定匹配精度。
3. **没有“每子代理一个工具”的形态**。早期 Gemini 曾为每个 agent 生成同名工具，后来合并为 `invoke_agent`；其余产品从一开始就是单工具 + 类型/名称参数。把类型拆成多个工具在主流实现中缺少先例。
4. **并行都靠“同一轮多次工具调用”**，需要结果的语义由产品自己加（Claude 的 `async_launched`、OpenCode 的 `background`、Codex 的 `wait_agent`）。没有一家做多轮排队调度。
5. **编排层只在两类产品出现**：Cline 的 Agent Teams 与 Lancer 的 Orchestration owner，都引入了持久共享状态（任务板、数据库）。单层委派的产品都不做这件事。

## 与 pi-desk 的对照

| 维度 | 当前实现 | 与主流的关系 |
| --- | --- | --- |
| 派发入口 | 单一 `delegate_subagent`，四类任务用 `subagent_type` 区分 | 实质重合：与 Claude Code、Cursor、OpenCode、Codex、Amp 同构 |
| 主动性来源 | 系统提示产品分段给出四条时机与三条反例；工具 `promptGuidelines` 按类型写边界 | 部分重合：主动性开关到位，但每类边界此前只在系统提示里，工具侧只有类型名 |
| 路由层 | 无；`executionMode: sequential`，无规则或策略判定 | 与多数产品一致；缺的是 Gemini 那类可审计策略层（本项目没有对应策略引擎） |
| 进程与权限 | 独立子进程 + `--tools` 白名单 + 文档写入守卫 + 不继承用户扩展（调研任务显式 `-e` 加载 `pi-web-access`） | 对方独有：Claude Code/Cursor 无 OS 级进程隔离；本项目独有：进程参数强制而非提示词劝阻 |
| 并行 | 单次调用内 `tasks[]` 批量、批内并发上限 3；调用之间串行 | 部分重合：批内并行等价于对方“同轮多次调用”，但缺后台执行与按任务续派 |
| 续派与父子登记 | 无：子任务生命周期等于一次工具调用，父级中断收敛全部子进程 | 无对应：Claude Code 的 `agentId` resume、Cursor 的 agent ID resume、DSH 的受管树都超出当前边界 |
| 编排层 | 无 | 无对应：Cline Teams / Lancer 的编排依赖持久任务板，与“不做递归、无父子登记表”的既定边界冲突 |

## 可借鉴方向

| 方向 | 可行性 | 依据与代价 |
| --- | --- | --- |
| 每类任务一段“何时用/何时不用”边界（工具侧） | 高 | 纯文本改动，落在 `subagent_type` 描述与 `promptGuidelines`；不需要动执行链，与 Claude Code/Cursor 把边界写在 description 的做法一致 |
| 把 `subagent_type` 作为策略键（Gemini 式） | 中 | 需要先有工具级策略或审批层；本项目现有 skill-guard 只管技能登记，没有 PolicyEngine，需另行设计，属于新产品能力 |
| 后台执行 + 按任务 ID 续派 | 中偏高 | 需要父子登记表与会话状态；现有边界是“子任务生命周期等于工具调用”，改动面涉及宿主、投影与页面，不只是扩展 |
| 编排者层（Cline Teams / Lancer Orchestration owner） | 低 | 需要持久任务板、跨会话状态与恢复语义，与不做递归委派的既定边界冲突 |

## 未核实项

- Cursor 官方 “Agent includes all custom subagents in its available tools” 一句无法判定是描述注入单一 Task 工具还是逐个注册为工具；字段表写 `description` 显示在 “Task tool hints”，倾向前者。
- Claude Code 与 Cursor 都未公开 `description` 注入的确切位置（system prompt 还是工具描述）。
- Codex 各 intelligence 级别是否放开自主 fan-out：官方仅说明 ChatGPT Work 的 Ultra 档可主动委派，本地客户端未提及。
- Gemini CLI 是否存在隐藏的后台子代理路径；其策略引擎动态规则的完整优先级只读到片段。
- Cline Teams 的持久化路径在官方文档（`teams.db`）与仓库内 SDK 参考（`teams/<name>/*.json`）之间表述不一致。

## 信息来源

外部产品（均为官方文档或官方仓库文件，核对于 2026 年 11 月）：

- Claude Code：[sub-agents](https://code.claude.com/docs/en/sub-agents)、[agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- Cursor：[subagents](https://cursor.com/docs/subagents)、[agent-sdk/subagents](https://cursor.com/docs/agent-sdk/reference/subagents)
- Codex CLI：[subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[spawn.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)
- OpenCode：[tools](https://opencode.ai/docs/tools/)、[agents](https://opencode.ai/docs/agents/)、[task.txt](https://github.com/anomalyco/opencode/blob/03bba464/packages/opencode/src/tool/task.txt)
- Gemini CLI：[subagents 文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md)、[agent-tool.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/agent-tool.ts)、[policy-engine.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/policy/policy-engine.ts)、[agents.toml](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/policy/policies/agents.toml)
- Cline：[subagents](https://docs.cline.bot/features/subagents)、[agent teams](https://docs.cline.bot/cli/agent-teams)
- Amp：[tools](https://ampcode.com/docs/tools)、[models-and-subagents](https://ampcode.com/docs/models-and-subagents)
- DeepSeek Harness：[subagent.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- Lancer：[architecture.md](https://github.com/raylee-ai/lancer/blob/main/docs/architecture.md)

pi-desk 侧事实出处：`src/sdk-host/sub-agent/delegation-extension.ts`（派发入口、类型参数、工具白名单、批次并发、超时预算）、`src/sdk-host/product-tools-hint.ts`（委派时机分段）、`src/shared/sub-agent-types.ts`（权限矩阵与写入上限）、[子代理模块文档](../modules/sub-agent.md)。
