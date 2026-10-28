# 多会话范围与边界

### 多会话的明确不做项

约定：同一窗口多会话并行只做「会话保留、宿主空闲回收、再次发送自动恢复」，以下都不做，不因实现方便而顺手加入——把侧栏多选扩展为复选框或批量操作、worktree 隔离与自动文件冲突解决、进程池与固定会话数上限、资源监控面板、自动恢复应用上次退出前的全部运行任务、草稿与图片的跨应用重启持久化。

适用：调整侧栏、会话列表、宿主生命周期或输入区时；提出「顺便支持一下」这类扩展需求时。

原因：这些项都曾被单独评估并明确排除，它们各自会引入新的生命周期或持久化边界（worktree 会改变项目目录语义，草稿落盘会引出跨重启一致性问题）。加回来属于需求变更，不是实现细节。

### 工作区标签组：标签按项目分组，活动对话标签就是前台实例

约定：主区顶部一组标签按当前项目分组，对话、终端与文件标签混排、顺序可拖动，每个项目各自记住上次的活动标签；切标签就是切前台（活动对话标签对应前台运行实例，其余标签由后台分片留底），切项目就换一组标签。侧栏点击会话新开一个对话标签，该会话已打开时聚焦已有标签，不重复开；新建对话入口默认新开标签（空白标签的复用边界见 `docs/modules/workspace-tabs.md`），输入区的 `/new` 例外——它在当前标签内就地替换（结束原实例、清空会话身份与重命名，标签位置与顺序不变）。关闭对话标签即结束该标签承载的运行实例（中断在途操作、解除占用、关闭宿主，保留会话历史文件），不弹确认；关闭终端标签即关掉那个终端。关闭文件标签只清内存编辑记录、不写磁盘，有未保存修改时先确认。标签顺序、活动标签、重命名与「有新回复」标记只存页面内，不跨应用重启恢复；应用重启后不恢复标签，进入项目时不自动创建空对话标签。

适用：新增或修改任何按会话、运行实例或项目寻址的接口、事件、状态、缓存键与标签相关交互时；判断某个「切走再切回」的行为是否算 bug 时。

原因：标签把「同一窗口多会话」从隐式约定变成显式交互，容易顺手加出跨重启恢复、标签数量上限、标签钉住或豁免回收这类被明确排除的能力。前台实例仍然只有「跟随当前项目」这一套归属规则，标签不引入第二套：渲染端用既有打开链表达前台切换，不新增寻址通道；标签只产出 `ChatOpenIntent`，唯一提交入口是 `src/renderer/src/sessions/stores/session.ts` 的 `openIntent`，补提交在 `src/renderer/src/shell/use-app-startup.ts`，不要在标签侧重新直接调用打开动作；标签读取会话状态只能经 `src/renderer/src/workspace/stores/session-tab-bridge.ts` 的只读视图（提供者由同一个组合根注册），标签不得直接 import 会话 Store，否则打开链会重新变成模块环。涉及文件：`src/renderer/src/workspace/stores/workspace-tabs.ts`、`src/renderer/src/workspace/components/WorkspaceTabBar.vue`、`src/renderer/src/editor/stores/project-editor.ts`、`src/renderer/src/editor/components/FileEditorView.vue`、`src/renderer/src/workspace/stores/terminal.ts`、`src/renderer/src/sessions/stores/session.ts`、`src/shared/session-run-api.ts`、`src/main/sessions/sdk-runtime-bridge.ts`、`src/renderer/src/workspace/stores/session-tab-bridge.ts`、`src/renderer/src/shell/use-app-startup.ts`。

### 进程隔离不等于文件隔离或安全沙箱

约定：独立 SDK 宿主只隔离进程与运行身份。同一项目下的多个会话仍写同一份工作目录，共享同一份 Pi 配置与凭据；并行写文件、Git 状态竞争、外部程序改写同一会话文件都不作保证，界面与说明只如实提示，不承诺隔离或自动冲突解决。

适用：编写多会话相关文案、错误提示、注释与任何对外说明时；判断某个并发问题是否属于「已知边界」时。

原因：把进程隔离说成数据隔离会给出错误的安全预期；本项目也没有为此引入文件锁或沙箱。

### 运行身份与占用由主进程注册表统一分配

约定：运行实例身份、绑定代际与会话占用关系只由主进程的会话运行注册表分配与登记，宿主与页面都不得自行编号；SDK 内部编号不能当作跨运行实例的全局身份。授权绑定会话的归属项目，不读可变的前台项目。同一个持久化会话在应用内只能由一个运行实例接管，占用覆盖打开中与退出未确认状态。

适用：新增任何按会话或按运行实例寻址的接口、事件、状态或缓存键时。

原因：这些是跨模块的硬约束，违反其中任一条都会让旧请求命中新对象，或在多实例下互相覆盖；机制细节以 `src/main/sessions/session-run-registry.ts`、`src/main/sessions/sdk-runtime-bridge.ts`、`src/main/sessions/sdk-host-manager.ts` 与渲染端 `src/renderer/src/sessions/stores/session-view.ts` 的注释为准。

### 前台实例跟随当前项目，项目与会话在侧栏同一棵树里

约定：切换或添加项目成功后，主进程把前台运行实例切到该项目最近一次前台的实例（该项目没有承载会话的实例时清空前台），因此聊天区内容与当前项目始终一致；项目切换不建立宿主、不重绑会话、不中断后台实例。活动标签由渲染端的标签状态决定，但活动对话标签与该项目最近一次前台的实例是同一个，因此两者不会指向不同的会话。侧栏按「项目 → 会话」两级展示：会话列表按项目分片、展开时懒读取，会话只出现在自己项目的节点下；项目列表顺序由用户维护，加载与切换都不按 `lastOpenedAt` 重排。

适用：调整侧栏、项目切换、会话列表读取、运行状态展示，或新增任何按项目寻址的查询时。

原因：曾出现「切到项目 B 后聊天区仍显示项目 A 的会话、发送也投给 A」以及侧栏把 A 的当前会话列在 B 下——两者都源于项目切换只写配置、前台归属与会话列表仍按旧项目解释。涉及文件：`src/main/projects/project-manager.ts`、`src/main/sessions/session-run-registry.ts`、`src/main/sessions/sdk-runtime-bridge.ts`、`src/main/sessions/session-manager.ts`、`src/renderer/src/projects/sidebar-tree.ts`、`src/renderer/src/sessions/stores/session.ts`。
