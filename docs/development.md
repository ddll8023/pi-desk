# Pi Desktop 开发文档

## 1. 目标与约束

构建面向 Windows 和 macOS 的 Pi Coding Agent 桌面客户端。第一版是可用的 Agent GUI，不是 IDE 或 VS Code 替代品。

确定使用：

- 桌面平台：Electron。
- 前端：Vue 3、TypeScript、Vite、Tailwind CSS、Pinia。
- Agent Runtime：官方 Pi standalone binary，以独立 sidecar 进程运行。
- 通信：Electron 主进程与 Pi 通过 stdin/stdout 交换 JSONL；Vue 通过受限的 contextBridge preload API 访问主进程，区分 IPC 请求响应与定向事件流。

主进程直接使用 Node.js `child_process.spawn` 管理 Pi。打包采用 electron-builder 的方向，应用代码进入 ASAR，Pi 与配套资源整体放在 ASAR 外；实际依赖版本和发行配置在相应开发阶段确定。

不重新实现 Agent Core，不以 fork Pi 为主要开发方式，不以 Node.js SDK 直接嵌入为主方案。安装后的应用携带匹配平台的 Pi Runtime，不要求用户预装 Node.js、npm、Bun 或 Pi CLI。

本文记录当前架构、官方调查结论、阶段范围和待解决问题，不作为安装、构建、启动、运行检查或扩大开发范围的授权。外部事实以引用版本为准；实现时核实实际依赖，不能将源码分析推定为实际运行结果。

## 2. 架构与职责

```text
Vue 3 Desktop UI / Pinia
        │ 固定业务方法 / 事件订阅
        ▼
Sandboxed preload / contextBridge
        │ IPC 请求响应 / 定向事件流
        ▼
Electron Main
        │ stdin / stdout · JSONL RPC
        ▼
Pi standalone binary
        ▼
Pi Agent Runtime
```

### Vue 渲染进程

负责界面、用户输入、消息展示、交互状态和 Desktop UI 偏好。不得直接启动 Pi，不拥有 Node.js、通用 shell 或全域文件访问能力。

Pinia 保存当前渲染进程所需的展示状态，不承担 Agent Runtime 生命周期，也不建立平行聊天历史数据库。

### Preload

在隔离上下文中通过 contextBridge 暴露固定业务方法与事件订阅。只做 IPC 薄桥接，不持有 Runtime、凭据或文件访问职责，不暴露 ipcRenderer、任意 channel 或 Electron event 对象。事件订阅提供释放能力。

### Electron 主进程

负责窗口和调用者校验、Pi 进程管理、工作目录、管道 I/O、协议解析、请求关联、临时消息投影、定向通知、异常退出和资源释放。对来自 Vue 的参数重新校验，不接受任意可执行文件路径、启动参数、环境变量或 shell 命令作为通用进程控制接口。

临时消息投影仅用于当前运行的增量重建、工具关联、状态收敛与渲染端重新同步，采用有界内存，不保存平行 Session 或聊天数据库。Pi 完整消息与持久化 Session 仍是权威来源。

### Pi

继续拥有 Agent 行为、Session、消息持久化、模型与认证配置、Skills、Extensions、Packages、MCP、Compaction、Context 和项目资源加载。

Desktop 仅维护自己的数据：最近项目、窗口尺寸、Sidebar 状态、主题和 Desktop 特有设置。轻量本地配置即可，不为这些信息提前引入数据库。

## 3. 当前项目与环境

开发在 Windows 与 macOS 主机上交替进行，文档不绑定某一平台，也不固定绝对路径；仓库可检出到任意位置，以下路径与命令均以项目根目录为基准。

仓库包含开发文档、Electron/Vue 桌面骨架、三端构建与 TypeScript 配置、统一前端服务入口、展示状态 Store，以及 Pi Runtime 的准备脚本与固定版本清单。当前主界面由顶栏、可折叠的会话侧栏、消息区与 Prompt 区组成，可经受限 preload API 读取应用信息、选择并记住本地项目、列出并打开该项目的 Pi 会话、启停 Pi RPC sidecar、接收状态变化、提交 Prompt 与图片附件、展示本轮文本与 Thinking、查看工具执行、切换模型与 Thinking 级别并查看上下文占用、中止当前操作、对项目信任做出与重置决定，并保存 Sidebar 折叠状态、主题与窗口尺寸位置；不读取项目内容、不持久化消息。

开发使用 npm，工具版本由 `package.json` 的 `packageManager` 字段声明，直接依赖使用精确版本。`package.json` 是依赖声明的维护位置，完整依赖树由安装生成的 `package-lock.json` 固定，不手写锁文件。依赖安装属于独立授权操作。

开发环境与约束：

- 开发主机可能是 Windows，也可能是 macOS；单一主机的系统版本与已装工具不作为项目前提，文档不记录某一台机器的环境清单。
- Node.js 与 npm 用于开发与打包，版本以 `package.json` 的 `packageManager` 字段为准。安装后的 Electron 使用自身携带的 Node.js 与 Chromium，Pi standalone 也不依赖全局 Node.js；全局 Node.js 版本不是 Electron 的运行时版本。
- 不需要 Rust、Cargo、rustup 或 Bun。
- 第一阶段避免需要本地编译的原生依赖，使用官方预编译 Electron 与 Pi，不自行编译二者。若后续依赖需要 node-gyp 编译，须按主机与目标平台准备对应的本地编译链与 Python（Windows 为 MSVC 与 Windows SDK，macOS 为 Xcode Command Line Tools），并单独取得安装授权。预编译 Pi 与 native helper 的运行库需求在相应开发步骤按目标核实，不将本机残留的运行库文件视为可靠前置条件。

当前依赖声明采用 Electron 44 系列，其 macOS 下限为 13；Electron 官方平台说明列出 Windows 10 及以上。两个平台的系统与运行库约束在对应开发任务中核实，不为兼容旧系统退回停止维护的版本，也不以本机现有状态推定目标平台满足约束。

## 4. Pi binary 与 Electron 打包

### 4.1 固定基线与获取方式

官方发布资产调查基线为 Pi `1.0.4`，对应 tag `v1.0.4`，源码 commit：

```text
7c10bd4337495ee613f2224843ecdf349b80d1df
```

第一阶段以该版本为固定集成基线。升级必须显式进行，不在运行时自动获取 latest，不自动调用 Pi 自更新来替换应用携带的 Runtime。

官方已经提供 Bun compile 生成的 standalone 发布包，优先直接获取，无须自行编译 Pi：

| 目标平台与架构 | 官方发布包 |
| --- | --- |
| macOS Apple Silicon / arm64 | `pi-darwin-arm64.tar.gz` |
| macOS Intel / x64 | `pi-darwin-x64.tar.gz` |
| Windows x64 | `pi-windows-x64.zip` |

下载地址使用固定版本：

```text
https://github.com/earendil-works/pi/releases/download/v1.0.4/<发布包名>
```

官方提供 `SHA256SUMS`，发布 API 也提供资产摘要。准备 binary 的脚本需要固定版本、目标平台映射和预期 SHA-256，校验原始归档后再解压，并保留官方文件名与相对目录结构；不能把执行 `pi --version` 当作完整性或协议兼容性的唯一依据。签名可能改变可执行文件字节，不能将签名后的文件摘要与原始归档摘要混用。

P1-02 已核实的 1.0.4 资产：

| 目标平台与架构 | 官方资产 | 字节数 |
| --- | --- | --- |
| Windows x64 | `pi-windows-x64.zip` | 45 055 959 |
| macOS arm64 | `pi-darwin-arm64.tar.gz` | 31 016 950 |
| macOS x64 | `pi-darwin-x64.tar.gz` | 33 474 471 |

预期 SHA-256 不写在本文，统一固定于 `runtime/pi-runtime.json`，由 `scripts/prepare-pi-runtime.mjs` 读取；升级版本必须同时更新二者并重新核对。官方 `SHA256SUMS` 是 `<sha256>  <文件名>` 两空格格式，只列发布资产；发布 API 的资产 `digest` 与它逐条一致，两种来源已交叉核对。同一版本还提供 `pi-windows-arm64.zip` 与 `pi-linux-*.tar.gz`，不属于当前确认的三目标分发范围。

已下载核对的 Windows 归档为平铺根目录：根下同时存在 `pi.exe`、`package.json`、`README.md`、`CHANGELOG.md`、`photon_rs_bg.wasm`、`theme/`、`assets/`、`export-html/`、`docs/`、`examples/`、`native/win32/prebuilds/win32-x64/win32-platform.node`，没有包裹目录；归档内另有一个带 BOM 前缀的 `examples/` 空目录条目（官方构建产物副作用），PowerShell 解压后未在 staging 中生成该目录，未做额外处理。

### 4.2 standalone 仍有配套资源

官方 binary 构建脚本除可执行文件外，还复制：

- `package.json`、README、CHANGELOG。
- 主题、交互资源、HTML 导出资源。
- `photon_rs_bg.wasm`。
- 对应平台和架构的 native helper。
- 文档和示例。

因此不能只复制一个可执行文件并假定所有功能完整。

资源路径有不同机制：

- `PI_PACKAGE_DIR` 可改变 Pi 元数据、主题、文档及部分资源的查找根目录。
- Photon WASM 的 fallback 包含可执行文件邻接路径，并不统一使用 `PI_PACKAGE_DIR`。
- TUI native helper 也包含可执行文件邻接路径，不能仅靠 `PI_PACKAGE_DIR` 迁移。

Pi 与官方配套资源作为整体保留，不压平目录、不只迁移 package 资源。`PI_PACKAGE_DIR` 只在可执行文件与 package 资源根被拆开时才需要指向资源根；本项目保持两者同层，因此不设置该变量（见 4.3），WASM 与 native helper 同时保持相对于 Pi executable 的官方邻接关系。Pi native helper 由 Pi 使用，不导入 Electron 主进程，不将其作为 Electron Node.js 原生模块加载。

### 4.3 ASAR 与 Runtime 资源布局

采用 electron-builder 的打包方向。其 `extraResources` 可将外部 CLI 与数据整体复制到应用资源目录，适合本项目固定 Runtime 的分发；Forge 同样可以打包，但当前没有需要其插件或 maker 的既有约束。具体依赖版本、配置与安装包目标在开发阶段确定。

Electron 应用代码进入 `app.asar`；Pi executable 和全部配套资源通过 `extraResources` 放在 ASAR 外。不依赖 ASAR 内执行、临时解包或运行时修改安装目录。

资源布局方向：

| 场景 | Runtime 根目录 |
| --- | --- |
| 本地开发 | `<项目根>/runtime/pi/<目标平台与架构>/` |
| Windows 安装后 | `<安装目录>/resources/runtime/pi/<目标平台与架构>/` |
| macOS 安装后 | `Pi Desktop.app/Contents/Resources/runtime/pi/<目标平台与架构>/` |

每个 Runtime 根目录保留对应官方归档的解压内容与相对位置。开发和正式包采用相同的内部布局，仅资源根定位不同；主进程在正式包中通过 `process.resourcesPath` 定位，不从 PATH 查找全局 Pi。

P1-02 已确定开发 staging 根为仓库内 `runtime/`：Runtime 位于 `runtime/pi/<目标平台与架构>/`，`runtime/pi-runtime.json` 保存固定版本与预期摘要，`runtime/pi/` 不入库。归档的可执行文件与全部 package 资源处于同一层，因此不需要设置 `PI_PACKAGE_DIR`：Pi 的 `getPackageDir()` 在 Bun binary 下默认返回 `dirname(process.execPath)`，与 package 资源根以及 WASM、native helper 的可执行文件邻接查找同时成立；只有当可执行文件与资源根被拆开时才必须显式设置该变量。

主进程沿用同一相对子路径定位 Runtime：

| 运行形态 | 基址 | Runtime 根 |
| --- | --- | --- |
| 开发 | 项目根（由构建产物的 `out/main` 上溯） | `<项目根>/runtime/pi/<目标平台与架构>` |
| 打包后 | `process.resourcesPath` | `<process.resourcesPath>/runtime/pi/<目标平台与架构>` |

正式包通过 electron-builder `extraResources` 把 `runtime/pi/` 复制到资源目录的同一相对位置；开发期不能使用 `process.resourcesPath`，因为该值在开发时指向 Electron 自身的 `resources` 目录。可执行文件名由平台决定：Windows 为 `pi.exe`，macOS 为 `pi`。

macOS Desktop 主可执行文件位于 `Contents/MacOS`，不要求 Pi 跟随搬入该目录。Pi 与其资源整体放在独立目录，分别满足 package 根和 executable 邻接 loader 的要求，不通过仅设置 `PI_PACKAGE_DIR` 修补拆散布局。

### 4.4 平台分发与签名边界

Windows x64、macOS arm64、macOS x64 分别携带匹配目标的 Electron、Pi 和 helper。构建 host 不等于分发 target，不默认下载全部平台，也不提前承诺 universal 安装包。

推荐按平台准备发行环境；macOS 正式签名、公证需要 macOS 环境及对应凭据。Pi 与附带的 Mach-O helper 必须纳入嵌套代码签名、公证及所需 entitlements 的考虑，不能假定官方归档自然满足 Desktop 分发要求，也不为方便而默认关闭库校验。

Desktop、固定 Pi 和配套资源作为一致发行版本更新，不在运行时独立替换 Pi。回退应用版本只改变 Desktop 与 Runtime，不自动撤销 Agent 已完成的文件修改或外部操作。正式签名和更新工作在相应发行任务中落实。

## 5. RPC 官方协议事实

### 5.1 启动与通道

官方最小启动命令：

```sh
pi --mode rpc --no-session
```

主进程固定完整启动参数，页面不能覆盖：`--mode rpc`、`--no-skills`、`--no-prompt-templates`、`--no-mcp`、按平台选择的 `--tools`（Windows `read,powershell,edit,write`；macOS `read,bash,edit,write`）、会话目录 `--session-dir <dir>`，以及恢复已有会话时的 `--session-id <id>`；项目信任覆盖 `--approve` / `--no-approve` 按第 6.2 节 Project Trust 的探测结果条件传递，无受保护资源时不传。P3-02 起不再传 `--no-extensions`，Extension 加载由 Trust 拦截控制（见第 6.2 节 Extension UI）。环境继承父进程并追加 `PI_SKIP_VERSION_CHECK=1`；不设置 `PI_OFFLINE`，因为 RPC 启动会在后台刷新模型目录；也不设置 `PI_PACKAGE_DIR`，因为包资源与可执行文件同层。

Electron 主进程设置 `cwd` 为用户选择的项目根目录，并分别建立 stdin、stdout、stderr 管道。不启动 HTTP 或 localhost TCP RPC 服务，不将协议暴露到网络。

第一阶段用 `--no-session` 跑内存 Session；第二阶段起不再传该参数，Runtime 使用 Pi 自己的持久化 Session，会话位置、列表与恢复方式见第 6.2 节。

RPC 启动并不自动发送 ready 事件，也不输出 JSON mode 的 Session header；使用 `get_state` 的成功响应确认协议可用，不依赖固定等待。

Pi CLI 在非交互模式下未能选出模型时会向 stderr 输出错误并以退出码 1 结束，因此 RPC 启动失败不能只看 stdout；真实 prompt 需要有效模型凭据。第一阶段复用现有 Pi 配置、认证或 provider 环境变量，不开发 Authentication UI，不把密钥放进 Vue 或命令行参数。

### 5.2 JSONL framing

Pi 使用自己的 JSONL RPC，不是标准 JSON-RPC 2.0：

- 一条记录是一个 UTF-8 JSON 对象，以 LF（`\n`）终止。
- 接收端只按 LF 分帧，可移除其前的 CR，兼容 CRLF。
- 一次管道读取可能只有半条记录，也可能包含多条记录。
- Unicode `U+2028`、`U+2029` 可以出现在 JSON 字符串中，不能当作记录分隔符。
- stdout 持续消费；不读取会因背压阻塞 Pi。
- stdin 写入同样需要处理背压，不能让并发写入交错。
- stderr 是诊断输出，不作 JSONL 协议解析。

官方记录分为 command、response、Session event，以及独立的 Extension UI 子协议。第一阶段不开发 Extension UI，但解析边界不能把所有非 response 记录当作普通文本。

### 5.3 Request 与 response

最小状态请求与 prompt：

```jsonl
{"id":"req-1","type":"get_state"}
{"id":"req-2","type":"prompt","message":"你好"}
```

prompt 接受响应：

```json
{"id":"req-2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
```

`id` 是可选字符串；Desktop 一律生成唯一 id，并按 id 匹配 response。Pi 异步处理命令，不保证响应按请求顺序返回。

`disposition` 可为 `started`、`queued`、`handled`。成功 response 只表示请求已接受、排队或被处理，不表示模型执行结束；`handled` 不能被当作本次一定启动了 Agent run。

prompt 的成功 response 在 preflight 通过时即发出，早于 Agent run 本身，因此拿到 response 不等于模型执行完成。Agent run 期间提交、且未提供 `streamingBehavior` 的 prompt 会被拒绝（`success: false`），不会排队；compaction 进行中提交同样被拒绝，此时 `isStreaming` 为 false 而 `isCompacting` 为 true。无可用模型或凭据也以 `success: false` 拒绝。

请求失败使用 `success: false` 和 `error`。prompt 接受后的 provider 失败、取消和执行错误通过消息与事件流表达，不应等待同一 request id 的第二个失败 response。

### 5.4 Streaming 与工具事件

第一阶段需要理解：

```text
agent_start / turn_start
message_start / message_update / message_end
tool_execution_start / tool_execution_update / tool_execution_end
turn_end / agent_end / agent_settled
```

`message_update.assistantMessageEvent` 在 JSONL wire 上是 delta-only，没有 SDK 的累计 `partial` 快照。

文本增量示例：

```json
{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "你好"}
}
```

上例为官方字段形状示例，数字不是实测数据。

主进程临时消息投影的最小重建规则，渲染进程展示其更新：

- `message_start` 建立消息。
- 按 `contentIndex` 累加 `text_delta` 和 `thinking_delta`，不要把不同内容块混合。
- 用 `text_end`、`thinking_end`、`toolcall_end` 校正相应内容块。
- 用 `message_end.message` 替换为权威完整消息，避免继续追加造成重复。
- Tool execution 按 `toolCallId` 关联，保留 `toolName`、`args`、`partialResult`、`result`、`isError`。
- `partialResult` 的追加或替换语义由工具决定，不能一律当作文本 delta；最终以结束事件的 `result` 为准。
- `usage` 是当前 assistant response 的累计值，不能逐事件相加。

`agent_end` 只关闭一个底层 run，之后可能继续重试、压缩恢复或队列工作。**Session 级忙碌状态以 `agent_settled` 收敛**，不能仅凭 `agent_end` 开放下一次普通 prompt。

第一阶段仅建立简单结构化工具展示，不开发完整 Tool Card 体系或每个工具的专属界面。后续通用 Tool Card 的折叠状态和由 Desktop 计算的耗时属于 UI 数据，不冒充 Pi 协议字段。

### 5.5 Abort 与 shutdown

停止当前 Agent 操作：

```json
{"id":"req-3","type":"abort"}
```

Pi 等待 Session idle 后返回：

```json
{"id":"req-3","type":"response","command":"abort","success":true}
```

停止操作与关闭 Runtime 是两种不同动作：

| 动作 | 语义 |
| --- | --- |
| `abort` | 停止当前操作，保留进程 |
| `clear_queue` | 清除 steering / follow-up 队列 |
| 关闭 stdin | 请求 Pi 正常 dispose Runtime 并退出 |
| 强制终止 | 正常退出超时后的兜底 |

`abort` 不清空队列，保留的队列可能继续执行。第一阶段不开放 streaming 期间排队输入，也不开放独立 RPC `bash` 执行入口。后续加入队列时，Stop 的产品语义需要明确处理 `clear_queue`。

## 6. 第一阶段最小实现方案

### 6.1 范围

只打通：

```text
Vue → preload → Electron Main → Pi RPC sidecar → prompt → streaming → tool → abort
```

只允许一个活动项目、一个 Pi Runtime；Runtime 在多次 prompt 之间驻留。切换目录时结束旧 Runtime，再启动新 Runtime，不通过改变 Desktop 状态假装子进程 cwd 已切换。

Runtime 与 Session 不是同一个对象；正式版本的一个 Project 可以有多个 Pi Session，但第一阶段不实现 Session 管理界面。

### 6.2 主进程管理与 IPC 策略

主进程直接使用 `child_process.spawn` 启动应用携带的固定 Pi executable，不经过 shell。`utilityProcess.fork` 面向 Node.js 脚本且自身 stdin 不支持所需管道模式，不能直接替代外部 Pi executable；增加该层还需由辅助进程再次 spawn Pi。第一阶段不增加这层进程，后续仅在处理负载确有需要时重新讨论。

最初保持少量职责，不机械拆出大量空模块：

| 职责 | 负责内容 |
| --- | --- |
| Manager | 唯一 Runtime、状态转换、请求关联、受限业务操作、窗口归属、退出编排 |
| Process | 固定 sidecar、cwd、三个管道、进程等待与平台回收 |
| Protocol | 请求与 response 校验、JSONL framing、事件分类与请求关联 |
| Projection | 临时消息重建、批次与序号、应用确认窗口、快照与截断边界 |

#### 管道与请求

- stdout、stderr 分别持续读取，不因 Vue 等待请求或应用更新而暂停消费。
- stdout 采用增量 UTF-8 解码，只按 LF 分帧；stderr 使用独立、有界的诊断通道。
- stdin 由单一 writer 串行写入完整记录并处理写入背压；串行写入不等于等待前一个 response 才处理下一个请求。
- 主进程生成唯一 Pi request id，使用 pending 表关联 response；Electron invoke 的响应关联与 Pi request id 分开。
- 不持全局锁等待 RPC response，不让等待 prompt 完成阻塞查询或 abort。
- 超时只结束等待，不证明 Pi 没有执行，不自动重发 prompt；进程退出、写入失败和初始化失败时收敛 pending 请求并释放资源。
- 解析错误产生明确诊断并按 LF 恢复记录边界；无法保持投影一致时不能继续显示为正常完整结果。超长记录和持续异常输出设处理边界，必要时可控关闭 Runtime，不能无限缓存或静默丢弃增量。
- 对有效但暂不支持的事件分类处理，不因未知事件名直接崩溃，也不把独立 Extension UI 记录当作普通文本。
- Prompt 提交走固定业务方法，主进程只接受 `message` 与可选 `images` 字段并重新校验：文本必须是字符串、去空白后非空、UTF-8 字节数不超过 1 048 576；图片逐张校验 MIME 白名单（png/jpeg/gif/webp）、base64 编码后不超过 4 MiB，单条 Prompt 最多 4 张，超限按参数拒绝，不静默丢弃。主进程自行构造 `{type:"prompt",message,images}`，`images` 仅在有附件时携带。等待期限 30 000 毫秒只覆盖 preflight，超时返回结果未知且不自动重发。Runtime 不是 `ready` 时提交返回 `RUNTIME_NOT_READY`；Pi 以 `success: false` 拒绝时返回 `PROMPT_REJECTED` 并带 Pi 的原因文本，disposition 取值不符契约时按 `RUNTIME_PROTOCOL_ERROR` 处理。busy 判定完全以 Pi 的拒绝为准，主进程不做本地 streaming 预检；运行中状态由事件流的 `agent_start`/`agent_settled` 收敛（见下文临时投影与通知契约），不用于预测性拦截。文件引用不做：RPC 模式官方拒绝 `@file` 参数，输入框中的路径文本只是普通文本，读文件由 Pi 的 `read` 工具覆盖。
- 模型的图片输入能力来自 `get_available_models` 返回的完整 Model 对象的 `input` 字段：含 `image` 为 true，明确不含为 false，缺失为 null（未知）。投影在 `ModelSummary.imageInput`；当前模型明确不支持时图片入口禁用并提示，未知时不限制。
- 消息投影对用户消息中的图片内容块生成附件描述块：`dataUrl`（base64 本体转 data URL，仅用户消息）、`mimeType` 与估算字节数；估算字节超过 8 MiB 的附件只保留文字描述不保留本体。恢复会话历史中的图片按同一规则投影；Assistant 消息中的图片块不进投影。
- CSP：`img-src` 为 `'self' data: blob:`，仅用于本地图片附件的输入预览（blob: URL）与消息内缩略图（data: URL）；模型 Markdown 与工具输出中的远程图片依旧不渲染，不放开任意远程图片来源。

#### 临时投影与通知契约

- 投影只重建 `user` 与 `assistant` 角色消息的 text、thinking 与 toolcall 内容块，用户消息中的图片块以附件描述块投影（见本节 Prompt 段）；压缩、重试与队列事件不进入展示投影。工具执行改成按 `toolCallId` 索引的独立条目、与消息块解耦，消息块不承载执行状态；界面展示的是 Pi 会话消息与工具执行的子集，不是完整历史。
- Pi 的 wire 消息没有 id，投影为每条消息生成 Desktop 侧的稳定标识，块按 `contentIndex` 对齐：`message_start` 建消息，`text_delta`/`thinking_delta` 累积，`text_end`/`thinking_end`/`toolcall_end` 用权威内容校正，`message_end.message` 整条替换；未知角色、未知子类型与未知事件名一律忽略。
- 工具条目关联一次执行的完整生命周期：`tool_execution_start` 建条目并记录 `args`，`tool_execution_update` 只保留最近一次 `partialResult`（追加或替换语义由具体工具决定，不做内容级累加），`tool_execution_end` 用 `result` 校正并按 `isError` 收敛为成功或失败；`agent_settled` 时仍未结束的条目标记为未确认结束，不冒充成功。结果只从 `content` 提取文本块；非文本内容块只保留类型、MIME 类型与估算字节数的描述，总量另行计数，图片数据不进入投影也不渲染。
- 工具耗时由 Desktop 计算，不使用 Pi 字段：条目的 `startedAt`、`endedAt` 是 Desktop 收到对应事件的时刻（纪元毫秒），未确认结束的条目没有结束时刻，只见过结束事件的条目没有开始时刻；运行中的条目以渲染端当前时刻估算进行中的耗时，缺少开始时刻、或既无结束时刻又非运行中的条目不显示耗时；界面不把它表述为工具的真实执行时间。
- 恢复会话时按 `get_messages` 返回的 `toolResult` 消息补种工具条目：`args` 取自同一次调用的 `toolcall` 块参数文本，结果与错误状态取自该消息的 `content` 与 `isError`，结束时刻取该消息的时间戳，开始时刻缺失；`toolResult` 本身仍不进入消息块投影，补种条目与实时条目共用条目上限与丢弃计数。
- 批次：距上次发送满 100 毫秒或积压 64 条更新即发送，消息与工具的开始、结束事件立即发送，工具 `partialResult` 更新只走批次节拍；批次带 Runtime 代际标识与单调序号。
- 更新形态：流式内容为“追加文本 + 追加后块总长度”，块结束、整条消息与工具条目为权威内容；渲染端只在长度不变式成立时应用，不符即换取快照，不猜测补齐；同一 `toolCallId` 的未发出条目更新只保留最新一份，合并不得越过块校正与整条替换的相对顺序。
- 同步：渲染端应用后回应用确认；主进程保留 32 个未确认批次，超出即作废增量并发出重同步标记。渲染端遇到序号缺口、重同步标记或尚未取得基准时调用快照接口全量替换，快照是唯一基准。
- 上限：单块 256 KiB、投影文本总量 4 MiB、保留 200 条消息；工具条目文本同样按 256 KiB 截断、参数摘要上限 4 KiB、最多保留 100 条、非文本内容描述最多 32 条（超出只保留总数）；触及上限时从最旧开始丢弃并计数，界面明确标示截断与省略条数，不伪装成完整内容。
- 主进程始终消费 stdout，不为等待渲染端确认而暂停读取 Pi。

#### IPC 请求响应与事件流

固定业务操作使用 `ipcRenderer.invoke` / `ipcMain.handle`；preload 只暴露本阶段需要的方法。主进程重新校验参数、运行状态、可信窗口与顶层 frame 来源，以及该窗口对 Runtime 的归属。不提供任意 RPC JSON、channel、启动参数或命令执行接口。

prompt 返回表示接受、排队或处理结果，不等待 Agent 执行结束。错误采用可序列化的业务结果，区分参数拒绝、状态冲突、Pi 命令失败、启动失败、通信失败与结果未知；不依赖原样跨 IPC 传递 Error 对象，不泄露内部堆栈或秘密。

中止当前操作走固定业务方法（通道 `desktop:runtime-abort`，零参数）：主进程只校验 Runtime 处于 `ready`，不做本地 streaming 预检；Pi 要等 Session idle 后才回应，因此等待上限为 30 000 毫秒，超时只表示结果未知且不自动重发。不新增错误码，复用 `RUNTIME_NOT_READY`、`RUNTIME_TIMEOUT`、`RUNTIME_EXITED` 与 `RUNTIME_PROTOCOL_ERROR`；第一阶段不引入 `clear_queue`，也不把 abort 当作清空排队输入。

主进程先应用 Pi 记录到临时投影，再通过定向事件通知窗口，不将每个 token 无界转发。Vue 在启动和发送 prompt 前完成订阅；重新订阅时取得投影和序列基点，避免遗漏或重复应用，并在释放页面时取消监听。

Runtime 代际、事件序列和同步元数据放在 Desktop envelope 中，不添加到 Pi 原始记录冒充官方字段。旧 Runtime 的异步结果不得覆盖新状态。展示更新可以按语义合并，最终消息、错误与运行终态不得因合并而丢失。

Pi 管道背压与 UI 通知背压分开处理：采用有界批次与渲染端应用确认，限制未确认通知；渲染端落后时从临时投影重新同步，不为等 UI 而暂停读取 Pi。展示输出超限时明确标示截断，不伪装为完整内容。具体批次节拍、未确认窗口与缓存上限见上文“临时投影与通知契约”。

第一阶段使用定向 IPC 事件，不增加 MessagePort 通道；MessagePort 本身也不代替应用层流量控制。

#### Project 与本地配置

- Project 基础属性为 `id`、`name`、`path`、`lastOpenedAt`：`id` 由主进程用 `crypto.randomUUID()` 生成，`name` 取规范路径末段，`lastOpenedAt` 为纪元毫秒，只在项目被设为当前项目时更新。
- 路径归一化只有一个入口（`src/main/project-path.ts`）：拒绝空值、NUL 与相对路径后执行 `realpath`（解析符号链接、平台短名与规范大小写，去掉尾部分隔符与 `\\?\` 前缀，保留 UNC 形式），再要求 `stat` 为目录。不做大小写折叠，不主动添加 `\\?\`。
- 本地配置为单个 JSON 文件 `<userData>/desktop-config.json`，结构为 `{ version: 1, projects: [...], currentProjectId, ui, window, projectTrust }`，UTF-8、两空格缩进、末尾换行；最近项目上限 50 条，超出按 `lastOpenedAt` 最旧淘汰。写入使用同目录临时文件加改名替换，并在主进程内串行执行。项目列表、界面偏好、窗口状态与各项目的信任决定共用同一个文件与同一条写入队列，只有一个读写者；`projectTrust` 的取值与语义见本节 Project Trust 小节。
- 界面偏好与窗口状态是同一文件里的可选字段：`ui.sidebarCollapsed`（布尔，默认 `false`）、`ui.theme`（`system`/`light`/`dark`，默认 `system`）与 `window.width/height/x/y/maximized`（尺寸与坐标为整数，位置必须成对有效，默认 1120×820 且不恢复位置）；各项目的信任决定同为可选字段，见 Project Trust 小节。字段缺失或非法一律按默认值处理，不参与损坏与版本判定，也不改变版本语义。
- 界面偏好通道：`desktop:preferences-get`（零参数，返回 Sidebar 折叠状态与主题）与 `desktop:preferences-set-ui`（只接受 `{ sidebarCollapsed, theme }`）。复用既有桥接错误码，本阶段不新增；写入失败只提示，界面偏好已在页面本地生效。
- 主题：取值与 Electron `nativeTheme.themeSource` 状态机一一对应；主进程在创建窗口前从配置读取主题并应用，页面内 `prefers-color-scheme` 媒体查询切换 CSS 令牌，窗口背景色按 `shouldUseDarkColors` 选择并与 `--color-desk-canvas` 同步维护，系统主题变化时同步收敛背景色；`system` 时跟随 OS 实时切换，不增加事件通道。保存偏好时在参数校验通过后立即应用本次请求的主题，只读降级时同样对本次运行生效。
- 窗口偏好不经 IPC，由主进程独占：创建窗口前读取，位置必须与某显示器工作区有足够交集，否则丢弃位置交给窗口居中；尺寸按窗口下限（720×600）与目标显示器工作区收敛；保存使用 `getNormalBounds` 与最大化状态，不把最大化尺寸写成常态尺寸；变更防抖写入，并在退出关闭链前强制落盘。
- 配置降级：文件不存在按空配置处理且不创建文件；JSON 无法解析或顶层结构不符时把原文件改名为 `desktop-config.corrupt-<时间戳>.json` 后重新开始；版本号不是 1 或读取失败（非「文件不存在」）时进入只读降级，保留原文件并拒绝一切写入；单条记录不合法只丢弃该条。
- 通道：`desktop:project-choose-directory`（零参数，返回归一化后的 `{ path, name }`，用户取消时 `data` 为 `null`）、`desktop:project-list`（返回项目列表、当前项目与配置提示）、`desktop:project-set-current`（只接受 `{ path, allowInterrupt }`）。本阶段不新增单向事件通道。
- 切换项目：先归一化目标路径；Runtime 处于 `starting`/`stopping`，或 `ready` 且 `isStreaming` 为真而请求未带 `allowInterrupt` 时返回 `PROJECT_SWITCH_BLOCKED` 且不中断任何操作；否则复用本节关闭链结束旧 Runtime，确认回到 `idle` 后才写入配置并返回新的列表；关闭未确认（`failed`）时返回错误且当前项目不变。不排队、不自动重放。`failed` 状态下不再追加终止尝试，只切换并保存项目选择。
- 错误码：本阶段新增 `INVALID_PROJECT_PATH`、`PROJECT_SWITCH_BLOCKED`、`PROJECT_STORAGE_FAILED`，与既有桥接错误码共用结果结构。
- 页面只保存展示副本，选择项目不会自动启动 Runtime；主进程读取项目列表时不检查项目目录是否仍然存在。

#### Project Trust

- 触发信任要求的资源清单以 Pi v1.0.4 官方文档为准：项目目录下 `.pi/settings.json`、`.pi/mcp.json`、`.pi/extensions|skills|prompts|themes`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`，以及当前目录与全部祖先目录的 `.agents/skills`；裸 `.pi` 目录不触发。探测在主进程内只读 `stat` 完成，祖先遍历到文件系统根为止，单路径失败按不存在处理，结果按项目规范路径缓存，不监听文件变化。
- 决定存入 Desktop 自己的配置：`desktop-config.json` 顶层可选字段 `projectTrust`（键为项目规范路径，值为 `"trusted"` 或 `"untrusted"`），缺失或非法按无决定处理，不改变配置版本语义；不读写 Pi 的 `~/.pi/agent/trust.json`，也不处理 `project_trust` extension 事件。
- 官方优先级中 CLI 覆盖最优先：有受保护资源时 Desktop 总是显式传 `--approve`（信任）或 `--no-approve`（不信任），因此会覆盖用户在 Pi TUI 中已保存的信任记录；无受保护资源时不传该参数，交给官方默认。信任≠沙箱，上下文文件（AGENTS/CLAUDE）不受决定影响，官方在 trust 决定前读取 `sessionDir` 的行为不改变。
- 拦截点只有两个：`desktop:runtime-start` 与 `desktop:session-open`。有受保护资源且无决定时返回 `TRUST_REQUIRED`（消息带资源路径摘要），不启动 Runtime；用户经 `desktop:trust-decide` 保存决定后，界面自动重试被拦截的会话打开或新建，取消则不重试。
- 通道：`desktop:trust-status`（零参数，返回当前项目的决定与探测到的资源列表）与 `desktop:trust-decide`（只接受 `{ projectPath, decision }`，`decision` 为 `"trusted"`/`"untrusted"`/`"unset"`；`projectPath` 必须与当前项目归一化路径一致，防止页面改写其他项目的决定，`unset` 表示清除决定）。错误码新增 `TRUST_REQUIRED`（定义在共享桥接错误码族，`desktop:runtime-start` 与 `desktop:session-open` 都可能返回）。
- 界面入口：会话打开或 Runtime 启动被拦截时弹信任对话框（资源列表 + 安全影响说明 + 信任/不信任），决定后自动重试被拦截的会话打开或新建，取消不保存任何状态；Runtime 详情弹层提供「重置本项目信任决定」，下次启动该项目时重新询问。

#### Extension UI（P3-02）

- 启用方式：P3-02 起不再传 `--no-extensions`，项目 Extension 的加载由 Project Trust 决定控制（见上节）；Skills、Prompt Templates 与 MCP 仍以 `--no-*` 关闭，启用与否属 P3-06 范围。
- 只映射官方 RPC Extension UI 子协议的九个 method。Dialog 类（`select`/`confirm`/`input`/`editor`）需要页面回应；fire-and-forget 类（`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`）只更新展示状态。未知 method、字段超限或形状不符的请求只计入 `invalidCount`，不报错、不自动批准。
- Dialog 请求按到达顺序排队（上限 8 条，同 id 重复投递按一次处理），页面模态展示队首；回应经 `desktop:extension-ui-respond` 提交，只接受互斥的三种形态（`value`/`confirm`/`cancelled`），主进程校验 id 在队列中且形态与 method 匹配后才出队并写回 `extension_ui_response`；写回失败按管道关闭收敛，不重发。`timeout` 字段由 Pi 侧自动解析，Desktop 不计时，只在界面展示。
- fire-and-forget 状态由主进程按代际持有并广播：`notify` 保留最近 10 条（info/warning/error）；`setStatus` 按 key 增删（上限 16 条）；`setWidget` 按 placement 覆盖，空 lines 表示清除；`set_editor_text` 保留最新一条，页面在用户输入框为空时填充，不覆盖已输入内容；`setTitle` 无桌面等价物，不计入展示。
- 通道：`desktop:extension-ui-state`（零参数，返回当前快照）与 `desktop:extension-ui-respond`（只接受 `{ dialogId, response }`）；变更经 `desktop:extension-ui-changed` 单向广播给当前可信窗口。快照带代际标识与递增序号，渲染端按序丢弃过期快照。错误码新增 `EXTENSION_DIALOG_NOT_FOUND`。
- 状态随 Runtime 退出、停止或切换清空，不持久化；通知、状态条与 widget 文本一律按不可信纯文本插值展示，不使用 `v-html`。

#### Session 与恢复

- 会话文件由 Pi 管理：根目录是 `<agent-dir>/sessions/`（`agent-dir` 由 `PI_CODING_AGENT_DIR` 指定，默认 `~/.pi/agent`），按工作目录分组为 `--<路径 munged>--/`（去掉路径开头的分隔符后把 `/`、`\`、`:` 换成 `-`），文件名是 `<ISO 时间>_<会话 id>.jsonl`，同名 `.jsonl.timings.json` 侧车不参与列表。主进程显式传 `--session-dir` 指定该根目录，不读取 `PI_CODING_AGENT_SESSION_DIR` 与 `sessionDir` 设置。
- 列表只读会话文件：每轮 `readdir` 后按文件大小与修改时间命中缓存，未命中时做一次 256 KiB 有界读取，取首行头部（`type`、`id`、`timestamp`、`cwd`）与首条用户消息开头（预览截断为 120 字符，取不到为 null）。条目字段为 `sessionId`、`createdAt`、`updatedAt`、`sizeBytes` 与预览，按最后修改时间降序，最多 100 条；超出的条数与「头部 `cwd` 与当前项目不符或无法解析」的文件数量分别计数，界面如实标示。
- 分组目录名会歧义（`<根>/a-b` 与 `<根>/a/b` 经 munge 后同名），因此会话归属以头部 `cwd` 与当前项目规范路径的比较结果为准；Windows 折叠大小写，其他平台严格比较。
- 打开与新建一律重启 Runtime：先校验目标会话存在且属于当前项目，再复用本节关闭链结束旧 Runtime，确认回到 `idle` 后以 `--session-id <id>`（恢复）或不带该参数（新建）启动；请求的会话与已就绪 Runtime 一致时幂等返回。Runtime 处于 `starting`/`stopping`，或 `ready` 且 `isStreaming` 为真而请求未带 `allowInterrupt` 时返回 `SESSION_SWITCH_BLOCKED` 且不中断任何操作；不排队、不重放。不使用 RPC 的 `switch_session` 与 `new_session`，保持一个 Runtime 代际对应一个会话。
- 恢复会话时在发布就绪前请求 `get_messages`，把历史消息按整条替换规则灌入临时投影作为基准；读取历史消息的等待上限是 15 000 毫秒，超时或失败按启动失败处理，不显示不完整的历史，截断与上限沿用临时投影契约。
- 通道：`desktop:session-list`（零参数，基于当前项目）与 `desktop:session-open`（只接受 `{ sessionId, allowInterrupt }`，`sessionId` 为 null 表示新建，非 null 时只接受 Pi 允许的字符集：字母、数字、`.`、`_`、`-`）。新增错误码 `SESSION_NOT_FOUND`（目标会话不存在，或 Pi 实际打开的会话与请求不一致）与 `SESSION_SWITCH_BLOCKED`；有受保护资源且无信任决定时返回 `TRUST_REQUIRED`（见本节 Project Trust 小节）；其余复用 Runtime 错误码族。会话文件路径不跨 IPC 交给页面。

#### Session Fork（P3-03）

- 接入方式：用官方 `get_fork_messages`（当前分支上可分叉的用户消息，`entryId` 为会话条目稳定 id）与 `fork { entryId }` 命令；`fork` 在同一 Pi 进程内产生新会话并切换，Extension 可经 `session_before_fork` 取消（响应 `cancelled: true`，Desktop 以专属错误码 `FORK_CANCELLED` 如实提示，不报错、不切换）。
- 会话归属复用重启式切换：fork 成功后读取 `get_state` 复核实际新会话 id（不沿用旧快照），再走与会话打开同一条关闭链 + 启动链，以新会话 id 重新启动 Runtime；信任拦截、中断确认、历史灌入与列表刷新全部复用既有链路，维持「一个 Runtime 代际对应一个会话」。
- 中断守门：Runtime 就绪且 `isStreaming` 为真而请求未带 `allowInterrupt` 时返回 `FORK_BLOCKED`，不中断任何操作；不排队、不重放。
- 通道：`desktop:fork-messages`（零参数，要求 Runtime 就绪，空列表是合法结果）与 `desktop:fork-start`（只接受 `{ entryId, allowInterrupt }`）；成功数据带新 `sessionId` 与刷新后的列表。新增错误码 `FORK_NOT_FOUND`、`FORK_CANCELLED`、`FORK_BLOCKED`。
- 入口在 Runtime 详情弹层；只在 Runtime 就绪时可用，运行中分叉会先停止当前操作（与切换会话同语义）。不做 `clone`、`get_entries` / `get_tree`，无 GUI 场景不提前接入。

#### Agent 控制（模型、Thinking、上下文占用）

- `get_state` 只投影页面需要的子集：`model`（`provider/id` 标签）、`modelProvider`、`modelId`、`thinkingLevel`、`sessionId`、`messageCount`、`isStreaming` 与 `isCompacting`；Pi 的完整 Model 对象、队列与 steering 字段不进入快照。状态变化只经既有的 `desktop:runtime-status-changed` 广播，字段扩展与跨进程校验必须同批更新。
- 通道：`desktop:runtime-capabilities`（零参数，返回当前代际的可用模型、Thinking levels 与上下文占用）、`desktop:runtime-set-model`（只接受 `{ provider, modelId }`）、`desktop:runtime-set-thinking-level`（只接受 `{ level }`）。参数只校验形状与非空，provider/modelId 上限 256 字符、level 上限 32 字符；取值是否被接受以 Pi 的拒绝为准，不维护 level 白名单。不新增单向事件通道。
- 能力结果分三区，每区独立表达失败：`models`（精简字段为 `provider`、`id`、`name`、`reasoning`、`contextWindow`；`baseUrl`、`api`、`maxTokens` 与 `cost` 不进页面）、`thinkingLevels`（当前模型支持的范围，不支持推理时为 `["off"]`）、`contextUsage`（`tokens`、`contextWindow`、`percent`）。`contextUsage` 为 null 且对应 error 也为 null 表示 Pi 明确没有可用上下文窗口；压缩刚结束时 `tokens` 与 `percent` 为 null，界面按未知展示，不当 0，也不把全会话累计用量当作当前占用。
- 刷新时机：Runtime 就绪后、每轮 `agent_settled` 之后由渲染端重新读取，以及模型或 Thinking 设置成功后；不做轮询。可用模型列表与 Thinking levels 在 `runtimeId` 代际内缓存（模型变化后 Thinking levels 失效），上下文占用每次重新读取。
- 事件收敛：`thinking_level_changed` 直接更新快照中的级别；`agent_settled` 后刷新一次 `get_state`，让 `isCompacting` 等字段回到权威值。协议没有模型变化事件，模型一致性以 `set_model` 成功后的刷新为准。刷新使用 in-flight 守卫，且只在该 Runtime 仍是当前代际且仍就绪时生效。
- 错误码：新增 `RUNTIME_COMMAND_REJECTED`，用于 Pi 以 `success: false` 拒绝模型或 Thinking 设置（消息带 Pi 的原因文本，如模型未配置凭据）；其余复用 Runtime 错误码族。
- 压缩中不新增本地拦截：界面如实提示“提交会被 Pi 拒绝”，busy 判定仍完全以 Pi 的拒绝为准。

#### 手动压缩（P3-03）

- 接入方式：官方 `compact` 命令（不带 `customInstructions`），响应同步携带结果；Desktop 投影 `summary`、`tokensBefore`、`estimatedTokensAfter` 与 `usage.totalTokens`（自定义压缩处理器可省略 `usage`，为 null；字段缺失一律按 null 展示，不猜造）。
- 等待期限单独设为 120 000 毫秒（压缩是一次 LLM 调用）；超时只结束等待，结果未知且不自动重发。压缩中状态由 `get_state.isCompacting` 与 `compaction_start` / `compaction_end` 事件收敛，`agent_settled` 后的既有快照刷新链把字段拉回权威值。
- 通道：`desktop:runtime-compact`（零参数，要求 Runtime 就绪）。入口在 Runtime 详情弹层，只在就绪且非压缩中时可用；成功展示前后 token 数，失败与中止按错误如实提示，不伪造结果。不做 `set_auto_compaction` 开关，属后续按需接入。

#### 关闭、异常与进程树

正常关闭停止接收新业务请求，保留内部取消路径；仅当事件流显示仍在运行（`isStreaming`）时先对活动操作发起 abort，并最多等待 3 000 毫秒——超时或取消被拒都不阻断后续链路——然后关闭 stdin、继续消费管道并等待退出，超时后执行平台兜底。异常退出显示原因和结果不确定性，由用户显式重新启动，不自动重放 prompt。

Windows 使用系统 `taskkill` 对当前受管 Pi 进程树定向终止，不先只杀根进程再假定能够找到所有子进程；macOS 为 Pi 建立独立进程组，必要时终止该组，不调用 unref 将其解除应用管理。实现上 Windows 调用 `%SystemRoot%\System32\taskkill.exe /F /T /PID`（与 Pi 自身的 `killProcessTree` 同法），macOS 向进程组先发 `SIGTERM`、再发 `SIGKILL`；关闭 stdin 后等待 5 秒，每级兜底再等 2 秒。终止对象只能来自主进程自身的 Runtime 记录，不接受页面传入任意 PID，也不按进程名批量终止。

这些都是尽力回收：根进程已退出、主进程崩溃或派生进程脱离后，不能保证完整清理。Windows 在系统关机或注销时不触发 Electron 的 `before-quit`，该路径不发起关闭链。Windows Job Objects 可提供更强控制，但 Node.js 内建 spawn 不直接提供该能力；第一阶段不为此引入原生绑定或专用 helper。

关闭唯一业务窗口或失去唯一可信控制界面时，主进程在 `before-quit` 中先落盘窗口状态，再发起可控 Runtime 关闭并在预算内等待（预算 10 秒，超时强制退出应用），避免无意留下后台 Agent。托盘、隐藏常驻与多窗口行为在第五阶段另行设计。第一阶段不承诺完整崩溃恢复、完整进程树回收或 OS 沙箱。

### 6.3 主界面

主界面替换第一阶段的最小 Runtime 页面，提供：

- 顶栏：Sidebar 折叠开关、项目切换入口（目录选择、最近项目、手动路径、配置提示）、当前会话、Runtime 状态，以及详情弹层里的 Agent 控制（模型与 Thinking 选择、上下文占用、压缩中提示）、重置本项目信任决定与应用信息、关闭 Runtime。
- 会话侧栏：当前项目的 Pi 会话列表、新建与刷新、当前会话高亮、跳过与截断提示。
- 消息区：按消息分组并按内容块顺序渲染，用户与 Assistant 区分，用户消息的图片附件渲染为缩略图，Thinking 可折叠，工具调用内联为通用工具卡片（名称、状态、Desktop 计算的耗时与参数摘要，展开后显示参数、结果或错误输出、非文本内容描述与截断提示；运行中的卡片自动展开一次，之后由用户开合），并表达同步、截断、失败与运行中状态。
- Prompt 区：输入与发送、图片附件选择、预览与移除、Agent 运行期间原位的停止入口，以及请求接受、拒绝与中止的提示；另承载 Extension 的对话、通知与 widget 展示及编辑器填充（取值与边界见第 6.2 节 Extension UI）。

组件通过统一前端服务入口调用受限 preload API，Pinia 管理共享的展示状态。消息重建与 Runtime 所有权归主进程，前端不直接访问 ipcRenderer，不提供任意 RPC JSON 的通用发送入口。打开、新建与恢复会话都由主进程重启式切换，页面的当前会话以 Runtime 快照为准。Prompt 发送只展示请求接受或拒绝；运行中状态由 `agent_start`/`agent_settled` 收敛，消息与工具展示来自主进程投影批次，页面在失去同步时标示同步中或截断，不自行拼装历史。打开或新建会话即启动 Runtime，页面不单独提供启动入口。Stop 只在 Runtime 就绪且事件流显示运行中时可用，界面把“中止请求中且仍在运行”表达为停止中，是否真的停止以 `agent_settled` 收敛，不以请求响应为依据。输入提交处理输入法组合态、Enter 发送与 Shift+Enter 换行、发送后焦点回归、成功后清空与发送中不重复提交；消息区在用户已上滚时不强制拉到底部。模型文本、工具参数与工具输出一律按纯文本插值展示，不使用 `v-html`，不当作 HTML 或外部资源渲染。主题切换在顶栏提供跟随系统、浅色与深色的循环入口，取值与切换机制见第 6.2 节。

### 6.4 实现顺序

具体任务与依赖见[第一阶段：Runtime](phases/01-runtime.md)。

**第一小步：启动链。** 建立最小 Electron/Vue 骨架、sandboxed preload 与固定 binary 准备流程；主进程启动 Pi RPC、通过 `get_state` 取得状态、消费 stderr、处理退出与关闭。

**第二小步：交互链。** 增加 prompt、主进程临时消息投影、受控流式通知、工具事件展示和 abort，不跨入第二阶段完整 Desktop UI。

具体源文件、依赖版本、资源布局的准确路径和操作清单在对应小步确定；本文不授权一次性生成完整项目。

## 7. 安全、Trust 与平台边界

### 7.1 Electron 安全与非沙箱边界

渲染进程明确使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，保持 `webSecurity` 开启。Sandboxed preload 只使用允许的有限 API，其构建适配沙箱限制，不因模块加载问题而关闭 sandbox。

- Vue 不直接 spawn Pi，不拥有 Node.js、通用 shell 或全域文件权限；preload 不暴露原始 ipcRenderer、任意 channel 或 Electron event 对象。
- 主进程仅提供明确业务能力，校验参数、当前状态、已登记窗口、顶层 frame 的可信来源及 Runtime 归属；channel 名固定不等于调用者可信。
- 正式包通过受控本地应用协议加载打包资源，路径映射只允许应用资产，不成为项目文件读取入口。
- 正式 CSP 限制脚本来源，不启用任意远程脚本或 unsafe-eval；开发服务器所需权限仅在开发配置中开放。
- 默认拒绝不需要的系统权限、页面导航和新窗口，不向网络开放 Pi RPC。
- 模型 Markdown、工具结果和 Extension 文本均视为不可信内容；需要 HTML 展示时净化内容，不允许脚本、事件属性或任意嵌入页面。
- 不自动加载模型生成的远程图片。外链只在用户动作后，经主进程协议检查交由外部浏览器打开，不开放任意 URI scheme。
- 不把密钥、认证文件、全部环境变量或完整敏感工具输出写入常规日志；已有凭据不回传页面。

三层边界分别是渲染进程 sandbox、主进程的受限业务桥接，以及 Pi 自身的 OS 权限。主进程和 Pi 不因渲染进程 sandbox 而被限制在项目目录；ASAR 是打包格式，不是权限或内容完整性边界。

**Pi 默认以启动用户的 OS 权限运行，不会逐次确认所有工具调用。** cwd 只是默认工作目录，Project Trust 控制资源加载而非文件访问沙箱。产品不能把 Electron 渲染隔离或项目目录选择宣传为已经限制 Pi 的 OS 权限。

### 7.2 Project Trust

官方 `--approve` 与 `--no-approve` 是本次进程的项目信任覆盖，不等于写入持久信任决定。

RPC 无法展示 Pi 内建的 TUI trust prompt。没有显式覆盖、Extension 决定或已保存决定时，`defaultProjectTrust` 的 `always` 会加载项目资源，`ask` / `never` 会跳过。

第一阶段显式采用 `--no-approve`，并关闭 Extensions、Skills、Prompt Templates、MCP（对应 `--no-extensions`、`--no-skills`、`--no-prompt-templates`、`--no-mcp`）；避免依赖全局 trust 默认值，不自动信任项目，不直接修改 `trust.json`。

P3-01 已实现 Desktop 侧的信任流程：启动前探测受保护资源，无决定时经 `TRUST_REQUIRED` 拦截并由用户决定，决定存入 `desktop-config.json` 的 `projectTrust` 字段，启动时按决定条件传递 `--approve` / `--no-approve`（细节见第 6.2 节 Project Trust）。Desktop 的显式覆盖优先于 Pi 已保存的信任记录，这是官方 CLI 覆盖优先级的直接结果；P3-02 起 Extension 随 Trust 决定加载，Skills、Prompt Templates 与 MCP 仍以 `--no-*` 关闭，启用与否属 P3-06 范围。

Trust 不完全覆盖启动行为：官方代码在 trust 决定前会读取项目 `sessionDir`；AGENTS/CLAUDE 上下文文件也不因拒绝 trust 自动禁用。关闭项目资源加载不等于内容安全或工具权限受限，信任决定也不是 OS 沙箱。

### 7.3 平台 Shell 与工具集合

Pi 1.0.4 已提供官方 `powershell` 工具：

- Windows：优先 `read,powershell,edit,write`。
- macOS：使用 `read,bash,edit,write`。

工具集合由启动参数显式选择，不修改用户全局 `defaultTools`。当前官方默认工具仍包含 Bash，并未按 Windows 自动替换成 PowerShell。

PowerShell 解析优先 `pwsh.exe`，其次 `powershell.exe`；不存在时报告明确错误，不强制用户安装 Git for Windows。启用 Git Bash 留待明确需求，不能假设 Windows 存在 Bash。

## 8. 后续阶段与不做项

| 阶段 | 目标与范围 |
| --- | --- |
| [第一阶段：Runtime](phases/01-runtime.md) | 最小桌面骨架、受限应用信息接口，以及当前文档第 6 节定义的启动链和交互链 |
| [第二阶段：基础 Desktop UI](phases/02-desktop-ui.md) | Project、Pi Session 列表与恢复入口、Chat、Streaming、通用 Tool Card、模型、Thinking Level、Stop、Context Usage |
| [第三阶段：Pi 深度能力](phases/03-pi-capabilities.md) | Extension UI、正式 Project Trust、完善 Session 恢复与 Fork、Compaction、Diff、图片、文件引用、Skills、Extensions、Packages、MCP |
| [第四阶段：Authentication](phases/04-authentication.md) | Provider、API Key、OAuth、Login/Logout、状态；仅在必要时增加复用官方认证实现的 standalone Helper |
| [第五阶段：Desktop 产品能力](phases/05-desktop-features.md) | Auto Update、Crash Recovery、Recent Projects 完善、快捷键、托盘、通知、多窗口 |

Project 的基础属性为 `id`、`name`、`path`、`lastOpenedAt`；本地配置位置、路径归一化、列表上限与切换编排见第 6.2 节。Session 和消息仍交给 Pi，不创建平行数据模型与数据库；会话目录、列表与恢复方式也在第 6.2 节。

当前 RPC command union 有 `new_session`、`switch_session`、`get_messages`、`fork` 等能力，但没有 Session 列表命令；接入方式已在 P2-02 确定为读 Pi 会话文件元数据（见第 6.2 节），不能自行假设存在 `list_sessions`。

当前 Extension UI wire 使用独立 `extension_ui_request` / `extension_ui_response`，设置编辑器文本的 method 为 `set_editor_text`。RPC 不支持任意 TUI 组件，未来兼容范围以官方支持的子协议为边界，不承诺所有 TUI Extension 无损运行。

第一阶段明确不做：完整 Sidebar、Project 持久化（已在 P2-01 实现）、Session 列表（已在 P2-02 实现）、Authentication、Extension UI、Git GUI、Terminal、文件管理器、插件市场、复杂工作流、多 Agent 和任务编排。不得为这些范围提前增加空抽象或依赖。

## 9. 待解决问题

1. 完整依赖树锁定，以及 Electron、固定 Pi 与 helper 在 Windows 与 macOS 上共同约束的系统与运行库最低版本；后续依赖调整继续考虑 Electron 的维护状态。
2. 避免需要本地编译的原生依赖；Pi/helper 在各目标平台的运行库需求。需要新增工具链时单独取得授权。
3. 正式签名、公证与安装包配置，按发行步骤确定；staging 路径、三目标文件选择与 package 根/executable 邻接映射已在 P1-02 确定（见第 4 节）。
4. Extension UI 进入展示投影的边界已在 P3-02 确定（见第 6.2 节 Extension UI）；消息历史的读取方式已在 P2-02 确定（`get_messages` 初始化投影，见第 6.2 节）。临时消息投影与通知确认契约已在 P1-06 确定，工具执行进入展示投影的边界与中止契约已在 P1-07 确定（均见第 6.2 节），管道边界在 P1-03 确定，请求期限在 P1-05 确定。不建立平行 Session 数据库。
5. 不同启动 profile 下现有模型与凭据的可用性（启动参数已在 P1-03 确定）；只读取必要配置，不输出秘密。
6. Windows 与 macOS 的进程树终止已按平台实现（见 6.2 节）；macOS 分支只在 macOS 主机上生效。保留尽力回收边界，不以关闭主 Pi 进程等同于完整进程树回收。
7. 第二阶段 Session 列表的接入方式（读 Pi 会话文件的元数据）与恢复方式（重启式切换）已在 P2-02 确定（见 6.2 节）；跨项目复用同一会话文件（手工移动会话文件或项目目录改名）对 cwd 与资源重建的影响仍待核实。

这些问题按相应阶段解决，不把后续完整能力变成第一阶段的提前实现范围。

## 10. 官方依据

Pi 事实以固定 `v1.0.4` 为引用基线；Electron、Node.js 和打包器资料用于说明能力与设计取舍，不代替具体依赖版本锁定。平台支持和签名配置会随版本变化，在相应开发阶段确定。

- [Pi 1.0.4 发布资产](https://github.com/earendil-works/pi/releases/tag/v1.0.4)
- [Pi binary 构建脚本](https://github.com/earendil-works/pi/blob/v1.0.4/scripts/build-binaries.sh)
- [Pi binary 发布 workflow](https://github.com/earendil-works/pi/blob/v1.0.4/.github/workflows/build-binaries.yml)
- [Pi CLI 参数](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/cli.md)
- [Pi RPC 概览](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/rpc.md)
- [Pi RPC commands](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/rpc-commands.md)
- [Pi JSON/RPC events](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/json.md)
- [Pi RPC 实现](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [Pi RPC types](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [Pi JSON event 转换](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/modes/json-event.ts)
- [Pi CLI 启动与模型前置条件](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/main.ts)
- [Pi 安全与 Project Trust](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/security.md)
- [Pi Extension UI 子协议](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/rpc-extension-ui.md)
- [Pi 资源路径配置](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/config.ts)
- [Pi Photon WASM loader](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/utils/photon.ts)
- [Pi native helper 路径](https://github.com/earendil-works/pi/blob/v1.0.4/packages/tui/src/native-module-path.ts)
- [Pi Bash/PowerShell 解析](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/utils/shell.ts)
- [Pi 内置工具](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/index.ts)
- [Electron 平台支持](https://github.com/electron/electron#platform-support)
- [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [Electron contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge)
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports)
- [Electron ASAR 限制](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [Electron process.resourcesPath](https://www.electronjs.org/docs/latest/api/process)
- [Electron 原生模块与 ABI](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [Node.js child_process](https://nodejs.org/api/child_process.html)
- [electron-builder 应用文件与 extraResources](https://www.electron.build/v26/docs/contents/)
- [electron-builder macOS 签名](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)
- [Electron Forge 构建生命周期](https://www.electronforge.io/core-concepts/build-lifecycle)
- [Windows taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
