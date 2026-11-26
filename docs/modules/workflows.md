# 工作流

模块标识：`workflows`。返回 [项目结构](../项目结构文档.md)。初步设计见 [工作流模块初步设计](../workflows-设计.md)。

## 职责与入口

把「多个 Agent 按一张固定的图依次／并行推进」做成可保存、可重跑、可观察的资产：一张有向图由节点与带路由的边组成，一次运行按图调度，**每个 Agent 节点各自是一次独立的 Agent 会话**，节点之间不共享上下文。

入口按使用者分三类：

- 用户入口：工作区标签栏「＋」菜单的「新建工作流」；工作流标签页里的定义清单、画布、节点检查器、连线检查器、参数定义对话框、启动填参对话框、定时任务面板与运行面板；设置页「插件」分节里「工作流」插件的设置项（存储位置、保留口径、清空已结束的运行记录）。
- 进程入口：`desktop:workflows-list`、`desktop:workflow-read`／`save`／`delete`、`desktop:workflow-run-start`（带运行参数）／`run-cancel`／`run-approve`／`run-read`、`desktop:workflow-runs-list`／`runs-clear`、`desktop:workflow-schedules-list`／`schedule-save`／`schedule-delete`／`schedule-run`，以及运行快照推送 `desktop:workflow-run-event`。
- 能力装配入口：`src/main/plugins/catalog.ts` 的 `workflows` 条目；停用即下次启动不注册通道。

不负责的部分：会话本身的创建与消息投影归 [会话与聊天](sessions-chat.md)；专家定义、能力范围与写入守卫归 [专家与专家团](experts.md) 与 [子代理](sub-agent.md)（工作流复用同一套守卫与专家正文）；一次性隔离委派归 [子代理](sub-agent.md)；画布所在的标签体系与项目归属归 [工作区标签](workspace-tabs.md)。

## 关键实现与协作

### 本模块实现

| 文件 | 职责 |
| --- | --- |
| `src/shared/workflow-api.ts` | 通道常量、定义／节点／边／运行态契约、跨进程响应校验，以及**图形校验的唯一实现**（恰好一个开始、至少一个结束、无环、边两端存在、Agent 节点必填专家与提示词、同来源同路由只能一条边）；保存与启动共用 |
| `src/main/workflows/store.ts` | 定义与定时任务的落盘：`<agentDir>/workflows/<标识>/workflow.json` 与同目录的 `schedules.json`，目录名即标识、创建后不可改；写入走临时文件再改名；删除定义走系统废纸篓 |
| `src/main/workflows/run-store.ts` | 运行记录：`<agentDir>/workflow-runs/<运行标识>/run.json` 与节点会话目录；启动时把上次遗留的 `running` 收敛为中断，按工作流列运行摘要供回放，按份数裁剪，并提供清空已结束记录 |
| `src/main/workflows/node-runner.ts` | 节点进程载体：一个节点一次独立 pi 子进程（`--mode json`、`--session-dir` 落盘、写入守卫环境变量、超时强杀、输出上限）；专家正文与生效工具集在调用前解析（工具集剔除扩展注册的工具，与 `--no-extensions` 一致），节点定义里只存专家标识 |
| `src/main/workflows/runner.ts` | 图调度：入边来源全部终态后才判定节点，激活的边决定执行或跳过；状态边优先，没有状态边可走时按定义顺序取第一条命中的条件边；审批门停在 `waiting` 等人给决定；启动时把节点提示词里的参数占位符换成运行参数值；同层并发受上限约束；取消会释放等待中的审批并终止全部活跃子进程 |
| `src/main/workflows/scheduler.ts` | 定时调度：每分钟检查一次到期任务，按调度里记录的项目与参数值启动运行；防重入按「同一工作流已有运行在推进」判断；应用退出即停 |
| `src/main/workflows/ipc.ts` | 通道注册、调用者与参数校验、项目白名单（只允许在已添加项目里启动运行）、装配期收敛遗留运行 |
| `src/preload/workflows.ts` | 页面桥接：定义读写、运行启停与读取、清空记录、运行快照订阅 |
| `src/renderer/src/workflows/stores/workflow.ts` | 定义清单与草稿、选中节点、图形问题、保存与删除；草稿与已保存定义分开，未保存时置 `dirty` |
| `src/renderer/src/workflows/stores/workflow-run.ts` | 当前运行快照、启动（带参数）与取消、审批决定、历史运行与回放选择、接管定时任务发起的运行、按 `runId` 过滤的订阅；启动失败不清掉上一次结果 |
| `src/renderer/src/workflows/stores/workflow-schedule.ts` | 定时任务清单、保存与删除、立即运行；按工作流现读，不做缓存 |
| `src/renderer/src/workflows/components/WorkflowCanvasView.vue` | 标签页主体：定义清单、画布工具条（名称、新连线路由、添加节点、保存、运行）、画布、检查器、运行面板 |
| `src/renderer/src/workflows/components/WorkflowNodeCard.vue`、`WorkflowNodeInspector.vue` | 画布节点（类型、标题、配置摘要、运行状态、连线锚点）与节点配置（标题、专家、提示词、写入范围三态；审批门只有标题与一段给人看的说明） |
| `src/renderer/src/workflows/components/WorkflowEdgeInspector.vue` | 连线配置：路由选择与条件（判定方式 + 条件值，正则就地预编译）；条件边只对没有状态边可走的分支生效 |
| `src/renderer/src/workflows/components/WorkflowParameterEditor.vue`、`WorkflowRunDialog.vue` | 参数定义编辑（名称自动生成、类型、必填、默认值、选项）与启动前填参（必填校验与默认值预填） |
| `src/renderer/src/workflows/components/WorkflowSchedulePanel.vue` | 定时任务列表与编辑（cron、项目、参数值、启停、删除、立即运行），并说明触发只在应用运行期间发生 |
| `src/renderer/src/workflows/components/WorkflowRunPanel.vue` | 运行状态、节点进度、事件流、等待审批时的通过／拒绝、历史运行选择与只读回放；不参与调度 |
| `src/renderer/src/workflows/components/WorkflowSettingsSection.vue` | 插件设置项：存储位置、保留口径、清空已结束的运行记录 |

### 与其他模块的交界

- **标签体系**：`workspace-tabs` 增加 `workflow` 标签类型与 `workflow:<标识>` 键前缀；新图首次保存后由 `rebindWorkflowTab` 把标签从空标识改绑到真实标识，同一份定义不再占两个标签。
- **专家**：节点按专家标识取正文与写入范围（节点未配置写入范围时沿用专家定义），不复制专家内容到定义文件，专家改版后节点按新正文运行。
- **子代理**：节点进程与 `team-runner`、委派子进程共用同一套进程习惯与守卫脚本，但会话目录按「运行 + 节点」分开，不复用父会话上下文。

### 执行语义

- 节点类型有 `start`、`agent`、`approval`、`end`；开始、结束与审批门不启进程。
- 边路由有 `success`、`failure`、`always`、`condition`；状态边按节点终态走，条件边按源节点结论文本求值。
- 状态边优先：源节点有可走的状态边时条件边不参与判定；没有时才按定义顺序取第一条命中的条件边。
- 节点终态为 `completed`／`failed`／`cancelled`；入边都未激活的节点标为 `skipped`。
- 审批门停在 `waiting`，通过走 `success` 与 `always` 边，拒绝记为 `failed`（成因 `rejected`）并走 `failure` 与 `always` 边。
- 取消一次运行会释放等待中的审批、终止全部活跃子进程，并把已开始未收敛的节点记为 `cancelled`。
- 同一工作流同一时刻只允许一次运行：已有运行在推进时再次启动被拒绕（`ALREADY_RUNNING`）。
- 节点的写入范围优先取节点配置，未配置时沿用专家定义；写入范围为空数组（只读）时同样装配写入守卫，拒绍全部写入，不依赖工具排除。工具集取专家的生效工具集，并剔除扩展注册的工具（节点进程带 `--no-extensions`）；工具范围为空时按默认工具集运行并在事件里提示。
- 启动参数：定义里声明的参数在启动时填值，节点提示词里的 `{{名称}}` 在派发前替换；未声明的占位符与缺值的必填参数分别在保存与启动时拒绝。
- 定时触发：五段 cron（`分 时 日 月 周`，支持 `*`、数字、区间、列表与 `*/n`）到点按调度里记录的项目与参数值启动；日与周两段都写死时按 POSIX 取「任一命中」，只有字段真的是 `*` 才算未限制；同一工作流已有运行在推进时跳过本次，不排队补跑；应用退出后不再触发。

## 数据与落盘

| 对象 | 位置 | 说明 |
| --- | --- | --- |
| 定义 | `<agentDir>/workflows/<标识>/workflow.json` | 目录名即标识；删除进系统废纸篓 |
| 定时任务 | `<agentDir>/workflows/<标识>/schedules.json` | 与定义同目录；每条带 cron、项目与参数值 |
| 运行记录 | `<agentDir>/workflow-runs/<运行标识>/run.json` | 每次状态变化写整份快照；保留最近 50 份 |
| 节点会话 | `<agentDir>/workflow-runs/<运行标识>/sessions/<节点标识>/` | 节点各自独立上下文，跨运行不共用 |

## 当前不做

- 循环；运行回放只重演记录，不支持从某个节点重跑。
- 模板发布与分发。
- 节点之间直接互发消息：只经图的边单向传递。
