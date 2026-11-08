# dsh-superagent

返回[开源项目参考](README.md)。本文记录 DeepSeek Harness 团队的 `deepseek-ai/dsh-superagent-prototype`，是外部项目的参考记录，不是 pi-desk 的模块文档。它属于 [DeepSeek Harness（DSH）](deepseek-harness.md) 生态：以 DSH bundle 形式发布，不由 DSH 主仓库提供。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) |
| 官网 | 无；仓库 `description` 为 “Towards a More Autonomous Agent System”，与配套设计文章同名 |
| 文档 | 仓库内 `docs/000-philosophy.md` 至 `008-cookbook.md`，按序阅读；另有 `SETUP.md` 供编码 Agent 执行的安装流程 |
| 定位 | 面向单个 GitHub 仓库的主动式编码 Agent，打包为 DSH bundle：监听 GitHub（可选飞书），把获准的请求变成工单，每单在独立会话与目录中执行，回到原对话交付。以“人花在监督上的注意力尽可能少”为设计尺度 |
| 自述状态 | README 首段写明“research prototype for reference only, not an official DeepSeek product”，代码多数由编码 Agent 完成，且与内部版本、设计文章描述的实现并不相同 |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `main` |
| 最新 Release | `releases/latest` 返回 404、`tags` 为空；没有正式发布标签。包版本 `0.1.0`、`private: true` 是源码包版本，不冒充发布版本 |
| Star / Fork | 21,057 / 2,508 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 0，仓库 `has_issues` 为 false；不解读为没有缺陷 |
| 分发形态 | DSH bundle（`cordis.patch.yml` 插件补丁 + 构建产物）；运维靠仓库内启停脚本；面板注入 DSH Web 侧栏 |
| 提交数 | 1 个：`8c32a9d`，2026-10-31 |

以上版本与统计核实于 **2026-11-08**，仅为快照，来源为[仓库 API][s-meta]、[Release API][s-release]、[提交列表][s-commits]与[包声明][s-pkg]。二手来源对 Star 数的叙述互相矛盾（9k／10.5k／11.4k），本文只采用 API 快照。

## 界面截图

该仓库**没有可直链的官方截图**：2026-11-08 核实文件树中 png、jpg、webp、gif、svg 共 0 个，README 与技术文档均为纯文本。面板形态只能依据官方 [005 面板][s-doc5] 的文字描述（六个页签、三问排序），因此本节不列图片，也不以社区项目截图代替官方素材。

## 许可证

[根 LICENSE][s-license] 为 MIT，版权方 DeepSeek Harness Team（2026）。允许使用、修改、分发及商业使用，分发副本或实质部分需保留版权与许可声明；软件按现状提供。根许可未声明任何目录例外，仓库 API 的 MIT 识别与实际文本一致。

**复用边界**：属于根 MIT 的代码可在履行声明义务后复用。但 README 明确说明这是研究代码、工程质量可能不一致，且发布版与设计文章描述的实现不同——许可允许复用不等于该实现适合作为工程基线。产品名称、DeepSeek 账号服务、GitHub 与飞书账号不因代码许可获得额外授权。

## 技术栈

| 运行层 | 组成与作用 |
| --- | --- |
| 宿主与插件 | TypeScript / Node.js（要求 `^22.19.0` 或 `>=24`）；以 Cordis 插件接入 DSH，`cordis.patch.yml` 声明 bundle 补丁；peer 依赖为 `@deepseek-ai/dsh-*` 系列，要求 DSH `^0.2.1-alpha.2` |
| 领域与持久化 | 领域层承载来源、触发、研判、工单、派工与回复；持久化用 Node 内置 SQLite，状态目录加锁，配置校验用 zod |
| Agent 运行时 | 不自带 Agent Loop，复用 DSH 会话：主会话用 `dsh-superagent-router` preset，每张工单一个 `worker-<工单 id>` 会话与同名目录，用 `dsh-superagent-worker` preset |
| 外部边界 | GitHub 与飞书都经外部 CLI（`gh`、`lark-cli`）的专用账号包装器读写；每张工单的检出目录由 operator 配置的 prepare 命令建立 |
| 面板 | React 18 客户端经 DSH 客户端插件注入 Web 侧栏；数据面是回环地址上的本地管理 API，要求专用请求头与同源 Host |

依据：[包声明][s-pkg]、[架构说明][s-arch]、[部署说明][s-deploy]。只保留影响能力边界的组件，不复述内部模块表。

## 能力清单

官方没有集中的“全部功能”页；下表按仓库 `docs/001`–`008` 的篇目与源码入口归纳，**不是官方功能清单**，分组名沿用其领域术语。

### 名词约定

术语在全文只用下表名称；英文原文仅在首次出现时括注。

| 术语 | 对方原文 | 含义 |
| --- | --- | --- |
| 来源 | Source | 事件流，一种可复用实现加一份实例配置；自持读取位置与 bot 身份 |
| 触发 | Trigger | 一条不可变事件，属于一个或多个线程；重复受理只建一张工单 |
| 线程 | Thread | 按时间排列的触发，一次只跑一个研判；承载订阅与决定历史 |
| 渠道 | Channel | 线程的写侧，即回复、评论与 PR 的落点 |
| 策略 | Policy | 有版本的受理规则，含允许名单、准入表、bot 名单与接受模式 |
| 研判 | Eval | 把一批触发变成决定的过程，分确定性准入与模型研判两层 |
| 决定 | Decision | 接单、停止、忽略、未完成四种结果 |
| 授权 | Mandate | 一次接单授予的内容：策略版本、范围、强度、命中规则与请求者身份；不可变 |
| 工单 | Ticket | 授权后的工作单元，有独立状态机，可被人类消息按同一授权恢复 |
| 派工 | Assignment | 工单与一个执行器实例的绑定，一张工单可有多次 |
| 订阅 | Subscription | 工单与线程的多对多关系，把后续讨论直接投给执行器 |
| 执行器 | Executor | 运行派工的端口：一张工单一个 DSH 会话与一个目录 |

| 分组 | 能力及依据 |
| --- | --- |
| 来源与触发（001、008） | GitHub：账号通知、订阅的 Issue 与 PR、CI 变化、PR 合并／关闭，开关后可接收仓库内全部新 Issue、PR、评论与默认分支 CI；飞书：实时事件、历史补读、订阅话题轮询。触发不可变、按 id 去重，先丢弃 bot 自身消息与范围外事件（001、008） |
| 准入与策略（002） | 策略有版本：研判规则、每个来源的允许名单（可从飞书群同步）、bot 名单、准入表；接受模式三档 `off`／`observe`（默认）／`auto`；判定强度分明确、推断、不受理三档；名单、规则与授权由宿主执行，消息与引文不能改变权限（002） |
| 研判（001、002） | 每个线程一次只跑一个研判，期间到达的触发合并进下一批；两层：确定性准入先判发送者与准入表，模型再逐条规则研判；超时两次后第三次记未完成并在面板提示；策略变更会丢弃进行中的研判并按新版本重排（002） |
| 授权与工单（002、003） | 只有研判能建工单；授权记录策略版本、范围、强度、命中规则与身份，只有人的停止能撤回、恢复前重校验失败则吊销；工单状态不跟随会话，结束后保留订阅，人类消息可按同一授权恢复（002、003） |
| 派工与执行（003） | 一张工单一个会话与目录；worker 槽位并发上限，另留一个给人用的额外槽位；前台命令 5 秒后转后台作业，回合结束仍有后台工作时保留槽位；`blocked`／`failed` 后停止自动投递但保留工具供人继续；先存储后执行的队列承担重试、重派与宿主重启恢复（003） |
| 交付与合并（003） | 确认、回答、结果、待人工决定四类回复各有允许规则；自动合并由提示词“交付要求”约束，宿主没有合并专用逻辑；PR 关闭决定工单结束并保留订阅（003） |
| 提示词与技能（004） | 团队可编辑三段（沟通、工单范围、交付要求）与团队技能，可覆盖每项内置提示分段；每次保存生成不可变版本，默认文本升级时面板标 **Default updated** 并给出差异（004） |
| 监督面板（005） | 六个页签，按“是否有人需要我／系统是否健康／这件事的历史”排序；工单阶段用可核对的判定表；全局搜索支持文本、id 与链接（005） |
| 运维与扩展（006、007、008） | 启停脚本以退出码表达“正常／需重启／部分组件报错／等待 setup”，健康项按类别聚合，连续失败才报为系统问题；状态与设置走本地管理 API；新增来源有完整步骤（插件入口、配置 schema、表单字段、触发映射、健康项）（006、007、008） |

## 与本项目的对照

基准为 pi-desk 当前内置实现；可安装扩展、用户自行安装的 CLI 与实验性分支不计入。对方事实来自官方文档与源码文件，其运行效果未在本机验证。

**总体结论**：4 项实质重合、4 项部分重合；桌面侧若干能力在对方 bundle 范围内无对应；对方独有能力集中在“外部事件驱动的授权与工单编排”这一整块。

### 实质重合

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| 项目内 Agent 对话与持久历史 | 主会话与每单一执行器会话，会话事件与目录跨重启存活 | pi-desk 由独立 SDK 宿主创建 Pi 会话并投影给 Vue（[会话模块][p-session]、`SdkSessionRuntime`）；对方会话是 DSH 会话并套用角色 preset。重合的是用户目标，不是会话契约 |
| 工作区绑定与执行目录 | 每单一目录，默认在状态目录下的 `work`，prepare 命令可建工作树 | pi-desk 以项目目录为会话与终端作用域（[项目与信任][p-trust]）；对方目录是工单级、由命令创建，不来自用户选择的项目 |
| 工具执行流的可观察结果 | 面板与报告给出工具活动、后台作业与阶段 | pi-desk 工具结果与子代理快照进入会话投影并渲染（[子代理模块][p-subagent]）；对方把执行状态固化成领域事实，面板按工单查询 |
| 用量与模型选择 | 面板分别选执行器与研判模型；会话创建时定模型并保持 | pi-desk 走 Pi SDK 的模型配置与用量统计；对方把角色与模型分开配置，已建会话不换模型 |

### 部分重合

| 本项目能力 | 重叠环节 | 不可视作替代的原因 |
| --- | --- | --- |
| `delegate_subagent` 四类子代理 | 都把一段工作交给独立上下文执行，结果回父级 | 本项目委派生命周期等于一次工具调用：无父子登记、无排队、无续接、不脱离工具调用存活（[子代理模块][p-subagent]）；对方的派工可多次重派、可被订阅的讨论唤醒、可在重启后恢复，且先有授权记录 |
| 项目信任与审批入口 | 都在执行前有用户决策点 | pi-desk `TrustManager` 管理项目资源信任，明确不提供 OS 沙箱或工具权限限制（[项目与信任][p-trust]）；对方准入决定“谁可以发起工作”，授权记录“凭哪条规则、可以做到哪一步”，属授权模型而非资源信任 |
| 侧栏工作台与会话页面 | 都有会话、状态与用量视图 | 本项目面板按会话与工具组织；对方按来源／触发／研判／执行分页，把“等人工处置”作为第一屏。信息架构差异，不是同一产品面 |
| 并发与后台执行 | 都能同时推进多件事 | 本项目并发来自多会话与终端守护 PTY（[终端模块][p-terminal]），彼此无槽位与优先级规则；对方有槽位上限、给人保留的额外槽位与“人优先于新工作”的调度规则 |

### 无对应

以下为 pi-desk 有、在对方 bundle 范围内确认没有的能力；对方运行在 DSH 之上，DSH 自身能力不自动算作本插件能力。

| 本项目能力 | 说明 |
| --- | --- |
| 受管终端面板与 PTY 守护 | 对方只有执行器内的 shell 工具与命令黑名单，没有用户终端；Shell 也不作为安全边界（官方称其为默认值而非边界） |
| 声明式生成式界面（GenUI） | 对方面板是固定六页签的 React 界面，没有按模型输出渲染界面文档的通道 |
| 记忆库与保存审批 | 对方有团队技能与提示词分段，但没有跨会话记忆库、检索引擎与逐份审批通道（本项目见[记忆模块][p-memory]） |
| 技能登记门禁 | 对方的技能只是随包提示与文件，没有“修改前校验收登正文”这类强制门禁（本项目见[技能门禁][p-skillguard]） |
| 桌面文件编辑器、Git 面板、局域网远程与手机端 | 对方不提供桌面外壳，界面只存在于 DSH Web 侧栏 |

### 对方独有

| 类别 | 能力 | 与 pi-desk 的差距 |
| --- | --- | --- |
| 外部事件接入 | GitHub 通知／Issue／PR／评论／CI，飞书会话与话题；来源自持读取位置，重启不重放，重复投递不重复建单 | 本项目没有外部事件源接入层，会话只能由用户发起 |
| 授权模型 | 有版本的策略、三档强度、准入表、不可变授权、策略变更对在办工单的通知与恢复前重校验 | 本项目没有“谁可以让 Agent 干活”的结构化记录；信任与审批都不是同一职责 |
| 工单编排 | 工单／派工／订阅：一单多执行器、订阅把后续讨论直接投递、工单状态不跟随会话、按影响决定结束 | 本项目的子任务没有可恢复的工单标识，跨调用归属不存在 |
| 主动模式与影子运行 | `observe` 默认模式把主动判定记成“应受理但按忽略处理”，供人复核后再开 `auto` | 本项目没有主动派生入口，也没有可回放的影子决策记录 |
| 提示词覆盖与版本 | 团队段加内置分段覆盖、不可变版本、升级时的默认文本差异对比 | 本项目的提示分层由宿主代码分段与随包资源构成，未核实存在等价的用户可编辑覆盖与版本历史 |
| 面板分区 | 按三问组织六个页签，工单阶段判定表可核对 | 本项目面板按会话与工具组织，没有工单中心的监督视图 |

**证据类型说明**：机制差异来自双方文档与源码（已确认事实）；“不可视作替代”的判断基于生命周期与归属语义（设计推断）；双方都没有给出运行数据，**未做量化对比**，因此不对“谁更快／更准／更省”下结论。

## 可借鉴方向

借鉴只指功能方向与产品形态；技术方案应回到 Pi SDK 与现有模块自行设计，不以对方实现为基线。

| 方向 | 可行性 | 说明 |
| --- | --- | --- |
| 面板按“需要人处置”排序的信息架构 | 高 | 纯前端组织：现有 Vue 页面与投影已有状态与用量，可按“待人工决定／异常／历史”重排；不需要新依赖，也不改变执行链 |
| 把“谁可以让 Agent 开始一项工作”显式化 | 低 | 需要新的策略层与持久记录（名单、强度、每次授权的依据），并把决策点前移到宿主而非提示词；涉及权限模型与界面，属独立产品级设计，与 `TrustManager` 不是同一职责 |
| 工单化的可恢复工作单元 | 低 | 需要工单标识、跨调用归属、目录与分支约定、重启恢复语义；当前边界是“子任务生命周期等于一次工具调用”，改动面覆盖宿主、投影与页面 |
| 主动派的影子模式（先记录、后放开） | 低 | 前提是已有事件源与主动派生入口；只有用户发起会话的产品里没有可记录的对象，不能先做 observe |
| 领域文档的分层写法（概念→授权→执行→架构） | 高 | 纯文档方法：每篇只依赖前篇概念，拒绝接受的概念单列成表；可用于本项目设计文档与模块说明的组织，无需代码改动 |

**对方短板（不列入借鉴方向）**：仅 1 个提交、无 Release、`has_issues=false`（没有 issue 反馈通道），README 自述工程质量不一致；执行器以 operator 的 OS 用户全权限运行，官方建议用独立 OS 账号做隔离而非依赖程序隔离；只支持 github.com，与 GitHub Enterprise Server 不兼容；自动合并由提示词而非宿主逻辑约束；部署依赖 tmux、专用 GitHub 账号与独立 DSH profile。

## 信息来源

### 对方官方资料

- [根 README][s-readme]：定位、研究原型声明、文档索引。
- 设计文档逐篇：[000 哲学][s-doc0]、[001 领域模型][s-doc1]、[002 授权][s-doc2]、[003 执行][s-doc3]、[004 提示词][s-doc4]、[005 面板][s-doc5]、[006 部署][s-doc6]、[007 架构][s-doc7]、[008 扩展来源][s-doc8]。
- [包声明][s-pkg]、[根 LICENSE][s-license]、[存储实现][s-store]。
- [仓库 API][s-meta]、[最新 Release API][s-release]、[提交列表][s-commits]：2026-11-08 快照。
- 截图核实：仓库文件树无图片资源（0 个），核对于 2026-11-08，故「界面截图」节无可直链素材。
- 未核实：配套设计文章《Exploring Super-agent Design: Towards a More Autonomous Agent System》与发布实现的具体差异（README 只说明“不相同”）；面板与执行器在本机的实际行为。

### 本项目事实出处

- [会话模块][p-session]、[子代理模块][p-subagent]、[终端模块][p-terminal]、[项目与信任][p-trust]、[记忆模块][p-memory]、[技能门禁][p-skillguard]。
- [`src/sdk-host/session-runtime.ts`](../../src/sdk-host/session-runtime.ts)：`SdkSessionRuntime` 与扩展工厂装配。
- [`src/sdk-host/sub-agent/delegation-extension.ts`](../../src/sdk-host/sub-agent/delegation-extension.ts)：`delegate_subagent` 的派发、白名单与批次并发。
- [`src/main/trust/trust-manager.ts`](../../src/main/trust/trust-manager.ts)：`TrustManager` 的职责与沙箱排除边界。

[s-readme]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md
[s-doc0]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md
[s-doc1]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md
[s-doc2]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md
[s-doc3]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md
[s-doc4]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md
[s-doc5]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md
[s-doc6]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md
[s-doc7]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md
[s-doc8]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/008-cookbook.md
[s-pkg]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/package.json
[s-license]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/LICENSE
[s-store]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/store.ts
[s-arch]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md
[s-deploy]: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md
[s-meta]: https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype
[s-release]: https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype/releases/latest
[s-commits]: https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype/commits
[p-session]: ../modules/sessions-chat.md
[p-subagent]: ../modules/sub-agent.md
[p-terminal]: ../modules/terminal-commands.md
[p-trust]: ../modules/projects-trust.md
[p-memory]: ../modules/memory.md
[p-skillguard]: ../modules/skill-guard.md
