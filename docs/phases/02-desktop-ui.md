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

### P2-02 Pi Session

**目标**：选择项目后能创建、列出、恢复 Pi Session，并继续已有对话。

**范围**：先核实并确定官方 Session 列表能力的接入路径，再接入创建、恢复、读取 Messages 和继续对话。列表与历史来自 Pi 管理的数据，Desktop 不复制持久化消息库。处理被 Extension 取消的切换结果及 Session 的实际 cwd。

**依赖**：P2-01。当前 RPC 没有列表命令，不能自行发明 `list_sessions`；接入方式是本任务的开放设计问题。

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

- Pi Session 列表的官方能力接入方式，以及 Session cwd 与 Project 不匹配时的交互。
- 活动操作期间切换 Project / Session 的用户确认与取消行为。
- Desktop 配置的存储路径、持久化所有者与窗口恢复策略。
- 主界面视觉方向、消息排版和 Tool Card 非文本内容的基础呈现方式。
