# Pi 桌面端首次启动调研交接

## 目的与范围

调研相关 Pi 桌面端项目如何处理首次 Runtime 启动，并把结论映射到 pi-desk。本文记录的是方案建议，不是已批准的实现规格或已完成的代码改动。

案例按与 Pi 桌面集成的相关性选取，不代表受欢迎度排名；本次未核验 Stars、Forks 或更新活跃度。结论基于公开文档及搜索返回的内容摘要，网页正文抓取受到当前网络代理限制，未逐行审阅案例项目源码。实施前应对照 pi-desk 固定的 Pi 版本核对官方协议和真实行为。

## 案例观察

### NativePi：活跃聊天按需持有 Pi 子进程

NativePi 将聊天界面、持久化会话和活动中的 Pi Runtime 区分开：

- 已保存聊天可先从 Pi 的 JSONL 会话文件读取并展示，不要求打开应用时为每个聊天启动 Pi。
- 活跃聊天需要 Agent 工作时才启动 Pi RPC 子进程，并在该聊天活动期间保留进程；其架构允许不同活跃聊天各自拥有 Pi 进程。
- 因而创建聊天界面不必等待 Pi 冷启动，但首次实际 Agent 工作仍可能等待进程启动。它是把等待移出“创建聊天”，不是消除冷启动。

来源：[Working with Pi](https://nativepi.vercel.app/docs/working-with-pi)、[Sessions and storage](https://nativepi.vercel.app/docs/sessions-and-storage)。

### pi-gui：按线程管理 SDK Runtime，首次提交时创建

pi-gui 使用 Pi SDK，并由 Electron 主进程负责线程、会话和 Runtime 管理：

- 应用启动时恢复线程和工作区等桌面状态，不为所有线程预先创建 Agent Runtime。
- 新线程的 Pi Runtime 在首次提交消息时创建或恢复；Runtime 之后按线程管理。
- 使用 SDK 的会话替换能力时，活动 Session 实例会改变，线程相关服务和事件订阅需要随之更新。

该模式将“逻辑线程已存在”与“Pi Runtime 已运行”分开；首次提交仍可能承担 Runtime 初始化成本。来源：[pi-gui 架构说明](https://github.com/minghinmatthewlam/pi-gui/blob/main/docs/architecture.md)、[Pi SDK](https://pi.dev/docs/latest/sdk)。

### 两种案例的共同点与差异

共同点是启动 Runtime 服从实际工作需要，而不是项目被选中或桌面应用启动；首次启动时间并未消失，只是被移到首次 Agent 工作附近。

差异在于进程所有权：NativePi 的活跃聊天可各有独立 Pi 子进程；pi-gui 以 SDK Runtime 按线程管理。两者都把线程/会话与运行中 Runtime 分开，但并不能直接证明哪一种对 pi-desk 性能更快；本次没有基准测试数据。

## pi-desk 现状

- 当前会话打开/新建会启动 Pi sidecar，并等待 `get_state` 成功后进入就绪状态；同项目会话切换通过关闭旧 Runtime、启动新 Runtime 完成。代码位置：`src/main/session-manager.ts`、`src/main/runtime-manager.ts`。
- 固定 Pi 版本记录在 `runtime/pi-runtime.json`。官方 v1.0.4 RPC 命令包含 `new_session` 与 `switch_session`：前者新建会话；后者按会话文件路径切换。两者都可能被 `session_before_switch` Extension handler 取消，响应需检查 `data.cancelled`。
- 这提供了避免“每次会话切换都重启 Runtime”的协议基础；但同进程切换仍需正确重置消息投影、刷新状态，并处理 Extension 取消和事件订阅边界。

来源：[Pi v1.0.4 RPC commands](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/rpc-commands.md)、[Pi v1.0.4 RPC types](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/modes/rpc/rpc-types.ts)。

## 目标拆分与方案取舍

“首次新对话卡顿”可能指两种不同体验，优化目标应先区分：

| 目标 | 方案方向 | 仍然存在的等待或代价 |
| --- | --- | --- |
| 新建聊天界面立即可用 | 先创建桌面端逻辑草稿，Pi Runtime 延迟到首次发送时启动 | 首次发送/Agent 响应仍可能等待冷启动；发送中的输入必须保留且不能重复提交 |
| 首次 Agent 响应也尽量快 | 在用户明确表达工作意图后预热 Pi | 提前占用进程资源；若选项目即预热，会更早触发 Project Trust，且默认持久化会话可能产生空会话 |
| 后续切换会话不再冷启动 | Runtime 启动后保持运行，同项目内优先用 `new_session` / `switch_session` | 需维护投影、状态与 Extension 的会话边界；切项目、资源重载仍需重启 |

## 建议方向（待确认）

优先采用“聊天草稿立即可用 + 首次发送时按需启动 + Runtime 就绪后复用进程”的组合：

1. 新建聊天不等待 Pi 启动，也不因选中项目而预先创建 Runtime 或持久化空会话。
2. 首次点击发送只触发 Pi 启动，不自动提交 Prompt；启动期间保留文字与附件并明确表达状态，Runtime 就绪后由用户再次点击发送。启动失败、Trust 决定或结果未知时不自动重放输入。
3. Runtime 已就绪后，同项目内新建、恢复会话优先使用 RPC 会话命令，避免重复加载进程与项目资源。
4. 项目切换、资源重载和 Runtime 故障恢复可继续采用进程重启。
5. 只有在产品明确要求“首次发送到 Agent 响应也要更快”时，再评估预热的触发时机和成本。调研到的上述案例未显示其采用“选项目即预热”的模式。

## 后续实现讨论中需确定

- 新聊天逻辑草稿的生命周期，以及空草稿是否持久化。
- 首次发送期间的输入保留、启动失败和结果未知处理；不得仅因启动超时就盲目重发 Prompt。
- 同进程切换后的消息投影基准、状态快照、能力缓存与 Extension 会话事件如何收敛。
- Project Trust 提示在首次发送时出现时的界面状态与取消行为。
- 按固定 Pi v1.0.4 再次核对 RPC 命令响应、取消行为和具体事件顺序。
