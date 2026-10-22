# 应用外壳

模块 ID：`app-shell`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责 Electron 窗口与原生标题栏集成、应用信息、Vue 挂载、设置页导航、右侧面板宿主，以及应用级启动与退出组装。入口为 `src/main/index.ts`、`src/renderer/src/main.ts` 和页面根组件。

不负责具体会话执行、文件读写、Git 命令或设置值的持久化。设置页只是各业务模块的导航容器，右侧面板只是文件树与 Git 视图的共同宿主。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/window-state.ts` | 窗口状态校正、变更采集、防抖保存与退出落盘 |
| `src/renderer/index.html` | 页面文档与应用挂载点 |
| `src/renderer/src/main.ts` | 创建 Vue、Pinia 并加载全局样式 |
| `src/renderer/src/components/AppTitleBar.vue` | 自绘标题栏、项目／会话信息与布局切换入口 |
| `src/renderer/src/components/SettingsView.vue` | 设置导航与分节内容分发；外观设置入口 |
| `src/renderer/src/components/SettingsNavIcon.vue` | 设置导航图标映射 |
| `src/renderer/src/components/RightPanel.vue` | 面板宽度与页签、文件目录和 Git 跟踪生命周期 |
| `src/renderer/src/components/RightPanelTabs.vue` | 文件／源代码管理页签与角标 |
| `src/renderer/src/stores/desktop.ts` | 应用信息展示状态 |
| `src/renderer/src/stores/settings.ts` | 设置页开关与当前分节，不保存设置值 |
| `src/renderer/src/services/desktop.ts` | 应用信息桥接与通信失败转换 |
| `src/renderer/src/settings-navigation.ts` | 分组、分节 ID、图标及关键词定义 |

窗口与页面入口已读；标题栏和导航辅助组件通过直接调用定位。综合组装文件不在本表重复归属。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/index.ts` 的 `createWindow`、资产协议、`restrictSession`、便携数据目录与退出链；`src/preload/index.ts` 的应用信息／外链接口；`src/renderer/src/App.vue` 的应用布局、弹层与 Store 生命周期。
- [F-config](shared.md#f-configdesktop-配置混合)：`src/main/config/desktop-config-store.ts` 保存窗口状态。
- [F-platform](shared.md#f-platform文件锁外链与基础错误共享)：`src/shared/desktop-api.ts` 定义应用信息和外链接口；受控外链不暴露任意系统协议。
- [F-style](shared.md#f-style全局主题与业务样式混合)：`src/renderer/src/assets/main.css` 的布局、主题、标题栏与公共控件样式。
- [偏好](preferences.md)：主题、面板宽度、折叠和页签值；主进程 `nativeTheme` 驱动页面亮暗色。
- [项目](projects-trust.md)、[会话](sessions-chat.md)、[标签](workspace-tabs.md)：提供标题栏和主区上下文。
- [文件](files-editor.md)、[Git](git.md)：`RightPanel.vue` 启动各自的跟踪，切页签不等于结束业务跟踪。

## 状态、调用链与生命周期

1. 主进程在建立窗口前应用便携数据路径及已保存主题，读取窗口状态，创建沙箱窗口并限制导航、权限和新窗口。
2. Vue 页面经固定 bridge 查询应用信息；主进程只接受可信主 frame 的固定请求。
3. App 挂载时初始化展示 Store；具体功能视图自行维护局部生命周期，例如模型页订阅认证，右侧面板订阅目录和 Git。
4. 设置页导航状态只在页面内保留。窗口位置和大小通过唯一配置实例保存。
5. 退出链阻止 SDK 恢复、关闭宿主与认证辅助进程、收敛窗口状态并断开终端连接；终端继续由守护进程持有。

应用保持单实例、单业务窗口。便携目录是运行数据，不属于可清除编译产物。Electron 集成细节在主进程；renderer 不直接调用 Electron。
