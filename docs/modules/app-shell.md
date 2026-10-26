# 应用外壳

模块 ID：`app-shell`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责 Electron 窗口与原生标题栏集成、应用信息、Vue 挂载、设置页导航、右侧面板宿主，以及应用级启动与退出组装。主进程侧由 `src/main/window.ts` 承担窗口与标题栏实现、`src/main/window-channel.ts` 承担事件投递与广播、`src/main/app-lifecycle.ts` 承担启动与退出编排，`src/main/index.ts` 只按固定顺序转交 `app-lifecycle.ts` 装配；页面侧入口为 `src/renderer/src/main.ts`，页面根组件 `src/renderer/src/App.vue` 只装配 `shell/` 下的骨架、工作区宿主、弹层宿主与启动编排。

顶部栏居中胶囊是对话导航入口：单行呈现项目名与当前会话，入口是模态弹窗（遮罩、居中轻量面板、Escape 或点遮罩收起，收起后焦点回到触发键），按新的在前列出每轮用户输入（序号、摘要、发送时间、含几个生成式界面），列表内部自己滚动，键盘 ↑↓／Home／End 移动、Enter 跳转；触发键带「当前轮／总轮数」位置小标。入口列表与当前轮由消息区发布，顶部栏只渲染弹窗并发出跳转意图，滚动与折叠仍由消息区执行（见[会话与聊天](sessions-chat.md)）。

不负责具体会话执行、文件读写、Git 命令或设置值的持久化。设置页只是各业务模块的导航容器，右侧面板只是文件树与 Git 视图的共同宿主。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/window-state.ts` | 窗口状态校正、变更采集、防抖保存与退出落盘 |
| `src/renderer/index.html` | 页面文档与应用挂载点 |
| `src/renderer/src/main.ts` | 创建 Vue、Pinia 并加载全局样式 |
| `src/renderer/src/App.vue` | 页面组合根：装配外壳骨架、弹层宿主与启动编排，不含业务逻辑 |
| `src/renderer/src/shell/components/AppShell.vue` | 布局骨架：顶部栏、侧栏与窄窗遮罩、工作区槽、右侧面板，持有窄窗与侧栏开合状态 |
| `src/renderer/src/shell/components/WorkspaceView.vue` | 工作区：标签条、操作失败提示条、对话／终端／文件面板层与空态 |
| `src/renderer/src/shell/components/AppDialogHost.vue` | 应用级弹层宿主：把各 Store 的待确认目标渲染成对话框，并按来源分派确认结果 |
| `src/renderer/src/shell/use-app-startup.ts` | 展示 Store 的初始化与释放顺序、生成式参数持久化与退出落盘、项目切换与会话落盘后的补读 |
| `src/renderer/src/shell/components/AppTitleBar.vue` | 自绘标题栏、项目与会话信息、对话导航弹窗与布局切换入口 |
| `src/renderer/src/shell/components/SettingsView.vue` | 设置导航与分节内容分发；外观设置入口 |
| `src/renderer/src/shell/components/SettingsNavIcon.vue` | 设置导航图标映射 |
| `src/renderer/src/shell/components/RightPanel.vue` | 面板宽度与页签、文件目录和 Git 跟踪生命周期 |
| `src/renderer/src/shell/components/RightPanelTabs.vue` | 文件／源代码管理页签与角标 |
| `src/renderer/src/shell/stores/desktop.ts` | 应用信息展示状态 |
| `src/renderer/src/shell/stores/settings.ts` | 设置页开关与当前分节，不保存设置值 |
| `src/renderer/src/shell/services/desktop.ts` | 应用信息桥接与通信失败转换 |
| `src/renderer/src/shell/settings-navigation.ts` | 分组、分节 ID、图标及关键词定义 |

窗口与页面入口已读；标题栏和导航辅助组件通过直接调用定位。综合组装文件不在本表重复归属。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/window.ts` 的 `createWindow` 与 `restrictSession`、`src/main/asset-protocol.ts` 的资产协议、`src/main/app-lifecycle.ts` 的便携数据目录与退出链；`src/preload/index.ts` 的应用信息／外链接口；`src/renderer/src/shell/components/AppShell.vue` 的应用布局、`src/renderer/src/shell/components/AppDialogHost.vue` 的弹层与 `src/renderer/src/shell/use-app-startup.ts` 的 Store 生命周期。
- [F-config](shared.md#f-configdesktop-配置混合)：`src/main/config/desktop-config-store.ts` 保存窗口状态。
- [F-platform](shared.md#f-platform文件锁外链与基础错误共享)：`src/shared/desktop-api.ts` 定义应用信息和外链接口；受控外链不暴露任意系统协议。
- [F-style](shared.md#f-style全局主题与业务样式混合)：`src/renderer/src/assets/styles/base.css` 的全局主题令牌与 `src/renderer/src/assets/styles/shell.css` 的外壳样式；由 `src/renderer/src/assets/main.css` 统一加载。
- [偏好](preferences.md)：主题、面板宽度、折叠和页签值；主进程 `nativeTheme` 驱动页面亮暗色。
- [项目](projects-trust.md)、[会话](sessions-chat.md)、[标签](workspace-tabs.md)：提供标题栏和主区上下文。
- [文件](files-editor.md)、[Git](git.md)：`RightPanel.vue` 启动各自的跟踪，切页签不等于结束业务跟踪。

## 状态、调用链与生命周期

1. 主进程在建立窗口前应用便携数据路径及已保存主题，读取窗口状态，创建沙箱窗口并限制导航、权限和新窗口。
2. Vue 页面经固定 bridge 查询应用信息；主进程只接受可信主 frame 的固定请求。
3. 页面挂载时初始化展示 Store（顺序见 `src/renderer/src/shell/use-app-startup.ts`）；具体功能视图自行维护局部生命周期，例如模型页订阅认证，右侧面板订阅目录和 Git。
4. 设置页导航状态只在页面内保留。窗口位置和大小通过唯一配置实例保存。
5. 退出链先停止手机访问的本地入口并断开手机，再阻止 SDK 恢复、关闭宿主与认证辅助进程、收敛窗口状态并断开终端连接；终端继续由守护进程持有。

应用保持单实例、单业务窗口。便携目录是运行数据，不属于可清除编译产物。Electron 集成细节在主进程；renderer 不直接调用 Electron。
