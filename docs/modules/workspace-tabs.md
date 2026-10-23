# 工作区标签

模块 ID：`workspace-tabs`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责按项目分组的对话、终端、文件标签，活动标签、排序、标题与后台回复标记，以及选择和关闭的页面编排：选择、新建与关闭只产出打开意图，实际提交在会话能力与外层编排。入口为工作区标签条、侧栏打开会话、新建对话、文件打开及快捷命令运行。

标签不执行 Agent，不持有 PTY，也不直接保存文件正文。对话标签关联运行实例，终端标签由终端清单派生，文件标签关联编辑记录。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/workspace/stores/workspace-tabs.ts` | 标签记录、项目分组、活动选择、打开意图与绑定、关闭链、排序与新回复标记 |
| `src/renderer/src/workspace/stores/session-tab-bridge.ts` | 标签读取会话状态的只读视图与提供者注册；标签不直接 import 会话 Store |
| `src/renderer/src/workspace/components/WorkspaceTabBar.vue` | 标签渲染、选择／关闭／重命名／排序事件与新建菜单 |

Store 完整实现已读；组件经 `shell/WorkspaceView.vue` 的 Props 与事件注册定位。标签状态是单一业务所有者，但会调用多个模块。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/renderer/src/shell/components/WorkspaceView.vue` 挂载面板，脏文件关闭确认状态由工作区标签 Store 持有，快捷命令弹层由快捷命令 Store 持有。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/renderer/src/sessions/stores/runtime-core.ts` 提供前台运行身份及就绪情况，经 `src/renderer/src/sessions/stores/runtime.ts` 门面暴露。
- [项目](projects-trust.md)：`src/renderer/src/projects/stores/project.ts` 提供当前项目与选择来源。
- [会话](sessions-chat.md)：会话状态经 `src/renderer/src/workspace/stores/session-tab-bridge.ts` 的只读视图读取（`opening`、`openingProjectPath`、`loadedSessionIds`、`sessionsOf`、`actionError`、`awaitingTrust`、`awaitingInterrupt`、`waitForOpenActions`、`invalidateOpenSelection`），提供者由 `src/renderer/src/shell/use-app-startup.ts` 注册；提交与打开意图的类型仍来自 `src/renderer/src/sessions/stores/session.ts` 的 `open`、`openIntent`（意图由标签侧声明）；`src/renderer/src/sessions/stores/session-runs.ts` 提供运行清单与结束动作。
- [文件](files-editor.md)：`src/renderer/src/editor/stores/project-editor.ts` 拥有编辑记录，标签只引用其 key 与脏状态。
- [终端](terminal-commands.md)：`src/renderer/src/workspace/stores/terminal.ts` 提供真实清单、创建、关闭、命名与写入；快捷命令每次创建新终端标签。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：标签菜单浮层、公共按钮与全局标签样式。

`workspace-tabs.ts` 不再调用会话的打开动作：标签只计算 `ChatOpenIntent` 并接收绑定结果，提交由 `session.ts` 的 `openIntent` 与 `shell/use-app-startup.ts` 的补提交执行；读取会话状态经 `session-tab-bridge.ts` 的只读视图而不是直接 import 会话 Store，两者之间因此不再构成模块环（会话侧仍会调用标签的准备与删除去标签动作）。

## 关键流程

1. 首次进入项目建立空对话标签；空闲态不因建立标签就启动 SDK。
2. 打开会话先确定目标项目与标签 key；会话结果只能绑定原标签，过期结果不抢占当前选择。
3. 选择对话标签时标签给出打开意图，由外层提交打开链切前台；选择文件或终端只改变展示，不中断后台会话。
4. 关闭对话标签等待打开动作收敛后结束关联实例，保留会话历史；失败保留标签。
5. 关闭终端标签结束该终端；关闭文件标签清除内存编辑记录，脏文件先由弹层宿主确认，不隐式保存。
6. `/new` 在当前对话标签就地替换，侧栏和标签条的新建入口则打开或聚焦空对话标签。

## 状态与边界

标签顺序、活动标签、对话／文件重命名和新回复标记保留在页面内，不跨应用重启恢复。终端命名由守护进程持久化，是不同数据所有者。

标签键、持久会话 ID、运行实例 ID、绑定代际、终端 ID 和文件记录 key 各有语义，不能互相替代。运行实例的占用和释放仍由主进程决定。后台留底与挂起不等同于应用重启后自动恢复全部任务。
