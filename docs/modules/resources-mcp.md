# 资源与 MCP

模块 ID：`resources-mcp`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责技能、提示词模板和扩展命令的展示与补全，启动前资源／模型预读、会话启动诊断，MCP 配置文件列举、一次性连接探测及运行中会话的 MCP 登录／退出／重连。

入口为设置页“资源”和输入坞补全；MCP 服务器不是本应用的后端模块。资源预读、文件配置、独立探测与运行中会话状态是不同来源，不能合并成一份无来源的“连接状态”。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/resources/resource-preview.ts` | 一次性 CLI RPC 预读资源、可用模型及默认模型，缓存结果与分项错误 |
| `src/main/resources/pi-response-projection.ts` | CLI `get_commands`、`get_available_models`、`get_state` 的字段投影 |
| `src/main/resources/mcp-config-reader.ts` | 全局／项目 MCP 配置的受限读取、覆盖与生效说明 |
| `src/main/resources/mcp-inspection.ts` | 一次性 MCP 探测、超时和取消 |
| `src/entries/pi-cli/index.ts` | 用官方 SDK CLI 执行主进程固定参数的一次性入口 |
| `src/renderer/src/resources/stores/resource.ts` | 运行资源、预读技能、诊断、MCP 配置／探测／动作展示状态 |
| `src/renderer/src/resources/services/resource.ts` | 资源、预读、诊断和 MCP 的受限桥接 |
| `src/renderer/src/resources/components/ResourceView.vue` | 资源分组、详情、配置和 MCP 状态／动作入口 |

资源 Store、服务、CLI 入口及预读关联已读；配置解析和页面辅助片段结合静态调用映射。外部 MCP 配置内容与服务器实现不属于本仓库源码地图。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/resources/ipc.ts` 的 `registerResourceHandlers` 注册资源、预读、诊断和 MCP 固定通道及对应 preload 方法。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/shared/runtime-api.ts` 中 `PiResourcePreview`、资源、MCP 与诊断类型；Runtime Store 提供当前运行目标及模型预读消费者。
- [F-process](shared.md#f-process受管进程与-sdk-公共设施共享)：`pi-cli-process.ts` 启动固定 CLI 入口；`pi-paths.ts` 与运行时加载固定 SDK 来源；进程树终止用于探测取消。
- [项目与信任](projects-trust.md)：项目级配置是否生效取决于真实信任决定；当前项目与运行目标的所属项目要分别理解。
- [会话](sessions-chat.md)：运行中资源、诊断与 `/mcp` 命令通过 SDK 宿主获取；授权提示沿扩展 UI 链处理。
- [供应商](providers-auth.md)：模型选择器复用资源预读中的模型与默认身份，不另起一套模型来源。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：复制、按钮、清单与资源展示样式。

## 来源与调用链

| 来源 | 数据与执行边界 |
| --- | --- |
| 运行中的 SDK 会话 | 目标实例当前绑定已加载的技能、模板、扩展命令、诊断与 MCP 命令结果 |
| 启动前预读 | 主进程按项目或中立目录调用一次性 CLI；资源、模型及默认身份分别报告错误 |
| MCP 配置文件 | 只读全局与项目配置，不连接服务器；包含覆盖、生效与信任语义 |
| MCP 一次性探测 | 主进程固定 `mcp list --json`；另起连接，仅代表探测时刻，与会话连接不是同一实例 |

Store 按配置清单构建 MCP 列表，再按服务器名叠加探测结果；没有配置结果时可展示探测报告。登录／退出／重连由主进程把受限动作及合法服务器名转成运行中会话的固定命令。

## 状态与生命周期

资源与诊断跟随 Runtime 绑定，预读跟随项目与启动阶段，MCP 配置跟随项目；resource Store 的监听由 `src/renderer/src/shell/use-app-startup.ts` 初始化并释放。Store 保留各来源独立的读取和动作状态，资源与诊断读取还使用各自忙标记，不把不同来源的加载视为一个动作。

桌面资源读取与展示层不编辑 MCP 配置文件、不安装扩展，也不把预读当作会话已执行过扩展。MCP 登录／退出可能涉及 SDK 管理的认证状态，不等同于只读配置列举；网络、OAuth 及凭据持久化由实际调用的 SDK／服务器处理。改完配置后的运行资源重载由会话模块负责。页面不能传入任意 CLI 入口、参数或 MCP 命令文本。
