# 终端与快捷命令

模块 ID：`terminal-commands`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责项目内终端创建、输入、尺寸、命名、关闭、常驻与恢复、画面和背压，以及全局／项目快捷命令的保存与运行。入口为标签条、新建菜单、终端菜单及设置页“终端”“快捷命令”。

不承载内置 Agent 会话，不将终端标签关闭解释为仅隐藏，也不把应用退出解释为结束 PTY。快捷命令是用户配置的 shell 输入，不是 Agent 工具权限。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/terminal-manager.ts` | 已登记项目校验、守护进程请求适配、错误映射与画面分块 |
| `src/main/terminal-daemon-client.ts` | 固定守护进程入口、连接／握手、请求、重连、版本与构建状态 |
| `src/terminal-daemon/index.ts` | 独立入口、端点所有权、服务与持久化组装、正常停止 |
| `src/terminal-daemon/daemon-server.ts` | 本地连接认证、协议分帧、请求分发与事件投递 |
| `src/terminal-daemon/endpoint.ts` | 版本化端点、token、pid、独占锁与数据路径 |
| `src/terminal-daemon/session-manager.ts` | PTY、终端状态、快照恢复、实时流控与退出冷存储 |
| `src/terminal-daemon/headless-emulator.ts` | 后台画面解析、序列化及终端应答 |
| `src/terminal-daemon/history-store.ts` | 原始历史、磁盘画面、元数据和批量／原子写入 |
| `src/shared/terminal-api.ts` | 页面终端接口、快照、输出、退出、恢复与守护状态契约 |
| `src/shared/terminal-daemon-protocol.ts` | 主进程客户端与守护进程的版本化协议 |
| `src/shared/quick-commands-api.ts` | 快捷命令范围、字段和清单校验 |
| `src/renderer/src/stores/terminal.ts` | 清单、画面恢复、终端动作与订阅状态 |
| `src/renderer/src/stores/quick-commands.ts` | 命令清单、按项目筛选和保存动作 |
| `src/renderer/src/services/terminal.ts` | 终端固定桥接及输出／退出事件 |
| `src/renderer/src/services/quick-commands.ts` | 命令清单读写桥接 |
| `src/renderer/src/components/TerminalView.vue` | xterm 视图、输入、尺寸、恢复确认、链接及路径拖入 |
| `src/renderer/src/components/TerminalSettingsSection.vue` | 守护进程状态与停止／清理入口 |
| `src/renderer/src/components/QuickCommandDialog.vue` | 命令新增、编辑、范围和执行选项 |
| `src/renderer/src/components/QuickCommandMenu.vue` | 当前项目可用命令菜单 |
| `src/renderer/src/components/QuickCommandsSection.vue` | 设置页命令管理 |

主进程适配、守护路径、会话与历史职责已读，视图和状态调用结合源码引用映射。真实 shell、原生 PTY 和操作系统进程是运行依赖，不由目录映射证明其跨平台行为。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`registerTerminalHandlers`、终端事件投递、页面代际撤销与应用退出断开；App 管理终端面板和快捷命令弹层。
- [F-config](shared.md#f-configdesktop-配置混合)：命令清单写 Desktop 配置；[偏好](preferences.md) 的 `PreferencesManager` 提供相关配置适配。
- [F-process](shared.md#f-process受管进程与-sdk-公共设施共享)：`process-tree-termination.ts` 收敛终端关联进程树。
- [F-build](shared.md#f-build构建与发行上下文)：守护进程独立 CJS 构建及 PTY 权限准备；不将原生模块打入浏览器。
- [工作区](workspace-tabs.md)：标签由真实终端清单派生；快捷命令经 `runQuickCommand` 创建新终端再写入。
- [文件](files-editor.md)：`project-entry-drag.ts` 提供拖拽载荷与路径插入文本。
- [项目](projects-trust.md)：终端 cwd 只能取已登记项目的规范路径，项目移除触发该项目终端关闭请求。

## 接回与生命周期

1. 终端 Store 先订阅再读取清单，状态查询不因没有守护进程就自动启动它；显式新建才允许拉起。
2. 主进程使用版本化端点和实例 token 连接守护进程；Windows 使用命名管道，其他平台使用 Unix 域套接字。
3. 单视图带投递代际请求快照，客户端按块取回；页面解析完成后确认恢复，守护进程再开启实时段投递。
4. 输出被 headless 画面与限量历史持续消费；页面按序号确认，背压同时考虑页面、解析和磁盘积压。
5. 页面重载／消失只撤销投递与额度，不结束 PTY。退出应用只断开连接。
6. 自然退出或正常停止保留画面与记录；显式关闭终端删除对应历史。守护进程重启恢复的是退出记录，旧 shell 不会复活。

## 快捷命令与存储

命令按全局或项目范围保存于 `desktop-config.json`。运行目标始终是新建终端，不复用可能被前台程序占用的现有 shell。执行选项控制是否补回车；命令内容不被解释成安全的固定参数 API。

终端数据由 `userData` 下的终端守护数据区持有，端点与持久化按协议版本隔离。原始输出、会话元数据及退出后的 `.screen.json` 画面均可落盘，活动快照还用于实时接回。开发／便携数据区分开，不能通过删除 `out/` 清理终端历史，也不能将便携版 `data/` 当缓存。

设置中的结束旧版本守护进程、停止守护进程和关闭全部终端是不同显式操作。节点进程脱离、文件锁与原生依赖受操作系统约束。设计依据见 [终端常驻设计](../terminal-persistence-design.md)。
