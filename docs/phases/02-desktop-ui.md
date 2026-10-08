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

### P2-04 通用 Tool Card

**目标**：统一展示内置与后续 Extension 工具的执行过程。

**范围**：工具名称、执行状态、参数、结果、错误、Desktop 计算的耗时、折叠状态；按工具调用关联并支持非文本内容的明确呈现。不要将所有 `partialResult` 统一追加，也不要为每个工具提前建立专属 UI。

**依赖**：P2-03 与第一阶段工具事件。Diff 留在第三阶段。

### P2-05 Agent 控制

**目标**：在界面中使用 Pi 的模型、Thinking 与 Context 能力。

**范围**：模型选择、按模型能力提供 Thinking Level、Context Usage、Stop 与状态同步。优先官方查询与设置命令，Context 未知或暂不可用时如实展示，不把累计用量当作当前上下文占用。

**依赖**：P2-03；依赖已有模型配置，不开发登录或 Provider 凭据管理。

### P2-06 UI 偏好

**目标**：保存 Desktop 自己的基本界面偏好。

**范围**：主题、Sidebar 状态和窗口尺寸 / 位置；采用轻量本地配置，恢复窗口时避免落入不可见区域。区分 Desktop 偏好与 Pi settings，不复制后者。

**依赖**：P2-03，以及 P2-01 采用的本地配置约定。

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
- 活动操作期间切换 Pi Session 的用户确认与取消行为（Project 切换已在 P2-01 确定，见开发总览第 6.2 节）。
- Desktop 配置的窗口尺寸与位置恢复策略（配置文件位置与持久化所有者已在 P2-01 确定，见开发总览第 6.2 节）。
- 主界面视觉方向、消息排版和 Tool Card 非文本内容的基础呈现方式。
