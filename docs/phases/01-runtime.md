# 第一阶段：Runtime

[开发总览](../development.md) · [下一阶段：基础 Desktop UI](02-desktop-ui.md)

## 目标与边界

打通 `Tauri → Pi RPC sidecar → prompt → streaming → tool → abort`。仅一个活动项目、一个 Pi Runtime，使用最小页面，不开发完整 Desktop UI。

架构与协议依据沿用开发总览。以下是任务范围与依赖，不是一次性实施授权；实际源文件、依赖和操作在每项开发前确定。

## 前置事项

- 本机尚未发现 Rust 工具链，环境安装单独取得授权，不随创建骨架自动执行。
- Pi 使用固定 standalone 版本，不需要先安装 Bun 或自行编译 Pi。
- 复用已有模型配置与凭据，不读取并输出认证秘密，不开发 Authentication。
- 启动显式拒绝项目资源信任，关闭 Extensions、Skills、Prompt Templates、MCP；保留总览中说明的非沙箱边界。

## 任务拆分

### P1-01 最小项目骨架

**目标**：建立桌面应用、前端入口与单页 Runtime 界面骨架。

**范围**：Tauri 2、Vue 3、TypeScript、Vite、Tailwind CSS、Pinia 的最小配置；Rust command 注册入口与统一前端 IPC 服务入口。只建立立即使用的结构，不创建 Session、认证或插件空模块。

**依赖**：无其他开发任务依赖；环境准备与依赖安装仍为独立操作。

### P1-02 Pi binary 准备

**目标**：为 sidecar 启动提供固定且匹配目标平台的 Runtime 文件。

**范围**：版本与预期 SHA-256 固定、官方发布包下载校验流程、三目标平台映射、externalBin 命名、配套资源保留与启动所需路径。区分开发 host 与构建 target，按实际目标准备文件，不默认下载全部平台。

**依赖**：P1-01 的项目配置位置。资源布局先解决本阶段所需路径，不擅自完成所有后续发行配置。

### P1-03 RPC 启动与就绪

**目标**：Rust 以项目目录为 cwd 启动官方 Pi sidecar，并取得真实 RPC 状态。

**范围**：固定进程与启动参数、独立 stdin/stdout/stderr、异步 I/O、LF 分帧、唯一 request id、pending 请求匹配、错误记录分类；发送 `get_state` 并据响应进入就绪状态。最小页面可启动 Runtime 并显示状态。

**依赖**：P1-01、P1-02。

### P1-04 Runtime 生命周期

**目标**：明确活动进程和管道的所有者，支持可控的关闭与重新启动。

**范围**：重复启动限制、初始化失败清理、持续 stderr 消费、有界诊断、异常退出通知、pending 请求失败收敛、stdin 正常关闭、退出等待与超时终止。切换目录需结束旧 Runtime，旧进程事件不得覆盖新进程状态。

本项先完善无 Agent 操作时的关闭链；有活动操作时的取消由 P1-07 补齐。不自动重放 prompt，不将关闭主进程宣传为已经解决所有派生进程回收。

**依赖**：P1-03。

### P1-05 Prompt 请求

**目标**：从页面提交 prompt，区分接受、拒绝与后续执行状态。

**范围**：输入、发送、Rust 参数校验、结构化请求、`disposition` 处理、请求错误与 busy 状态。不把 prompt response 当作完成通知，不自动重发超时请求，不开放任意 RPC JSON 或独立 shell 执行入口。

**依赖**：P1-04。

### P1-06 Streaming 消息

**目标**：实时展示 assistant 文本和 Thinking，保持消息重建一致。

**范围**：在发送前订阅事件；按内容块重建增量，以块结束内容与完整 `message_end.message` 校正；处理用户消息、执行错误和最终消息，使用 `agent_settled` 收敛本轮 busy 状态。Rust 定向转发，前端释放监听并隔离旧 Runtime 事件。

**依赖**：P1-05。

### P1-07 Tool 与 Stop

**目标**：展示工具执行生命周期，并能停止当前 Agent 操作而保留 Runtime。

**范围**：按 `toolCallId` 关联工具名称、参数、更新、结果、错误；采用简单结构化展示，保留非文本结果。加入 `abort`、停止中状态、终态收敛，并补齐运行中关闭 Runtime 的取消路径。并发查询与取消不能被长时间持锁阻塞。

不开放 steering / follow-up 排队输入；不把 `abort` 当作自动清空队列。完整 Tool Card、专属工具 UI 和 Diff 留在后续阶段。

**依赖**：P1-06。

## 推进顺序

```text
P1-01 → P1-02 → P1-03 → P1-04 → P1-05 → P1-06 → P1-07
         启动链：P1-01～P1-04       交互链：P1-05～P1-07
```

当前优先启动链，每次只落实已讨论的任务，不因存在完整任务表一次生成整个阶段。

## 不做项

- 完整 TopBar / Sidebar、Project 持久化、Session 列表。
- Authentication、Extension UI、正式 Project Trust 对话。
- Skills、Extensions、Packages、MCP 的产品接入。
- Git、Terminal、文件管理器、多窗口、多 Agent、复杂调度。
- 自动重启重放、完整崩溃恢复、OS 沙箱。

## 待决策事项

- 创建项目时的 package manager 与实际依赖版本。
- Pi 配套资源的开发目录及正式安装包布局，分别处理 package 根目录与 executable 邻接 loader。
- 管道与前端通知的有界缓存、请求期限和事件路由细节。
- 正常关闭超时兜底与 Windows/macOS 派生进程清理机制。
- 现有模型是否可选；缺少凭据时如何给出清晰提示，不能转为提前开发登录功能。
