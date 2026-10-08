# 第一阶段：Runtime

[开发总览](../development.md) · [下一阶段：基础 Desktop UI](02-desktop-ui.md)

## 目标与边界

打通 `Vue → preload → Electron Main → Pi RPC sidecar → prompt → streaming → tool → abort`。仅一个活动项目、一个 Pi Runtime，使用最小页面，不开发完整 Desktop UI。主进程拥有 Runtime 和临时消息投影，渲染进程只持有展示状态，不建立平行 Session 数据库。

架构与协议依据沿用开发总览。以下是任务范围与依赖，不是一次性实施授权；实际源文件、依赖和操作在每项开发前确定。

## 前置事项

- 本机 Node.js/npm 用于开发；工具版本与直接依赖声明见根目录 `package.json`，系统和运行库约束见开发总览第 3 节。依赖安装不包含 Electron 二进制；本地开发启动前需显式执行 `node node_modules/electron/install.js`。Electron 自带 Node.js 与 Chromium，不要求安装后的用户预装 Node.js 或 WebView2；官方系统家族支持不能代替 Windows build 18363 的具体兼容性判断。
- 不需要 Rust 工具链；Pi 使用固定 standalone 版本，不需要先安装 Bun 或自行编译 Pi。
- 当前没有 C++ 编译链，第一阶段避免需要本地编译的原生依赖。若出现 node-gyp 编译需求，MSVC、Windows SDK 和所需 Python 属于新增前置条件，安装单独取得授权。
- Pi/helper 的运行库需求按目标核实，不依赖待清理的 VC++ DLL；本机存在挂起重启与延迟卸载清理，不能将残留文件视为可靠环境条件。
- 复用已有模型配置与凭据，不读取并输出认证秘密，不开发 Authentication。
- 启动显式拒绝项目资源信任，关闭 Extensions、Skills、Prompt Templates、MCP；保留总览中说明的非沙箱边界。

## 任务拆分

### P1-01 最小项目骨架

**目标**：建立桌面应用、前端入口与单页 Runtime 界面骨架。

**范围**：Electron、Vue 3、TypeScript、Vite、Tailwind CSS、Pinia 的最小配置；主进程入口、sandboxed preload 与统一前端服务入口。明确 contextIsolation 和 sandbox 开启、nodeIntegration 关闭、webSecurity 保持开启；建立固定业务 IPC 入口、调用者校验和本地页面/CSP 边界，不暴露原始 ipcRenderer 或通用系统能力。只建立立即使用的结构，不创建 Session、认证或插件空模块。

**当前实现**：单页展示桌面桥接连接状态与应用信息；桥接连接成功不表示 Pi 就绪。页面输入不持久化，项目目录在启动 Runtime 时由主进程校验。Runtime 启动与状态展示见 P1-03；关闭见 P1-04，发送见 P1-05；文本与 Thinking 区域展示主进程投影的消息（见 P1-06），工具执行与 Stop 见 P1-07，Runtime 诊断区域仍为空状态，不模拟 Pi 输出。

**构建与页面**：配置见根目录 `electron.vite.config.ts`，依赖版本以 `package.json` 为准。

- Main 输出目标为 `out/main/index.cjs`；Electron 与 Node 内建模块由运行环境提供。
- Preload 输出目标为单个 `out/preload/index.cjs`，本地桥接代码全部打入该文件，只引用沙箱允许的 Electron API，不拆分本地模块或输出 ESM preload。
- Renderer 输出目标为 `out/renderer/`；使用浏览器类型环境，不引入 Node 全局能力。
- 开发服务器固定为 `http://127.0.0.1:5173/`，严格端口；主进程只在非正式包且存在 `ELECTRON_RENDERER_URL` 时接受该精确地址。
- 本地构建页面使用 `app://desktop/index.html`，协议仅映射 Renderer 产物中的 `index.html` 与 `assets/` 下的 HTML、JavaScript、CSS，拒绝目录穿越及目录外符号链接目标，不提供项目文件入口。
- 开发 CSP 仅额外允许样式注入与固定 HMR WebSocket 连接；生产 CSP 不允许内联样式、任意网络连接或 `unsafe-eval`。系统权限、下载、新窗口和非可信 frame 导航默认拒绝。

**当前接口**：`window.desktop.getAppInfo()` 无参数，内部使用固定 channel `desktop:get-app-info`。主进程校验已登记窗口、对应 `webContents`、顶层 frame 和精确页面地址，并拒绝额外 IPC 参数；不接受任意 channel、RPC 或系统命令。

成功结果为 `{ ok: true, data }`，`data` 的 `appVersion`、`electronVersion`、`platform`、`arch` 均为字符串。失败结果为 `{ ok: false, error: { code, message } }`。契约定义与响应校验见 `src/shared/desktop-api.ts`。

| 错误码 | 含义 |
| --- | --- |
| `FORBIDDEN` | 调用者不是已登记窗口的可信顶层页面 |
| `INVALID_REQUEST` | 主进程收到额外 IPC 参数 |
| `INTERNAL_ERROR` | 主进程无法取得应用信息 |
| `INVALID_RESPONSE` | Preload 收到不符合应用信息契约的响应 |
| `BRIDGE_UNAVAILABLE` | 前端没有可用的桌面桥接方法 |
| `BRIDGE_CALL_FAILED` | 前端调用桥接时发生异常或 Promise 拒绝 |

组件通过 `src/renderer/src/services/desktop.ts` 调用接口；底层 `invoke` 仍可能拒绝，前端服务将其转换为 `BRIDGE_CALL_FAILED`，不向展示层传递底层错误对象或堆栈。Pinia 仅保存桥接初始化结果，没有 Runtime 所有权或消息数据库；当前接口没有事件订阅。

**项目脚本**：以下 npm 脚本对应关系以根目录 `package.json` 为准，从项目根目录调用；`scripts/start-dev.cmd` 是对 `npm run dev` 的包装入口。

| 调用 | 脚本内容 |
| --- | --- |
| `npm run dev` | `electron-vite dev` |
| `npm run build` | `electron-vite build` |
| `npm run start` | `electron-vite preview` |
| `npm run typecheck:node` | `tsc --noEmit -p tsconfig.node.json` |
| `npm run typecheck:web` | `vue-tsc --noEmit -p tsconfig.web.json` |
| `npm run typecheck` | `npm run typecheck:node && npm run typecheck:web` |
| `npm run pi:prepare` | `node scripts/prepare-pi-runtime.mjs` |
| `scripts/start-dev.cmd` | 定位项目根后执行 `npm run dev`；前置条件缺失时提示并退出，不自动安装或下载 |

脚本说明不构成执行授权；依赖安装、检查、测试、构建、启动和重启仍需单独明确授权。

**依赖**：无其他开发任务依赖；环境准备与依赖安装仍为独立操作。

### P1-02 Pi binary 准备

**目标**：为 sidecar 启动提供固定且匹配目标平台的 Runtime 文件。

**范围**：版本与预期 SHA-256 固定、官方发布包下载校验流程、三目标平台映射、开发 staging 根与资源定位。完整保留官方文件名和相对目录，分别满足 PI_PACKAGE_DIR 与 executable 邻接 loader，不只复制可执行文件。按总览的 electron-builder 方向设计 ASAR 外整体复制，开发和正式包保持相同内部布局。区分开发 host 与构建 target，按实际目标准备文件，不默认下载全部平台，不从 PATH 调用全局 Pi。

**依赖**：P1-01 的项目配置位置。本项确定启动所需准确路径，不擅自完成签名、公证、自动更新或全部平台安装包配置。

**固定清单**：`runtime/pi-runtime.json` 记录基线版本、tag、源码 commit 与三目标资产的预期字节数和 SHA-256，是完整性校验的唯一依据；不在运行时获取 `latest`，也不用执行 `pi --version` 代替摘要校验。三目标与官方资产的映射：

| 目标 | 官方资产 |
| --- | --- |
| `win32-x64` | `pi-windows-x64.zip` |
| `darwin-arm64` | `pi-darwin-arm64.tar.gz` |
| `darwin-x64` | `pi-darwin-x64.tar.gz` |

**staging 与资源定位**：开发 staging 根是仓库内 `runtime/`，Runtime 落在 `runtime/pi/<目标平台与架构>/`，`runtime/pi/` 不入库。归档是平铺根目录，可执行文件与 `package.json`、`README.md`、`CHANGELOG.md`、`theme/`、`assets/`、`export-html/`、`docs/`、`examples/`、`photon_rs_bg.wasm`、`native/<平台>/prebuilds/<平台>-<架构>/<平台>-platform.node` 同层，因此不设置 `PI_PACKAGE_DIR`：`getPackageDir()` 默认值即 `dirname(process.execPath)`，与 package 资源根、以及 WASM 与 native helper 的可执行文件邻接查找同时一致。开发与正式包保持相同内部布局，主进程解析契约见开发总览第 4.3 节；P1-03 实现，P1-02 不改 `src/main`。

**校验顺序与失败处理**：解析 host 目标（只支持清单内的当前主机平台，不支持指定其他平台，也不默认下载全部平台）→ 幂等检查（必需条目齐备且 `package.json` 版本一致则跳过，`--force` 才重建）→ 流式下载并同时计算 SHA-256 → 字节数或摘要不符即删除归档并失败，不解压 → 解压到 `runtime/pi/` 下的临时目录（Windows 用 PowerShell，macOS 用系统 tar；PATH 中的 GNU tar 不支持 zip）→ 校验必需条目与固定版本，`README.md`、`CHANGELOG.md`、`docs/`、`examples/` 缺失只告警 → 全部通过后才替换到 `runtime/pi/<目标平台与架构>/`。任何失败都不得留下半成品目标目录，也不回退到 PATH 中的全局 Pi。

**项目脚本实现**：`scripts/prepare-pi-runtime.mjs` 只使用 Node 内建模块，不新增依赖，不写成安装依赖时的生命周期脚本。

**当前状态**：`runtime/pi/win32-x64/` 已按固定清单准备，`package.json` 版本为 `1.0.4`；macOS 两目标需要在 macOS 主机上准备。

### P1-03 RPC 启动与就绪

**目标**：Electron 主进程以项目目录为 cwd 启动官方 Pi sidecar，并取得真实 RPC 状态。

**范围**：直接使用 child_process.spawn 启动固定 executable，不经过 shell，也不增加 utilityProcess 管理层。建立独立 stdin/stdout/stderr、增量 UTF-8 解码和 LF 分帧；stdout/stderr 持续消费，stdin 由单一 writer 串行写入完整记录并处理背压。主进程生成 Pi request id 并匹配 pending 响应，与 Electron invoke 的响应关联分开；区分协议与诊断错误。发送 `get_state` 并据响应进入就绪状态。最小页面经受限 preload 方法启动 Runtime 并显示状态。

**依赖**：P1-01、P1-02。

**启动参数与环境**：argv 与 cwd 全部由主进程固定，页面只能提供项目目录（完整参数与环境变量见开发总览第 5.1 节）。本项确定 `--tools` 按平台选择：Windows `read,powershell,edit,write`，macOS `read,bash,edit,write`（`--tools` 替换默认集合）。cwd 是主进程校验过的绝对目录，可执行文件只从 staging 根定位，不查 PATH。RPC 模式没有可用模型时 Pi 不进入协议就直接以退出码 1 结束，错误只在 stderr，因此就绪判定必须同时消费 stderr 与退出事件。

**接口与错误码**：`window.desktop.startRuntime(projectPath)` 对应 `desktop:runtime-start`，`window.desktop.getRuntimeStatus()` 对应 `desktop:runtime-status`；两者都返回 `{ ok: true, data }` 或 `{ ok: false, error }`，`data` 是 Runtime 快照。契约与响应校验见 `src/shared/runtime-api.ts`。

| 错误码 | 含义 |
| --- | --- |
| `FORBIDDEN` | 调用者不是已登记窗口的可信顶层页面 |
| `INVALID_REQUEST` | 参数量或形状不符合接口约定 |
| `INVALID_PROJECT_PATH` | 项目目录不是存在的绝对目录 |
| `RUNTIME_ALREADY_RUNNING` | 已有 Runtime 在运行，不做隐式重启 |
| `RUNTIME_SPAWN_FAILED` | 可执行文件缺失或进程无法启动 |
| `RUNTIME_EXITED` | Pi 在就绪前退出，消息含退出码与最近诊断 |
| `RUNTIME_TIMEOUT` | 期限内没有收到 `get_state` 响应 |
| `RUNTIME_PROTOCOL_ERROR` | 记录无法解析、契约不符或 `get_state` 被拒绝 |
| `INTERNAL_ERROR` | 其他内部失败 |
| `INVALID_RESPONSE`、`BRIDGE_UNAVAILABLE`、`BRIDGE_CALL_FAILED` | Preload 与前端侧的桥接校验失败 |

**主进程落点**：三类职责分别落在 `src/main/pi-process.ts`、`src/main/pi-protocol.ts`、`src/main/runtime-manager.ts`（消息投影在 P1-06 拆到 `src/main/message-projection.ts`）；IPC 注册与调用者校验在 `src/main/index.ts` 接线，受限方法由 `src/preload/index.ts` 暴露。

**状态与边界**：状态为 `idle`、`starting`、`ready`、`stopping`、`failed`（`stopping` 与关闭链见 P1-04），就绪快照只投影模型、Thinking 级别、Session 标识、消息数与 streaming 标志。`get_state` 等待期限为 10 秒；单条 stdout 记录上限 8 MiB（按解码后字符数计），超限按协议错误处理；stderr 只保留最近 40 行、单行截断到 400 字符。本项不开放事件订阅、Prompt、Stop 与重启；关闭唯一窗口时先关闭 Pi 的 stdin 请求其自行有序退出，等待退出期限与平台定向进程树终止见 P1-04。

**当前状态**：主进程、受限 preload 方法与最小页面已按上述参数与契约接入启动链；Tool 与 Stop 见 P1-07。

### P1-04 Runtime 生命周期

**目标**：明确活动进程和管道的所有者，支持可控的关闭与重新启动。

**范围**：重复启动限制、初始化失败清理、持续 stderr 消费、有界诊断、异常退出通知、pending 请求失败收敛、stdin 正常关闭、退出等待与超时终止。切换目录需结束旧 Runtime；采用 Runtime 代际隔离旧进程事件。关闭唯一业务窗口或失去唯一可信控制界面时，主进程发起可控关闭，不默认留下后台 Agent。

Windows 采用系统 taskkill 定向终止当前受管 Pi 进程树；macOS 建立独立进程组并在必要时终止该组，不通过 unref 解除应用管理。只处理主进程自身管理对象，不接受任意 PID 或按进程名批量终止。根进程已退出、主进程崩溃或派生进程脱离后的清理不作完整保证，不为此引入 Job Objects 原生绑定或专用 helper。

本项先完善无 Agent 操作时的关闭链；有活动操作时的取消已在 P1-07 补齐（仅在事件流显示运行中时先 abort，见本文 P1-07 段）。不自动重放 prompt，不将关闭 Pi 主进程宣传为已经解决所有派生进程回收。

**关闭链**：`window.desktop.stopRuntime()` 对应 `desktop:runtime-stop`，是幂等动作。关闭时先置 `stopping` 停止接受新请求，再关闭 stdin 请求 Pi 自行退出，继续消费管道并等待有限期限；超时后按平台兜底——Windows 直接用 `%SystemRoot%\System32\taskkill.exe /F /T /PID` 定向终止受管进程树（不先只杀根进程），macOS 向独立进程组先发 `SIGTERM`、必要时再发 `SIGKILL`（期限与平台兜底见开发总览第 6.2 节）。期限内确认退出则回 `idle` 并保留本次 `runtimeId`；未能确认退出则落 `failed` 并显示原因，不声称已经清理干净。

**状态事件**：主进程状态变化通过 `desktop:runtime-status-changed` 单向推给当前唯一可信窗口，payload 就是 `RuntimeStatus`；preload 暴露 `onRuntimeStatusChanged(listener)` 并返回释放函数，页面先订阅再查询一次当前快照，不引入事件序列号（序列基点属 P1-06）。状态取值与 `idle` 的运行时标识语义见 `src/shared/runtime-api.ts`。

**退出编排**：关闭唯一窗口只触发 `app.quit()`；`before-quit` 里 `preventDefault()` 一次，等待关闭链，预算内未完成则 `app.exit(0)` 强制退出，不让应用挂死（预算见开发总览第 6.2 节）。Windows 的系统关机或注销不触发 `before-quit`，该路径不保证回收。

**启动与关闭的交互**：已有 Runtime（含 `stopping`）时再次启动返回 `RUNTIME_ALREADY_RUNNING`，不做隐式重启；切换目录需先关闭再启动。由主动关闭引起的启动失败不覆盖关闭后的快照。

**依赖**：P1-03。

### P1-05 Prompt 请求

**目标**：从页面提交 prompt，区分接受、拒绝与后续执行状态。

**范围**：输入、受限 preload 方法、主进程参数与调用者校验、结构化请求、`disposition` 处理、请求错误与 busy 状态。invoke 返回请求接受或失败结果，后续运行结果走事件流；区分 Pi 命令失败、通信失败与结果未知，不依赖原样跨 IPC 传递 Error 对象。不把 prompt response 当作完成通知，不自动重发超时请求，不开放任意 RPC JSON 或独立 shell 执行入口。

**接口与错误码**：`window.desktop.sendPrompt(message)` 对应 `desktop:runtime-prompt`，成功数据是 `{ disposition }`，失败为 `{ ok: false, error }`；契约与响应校验见 `src/shared/runtime-api.ts`。入参上限、等待期限与错误分类见开发总览第 5.3、6.2 节。

| 错误码 | 含义 |
| --- | --- |
| `FORBIDDEN` | 调用者不是已登记窗口的可信顶层页面 |
| `INVALID_REQUEST` | 参数量或形状不符合接口约定，或 Prompt 内容为空、超长 |
| `RUNTIME_NOT_READY` | Runtime 不是 `ready` 的本地状态冲突 |
| `PROMPT_REJECTED` | Pi 以 `success: false` 拒绝，消息带 Pi 的原因文本 |
| `RUNTIME_TIMEOUT` | preflight 期限内没有响应，结果未知且不重发 |
| `RUNTIME_EXITED` | 提交期间管道关闭或进程结束 |
| `RUNTIME_PROTOCOL_ERROR` | 记录无法解析、契约不符或 disposition 取值非法 |
| `INTERNAL_ERROR` | 其他内部失败 |
| `INVALID_RESPONSE`、`BRIDGE_UNAVAILABLE`、`BRIDGE_CALL_FAILED` | Preload 与前端侧的桥接校验失败 |

**busy 与运行中状态**：busy 判定完全以 Pi 的拒绝为准，主进程不做本地 `get_state.isStreaming` 预检，因而不新增 `RUNTIME_BUSY`；本项也不维护本地运行中标志、不新增 `isStreaming` 刷新点，运行中状态与最终收敛由 P1-06 依据事件流（`agent_settled`）负责。请求失败不改写 Runtime 快照，进程真的退出时由退出路径收敛。

**落点**：response 形状识别在 `src/main/pi-protocol.ts`（`toPromptDisposition`），请求编排在 `src/main/runtime-manager.ts`（`prompt`），IPC 注册与调用者校验在 `src/main/index.ts`，受限方法由 `src/preload/index.ts` 暴露，前端入口在 `src/renderer/src/services/runtime.ts` 与 `src/renderer/src/stores/runtime.ts`，页面在 `src/renderer/src/App.vue`。

**当前状态**：页面、preload 方法、主进程校验与错误分类已按上述契约接入。

**依赖**：P1-04。

### P1-06 Streaming 消息

**目标**：实时展示 assistant 文本和 Thinking，保持消息重建一致。

**范围**：在发送前完成事件订阅；主进程按内容块重建临时投影，以块结束内容与完整 `message_end.message` 校正，处理用户消息、执行错误和最终消息，使用 `agent_settled` 收敛 busy 状态。渲染进程展示定向更新、释放监听并隔离旧 Runtime 事件；重新订阅时取得投影与序列基点。

采用有界批次和渲染端应用确认控制未确认通知，落后时从投影重新同步，不无限缓存原始事件，也不为等 UI 暂停消费 Pi stdout。展示更新按语义合并，不丢弃最终消息、错误和运行终态；展示超限明确标示截断，协议超限或失同步明确报错，不能伪装为完整内容。第一阶段不增加 MessagePort 通道。

**接口与事件**：`window.desktop.getRuntimeProjection()` 对应 `desktop:runtime-projection`，返回投影快照；`window.desktop.ackRuntimeProjection(runtimeId, seq)` 对应 `desktop:runtime-projection-ack`，只控制未确认通知窗口；批次经 `desktop:runtime-projection-changed` 单向推送，载荷是带 Runtime 代际标识与序号的投影批次。契约与响应校验见 `src/shared/runtime-api.ts`；投影模型、批次节拍、未确认窗口、重同步与上限常数见开发总览第 6.2 节。

**决策**：投影重建展示片段而不是转发原始事件；批次携带单调序号，渲染端以应用确认控制未确认窗口，遇到序号缺口、长度不变式不符或重同步标记时以快照全量重同步，不猜测补齐；状态变化与投影批次保持两条独立通道；投影只保留当前 Runtime 代际，Runtime 结束即清空；busy 由 `agent_start`/`agent_settled` 收敛，为 `RuntimeInfo.isStreaming` 提供事件来源。非 `user`/`assistant` 角色的消息不进入投影，工具执行结果属 P1-07。

**落点**：投影状态机在 `src/main/message-projection.ts`，批次订阅与状态提示合并在 `src/main/runtime-manager.ts`，IPC 注册与校验在 `src/main/index.ts`，受限方法由 `src/preload/index.ts` 暴露，前端入口在 `src/renderer/src/services/runtime.ts` 与 `src/renderer/src/stores/runtime.ts`，页面在 `src/renderer/src/App.vue`。

**当前状态**：页面、preload 方法、主进程投影与批次、渲染端同步与截断标示已按上述契约接入；工具面板见 P1-07，诊断面板仍为空状态。

**依赖**：P1-05。

### P1-07 Tool 与 Stop

**目标**：展示工具执行生命周期，并能停止当前 Agent 操作而保留 Runtime。

**范围**：主进程投影按 `toolCallId` 关联工具名称、参数、更新、结果、错误；不将所有 partialResult 一律追加，最终以结束结果校正。前端采用简单结构化展示，保留非文本结果，不将模型或工具输出作为可执行 HTML。加入受限 abort 操作、停止中状态与终态收敛，补齐运行中关闭 Runtime 的取消路径；停止接收新业务请求后仍保留内部取消路径，不无限等待 abort 才进入退出兜底。并发查询与取消不能被长时间持锁阻塞。

不开放 steering / follow-up 排队输入；不把 `abort` 当作自动清空队列。完整 Tool Card、专属工具 UI 和 Diff 留在后续阶段。

**接口与错误码**：`window.desktop.abortRuntime()` 对应 `desktop:runtime-abort`，零参数，成功数据是当前 Runtime 快照（表示 Pi 已确认取消），失败为 `{ ok: false, error }`；投影新增按 `toolCallId` 索引的工具条目与 `{ kind: 'tool' }` 更新，快照新增 `tools` 与 `droppedTools`，契约与响应校验见 `src/shared/runtime-api.ts`；工具条目的状态取值、批次与上限见开发总览第 6.2 节。

| 错误码 | 含义 |
| --- | --- |
| `FORBIDDEN` | 调用者不是已登记窗口的可信顶层页面 |
| `INVALID_REQUEST` | 参数量或形状不符合接口约定 |
| `RUNTIME_NOT_READY` | Runtime 不是 `ready` 的状态冲突 |
| `RUNTIME_TIMEOUT` | 中止等待期限已过，结果未知且不重发 |
| `RUNTIME_EXITED` | 中止期间管道关闭或进程结束 |
| `RUNTIME_PROTOCOL_ERROR` | 记录无法解析、契约不符或 Pi 拒绝该命令 |
| `INTERNAL_ERROR` | 其他内部失败 |
| `INVALID_RESPONSE`、`BRIDGE_UNAVAILABLE`、`BRIDGE_CALL_FAILED` | Preload 与前端侧的桥接校验失败 |

**决策**：工具执行以按 `toolCallId` 索引的独立条目进入投影，与消息块解耦，不把执行状态挂在 assistant 消息的 toolcall 块上；`partialResult` 只保留最近一次、结束事件用 `result` 校正；`abort` 只校验可用的 Runtime，不在主进程做 streaming 预检，停止中状态由页面按中止请求与事件流 `isStreaming` 共同表达，终态以 `agent_settled` 收敛；关闭 Runtime 时仅在事件流显示运行中才先 abort，等待上限明显短于退出预算，取消失败不阻断既有关闭链；不新增错误码；工具参数与输出一律按纯文本展示，非文本内容只标示数量。

**落点**：工具条目状态机在 `src/main/tool-projection.ts`，批次与聚合在 `src/main/message-projection.ts`，中止编排与关闭链中的取消在 `src/main/runtime-manager.ts`，IPC 注册与校验在 `src/main/index.ts`，受限方法由 `src/preload/index.ts` 暴露，前端入口在 `src/renderer/src/services/runtime.ts` 与 `src/renderer/src/stores/runtime.ts`，页面在 `src/renderer/src/App.vue`。

**当前状态**：页面、preload 方法、主进程工具投影与中止编排已按上述契约接入；Runtime 诊断面板仍为空状态。

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
- 自动重启重放、完整崩溃恢复、完整进程树回收保证、Pi OS 权限沙箱。

## 待决策事项

- 完整依赖树锁定、Electron 与固定 Pi/helper 的共同系统要求，以及原生组件的预编译资源、运行库或编译前置条件。
- Pi 配套资源的 staging 路径、目标文件选择与 package 根/executable 邻接映射已在 P1-02 确定（见本文 P1-02 段与开发总览第 4 节）；正式安装包沿用 ASAR 外整体资源方向，发行配置在相应步骤确定。
- Runtime 操作的临时投影、订阅序列基点、通知批次与应用确认的具体契约，以及缓存预算和请求期限；Runtime 启动与状态查询的 IPC 业务结果已在 P1-03 确定，Prompt 请求的入参上限、等待期限与错误分类已在 P1-05 确定（见开发总览第 5.3、6.2 节）。
- 关闭期限与平台定向终止方式已在 P1-04 确定（见 P1-04 段与开发总览第 6.2 节）；macOS 进程组分支只在 macOS 主机上生效，保持尽力回收边界。
- Pi/helper 的运行库需求，以及挂起重启与延迟清理对本机环境的影响。
- 现有模型是否可选；缺少凭据时如何给出清晰提示，不能转为提前开发登录功能。
