# 第三阶段：Pi 深度能力

[开发总览](../development.md) · [上一阶段：基础 Desktop UI](02-desktop-ui.md) · [下一阶段：Authentication](04-authentication.md)

## 目标与边界

在基础 Desktop GUI 上接入 Pi 的可扩展能力、项目资源与更丰富的对话操作。继续由 Pi 管理 Session、Compaction、Skills、Extensions、Packages 和 MCP，不创建平行实现。

本阶段是能力方向与任务拆分，不提前决定全部 Extension 方法、资源管理接口或供应商细节。

## 依赖

- 第二阶段已有 Project、Session、Chat、Tool Card 和基础控制。
- Project Trust 在启用项目资源前完成。
- 能发起用户对话的 Extensions 必须在对应 Extension UI 可处理后启用，不能通过自动肯定请求绕过确认。

## 任务拆分

### P3-01 Project Trust（已完成实现，决策记录）

**目标**：在加载项目级 Pi 资源前取得明确的用户信任决定。

**范围**：识别需要信任的项目资源、解释安全影响、启动前信任 / 不信任选择、通过官方启动能力传递。核实持久决定的正式方式，不直接写 `trust.json`，不默认 always trust。需要改变加载范围时明确重建 Runtime。

**已定决策**（事实与数值见[开发总览](../development.md)第 5、6.2、7.2 节）：

- 持久决定存入 Desktop 自己的 `desktop-config.json`（`projectTrust` 字段）；官方唯一持久方式是 TUI `/trust` 写 `~/.pi/agent/trust.json`，Desktop 不读写该文件。
- 官方优先级中 CLI 覆盖最优先：有受保护资源时 Desktop 总是显式传 `--approve` / `--no-approve`，因此覆盖 Pi 已保存的信任记录；无受保护资源时不传，不依赖 `defaultProjectTrust`。
- 探测按官方受保护资源清单在主进程内完成，含祖先目录的 `.agents/skills`；探测失败按不存在处理。
- 拦截点为 `desktop:runtime-start` 与 `desktop:session-open`，无决定时返回 `TRUST_REQUIRED`；决定后由页面重试原操作，Runtime 启动链本身不变。
- 重置入口在 Runtime 详情弹层；重置后下次启动重新询问。

**依赖**：第二阶段 Project 生命周期。Trust 不是 OS 沙箱，也不能取消启动前读取 `sessionDir` 与上下文文件的官方行为。

### P3-02 Extension UI

**目标**：为官方 RPC 支持的 Extension 交互提供独立 GUI 适配层。

**范围**：对话请求与响应、取消、通知、状态、Widget、标题及编辑器文本。区分需要回应的对话与无需回应的通知，保留原始 request id，不让普通 pending RPC 表错误等待 Extension response。

只映射当前官方 RPC 子协议；不承诺任意 TUI 组件可在 Vue 无损运行，未知交互不得自动批准。

**依赖**：第二阶段 IPC 与界面状态；项目级 Extension 加载依赖 P3-01。

### P3-03 Session 深化与 Compaction

**目标**：扩展已有 Session 恢复体验，支持 Fork 与上下文压缩操作。

**范围**：基于 Pi Session 的 Fork、恢复过程的取消与错误、Compaction 状态和结果展示；尊重官方 Session 生命周期及 Extension 取消结果。复用第二阶段的列表、读取和基础恢复，不另建历史模型。

**依赖**：第二阶段 Session 与 Context 控制；启用相关 Extension 时依赖 P3-02。

### P3-04 输入增强

**目标**：支持图片与文件引用参与对话。

**范围**：用户选择图片、模型能力提示、输入预览与移除、官方消息内容映射；明确文件引用是路径信息还是内容输入，不把 RPC 不支持的 `@file` 启动参数直接套进协议。限制读取范围与输入大小，避免无意上传敏感内容。

**依赖**：第二阶段 Prompt 与模型控制。资源 loader 与图片所需配套文件沿用 Runtime 打包机制。

### P3-05 Diff 展示

**目标**：让 Edit / Write 的变更更易理解。

**范围**：确定可靠的变更来源和基线，呈现支持范围内的 Diff；处理重复修改、并发变更与无法取得基线的情况。未知变更不伪造 Diff，不为了展示自动撤销或重新应用工具修改。

**依赖**：第二阶段 Tool Card；不替代通用工具结果，不扩展为 Git GUI。

### P3-06 Pi 资源接入

**目标**：让 Desktop 发现、使用并展示 Pi 的 Skills、Extensions、Packages 与 MCP 能力。

**范围**：先核实官方发现、管理和重载能力，再决定 GUI 暴露范围；复用 Pi settings 与资源加载，不建立独立插件市场或平行 MCP 配置。准确展示资源归属、加载失败和外部依赖，涉及安装或可执行配置变更保留用户确认。

**依赖**：P3-01、P3-02，以及稳定的 Project / Session 与工具界面。不把资源管理作为通用任意 shell 执行入口。

## 推进顺序

```text
P3-01 → P3-02 → P3-03 → P3-04 → P3-05 → P3-06
```

Trust 与 Extension UI 先建立安全交互边界，再启用相应资源；后续能力按实际需求逐项接入。

## 不做项

- 自行实现 Agent Core、压缩算法、Package manager 或 MCP client。
- 任意 TUI 组件模拟、插件市场、多 Agent、任务编排。
- Provider 登录与 OAuth 实现。
- Git GUI、Terminal、完整文件管理器或通用工作台。

## 待决策事项

- 目标 Pi 版本下 Extension UI 支持范围、取消与窗口关闭时的收敛行为。
- Session Fork 与恢复操作的具体 GUI 入口。
- 文件引用的数据语义、图片能力与敏感数据提示。
- Diff 来源与基线维护策略。
- Packages / MCP 的外部程序依赖、重载与生命周期边界；不能假定 standalone 自动携带所有第三方运行环境。
