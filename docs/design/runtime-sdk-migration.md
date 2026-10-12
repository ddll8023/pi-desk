# Runtime 托管方式迁移：RPC sidecar → 官方 SDK

## 1. 文档定位

本文是 pi-desk 运行时托管方式迁移的需求与设计基线，供后续开发对话按阶段实施。本文只写范围、决策、职责边界与指向；一切可核对的事实（启动参数、通道名、错误码、常量、版本）只以代码为准，本文不复制。

本文不做验证方向、测试计划与通过标准，这些在各自开发阶段单独讨论。

## 2. 决策与前提

**决策**：把 Agent 运行时的宿主从「外部 `pi` 二进制 + stdio RPC」改为「官方 `@earendil-works/pi-coding-agent` SDK 托管在应用自己的进程中」。

**代价必须写清楚**：这次迁移放弃以下能力——驱动用户自装的外部 `pi` 二进制、与 CLI 逐字节同版本、多引擎（协议兼容的第三方二进制）兼容。换取的是：模型目录、provider 认证、资源清单不再需要任何进程往返，会话切换不再停+起进程。

**因此不把原设计定性为「错」**：sidecar 路线是用「等待」换到了上面那些能力，属于取舍而非缺陷。迁移是换一种取舍，不是纠错。

**前提约束（迁移后仍须成立）**：

- 渲染进程只渲染，不碰 Node、文件系统与密钥；IPC 有类型契约与主进程校验。
- Pi 的本机会话文件（JSONL）是会话唯一真相，桌面端不自建副本，终端与 GUI 可轮流接管同一会话。
- Pi 的 agent 目录是配置唯一真相（`models.json`、`auth.json`、`mcp.json`、`settings.json`）；桌面端只读写这些文件，不另存配置副本。
- Project Trust 的确认点仍由桌面端接管。
- agent 语义（会话树、压缩、队列、工具、扩展、供应商与模型行为）全部由 Pi SDK 负责，桌面端不自研替代实现。

## 3. 要解决的问题

现有实现里「等待 Pi」有三个独立来源，迁移要分别消除：

1. **模型目录与服务生命周期耦合。** 候选模型来自一次性预读探针，或运行中 Runtime 的能力；探针作用域按「项目 + 信任」分键，且 Runtime 状态变化时缓存失效。相关模块：`src/main/resource-preview.ts`、`src/renderer/src/stores/runtime.ts`、`src/renderer/src/components/RuntimeModelSelect.vue`。
2. **会话切换等于进程重启。** 打开/切换/新建会话都会先结束旧 Runtime 再启动新的；Runtime 还是全局单例，重复启动被拒绝。相关模块：`src/main/session-manager.ts`、`src/main/runtime-manager.ts`。
3. **能力数据与进程耦合。** provider 认证状态、已配置模型、项目资源清单的展示都经过 Pi 进程（认证已由独立 helper 进程承担，属于部分例外）。相关模块：`src/main/auth-manager.ts`、`src/main/resource-preview.ts`、`src/renderer/src/stores/resource.ts`。

叠加因素（迁移后自然消失，但要在实施时确认没有以别的方式复现）：探针未关闭启动时的网络目录刷新；探针把资源发现与模型读取放在同一次进程启动里；界面把「未启动」表达为「加载中」。

## 4. 重构要求（目标状态）

### 4.1 数据分层

| 层 | 内容 | 归属 | 界面表现 |
|---|---|---|---|
| L1 桌面本机 | 项目列表、界面偏好、会话文件索引 | Electron 主进程 + 桌面配置文件 | 启动即读，不出现加载态 |
| L2 Pi 全局快照 | 可用模型目录与能力、provider 认证状态、用户级资源清单 | 应用进程内的 SDK 实例，主进程持有快照 | 有则显示，无则空骨架，绝不阻塞 |
| L3 会话运行态 | 会话 runtime、消息投影、工具、rewind、中止 | 每会话一个 SDK session | 只影响对话区 |

### 4.2 运行时形态

- Agent 运行时必须运行在应用自己的进程内，且**不在渲染进程**。
- 会话与运行时一一对应：同一项目内新建/切换会话复用进程、不重建运行时；只有项目切换、信任决定变化、配置或资源需要重新加载时才重建。
- 会话并发（多会话同时存在）是**可选能力**，不作为本迁移的必需项；若宿主形态选择允许多会话，需在设计时明确内存与投影的代价。

### 4.3 界面状态

- 统一四态：可用 / 加载（有占位）/ 需要用户动作 / 错误。
- 「运行时尚未启动」不得表达为加载中或不可用；凡是 L2 能回答的问题（模型列表、认证状态、资源清单）不得因会话未启动而阻塞。
- 运行时启动只影响对话区与需要执行动作的入口（提交、中止、回退、工具审批、MCP 连接）。

### 4.4 保持不变

- 现有 `stores/*` 的 view 状态机形状、preload 桥接与主进程校验模式、错误码与统一响应契约继续沿用，避免迁移同时改两套约定。
- 桌面端新增的领域能力（模型可见性、默认模型、项目记忆等）语义不变，只更换数据来源。

## 5. 参考项目

已核实（读的是仓库代码，不是二手描述）：

| 项目 | 形态 | 可借鉴的具体做法 |
|---|---|---|
| `heyhuynhgiabuu/openpi` | Electron + SDK sidecar | 最接近本项目的形态：`electron/pi/sidecarHost.ts` 用 Electron `utilityProcess.fork`（非 Electron 环境退回 node `fork`）托管 SDK 宿主，宿主通过 parentPort 通信，并明确「没有 parentPort 就必须跑在 utilityProcess 或 node fork 里」；`packageManager`/`updater` 由应用自己管理 Pi 包版本；`providerHost`/`providerAuth` 把认证放进宿主；主进程持有 typed IPC（`electron/ipc`）。 |
| `minghinmatthewlam/pi-gui` | Electron + SDK（主进程） | `packages/pi-sdk-driver` 是唯一 import SDK 的地方，全仓库无 `pi` 子进程；`runtime-supervisor` 用 `ModelRuntime.create({ authPath, modelsPath, refreshOnCreate:false })` 直接读模型与认证；`session-supervisor` 用 `createAgentSession*` 系列管理会话；`npm-package-fallback` 在打包的 SDK 不可用时退回 npm 安装的包——这是「升级 SDK 即升级运行时」风险的现成缓解手段。 |
| `Jaxton07/percho` | Electron + SDK（后端包） | 三包结构：契约包 / 后端包 / 桌面包，只有后端 import SDK，依赖方向单向；审批 dock + 工具规则引擎；错误与重试集中在 UI 层。可借鉴的是「契约与实现分离」和「审批入口统一」。 |
| `justhil/pi-app` | Electron + SDK（worker） | `src/worker/worker-runtime.ts` 用 `createAgentSessionServices` → `createAgentSessionFromServices` → `createAgentSessionRuntime` 在 worker 里建会话；渲染进程完全不碰 SDK；会话、登录与设置留在 Pi 本机目录，CLI 与应用可轮流接管同一会话。多会话隔离做得最彻底。 |
| `vastsa/PI-Desktop` | Electron + SDK + Rust host-core | `packages/agent-runtime` 直接 import `createAgentSession`/`ModelRuntime`/`SessionManager`/`DefaultResourceLoader`/`SettingsManager`；另有插件能力矩阵与独立 host 进程。可借鉴「agent 运行时单独成包」的切分。 |
| `ayuayue/PiDeck` | RPC sidecar（**反面参照**） | 与当前实现同构，且已经被迫自建一层来掩盖等待：启动后台预热、主进程模型列表缓存、`pi --list-models` 解析、`models.json` 兜底、目录刷新节流、失败原因分类。这说明 sidecar 路线的等待无法自然消除，只能额外补一层；迁移就是要避免继续维护这一层。 |

未能核实：`DLYZZT/pi-desktop`。该仓库当前重定向到 `vastsa/PI-Desktop`，无法作为独立参考，本文不使用。仓库内 `docs/pi-desktop-ecosystem-research.md` 中关于该项目的描述需要重新核对后再引用。

## 6. 宿主形态（阶段 1 必须先定）

三个候选，按推荐顺序：

1. **独立 utilityProcess 托管 SDK（推荐）**。与 openpi 一致：主进程负责窗口、IPC、会话监督与生命周期，宿主进程只跑 SDK。收益：SDK 崩溃或阻塞不拖垮主进程；SDK 的 ESM/原生依赖问题与 Electron 主进程隔离；未来可换宿主实现而不动主进程契约。代价：多一层进程与消息契约。
2. **主进程内嵌 SDK（pi-gui 形态）**。收益：最少一层 IPC，实现最快。代价：SDK 的同步/阻塞操作会挂在主进程上，长会话与多会话时风险集中；升级 SDK 直接影响主进程稳定性。
3. **每会话一个 worker（pi-app 形态）**。收益：会话隔离最好，天然支持并行会话。代价：内存与进程数随会话增长，投影与状态同步复杂度最高。

本项目已有先例支持选项 1：`src/auth-helper` 已经在独立进程内 import 官方 SDK 并单独打包运行（`vite.auth-helper.config.ts`）。扩展这个模式比从零建立宿主风险低。

## 7. 迁移范围（模块指向，非文件级清单）

- **主进程运行时层**：`src/main/runtime-manager.ts`、`src/main/session-manager.ts`、`src/main/pi-process.ts`、`src/main/pi-protocol.ts`、`src/main/resource-preview.ts`、`src/main/message-projection.ts`、`src/main/tool-projection.ts`、`src/main/extension-ui-manager.ts`。
- **认证**：`src/main/auth-manager.ts`、`src/main/auth-helper-process.ts`、`src/auth-helper/*`（SDK 宿主建立后，这部分可能并入宿主）。
- **契约层**：`src/shared/runtime-api.ts`、`session-api.ts`、`auth-api.ts`、`resource` 与 `project-file` 相关契约、`src/preload/index.ts`。
- **渲染端**：`src/renderer/src/stores/runtime.ts`、`session.ts`、`resource.ts`、`auth.ts`，以及依赖运行时状态的组件（顶栏模型选择器、对话区空状态与输入框、会话选择、资源页、设置页模型页）。
- **打包与运行时准备**：`scripts/prepare-pi-runtime.mjs`、`runtime/pi-runtime.json`、`electron.vite.config.ts`。SDK 由 npm 依赖提供后，下载 standalone 二进制的流程需要下线或保留为可选引擎。
- **新增**：SDK 宿主及其 typed IPC 契约（见第 6 节形态选择）。

## 8. 阶段划分

阶段只写目标、设计关注点与依赖，具体实现与测试安排在各阶段单独讨论。

**阶段 1：宿主与 L2 打通**
目标：确定宿主形态；建立最小可用的 SDK 宿主；模型目录、provider 认证状态、用户级资源清单改由宿主回答并缓存，界面不再等待进程。
关注点：宿主进程边界与消息契约、宿主生命周期（何时启动、何时重建、崩溃恢复）、快照失效与刷新触发点、与现有 `auth-helper` 的关系。
依赖：无。

**阶段 2：会话与投影迁移**
目标：会话列表、新建、打开、切换、消息投影、工具投影、回退全部走 SDK；切换会话不再重建运行时。
关注点：会话文件（JSONL）读写归属、投影与 SDK 事件的对齐、运行时内切换会话与运行中操作的互斥、本地新增的 rewind 语义如何映射到 SDK 能力。
依赖：阶段 1（宿主与契约）。

**阶段 3：扩展、信任与权限**
目标：扩展加载与 UI 桥接、工具审批、MCP 全部在 SDK 宿主内成立。
关注点：Project Trust 在 SDK 下的确认点、扩展来源与启用状态与 Pi 设置保持一致、审批入口统一、工具投影的差异。
依赖：阶段 2。

**阶段 4：清理**
目标：下线 RPC 侧的全部链路与二进制准备流程。
关注点：确认没有遗留依赖（预读探针、协议层、进程管理、二进制下载与校验、信任探针）、文档与记忆同步。
依赖：阶段 3。

## 9. 风险与不确定性

- **升级 SDK 即升级运行时**：需要与扩展兼容性策略一起考虑；pi-gui 的 npm 包 fallback 与版本断言是可参考的缓解手段。
- **打包风险**：SDK 为 ESM，且可能含原生依赖；在 Electron 主进程与 utilityProcess 中的加载差异需要先验证（openpi 的实现里对 ASAR 有专门处理）。
- **本次迁移会失去的能力**：不能再驱动用户自装或第三方的 `pi` 二进制；若以后需要多引擎，必须重新引入。
- **权限与信任语义差异**：CLI 与 SDK 在信任、扩展加载顺序、工具集合上的行为可能有差异，需要逐项核对后再迁移相关界面。
- **未核实事项**：Agent 运行中能否直接切换会话；SDK 在全 Electron 主进程内长期运行的稳定性；多会话并发的实际内存代价。

## 10. 待定问题（新对话开始时先定）

1. 宿主形态选第 6 节的哪一项。
2. 迁移期间是否双轨（保留 sidecar 一段时间，宿主与 sidecar 并存并逐步切换），还是直接切换。
3. 是否保留「外部 pi 二进制」作为可选引擎（若保留，宿主形态与契约设计需要预留抽象）。
4. 多会话并发是否进入本轮范围。
