# pi-desk 结构重构初步设计

本文用于明确需求、范围、当前事实、大致设计思路、关键取舍、风险与开发阶段方向，不是实现规格或开发授权。具体文件改动、导入路径、构建入口与逐项执行清单，在各阶段结合当时事实单独讨论并另获确认。

## 1. 需求、范围与不做项

### 1.1 用户明确提出的目标

- 保留合理的 Electron 运行边界，明确主进程、preload、页面、SDK 宿主、终端守护进程与辅助入口的职责。
- 在运行边界内部按业务能力聚合代码，解决 `main/` 与前端文件平铺、模块实现分散的问题。
- 收敛 `src/main/index.ts`、`src/preload/index.ts`、`App.vue` 与综合 Runtime Store 的混合职责。
- 明确共享设施与跨模块接口，处理双向调用和循环依赖；不只为搬文件、增加空目录或制造透传层。
- 按真实职责判断是否收拢 `src/` 下的辅助入口，不以减少一级目录数量作为目标。

### 1.2 本次明确不做

- 不新增功能，不顺带升级依赖，不改造产品交互。
- 默认保持公开行为、IPC 契约、状态归属、存储位置、权限与信任边界、进程生命周期不变。
- 保留独立 SDK 宿主与终端常驻机制，不把进程隔离误写为文件隔离。
- 不清理发布包、运行数据、会话历史或项目记忆。
- 不在本阶段运行测试、检查器、构建、安装依赖或启动服务。

### 1.3 任务级别

按设计协议属级别 C（架构调整与重要重构），采用标准流程：先建立项目事实，再给出一个推荐方向与至多两个有真实价值的替代方向，最后按风险划分阶段。

## 2. 项目事实

以下为本次只读核查的实测结论，来源为当前源码、构建配置与工作区状态。文档与既有审查结论只用于导航，均经源码复核。

### 2.1 规模与分布

下表的目录与行数是**重构开始前的快照**，其中的 `src/projection/`、`src/extensions/genui/`、`src/runtime-install/`、`src/update-check/`、`src/package-update/`、`src/pi-cli/` 已不存在，现行结构见 [项目结构文档](项目结构文档.md)。保留本表只为说明当时的规模依据。

| 运行单元 | 文件数 | 代码行数 | 备注 |
| --- | --- | --- | --- |
| `src/main/` | 50 | 15 803 | `index.ts` 3 206 行；其余 45 个非测试文件 12 206 行 |
| `src/preload/` | 1 | 1 566 | 单文件承载 16 个域 Api |
| `src/renderer/` | 165 | 35 580 | 根目录 42 个 `.ts`、`components/` 60、`stores/` 22、`services/` 19 |
| `src/shared/` | 21 | 8 287 | `genui-api.ts` 2 154 行、`runtime-api.ts` 1 558 行 |
| `src/projection/` | 6 | 2 525 | 仅被 `src/sdk-host/session-runtime.ts` 引用 |
| `src/extensions/genui/` | 7 | 1 699 | 仅被 `src/sdk-host/session-runtime.ts` 引用 |
| `src/sdk-host/` | 4 | 1 896 | 会话执行主体 |
| `src/terminal-daemon/` | 6 | 1 566 | 常驻终端 |
| `src/auth-helper/` | 2 | 719 | Provider 认证辅助进程 |
| `src/runtime-install/` | 2 | 620 | `index.ts` 为一次性安装入口，`runtime.ts` 为共享运行时布局 |
| `src/update-check/` / `src/package-update/` / `src/pi-cli/` | 各 1 | 349 / 114 / 21 | 一次性受管入口 |

### 2.2 依赖图实测结论

- `src/main` 内部**无循环依赖**；`import` 出度集中在 `session-manager`(7)、`git-service`(5)、`project-manager`(4)、`sdk-host-manager`(4)、`sdk-runtime-bridge`(4)，其余业务模块出度为 0–1；被引用集中在 `pi-paths.ts`(8)、`desktop-config-store.ts`(6)、`pi-cli-process.ts`(5)、`process-tree-termination.ts`(5)、`project-entry-path.ts`(5)、`session-run-registry.ts`(5)。
- 但 `import` 出度不等于跨能力复用。按导出符号名静态比对，业务模块之间仍存在跨能力引用具体符号的情况：`git-service` 复用 `git-command` 的错误类与常量，`session-manager` 复用 `sdk-host-manager` 的 `SdkHostError` 与 `sdk-runtime-bridge` 的 `sessionErrorOf`，`models-config-manager` 与 `pi-settings-manager` 复用 `file-lock` 的 `FileLockError`/`withFileLock`。
- 真正的横跨中心只有 `src/main/index.ts`：按导出符号名比对，它引用了 38 个来自其他主进程文件的导出符号，是所有业务模块的唯一组装者。**这是“只有组合根横跨全部业务”的直接证据，也是阶段 1 选它作为起点的依据。**
- `src/shared` 内部无循环；被引用次数：`runtime-api.ts` 43、`desktop-api.ts` 30、`genui-api.ts` 24，其余 8–19。
- 跨运行单元引用共 22 条，其中 20 条指向 `src/shared`；非 shared 的四类为：`main → sdk-host/protocol`、`main → auth-helper/protocol`、`main → terminal-daemon/endpoint`、`terminal-daemon/session-manager → main/shared/process-tree-termination`，另有多处指向当时的 `runtime-install/runtime.ts`。后两类已在阶段 2 处置：`runtime.ts` 与 `process-tree-termination.ts` 都下沉到 `src/shared-process/`，跨单元依赖不再指向 `src/main` 内的文件。
- 全库共 5 处循环，全部在前端：`session.ts ↔ workspace-tabs.ts`、`file-rich-markdown-codec ↔ -details`、`file-rich-markdown-source ↔ -block-source`、`GenuiNode ↔ GenuiCollapse`、`GenuiNode ↔ GenuiTabs`。后四者中，`file-rich-markdown` 两对为数据编解码互递归，`GenuiNode` 两处为节点递归渲染，**属有意为之**，不应按“必须消除”处理；只有 `session ↔ workspace-tabs` 是编排倒挂。

### 2.3 职责混杂的实测证据

- `src/main/index.ts`：102 个 `handle()` IPC 注册、40 个 `*Failure` 错误映射函数（全仓共 49 个此类函数，其余 9 个定义在非 `ipc.ts` 文件里）、10 个广播函数，以及窗口创建、资产协议、便携数据目录、单实例锁、退出链、启动自动更新，还集中实例化全部业务服务。
- `src/preload/index.ts`：114 处 `ipcRenderer` 调用、约 100 条 `INVALID_*` 常量与 `invalid*Response` 工厂，16 个域的 Api 合并后一次性 `exposeInMainWorld('desktop')`。
- `src/renderer/src/App.vue`：16 个 Store 引用、Store 初始化与 `dispose` 顺序编排、5 个 `ConfirmDialog` 与 5 个业务弹层、布局与响应式处理，以及项目/会话/文件/快捷命令的确认意图。
- `stores/runtime.ts`（重构前的路径）：1 412 行，同时持有会话运行状态、投影应用与历史缓存、模型能力与切换、Pi 默认模型、隐藏模型偏好与写回、资源预读。其中模型相关部分只被 4 个组件消费（`ModelSettingsView`、`ProviderListItem`、`ProviderVisibilitySection`、`RuntimeModelSelect`），边界已可切。（拆分结果见 §6 阶段 5 的 A1 条目；该文件现位于 `src/renderer/src/sessions/stores/runtime.ts`。）
- 顶层目录语义混杂：`src/projection/` 与 `src/extensions/genui/` 是“假顶层能力目录”，实际是 SDK 宿主的内部组成；`src/runtime-install/` 把一次性安装入口与被 5 个运行单元引用的 `runtime.ts` 混在同一目录。

### 2.4 必须保持的既有设计

- 五个运行单元与两类生命周期：主进程、沙箱 preload、页面、`utilityProcess` SDK 宿主、常驻终端守护进程，以及若干一次性受管入口。进程隔离只隔离故障与运行身份。
- 双层校验墙：主进程 `isTrustedCaller`（103 处使用）校验来源 frame；preload 只暴露固定方法并用 shared 校验重建载荷；shared 同时供两侧复用，不替代任一侧。
- 单一真源：`SessionRunRegistry` 持有运行身份/绑定代际/占用，`DesktopConfigStore` 是唯一配置写者，`file-lock` 约束 Pi 配置文件写入，SDK 持有会话历史。
- 产物布局不变：`out/main/index.cjs`、`out/preload/index.cjs`、`out/sdk-host/*.mjs`、`out/auth-helper/index.mjs`、`out/terminal-daemon/index.cjs`；`pi-cli-process.ts` 与 `createWindow` 依赖 `__dirname` 相对定位产物。**源码搬家不得改变 `out/` 结构。**
- 文档即导航：`docs/项目结构文档.md` 与 `docs/modules/*.md` 的显式路径索引机制。

### 2.5 结构变更的耦合点

移动文件会同时牵动四类配置：`package.json` 的 `test` 脚本（按目录 glob 列举测试文件，移动测试文件后需同步该 glob）、`tsconfig.node.json` 与 `tsconfig.web.json` 的 `include` 目录列举、以及四份 Vite 构建配置的入口路径。任何阶段都必须把这四类同步纳入。

### 2.6 工作区状态

当前在 `main` 分支，存在未提交改动：`package.json`（新增 `lightningcss` overrides）、`docs/terminal-persistence-design.md`、删除 `docs/commandcode-代理搭建.md`，以及未跟踪的 `docs/modules/` 与 `docs/项目结构文档.md`。重构涉及大批量文件移动，必须在该状态落定后再开始移动，避免与用户改动混成不可分辨的 diff。

### 2.7 外部调研取舍

本次未做外部方案调研。理由是：Electron 官方已确立的多入口目录与 electron-vite 的多构建产物约束、以及垂直切片（feature-first）与按技术层平铺的取舍，属于成熟工程共识，不存在需要外部证据才能判断的技术路线分歧；当前决策的主要依据是上文实测的依赖图与耦合点，外部资料不会改变方向选择。

### 2.8 实测方法与局限

- 依赖边由 `src/` 下全部 `.ts`/`.vue` 的静态 `import`/`from`/动态 `import()` 解析得出，`import type` 一并计入；循环检测在解析后的文件图上做深度优先遍历。
- 跨能力复用按“导出符号名 + 词边界匹配”静态比对，只证明符号名在某文件中出现，不区分实际调用路径，可能高估复用；因此引用结论只用作方向判断，不作为行为结论。
- 未执行类型检查、构建或运行，因此不声称迁移前后产物等价；这需要在获准运行后单独确认。
- 未逐函数审阅业务实现，函数行号区间与频道归属来自静态定位。

## 3. 推荐方案

### 3.1 核心思路

**一级目录按运行单元划分，单元内部按业务能力做垂直切片；跨单元只允许经 `shared/`（契约）与 `shared-process/`（跨进程设施）或已声明的协议文件通信。**

四条编排原则，用于判断一个文件该落在哪里：

1. 一个业务能力在某个运行单元内的全部实现（编排、数据访问、注册表、投影转换）放在同一能力目录。
2. 能力之间不直接互相 import 编排层；共享内容下沉到该单元的 `shared/` 叶子设施。
3. 跨单元的请求/事件/结果定义归 `src/shared/`，按业务域分文件；跨进程基础设施（路径、受管进程、进程终止、运行时布局、文件锁）归 `src/shared-process/`。
4. IPC 处理按业务域注册，由组合根一次性装配；组合根只做装配与生命周期，不含业务逻辑。

### 3.2 主进程目标结构

以下目录划分已按阶段 1 的细节调查核实（依赖方向与符号复用均已逐文件比对）：

```text
src/main/
├─ index.ts              组合根：app 生命周期、单实例、便携目录、登录 shell PATH、窗口创建与关闭、退出链、IPC 注册装配、启动检查编排
├─ shell/                窗口状态、原生主题与标题栏配色、资产协议、会话权限限制、可信来源校验、事件投递
├─ config/               Desktop 配置的唯一读写者（desktop-config-store）
├─ shared/               叶子设施：pi-paths、process-tree-termination、managed-entry-runner、pi-cli-process、external-url、file-lock、project-path
├─ projects/             项目登记与收敛、目录读取与监听、文件索引、文件内容、Markdown 资产、条目路径
├─ trust/                Project Trust 探测与决定
├─ sessions/             会话编排、会话存储、运行注册表、宿主监督、Runtime 桥、扩展 UI 管理、Prompt 输入边界
├─ git/                  命令、仓库、状态与历史解析、服务
├─ terminal/             守护进程客户端与终端适配
├─ preferences/          界面偏好读写适配
├─ providers/            自定义供应商、Pi 默认模型、认证编排与认证辅助进程
├─ resources/            MCP 配置读取、MCP 探测、资源预读、Pi 响应投影
├─ updates/              版本检查、扩展更新、运行时安装编排、运行时入口解析（pi-runtime）
└─ genui/                生成式界面参数存储
```

与初始设想的差异及依据：

- **合并 `projects/` 与 `files/`**：`project-manager`、`project-directory`、`project-directory-watcher`、`project-file-index`、`project-file-content`、`project-markdown-assets`、`project-entry-path` 与 `project-path` 命名同源、调用链同源（都围绕“已登记项目 + 项目内相对路径”），且 `project-entry-path` 被文件类四个模块共用。拆成两个目录会制造一条 `files → projects` 的隐式主干依赖，因此合并。
- **新增 `config/`**：`desktop-config-store` 被项目、外壳、偏好、供应商、终端、更新、生成式界面共 6 处使用，但它不是叶子设施（自身依赖 `project-path`），也不属于 `shell/`。单独成目录使其“唯一配置写者”身份在目录层面可见。
- **`project-path` 归 `shared/`**：它被 `config`、`projects`、`trust`、`sessions` 四处使用，是叶子模块（零依赖），符合叶子设施判据。
- **`pi-runtime` 归 `updates/`**：它只是 `updates` 与 `resources` 用于注入运行时入口的两函数，但自身依赖 `shared-process/runtime.ts`，并因其消费 `electron.app` 而无法进入不感知 Electron 的 `shared-process/`；阶段 2 把 `runtime.ts` 下沉后，两个函数留在 `updates/` 是为了不在 `shared/` 留下一条指向 `shared-process/` 的依赖。

`ipc/` 不设独立目录：IPC 注册函数按业务域迁入对应能力目录（如 `sessions/ipc.ts`），由 `index.ts` 统一调用。这样“能力 → IPC → 编排 → 数据”在目录内闭合，避免新增一层只做转发的目录。

根目录只保留应用级与窗口相关的文件：`index.ts`（装配）、`app-lifecycle.ts`（`app.on` 事件、单实例、退出链、启动自动更新）、`window.ts`（`createWindow`、背景色与标题栏窗口参数）、`window-channel.ts`（窗口引用、投递与广播）、`services.ts`（业务实例装配）、`asset-protocol.ts`（资产协议）、`window-state.ts`（窗口尺寸与位置）。`app-lifecycle.ts`、`window.ts` 与 `window-channel.ts` 与 `shell/` 的区别：它们是应用级生命周期与唯一窗口的创建链，不被任何业务能力反向依赖。`window.ts` 会读取 `services.ts` 注入的实例（配置、终端、窗口状态、SDK 运行时、目录监听），但业务能力不反向引用窗口层；`window-channel.ts` 通过注册取值函数取得终端状态，因此不反向依赖 `services.ts`。

### 3.3 SDK 宿主目标结构

`src/projection/`、`src/extensions/genui/` 并入 `src/sdk-host/`，因为两者只有宿主机一个消费者，属宿主内部组成：

```text
src/sdk-host/
├─ index.ts、protocol.ts、session-runtime.ts、extension-ui-bridge.ts
├─ projection/           消息、工具、历史、活动、身份、输出速率投影
├─ genui/                内置生成式 UI 扩展
└─ runtime/              SDK 运行时布局与加载（已下沉为 `src/shared-process/runtime.ts`，宿主单向引用）
```

一次性安装入口现为 `src/entries/runtime-install/index.ts`（见 3.4）。

### 3.4 辅助入口目标结构

`pi-cli`、`update-check`、`package-update`、`runtime-install` 四个一级目录同构：各为单个一次性 ESM 入口、同一份构建配置的多个 input、同一条 `spawnManagedEntry` 启动通道、同样的一次性生命周期。建议收拢为：

```text
src/entries/
├─ pi-cli/index.ts
├─ update-check/index.ts
├─ package-update/index.ts
└─ runtime-install/index.ts
```

理由是按真实职责（同构的一次性受管入口），不是为减少一级目录数。`src/auth-helper/` 与 `src/terminal-daemon/` **不并入**：前者是长驻协议对话的独立进程单元，后者是脱离主进程独立存活的守护进程，二者生命周期与四个一次性入口不同质。

### 3.5 跨单元共享层目标结构

```text
src/shared/         分域契约（请求/事件/结果/运行期校验），按业务域分文件
src/shared-process/ 跨进程基础设施：运行时布局与 SDK 加载、进程树终止
```

`src/shared-process/` 的判据是“被两个及以上运行单元引用且不感知 Electron”，其中“运行单元”含主进程。当前有两个文件满足：

- `runtime.ts`：被 `sdk-host`、`auth-helper`、`pi-cli`、`update-check` 四个运行单元引用，自身只依赖 `node:fs`、`node:path` 与 `node:url`。
- `process-tree-termination.ts`：被主进程与 `terminal-daemon` 两个运行单元引用，自身只依赖 `node:child_process` 与 `node:path`。它的存在使终端守护进程不必反向引用 `src/main` 内的实现。

以下两项**不满足**该判据，留在 `src/main/shared/`：`pi-paths.ts` 的 8 处引用全部在 `src/main` 内，且经 `updates/pi-runtime` 传递依赖 `electron.app`；`managed-entry-runner.ts` 的 3 处引用同样全在 `src/main` 内。

### 3.6 前端目标结构

前端在 `src/renderer/src/` 下按能力做垂直切片：能力目录内聚其组件、Store、服务与纯函数，`ui/` 与 `assets/` 是共享展示层与样式，组合根留在目录根：

```text
src/renderer/src/
├─ main.ts、App.vue、env.d.ts   组合根与环境类型
├─ shell/                       标题栏、布局、设置导航、右侧面板宿主、弹层与启动编排
├─ projects/                    项目、信任、侧栏项目树
├─ sessions/                    会话列表、运行状态、会话视图、投影应用、历史、聊天展示
├─ workspace/                   标签、终端视图与终端状态
├─ editor/                      文件树、文件编辑、富文本 Markdown、代码高亮
├─ git/                         状态、历史、差异、面板
├─ providers/                   供应商、认证、模型选择与展示偏好
├─ preferences/                 偏好、快捷输入、快捷命令
├─ resources/                   资源、MCP
├─ updates/                     版本检查与运行时更新
├─ genui/                       声明式界面渲染与几何、参数与设置入口
├─ ui/                          公共展示：按钮、选择器、确认弹层、Markdown 展示、浮层定位、剪贴板
└─ assets/                      全局与生成式界面样式
```

能力目录内按 `components/`、`stores/`、`services/` 三处子目录分放组件、Store 与服务，仅供该能力使用的纯函数与组合式函数就近放在能力目录根。实施结果见 §6 阶段 7：原计划的能力目录平铺会让 15 对 `stores/x.ts` 与 `services/x.ts` 同名冲突，需改名 15 个服务文件并波及文档与记忆里按文件名引用的位置，因此改为子目录。

`ui/` 只放真正被多个能力复用的无业务状态内容；仅服务单一能力的纯函数随该能力走，不因位于 ui/ 或能力目录根就升级为公共设施。

关键编排倒挂处理：`session.ts ↔ workspace-tabs.ts` 的循环来自“打开会话先固定标签，标签选择又调用会话打开”。推荐把**打开编排**收拢到会话能力，标签只声明意图与接收结果（不反向调用会话打开）；读取会话状态改经组合根注册的只读视图（`workspace/stores/session-tab-bridge.ts`，提供者在 `shell/use-app-startup.ts` 注册），标签因此不 import 会话 Store。这是收敛调用方向，不是新增事件总线或透传层。`GenuiNode ↔ Collapse/Tabs` 的递归渲染与 `file-rich-markdown` 的编解码互递归保留，只在切片时保证同一目录内。

### 3.7 四大混合职责的收敛目标

| 目标 | 现状 | 收敛方向 |
| --- | --- | --- |
| `src/main/index.ts` | 3 206 行，业务与装配混排 | 只保留：单实例、便携目录、登录 shell PATH、`whenReady` 注册装配顺序、窗口创建与关闭、退出链、启动检查编排。102 个 IPC 处理、40 个错误映射与 10 个广播函数迁入各能力目录；服务仍在组合根集中实例化后按序注入（现状已如此，不改变实例化方式） |
| `src/preload/index.ts` | 1 566 行，16 域混装 | 按域拆为 `preload/<domain>.ts`，各域自带 `ipcRenderer` 调用、载荷重建与结果校验；`index.ts` 只合并并 `exposeInMainWorld`。沙箱不能 require 拆分模块，构建侧须保持 `inlineDynamicImports` 单产物 |
| `App.vue` | 624 行，布局 + 生命周期 + 弹层 + 业务确认 | 拆为：组合根（provider 装配与 Store 初始化/释放顺序）、布局骨架组件、启动编排 composable、弹层宿主组件。业务确认意图交回各能力的 Store 或弹层组件 |
| `stores/runtime.ts` | 1 412 行，会话 + 模型 + 资源 | 拆为：会话运行与投影状态、历史缓存、模型能力与切换、模型展示偏好与写回。拆分后会话侧不依赖模型侧与资源预读 |

### 3.8 依赖方向规则

```text
页面能力切片 ──→ renderer/ui         （允许）
页面能力切片 ──→ shared 契约          （允许）
页面能力切片 ──×→ 其他能力切片的内部  （禁止；经 Store 公开接口或 shared 契约）

主进程能力切片 ──→ main/shared        （允许）
主进程能力切片 ──→ shared-process     （允许）
主进程能力切片 ──→ shared 契约        （允许）
主进程能力切片 ──×→ 其他能力切片内部  （禁止；跨能力经 shared 叶子或能力公开接口）

任何运行单元 ──×→ 另一单元的运行时实现（禁止）
任何运行单元 ──→ 另一单元的纯协议文件（允许：sdk-host/protocol、auth-helper/protocol、terminal-daemon/endpoint）
```

### 3.9 已发现的邻接问题

以下问题在本轮调查中发现，不在本次结构重构范围内解决，统一登记以便后续处置：

| 位置 | 证据 | 影响 | 推荐处置 |
| --- | --- | --- | --- |
| `src/shared/runtime-api.ts` | 1 558 行承载运行状态、Prompt、回退、压缩、投影、模型能力、资源与 MCP、历史、诊断共 6 组契约 | 单文件过载 | 已在阶段 4 拆为 `shared/runtime/` 下的 `status`、`projection`、`models`、`resources`；`runtime-api.ts` 只再导出 |
| `src/shared/genui-api.ts` | 2 154 行 | 单文件过载 | 已在阶段 4 拆为 `shared/genui/` 下的 `limits`、`nodes`、`params`、`diagram`、`chart`、`parse`；`genui-api.ts` 只再导出 |
| `package.json` 的 `test` | 目录 glob 按目录列举测试文件 | 新增或移动测试目录时静默漏检 | 每阶段随测试文件位置同步更新 glob |
| `src/renderer/src/assets/main.css` | 单一全局样式文件承载多能力业务类 | 样式归属已拆分为基础层、能力层与共享层 | 实施结果见 §8 样式归属评估 |
| `src/renderer/src/` 跨能力 import | 阶段 7 后实测 433 条导入：280 条同能力内部、88 条指向 `ui/`（§3.8 允许）、105 条指向其他能力的 Store 公开接口（§3.8 允许）；其余 40 条中 31 条是 `shell/` 与组合根作为宿主挂载各能力视图与弹层（职责本身），9 条是真正的跨能力内部引用 | 已处置 4 条：`project-entry-drag` 作为文件与终端共用的拖拽协议下沉到 `ui/`（对应两条引用）、相对时间与分叉折叠两个纯展示整形函数下沉到 `ui/relative-time.ts` 与 `ui/forked-sessions.ts`（对应两条引用）、`external-url` 桥接移入唯一消费者 `editor/services/` | 余 5 条保留并登记：`sessions/stores/runtime-models.ts` 直引 `providers/services/pi-settings.ts` 与 `resources/services/resource.ts`、`sessions/stores/runtime-model-display.ts` 直引 `preferences/services/preferences.ts`、`workspace/components/TerminalView.vue` 与 `git/stores/git-status.ts` 直引 `editor/services/project-file.ts`；这些是无状态的 preload 薄桥接，不是对方能力的状态或编排，改经对方 Store 只会多出一层纯转发（与 §3.1 不造透传层冲突）。另有 5 条跨能力组件组合（`ChatMessageItem` 渲染生成式界面、`PromptComposer` 嵌入模型选择器、终端与标签条嵌入快捷命令菜单），属能力间经公开组件的协作，同样保留 |

## 4. 备选方向与取舍

### 4.1 替代方向 A：只做“薄 index + 按技术层分目录”

只把 `index.ts` 拆成 IPC/窗口/生命周期三个文件，业务文件保持现有平铺。收益是最小改动、可快速落地；代价是“模块实现分散”未解决，前端与 preload 的混杂照旧，后续再加能力仍要回到同一堆文件。**不作为推荐**：不满足用户第 2 项目标。

### 4.2 替代方向 B：一次性完成全库迁移

一次提交覆盖 main、preload、renderer、shared 与全部配置。收益是终态一次到位、无需过渡期共存；代价是单次 diff 覆盖 260 余个文件，与当前未提交改动、四大配置耦合点和 5 处循环同时暴露，任何一处失误都难以定位，且无法在阶段间停下重新确认。**不作为推荐**：违反“范围稳定、分阶段确认”的约束。

### 4.3 推荐方向相对取舍

推荐方向在两端之间：一级目录按运行单元稳定，单元内分阶段垂直切片；每阶段可独立停下。主要代价是迁移期内会出现部分能力已切片、部分仍平铺的混合状态，需靠文档标注维持导航准确性。

## 5. 风险与不可逆点

| 风险 | 说明 | 缓解方向 |
| --- | --- | --- |
| 构建产物路径 | `pi-cli-process.ts`、`createWindow`、`shared-process/runtime.ts` 均按 `__dirname` 与相对路径定位产物 | 只移动源码、不改四份 Vite 配置的输出目录与 `entryFileNames` |
| preload 沙箱限制 | 沙箱不能 require 拆分模块；需保持 `externalizeDeps: false` 与 `inlineDynamicImports: true` | preload 拆分在构建配置不变的前提下进行，拆分维度只到源文件 |
| 测试与类型检查漏检 | `test` 脚本与两份 tsconfig 用目录 glob | 每阶段把四类配置同步纳入执行清单 |
| 未提交改动冲突 | 工作区已有修改与未跟踪文档 | 移动前先落定基线，移动阶段避免触碰这些文件 |
| 契约误改 | `shared/*` 被 87 处渲染端、71 处主进程引用 | 阶段 4 之前不改契约内容，只改路径；拆分契约时逐域核对校验函数 |
| 混合态导航失真 | 过渡期目录部分切片 | 每阶段末同步 `docs/项目结构文档.md` 与 `docs/modules/*.md` |
| 循环依赖误处理 | 前端 5 处循环中 4 处是有意递归 | 只改造 `session ↔ workspace-tabs` 的编排方向，另四处在切片时保持同目录 |

不可逆点：无数据删除、无持久化格式变更、无权限边界变更。全部改动为源码位置与导入路径，可通过版本控制整体回退。

## 6. 开发阶段

阶段划分按“风险由低到高、依赖由叶子到编排”排序。每阶段在开始前单独讨论实现细节并提交逐文件执行清单，另获确认后实施。

当前进度：阶段 1 至 7 已完成。各阶段标题下标注的是该阶段**开始时**的计划与判据，实施中对不上实测的部分已在文中就地更正。

### 阶段 1：主进程布局与装配拆分（已完成）

- 目标：消除 `src/main/index.ts` 的 3 206 行混合职责，建立主进程能力目录，落实 3.8 的依赖方向规则。
- 涉及职责：全部主进程能力切片的目录聚合、17 个 IPC 注册函数迁入能力目录、组合根瘦身。
- 前置依赖：无。
- 风险：中低。主进程内部零循环，依赖已下沉到叶子设施，是四个混合职责中边界最清晰的一个。

已核实的迁移量：48 个源文件位移（含 3 个测试文件）、158 处 import 说明符改写。单个文件往往同时引用多个迁走目标，因此 import 改写量远大于文件数。

阶段 1 内部拆为三个可独立停下确认的子阶段，按“叶子 → 能力 → 组合根”顺序：

| 子阶段 | 内容 | 主要风险 |
| --- | --- | --- |
| 1a 叶子设施与目录骨架 | 把 `pi-paths`、`process-tree-termination`、`managed-entry-runner`、`pi-cli-process`、`external-url`、`file-lock`、`project-path` 归入 `main/shared/`；`desktop-config-store` 归入 `main/config/`；`window-state`、`shell-path` 归入 `main/shell/`。同步改写引用它们的文件（含 `index.ts`）的导入路径 | 最低。叶子模块零依赖或单向依赖，改动只有路径 |
| 1b 业务能力目录聚合 | 把 38 个业务文件按 3.2 的目录划分归类；同目录内的相对导入不变，跨目录的改写为新路径 | 中。跨能力符号复用（`FileLockError`、`SdkHostError`、`sessionErrorOf`、git 错误类）在目录边界改变后仍需可达 |
| 1c 组合根拆分 | `index.ts` 拆为 `index.ts` / `app-lifecycle.ts` / `window.ts` / `window-channel.ts`，17 个 `register*Handlers` 与 40 个 `*Failure` 映射器、10 个广播函数迁入各能力目录 | 中。需逐函数确认它只依赖组合根传入的实例，而不依赖 `index.ts` 的其他局部状态 |

1c 的已核实前提：17 个 `register*Handlers` 之间 **互不调用**，只由 `index.ts` 的 `whenReady` 按固定顺序调用；每个注册器需要的外部依赖是组合根集中实例化的服务对象与 `pageUrl` + `isTrustedCaller` 两个横切参数。因此可以按能力目录接收显式注入，不需要为它们新增全局单例或透传层。

阶段 1 必须同步的配置与文档项：

- `package.json` 的 `test` 脚本：`src/main/*.test.ts` 不再匹配迁入子目录的 2 个 git 测试文件与 1 个项目目录监听测试，需改为覆盖子目录的形式。具体写法在阶段 1 执行清单中给出，不在本设计阶段锁定。
- `tsconfig.node.json` 的 `include`：现为 `src/main/**/*.ts`，递归包含子目录，**不需要改动**；其它单元条目同理。
- `electron.vite.config.ts`：主进程入口仍为 `src/main/index.ts`、产物仍为 `out/main/index.cjs`，**不需要改动**。
- `docs/项目结构文档.md`、`docs/modules/*.md`：路径索引会大面积失效，需在同阶段同步。

### 阶段 2：辅助入口与跨单元共享设施归位（已完成）

- 目标：收拢四个一次性入口为 `src/entries/`；`projection`、`extensions/genui` 并入 `sdk-host`；`runtime-install/runtime.ts` 与 `main/shared/process-tree-termination.ts` 下沉为 `src/shared-process/`。`main/shared/` 下的 `pi-paths.ts` 与 `managed-entry-runner.ts` 留在原处，判据见 §3.5。
- 涉及职责：跨单元引用、SDK 宿主内部组成、构建配置的 5 个 input 路径。
- 前置依赖：阶段 1 完成（`shared-process` 的归位会影响主进程导入路径）。
- 风险：中。需同步 `vite.sdk-host.config.ts` 的四个 input 路径，但产物路径与产物名不变。
- 实施结果：`src/projection/`、`src/extensions/genui/` 并入 `src/sdk-host/`；`runtime.ts` 与 `process-tree-termination.ts` 下沉为 `src/shared-process/`；四个一次性入口收拢为 `src/entries/`。实测 `shared-process` 只收到这两个文件——`pi-paths.ts` 与 `managed-entry-runner.ts` 的引用面全在 `src/main` 内，不满足判据，留在原处。

### 阶段 3：preload 按域拆分（已完成）

- 目标：`src/preload/index.ts` 拆为按域的多个源文件，`index.ts` 只做合并与暴露。
- 涉及职责：16 个域 Api、约 100 条校验常量与工厂的域内归位。
- 前置依赖：阶段 1–2（域划分与主进程能力目录保持同名，便于对照）。
- 风险：中。沙箱与 `inlineDynamicImports` 约束需在实施前确认构建行为不变。
- 实施结果：拆为 11 个域文件（`desktop`、`projects`、`sessions`、`runtime`、`terminal`、`git`、`preferences`、`providers`、`updates`、`trust`、`genui`），`index.ts` 由 1 566 行降为只做合并与暴露。115 个方法、53 个错误工厂、47 条错误文案、113 个 channel 与拆分前逐一对应。`runtime-api` 的 21 个方法作为一个域整体保留在 `runtime.ts`，其内部的方法归属留到阶段 4 拆契约时一并调整。

### 阶段 4：共享契约分域（已完成）

- 目标：`src/shared/` 按业务域重组，`runtime-api.ts` 与 `genui-api.ts` 按域拆分。
- 涉及职责：契约文件与运行期校验函数；被 87 处渲染端与 71 处主进程引用，是引用面最广的阶段。
- 前置依赖：阶段 1–3（域命名在此时已稳定）。
- 风险：高（引用面最广）。建议按域逐个提交，不一次性替换全部导入路径。
- 实施结果：只拆了过载的两个文件，未把 19 个单文件契约移入子目录。`runtime-api.ts` 拆为 `status`、`projection`、`models`、`resources` 四文件（129 个导出），`genui-api.ts` 拆为 `limits`、`nodes`、`params`、`diagram`、`chart`、`parse` 六文件（122 个导出）。两个原文件改为只再导出，既有 66 处导入路径不变。可跨组的非导出辅助（如 `isRecord`、`RUNTIME_ERROR_CODES`）落在各组内，被两组以上共用的才提升为导出。

### 阶段 5：前端能力切片（已完成）

- 目标：`src/renderer/src/` 按能力垂直切片；拆分 `App.vue` 与 `stores/runtime.ts`；收敛 `session ↔ workspace-tabs` 的编排方向。
- 涉及职责：`src/renderer/src/` 下的页面能力文件、Store、服务与组件。
- 前置依赖：阶段 4（契约分域后切片引用的契约路径才稳定）。
- 风险：中高。逐个能力切片，每次只动一个能力目录。
- 批次划分（按风险从低到高，各自单独提交清单）：
  - A0 共享展示层归位：把被多能力复用的展示代码收进 `ui/`，纯路径搬迁，不改行为。**已完成**：9 个文件移入 `src/renderer/src/ui/`，56 个文件改写 88 处导入。
  - A1 拆分 `stores/runtime.ts`：按会话运行与投影、历史缓存、模型能力与切换、模型展示偏好切开。**已完成**：拆为 `stores/runtime-core.ts`、`stores/runtime-history.ts`、`stores/runtime-models.ts`、`stores/runtime-model-display.ts` 四个切片模块，`runtime.ts` 只作门面（组合与初始化/释放编排），保留原有 49 个公开成员（`initialize`、`dispose` 与 47 个状态及动作）与两个历史类型再导出，19 个引用 `useRuntimeStore` 的文件不改调用点。切片间不互相 import，会话状态收敛对模型侧的影响经组合根一次性晚绑定转交。
  - A2 拆分 `App.vue`：组合根、布局骨架、启动编排、弹层宿主分离。**已完成**：`App.vue` 从 624 行降为只装配 `<AppShell />`、`<AppDialogHost />` 并调用 `useAppStartup()`；新增 `shell/AppShell.vue`（布局骨架与窄窗开合）、`shell/WorkspaceView.vue`（标签条、四条提示与面板层）、`shell/AppDialogHost.vue`（5 个确认弹层与 5 个业务弹层，以及展示派生值）、`shell/use-app-startup.ts`（Store 初始化/释放顺序、生成式参数落盘、两条补读 watch）。项目移除、会话删除、脏文件关闭与快捷命令增删改的待确认目标分别归入 `stores/project.ts`、`stores/session.ts`、`stores/workspace-tabs.ts`、`stores/quick-commands.ts`，弹层宿主不另存副本；同时删掉 `App.vue` 里未被使用的 `trustStore`。
  - A3 收敛 `session ↔ workspace-tabs` 的打开编排方向，这是本阶段唯一有行为风险的项。**已完成**：标签侧导出 `ChatOpenIntent`，只计算「打开哪个会话、落到哪个标签」；`activateTab`／`openNewChatTab`／`startNewChatInTab`／`closeTab`／`requestClose`／`confirmPendingClose` 改为返回意图，新增 `session.openIntent` 作为唯一提交入口；原挂在标签 Store 上的两个补焦订阅迁到 `shell/use-app-startup.ts`，标签侧改为 `onProjectChanged`／`chatFocusIntent` 返回意图；`createTab` 收窄为 `createTerminalTab`。

### 阶段 6：文档与记忆同步（已完成）

- 目标：重写 `docs/项目结构文档.md` 与 `docs/modules/*.md` 的路径索引；评估并更新 `.agents/memory/` 中涉及目录约定的条目。
- 前置依赖：可与各阶段末尾增量进行，最终阶段做全量校对。
- 风险：低。

### 阶段 7：前端能力目录切片（已完成）

- 目标：把 `src/renderer/src/` 下仍平铺的 `components/`、`stores/`、`services/` 与根目录散文件归入 §3.6 的能力目录，结清“前端实现分散”的最后一块，并为 §8 的样式归属提供判定前提。
- 前置依赖：阶段 5（共享展示层与外壳已归位）、阶段 6（文档索引已校对）。
- 风险：中。纯路径搬迁与导入改写，不改 IPC 契约、Store 归属、存储位置与行为。
- 实施结果：150 个文件迁入 11 个能力目录，377 处导入语句改写（代码改动 379 行，其中 2 行为注释里的路径），`src/renderer/src/` 文件数守恒 172。四类配置均已是递归匹配，未改动：`tsconfig.web.json` 的 `src/renderer/src/**/*` include、四份 Vite 配置（`renderer.root` 与 `index.html` 的 `/src/main.ts` 不动）、`package.json` 的 `src/renderer/src/**/*.test.ts` test glob。能力目录内按 `components/`、`stores/`、`services/` 三处子目录组织（原因见 §3.6）。`ui/`、`assets/` 与 `main.ts`、`App.vue`、`env.d.ts` 留在原处，`assets/main.css` 的样式归属仍按 §8 待定。混合文件归属：`stores/runtime*.ts` 五文件整体留 `sessions/stores/`（门面不跨目录）、`ProjectSidebar.vue` 与 `sidebar-tree.ts` 归 `projects/`、设置页与右侧面板归 `shell/`、`services/genui-params.ts` 归 `genui/`。搬迁本身只改路径；随后的小收尾断开了 `stores/session.ts ↔ stores/workspace-tabs.ts` 的模块环——标签改为经 `workspace/stores/session-tab-bridge.ts` 的只读视图读取会话状态，提供者由 `shell/use-app-startup.ts` 注册，全库循环降为 4 组，均为有意递归（`file-rich-markdown` 两对编解码互递归、`GenuiNode` 与折叠／页签两处节点递归）。随后又把 4 条跨能力内部引用收掉（拖拽协议、相对时间、分叉折叠下沉 `ui/`，`external-url` 桥接移入唯一消费者 `editor/services/`），余 5 条薄桥接与 5 条跨能力组件组合按 §3.9 登记保留；收尾新增 `session-tab-bridge.ts`、`ui/relative-time.ts`、`ui/forked-sessions.ts` 三个文件，`src/renderer/src/` 现为 175 个文件。

## 7. 推荐先实施阶段 1 的理由

1. **边界最清晰**：主进程内部实测零循环，业务管理器之间近乎不互相依赖，依赖已下沉到 `pi-paths`、`desktop-config-store` 等叶子设施。迁移动机明确、判定标准唯一。
2. **收益最集中**：`index.ts` 的 3 206 行是全项目最大的单文件混合职责，且承载 102 个 IPC 注册。拆分后主进程后续任何改动都不再落到同一文件。
3. **风险最低且可为后续定名**：产物路径与构建配置不变，只动源码与导入；同时主进程能力目录名会成为 preload 域划分与 shared 契约分域的命名基准，先做可避免后续反复改名。
4. **不触碰用户未提交改动**：`src/main` 下当前无未提交修改，移动不会与用户改动混叠。

## 8. 待定问题

原四项待定中三项已在实施中结清，只余样式归属一项：

| # | 待定事项 | 待定原因 | 决定阶段 |
| --- | --- | --- | --- |
| 1 | `main.css` 是否按能力拆分样式 | 阶段 7 后已具备判定前提（组件已按能力切片）；归属评估与实施结果见本表下方 | 已完成 |

样式归属的评估结论（阶段 7 收尾实测）：`assets/main.css` 6 202 行、605 个类选择器，484 个只被单一能力使用，75 个被两个以上能力共用，没有未被引用的类。`:root` 与暗色主题令牌、动效、焦点环、Tailwind 引入与图表色槽属于跨能力基础层，必须保留为共享样式。实施结果：`assets/main.css` 现为入口，`assets/styles/base.css` 承载主题令牌与基础规则；组件样式拆入 `editor.css`、`sessions.css`、`git.css`、`shell.css`、`projects.css`、`workspace.css`、`preferences.css` 与 `ui.css`。规则声明未改写，公共与混合选择器归入 `ui.css`；`assets/genui.css` 继续由生成式界面模块独立维护。样式拆分改变了不同能力样式表之间的加载顺序，页面视觉效果尚未运行核对。

已结清的原待定项：

- preload 拆分的域粒度（阶段 3）：定为 11 个域文件（`desktop`、`projects`、`sessions`、`runtime`、`terminal`、`git`、`preferences`、`providers`、`updates`、`trust`、`genui`）；`runtime-api` 的 21 个方法作为一个域整体保留，契约分域不改变 preload 的方法归属。
- 契约拆分是否改变校验函数分组（阶段 4）：未合并形状相同的重复校验；可跨组的非导出辅助（`isRecord`、`RUNTIME_ERROR_CODES`）留在各自组内，被两组以上共用的才提升为导出。
- `resources/pi-response-projection` 的归属（阶段 1）：按调用点确认留在 `src/main/resources/`，唯一消费者是同目录的 `resource-preview.ts`，不属于跨单元共享契约。
- `projects/` 与 `files/` 合并；主进程服务实例化保持组合根集中注入（现状已如此，不需改动实例化方式）；`terminal-manager` 归 `terminal/`（主进程侧只做适配，终端生命周期在守护进程）。

## 9. 待确认事项

阶段 1–7 与 §8 的样式归属拆分均已完成，§3.6 的前端能力目录及全局样式已按能力归位，相关模块文档已更新。样式加载后的实际视觉表现尚未核对。
