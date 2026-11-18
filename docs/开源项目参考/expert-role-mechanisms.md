# 会话角色与多角色协作机制（专题对照）

本文件是**专题对照**，不属于单项目记录：把多个成熟产品「怎样定义一份可召唤的角色、角色能改哪些能力、多角色怎样协作」的做法放在同一组表里比较，用于判断 pi-desk 专家体系的现有设计与阶段六「专家团」的方向。单项目明细仍以各项目文件与官方文档为准，索引见 [README](README.md)。

核实时间：2026 年 11 月。DeepSeek Harness 的 Profile 与 Agent Teams 契约于 2026-11-18 直读官方仓库文档；其余产品按各自项目文件的核实日期引用（WorkBuddy 2026-11-10/12、EvoFlow 2026-11-06、Cline 2026-11、Ekko Studio 2026-11-06、OpenBitFun、TencentDB Agent Memory、ZCode 见各文件）。标注「未核实」的部分本次没有取到可点开的官方原文，不以推测补全。

## 对照表

| 产品 | 角色载体 | 绑定粒度 | 能力范围由谁声明 | 多角色协作 | 关键限制 |
| --- | --- | --- | --- | --- | --- |
| WorkBuddy（专家） | 专家包：`.codebuddy-plugin/plugin.json`（运行配置与市场字段）+ `agents/*.md`（frontmatter 声明 `maxTurns`、`skills`，正文即系统提示） | 会话级；换专家需新开对话 | 技能由包声明；**工具权限不由包作者声明，由系统按专家类型统一分配**；MCP 与连接器在包内声明依赖，召唤时引导授权 | 专家团单独一层，见下行 | 名称创建后不可改、删除不可恢复 |
| WorkBuddy（专家团 / CLI Agent Teams） | `expertType: "team"` + `teamInfo{leadAgent, memberAgents[]}`；CLI 侧为 team-lead + teammates | 团队级：一个会话只管理一个团队 | 成员权限在生成时确定；委派模式下领导仅保留 `Agent`／`TaskStop`／`SendMessage`／`AskUserQuestion`／`StructuredOutput` | 团长拆解、团员并行、团长整合；CLI 成员有独立上下文窗口，可 `message`／`broadcast`／`shutdown_request`／`plan_approval_response`，共享任务列表三态带依赖解阻塞与自主认领，`@成员`／`@all` 直达，进程内运行 | 不支持嵌套团队、领导角色不可转让、团队无会话恢复、成员关闭较慢；专家团成本约为单专家 3–5 倍 |
| EvoFlow | 「智能体」= 人设、模型、工具、Skill 与连接器（MCP）的能力配置 | 智能体按单次 `@` 使用 | 由智能体配置声明（人设与能力并列） | 「员工」另行承载岗位、职责、值班、转交审批、汇报、预算；另有项目团队与 Goal 控制面 | 员工与项目团队依赖组织级账号、IM 与调度，属平台能力 |
| dsh-superagent | DSH preset：主会话 `dsh-superagent-router`、每工单 `worker-<工单 id>` | 工单级：一张工单一个会话与目录 | preset 随包固定；团队可编辑三段提示词（沟通、工单范围、交付要求）与团队技能，可覆盖每项内置提示分段 | 不共享会话：派工把工单交给执行器，订阅把后续讨论直接投递；worker 槽位有并发上限，另留一个人用槽位 | 定位为研究原型；执行器以 operator 的 OS 用户全权限运行 |
| DeepSeek Harness | Profile = 命名插件组合（`web`／`headless`／`sdk`／`sdk-minimal`／`acp` 为模板），bundle + patch 按 row id 替换或插入 | Profile 级配组合；Agent Teams 绑**根会话** | 能力由当前 Profile 的插件树决定；`permission`／`approval`／`sandbox-policy`／`fs-sandbox` 是组合层独立插件，不由角色声明 | Agent Teams：`TeamId` 绑定根 `SessionId`，共享任务 DAG（`blockedBy` 必须无环、`revision` 做 CAS），成员间走普通子代理消息；模式按根会话开启，新会话默认关闭，只有根能 `setEnabled`，后代共享 | `writeScopes` 是规范化后的**提示性**路径前缀而非锁，并发写冲突仍靠成员自律；历史 roster 与 mailbox 仅供解码，不授予权限 |
| Cline | 模式 + 子代理定义；Agent Teams 由 coordinator 牵头 | 会话级子代理、团队级协调者 | 子代理继承当前模式内置工具、拿不到 MCP 工具；团队派活走 `team_delegate_task` | 两层：`spawn_agent` 派生的会话级子代理（可再派生）；Agent Teams 共享任务板、邮箱与 mission log，可 `/team` 显式开启 | 批准一次 `spawn_agent` 即批准其后续全部工具调用 |
| Ekko Studio | Agent 定义 | 房间级：同一房间可添加多个不同 Agent | 由各 Agent 定义声明 | 群聊房间 + `@提及` 路由驱动上下文回复，历史超限自动压缩摘要 | 多 Agent 上下文与路由状态复杂度高；主体为 BSL 1.1 源码可见许可 |
| OpenBitFun | 四档 Harness 协作模式：Minimal／Standard／Ultimate／Creative | 会话级模式 | 模式预设决定执行框架 | Ultimate 模式下多 Agent 分工协同与整合，配任务看板 | 是执行强度预设而非角色定义，没有「一份可召唤的身份」 |
| TencentDB Agent Memory | L3 Persona 是**用户画像**提炼，不是会话角色；Team／Agent／Task 是资产隔离维度 | 资产级多租户 | 资产归属由 Team／Agent／Task 划分 | 不提供会话内多角色协作 | 角色语义缺位：画像与角色是两件事 |
| ZCode | 无会话角色机制 | — | 最接近的是子代理定义文件的 `tools`／`mcpServers` 裁剪（委派维度，不是会话角色） | 无 | 会话无角色绑定，故对照中「专家体系为本项目独有」 |

## 逐产品要点

**WorkBuddy**。专家是「人设 + 方法论 + 工具链」的一份 Agent 定义文件，与本项目 `expert.md` 同构；差别在能力范围的声明位置——它的工具权限由系统按专家类型统一分配，包作者只能通过 frontmatter 声明 `maxTurns` 与 `skills` 并声明 MCP／连接器依赖。团队层用 `leadAgent` + `memberAgents[]` 表达，团长拆解、团员并行、团长整合；成员权限在生成时确定，不支持嵌套团队与领导转让，也没有团队会话恢复。CLI 侧同一能力落成 team-lead + teammates，成员拥有独立上下文窗口且可直接互发消息，共享任务列表为三态并带依赖解阻塞与自主认领。来源：[Expert-Center](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Expert-Center)、[专家包配置](https://open.workbuddy.cn/docs/expert)、[Agent Teams](https://www.workbuddy.ai/docs/zh/cli/agent-teams)（后一页本次未能取到原文，细节按本地记录 [workbuddy.md](workbuddy.md)）。

**EvoFlow**。把「会什么」与「岗位语义」显式分成两层：智能体配置人设、模型、工具、Skill 与连接器；员工另承载岗位、职责、值班、转交审批、汇报、预算。这一分层是外部产品里最明确的角色／岗位边界证据。来源：[产品总览](https://github.com/EvovexAI/EvoFlow/blob/main/docs/user/getting-started/product-overview.md)、本地记录 [evoflow.md](evoflow.md)。

**dsh-superagent**。角色由 preset 承载而不是独立角色文件；团队可编辑三段提示词并覆盖内置提示分段，每次保存生成不可变版本，上游默认文本升级时面板标 `Default updated` 并给出差异。执行侧一张工单一个会话与目录，槽位有并发上限并为人类预留一个。这是「提示词版本治理」的唯一完整先例。来源：本地记录 [dsh-superagent.md](dsh-superagent.md)、[002-authorization.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)、[003-execution.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)。

**DeepSeek Harness**。Profile 是启动期拼出的插件组合，patch 按 row id 整条替换或插入，`preset` 在 `config.plugins` 内应用同样层级；权限、审批与沙箱策略是组合层插件，与「角色」无关。Agent Teams 把团队绑到根会话：任务板用 `blockedBy` 有向无环图与 `revision` 比较并写表达依赖与并发，`writeScopes` 明确是提示性路径前缀而不是锁；成员之间走普通子代理消息，历史 roster 与 mailbox 只用于解码、不授予任何权限。来源：[architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[agent-team.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md)（均于 2026-11-18 直读）。

**Cline**。两层并存：会话级子代理继承当前模式的内置工具、拿不到 MCP 工具、可再派生；Agent Teams 由 coordinator 派活并共享任务板、邮箱与 mission log。它的安全取舍是明文写的：批准一次派生即批准其后全部工具调用。来源：[sub-agents](https://docs.cline.bot/features/subagents)、[agent-teams](https://docs.cline.bot/cli/agent-teams)、本地记录 [sub-agent-delegation.md](sub-agent-delegation.md)。

**Ekko Studio**。唯一把「同会话多角色」做成房间形态的产品：房间内添加多个不同 Agent，按 `@提及` 路由决定谁回、上下文超限自动压缩摘要。它证明同会话多角色可行，但代价是房间状态、路由与压缩三套新机制。来源：本地记录 [ekko-studio.md](ekko-studio.md)。

**OpenBitFun**。四档协作模式（Minimal／Standard／Ultimate／Creative）划的是执行强度，不是身份；Ultimate 才进入多 Agent 分工。它提示「模式」与「角色」是两个正交维度，不能互相替代。来源：本地记录 [openbitfun.md](openbitfun.md)。

**TencentDB Agent Memory**。L3 Persona 是从对话提炼的用户画像，Team／Agent／Task 是多租户资产隔离；两者都不构成会话角色。来源：本地记录 [tencentdb-agent-memory.md](tencentdb-agent-memory.md)。

**ZCode**。官方能力清单里没有会话语义的角色绑定，最接近的只是子代理定义文件对 `tools`／`mcpServers` 的裁剪，属委派维度。它是「会话级角色不是行业默认」的反证。来源：本地记录 [zcode.md](zcode.md)。

## 共性结论

1. **角色一律落在一个定义文件或一份配置上**。WorkBuddy 的 `agents/*.md`、EvoFlow 的智能体、DSH 的 Profile／preset、dsh-superagent 的 preset 都是同一形态：一份声明 + 一段正文。没有一家把角色做成纯运行时状态，也没有一家把它塞进集中式配置库。
2. **能力范围的声明位置有两派**。一派由作者声明（技能、MCP 依赖、子代理工具白名单）；另一派由平台统一分配——WorkBuddy 明说工具权限「不由包作者声明，由系统按专家类型统一分配」。后者把范围从作者手里收回，代价是平台要维护一套专家类型目录。pi-desk 属前者。
3. **绑定粒度只有三档，且团队级仍是委派**。会话级（WorkBuddy 专家、pi-desk 专家）、工单／任务级（dsh-superagent 一工单一会话）、团队级（WorkBuddy 专家团、DSH Agent Teams 绑根会话）。团队级内部仍是「根 / 领导 + 下级成员会话」，不是同一上下文里的多个身份。
4. **同会话多角色必须引入持久共享状态**。Ekko 用房间、WorkBuddy CLI Teams 与 Cline 用任务板 + 邮箱 + 消息通道；不做这套状态的 DSH 与 dsh-superagent 都把成员放进独立会话。这是一个二选一：要么加房间与路由，要么加成员会话与管理面板。
5. **岗位语义（值班、审批、预算、汇报）只出现在 EvoFlow，并与角色显式分层**。其余产品把角色当能力与身份，不承担组织职责。
6. **团队代价与限制高度一致**。成本 3–5 倍（WorkBuddy）、不支持嵌套、无会话恢复、成员权限在生成时确定（WorkBuddy）；并发写的冲突不靠锁，只靠提示性 `writeScopes` 与成员自律（DSH）。
7. **提示词版本治理只有 dsh-superagent 做到「不可变版本 + 上游默认升级差异」**；其余产品的角色正文要么不可版本化，要么由用户自己 diff。

## 与 pi-desk 专家体系的对照

基准为 [专家设计](../专家设计.md) 的现行设计与其列出的实现出处；外部事实见上表。

| 维度 | pi-desk 当前实现 | 与外部的关系 |
| --- | --- | --- |
| 角色载体 | `expert.md`（声明段 + 正文），解析在 `src/shared-process/expert-definitions.ts`，角色段装配在 `src/sdk-host/expert-role.ts` | 实质重合：与 WorkBuddy `agents/*.md`、DSH preset 同构 |
| 绑定粒度 | 会话级，首轮后锁定，绑定由打开链落盘；标识不可改，编辑不影响既有绑定 | 实质重合：与 WorkBuddy 专家同粒度；外部无「标识不可改」的同等约束（对方是名称不可改、改需重建） |
| 能力范围声明 | 三维（技能／MCP／工具），基线 `inherit`／`only` + 专家 `Add`／`Remove`，受保护工具不可排除（`src/sdk-host/expert-capability.ts`） | 部分重合：比 WorkBuddy「系统统一分配」更细，比 Cline／Cursor 式子代理白名单多一层全局基线与「仅用选中」口径 |
| 写入范围 | `writeScope` 三态（不写＝不限制、`[]`＝只读、列表＝白名单），宿主守卫只拦 `write`／`edit`（`src/sdk-host/expert-write-guard.ts`） | 无对应：外部同层产品里未见角色自带写入白名单；DSH 的 `fs-sandbox` 是平台级策略，Team 的 `writeScopes` 只是提示性前缀 |
| 多角色协作 | 无，一次会话一个专家 | 对方独有：群聊房间（Ekko）、任务板 + 邮箱（WorkBuddy CLI、Cline）、工单编排（dsh-superagent）、共享任务 DAG（DSH） |
| 提示段治理 | 正文可编辑、未知字段保留、派生副本不自动合并、超限截断 | 部分重合：dsh-superagent 有不可变版本与上游默认升级差异；本项目无版本与差异视图 |
| 创建方式 | 设置页表单人工编写 + 会话内草案卡片 | 对方独有：WorkBuddy 对话式创建（本项目按「人工配置」明确不做） |
| 分发 | 搬数据目录，无导出导入、无市场 | 对方独有：专家包分享链接、15 行业分类市场与推荐位 |

## 可借鉴方向

| 方向 | 可行性 | 依据与依赖代价 |
| --- | --- | --- |
| 阶段六以「团队 = 根会话 + 共享任务板 + 成员是独立会话」为中性起点 | 中 | DSH 的 `TeamTaskSnapshot`（`blockedBy` 无环、`revision` CAS、`writeScopes` 提示性前缀）与 WorkBuddy CLI 的三态任务列表同构。本项目已有独立子进程与写入守卫，缺持久任务板、成员管理与面板，属新产品能力 |
| 团队模式按根会话开启、默认关闭、只有根可改 | 高 | 纯装配期开关加一个随会话持久化的字段，与现有「专家绑定随会话落盘」同链路；DSH 的 `agentTeam.enabled`（新会话默认 false、后代共享）可直接对照 |
| 成员写冲突用提示性 `writeScopes` 展示而非加锁 | 高 | 本项目已有子代理 `write_scope` 守卫，可在任务板视图派生同一字段做告警；DSH 明确该字段是规范化提示性前缀，不是锁 |
| 专家正文的版本与上游差异视图（只展示、不合并） | 中偏低 | 与已定的「派生副本不自动合并」相容，但需要版本化写回与差异 UI，改动面大于当前定义文件形态 |
| 召唤前的依赖连接引导（声明依赖 → 逐个授权 → 授权后自动继续） | 中 | 本项目专家只声明能力范围、不声明包依赖；要先引入依赖声明字段，再把 MCP 授权与继续执行串起来 |
| 同会话多角色群聊路由 | 低 | 与「一次会话一个专家」冲突，需要房间状态、路由与上下文压缩三套机制；本项目已明确不做 |
| 岗位语义（值班／审批／预算／汇报） | 低 | 需组织账号、IM 与常驻调度；与单用户桌面定位不符，只作概念边界，不进范围 |

## 未核实项

- WorkBuddy Agent Teams 页（`workbuddy.ai/docs/zh/cli/agent-teams`）本次抓取返回 CodeBuddy 编辑器页，消息类型、数据目录与委派工具清单按本地记录核实于 2026-11-10，本次未重新核实原文。
- Cline Teams 的持久化路径在官方文档（`teams.db`）与仓库内 SDK 参考（`teams/<name>/*.json`）之间表述不一致（本地记录已标注）。
- EvoFlow「员工」的预算与审批落在会话层还是组织层未核实；本地记录已标注组织级保证未核实。
- 把 DSH 的 Profile 等同为「角色」属设计推断：官方只把它描述为插件组合，未使用角色语义。
- ZCode 是否存在未公开的角色配置：仅据官方能力清单与本地记录判定「无会话角色机制」。
- WorkBuddy 工具权限「按专家类型统一分配」的具体类型清单与分配规则未公开，无法判断其收窄粒度。

## 信息来源

一手（官方文档、仓库文件、官方功能页）：

- DeepSeek Harness：[architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[subsystems/agent-team.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md)（直读于 2026-11-18）
- WorkBuddy：[Expert-Center](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Expert-Center)、[开放平台专家包配置](https://open.workbuddy.cn/docs/expert)、[Agent Teams](https://www.workbuddy.ai/docs/zh/cli/agent-teams)（核实于 2026-11-10/12）
- EvoFlow：[product-overview.md](https://github.com/EvovexAI/EvoFlow/blob/main/docs/user/getting-started/product-overview.md)（核实于 2026-11-06）
- dsh-superagent：[002-authorization.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)、[003-execution.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)（核实于 2026-11）
- Cline：[subagents](https://docs.cline.bot/features/subagents)、[agent teams](https://docs.cline.bot/cli/agent-teams)（核实于 2026-11）
- Ekko Studio、OpenBitFun、TencentDB Agent Memory、ZCode：官方仓库与官方文档，见各自项目文件的「信息来源」节（核实于 2026-11-06 至 2026-11-12）

本项目侧事实出处：[专家设计](../专家设计.md)、`src/shared-process/expert-definitions.ts`、`src/sdk-host/expert-role.ts`、`src/sdk-host/expert-capability.ts`、`src/sdk-host/expert-write-guard.ts`、`src/main/sessions/expert-files.ts`。

二手（本次未把媒体与第三方实测作为结论依据）：WorkBuddy 专家团成本口径来自官方文档自述，第三方实测仅在本项目记录中标注为二手测量，未用于本文件的判断。
