# 供应商与认证

模块 ID：`providers-auth`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责模型设置页里的供应商凭据、API Key／OAuth 登录退出、自定义 `models.json` 条目，以及默认模型、当前会话模型选择和对话页模型可见性。入口为设置页“模型”、登录流程条与聊天输入区模型选择器。

凭据、供应商定义、默认模型和桌面展示偏好是四类数据，页面按供应商聚合展示不代表它们共享存储。SDK 会话执行及资源重载由会话模块处理，SDK 安装由更新模块处理。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/providers/auth-manager.ts` | 认证状态、登录流程、提示回应、取消、退出与受控授权地址 |
| `src/main/providers/auth-helper-process.ts` | 认证辅助进程启动、JSONL 通信与关闭 |
| `src/auth-helper/index.ts` | 官方 ModelRuntime 认证适配、提示与敏感信息脱敏 |
| `src/auth-helper/protocol.ts` | 辅助进程请求、响应和事件帧 |
| `src/main/providers/models-config-manager.ts` | 自定义供应商快照、脱敏、单条保存／删除与并发基线 |
| `src/main/providers/pi-settings-manager.ts` | Pi 默认模型读取与定点写入 |
| `src/shared/auth-api.ts` | 页面认证状态、登录方法、提示、流程与错误契约 |
| `src/shared/models-config-api.ts` | 自定义供应商请求、快照与校验 |
| `src/shared/pi-settings-api.ts` | 默认模型读取／写入契约 |
| `src/renderer/src/providers/stores/auth.ts` | 认证状态、流程副本及临时输入 |
| `src/renderer/src/providers/stores/models-config.ts` | 供应商条目快照与编辑动作 |
| `src/renderer/src/providers/services/auth.ts` | 认证桥接、事件与错误细节 |
| `src/renderer/src/providers/services/models-config.ts` | 供应商定义桥接 |
| `src/renderer/src/providers/services/pi-settings.ts` | 默认模型桥接 |
| `src/renderer/src/providers/provider-status.ts` | 供应商配置／认证状态文案 |
| `src/renderer/src/providers/components/ModelSettingsView.vue` | 按供应商聚合清单、搜索、凭据、定义与可见性 |
| `src/renderer/src/providers/components/AuthFlowBanner.vue` | 登录流程、提示与资源重载入口 |
| `src/renderer/src/providers/components/ProviderListItem.vue` | 供应商清单行与展开区编排 |
| `src/renderer/src/providers/components/ProviderEntrySummary.vue` | 自定义条目摘要 |
| `src/renderer/src/providers/components/ProviderCredentialSection.vue` | 凭据配置及登录／退出入口 |
| `src/renderer/src/providers/components/ProviderDefinitionSection.vue` | 供应商定义与模型条目编辑 |
| `src/renderer/src/providers/components/ProviderVisibilitySection.vue` | 对话页模型展示开关 |
| `src/renderer/src/providers/components/ProviderEditorDialog.vue` | 自定义供应商新增／编辑弹层 |
| `src/renderer/src/providers/components/RuntimeModelSelect.vue` | 聊天模型候选、实际绑定会话模型与未绑定／新草稿默认模型选择 |

认证 Store、模型页编排、服务及辅助入口已读；子组件和配置管理的关联按调用与契约定位。登录方法和供应商支持范围来自运行期 SDK，不在本文固定枚举。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：认证、自定义模型与 Pi 默认模型 IPC、事件投递及对应 preload 方法。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`stores/runtime-models.ts` 的能力、模型切换、`loadPiDefaultModel`、`setPiDefaultModel`；`stores/runtime-model-display.ts` 的 `loadModelDisplay` 与可见性动作；`runtime.ts` 只做门面转发；`runtime-api.ts` 的模型身份与能力类型。
- [F-config](shared.md#f-configdesktop-配置混合)：模型隐藏项与安装级设备标识；不保存认证密钥。
- [F-platform](shared.md#f-platform文件锁外链与基础错误共享)：配置写锁、外链与基础错误。
- [F-process](shared.md#f-process受管进程与-sdk-公共设施共享)：固定 agent 目录、受管 SDK 加载与进程终止。
- [会话](sessions-chat.md)：切换当前模型与重新加载资源；登录成功不意味着已有会话自动加载新凭据。
- [偏好](preferences.md)：模型展示偏好的读写服务；[资源](resources-mcp.md)：启动前模型目录使用共享资源预读。

## 调用链与数据所有者

| 动作 | 路径 | 存储 |
| --- | --- | --- |
| 登录／退出 | 模型页 → auth Store／服务 → IPC → AuthManager → 辅助进程 → 官方 SDK | agent 目录 `auth.json`；页面只接收状态与提示 |
| 定义供应商 | 条目弹层 → models-config Store／服务 → IPC → ModelsConfigManager | agent 目录 `models.json`；按单个 provider 修改 |
| 默认模型 | 选择器 → Runtime Store → pi-settings 服务 → PiSettingsManager | agent 目录 `settings.json` 的默认模型字段 |
| 当前模型 | 选择器 → Runtime 命令 → 主进程 → 已绑定 SDK 会话 | 当前会话状态，不等同于写默认模型 |
| 显示／隐藏 | 供应商展开区 → Runtime Store → preferences 服务／管理器 | Desktop 配置的隐藏模型列表 |

## 生命周期与安全边界

模型设置页挂载时初始化认证与供应商快照，卸载时释放认证订阅。密钥和验证码输入只在认证交互窗口存在，不作为 Provider 状态快照回传；自定义配置中的真实密钥使用哨兵显示，保存由主进程按位置还原。

preload 与服务传递明确字段和普通对象，主进程决定辅助入口与授权地址。默认模型保存不修改当前会话；当前模型切换不隐式修改全局默认。选择器按当前对话的实际绑定状态决定操作目标：原位新草稿使用默认模型预读，不因旧 Runtime 仍就绪就操作旧会话；旧实例结束或新绑定尚在确认时禁用改选与手动刷新，当前模型切换反馈以实际运行状态为准。配置写入需要文件锁及已有基线，不通过第二个 Desktop 配置写入者绕过统一存储。
