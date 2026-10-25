# DeepSeek Harness（DSH）

返回[开源项目参考](README.md)。本文记录 DeepSeek 官方的 `deepseek-ai/deepseek-harness`，不是同名社区桌面包装项目，也不是 pi-desk 的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |
| 官网 | [DeepSeek Harness](https://deepseek.com/harness) |
| 文档 | [官方文档站](https://deepseek-harness.github.io/deepseek-harness/) |
| 定位 | 以“Everything is a Plugin”为原则组合模型、工具、会话、策略与界面的 Agent Harness |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `master` |
| 最新 Release | GitHub `releases/latest` 返回 404；未核实最新发布标签，不能据此断言没有预发布或其他渠道版本 |
| 桌面包清单版本 | `apps/desktop/package.json` 声明 `0.2.1-rc.3`；这是源码包版本，不冒充最新 Release |
| Star / Fork | 261,100 / 31,533 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 0，仓库 `has_issues` 为 false；不能解读为没有缺陷 |
| 分发形态 | npm CLI 与 Web UI；`headless`、`sdk`、`sdk-minimal`、`acp` Profile；Electron 桌面壳随包携带生产运行时 |

以上版本与统计核实于 **2026-10-25**，仅为快照，来源为[仓库 API][d-meta]、[Release API][d-release]和[桌面包声明][d-desktop]。桌面配置包含 macOS 与 Windows 打包入口；本次没有核实可下载的安装产物清单，不将构建脚本视为已发布产物。

## 许可证

[根 LICENSE][d-license] 为 MIT，版权方为 DeepSeek。允许使用、修改、分发及商业使用，分发副本或实质部分需保留版权与许可声明；软件按现状提供。

根许可未声明产品目录例外，仓库 API 的 MIT 识别与实际文本一致。[README][d-readme]另指向 `THIRD_PARTY_NOTICES.md`；本次没有逐项审计第三方依赖与 vendored 代码，不把根 MIT 扩展为全部第三方材料的统一许可。

**复用边界**：属于根 MIT 的代码可以在履行声明义务后复用；实际引入文件前仍需核对其文件头、第三方声明与依赖许可。产品名称、账号服务与远端模型服务不因代码许可而获得额外授权。

## 技术栈

| 运行层 | 组成与职责 |
| --- | --- |
| 核心运行时 | TypeScript / Node.js；Cordis 提供插件、服务、事件和可撤销注册，模型适配器、工具注册表、会话日志和 Agent Loop 均由插件承担 |
| 组合与配置 | Profile 叠加有序 Bundle，再应用用户 Patch；`sdk-minimal` 使用独立组合，不默认等同于完整 `dsh-base` |
| 会话与投影 | 追加式会话事件日志，JSONL 持久化；投影单元折叠事件形成界面视图，实时流与持久事实分开 |
| Web 与桌面 | Web 应用负责 RPC 与流；Electron 桌面壳启动本机 Host、加载打包的 Web 资源并接入运行时；桌面包声明 React 依赖 |
| 执行与安全 | 文件系统、子进程、沙箱和审批分别是插件能力；本地 Shell 栈按平台选择 Bash 或 PowerShell |

依据：[官方架构说明][d-arch]、[基础 Bundle][d-base]、[桌面包声明][d-desktop]。这里概括影响能力边界的组件，不复述内部模块架构。

## 能力清单

未以根 README 的产品描述充当完整功能表。下表按官方 **Profile** 与 **基础组合中的实际插件 ID** 记录已核实的入口；基础组合是配置清单，不表示每个内部插件都独立暴露为用户功能。

### 官方 Profile 与桌面入口

| 官方入口 | 能力与边界 |
| --- | --- |
| `web` | 工作区选择、模型配置、会话对话与按当前策略发起审批 |
| `headless` | 无 Web 服务的一次性任务入口 |
| `sdk` / `sdk-minimal` | 程序化会话接入；前者基于共享基础组合，后者显式采用精简独立组合 |
| `acp` | 面向自动化的 ACP 服务入口 |
| Desktop | Electron 承载同一 Web 产品及配套运行时，并拥有桌面专用 Profile |

### 基础组合中的能力入口

| 官方插件 ID / 入口 | 对应能力 |
| --- | --- |
| `tool-fs`、`tool-fs-search`、`tool-working-directory` | 文件读取／写入／精确编辑、文件检索及后续操作目录切换 |
| `tool-bash` / `tool-pwsh`、`tool-jobs` | 按平台执行 Shell 操作，查询和停止后台作业 |
| `tool-web` | Web 搜索与 HTTP(S) 抓取；抓取默认不逐次审批，且可访问回环及私网地址，不能理解成网络隔离沙箱 |
| `skill`、`skill-filesystem`、`tool-skill`、`commands` | Skill 发现与使用、人工命令入口 |
| `mcp-resources` | MCP 资源能力；具体服务器由客户端插件配置，无服务器时不展示相应 MCP 工具 |
| `tool-plugin-manager` | 管理插件组合；不是只展示已加载资源名称 |
| `tool-subagent`、`tool-subagent-fork`、`tool-subagent-control` | 新建或从父历史分叉子会话，发送消息及管理受托任务；启动返回子身份，最终结果由管理器交付 |
| `plan-mode`、`tool-todo`、`tool-goal`、`tool-workflow` | 计划模式、任务与目标跟踪、工作流执行入口；不据此推定存在 EvoFlow 式可视化业务画布 |
| `permission`、`approval`、`sandbox-policy`、`fs-sandbox` | 权限预设、审批、进程与文件写入策略；具体能力受平台和当前组合约束 |
| `command-compact`、`token-meter`、`session-persistence-jsonl` | 上下文压缩、用量计量、持久会话 |

依据：[基础 Bundle 的“what you get”][d-base]、[官方生成的组合清单][d-composition]、[工具契约][d-tools]、[子代理契约][d-subagent]。实验性 Agent Teams 在[架构说明][d-arch]中明确为 opt-in，不与默认子代理能力混为一谈。

## 与本项目的对照

基准为 pi-desk 当前内置实现；外部扩展可做什么不计入桌面产品的内置范围。DSH 侧以下机制来自官方文档和组合清单，不代表双方运行效果或实现质量已经对比。

### 实质重合

| 能力 | DSH 对应机制 | 与 pi-desk 的关键差异 |
| --- | --- | --- |
| 项目内 Agent 对话与持久历史 | 工作区会话、事件日志和流式展示 | pi-desk 由独立 SDK 宿主创建 Pi 会话并投影给 Vue；DSH 自有插件化 Agent Loop 和日志契约。见[会话模块][p-session]与 `SdkSessionRuntime` |
| 会话上下文压缩与用量展示 | `command-compact`、`token-meter` | pi-desk 转交 Pi SDK 压缩并映射 SDK 统计；DSH 将相应策略和计量作为组合项。重合的是用户目标，不是格式或策略实现相同 |
| Skill 与 MCP 参与会话 | Skill 插件和 MCP 客户端／资源插件 | pi-desk 展示 Pi 加载资源，MCP 配置、一次性探测和会话连接分源管理；DSH 的能力由当前 Profile 插件树决定。见[资源模块][p-resources] |

### 部分重合

| 能力 | 重叠环节 | 不可视作替代的原因 |
| --- | --- | --- |
| 插件与资源管理 | 都能让 Agent 获得扩展能力 | DSH 的模型、循环和界面都可参与插件组合；pi-desk 的资源页主要展示／诊断 Pi 资源，不是 Cordis 组合编辑器或插件市场 |
| 权限与项目安全 | 都有执行前的用户决策入口 | DSH 具有工具审批和沙箱策略；pi-desk `TrustManager` 管理项目资源信任，明确不提供 OS 沙箱或工具权限限制。扩展对话框也不等于所有工具都受审批 |
| 命令执行 | 都能在项目中执行 Shell | DSH 的 Agent Shell 工具与作业服务不等于桌面终端面板；pi-desk 的用户终端由独立 PTY 守护进程维护，与 Agent 会话分离。见[终端模块][p-terminal] |

### 对方独有

| 类别 | DSH 已公开能力 | pi-desk 当前边界 |
| --- | --- | --- |
| 子代理管理 | 受管父子关系、独立子会话、消息、续接与结果交付 | 内置子代理模块无；[现有文档][p-subdesign]是初步设计，不是已实现功能；多会话并行也不自动形成父子任务 |
| 目标与工作流 | `plan-mode`、`tool-goal`、`tool-workflow` | 内置模式与任务控制平面无；在聊天里写计划不等于具备这些运行语义 |
| Harness 组合入口 | Web、无界面、SDK、ACP 与多层 Profile 组合 | pi-desk 是 Pi SDK 桌面客户端，不提供等价的自有 Harness 分发体系 |

### 尚不能判定为“无对应”的项

pi-desk 有[声明式生成式界面][p-genui]、桌面文件编辑和常驻终端；本次没有核实 DSH 是否存在与这些输入、输出及目标完全一致的产品入口，**不将未确认项判成“DSH 没有”**。尤其工具卡 presenter 不自动等于可调参数文档产品。

**证据边界**：未逐项审读双方算法并做量化对比，因此不下“更快”“更安全”或输出质量更优的结论；权限机制的存在也不证明任何默认配置提供完整安全隔离。

## 可借鉴方向

这里只提出方向，不建议替换 Pi SDK 或把 Cordis 运行时直接嵌入 pi-desk。

| 方向 | 可行性 | 依据与依赖代价 |
| --- | --- | --- |
| 明确父子任务身份、活动归属与结果交付 | 低 | DSH 将执行、通知和子会话身份分开；pi-desk 有 SDK 宿主与投影基础，但仍需独立设计授权、取消、历史和 UI，不能以多开会话代替 |
| 区分信任、工具审批与执行隔离 | 低 | 现有 `TrustManager` 不是沙箱；新增能力需独立策略设计及平台执行后端，影响进程启动和分发，不是多加一个确认框 |
| 展示当前能力的来源与实际生效状态 | 高 | 现有资源页已区分预读、配置、探测和会话状态，可沿既有投影与 Vue 组件组织说明，无需引入 Cordis；不包含实现插件管理器 |
| 将工具参数、模型结果和界面载荷分开建模 | 高 | DSH 的工具契约区分模型 Schema 与宿主展示元数据；pi-desk 的生成式界面已采用正文摘要与 `details.ui` 分流，可在现有契约上延续，不必引入新框架 |

后两项为**设计推断**：判断依据是双方已有契约，未量化开发耗时或运行收益。DSH 的整套插件组合与 pi-desk 的 SDK 客户端定位不同，不因可扩展就建议整体照搬。

## 信息来源

### 对方官方资料

- [根 README][d-readme]、[Web UI 指南][d-guide]：定位、工作区和模型入口。
- [架构说明][d-arch]：Profile、插件、会话、桌面与实验性团队的边界。
- [基础 Bundle][d-base]、[组合清单][d-composition]：工具和策略的实际组合入口；不是按营销文案穷举功能。
- [工具契约][d-tools]、[子代理契约][d-subagent]：工具展示和父子任务语义。
- [桌面包声明][d-desktop]、[根 LICENSE][d-license]。
- [仓库 API][d-meta]、[最新 Release API][d-release]：2026-10-25 快照。

### 本项目事实出处

- [会话模块][p-session]、[`src/sdk-host/session-runtime.ts`](../../src/sdk-host/session-runtime.ts)：`SdkSessionRuntime`、`createAgentSessionServices`、`createAgentSessionRuntime` 及内置扩展工厂装配。
- [资源模块][p-resources]、[终端模块][p-terminal]、[子代理初步设计][p-subdesign]。
- [`src/main/trust/trust-manager.ts`](../../src/main/trust/trust-manager.ts)：`TrustManager` 的职责及沙箱排除边界。
- [生成式界面模块][p-genui]、[`src/sdk-host/genui/tools.ts`](../../src/sdk-host/genui/tools.ts)：`GenuiToolDetails` 与模型摘要／界面载荷分离。
- [`package.json`](../../package.json)：现有 Electron、Vue、Pi SDK 和终端依赖。

[d-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md
[d-guide]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md
[d-arch]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
[d-base]: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/README.md
[d-composition]: https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/composition.md
[d-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md
[d-subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md
[d-desktop]: https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/package.json
[d-license]: https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE
[d-meta]: https://api.github.com/repos/deepseek-ai/deepseek-harness
[d-release]: https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/latest
[p-session]: ../modules/sessions-chat.md
[p-resources]: ../modules/resources-mcp.md
[p-terminal]: ../modules/terminal-commands.md
[p-genui]: ../modules/genui.md
[p-subdesign]: ../subagents-design.md
