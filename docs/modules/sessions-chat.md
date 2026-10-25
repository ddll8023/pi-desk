# 会话与聊天

模块 ID：`sessions-chat`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责按项目读取会话列表、打开／新建／重载／删除会话、按会话读取历史（页、轮次与原文续段），监督 SDK 宿主、维护运行身份与占用，发送与中止、回退、压缩，投影聊天／工具／历史／活动与用量，以及 SDK 扩展对话框、通知和 widget。

入口为侧栏、顶部栏的对话跳转入口、输入坞、聊天消息动作和资源重载。文件编辑器、终端、MCP 配置与供应商持久化属于其他模块；会话内 Agent 自己读写项目文件也不等于桌面文件编辑接口。

## 专属文件

### 主进程与宿主

| 文件 | 用途 |
| --- | --- |
| `src/main/sessions/session-manager.ts` | 列表、打开、重载、删除与 SDK 目标授权编排 |
| `src/main/sessions/session-store.ts` | 项目会话目录、受限列表窗口与摘要缓存、文件定位与删除 |
| `src/main/sessions/session-run-registry.ts` | 运行 ID、绑定代际、前台顺序及会话占用的唯一登记 |
| `src/main/sessions/log-host-pool.ts` | 只读解析宿主池：按项目保活查看历史用的宿主进程，不登记运行实例、不占用会话，可被绑定接管 |
| `src/main/sessions/sdk-runtime-bridge.ts` | 多实例运行选择、请求分发、状态与宿主生命周期适配 |
| `src/main/sessions/sdk-host-manager.ts` | utilityProcess 启动、协议请求、超时、身份和退出监督 |
| `src/main/sessions/extension-ui-manager.ts` | 扩展 UI 投影、等待与回应管理 |
| `src/main/sessions/prompt-input.ts` | Prompt 与图片附件边界处理 |
| `src/main/sessions/ipc.ts` | 会话列表、打开、重载、删除、按会话读取历史，以及运行清单查询、释放与结束的通道注册 |
| `src/main/sessions/runtime-ipc.ts` | 执行主链通道注册：状态、中止、回退、模型、压缩、Prompt、投影快照与确认 |
| `src/main/sessions/extension-ui-ipc.ts` | 扩展交互通道注册：对话、通知与 widget 快照读取及应答提交 |
| `src/sdk-host/index.ts` | 宿主入口、初始化、授权回应与控制／生命周期分派 |
| `src/sdk-host/protocol.ts` | 主进程和 SDK 宿主的版本化消息、请求与目标校验 |
| `src/sdk-host/session-runtime.ts` | 官方 SDK 会话、运行请求、订阅、回退／压缩及内置扩展装配 |
| `src/sdk-host/log-reader.ts` | 日志读取：把已授权的会话文件按查询解析成历史页、轮次页或原文续段，不建会话、不加载扩展与 MCP；按文件版本有界复用多个会话的解析结果，并把最新首页写入检查点 |
| `src/sdk-host/extension-ui-bridge.ts` | SDK UI 回调到宿主消息的适配及取消 |

### 会话投影与契约

| 文件 | 用途 |
| --- | --- |
| `src/sdk-host/projection/message-projection.ts` | 有界消息／工具聚合、序号、批次与确认 |
| `src/sdk-host/projection/tool-projection.ts` | 工具生命周期、参数／结果摘要与生成式界面载荷接入 |
| `src/sdk-host/projection/history-projection.ts` | 当前分支按轮历史与原文续段 |
| `src/sdk-host/projection/activity-projection.ts` | 从官方分支累计稳定活动事实，以实时工具状态补充展示，支持检查点恢复与连续追加复用 |
| `src/sdk-host/projection/identity.ts` | 用户消息规范化摘要身份；不替代官方回退条目 ID |
| `src/sdk-host/projection/output-rate.ts` | 模型输出速率计算 |
| `src/sdk-host/projection/checkpoint.ts` | 首页与稳定活动的独立内存检查点：绑定时分别核对恢复条件，命中不替代 SDK 打开会话文件 |
| `src/shared/session-api.ts` | 会话列表、打开、重载、删除与按会话读取历史的页面契约 |
| `src/shared/session-run-api.ts` | 应用级运行清单、释放／结束与事件契约 |
| `src/shared/extension-ui-api.ts` | 扩展对话、通知、widget 与回应形态 |
| `src/shared/user-message-text.ts` | 用户消息里的技能块与图片标记处理，供摘要和展示共用 |

### 前端状态与服务

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/sessions/stores/session.ts` | 按项目的列表窗口与读取调度、串行打开／重载、按标签意图提交打开、删除与待确认目标 |
| `src/renderer/src/sessions/stores/session-runs.ts` | 运行清单、副本状态、释放与结束 |
| `src/renderer/src/sessions/stores/session-view.ts` | 会话输入、阅读与展开状态，原位新草稿的独立留底及附件回收 |
| `src/renderer/src/sessions/stores/chat-navigation.ts` | 对话内跳转登记：按会话键发布轮次入口与当前轮，并转交一次性跳转意图 |
| `src/renderer/src/sessions/stores/extension-ui.ts` | 运行目标的扩展对话、通知、widget 展示副本 |
| `src/renderer/src/sessions/services/session.ts` | 会话请求桥接 |
| `src/renderer/src/sessions/services/session-runs.ts` | 运行清单与生命周期桥接 |
| `src/renderer/src/sessions/services/runtime.ts` | Runtime 状态、Prompt、回退、压缩、模型命令与投影桥接 |
| `src/renderer/src/sessions/services/extension-ui.ts` | 扩展快照订阅与对话回应桥接 |
| `src/renderer/src/sessions/chat-view.ts` | 将消息与工具投影组织为聊天展示模型 |
| `src/renderer/src/sessions/clock.ts` | 聊天生成／工具计时与显示时钟 |
| `src/renderer/src/sessions/usage-format.ts` | token、费用及用量展示格式 |
| `src/renderer/src/sessions/tool-summary.ts` | 工具卡展示推导：参数摘要、路径相对化、改动量与结果预览 |
| `src/renderer/src/sessions/extension-dialog-presentation.ts` | 扩展提示、选择及对话展示转换 |

### 界面

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/sessions/components/PromptComposer.vue` | 输入、附件、文件树拖入引用、命令、补全与提交编排 |
| `src/renderer/src/sessions/components/ChatMessageList.vue` | 消息列表、历史加载、滚动与布局观察；向顶部栏发布对话跳转入口并执行跳转 |
| `src/renderer/src/sessions/components/ChatTurnItem.vue` | 按轮摘要、展开与原文内容 |
| `src/renderer/src/sessions/components/ChatMessageItem.vue` | 单消息、思考、工具归组面板与生成式界面分发 |
| `src/renderer/src/sessions/components/HistoryLoadSentinel.vue` | 历史加载触发哨兵 |
| `src/renderer/src/sessions/components/ToolCard.vue` | 工具卡：摘要行、变更 Diff、参数与结果二级折叠 |
| `src/renderer/src/sessions/components/UsageDetailDialog.vue` | 用量明细 |
| `src/renderer/src/sessions/components/SessionActivityBar.vue` | 会话活动摘要和明细 |
| `src/renderer/src/sessions/components/ExtensionDialog.vue` | SDK 扩展交互队列的当前对话 |
| `src/renderer/src/sessions/components/ExtensionNotificationBar.vue` | 扩展通知展示 |

核心打开链、Store、宿主入口及投影职责已由源码读取；投影辅助实现与界面文件结合导入、模板和接口调用映射，不将本表视作逐函数质量结论。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/sessions/ipc.ts` 的 `registerSessionHandlers`、`src/main/sessions/runtime-ipc.ts` 的 `registerRuntimeHandlers`、`src/main/sessions/extension-ui-ipc.ts` 的 `registerExtensionUiHandlers`、广播，`src/main/app-lifecycle.ts` 的生命周期及 `src/renderer/src/shell/components/AppDialogHost.vue` 的确认弹层。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/renderer/src/sessions/stores/runtime-core.ts` 持有展示状态与投影分片，`src/renderer/src/sessions/stores/runtime-history.ts` 持有历史缓存，`src/renderer/src/sessions/stores/runtime.ts` 为装配门面；`src/shared/runtime-api.ts` 提供综合契约。
- [F-sidebar](shared.md#f-sidebar项目会话树混合)：项目树中的会话与运行状态。
- [F-process](shared.md#f-process受管进程与-sdk-公共设施共享)：SDK 定位、固定环境与进程终止。SDK 动态加载不代表宿主可自行选择任意授权目录。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：Markdown、数学、复制、浮层和聊天样式。
- [项目与信任](projects-trust.md)：登记项目与目标授权；[工作区](workspace-tabs.md)：原标签绑定、选择与关闭；两者不拥有 SDK 分配权。
- [供应商](providers-auth.md)：`RuntimeModelSelect.vue` 提供模型选择，持久默认模型不等于当前会话模型。
- [文件](files-editor.md)：`project-file` Store 提供 `@` 文件候选；[资源](resources-mcp.md) 提供技能和命令补全；[偏好](preferences.md) 提供快捷输入。
- [生成式界面](genui.md)：宿主注册内置扩展，工具投影识别其载荷，消息组件分发到专用渲染器。

## 关键调用链

1. 页面表达打开意图：标签 Store 计算 `ChatOpenIntent`，`session` Store 固定项目与标签并串行提交；选择本身立即落到标签，不等打开动作整体收尾。打开已有会话前先按会话读取首页历史并显示出来，未绑定时可继续翻页、展开轮次与续段；历史读取不排队，失败即降级。页面只给项目与会话，由主进程判定该会话当前走绑定路径还是日志解析。
2. 主进程校验登记项目与信任，注册表管理占用，Runtime 桥决定复用、切前台或建立宿主；前台选择按主进程分配的序号收敛，先提交后完成的旧选择不会把前台改回旧目标。项目成为当前项目时预热只读池中的一个解析宿主，供查看历史与随后的绑定共用。
3. 宿主请求会话目标准备，主进程按来源实例的归属项目复核目标，再返回绑定代际与目录；宿主不能自行编号授权。
4. 输入坞经 Runtime 服务提交固定目标和附件；SDK 事件转换成消息、工具与活动投影，主进程广播到可信页面。
5. 页面校验代际／序号并应用增量；切回已缓存的实例时直接复用分片与模型清单，仅在换代、缺基准、序号断档或宿主失效时取快照；同一绑定的快照水位不倒退；早期历史和超长正文按会话读取当前分支，不接受任意文件路径，分支已变时按权威基准重建一次。
6. 回退基于官方条目身份建立新分支；压缩由 SDK 处理。成功请求和最终展示收敛不是同一个时点。
7. 删除会话先按登记占用结束或释放实例，再删除受限会话文件并刷新列表。关闭标签保留历史，与删除不同。

## 状态与边界

运行注册表是运行身份、绑定代际和占用真源；SDK 持有会话及历史；renderer 保存展示副本、后台投影留底与有限历史缓存。会话列表按项目取有界窗口，不能当作完整运行清单；列表由项目切换、删除、回退与新增会话落盘后的补读维护，打开与重载不回传列表，切换链不等目录扫描，列表读取失败也不回退已完成的切换。

列表每次仍扫描目录与文件元数据，保持文件 mtime 排序；窗口内的摘要按文件版本有界缓存，同版本的在途读取共用任务，读取前后复核文件身份，瞬时读取失败不缓存为无效摘要。页面按项目合并读取：强制刷新安排后置补读，旧响应不覆盖更晚的刷新或删除结果，删除回传的窄窗口不收起已展开列表，而是补读所需窗口。

已有会话的聊天面板在活动标签与前台身份一致时显示，或在该标签有该会话的日志历史时显示：身份已匹配就先展示缓存内容，输入、回退与压缩另按交互状态门禁，不拿打开动作的收尾当可见条件。原位新草稿使用独立空态与输入身份，不以旧 Runtime 的就绪状态决定展示或发送目标；新建、失败恢复与首次发送流程见[工作区标签](workspace-tabs.md#关键流程)。

历史读取按会话寻址：页面只给项目与会话，已由运行实例接管时由绑定路径读权威分支，未接管时由日志解析作答；两条路径返回同一套条目身份，缓存合并规则不区分来源。日志路径是展示副本，覆盖历史页、轮次页与原文续段，因此未绑定的会话也能查看与翻页；但在会话真正绑定前不能发送、回退或压缩。绑定到同一个会话时日志展示不提前清空：先取一次权威基准，应用成功后才交还展示位，交接中间不出现空白。日志读取失败、结果不属于请求目标或被更晚的选择取代时一律不写入，界面退回原来的等待呈现；文件戳在读取前后各复核一次，读取期间被改写按目标失效处理。

两条路径的「这一页已经过期」（绑定代际变化、日志文件被改写或游标不再属于当前分支）在会话编排层统一归成 `HISTORY_STALE`，页面据此按权威基准重建一次，而不是当成项目未登记或宿主未就绪报错；其余失败仍按原分类上报。

查看历史仍要有一个宿主进程承担解析。只读宿主池按项目保活这样的进程：它不承载会话、不登记运行实例、不进入页面运行清单，也不参与项目移除的活动判定。日志读取优先复用该会话仍可用的原服务宿主，再借同项目执行宿主，没有才用池中宿主；只有宿主失效才重选一次，文件版本、游标与解析错误不盲目重试。池中宿主在绑定时按原对象接管，接上运行身份与授权回路，进程内缓存无需搬运；读取不新增执行占用，也不因此改为共享多会话执行宿主或默认常驻。

历史读取由池租约或管理器读取计数保护，在途读取不被自动回收；读取结束后按宿主当前归属重新安排回收。池内空闲计时从最后一次读取结束起算，确认回收后才移出登记，关闭未确认时保留监督并禁止借用或接管。显式关闭与应用退出不受读取保护阻挡。

日志解析结果在宿主内按项目、会话、规范文件与文件版本有界复用，同版本并发共用解析，不保留原始日志文本。首页与稳定活动检查点彼此独立，也不落盘或跨进程传递：首页按文件戳与分支尾匹配；稳定活动从官方分支累计，与实时工具状态分开，恢复时核对完整前缀及投影版本，绑定时再核对实际 SDK 分支。同一 manager 的连续追加只累计新增条目，无事实变化时复用视图；分支不匹配则重建。检查点命中不能省去 SDK 打开会话文件，也不能把旧绑定的实时状态当作恢复基准。

输入、附件和阅读状态只保留页面内；空闲回收后的会话可在发送时恢复，不意味着应用重启后恢复所有运行任务。应用退出关闭 SDK 宿主，终端常驻是另一条生命周期。独立宿主不隔离项目文件，多会话不承诺自动解决并行文件修改。
