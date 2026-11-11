# WorkBuddy

返回 [开源项目参考](README.md)。本文是外部产品的参考记录，不是本项目的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 产品 | WorkBuddy（腾讯出品的 AI 办公工作台；Buddy AI 系列下与 CodeBuddy、CodeBuddy Code 同族） |
| 官网 | [workbuddy.cn](https://www.workbuddy.cn/work/)（国内站）／[workbuddy.ai](https://www.workbuddy.ai/)（国际站） |
| 文档 | [workbuddy.cn/docs/workbuddy](https://www.workbuddy.cn/docs/workbuddy/Overview)；开放平台 [open.workbuddy.cn/docs](https://open.workbuddy.cn/docs/expert) |
| 仓库 | 闭源，无公开仓库与开放源码 |
| 定位 | 用自然语言下达任务，自主拆解规划并交付文档、表格、PPT 等可验收成果；以「专家 / 专家团」组织角色化与多智能体协作 |
| 分发形态 | Windows x64（兼容 ARM64）、macOS 12.0+（Intel 与 ARM64）、Linux（UOS／银河麒麟走系统应用商店）；另有网页版、移动端 App、小程序与 IM 助理（微信、企业微信、QQ、飞书、钉钉）入口 |
| 版本快照 | 客户端更新日志最新条目为 5.11.0（2026-11-03，灰度中）；其上一条为 5.5.1（2026-09-02） |
| 计费 | 体验版免费，标准／高级／旗舰三档订阅，按积分消耗；专家团积分消耗约为单专家的 3–5 倍（官方口径） |

以上形态与版本核实于 2026-11-10，仅为快照。

## 界面截图

官方文档页内的专家卡片、专家团卡片与工作界面截图（直链，不在本仓库保存副本，图注依据官方相邻正文撰写）：

- 工作界面区域：`https://download.codebuddy.cn/web/docs/4e3f659462571e5bf57532423dabe302ee07e013/docs/static/overview-ui-areas.si-lsnLi.png` —— 官方标注为「WorkBuddy 工作界面区域标注」，含工具栏、侧边栏、对话区、结果区四块。
- 专家卡片：`https://download.codebuddy.cn/web/docs/4e3f659462571e5bf57532423dabe302ee07e013/docs/static/expert-3.D-D3lWdi.png` —— 官方正文说明专家卡片展示能力介绍、擅长领域、任务示例，并给出使用量与开发者信息。
- 专家团卡片：`https://download.codebuddy.cn/web/docs/4e3f659462571e5bf57532423dabe302ee07e013/docs/static/expert-2.Ccrh5U1L.png` —— 官方正文说明专家团卡片在专家卡片之外另显示团队成员与版本。

截图核实于 2026-11-10；上游改版可能使直链失效，届时需回看修正。

## 许可与来源性质

WorkBuddy 为闭源商业产品，没有可读源码、也没有可复用的许可授予。因此本文：

- 只记录官方文档、开放平台规范与官方发布记录所描述的**公开行为**，不涉及任何代码移植或实现细节推导；
- 不写许可证条款、Star／Fork／Issue 统计与 Release 产物清单；
- 不据产品表现排名实现质量；客户端内部实现（框架、进程模型、存储格式）无官方说明时一律标注未核实；
- 定价、积分与订阅条款属商业信息，只在影响对照结论（成本差异）时提及，不作为能力判据。

## 技术栈

| 层 | 组成 |
| --- | --- |
| 客户端 | 桌面安装包覆盖 Windows／macOS／Linux，另有网页版、移动端与小程序入口。客户端框架与进程模型未在官方文档说明，**未核实** |
| 扩展面（专家与技能） | 专家包 = `.codebuddy-plugin/plugin.json`（运行配置 + 市场展示字段）+ `agents/*.md`（YAML frontmatter 声明 `maxTurns`、`skills`，正文即系统提示）+ `avatars/`。工具权限不由包作者声明，由系统按专家类型统一分配 |
| 协议面 | MCP（远程 SSE／Streamable HTTP）与 WorkBuddy 连接器；依赖在专家包内声明（`dependencies.mcpServers`／`dependencies.connectors` 或根目录 `.mcp.json`），召唤时按需引导授权 |
| 编排层（CLI 侧） | CodeBuddy Code 的 Dynamic Workflows：模型现场生成一段 JavaScript 编排脚本，运行时在后台执行；会话保持响应。同一产品线的 Agent SDK（JS／Python）在发布记录中出现版本号 |
| 沙箱 | 确定性沙箱：禁 `Date.now`、`Math.random`、动态字符串求值与动态 Function 构造，无 `require`／`process`／`Buffer`。脚本本身无文件系统与 Shell 能力，读写与执行全部由子代理完成 |

组件与能力的对应关系：专家包决定「以什么身份、带哪些技能、能拉哪些外部服务」；Workflows 决定「谁来决定下一步」——把计划从模型逐轮决策挪进脚本。

## 能力清单

按官方文档分组记录，不自创分类。

| 分组 | 能力 |
| --- | --- |
| 专家中心 | 侧边栏「专家·技能·连接器」进入；推荐位（使用热度、新上架、编辑精选）；按 15 个行业分类浏览专家与专家团；卡片展示能力介绍、擅长领域、任务示例、使用量、开发者信息（专家团另显团队成员与版本）；召唤后从该专家引导提示词中随机取一条作为开场 |
| 我的专家 | 对话式创建（头像与显示名称、人设身份、擅长领域、提示词）；修改、分享（生成链接，受分享方拿到的是副本）、删除。名称创建后不可修改，删除不可恢复 |
| 专家包结构（开放平台） | `plugin.json` 必填字段含 `name`、`expertType`（`agent`／`team`）、`version`、`description`、`author`、`agents[]`、`agentName`、`displayName`、`profession`、`displayDescription`（中文 40–50 字）、`avatar`、`categoryId`、`defaultInitPrompt`、`plugin`、`tags`（固定 3 个）、`quickPrompts`（固定 3 个）；`expertType: "team"` 时补 `teamInfo{leadAgent, memberAgents[]}` |
| MCP 与连接器依赖 | `dependencies` 或 `.mcp.json`；`x-workbuddy` 私有元信息负责引导卡片的名称、描述、图标与鉴权方式（`oauth`／`token`／`none`），`token` 类型用 `tokenSchema` 声明表单字段与 `${VAR}` 占位；连接后凭据由用户本地保存，不写入最终连接器配置 |
| 专家团 | 由多位专家分工协作，团长自动拆解任务、并行执行、整合交付；召唤前若依赖服务未连接，输入框上方出现连接引导卡片，连接完成后自动继续当前任务。专家团会话中改召唤其他专家会提示需开启新对话 |
| Agent Teams（CLI 侧同一团队能力） | team-lead + teammates，成员拥有独立上下文窗口且可**直接互发消息**（`message`／`broadcast`／`shutdown_request`／`shutdown_response`／`plan_approval_response`）；共享任务列表三态（待处理／进行中／已完成）带依赖解阻塞与自主认领；`@成员`／`@all` 直达；进程内运行；数据落 `~/.codebuddy/teams/{team}/config.json`、`inboxes/{member}.json` 与 `~/.codebuddy/tasks/{team}/` |
| Dynamic Workflows | 模型现场写 JS 编排脚本，运行时执行；脚本 API 为 `agent(prompt, options?)`、`parallel()`、`pipeline()`、`phase()`、`log()`、`args`、`workflow()`（仅父级可嵌套调用）；中间结果留在脚本变量，不进会话上下文；脚本写入会话目录文件，可读、可改、可 diff 后重跑 |
| Workflows 观察与控制 | `/workflows` 按阶段（phase）展示代理数量、Token 总量与耗时，可下钻到单个代理的提示、工具调用与结果；`p` 暂停／恢复、`r` 重启选中代理、`x` 中止代理或整个 run、`s` 把 run 保存为命令（项目级 `.codebuddy/workflows/` 优先于用户级 `~/.codebuddy/workflows/`）；保存后的命令通过 `args` 接收参数 |
| Workflows 约束 | 单次 run 最多 16 个并发代理（核数少时更少）、最多 1000 个代理；运行中不接受用户输入，唯一暂停点是代理的权限询问；恢复仅限同一会话内（已完成代理走缓存），退出后从头跑 |

同名词的其他两层（不属于本次对照的「工作流」基准，仅作区分）：

| 名称 | 是什么 | 出处 |
| --- | --- | --- |
| Playbook（企业侧） | 预配置的**工作流模板**，由名称、模型、Agent ID 与 System Prompt 组成，面向不写提示词的泛开发者 | 企业文档「Playbook」 |
| 自动化 | 定时任务：表单创建或对话创建，按每天／每周／每月频率执行，支持立即运行、编辑、重命名、删除与启停 | 客户端文档「自动化」 |

未核实：客户端内是否存在与 CLI 同名的可视化工作流节点编排。官方 `docs/workbuddy` 侧未见该模块的文档页，网络上流传的「可视化节点编排」均出自第三方站点，不作为事实。

### 名词约定

| 术语 | 对方原文 | 含义 |
| --- | --- | --- |
| 专家 | Expert | 角色切换机制：人设 + 方法论 + 工具链；包内是一份 Agent 定义文件 |
| 专家团 | Expert Team | 协作执行机制：团长（leadAgent）拆解、团员（memberAgents）并行、团长整合 |
| 技能 | Skill | 提供执行能力的工具包；可随专家包预加载 |
| 连接器 | Connector | 平台已上架的第三方服务接入（如腾讯文档、飞书）；与自带 MCP 并列作为依赖声明对象 |
| 主理人 | leadAgent | 专家团中负责拆解与整合的团长 Agent，唯一可用 `AgentTool` 与 `SendMessage` |
| 团队成员 | teammate | 独立上下文窗口的 Agent 实例，与团长、其他成员可直接通信 |
| 阶段 | phase | 工作流脚本的编排标注单位，观察面板按阶段聚合代理数、Token 与耗时 |
| ultracode | ultracode | 组合开关：推理强度 `xhigh` + 自动把有分量的任务规划成 Workflow；仅当前会话生效 |

## 与本项目的对照

总体结论：**1 项实质重合**（技能），**1 项部分重合**（委派与多智能体协作），**6 类对方独有**。本项目的技能登记门禁与记忆写入审批在已核实的官方文档中未见等价描述，资料不足以判定对方「没有」，故不列入「无对应」。

### 实质重合

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| 技能（Skill）：随包与用户级技能目录加载，正文作为可复用指令 | 技能（Skill）：可随专家包 `skills[]` 预加载，也在市场随专家分发 | 两边都是「给 Agent 一份可复用指令」的同一目标。差异在加载与治理：本项目带 `skill_guard_select` 登记、必读引用完整加载核对与修改类工具阻断（`resources/agent/extensions/skill-guard/`）；对方文档只描述技能作为工具能力包使用，未描述等价的加载核对与阻断机制（**未核实**是否存在） |

### 部分重合

| 本项目能力 | 对方对应 | 差异 |
| --- | --- | --- |
| 子代理委派 `delegate_subagent`（四类子任务、`tasks[]` 批内并行、独立子进程、能力白名单与写入守卫） | 专家团（团长 + 团员）与 CLI 侧 Agent Teams | 输入都是「一份主任务拆成若干可并行子任务」，输出都是「汇总回主对话的结论」，但协作层不同：本项目每次委派是**一次工具调用对应一个独立子进程**，任务说明不注入父会话历史，子进程没有委派工具因此不能递归，产出以有界快照回到主上下文；对方团队成员是**进程内常驻实例**，共享任务列表可认领、依赖完成自动解阻塞，成员之间可直接发消息与广播，存在团队生命周期（开启、关闭、清理）与计划审批。边界控制也不同：本项目用 `--tools` 白名单 + 进程参数 + 逐任务预算强制；对方团队成员默认继承领导的权限模式（委派模式下领导只剩协调工具，但成员改用完整工具访问），Workflow 派出的子代理则固定 `acceptEdits` 并继承工具白名单 |

两种形态的可判定差异（已确认事实与推断分开）：

- 已确认事实：本项目子进程不继承父会话历史，也不能递归委派；对方成员不继承领导的对话历史，但彼此可直接通信。
- 已确认事实：本项目写入范围在派发阶段即校验 `write_scope`（1–8 项、限 `docs/` 与根 `README.md`）并由守卫扩展在子进程内按真实路径二次拦截；对方对成员的文件冲突只有文档层面的「拆分时确保各成员负责不同文件集合」。
- 设计推断：成员互通更适合需要相互质疑、交叉验证的任务，代价是协调开销与 Token 随成员数增长；一次性子进程更适合结果导向的聚焦任务，代价是无法在子任务之间转手中间结论。
- 未量化对比：双方均未公布并行效率或 Token 效率数据。第三方实测称专家团单次任务约 220+ 积分、约为单专家 3–5 倍，与官方 3–5 倍口径一致，但属二手测量，不作能力结论。

### 对方独有

| 类别 | 能力 |
| --- | --- |
| 角色化专家与市场分发 | 15 个行业分类的专家市场、推荐位、使用量与开发者信息；专家包规范（`plugin.json` + `agents/*.md`）与上架、链接分享（受分享方得到副本） |
| 多智能体团队 | 专家团团长拆解—团员并行—团长整合；召唤前的依赖连接引导，连接后自动继续任务 |
| 成员协作机制 | 成员间直接消息与广播、共享任务列表（三态 + 依赖解阻塞 + 自主认领）、成员计划审批、团队关闭与清理、委派模式（领导仅保留 `Agent`／`TaskStop`／`SendMessage`／`AskUserQuestion`／`StructuredOutput`） |
| 脚本化编排 | 模型现场编写 JS 编排脚本作为「计划」的载体；`agent()`／`parallel()`／`pipeline()`／`phase()`／`log()`／`args`／`workflow()` |
| 运行观察与控制 | `/workflows` 按阶段聚合代理数、Token、耗时并可下钻；暂停／恢复、单代理重启与中止、整 run 中止；run 保存为命令并在项目级与用户级之间定优先级 |
| 自动编排入口 | 关键词 `ultracode` 与 `/effort ultracode`（xhigh + 自动编排），会话级生效，可按配置或环境变量整体关闭 |

### 对方短板（不列入借鉴方向）

官方自述的已知限制：团队无会话恢复（`/resume`、`/rewind` 不恢复成员）、任务状态可能滞后导致依赖阻塞、成员关闭较慢、每个会话只能管理一个团队、不支持嵌套团队、领导角色不可转让、成员权限在生成时确定。产品侧另有：专家名称创建后不可改、删除不可恢复；专家团成本显著高于单专家。

## 可借鉴方向

借鉴范围只指功能方向与产品形态，不参考对方任何实现代码。

| 方向 | 可行性 | 说明 |
| --- | --- | --- |
| 专家包／技能包内的依赖声明，与召唤前的授权引导 | 高 | 本项目已有 MCP 配置、资源包清单（`resources/agent/bundle.json`）与信任页；缺的是「声明依赖 → 召唤时逐个引导授权 → 授权后自动继续」的契约与 UI，不引入外部组件 |
| 阶段（phase）聚合的运行观察 | 高 | 现有子代理快照契约（`src/shared/sub-agent-view.ts`）已按工具开始／结束实时推送，`SubAgentCard.vue`／`SubAgentDialog.vue` 已能展示批次与单项；增加阶段标记与整批中止不需要新依赖 |
| 工作流 run 保存为可复用命令 | 低 | 依赖脚本化编排运行时；另需命令注册、`args` 传参与项目级／用户级优先级，属独立产品级设计 |
| 成员间通信与共享任务列表 | 低 | 需跨进程消息总线、共享任务状态机与成员生命周期管理；与「一次工具调用＝一次委派」的现有委派模型差异大，需重新设计执行模型 |
| 确定性沙箱的脚本化编排运行时（`agent()`／`parallel()`／`pipeline()`） | 低 | 需新增编排运行时与沙箱（禁时间、随机、动态代码生成），并把现有子代理进程当作 `agent()` 原语；权限模型与预算口径都要重新设计 |

## 信息来源

### 对方官方资料

- WorkBuddy 简介：<https://www.workbuddy.cn/docs/workbuddy/Overview>
- 专家（客户端功能页，含专家 / 技能 / 专家团对比、创建与管理、积分提醒）：<https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Expert-Center>
- 开放平台专家包配置说明（`plugin.json` 字段、`agents/*.md` frontmatter、工具分配、MCP 与连接器依赖、`categoryId` 分类）：<https://open.workbuddy.cn/docs/expert>
- CodeBuddy Code — Dynamic Workflows（脚本 API、约束、确定性沙箱、观察与控制、保存复用、权限与关闭方式）：<https://www.workbuddy.ai/docs/zh/cli/workflows>
- CodeBuddy Code — Agent Teams（团队结构、消息类型、共享任务列表、委派模式、数据位置、已知限制）：<https://www.workbuddy.ai/docs/zh/cli/agent-teams>
- Playbook（企业侧预配置工作流模板）：<https://www.workbuddy.cn/docs/enterprise/216127597664321536>
- 自动化（定时任务）：<https://www.workbuddy.cn/docs/workbuddyapp/features/Auto>
- 更新日志（版本快照）：<https://www.workbuddy.cn/docs/workbuddy/Changelog>
- CodeBuddy Code v2.105.0 发布说明（Workflow 工具与 `/workflows` 面板的首发条目、Agent SDK 版本）：<https://www.workbuddy.cn/docs/cli/release-notes/v2.105.0>
- 定价详情（订阅与积分口径）：<https://www.workbuddy.cn/docs/workbuddy/Pricing>
- 官网与分发形态：<https://www.workbuddy.cn/work/>、<https://www.workbuddy.ai/>

以上官方页面核实于 2026-11-10。

### 第三方资料（仅作线索，不作关键结论依据）

- 专家与专家团实测（专家团 Beta、单次约 220+ 积分）：<https://www.xmsumi.com/detail/3230>
- 专家 / 专家团开发规范（团员 `SendMessage` 回传要求等实践中约定）：<https://wangjunjian.com/posts/2026-09-09-workbuddy-expert-dev-spec/>

### 本项目事实出处

- 子代理委派的能力边界、批次并行、进程参数、写入守卫与快照契约：`docs/modules/sub-agent.md`；实现见 `src/sdk-host/sub-agent/delegation-extension.ts`、`src/sdk-host/sub-agent/write-guard.ts`、`src/shared/sub-agent-view.ts`
- 技能登记门禁（登记沿用、必读引用加载核对、修改类工具阻断）：`docs/modules/skill-guard.md`；实现见 `resources/agent/extensions/skill-guard/`
- MCP 与资源包：`docs/modules/resources-mcp.md`、`resources/agent/bundle.json`
- 过程可见性（待办清单）：`src/renderer/src/sessions/components/TodoPanel.vue`
