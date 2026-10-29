# 会话与聊天

模块 ID：`sessions-chat`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责按项目读取会话列表、打开／新建／重载／删除会话、按会话读取历史（页、轮次与原文续段），监督 SDK 宿主、维护运行身份与占用，发送与中止、回退、压缩，投影聊天／工具／历史／活动与用量，管理独立图片资料与编号标注，以及 SDK 扩展对话框、通知和 widget。

入口为侧栏、顶部栏的对话跳转入口、输入坞及其独立图片资料区、聊天消息动作和资源重载。文件编辑器、终端、MCP 配置与供应商持久化属于其他模块；会话内 Agent 自己读写项目文件也不等于桌面文件编辑接口。

## 专属文件

### 主进程与宿主

| 文件 | 用途 |
| --- | --- |
| `src/main/sessions/session-manager.ts` | 列表、前后台新建／打开、重载、删除与 SDK 目标授权编排 |
| `src/main/sessions/session-store.ts` | 项目会话目录、受限列表窗口与摘要缓存、文件定位与删除 |
| `src/main/sessions/session-run-registry.ts` | 运行 ID、绑定代际、前台顺序及会话占用的唯一登记 |
| `src/main/sessions/log-host-pool.ts` | 只读解析宿主池：按项目保活查看历史用的宿主进程，不登记运行实例、不占用会话，可被绑定接管 |
| `src/main/sessions/sdk-runtime-bridge.ts` | 多实例运行选择、请求分发、状态与宿主生命周期适配；按实例查询与订阅完整状态 |
| `src/main/sessions/sdk-host-manager.ts` | utilityProcess 启动、协议请求、超时、身份和退出监督 |
| `src/main/sessions/extension-ui-manager.ts` | 扩展 UI 投影、等待与回应管理 |
| `src/main/sessions/prompt-input.ts` | Prompt、图片及绑定标注的校验与受限载荷重建 |
| `src/main/sessions/ipc.ts` | 会话列表、打开、重载、删除、按会话读取历史，以及运行清单查询、释放与结束的通道注册 |
| `src/main/sessions/runtime-ipc.ts` | 执行主链通道注册：状态、中止、回退、模型、压缩、Prompt、投影快照与确认 |
| `src/main/sessions/extension-ui-ipc.ts` | 扩展交互通道注册：对话、通知与 widget 快照读取及应答提交 |
| `src/sdk-host/index.ts` | 宿主入口、初始化、授权回应与控制／生命周期分派 |
| `src/sdk-host/protocol.ts` | 主进程和 SDK 宿主的版本化消息、请求与目标校验 |
| `src/sdk-host/session-runtime.ts` | 官方 SDK 会话、运行请求、订阅、回退／压缩及内置扩展装配 |
| `src/sdk-host/image-annotations.ts` | 按提交的异步作用域附带本轮独立图片说明消息，不改写提示词或预先排入下一轮 |
| `src/sdk-host/log-reader.ts` | 日志读取：把已授权的会话文件按查询解析成历史页、轮次页或原文续段，不建会话、不加载扩展与 MCP；按文件版本有界复用多个会话的解析结果，并把最新首页写入检查点 |
| `src/sdk-host/extension-ui-bridge.ts` | SDK UI 回调到宿主消息的适配及取消 |

### 会话投影与契约

| 文件 | 用途 |
| --- | --- |
| `src/sdk-host/projection/message-projection.ts` | 有界消息／工具聚合、序号、批次与确认，将图片标注附属资料关联回原用户消息 |
| `src/sdk-host/projection/tool-projection.ts` | 工具生命周期、参数／结果摘要与生成式界面载荷接入 |
| `src/sdk-host/projection/history-projection.ts` | 当前分支按轮历史与原文续段，从附属条目还原图片与标注关系 |
| `src/sdk-host/projection/activity-projection.ts` | 从官方分支累计稳定活动事实，以实时工具状态补充展示，支持检查点恢复与连续追加复用 |
| `src/sdk-host/projection/identity.ts` | 用户消息规范化摘要身份；不替代官方回退条目 ID |
| `src/sdk-host/projection/output-rate.ts` | 模型输出速率计算 |
| `src/sdk-host/projection/checkpoint.ts` | 首页与稳定活动的独立内存检查点：绑定时分别核对恢复条件，命中不替代 SDK 打开会话文件 |
| `src/shared/session-api.ts` | 会话列表、打开、重载、删除与按会话读取历史的页面契约 |
| `src/shared/session-run-api.ts` | 应用级运行清单、释放／结束与事件契约 |
| `src/shared/extension-ui-api.ts` | 扩展对话、通知、widget 与回应形态 |
| `src/shared/user-message-text.ts` | 用户消息里的技能块与图片标记处理，供摘要和展示共用 |
| `src/shared/image-annotation.ts` | 图片标注的编号、归一化位置、说明与整图意见契约，以及附属资料识别和校验 |

### 前端状态与服务

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/sessions/stores/session.ts` | 按项目的列表窗口与读取调度、串行打开／重载、按标签意图提交打开、删除与待确认目标 |
| `src/renderer/src/sessions/stores/session-runs.ts` | 运行清单、副本状态、释放与结束 |
| `src/renderer/src/sessions/stores/session-view.ts` | 会话输入、阅读与展开状态，按标签保存待发送快照、核对同步并保留未确认输入，原位新草稿的独立留底、浏览器批注交付目标身份核对及图片与绑定标注的移交、还原与回收 |
| `src/renderer/src/sessions/stores/chat-navigation.ts` | 对话内跳转登记：按会话键发布轮次入口与当前轮，并转交一次性跳转意图 |
| `src/renderer/src/sessions/stores/extension-ui.ts` | 运行目标的扩展对话、通知、widget 展示副本 |
| `src/renderer/src/sessions/services/session.ts` | 会话请求桥接 |
| `src/renderer/src/sessions/services/session-runs.ts` | 运行清单与生命周期桥接 |
| `src/renderer/src/sessions/services/runtime.ts` | Runtime 状态、Prompt、回退、压缩、模型命令与投影桥接 |
| `src/renderer/src/sessions/services/extension-ui.ts` | 扩展快照订阅与对话回应桥接 |
| `src/renderer/src/sessions/chat-view.ts` | 将消息与工具投影组织为聊天展示模型，保留图片与标注关系并还原可重发输入 |
| `src/renderer/src/sessions/clock.ts` | 聊天生成／工具计时与显示时钟 |
| `src/renderer/src/sessions/usage-format.ts` | token、费用及用量展示格式 |
| `src/renderer/src/sessions/tool-summary.ts` | 工具卡展示推导：参数摘要、路径相对化、改动量与结果预览 |
| `src/renderer/src/sessions/extension-dialog-presentation.ts` | 扩展提示、选择及对话展示转换 |

### 界面

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/sessions/components/PromptComposer.vue` | 提示词与独立图片资料编排、文件树拖入引用、命令与补全；浏览器批注草稿合并；固定提示词、图片及标注快照、后台提交与失败恢复；显式同步及确认结束原运行后的输入恢复 |
| `src/renderer/src/sessions/components/PromptImageMaterials.vue` | 输入框外的图片资料区：导入、移除、标注数量与独立编辑入口 |
| `src/renderer/src/sessions/components/ImageAnnotationPanel.vue` | 左图右说明的独立标注面板、编号双向定位、同步删除与键盘调整入口 |
| `src/renderer/src/sessions/components/ImageAnnotationCanvas.vue` | 共用原图坐标系的编号与点框叠加层，支持编辑及桌面／手机只读展示，不修改图片像素 |
| `src/renderer/src/sessions/components/ChatMessageList.vue` | 本地待发送／结果未确认状态及绑定图片标注展示、权威消息交接、历史加载、滚动与布局观察；向顶部栏发布对话跳转入口并执行跳转 |
| `src/renderer/src/sessions/components/ChatTurnItem.vue` | 按轮摘要、展开与原文内容 |
| `src/renderer/src/sessions/components/ChatMessageItem.vue` | 单消息、图片编号及对应说明、思考、工具归组面板与生成式界面分发 |
| `src/renderer/src/sessions/components/HistoryLoadSentinel.vue` | 历史加载触发哨兵 |
| `src/renderer/src/sessions/components/ToolCard.vue` | 工具卡：摘要行、变更 Diff、参数与结果二级折叠 |
| `src/renderer/src/sessions/components/UsageDetailDialog.vue` | 会话用量明细与独立的 Codex 账户额度展示、按需读取与手动刷新 |
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
- [项目与信任](projects-trust.md)：登记项目与目标授权；[工作区](workspace-tabs.md)：原标签绑定、选择与关闭，以及浏览器批注的来源固定和目标切换编排。输入坞的 `mergeBrowserAnnotation` 在目标就绪后复核身份并合并草稿，两模块不拥有 SDK 分配权。
- [供应商](providers-auth.md)：`RuntimeModelSelect.vue` 提供模型选择，持久默认模型不等于当前会话模型；`UsageDetailDialog.vue` 经认证服务读取 Codex 账户额度，查询机制与凭据边界由供应商模块维护。
- [文件](files-editor.md)：`project-file` Store 提供 `@` 文件候选；[资源](resources-mcp.md) 提供技能和命令补全；[偏好](preferences.md) 提供快捷输入。
- [生成式界面](genui.md)：宿主注册内置扩展，工具投影识别其载荷，消息组件分发到专用渲染器。

## 关键调用链

输入坞的用量指标打开“用量与额度”弹窗，保留本会话统计并按需读取 Codex 账户额度，支持手动刷新。加载、未登录、接口失败和缺失窗口分别展示，不把账户额度计入会话用量；关闭或卸载后忽略迟到响应，重新打开时读取当前账户快照。查询链路见[供应商与认证](providers-auth.md#调用链与数据所有者)，不经过会话 SDK 宿主。

1. 页面表达打开意图：标签 Store 计算 `ChatOpenIntent`，`session` Store 固定项目与标签并串行提交；选择本身立即落到标签，不等打开动作整体收尾。打开已有会话前先按会话读取首页历史并显示出来，未绑定时可继续翻页、展开轮次与续段；历史读取不排队，失败即降级。页面只给项目与会话，由主进程判定该会话当前走绑定路径还是日志解析。
2. 主进程校验登记项目与信任，注册表管理占用，Runtime 桥决定复用、切前台或建立宿主；前台选择按主进程分配的序号收敛，先提交后完成的旧选择不会把前台改回旧目标。项目成为当前项目时预热只读池中的一个解析宿主，供查看历史与随后的绑定共用。
3. 宿主请求会话目标准备，主进程按来源实例的归属项目复核目标，再返回绑定代际与目录；宿主不能自行编号授权。
4. 输入坞点击发送即固定本次提示词、图片及绑定标注、清空本次输入，并按原标签显示本地待发送消息；目标未就绪时先走会话打开链，就绪且投影同步后经 Runtime 服务提交固定目标与输入快照。提示词照常进入命令、输入处理器与模板管线，图片说明在实际启动用户轮次时作为 SDK 独立附属消息提供。SDK 事件转换成消息、工具与活动投影，图片标注关联回原用户消息；主进程广播到可信页面。本地待发送展示与 SDK 受理、正式投影到达是不同阶段。
5. 页面校验代际／序号并应用增量；切回已缓存的实例时直接复用分片与模型清单，仅在换代、缺基准、序号断档或宿主失效时取快照；同一绑定的快照水位不倒退；早期历史和超长正文按会话读取当前分支，不接受任意文件路径，分支已变时按权威基准重建一次。
6. 回退基于官方条目身份建立新分支；压缩由 SDK 处理。成功请求和最终展示收敛不是同一个时点。
7. 删除会话先按登记占用结束或释放实例，再删除受限会话文件并刷新列表。关闭标签保留历史，与删除不同。

## 状态与边界

运行注册表是运行身份、绑定代际和占用真源；SDK 持有会话及历史；renderer 保存展示副本、后台投影留底与有限历史缓存。后台新建与接入已有会话复用同一条授权与打开链，按目标项目复核信任，不参与桌面前台选择，也不清扫或占用桌面空白会话；手机首次发送创建与结果未知保护见[手机访问](lan-remote.md#状态与边界)。会话列表按项目取有界窗口，不能当作完整运行清单；列表由项目切换、删除、回退与新增会话落盘后的补读维护，打开与重载不回传列表，切换链不等目录扫描，列表读取失败也不回退已完成的切换。

列表每次仍扫描目录与文件元数据，保持文件 mtime 排序；窗口内的摘要按文件版本有界缓存，同版本的在途读取共用任务，读取前后复核文件身份，瞬时读取失败不缓存为无效摘要。页面按项目合并读取：强制刷新安排后置补读，旧响应不覆盖更晚的刷新或删除结果，删除回传的窄窗口不收起已展开列表，而是补读所需窗口。

已有会话的聊天面板在活动标签与前台身份一致时显示，或在该标签有该会话的日志历史时显示：身份已匹配就先展示缓存内容，输入、回退与压缩另按交互状态门禁，不拿打开动作的收尾当可见条件。本地待发送消息也能独立保持面板可见，身份未匹配时仍隐藏原会话内容，不退回整页占位。原位新草稿使用独立空态与输入身份，提交后由待发送展示接替空态，不以旧 Runtime 的就绪状态决定展示或发送目标；新建流程见[工作区标签](workspace-tabs.md#关键流程)。

本地待发送状态固定原项目、标签与本次输入，独立于权威投影，不生成历史身份，也不提供回退操作；后续编辑属于下一份草稿，不混入当前提交。同一标签有待发送消息时不重复提交，界面命令也先保留草稿并拒绝穿插。正式用户消息到达后交还展示位；请求受理不等于正式投影已同步，待发送气泡也不代表 SDK 已执行或历史已落盘。

请求受理后安排一次有限的同步核对；仅在原标签仍展示原绑定时补读权威投影。原目标未连接、绑定变化、同步未完成或未发现正式用户消息时，保留为「结果未确认」，不据此判定输入未执行。输入坞的「重新同步」只核对投影，不再次提交输入；等待边界以 `src/renderer/src/sessions/stores/session-view.ts` 为准。

「结束原运行并恢复输入」须显式确认，先重新核对消息，再按原目标结束运行；原槽位已确认释放且标签仍为空白时可直接恢复。结束未确认或目标变化时保留原输入，后续草稿仍按原归属交回。恢复保留文字、附件及后续草稿，不自动发送；关闭期间已观察到正式消息时只交回后续草稿，不重复恢复原输入。切走或卸载后的恢复快照留在原标签，重新进入时才交回输入，不转投其他标签。

启动或提交失败时，输入按原归属合并恢复，保留后续草稿和新附件；已观察到正式用户消息时，不再把同一输入恢复成可重复发送的草稿。启动等待期间切换项目、标签或卸载输入组件会取消自动发送，将快照连同后续草稿保留在原标签，重新进入后恢复输入而不自动重发；标签关闭时回收附件。请求已经发出后切换展示不撤销执行，迟到结果只收敛原请求与输入归属。

历史读取按会话寻址：页面只给项目与会话，已由运行实例接管时由绑定路径读权威分支，未接管时由日志解析作答；两条路径返回同一套条目身份，缓存合并规则不区分来源。日志路径是展示副本，覆盖历史页、轮次页与原文续段，因此未绑定的会话也能查看与翻页；但在会话真正绑定前不向 SDK 提交输入，也不能回退或压缩。绑定到同一个会话时日志展示不提前清空：先取一次权威基准，应用成功后才交还展示位，交接中间不出现空白。日志读取失败、结果不属于请求目标或被更晚的选择取代时一律不写入，界面退回原来的等待呈现；文件戳在读取前后各复核一次，读取期间被改写按目标失效处理。

两条路径的「这一页已经过期」（绑定代际变化、日志文件被改写或游标不再属于当前分支）在会话编排层统一归成 `HISTORY_STALE`，页面据此按权威基准重建一次，而不是当成项目未登记或宿主未就绪报错；其余失败仍按原分类上报。

查看历史仍要有一个宿主进程承担解析。只读宿主池按项目保活这样的进程：它不承载会话、不登记运行实例、不进入页面运行清单，也不参与项目移除的活动判定。日志读取优先复用该会话仍可用的原服务宿主，再借同项目执行宿主，没有才用池中宿主；只有宿主失效才重选一次，文件版本、游标与解析错误不盲目重试。池中宿主在绑定时按原对象接管，接上运行身份与授权回路，进程内缓存无需搬运；读取不新增执行占用，也不因此改为共享多会话执行宿主或默认常驻。

历史读取由池租约或管理器读取计数保护，在途读取不被自动回收；读取结束后按宿主当前归属重新安排回收。池内空闲计时从最后一次读取结束起算，确认回收后才移出登记，关闭未确认时保留监督并禁止借用或接管。显式关闭与应用退出不受读取保护阻挡。

日志解析结果在宿主内按项目、会话、规范文件与文件版本有界复用，同版本并发共用解析，不保留原始日志文本。首页与稳定活动检查点彼此独立，也不落盘或跨进程传递：首页按文件戳与分支尾匹配；稳定活动从官方分支累计，与实时工具状态分开，恢复时核对完整前缀及投影版本，绑定时再核对实际 SDK 分支。同一 manager 的连续追加只累计新增条目，无事实变化时复用视图；分支不匹配则重建。检查点命中不能省去 SDK 打开会话文件，也不能把旧绑定的实时状态当作恢复基准。

桌面图片通过提示词输入框外的「图片资料」区导入、粘贴或拖入，点击图片进入独立标注面板。点标记或矩形区域与各自的编号、说明绑定，支持整图说明；图上编号与说明双向定位，删除时一起删除，不重新排列其他编号。画面只叠加标记，不改写原图像素；存在未填写说明的标记时不提交，类型和内容边界见 `src/shared/image-annotation.ts` 与 `src/main/sessions/prompt-input.ts`。

发送时图片及标注与提示词一起固定，但说明不拼入提示词，也不作为命令或模板的文字参数。模型接收图片本体及独立的编号、比例坐标和说明；结构化资料随 SDK 会话历史保存，实时与历史投影按原用户消息中的图片顺序还原，不另建用户轮次或回退身份。失败恢复及修改重试保留可还原图片与绑定说明，提示词回到输入框，图片资料回到独立区域；处理器消费输入但未走常规提交时保留图片资料，不自动重发。

浏览器批注交付只在指定项目、标签内容与输入身份匹配且输入坞可编辑时合并；模型图片能力与附件限制仍由输入坞核对，拒绝时不改动原草稿。成功时追加批注文字与图片，不自动提交给 SDK；浏览器采集、悬浮编辑与关闭边界见[工作区批注](workspace-tabs.md#浏览器批注)。

未提交的提示词、图片及标注草稿和阅读状态只保留页面内；空闲回收后的会话可在发送时恢复，不意味着应用重启后恢复所有运行任务。应用退出关闭 SDK 宿主，终端常驻是另一条生命周期。独立宿主不隔离项目文件，多会话不承诺自动解决并行文件修改。
