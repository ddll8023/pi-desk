# 更新与运行时

模块 ID：`updates-runtime`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责 Pi agent 与 Pi 扩展的已安装／远端版本检查、显式扩展更新、内置 Pi agent 运行时安装，以及运行时指针未生效时的重装或清指针入口。入口为设置页“版本与更新”和启动更新提示。

不等于 Electron 桌面应用自更新器，不修改项目 `package.json` 或项目依赖，不建立 Agent 会话。扩展更新和 SDK 运行时安装是不同任务。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/main/update-checker.ts` | 版本检查单飞、状态快照与启动检查 |
| `src/main/package-updater.ts` | 已声明 Pi 扩展包更新、进度与结论 |
| `src/main/pi-agent-updater.ts` | 内置运行时安装、进度、结论与指针修复 |
| `src/main/pi-runtime.ts` | Electron 数据目录下的运行时根与可用 SDK 入口环境 |
| `src/update-check/index.ts` | 一次性读取安装信息并查询官方发布、npm、git 版本 |
| `src/package-update/index.ts` | 一次性调用 Pi 包管理更新，输出带前缀的进度与结论 |
| `src/runtime-install/index.ts` | 官方发布依赖安装、候选加载、发布切换与旧版本清理 |
| `src/shared/updates-api.ts` | 更新状态、进度、结果、协议前缀与载荷校验 |
| `src/renderer/src/stores/updates.ts` | 检查／更新／安装动作、订阅与启动提示状态 |
| `src/renderer/src/services/updates.ts` | 更新、安装和修复的固定桥接与事件 |
| `src/renderer/src/components/VersionUpdateSection.vue` | 版本清单、检查、更新、安装和修复入口 |
| `src/renderer/src/components/UpdateNoticeDialog.vue` | 启动更新提示与详情导航 |

更新与安装入口、通用执行器及组装调用已读；前端各分支通过服务、事件和视图引用定位。本文不把外部发布服务的可用性或兼容性当作仓库事实。

## 公共与跨模块引用

- [F-process](shared.md#f-process受管进程与-sdk-公共设施共享)：`managed-entry-runner.ts` 提供单飞、超时和输出边界；`pi-cli-process.ts` 只允许固定产物；`pi-paths.ts` 提供固定 agent 环境；`runtime-install/runtime.ts` 提供布局、指针及 SDK 加载公共实现。
- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`registerUpdatesHandlers` 校验允许版本／已报告来源，广播进度和结论；`runStartupAutoUpdate` 消费启动检查与偏好。
- [F-build](shared.md#f-build构建与发行上下文)：一次性入口与 SDK 宿主共用多入口 ESM 构建，但在运行时分别启动。
- [项目](projects-trust.md)：扩展声明读取使用当前项目上下文；[偏好](preferences.md)：扩展自动更新开关。
- [应用外壳](app-shell.md)：更新提示导航到版本分节，应用版本信息由桌面接口提供。

## 数据流与持久化

1. 检查器启动一次性脚本，读取已安装包并按离线状态决定是否访问官方发布、npm 与 git 远端。
2. 检查结果更新应用内快照并投递页面。检查本身不安装或修改 Pi 配置。
3. 扩展更新只针对 Pi 已声明包；页面不能任意构造主进程尚未报告的来源。进度行带固定前缀，依赖命令日志不是协议结论。
4. SDK 安装入口取得官方发布依赖，在应用自有 staging 中安装并加载候选 SDK、比对版本，再移动到版本目录和切换当前版本指针；失败不切换当前版本。
5. `pi-runtime.ts` 与公共布局代码解析指针。使用动态加载器的受管入口可加载指向版本或回退自带版本；每个入口的实际 SDK 来源还取决于它自己的导入方式，不只取决于项目依赖声明。

运行时目录为 `userData/pi-runtime`，包含发布、staging 和当前版本指针。清指针只删除指针，不等于删除所有运行时文件；扩展包由 Pi 包管理器维护，不与运行时发布目录混淆。

## 生命周期与边界

启动检查在窗口建立后后台进行。扩展自动更新仅在开关开启且启动检查满足条件时执行，手动检查不等于授权一轮静默安装；显式更新、运行时安装与指针修复有各自动作状态。

受管任务的启动、超时、输出和退出由主进程负责。正在使用的 SDK 宿主不会仅因磁盘指针改变就自动切换版本。运行时发布受版本策略约束，不承诺任意 SDK 版本与现有协议兼容，也不因为独立进程而获得额外系统权限。
