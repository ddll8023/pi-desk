# 偏好

模块 ID：`preferences`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责界面主题、侧栏与右侧面板、Markdown 默认视图、文件排除规则与显隐模式、终端链接打开模式、快捷输入短语，以及统一偏好服务对模型展示、快捷命令和功能开关的适配。入口为设置页“外观”“文件”“快捷输入”“终端”和使用相应偏好的布局与终端控件。

设置页导航不是设置值存储；窗口位置、项目列表、认证秘密和 Pi 自己的默认模型不归此模块独立写入。业务开关由本模块提供配置入口，实际运行行为由对应模块持有。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/preferences/preferences-manager.ts` | 通过共享配置实例读取／保存偏好，返回页面结果 |
| `src/shared/preferences-api.ts` | 主题、布局、终端链接模式、文件排除与显隐、模型显示、快捷输入、自动更新、生成式开关的契约及校验 |
| `src/renderer/src/preferences/stores/preferences.ts` | 偏好展示与动作状态、布局修改及已保存／待应用的功能开关状态 |
| `src/renderer/src/preferences/services/preferences.ts` | 固定偏好桥接与普通载荷重建 |
| `src/renderer/src/preferences/components/QuickSendSection.vue` | 快捷发送短语管理 |

偏好入口、共享配置字段及 Store 消费关系来自源码读取与静态调用；各偏好的视觉样式在公共样式记录。

## 公共与跨模块引用

- [F-config](shared.md#f-configdesktop-配置混合)：`src/main/config/desktop-config-store.ts` 才是 `desktop-config.json` 的唯一持久化所有者；PreferencesManager 不另建第二份文件写入。
- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`registerPreferencesHandlers` 校验完整偏好请求并应用原生主题；preload 提供固定接口，布局值由 `src/renderer/src/shell/components/AppShell.vue` 消费。
- [应用外壳](app-shell.md)：`SettingsView.vue` 的外观分节、`RightPanel.vue` 的宽度／页签、标题栏的布局开关。
- [供应商](providers-auth.md)：隐藏模型列表的读写通过本模块服务，交互状态当前位于综合 Runtime Store。
- [终端](terminal-commands.md)：快捷命令有独立业务契约与 Store，配置适配复用 PreferencesManager；终端链接打开模式随 UI 偏好保存，由终端设置节与终端视图消费。
- [生成式界面](genui.md)：开关与本机参数文件不同；[更新](updates-runtime.md)：启动扩展自动更新消费开关；[会话](sessions-chat.md)：重载后同步功能已应用状态。
- [F-style](shared.md#f-style全局主题与业务样式混合)：CSS 同名主题令牌，主进程通过 `nativeTheme` 驱动亮暗色。

## 调用链与数据

页面动作 → preferences Store／服务 → preload 固定方法 → 主进程偏好处理器 → PreferencesManager → 同一 DesktopConfigStore。

配置含 UI 偏好、模型隐藏、快捷输入、快捷命令和功能开关，但这些字段不因此成为同一个用户任务。布局与设置页可读取共同状态；输入框草稿仍由会话视图状态持有，不放入通用偏好。

主题请求在合法后立即应用到原生主题；窗口与页面使用同一主题来源。右侧面板拖动期间保持局部尺寸，结束后再保存；Markdown 默认视图用于新打开标签，不强制改变所有已打开文件。

保存失败通过结果和界面状态报告，配置不可写时不创建另一套本地存储兜底。生成式开关的已保存值与现有 SDK 会话已加载能力分开，开关不意味着自动重建全部会话。
