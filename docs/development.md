# Pi Desktop 开发文档

## 1. 目标与约束

构建面向 Windows 和 macOS 的 Pi Coding Agent 桌面客户端。第一版是可用的 Agent GUI，不是 IDE 或 VS Code 替代品。

确定使用：

- 桌面平台：Tauri 2。
- 前端：Vue 3、TypeScript、Vite、Tailwind CSS、Pinia。
- Agent Runtime：官方 Pi standalone binary，以独立 sidecar 进程运行。
- 通信：Rust 与 Pi 通过 stdin/stdout 交换 JSONL；Vue 通过 Tauri command/event 与 Rust 通信。

不重新实现 Agent Core，不以 fork Pi 为主要开发方式，不以 Node.js SDK 直接嵌入为主方案。安装后的应用携带匹配平台的 Pi Runtime，不要求用户预装 Node.js、npm、Bun 或 Pi CLI。

本文记录当前架构、官方调查结论、阶段范围和待解决问题，不作为安装、构建、启动、运行检查或扩大开发范围的授权。外部事实以引用版本为准；实现时核实实际依赖，不能将源码分析推定为实际运行结果。

## 2. 架构与职责

```text
Vue 3 Desktop UI
        │ Tauri command / event
        ▼
Tauri Rust Core
        │ stdin / stdout · JSONL RPC
        ▼
Pi standalone binary
        ▼
Pi Agent Runtime
```

### Vue

负责界面、用户输入、消息展示、交互状态和 Desktop UI 偏好。不得直接启动 Pi，不得直接调用 shell plugin 管理进程。

Pinia 保存当前 WebView 所需的状态，不承担 Agent Runtime 生命周期，也不建立平行聊天历史数据库。

### Rust

负责 Pi 进程管理、工作目录、管道 I/O、协议解析、请求关联、事件转发、异常退出和资源释放。对来自 Vue 的参数重新校验，不接受任意可执行文件路径、启动参数或 shell 命令作为通用进程控制接口。

### Pi

继续拥有 Agent 行为、Session、消息持久化、模型与认证配置、Skills、Extensions、Packages、MCP、Compaction、Context 和项目资源加载。

Desktop 仅维护自己的数据：最近项目、窗口尺寸、Sidebar 状态、主题和 Desktop 特有设置。轻量本地配置即可，不为这些信息提前引入数据库。

## 3. 当前项目与环境

项目根目录：`/Users/mima1234/Desktop/code/pi-desk`。

项目从空目录开始，没有既有 `package.json`、Cargo 配置、Tauri 配置、组件、Store 或脚本可复用。业务代码和依赖版本尚未建立。

已确认的本机环境：

| 项目 | 状态 |
| --- | --- |
| 系统与架构 | macOS、Apple Silicon / arm64 |
| Node.js、npm、Git | PATH 中存在 |
| Xcode Command Line Tools | 已发现安装目录 |
| Rust、Cargo、rustup | PATH 中未发现，常规 `~/.cargo`、`~/.rustup` 目录不存在 |
| Bun | PATH 中未发现 |
| 本机 Pi npm 包 | `@earendil-works/pi-coding-agent`，版本 `1.0.4` |

存在工具路径不等于版本和开发功能已经确认。Rust 工具链是本机 Tauri 开发的环境阻塞；准备环境须另行明确授权。Bun 不阻塞使用官方 standalone 发布包。

## 4. Pi binary 与 Tauri 打包事实

### 4.1 固定基线与获取方式

官方发布资产调查基线为 Pi `1.0.4`，对应 tag `v1.0.4`，源码 commit：

```text
7c10bd4337495ee613f2224843ecdf349b80d1df
```

第一阶段以该版本为固定集成基线。升级必须显式进行，不在运行时自动获取 latest，不自动调用 Pi 自更新来替换应用携带的 Runtime。

官方已经提供 Bun compile 生成的 standalone 发布包，优先直接获取，无须自行编译 Pi：

| 平台 | 官方发布包 | Tauri externalBin 构建输入名 |
| --- | --- | --- |
| macOS Apple Silicon | `pi-darwin-arm64.tar.gz` | `pi-aarch64-apple-darwin` |
| macOS Intel | `pi-darwin-x64.tar.gz` | `pi-x86_64-apple-darwin` |
| Windows x64 | `pi-windows-x64.zip` | `pi-x86_64-pc-windows-msvc.exe` |

下载地址使用固定版本：

```text
https://github.com/earendil-works/pi/releases/download/v1.0.4/<发布包名>
```

官方提供 `SHA256SUMS`，发布 API 也提供资产摘要。准备 binary 的脚本需要固定版本、目标平台映射和预期 SHA-256，校验归档后再解压、重命名；不能把执行 `pi --version` 当作完整性或协议兼容性的唯一依据。

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

需要保留官方配套资源，并按实际使用能力处理路径。macOS 的 executable 与 Resources 目录分离，不能直接假定资源放入 Resources 后所有 loader 都能找到。第一阶段解决启动链所需布局；正式安装包的完整资源落点在相应开发步骤确定，不提前承诺一个未经核实的布局。

### 4.3 Tauri 2 命名与调用

配置中的 `externalBin` 使用无 target 后缀、无 `.exe` 的基础路径：

```json
{
  "bundle": {
    "externalBin": ["binaries/pi"]
  }
}
```

路径相对于 `src-tauri/tauri.conf.json`。对应构建输入放在 `src-tauri/binaries/`，使用上表中的文件名。按实际构建 target 选择文件，不将开发机 host 架构误用为交叉构建 target。

Tauri 构建会移除可执行文件名中的 target 后缀。Rust 官方调用形式为：

```rust
app.shell().sidecar("pi")
```

这里传文件名，不传 `binaries/pi` 或带 target 的完整文件名。JavaScript sidecar API 的参数约定不同，本项目不使用它控制 Pi。

## 5. RPC 官方协议事实

### 5.1 启动与通道

官方最小启动命令：

```sh
pi --mode rpc --no-session
```

Rust 设置 `cwd` 为用户选择的项目根目录，并分别建立 stdin、stdout、stderr 管道。不启动 HTTP 或 localhost TCP RPC 服务，不将协议暴露到网络。

`--no-session` 表示内存 Session，仅用于第一阶段的临时 Runtime 页面。正式 Desktop 继续使用 Pi 自己的持久化 Session。

RPC 启动并不自动发送 ready 事件，也不输出 JSON mode 的 Session header；使用 `get_state` 的成功响应确认协议可用，不依赖固定等待。

Pi CLI 在非交互模式下未能选出模型时会退出。真实 prompt 需要有效模型凭据；第一阶段复用现有 Pi 配置、认证或 provider 环境变量，不开发 Authentication UI，不把密钥放进 Vue 或命令行参数。

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

前端最小重建规则：

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
Tauri → Pi RPC sidecar → prompt → streaming → tool → abort
```

只允许一个活动项目、一个 Pi Runtime；Runtime 在多次 prompt 之间驻留。切换目录时结束旧 Runtime，再启动新 Runtime，不通过改变 Desktop 状态假装子进程 cwd 已切换。

Runtime 与 Session 不是同一个对象；正式版本的一个 Project 可以有多个 Pi Session，但第一阶段不实现 Session 管理界面。

### 6.2 Rust 管理策略

推荐由 Rust-only shell plugin 解析 sidecar Command，再通过其公开转换得到 `std::process::Command`，交给 Tokio 异步进程管理。

当前 shell plugin 源码提供该转换。直接使用插件 `CommandChild` 时，stdin 写入是同步操作，且没有独立关闭 stdin 的公开方法；转换后便于异步读写、关闭输入、等待退出和强制终止。

此方式仍启动 Tauri 携带的独立 sidecar，不改为 SDK 嵌入。实际插件版本在实现时核实并锁定，不依赖浮动分支作为构建输入。

最初保持三类职责，不机械拆出大量空模块：

| 职责 | 负责内容 |
| --- | --- |
| Manager | 唯一 Runtime、状态转换、请求关联、对外操作、退出编排 |
| Process | 固定 sidecar、cwd、三个管道、进程等待与回收 |
| Protocol | 本阶段请求、response 校验、JSONL framing、事件分类 |

关键管理规则：

- stdout、stderr 分别持续读取，不因 Vue 等待某个请求而暂停读取。
- stdin 由单一 writer 串行写入完整记录；串行写入不等于必须等待前一个 response 才处理下一个请求。
- 使用 pending request 表与各类期限；超时结束等待不等于 Pi 没有执行，不自动重发 prompt。
- 不持全局锁等待 RPC response；尤其不能让等待 prompt 完成阻塞 abort。
- 进程退出、写入失败和初始化失败时清理 pending 请求与已创建资源。
- 解析错误行产生明确诊断，不伪造 Pi 事件；按 LF 恢复下一条记录，对超长、持续异常输出设边界，避免无限缓存。
- 对有效但暂不支持的事件分类保留，不因未知事件名直接崩溃。
- Rust 向目标窗口转发事件，Vue 在启动和发送 prompt 前完成订阅，并负责释放监听。
- Desktop 的 Runtime 标识、事件序号等桥接元数据放在自己的 envelope 中，不添加到 Pi 原始记录冒充官方字段。
- 旧 Runtime 的异步结果不得覆盖新 Runtime 状态。
- 正常退出停止新请求、abort、关闭 stdin、继续消费管道并等待退出；超时再终止和回收。
- 自行拥有进程清理责任，不能依赖 shell plugin 自动回收 Rust 直接启动的子进程。
- 异常退出后显示原因，由用户显式重新启动，不自动重放 prompt。

应用强制终止、系统终止及工具派生进程的清理不能仅靠常规退出回调保证。第一阶段实现正常关闭与退出兜底；不宣称已有完整崩溃恢复或 OS 沙箱。

### 6.3 最小前端

使用一个简洁 Runtime 页面，提供：

- 项目目录输入。
- 启动、关闭 Runtime。
- 就绪、运行、停止中、异常退出等状态。
- Prompt 输入、发送、Stop。
- 实时文本与 Thinking。
- 简单结构化工具参数、输出和错误。
- 有界的临时诊断展示。

组件通过统一 Tauri 服务入口调用 Rust，Pinia 管理本页面共享的 Runtime 状态。不安装 shell JavaScript guest binding，不提供任意 RPC JSON 的通用发送入口。

### 6.4 实现顺序

具体任务与依赖见[第一阶段：Runtime](phases/01-runtime.md)。

**第一小步：启动链。** 建立最小 Tauri/Vue 骨架与固定 binary 准备流程；启动 Pi RPC、通过 `get_state` 取得状态、消费 stderr、处理退出与关闭。

**第二小步：交互链。** 增加 prompt、消息增量重建、工具事件展示和 abort，不跨入第二阶段完整 Desktop UI。

具体源文件、依赖版本、资源落点和操作清单在对应小步确定；本文不授权一次性生成完整项目。

## 7. 安全、Trust 与平台边界

### 7.1 权限不是沙箱

- Vue 不直接 spawn Pi，不拥有通用 shell 或全域文件权限。
- Rust 只暴露本阶段需要的 Tauri command；自定义 command 也需要自身参数和窗口边界校验，不能假定未列入 capability 就自然禁止调用。
- 不授予 `shell:allow-execute`、`shell:allow-spawn` 或 `fs:allow-all` 来简化前端实现。
- 不向网络开放 Pi RPC。
- 不把密钥、认证文件、全部环境变量或完整敏感工具输出写入常规日志。
- 不将模型输出作为可执行 HTML 加载到有本地权限的 WebView。

**Pi 默认以启动用户的 OS 权限运行，不会逐次确认所有工具调用。** cwd 只是默认工作目录，不是文件访问沙箱；Tauri capability 也不会自动约束 Pi 的 OS 权限。产品不能把项目目录权限最小化宣传为已经具有沙箱隔离。

### 7.2 Project Trust

官方 `--approve` 与 `--no-approve` 是本次进程的项目信任覆盖，不等于写入持久信任决定。

RPC 无法展示 Pi 内建的 TUI trust prompt。没有显式覆盖、Extension 决定或已保存决定时，`defaultProjectTrust` 的 `always` 会加载项目资源，`ask` / `never` 会跳过。

第一阶段显式采用 `--no-approve`，并关闭 Extensions、Skills、Prompt Templates、MCP；避免依赖全局 trust 默认值，不自动信任项目，不直接修改 `trust.json`。

Trust 不完全覆盖启动行为：官方代码在 trust 决定前会读取项目 `sessionDir`；AGENTS/CLAUDE 上下文文件也不因拒绝 trust 自动禁用。关闭项目资源加载不等于内容安全或工具权限受限。

后续 Project Trust UI 在 Pi 启动前取得用户决定，通过正式 CLI 参数传递；持久决定的方式在第三阶段另行核实。Extension 对话在未支持时不能被自动肯定；第一阶段直接不启用 Extensions。

### 7.3 Windows Shell

Pi 1.0.4 已提供官方 `powershell` 工具：

- Windows：优先 `read,powershell,edit,write`。
- macOS：使用 `read,bash,edit,write`。

工具集合由启动参数显式选择，不修改用户全局 `defaultTools`。当前官方默认工具仍包含 Bash，并未按 Windows 自动替换成 PowerShell。

PowerShell 解析优先 `pwsh.exe`，其次 `powershell.exe`；不存在时报告明确错误，不强制用户安装 Git for Windows。启用 Git Bash 留待明确需求，不能假设 Windows 存在 Bash。

## 8. 后续阶段与不做项

| 阶段 | 目标与范围 |
| --- | --- |
| [第一阶段：Runtime](phases/01-runtime.md) | 当前文档第 6 节定义的启动链和交互链 |
| [第二阶段：基础 Desktop UI](phases/02-desktop-ui.md) | Project、Pi Session 列表与恢复入口、Chat、Streaming、通用 Tool Card、模型、Thinking Level、Stop、Context Usage |
| [第三阶段：Pi 深度能力](phases/03-pi-capabilities.md) | Extension UI、正式 Project Trust、完善 Session 恢复与 Fork、Compaction、Diff、图片、文件引用、Skills、Extensions、Packages、MCP |
| [第四阶段：Authentication](phases/04-authentication.md) | Provider、API Key、OAuth、Login/Logout、状态；仅在必要时增加复用官方认证实现的 standalone Helper |
| [第五阶段：Desktop 产品能力](phases/05-desktop-features.md) | Auto Update、Crash Recovery、Recent Projects 完善、快捷键、托盘、通知、多窗口 |

Project 的基础属性为 `id`、`name`、`path`、`lastOpenedAt`。采用轻量配置存储；Session 和消息仍交给 Pi，不创建平行数据模型与数据库。

当前 RPC command union 有 `new_session`、`switch_session`、`get_messages`、`fork` 等能力，但没有 Session 列表命令；第二阶段需单独确定官方 Session 列表能力的接入方式，不能自行假设存在 `list_sessions`。

当前 Extension UI wire 使用独立 `extension_ui_request` / `extension_ui_response`，设置编辑器文本的 method 为 `set_editor_text`。RPC 不支持任意 TUI 组件，未来兼容范围以官方支持的子协议为边界，不承诺所有 TUI Extension 无损运行。

第一阶段明确不做：完整 Sidebar、Project 持久化、Session 列表、Authentication、Extension UI、Git GUI、Terminal、文件管理器、插件市场、复杂工作流、多 Agent 和任务编排。不得为这些范围提前增加空抽象或依赖。

## 9. 待解决问题

1. Rust 工具链的环境准备与授权。
2. 第一小步的准确源文件清单、前后端依赖锁定与 package manager 约定。
3. Pi 配套资源在开发环境及 Windows/macOS 安装包中的布局；`PI_PACKAGE_DIR` 与 executable 邻接 loader 分别处理。
4. 启动参数、已有模型配置和凭据的可用性；只读取必要配置，不输出秘密。
5. 正常退出兜底与派生进程清理的实际平台机制；不以关闭主 Pi 进程等同于完整进程树回收。
6. 第二阶段 Session 列表的接入方式，以及跨项目 Session 切换对 cwd 与资源重建的影响。

这些问题按相应阶段解决，不把后续完整能力变成第一阶段的提前实现范围。

## 10. 官方依据

Pi 事实以固定 `v1.0.4` 为引用基线；Tauri 引用为官方 Tauri 2 文档及源码，实际 crate 版本在创建项目时确认。

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
- [Tauri 2 externalBin / sidecar](https://v2.tauri.app/develop/sidecar/)
- [Tauri shell process API](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/process/mod.rs)
- [Tauri shell plugin 生命周期](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/shell/src/lib.rs)
- [Tauri externalBin 构建处理](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-build/src/lib.rs)
