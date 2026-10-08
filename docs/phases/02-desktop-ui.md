# 第二阶段：基础 Desktop UI

[开发总览](../development.md) · [上一阶段：Runtime](01-runtime.md) · [下一阶段：Pi 深度能力](03-pi-capabilities.md)

## 目标与边界

在第一阶段 Runtime 之上形成可日常使用的 Project / Session / Chat GUI。复用已有启动、请求、Streaming、工具事件和 Stop，不另建 Agent Core 或历史数据库。

本阶段确定业务交互和界面职责；具体文件、视觉方案、存储方式与接口在对应任务开发时讨论。

## 依赖

- 第一阶段提供 Runtime、Prompt、Streaming、工具事件和取消能力。
- 基础会话恢复属于本阶段，第三阶段只深化体验与能力，不重复实现。
- 正式 Trust UI 尚未接入时继续显式拒绝项目资源加载，不因新增 Project 选择器自动信任目录。

## 任务拆分

### P2-01 Project

**目标**：以本地项目而不是孤立 Chat 组织使用入口。

**范围**：目录选择、路径归一化、Project 基础属性、轻量本地持久化、选择与切换。保持一个活动 Runtime；有活动操作时明确切换行为，不自动中断或重放有副作用的工作。不引入数据库。

**依赖**：第一阶段生命周期；Project UI 与 Chat 布局可在接口明确后协同设计。

**当前实现**：主进程提供 `desktop:project-choose-directory`、`desktop:project-list`、`desktop:project-set-current` 三个受限方法，目录选择、路径归一化、最近项目列表与当前项目都归主进程；页面只持展示副本，选择项目不会自动启动 Runtime。配置位置、结构、上限、降级行为与切换编排见开发总览第 6.2 节。TopBar、Sidebar 与消息区仍属 P2-03。

**决策**：以 `realpath` 结果为同一目录的唯一键；有活动操作时由主进程拒绝未确认的切换，界面就地确认后带 `allowInterrupt` 重试；切换复用第一阶段关闭链，不排队、不自动重放；不新增依赖，也不新增单向事件通道。

### P2-02 Pi Session

**目标**：选择项目后能创建、列出、恢复 Pi Session，并继续已有对话。

**范围**：先核实并确定官方 Session 列表能力的接入路径，再接入创建、恢复、读取 Messages 和继续对话。列表与历史来自 Pi 管理的数据，Desktop 不复制持久化消息库。处理被 Extension 取消的切换结果及 Session 的实际 cwd。

**依赖**：P2-01。

**当前实现**：列表来自 Pi 管理的会话文件（只读头部元数据与有界预览），主进程提供 `desktop:session-list` 与 `desktop:session-open`；打开与新建一律结束旧 Runtime 后带 `--session-id` 或不带该参数重启，恢复后就绪前用 `get_messages` 初始化投影。存储位置、分组规则、列表上限、切换守门与错误码见开发总览第 6.2 节。

**决策**：核实结果是本版本 RPC 没有列举会话的命令（`Session` 段只有 `get_session_stats`、`switch_session`、`fork`、`clone`、`get_entries`、`get_tree` 等），因此按官方文件布局读会话元数据，不发明 RPC 命令；不在同一进程内使用 `switch_session`，保持一个 Runtime 代际对应一个会话；会话归属以头部 `cwd` 判定，分组目录名歧义只作为初筛。本阶段显式关闭 Extensions，且不调用可被 Extension 取消的切换命令，因此不需要处理 Extension 取消切换的结果。

### P2-03 Chat 布局

**目标**：将最小 Runtime 页面替换为稳定的 Desktop 主界面。

**范围**：TopBar、Project / Session Sidebar、消息区、Prompt 区；正式消息组件、Streaming、Thinking、错误与运行状态。保留第一阶段协议重建逻辑，处理输入法、焦点、滚动和重复发送，不扩大为 IDE。

**依赖**：P2-01、P2-02 的状态与交互契约；复用第一阶段消息状态。

**当前实现**：主界面由顶栏、可折叠的会话侧栏、消息区与 Prompt 区组成，替换第一阶段的最小 Runtime 页面。消息按 `contentIndex` 顺序渲染，Thinking 可折叠，工具调用内联为可展开的通用工具卡片（见 P2-04）；运行中切换统一用应用内确认对话框，Runtime 启动由打开或新建会话触发。界面分区见开发总览第 6.3 节，本地配置与窗口偏好见第 6.2 节。

**决策**：只动渲染进程与必要的偏好契约，消息、工具与投影仍由主进程重建；不引入组件库、图标库、外部字体、Markdown 渲染或虚拟滚动；不新增错误码；Sidebar 折叠与窗口尺寸/位置随本任务一并落地（见 P2-06）。

### P2-04 通用 Tool Card

**目标**：统一展示内置与后续 Extension 工具的执行过程。

**范围**：工具名称、执行状态、参数、结果、错误、Desktop 计算的耗时、折叠状态；按工具调用关联并支持非文本内容的明确呈现。不要将所有 `partialResult` 统一追加，也不要为每个工具提前建立专属 UI。

**当前实现**：工具调用在消息流内联为通用工具卡片，展示名称、状态、Desktop 计算的耗时、参数摘要，展开后显示参数、结果或错误输出、非文本内容描述与截断提示；运行中的卡片自动展开一次，之后由用户开合。恢复会话时按 `get_messages` 的 `toolResult` 消息补种工具条目。数据来自现有投影条目与 `toolcall` 块，不新增通道、错误码或依赖；字段、耗时语义与补种规则见开发总览第 6.2 节，卡片呈现见第 6.3 节。

**决策**：耗时由主进程记录事件到达时刻并在投影中给出，渲染端只在运行中补当前时刻，不按批次到达时间估算；非文本内容只保留类型与估算大小的描述，不携带载荷也不渲染；折叠状态只存在组件实例内，不落配置；不新增依赖、通道与错误码，Diff 与工具专属 UI 留到第三阶段。

**依赖**：P2-03 与第一阶段工具事件。Diff 留在第三阶段。

### P2-05 Agent 控制

**目标**：在界面中使用 Pi 的模型、Thinking 与 Context 能力。

**范围**：模型选择、按模型能力提供 Thinking Level、Context Usage、Stop 与状态同步。优先官方查询与设置命令，Context 未知或暂不可用时如实展示，不把累计用量当作当前上下文占用。

**当前实现**：TopBar 的 Runtime 弹层内提供模型与 Thinking 选择、上下文占用与压缩中提示；Stop 沿用 P2-03 的 Prompt 区原位入口。能力来自 `desktop:runtime-capabilities`，设置走 `desktop:runtime-set-model` 与 `desktop:runtime-set-thinking-level`，状态仍经既有的 Runtime 状态广播收敛。通道、字段、刷新时机与错误码见开发总览第 6.2 节。

**决策**：模型列表与 Thinking levels 走独立的能力读取通道，不放进每次状态变化都会全量广播的快照；取值合法性交给 Pi 判定，不维护 level 白名单；上下文占用只在就绪、每轮结束与设置成功后重新读取，不做轮询；压缩中只提示不本地拦截；不新增依赖、单向事件通道或 Provider / 凭据能力。

**依赖**：P2-03；依赖已有模型配置，不开发登录或 Provider 凭据管理。

### P2-06 UI 偏好

**目标**：保存 Desktop 自己的基本界面偏好。

**范围**：主题、Sidebar 状态和窗口尺寸 / 位置；采用轻量本地配置，恢复窗口时避免落入不可见区域。区分 Desktop 偏好与 Pi settings，不复制后者。

**依赖**：P2-03，以及 P2-01 采用的本地配置约定。

**当前实现**：Sidebar 折叠状态、窗口尺寸、位置、最大化状态与主题（跟随系统 / 浅色 / 深色，默认跟随系统）均已实现：与项目列表共用 `<userData>/desktop-config.json` 的 `ui`、`window` 字段，界面偏好走 `desktop:preferences-get` 与 `desktop:preferences-set-ui`，窗口偏好由主进程独占并在创建窗口前校正，主题机制见开发总览第 6.2 节。本阶段任务至此完成。

## 推进顺序

```text
P2-01 → P2-02 → P2-03 → P2-04 → P2-05 → P2-06
```

先确定 Project / Session 归属，再完善主界面与控件；不先堆积大量组件。

## 不做项

- Extension UI、资源管理界面、正式 Project Trust 对话。
- Fork、复杂 Session 搜索、独立历史数据库。
- Diff、图片输入、复杂文件引用。
- Authentication、Git、Terminal、文件管理器、多窗口、多 Agent。

## 待决策事项

- Session 列表接入方式与 cwd 不匹配的交互已在 P2-02 确定（见开发总览第 6.2 节）；跨项目复用同一会话文件的影响仍待核实。
- 活动操作期间切换 Pi Session 的用户确认与取消行为（Project 切换已在 P2-01 确定，见开发总览第 6.2 节；界面上两者共用同一个确认对话框，已在 P2-03 确定）。
- 主界面视觉方向与消息排版已在 P2-03 确定，工具卡片的呈现与非文本内容方式已在 P2-04 确定（见开发总览第 6.2、6.3 节）；Diff 与工具专属 UI 留到第三阶段。
