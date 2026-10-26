# 工作区标签

模块 ID：`workspace-tabs`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责按项目分组的对话、终端、文件标签，活动标签、排序、标题与后台回复标记，以及选择、新建和关闭的页面编排。需要打开会话时产出意图，由会话能力与外层编排提交；结束实例经会话运行清单能力执行，原位新建另维护空白展示、独立草稿身份与失败恢复。入口为工作区标签条、侧栏打开会话、新建对话、文件打开及快捷命令运行。

标签不执行 Agent，不持有 PTY，也不直接保存文件正文。对话标签关联运行实例，终端标签由终端清单派生，文件标签关联编辑记录。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/workspace/stores/workspace-tabs.ts` | 标签记录、项目分组、活动选择、打开意图与绑定、原位新建与失败恢复、关闭链、排序与新回复标记 |
| `src/renderer/src/workspace/stores/session-tab-bridge.ts` | 标签读取会话状态的只读视图与提供者注册；标签不直接 import 会话 Store |
| `src/renderer/src/workspace/components/WorkspaceTabBar.vue` | 标签渲染、选择／关闭／重命名／排序事件与新建菜单 |

组件由 `src/renderer/src/shell/components/WorkspaceView.vue` 通过 Props 与事件接线。标签状态由 Store 统一维护，但会调用多个模块。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/renderer/src/shell/components/WorkspaceView.vue` 挂载面板，脏文件关闭确认状态由工作区标签 Store 持有，快捷命令弹层由快捷命令 Store 持有。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/renderer/src/sessions/stores/runtime-core.ts` 提供前台运行身份、就绪情况，以及会话日志历史的展示与退场交接，经 `src/renderer/src/sessions/stores/runtime.ts` 门面暴露。
- [项目](projects-trust.md)：`src/renderer/src/projects/stores/project.ts` 提供当前项目与选择来源。
- [会话](sessions-chat.md)：会话状态经 `src/renderer/src/workspace/stores/session-tab-bridge.ts` 的只读视图读取（`opening`、`openingProjectPath`、`loadedSessionIds`、`sessionsOf`、`actionError`、`awaitingTrust`、`awaitingInterrupt`、`waitForOpenActions`、`invalidateOpenSelection`），提供者由 `src/renderer/src/shell/use-app-startup.ts` 注册；打开请求由 `src/renderer/src/sessions/stores/session.ts` 的 `open`、`openIntent` 承接，`ChatOpenIntent` 定义于 `src/renderer/src/workspace/stores/workspace-tabs.ts`；`src/renderer/src/sessions/stores/session-runs.ts` 提供运行清单与结束动作；`src/renderer/src/sessions/stores/session-view.ts` 消费新草稿身份与绑定映射，负责输入留底及附件回收。
- [文件](files-editor.md)：`src/renderer/src/editor/stores/project-editor.ts` 拥有编辑记录，标签只引用其 key 与脏状态。
- [终端](terminal-commands.md)：`src/renderer/src/workspace/stores/terminal.ts` 提供真实清单、创建、关闭、命名与写入；快捷命令每次创建新终端标签。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：标签菜单浮层、公共按钮与全局标签样式。

`workspace-tabs.ts` 不再调用会话的打开动作：标签只计算 `ChatOpenIntent` 并接收绑定结果，提交由 `session.ts` 的 `openIntent` 与 `shell/use-app-startup.ts` 的补提交执行；读取会话状态经 `session-tab-bridge.ts` 的只读视图而不是直接 import 会话 Store，两者之间因此不再构成模块环（会话侧仍会调用标签的准备与删除去标签动作）。

## 关键流程

1. 进入项目切换到该项目保留的活动标签，没有标签时显示新建入口，不自动建立空对话标签；标签由新建或打开入口建立，空闲态不因建立标签就启动 SDK。
2. 打开会话先确定目标项目与标签 key；会话结果只能绑定原标签，过期结果不抢占当前选择。
3. 选择对话标签时按需要返回打开意图，由外层提交打开链切前台；选择文件或终端只改变展示，不中断后台会话。
4. 关闭对话标签等待打开与原位新建任务收敛后，再结束当前关联实例，保留会话历史；关闭失败保留标签。
5. 关闭终端标签结束该终端；关闭文件标签清除内存编辑记录，脏文件先由弹层宿主确认，不隐式保存。
6. `/new` 先在当前标签展示空白对话，标签位置与顺序不变；旧实例按标签单飞结束，期间可编辑草稿但禁止发送。结束成功后不补开 SDK 会话，首次发送先固定输入并立即展示本地待发送消息，再经会话打开链准备新目标；实际绑定、运行清单与前台状态确认且投影同步后，才向 SDK 提交固定快照。待发送交接、失败恢复与启动期间切走的处理见[会话状态与边界](sessions-chat.md#状态与边界)。侧栏和标签条的新建入口仍打开或聚焦空对话标签。

## 状态与边界

标签顺序、活动标签、对话／文件重命名和新回复标记保留在页面内，不跨应用重启恢复。终端命名由守护进程持久化，是不同数据所有者。

原位新建失败时恢复原会话展示，执行状态仍以主进程报告为准，不代表已经发生的 SDK 操作被回滚；新草稿独立留底，重试 `/new` 时取回。异步收尾只更新原标签，不抢回后来选中的项目或标签；失去标签归属的新草稿附件由输入状态所有者回收。

标签键、新草稿输入身份、持久会话 ID、运行实例 ID、绑定代际、终端 ID 和文件记录 key 各有语义，不能互相替代。运行实例的占用和释放仍由主进程决定。后台留底与挂起不等同于应用重启后自动恢复全部任务。
