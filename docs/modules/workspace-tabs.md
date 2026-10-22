# 工作区标签

模块 ID：`workspace-tabs`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责按项目分组的对话、终端、文件标签，活动标签、排序、标题与后台回复标记，以及选择和关闭的页面编排。入口为工作区标签条、侧栏打开会话、新建对话、文件打开及快捷命令运行。

标签不执行 Agent，不持有 PTY，也不直接保存文件正文。对话标签关联运行实例，终端标签由终端清单派生，文件标签关联编辑记录。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/stores/workspace-tabs.ts` | 标签记录、项目分组、活动选择、打开绑定、关闭链、排序与新回复标记 |
| `src/renderer/src/components/WorkspaceTabBar.vue` | 标签渲染、选择／关闭／重命名／排序事件与新建菜单 |

Store 完整实现已读；组件经 App 的 Props 与事件注册定位。标签状态是单一业务所有者，但会调用多个模块。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/renderer/src/App.vue` 挂载面板，处理脏文件关闭确认与快捷命令弹层。
- [F-runtime-state](shared.md#f-runtime-state综合-runtime-状态混合)：`src/renderer/src/stores/runtime.ts` 提供前台运行身份及就绪情况。
- [项目](projects-trust.md)：`src/renderer/src/stores/project.ts` 提供当前项目与选择来源。
- [会话](sessions-chat.md)：`src/renderer/src/stores/session.ts` 提供 `open`、`invalidateOpenSelection`、`waitForOpenActions`；`src/renderer/src/stores/session-runs.ts` 提供运行清单与结束动作。
- [文件](files-editor.md)：`src/renderer/src/stores/project-editor.ts` 拥有编辑记录，标签只引用其 key 与脏状态。
- [终端](terminal-commands.md)：`src/renderer/src/stores/terminal.ts` 提供真实清单、创建、关闭、命名与写入；快捷命令每次创建新终端标签。
- [F-ui](shared.md#f-ui前端共享展示共享)、[F-style](shared.md#f-style全局主题与业务样式混合)：标签菜单浮层、公共按钮与全局标签样式。

`session.ts` 与 `workspace-tabs.ts` 当前双向调用：会话打开先固定标签，标签选择又调用会话打开。这里记录现有编排，不假定依赖已经改成单向。

## 关键流程

1. 首次进入项目建立空对话标签；空闲态不因建立标签就启动 SDK。
2. 打开会话先确定目标项目与标签 key；会话结果只能绑定原标签，过期结果不抢占当前选择。
3. 选择对话标签通过会话打开链切前台；选择文件或终端只改变展示，不中断后台会话。
4. 关闭对话标签等待打开动作收敛后结束关联实例，保留会话历史；失败保留标签。
5. 关闭终端标签结束该终端；关闭文件标签清除内存编辑记录，脏文件由 App 先确认，不隐式保存。
6. `/new` 在当前对话标签就地替换，侧栏和标签条的新建入口则打开或聚焦空对话标签。

## 状态与边界

标签顺序、活动标签、对话／文件重命名和新回复标记保留在页面内，不跨应用重启恢复。终端命名由守护进程持久化，是不同数据所有者。

标签键、持久会话 ID、运行实例 ID、绑定代际、终端 ID 和文件记录 key 各有语义，不能互相替代。运行实例的占用和释放仍由主进程决定。后台留底与挂起不等同于应用重启后自动恢复全部任务。
