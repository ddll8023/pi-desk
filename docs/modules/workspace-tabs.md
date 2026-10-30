# 工作区标签

模块 ID：`workspace-tabs`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责按项目分组的对话、终端、文件与内置浏览器标签，活动标签、排序、标题与后台回复标记，以及选择、新建和关闭的页面编排。需要打开会话时产出意图，由会话能力与外层编排提交；结束实例经会话运行清单能力执行，原位新建另维护空白展示、独立草稿身份与失败恢复。入口为工作区标签条、侧栏打开会话、新建对话、文件打开、新建浏览器、终端链接唤起及快捷命令运行；浏览器工具栏提供截图标注与元素选择，批注在原位悬浮编辑并交付指定对话草稿。

标签不执行 Agent，不持有 PTY，不直接保存文件正文，也不直接持有网页实例。对话标签关联运行实例，终端标签由终端清单派生，文件标签关联编辑记录，浏览器标签关联页面状态。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/workspace/stores/workspace-tabs.ts` | 标签记录、项目分组、活动选择、打开意图与绑定、原位新建与失败恢复、关闭链、排序与新回复标记 |
| `src/renderer/src/workspace/stores/session-tab-bridge.ts` | 标签读取会话状态与原标签待提交输入的只读视图及提供者注册；标签不直接 import 会话 Store |
| `src/renderer/src/workspace/components/WorkspaceTabBar.vue` | 标签渲染、选择／关闭／重命名／排序事件与新建菜单 |
| `src/main/browser/element-picker.ts` | 在隔离世界运行的固定元素选择脚本、悬停高亮、有限上下文采集、取消与画面变化检查 |
| `src/main/browser/browser-session-service.ts` | 主进程浏览器会话服务，管理受管实例注册表、独占绑定租约与人工接管状态机 |
| `src/main/browser/browser-cdp-adapter.ts` | CDP 协议适配器，负责基于 webContents.debugger 的无障碍快照、正文提取、动态盒模型定位与点击/填充/按键/滚动事件派发 |
| `src/shared/browser-api.ts` | 浏览器标签与 URL 工具、截图／元素选择／取消契约及结果校验 |
| `src/shared/browser-session-api.ts` | 受管浏览器实例登记、项目存储分区派生、会话独占控制权与接管状态机契约及校验 |
| `src/renderer/src/browser/stores/browser.ts` | 各浏览器标签的导航、地址输入与加载状态 |
| `src/renderer/src/browser/stores/browser-annotations.ts` | 按标签保存固定截图、元素上下文、批注及交付指纹，判断未交付内容并回收状态 |
| `src/renderer/src/browser/services/capture.ts` | 截图、元素选择与取消的受限桥接调用及异常展示 |
| `src/renderer/src/browser/components/BrowserView.vue` | webview、截图与元素选择编排、原位批注浮层及替换确认 |
| `src/renderer/src/browser/components/BrowserControlBanner.vue` | 浏览器控制权状态与人工接管/恢复横幅，提供会话绑定选择、一键接管与恢复控制 |
| `src/renderer/src/browser/components/BrowserToolbar.vue` | 导航、地址输入、标注／元素选择与取消、DevTools 及外链入口 |
| `src/renderer/src/browser/components/BrowserAnnotationPanel.vue` | 同视口固定画面、点框编号、悬浮意见编辑与列表、键盘调整、上下文及草稿交付预览 |
| `src/renderer/src/browser/browser-api.test.ts` | URL 规范化的测试源码 |
| `src/renderer/src/browser/stores/browser.test.ts` | 浏览器导航状态 Store 的测试源码 |

组件由 `src/renderer/src/shell/components/WorkspaceView.vue` 通过 Props 与事件接线。标签状态由 Store 统一维护，但会调用多个模块。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/renderer/src/shell/components/WorkspaceView.vue` 挂载面板并编排浏览器批注向对话草稿的交付；脏文件与未交付批注的关闭确认状态由工作区标签 Store 持有，经 `src/renderer/src/shell/components/AppDialogHost.vue` 展示，快捷命令弹层由快捷命令 Store 持有。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/renderer/src/sessions/stores/runtime-core.ts` 提供前台运行身份、就绪情况，以及会话日志历史的展示与退场交接，经 `src/renderer/src/sessions/stores/runtime.ts` 门面暴露。
- [项目](projects-trust.md)：`src/renderer/src/projects/stores/project.ts` 提供当前项目与选择来源。
- [会话](sessions-chat.md)：会话打开与列表状态、原标签的待提交输入经 `src/renderer/src/workspace/stores/session-tab-bridge.ts` 的视图读取，打开链收敛动作也由该视图转交；接口以该文件的 `SessionTabState` 为准，提供者由 `src/renderer/src/shell/use-app-startup.ts` 注册；打开请求由 `src/renderer/src/sessions/stores/session.ts` 的 `open`、`openIntent` 承接，`ChatOpenIntent` 定义于 `src/renderer/src/workspace/stores/workspace-tabs.ts`；`src/renderer/src/sessions/stores/session-runs.ts` 提供运行清单与结束动作；`src/renderer/src/sessions/stores/session-view.ts` 消费新草稿身份与绑定映射，负责输入留底及附件回收。
- [文件](files-editor.md)：`src/renderer/src/editor/stores/project-editor.ts` 拥有编辑记录，标签只引用其 key 与脏状态。
- [终端](terminal-commands.md)：`src/renderer/src/workspace/stores/terminal.ts` 提供真实清单、创建、关闭、命名与写入；快捷命令经 `runQuickCommand` 始终创建新终端标签再写入，不复用现有终端。
- 浏览器主进程与桥接：`src/main/browser/ipc.ts` 的 `registerBrowserHandlers` 由 `src/main/app-lifecycle.ts` 注册；主进程 `src/main/browser/browser-session-service.ts` 维护受管 webview 实例注册表与独占会话租约，通过 `src/main/browser/browser-cdp-adapter.ts` 提供有界无障碍快照、正文提取与有限动作派发，可信主窗口只能操作自己所属的 webview；`src/main/window.ts` 动态应用按项目派生的独立持久分区并实施安全收紧。`src/preload/browser.ts` 提供截图、元素选择、实例登记、会话绑定、接管、恢复、页面快照、正文与动作派发方法，不暴露任意脚本执行；渲染端通过 `BrowserControlBanner.vue` 与 `BrowserView.vue` 呈现控制状态并响应人工接管与恢复，并在发起截图标注时主动挂起自动化操控；页面接口并入公共桥接与环境声明。
- 批注输入交接：[会话输入](sessions-chat.md)中的 `PromptComposer.vue` 通过 `mergeBrowserAnnotation` 复核输入状态、模型图片能力与附件限制，`session-view.ts` 的 `annotationTargetMatches` 只负责身份核对；工作区不直接覆盖后台草稿。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：标签菜单浮层、公共按钮与全局标签样式。

`workspace-tabs.ts` 不再调用会话的打开动作：标签只计算 `ChatOpenIntent` 并接收绑定结果，提交由 `session.ts` 的 `openIntent` 与 `shell/use-app-startup.ts` 的补提交执行；读取会话状态经 `session-tab-bridge.ts` 的只读视图而不是直接 import 会话 Store，两者之间因此不再构成模块环（会话侧仍会调用标签的准备与删除去标签动作）。

## 关键流程

1. 进入项目切换到该项目保留的活动标签，没有标签时显示新建入口，不自动建立空对话标签；标签由新建或打开入口建立，空闲态不因建立标签就启动 SDK。
2. 打开会话先确定目标项目与标签 key；会话结果只能绑定原标签，过期结果不抢占当前选择。
3. 选择对话标签时按需要返回打开意图，由外层提交打开链切前台；选择文件、终端或浏览器只改变展示，不中断后台会话。
4. 关闭对话标签等待打开与原位新建任务收敛后，再结束当前关联实例，保留会话历史；关闭失败保留标签。
5. 关闭终端标签结束该终端；关闭浏览器标签清理该标签的页面、导航与批注状态，有未交付批注时先确认丢弃；关闭文件标签清除内存编辑记录，脏文件先由弹层宿主确认，不隐式保存。
6. `/new` 先在当前标签展示空白对话，标签位置与顺序不变；旧实例按标签单飞结束，期间可编辑草稿但禁止发送。结束成功后不补开 SDK 会话，首次发送先固定输入并立即展示本地待发送消息，再经会话打开链准备新目标；实际绑定、运行清单与前台状态确认且投影同步后，才向 SDK 提交固定快照。待发送交接、失败恢复与启动期间切走的处理见[会话状态与边界](sessions-chat.md#状态与边界)。侧栏和标签条的新建入口打开或聚焦空对话标签；已有待提交输入的标签不作为空白标签复用，原输入继续留在原标签，不阻止另建或聚焦其他空白对话。
7. 终端链接唤起浏览器：终端内点击 HTTP/HTTPS 链接时，可按偏好设置或操作气泡选择在当前项目新开内置浏览器标签（调用 `openBrowserTab(initialUrl)`），自动激活新标签并加载目标地址，与从标签栏新建浏览器共用导航及生命周期。

### 浏览器批注

1. 「标注」捕获网页可见区域，在原网页视口叠加同尺寸、等比例的固定画面；点选或框选后在附近悬浮编辑意见，工具条、列表及交付预览不参与网页宽高分配。退出标注恢复网页操作，固定画面的坐标不跟随网页滚动。
2. 「选择元素」进入隔离世界的悬停高亮与点击选取，采集元素可见区域、有限 HTML 与计算样式，截图后进入同一批注浮层。取消、切走、导航或采集期间页面变化时不接纳迟到结果；已有未交付批注的替换须先确认，选择取消或失败保留旧批注。
3. 「交给对话」预览带编号的截图和意见，并选择同项目已打开的对话。网页地址、元素结构与样式由用户选择是否附带；选中的元素区域被手动调整后，上下文仍指向原始元素并在交付文字中说明。
4. `WorkspaceView.vue` 固定来源批注及目标身份，沿既有打开意图切到目标；输入坞就绪后再次核对归属并合并文字与图片，保留原草稿和附件，不自动发送。目标变化、不可编辑或附件限制拒绝时保留批注，不转投其他对话；图片限制以输入组件的定义为准。

## 状态与边界

标签顺序、活动标签、对话／文件重命名和新回复标记保留在页面内，不跨应用重启恢复。终端命名由守护进程持久化，是不同数据所有者。浏览器批注与固定截图同样只保存在页面内存中，关闭浏览器标签或移除项目时回收。

元素上下文是网页提供的不可信参考数据，不作为指令执行；HTML 仅摘取有限属性与直接文本，不采集表单值或脚本内容。选取范围不保证深入跨域 iframe、Canvas 或封闭 Shadow DOM；当前不提供源码位置、系统全屏捕获、长截图、OCR、视频标注与图层拖拽。webview 保持沙箱与主应用隔离，元素选择只运行主进程持有的固定脚本。

原位新建失败时恢复原会话展示，执行状态仍以主进程报告为准，不代表已经发生的 SDK 操作被回滚；新草稿独立留底，重试 `/new` 时取回。异步收尾只更新原标签，不抢回后来选中的项目或标签；失去标签归属的新草稿附件由输入状态所有者回收。

标签键、新草稿输入身份、持久会话 ID、运行实例 ID、绑定代际、终端 ID 和文件记录 key 各有语义，不能互相替代。运行实例的占用和释放仍由主进程决定。后台留底与挂起不等同于应用重启后自动恢复全部任务。
