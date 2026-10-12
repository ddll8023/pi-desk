# 交接：SDK 宿主主链的后续开发

本文供接手人继续开发使用。设计背景见[设计基线](./runtime-sdk-migration.md)、[开发总览](./runtime-development.md)与三个阶段文档；本文只写接手需要的现状、已定决策、代码入口、剩余任务、未验证假设与问题清单。

行号以提交 `b6a4875` 为准，改动历史看 `git log`。

## 1. 现状

会话执行主链已经由独立 SDK 宿主承担，旧 RPC Runtime 退居查询后端：

- **走宿主**：`runtime:start`/`stop`/`status`/`abort`/`rewind`/`capabilities`/`set-model`/`prompt`/`projection`/`ack` 与 Extension UI 两入口，全部经 `SdkRuntimeBridge` → `SdkHostManager` → `utilityProcess` 宿主。
- **仍走旧 `RuntimeManager`**：资源清单、MCP 状态/命令/探测、诊断（即阶段 2 的迁移对象）。
- **开发期退路**：`src/main/index.ts:205` 的 `legacyRpcFallback` 是唯一开关，默认 `false`，运行中不自动落回；它就是 2E 要删除的对象。
- **已实测**：一次完整对话（宿主握手、会话绑定、模型往返、流式投影、回退走官方 fork 分支），协议失败与冷启动误报已修。
- **未实测**：中止、项目切换、Extension UI、宿主崩溃恢复、长历史。

## 2. 运行与验证

```bash
npm run typecheck   # tsc --noEmit (node) + vue-tsc --noEmit (web)
npm run build       # auth-helper + sdk-host 独立构建 + electron-vite build，产物在 out/
npm run dev         # 先构建 auth-helper 与 sdk-host，再起 Electron；主进程日志直接进终端
```

- 宿主入口产物：`out/sdk-host/index.mjs`（`vite.sdk-host.config.ts` 独立构建，官方包 external，从 `node_modules` 解析）。
- `npm run dev` 会把 `stdio: 'inherit'` 交给 Electron，因此主进程 `console.error`（含 `[sdk-host]` 宿主诊断）出现在终端日志里。
- 推送 GitHub 直连会被重置，需要代理：`git -c http.proxy=http://127.0.0.1:7897 push origin main`。
- 本项目的工作方式：**运行、构建、测试、启动服务前必须先取得项目所有者明确授权**；改动前先只读调查并提交逐文件执行清单。

## 3. 已定决策（不要改）

- 页面 `runtimeId` 等于宿主 `bindingId`；页面 `ready` 需要会话进入 `bound`，宿主就绪不代表可提交。
- 会话通道 `SESSION_BUSY` → 页面 `SESSION_SWITCH_BLOCKED`（页面据此发起中断确认）；运行通道 → `RUNTIME_COMMAND_REJECTED`。
- 宿主失败码必须落在既有 Runtime/Session 错误码内，**不新增页面契约**；共享契约（`src/shared/*`）、`preload`、`renderer` 在本轮迁移中不动。
- 宿主自身输出不进入 IPC 契约：`stdio` 保持 `'pipe'` 并持续读空（`HostOutputTail`，8 KB 尾部），失败时只写主进程日志；改回 `'ignore'` 会重新失去故障可观测性。
- 会话失败码不得冒充 `HOST_NOT_READY`：会话侧只保留协议内分类，宿主级原因由宿主状态携带，页面取宿主级优先。
- 用量与速率的形状校验复用 `src/shared/runtime-api.ts` 导出的 `isSessionUsage` / `isOutputRate`，不写第二套。

## 4. 代码地图

| 文件 | 职责 | 注意 |
|---|---|---|
| `src/main/index.ts` | 组合根（200-226）与各 `register*Handlers` | 主链与旧查询的切换点都在这里；每个 handler 逐字段校验 |
| `src/main/sdk-host-manager.ts` | 宿主监督、协议收发、失败分类、诊断日志 | `EXPECTED_REPLIES` 是穷尽表，新增请求类型漏写会在编译期暴露 |
| `src/main/sdk-runtime-bridge.ts` | 宿主状态 → 页面契约映射、错误码表、状态去重 | 错误码表是穷尽 `Record`；`sameStatus` 决定页面能否收到变化 |
| `src/sdk-host/index.ts` | 宿主入口：`initialize`、请求分派、关闭 | 所有出站消息经 `send`，错误只带分类 |
| `src/sdk-host/protocol.ts` | 宿主内部协议与形状校验 | 改状态字段必须同步四处：接口、`emptySdkSessionStatus`、`isSdkSessionStatus` 键白名单、`EXPECTED_REPLIES` |
| `src/sdk-host/session-runtime.ts` | 单活动会话生命周期、投影、速率与用量 | 绑定换代时速率/用量/条数必须一起重置 |
| `src/sdk-host/extension-ui-bridge.ts` | 扩展交互代际与等待计数 | |
| `src/projection/*` | 展示投影、身份摘要、共用速率采样 | `message-projection` 被主进程与宿主共用，改它要同时考虑两代 |
| `src/main/runtime-manager.ts` | 旧 RPC 后端（资源/MCP/诊断/退路） | 2B-2E 的迁移来源；删除前必须确认无业务依赖 |
| `src/main/session-manager.ts` | 会话新建/打开/切换/重载编排 | `legacyRpc` 分派与 `requireLegacyReleased()` 是 2E 的删除对象 |
| `src/main/project-manager.ts` | 项目切换，只用到会话后端的状态查询与关闭链 | |
| `src/main/pi-protocol.ts` | 旧 RPC 形状解析（含 `toResources`、`toExtensionError`） | 2B/2C 的映射参考 |

## 5. 剩余任务

### 2B 资源清单接入宿主

- **取数入口（已在 SDK 内核实）**：`dist/modes/rpc/rpc-mode.js:540-566` 的 `get_commands` 由三处拼成——`session.extensionRunner.getRegisteredCommands()`（extension）、`session.promptTemplates`（prompt）、`session.resourceLoader.getSkills().skills`（skill）。三者都是 `AgentSession` 的公开 getter（`agent-session.d.ts:906/475/624`）。
- **必须保持的形状**：skill 的名称要写成 `skill:<名称>`（RPC 路径就是这么给的），`ResourceView.vue:214`、`PromptComposer.vue:576` 依赖该前缀；`SourceInfo{path,scope,origin,baseDir?}` 对应 `PiResourceEntry` 同名字段。
- **改动点**：`src/sdk-host/protocol.ts` 增加请求 `resources` 与结果帧 `resources-result`（`runtimeId`/`entries`/`truncated`/`error`）并同步 `EXPECTED_REPLIES`；宿主内做 `SourceInfo → PiResourceEntry` 映射；`src/main/index.ts:1010` 改为桥；桥在会话未绑定时返回未就绪错误（页面此时 `runtimeReady=false`，本来就走磁盘预读，不需要改页面）。
- **页面无需改动**：`src/renderer/src/stores/resource.ts:152` 已按 `runtimeId` 校验结果并区分未就绪与错误。
- **待定**：映射代码放宿主内还是提到 `src/projection/`（建议宿主内，避免宿主依赖主进程模块）。

### 2C 诊断接入宿主

- 旧实现的两个来源：RPC 子进程的 stderr 尾部、`extension_error` 事件（`pi-protocol.ts:225`）。
- 宿主没有 Pi 子进程，可用的等价来源：`AgentSessionRuntime.diagnostics`（创建期诊断）、扩展错误、以及宿主自身 stdout/stderr 的 `HostOutputTail`。
- **语义会变**：`RuntimeDiagnostics.stderrLines` 从「Pi 输出原文」变成「宿主进程输出尾巴」，`src/shared/runtime-api.ts` 的注释与页面提示要同步改写，不能让页面文案继续说 Pi。
- 改动点：`src/main/index.ts:1052` 改接桥；桥新增诊断读取（建议只读已有缓冲与已收集诊断，不为查询建立执行上下文）。

### 2D MCP（最不确定，先只读调查再动手）

- 旧三入口：`readMcpStatus`（固定 `/mcp` prompt + notify 捕获）、`runMcpCommand`（`/mcp login|logout|reconnect`）、`inspectMcpServers`（另起 `pi mcp list --json` 一次性 CLI 进程）；另有 `mcp-config-reader` 直接读 `mcp.json`，与 Runtime 无关，可保留。
- **障碍**：SDK 里的 `/mcp` 是 TUI 管理器（`extensions/mcp/index.d.ts` 写明 "opens a manager to sign in, reconnect, enable or disable servers"），**没有找到无头等价入口**；`McpServerRegistry`/`McpServerListing` 只覆盖「已注册服务器与工具暴露」的列举。
- **先查清**：官方 mcp 扩展是否注册了可无头调用的命令、探测结果能否从扩展运行时读出、以及 `inspectMcpServers` 依赖的 `runtime/pi/win32-x64/pi.exe` 在阶段 3 退役时由谁替代。
- **未决选项**：登录/退出/重连改为不可用并如实降级，或找到宿主内等价入口；不要退回旧 RPC 重启链（运行中不落回是既定边界）。

### 2E 删除退路与清理失效表述

- `legacyRpc` 删除顺序：先确认 2B/2C/2D 已替代，再删 `src/main/session-manager.ts` 的 `legacyRpc` 分派（6/47/51/151/176/207/241/250/264/292 行）与 `src/main/index.ts:205/208/220/222`，并一并处理只服务退路的 `requireLegacyReleased()`（`session-manager.ts:78`）与 `runtimeManager` 的注入。
- 失效表述共 9 处：`src/main/index.ts:1000/1052/1066/1184/1823`、`src/main/runtime-manager.ts:1-10`、`src/main/project-manager.ts:55`、`src/main/session-manager.ts:6/47/51/61/176/187/207/250/264`、`src/main/sdk-runtime-bridge.ts:5-6`、`src/main/extension-ui-manager.ts:6`、`src/projection/message-projection.ts:2`、`src/projection/identity.ts:4`、`src/main/sdk-host-manager.ts:170/215/253`。

### 独立项

- **P6 回退未知态**：`rewind` 只在 `HOST_TIMEOUT`/`HOST_EXITED`/`HOST_CLOSED` 时给页面 `blocked`；宿主的 `uncertainOperationId`（`sdk-host-manager.ts:232-240/300-340`）没有对页面收敛，目前只能重启应用或显式打开/重载会话触发自动重建。建议先读清 `uncertainOperationId` 的全部使用点再定收敛方式。
- **`runtime:start-safe`**：`index.ts:1195` 显式失败（宿主暂无「不加载 Extension」等价启动）。UI 仍有两个入口（`ResourceView.vue:822`、`ChatMessageList.vue:398`）。要么实现宿主侧等价能力，要么把入口改成不可用并说明原因。
- **侧栏「新建」在闲置态无反馈**：`ProjectSidebar.vue:142` 刻意不启动 Pi，但按钮没有任何反馈，用户会以为坏了。建议保留不启动语义，改为聚焦输入框并提示「发送后开始新会话」。
- **测试残留**：`H:\code\pi-desk-smoke-project` 空目录与 `desktop-config.json` 里的同名项目条目（`%APPDATA%\pi-desk\desktop-config.json`，删除前需先退出应用）。
- **未实测且影响体验**：历史消息耗时恒为「耗时未记录」（`message-projection` 播种历史时 `generation` 为 null，两代共用该模块，非回归）。

## 6. 未验证假设（先验证再改）

1. `message.usage.output` 是否随流式增量推进。若只在结束时给值，实时速率会恒为 `null`，只剩平均值——`session-runtime.ts` 的速率采样依赖这一点。
2. `getSessionStats()` 的实际成本（已按 1 秒最小间隔补读并在绑定完成后补读一次）；若明显昂贵，改为只在 `message_end`/`agent_end` 后读取。
3. 状态帧频率与体积：速率 tick 最多 4 次/秒，且状态帧现在含用量与速率，未实测对页面与 IPC 的影响。
4. 宿主在 `utilityProcess` 下的行为：SDK 解析、`initialize` 的 30 秒预算、`MAX_AUTOMATIC_REBUILDS = 2` 的自动重建、崩溃后的 `needsHostRebuild` 收敛路径都只跑过一次正常流程。
5. 跨项目切换复用宿主是否会带入旧项目的模型注册或 MCP 连接（项目切换只 release 会话、不重建宿主）。
6. 2B/2C 迁移后数据源变化但页面契约不变，形状对齐需要实测比对（资源条目数量、来源标签、诊断文案）。

## 7. 问题清单

| # | 问题 | 位置 | 建议动作 |
|---|---|---|---|
| 1 | 资源/MCP/诊断仍走旧后端，会话就绪后资源页/MCP/诊断报未就绪 | `index.ts:1010/1052/1066/1076/1105/1127/1146` | 2B → 2C → 2D |
| 2 | MCP 登录/退出/重连无头入口未知 | SDK `extensions/mcp` | 先只读调查，再定降级或等价入口 |
| 3 | 回退结果未知只能重启应用 | `sdk-runtime-bridge.rewind`、`sdk-host-manager.uncertainOperationId` | 2C 后单独收敛 |
| 4 | `start-safe` 显式失败但 UI 仍有入口 | `index.ts:1195`、`ResourceView.vue:822`、`ChatMessageList.vue:398` | 2E 时一并决定 |
| 5 | 侧栏「新建」闲置态无反馈 | `ProjectSidebar.vue:142` | 保留语义 + 加可见反馈 |
| 6 | 失效表述 9 处 | 见 2E 清单 | 2E 同批清理 |
| 7 | 测试项目目录与配置条目残留 | `H:\code\pi-desk-smoke-project`、`desktop-config.json` | 退出应用后清理 |
| 8 | 未实测：中止、项目切换、Extension UI、宿主崩溃恢复、长历史 | — | 迁移前先跑一轮，避免在未验证基础上叠加改动 |

## 8. 接手注意

- 改 `src/sdk-host/protocol.ts` 的字段，四处要一起改（接口、初始值、校验与键白名单、`EXPECTED_REPLIES`）——表是穷尽的，漏改会编译失败，这是刻意的防线。
- 宿主异常只能跨出固定分类：原始 SDK 异常可能带配置或凭据，不要直接透传。
- 迁移期间旧查询仍在承担业务，**不要只因计划进入下一阶段就删除**；确认无调用者后再删。
