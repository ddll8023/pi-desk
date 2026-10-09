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

### P3-02 Extension UI（已完成实现，决策记录）

**目标**：为官方 RPC 支持的 Extension 交互提供独立 GUI 适配层。

**范围**：对话请求与响应、取消、通知、状态、Widget、标题及编辑器文本。区分需要回应的对话与无需回应的通知，保留原始 request id，不让普通 pending RPC 表错误等待 Extension response。

只映射当前官方 RPC 子协议；不承诺任意 TUI 组件可在 Vue 无损运行，未知交互不得自动批准。

**已定决策**（细节见[开发总览](../development.md)第 6.2 节 Extension UI）：

- 去掉 `--no-extensions`，Extension 加载由 P3-01 的 Trust 拦截控制；Skills、Prompt Templates 与 MCP 仍关闭（P3-06 起改为交给 Pi 的加载规则，见下）。
- Dialog 类请求用模态对话框按队首依次展示，可取消；fire-and-forget 状态（notify/status/widget/编辑器填充）由主进程按代际持有并广播快照。
- `set_editor_text` 只在输入框为空时填充，不覆盖用户已输入内容；`setTitle` 无桌面等价物，不展示。
- 未知 method 与形状不符的请求只计数不报错；dialog 响应写回失败按管道关闭收敛，不重发。

**依赖**：第二阶段 IPC 与界面状态；项目级 Extension 加载依赖 P3-01。

### P3-03 Session 深化与 Compaction（已完成实现，决策记录）

**目标**：扩展已有 Session 恢复体验，支持 Fork 与上下文压缩操作。

**范围**：基于 Pi Session 的 Fork、恢复过程的取消与错误、Compaction 状态和结果展示；尊重官方 Session 生命周期及 Extension 取消结果。复用第二阶段的列表、读取和基础恢复，不另建历史模型。

**已定决策**（细节见[开发总览](../development.md)第 6.2 节 Session Fork 与手动压缩）：

- Fork 用官方 `get_fork_messages` / `fork` 命令接入；fork 后复用重启式切换链以新会话 id 重新启动 Runtime，信任拦截与中断确认全部复用会话打开链路。
- Extension 取消 fork 以专属错误码 `FORK_CANCELLED` 如实提示；运行中未确认时返回 `FORK_BLOCKED`，不中断操作。
- 手动压缩用 `compact` 命令同步等待（期限 120 秒）；成功展示前后 token 数，字段缺失按 null 展示；不做 `set_auto_compaction` 开关与 `clone`。
- 恢复过程的取消与错误由 P2-02 既有链路覆盖（历史读取超时按启动失败处理），本阶段未改。

**依赖**：第二阶段 Session 与 Context 控制；启用相关 Extension 时依赖 P3-02。

### P3-04 输入增强（已完成实现，决策记录）

**目标**：支持图片与文件引用参与对话。

**范围**：用户选择图片、模型能力提示、输入预览与移除、官方消息内容映射；明确文件引用是路径信息还是内容输入，不把 RPC 不支持的 `@file` 启动参数直接套进协议。限制读取范围与输入大小，避免无意上传敏感内容。

**已定决策**（细节见[开发总览](../development.md)第 6.2 节）：

- 只做图片附件：随 `prompt` 的官方 `images` 字段提交（`ImageContent` 格式）；主进程校验 MIME 白名单、单图编码后 4 MiB 与单条 4 张上限。
- 文件引用不做：RPC 模式官方拒绝 `@file` 参数；路径文本无特殊语义，读文件由 Pi 的 `read` 工具覆盖。
- 模型图片输入能力来自 Model 对象的 `input` 字段，投影为 `ModelSummary.imageInput`；明确不支持时禁用图片入口。
- CSP `img-src` 放开 `data:` 与 `blob:` 用于缩略图预览与消息内附件展示；远程图片依旧不渲染。恢复历史中的图片按同一规则投影展示。

**依赖**：第二阶段 Prompt 与模型控制。资源 loader 与图片所需配套文件沿用 Runtime 打包机制。

### P3-05 Diff 展示（已完成实现，决策记录）

**目标**：让 Edit / Write 的变更更易理解。

**范围**：确定可靠的变更来源和基线，呈现支持范围内的 Diff；处理重复修改、并发变更与无法取得基线的情况。未知变更不伪造 Diff，不为了展示自动撤销或重新应用工具修改。

**依赖**：第二阶段 Tool Card；不替代通用工具结果，不扩展为 Git GUI。

### P3-06 Pi 资源接入（已完成实现，决策记录）

**目标**：让 Desktop 发现、使用并展示 Pi 的 Skills、Extensions、Packages 与 MCP 能力。

**范围**：先核实官方发现、管理和重载能力，再决定 GUI 暴露范围；复用 Pi settings 与资源加载，不建立独立插件市场或平行 MCP 配置。准确展示资源归属、加载失败和外部依赖，涉及安装或可执行配置变更保留用户确认。

**已定决策**（事实与通道细节见[开发总览](../development.md)第 5.1、6.2、6.3 节）：

- 启用范围：去掉 `--no-skills`、`--no-prompt-templates`、`--no-mcp`，三类资源的加载交给 Pi 自己的规则与 Project Trust；`--no-extensions` 只用于安全模式启动。
- 发现与展示只读：只消费官方 `get_commands` 的投影（skill/prompt/extension 三类命令与其归属），不解析 Pi 的 settings / mcp / 包配置，不提供安装、卸载或写配置入口。
- MCP 状态经固定 `/mcp` 命令与 Extension UI 的 notify 捕获读取，期限与失败语义见开发总览第 6.2 节；不提供 `/mcp` 的登录与 enable/disable/exposure 写路径。
- 重载只走重启链：RPC 没有重载命令，`/reload` 是 TUI 内建命令；重载重启 Runtime 并保留当前会话，通道与守门见开发总览第 6.2 节。
- 加载失败的可见边界：扩展加载失败在非交互模式下致命（退出码 1），stderr 诊断尾部与 `extension_error` 进入资源面板；技能与提示词的加载警告 RPC 不提供，面板只展示已加载清单。
- 安全模式启动只接受零参数，固定传 `--no-extensions`（同时禁用内建扩展，含 `builtin:mcp`），仅本次生效，用于坏扩展导致 Runtime 无法启动时的应用内逃生。

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

- ~~目标 Pi 版本下 Extension UI 支持范围、取消与窗口关闭时的收敛行为~~ 已在 P3-02 确定：只映射官方 RPC 子协议的九个 method，取消即发送 `cancelled` 响应，状态随 Runtime 代际清空（见[开发总览](../development.md)第 6.2 节 Extension UI）。
- ~~Session Fork 与恢复操作的具体 GUI 入口~~ 已在 P3-03 确定：入口在 Runtime 详情弹层，fork 后复用重启式切换链，Extension 取消以 `FORK_CANCELLED` 如实提示（见[开发总览](../development.md)第 6.2 节 Session Fork）。
- ~~文件引用的数据语义、图片能力与敏感数据提示。~~ 已在 P3-04 确定：只做图片附件（官方 `images` 字段，MIME 白名单、单图 4 MiB、单条 4 张）；文件引用不做（RPC 拒绝 `@file`，路径文本无特殊语义）。
- ~~Diff 来源与基线维护策略。~~ 已在 P3-05 确定：只解析 Pi 结束结果的 `details.diff`，edit 参数 `edits[]` 仅作降级来源并标注，无可信来源时不伪造。
- ~~Packages / MCP 的外部程序依赖、重载与生命周期边界；不能假定 standalone 自动携带所有第三方运行环境。~~ 已在 P3-06 确定：不提供安装与写配置入口，外部依赖（如 `npx`、`uvx`）的失败经 `/mcp` 状态文本如实展示，重载只走 Runtime 重启，MCP 默认 exposure 会连带启用 `codemode` 并在界面披露（见[开发总览](../development.md)第 6.2 节）。
