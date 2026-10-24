# 公共记录

本页唯一登记跨模块公共设施、混合职责文件及全局上下文。模块引用本页记录，不重新认领文件。源码路径以仓库根为基准。

## F-assembly：进程与页面组装（混合）

| 文件 | 真实职责与模块使用范围 |
| --- | --- |
| `src/main/index.ts` | 只准备入口步骤：准备协议与应用目录、取单实例锁、注册生命周期，随后把启动编排交给 `app-lifecycle.ts`。不含业务逻辑 |
| `src/main/app-lifecycle.ts` | 便携数据目录、登录 shell PATH、单实例锁、窗口就绪后按固定顺序调用各能力 `ipc.ts` 注册器、窗口全部关闭与退出链、启动时的扩展自动更新 |
| `src/main/window.ts` | 唯一窗口的创建、主题与标题栏配色、导航与权限限制、单实例聚焦 |
| `src/main/window-channel.ts` | 窗口引用、向页面投递事件与全部业务广播、系统目录选择；不持有业务实例，终端状态来源由组合根注册 |
| `src/main/asset-protocol.ts` | 应用协议注册、页面地址解析、目录越界判定与生产 CSP |
| `src/main/services.ts` | 主进程业务实例的唯一装配处（配置、项目、信任、会话、终端、供应商、资源、更新、生成式界面） |
| `src/main/ipc/dispatch.ts` | IPC 注册包装、调用者校验、有界标识与 MCP 服务器名校验 |
| `src/preload/index.ts` | 只合并各域 Api 并暴露 `window.desktop`，不含 channel 调用与校验 |
| `src/preload/*.ts`（域文件） | 按业务域各一个文件（`desktop`、`projects`、`sessions`、`runtime`、`terminal`、`git`、`preferences`、`providers`、`updates`、`trust`、`genui`），各自承载固定 channel 调用、声明字段载荷重建、响应与事件校验、订阅释放 |
| `src/renderer/src/App.vue` | 页面组合根：只装配外壳骨架、弹层宿主与启动编排 |
| `src/renderer/src/shell/components/AppShell.vue` | 布局骨架：顶部栏、侧栏与窄窗遮罩、工作区槽、右侧面板；持有窄窗与侧栏开合状态 |
| `src/renderer/src/shell/components/WorkspaceView.vue` | 工作区：标签条、四条操作失败提示、对话／终端／文件面板层与空态 |
| `src/renderer/src/shell/components/AppDialogHost.vue` | 弹层宿主：会话中断、信任、项目移除、会话删除、脏文件关闭、会话选择、快捷命令编辑与删除、Extension、更新提示 |
| `src/renderer/src/shell/use-app-startup.ts` | Store 初始化与释放顺序、打开意图的补提交、标签侧会话状态视图的注册、生成式参数持久化初始化与退出落盘、项目切换与会话落盘的补读 |
| `src/renderer/src/env.d.ts` | 将各域 Api 合成为可缺失的 `Window.desktop`；仅环境类型，不承担业务请求 |

已知消费者覆盖总览列出的业务模块。IPC 参数与调用者校验、preload 验证和渲染服务异常转换是不同边界，不能因存在相似代码就省掉任一边界。单窗口事件只投递给受信任窗口。

## F-runtime-state：综合 Runtime 状态（混合）

| 文件 | 模块相关符号与范围 |
| --- | --- |
| `src/renderer/src/sessions/stores/runtime.ts` | 只做装配与初始化／释放编排，不含业务状态；按原成员名转发到下列四个切片 |
| `src/renderer/src/sessions/stores/runtime-core.ts` | 前台实例身份、Prompt／回退／中止／压缩等动作状态、投影分片与后台留底、`send`、`rewind`、`compact`、`stopOperation`、同步与快照收敛 |
| `src/renderer/src/sessions/stores/runtime-history.ts` | 历史分页、展开轮次的原文与续段状态、缓存淘汰；读取目标与会话键由调用方注入 |
| `src/renderer/src/sessions/stores/runtime-models.ts` | 可用模型能力清单、Runtime 未就绪时的候选预读、Pi 默认模型、当前会话 `switchModel` |
| `src/renderer/src/sessions/stores/runtime-model-display.ts` | 对话页隐藏模型偏好、乐观更新与串行写回、失败回滚 |
| `src/shared/runtime-api.ts` | 只再导出 `./runtime/`，外部导入路径不变 |
| `src/shared/runtime/status.ts` | 运行目标、状态、错误与命令（Prompt、回退、压缩、切换模型） |
| `src/shared/runtime/projection.ts` | 消息／工具／历史／活动／用量／速率投影 |
| `src/shared/runtime/models.ts` | 模型标识、摘要与 agent 能力清单 |
| `src/shared/runtime/resources.ts` | 资源预读、诊断与 MCP 状态、探测、配置、命令 |
| `src/shared/runtime/api.ts` | `RuntimeApi` 桥接接口：聚合上述四组方法，跨域类型在此引用 |

请求目标的运行实例与绑定代际由主进程登记，不等同于标签键或可变的当前项目；按会话读取历史不带这两项，由主进程判定该会话走绑定路径还是日志路径。后台投影留底是页面展示缓存，SDK 会话和历史文件仍是另一层生命周期。`stores/runtime.ts` 只是装配门面：会话运行、历史缓存、模型能力与模型展示偏好分别落在 `runtime-core`、`runtime-history`、`runtime-models`、`runtime-model-display`，门面保留原有公开成员与历史类型再导出，消费者不需要改调用点。

## F-config：Desktop 配置（混合）

唯一归属文件：`src/main/config/desktop-config-store.ts`。

| 使用者 | 涉及字段／入口 |
| --- | --- |
| 项目与信任 | 项目列表、当前项目、`projectTrust`、按项目清除快捷命令 |
| 应用外壳 | 窗口位置、尺寸、最大化状态 |
| 偏好 | 界面主题、侧栏、右侧面板、Markdown 默认视图、快捷输入 |
| 供应商与认证 | 安装级设备标识、隐藏模型列表 |
| 终端与快捷命令 | 全局与项目范围命令列表 |
| 更新与生成式界面 | 扩展自动更新、生成式 UI 开关 |

文件位于 `userData/desktop-config.json`。全部读写串行进行，保存前比对已加载的磁盘文件标识；读失败可进入只读降级，结构损坏走备份重建。其他服务通过同一个实例访问，不另行直接覆盖此文件。应用单实例锁由 `src/main/app-lifecycle.ts` 的 `acquireSingleInstance` 建立。

## F-sidebar：项目会话树（混合）

| 文件 | 范围与消费者 |
| --- | --- |
| `src/renderer/src/projects/components/ProjectSidebar.vue` | 侧栏编排：滚动、分页、当前会话可见性、展开折叠、项目／会话菜单；应用外壳接收移除和删除意图，会话及工作区模块接收打开意图 |
| `src/renderer/src/projects/components/ProjectRow.vue` | 项目行排布（展开控件、名称与路径、折叠时的活动标记、新建与更多操作），动作以事件交回编排层 |
| `src/renderer/src/projects/components/SessionRow.vue` | 会话行与未绑定实例行的统一排布：状态槽、标题与状态 chip、相对时间、悬停操作 |
| `src/renderer/src/projects/components/SessionStatusMark.vue` | 运行状态标记：执行中为旋转环，需留意为实心点加光晕，空闲为中性点；装饰性输出，读屏文案由调用方提供 |
| `src/renderer/src/projects/sidebar-tree.ts` | 将项目、项目内会话列表、运行实例与读取状态转换为侧栏树数据，并给出状态文案、chip 与视觉分级映射 |

项目节点不拥有会话文件；删除项目记录、删除会话和关闭标签是不同动作。此处同时服务项目与会话，不登记为纯通用树控件。

## F-process：受管进程与 SDK 公共设施（共享）

| 文件 | 共享职责 | 已知消费者 |
| --- | --- | --- |
| `src/main/shared/managed-entry-runner.ts` | 一次性入口输出分帧、超时、退出判定、单飞执行槽 | 版本检查、扩展更新、运行时安装 |
| `src/main/shared/pi-cli-process.ts` | 固定产物定位与启动，只返回子进程句柄 | 资源预读、MCP 探测、版本与更新编排 |
| `src/main/shared/pi-paths.ts` | 固定 Pi agent 目录与受管环境；注入 SDK 入口 | 会话文件、配置、认证、SDK 宿主与辅助入口 |
| `src/main/shared/shell-path.ts` | 图形界面启动时补齐登录 shell 的 PATH | 应用启动与后续外部命令 |
| `src/shared-process/process-tree-termination.ts` | 跨平台进程树终止 | 受管入口、资源探测、认证及终端守护进程 |
| `src/shared-process/runtime.ts` | SDK 发布目录布局、当前版本指针、SDK 入口解析、动态加载及自带版本回退 | 主进程运行时解析、SDK 宿主、认证、CLI、版本检查、安装入口 |

前四行位于 `src/main/shared/`，后两行位于 `src/shared-process/`。`runtime.ts` 与 `src/entries/runtime-install/index.ts` 不是同一职责：前者本身不下载、不安装，只维护发布目录布局与当前版本指针。

## F-platform：文件锁、外链与基础错误（共享）

| 文件 | 职责与已知使用者 |
| --- | --- |
| `src/main/shared/file-lock.ts` | Pi 配置写入的文件锁边界；供应商条目与默认模型管理使用 |
| `src/main/shared/external-url.ts` | 受控 http(s) 外链打开；主进程桌面外链接口及认证流程使用 |
| `src/shared/desktop-api.ts` | 应用信息、外链请求及跨域基础错误；各域契约引用错误定义 |
| `src/shared/dev-server.ts` | 从传入环境值解析开发端口；构建配置与主进程页面地址共用 |
| `src/renderer/src/editor/services/external-url.ts` | 文件内文档链接打开的统一桥接封装；主进程执行协议与凭据检查 |

主进程业务结果、桥接通信失败、调用者权限拒绝是不同失败来源。声明类型不替代实际跨进程载荷校验。

## F-ui：前端共享展示（共享）

| 文件 | 职责与已知使用者 |
| --- | --- |
| `src/renderer/src/ui/AppButton.vue` | 原生按钮及统一视觉变体；业务组件共用 |
| `src/renderer/src/ui/AppSelect.vue` | 自定义选择器；业务表单共用 |
| `src/renderer/src/ui/ConfirmDialog.vue` | 通用确认弹层；应用外壳、聊天列表、文件编辑、Git、供应商、资源、终端设置与快捷命令消费 |
| `src/renderer/src/ui/anchored-popup.ts` | 浮层定位与生命周期；标签、菜单、文件编辑、Git、侧栏与基础选择器消费 |
| `src/renderer/src/ui/clipboard.ts` | 复制文本与错误结果；聊天、文件、供应商、资源、终端、更新与生成式界面消费 |
| `src/renderer/src/ui/MarkdownContent.vue` | 安全 Markdown 展示、数学与代码／表格交互；聊天正文的 Thinking、回答与技能正文消费 |
| `src/renderer/src/ui/markdown.ts` | 聊天 Markdown 解析与清洗，供 Markdown 展示组件使用 |
| `src/renderer/src/ui/markdown-shared.ts` | 代码、表格与 HTML 转义的共同渲染；聊天及文件 Markdown 消费 |
| `src/renderer/src/ui/markdown-math.ts` | 数学解析与 KaTeX 渲染；聊天、文件预览及富文本公式消费 |
| `src/renderer/src/ui/project-entry-drag.ts` | 项目条目拖拽载荷与终端插入文本；文件树与终端视图共用 |
| `src/renderer/src/ui/relative-time.ts` | 相对时间文案；侧栏会话行与提交历史共用 |
| `src/renderer/src/ui/forked-sessions.ts` | 分叉会话折叠；侧栏项目树与会话选择器共用 |

`src/renderer/src/ui/` 是共享展示目录，只收被多个能力重复使用的无业务状态代码：展示组件、Markdown 与数学渲染、剪贴板、浮层定位、相对时间与分叉折叠。仅服务单一能力的文件不因位置相同就视为共享：`sessions/clock.ts` 服务聊天计时，`editor/` 的富文本实现只服务文件编辑。

## F-style：全局主题与业务样式（混合）

页面样式入口为 `src/renderer/src/assets/main.css`，负责引入 Tailwind、KaTeX、本地基础样式及能力样式。主题令牌与基础规则归 `src/renderer/src/assets/styles/base.css`；能力规则按样式归属分别位于 `src/renderer/src/assets/styles/editor.css`、`sessions.css`、`git.css`、`shell.css`、`projects.css`、`workspace.css`、`preferences.css` 与 `ui.css`。这些样式均由页面入口统一加载，不由各能力组件重复导入。

`src/renderer/src/assets/genui.css` 仍由生成式界面模块独立维护。全局主题与主进程窗口背景／覆盖层颜色存在同步关系，改动不只影响单个组件。

## F-build：构建与发行上下文

| 文件 | 输入／作用 |
| --- | --- |
| `package.json` | 应用入口、依赖、开发、构建、类型检查、既有测试及发行脚本 |
| `package-lock.json` | npm 解析结果；与依赖声明共同确定安装内容 |
| `tsconfig.json` | Node 与页面共享的严格类型选项 |
| `tsconfig.node.json` | 主进程、preload、宿主、终端守护进程、跨进程设施、一次性入口、共享契约与现有 TS 测试的检查范围 |
| `tsconfig.web.json` | Vue 页面与共享契约的浏览器检查范围 |
| `electron.vite.config.ts` | `src/main/index.ts` → `out/main/index.cjs`；`src/preload/index.ts` → `out/preload/index.cjs`；`src/renderer/index.html` → 页面产物 |
| `vite.auth-helper.config.ts` | `src/auth-helper/index.ts` → `out/auth-helper/index.mjs` |
| `vite.sdk-host.config.ts` | SDK 宿主、CLI、版本检查、扩展更新、运行时安装五入口 → `out/sdk-host/` 下各自 ESM 产物 |
| `vite.terminal-daemon.config.ts` | `src/terminal-daemon/index.ts` → `out/terminal-daemon/index.cjs`；原生 PTY 与终端依赖保留外部引用 |
| `electron-builder.yml` | 随包文件、图标、平台发行目标与输出目录；生产依赖随应用分发 |
| `scripts/start-dev.cmd` | 对应平台的开发启动包装 |
| `scripts/start-dev.sh` | 对应平台的开发启动包装 |
| `scripts/package-win.cmd` | 对应平台的便携出包包装 |
| `scripts/package-mac.sh` | 对应平台的便携出包包装 |
| `scripts/package-portable.mjs` | 按主机平台／架构调用打包器，准备镜像默认值及 PTY 助手权限 |
| `scripts/fix-node-pty-permissions.mjs` | 修正 PTY 预编译助手执行权限，供开发与发行准备使用 |
| `build/icon.svg` | 应用图标源 |
| `build/icon.ico` | 预生成的发行图标资源 |
| `licenses/emojibase-MIT.txt` | 对应第三方许可声明 |
| `licenses/mermaid-MIT.txt` | 对应第三方许可声明 |
| `licenses/orca-MIT.txt` | 对应借鉴代码的许可声明 |
| `.gitignore` | 排除依赖、编译输出、发行输出与平台元数据 |

构建入口与业务模块不是一一对应；同一个 SDK 宿主构建配置输出多个独立运行入口。产物目录不能当源码归属记录，便携应用的 `data/` 更不能当构建缓存。

## 关系覆盖边界

消费者依据仓库 `src/` 的静态导入、IPC 注册、Store 调用、模板与构建入口建立。动态加载的 SDK 与第三方扩展内部调用不在消费者清单中；公共记录不声称穷尽应用外部使用者。源码只定位而未逐函数读取的辅助文件，由所属模块说明其职责边界，不据此推断行为正确性。
