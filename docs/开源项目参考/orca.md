# Orca

返回[开源项目参考](README.md)。本文记录 `stablyai/orca` 的公开产品能力，不是 pi-desk 的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [stablyai/orca](https://github.com/stablyai/orca) |
| 官网 | [orca.dev](https://orca.dev)，README 的下载与文档入口为 [onorca.dev](https://www.onorca.dev/) |
| 文档 | [官方文档](https://www.onorca.dev/docs) |
| 定位 | 以任务工作树为中心，把多个编码 Agent、终端、编辑器、审阅与浏览器集中在同一桌面工作台 |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `main` |
| 最新 Release | `v1.4.240`，2026-10-25 04:02:08 UTC 发布 |
| Star / Fork | 105,356 / 6,658 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 8,561；非纯 Issue 数 |
| 桌面产物 | 最新 Release 提供 macOS arm64/x64 DMG 与 ZIP、Windows 安装 EXE、Linux arm64/x64 AppImage／DEB／RPM |
| 移动与远程形态 | iOS / Android Companion；官方文档另列 SSH、自托管 Orca Server 和自有云账户的 VM 执行形态 |

以上版本、统计与产物核实于 **2026-10-25**，仅为快照，来源为[仓库 API][o-meta]和[Release API][o-release]。移动端和远程形态来源于[产品说明][o-intro]与[手机文档][o-mobile]，不表示它们都包含在该次桌面 Release 资产中。

## 许可证

[根 LICENSE][o-license] 为 MIT，版权方为 Lovecast Inc.。允许使用、修改、分发和商用，需保留版权与许可声明；不提供软件保证。仓库 API 的 MIT 识别与实际文本一致。

根许可未列产品目录例外，但本次没有逐项审计 vendored 内容与全部依赖，不把 MIT 扩展为代理订阅、远端模型服务、品牌或第三方资产的授权。

**与本项目已有复用的关系**：pi-desk 的 [`licenses/orca-MIT.txt`](../../licenses/orca-MIT.txt) 明确记录部分富 Markdown 编辑实现改编自 Orca，并保留 MIT 文本。这是已存在的代码来源声明，不表示本项目已集成 Orca 工作树或多 Agent 编排，也不表示本次复制了外部代码。

## 技术栈

| 运行层 | 组成与作用 |
| --- | --- |
| 桌面 | Electron、TypeScript、electron-vite / electron-builder，承担本地桌面和发行载体 |
| 前端与编辑 | React；Monaco 用于代码编辑，Tiptap 相关依赖用于富文本；Marked、KaTeX、Mermaid 等参与内容展示 |
| 终端 | 包清单包含 xterm、headless、序列化和 WebGL 扩展；官方将终端分屏与重启后回看作为产品能力 |
| Agent 接入 | 支持终端 CLI Agent，并对支持的 Agent 提供 Chat UI；包声明另包含 Claude Agent SDK。不能推定所有 Agent 使用同一种 SDK 或相同深度的集成 |
| 远程与移动 | 桌面持有工作区与 Agent；手机经配对接入，支持 LAN 或 Relay 等可达路径；SSH / Server 是独立运行形态 |

依据：[包声明][o-package]、[官方介绍][o-intro]、[README 功能入口][o-readme]、[移动端文档][o-mobile]。不将 README 的“Ghostty-class”描述当作已经核实其终端使用 Ghostty 引擎。

## 能力清单

按[官方文档导航分组][o-nav]组织，具体能力取自产品说明和相应功能文档。下表是已读取资料覆盖的能力，不宣称穷尽每日发布内容。

| 官方分组 | 已公开能力及边界 |
| --- | --- |
| Model | 每任务 Git worktree；项目分组、标签／面板／分屏、快速打开；可从分支或任务来源创建工作区 |
| Agents | 多 CLI Agent 并行；支持的 Agent 可使用 Chat UI；账号切换与用量／限流状态展示 |
| Review | Git 差异、提交和 PR 工作流；GitHub / Linear 等任务关联；Annotate AI Diff 把行级意见批量发回指定 Agent |
| Editing | 文件树、代码编辑、文件或图片拖入 Agent；Markdown、图片及 PDF 等仓库内容预览 |
| Browser | 浏览器面板与 Design Mode；点击页面元素，发送 HTML、计算样式、局部截图及可获得的源码位置 |
| Terminal | 终端分屏、滚动历史；并行运行 CLI Agent 与普通命令 |
| Remote & SSH | SSH 工作区、远程文件／Git／终端、端口转发；自托管 Server 和自有 VM 形态 |
| CLI & Automation | Orca CLI 操作工作树和界面；Computer Use 操作可见桌面界面。CLI 产品入口不等于任意 Agent 都有无限系统权限 |
| Mobile | 查看多个主机的工作区与 Agent；Chat UI 或终端、文件树、回复和附件、快捷命令、源代码管理、账号与用量；并非完整移动 IDE |
| Notifications & Inbox | 完成／待输入通知、未读状态、活动入口；手机可接收推送 |
| Settings / Privacy & Telemetry | 工作区与快捷键配置、遥测说明及退出选项；本次没有审计遥测实现或传输内容 |

### 工作树与手机的关键边界

- [工作树文档][o-worktrees]描述独立分支与文件目录，但依赖目录可以共享或符号链接，忽略文件可以复制；**Git 工作树不等于 OS 沙箱，也不保证共享路径与外部资源互不影响**。
- 工作树创建在后台执行并展示进度；归档、休眠、删除与删除后保留未合并分支是不同操作，不应合成一个“关闭”。
- [手机文档][o-mobile]区分 LAN 与 Relay 配对：Relay 需要登录，LAN 是另一条路径；桌面仍是会话与 Agent 的真源，不是手机新建一个云 Agent。
- 手机支持文件树和部分 Git 写操作，不是只有只读监控；其权限面明显不同于本项目的受限手机聊天网页。

## 与本项目的对照

基准为 pi-desk 内置能力。可在用户终端运行某个 CLI，不等于已实现该 Agent 的原生聊天、权限、账号或用量集成。外部侧为官方文档与包声明事实，不据此作性能或实现质量排名。

### 实质重合

| 能力 | Orca 对应 | 与 pi-desk 的关键差异 |
| --- | --- | --- |
| 本地文件浏览、源码与 Markdown 编辑 | 文件树、代码编辑、仓库内容预览 | pi-desk 源码用 CodeMirror，Markdown 用 Tiptap 与安全回写；Orca 声明 Monaco 与富文本依赖。编辑目标重合，不意味着编辑状态和保存策略相同。见[文件模块][p-files] |
| 项目终端与历史回看 | Terminal、滚动历史 | pi-desk 用独立 PTY 守护进程、快照和序号确认接回；Orca 将终端组织在工作树与分屏内。仅比较交互目标，不推定后台持久化协议相同。见[终端模块][p-terminal] |
| Git 状态、差异和提交 | Review / Source Control | pi-desk 通过系统 Git 和固定 IPC 操作状态、差异、暂存、提交、拉取和推送；Orca 把它们进一步关联工作树及 PR。见[Git 模块][p-git] |
| 全局／项目快捷终端命令 | Quick Commands 的 Terminal Command | pi-desk 新建终端后写入用户配置命令；Orca 还支持 Agent Prompt 和移动端同步，不把这些额外入口计入相同能力 |

### 部分重合

| 能力 | 重叠环节 | 不可视作替代的原因 |
| --- | --- | --- |
| 多 Agent / 多会话 | 都能并行处理项目任务 | pi-desk 核心是 Pi SDK 多运行实例，不自动隔离项目文件；Orca 以工作树和多种 CLI Agent 组织任务 |
| 手机继续对话 | 远程查看进展并回复 | pi-desk 是局域网 HTTP 直连的网页，桌面开启后自动显示二维码，手机扫码自动连接并访问全部已登记项目，提供聊天及问题回应；Orca 是 iOS/Android Companion，包含多主机、终端、Git、账号和 Relay 路径 |
| 差异审阅 | 都能看到变更与行差异 | pi-desk 有 `GitDiffView`，但没有内置行级评论归集与批量发回 Agent 的闭环；Orca 的 Annotate AI Diff 还维护评论及处理状态 |
| 供应商与用量 | 都能展示模型或用量信息 | pi-desk 管 Pi Provider 凭据与会话 token／费用；Orca 面向外部 Agent 账号及订阅限流，二者的统计对象与认证边界不同 |

### 对方独有

| 类别 | Orca 已公开能力 | pi-desk 当前边界 |
| --- | --- | --- |
| 工作树编排 | 创建、分支、任务来源、归档／休眠／删除、结果审阅 | 内置工作树管理无；现有 Git 模块明确不创建隔离工作树 |
| 跨主机执行 | SSH 工作树、Server、远程文件与终端 | 无等价内置执行后端；手机入口仍驱动当前电脑，不是远程项目宿主 |
| 浏览器与设计上下文 | Browser / Design Mode | pi-desk 现已支持内置浏览器工作区标签、导航控制与 DevTools 调试；点击选取页面元素并直传 Agent 上下文的 Design Mode 暂未内置 |
| 第三方任务集成 | GitHub / Linear 等任务与工作树、PR 关联 | 内置任务提供商与 PR 工作台无；系统 Git 的 pull/push 不等于这些集成 |
| 产品自动化 CLI | 操作 Orca 工作树、浏览器和可见界面 | pi-desk 没有等价的对外工作台 CLI；Pi Agent 工具不等于桌面自动化协议 |

### 尚不能判定为“无对应”的项

pi-desk 的[声明式生成式界面][p-genui]含文档版本、节点补丁及参数回填。本次没有核实 Orca 是否存在完全等价的能力，**不因其公开功能页未列出而宣称没有**。浏览器设计上下文和富 Markdown 也不自动构成对应能力。

**判断边界**：工作树目录与多 Agent 覆盖面是官方公开机制；“因此安全性／产出质量／吞吐优于 pi-desk”并非已确认结论。没有运行双方产品或进行量化对比。

## 可借鉴方向

优先借鉴工作流，不整体搬入 Orca 的工作区模型。下列可行性是基于现有依赖与调用边界的设计判断。

| 方向 | 可行性 | 依据与依赖代价 |
| --- | --- | --- |
| 将差异评论批量组织成修改请求 | 低 | 已有差异展示和发送消息基础，但缺评论身份、变更后锚点、批次和处理状态，需独立审阅产品设计；不必为此更换 CodeMirror |
| 显示后台任务的创建中／失败／可取消状态 | 高 | 现有会话运行状态与 Vue 展示能覆盖状态表达，无须新增框架；这里只借鉴可见状态，不包含新增工作树创建能力 |
| 任务级 Git worktree 隔离 | 低 | 系统 Git 已存在，但需要重新设计项目身份、文件根、会话／终端归属、共享目录与删除边界；已有 Git 依赖不代表引入成本低 |
| 浏览器元素到 Agent 上下文 | 低 | Electron 具备页面载体基础，但需要独立浏览器生命周期、页面权限、调试通道及捕获／附件链，不是普通文件预览扩展 |
| 先明确手机能力白名单，再考虑扩大入口 | 高 | 现有设备身份校验与受限会话接口已提供边界，可在当前契约上说明支持范围，无新增依赖；当前为局域网扫码直连，内置公网 Relay、多主机和移动原生客户端不在该评级内 |

不照搬的结论：不把工作树说成沙箱，不把所有 CLI Agent 说成具有相同原生集成，不为“对齐 Orca”直接增加公网服务或第三方账号体系。

## 信息来源

### 对方官方资料

- [产品介绍][o-intro]、[README 功能入口][o-readme]、[官方导航][o-nav]：定位和能力分组。
- [工作树][o-worktrees]：生命周期、共享路径、后台创建与任务关联。
- [移动端][o-mobile]：配对、Relay、终端、Git 和桌面真源。
- [Design Mode][o-design]、[Annotate AI Diff][o-annotate]：页面上下文与审阅闭环。
- [包声明][o-package]、[根 LICENSE][o-license]。
- [仓库 API][o-meta]、[最新 Release API][o-release]：2026-10-25 快照。

### 本项目事实出处

- [文件模块][p-files]、[`CodeMirrorEditor.vue`](../../src/renderer/src/editor/components/CodeMirrorEditor.vue)：编辑器和文件操作边界。
- [终端模块][p-terminal]：PTY 守护进程、历史和全局／项目快捷命令。
- [Git 模块][p-git]、[`src/main/git/git-command.ts`](../../src/main/git/git-command.ts)、[`src/shared/git-api.ts`](../../src/shared/git-api.ts)：`GitRunOptions`、固定 Git 通道和请求范围。
- [会话模块][p-session]、[`src/sdk-host/session-runtime.ts`](../../src/sdk-host/session-runtime.ts)：Pi SDK 会话及内置工厂装配；[子代理初步设计](../subagents-design.md)不是实现清单。
- [手机模块][p-mobile]、[`src/main/lan-remote/manager.ts`](../../src/main/lan-remote/manager.ts)、[`src/main/lan-remote/server.ts`](../../src/main/lan-remote/server.ts)、[`src/shared/lan-remote-api.ts`](../../src/shared/lan-remote-api.ts)：`LanRemoteManager`、`LanServer` 与共享契约中的局域网入口、自动扫码连接及设备身份边界。
- [生成式界面模块][p-genui]、[`package.json`](../../package.json)、[既有 Orca 许可声明](../../licenses/orca-MIT.txt)。

[o-intro]: https://github.com/stablyai/orca/blob/main/docs/site/content/docs/index.mdx
[o-readme]: https://github.com/stablyai/orca/blob/main/README.md
[o-nav]: https://github.com/stablyai/orca/blob/main/docs/site/content/docs/meta.json
[o-worktrees]: https://github.com/stablyai/orca/blob/main/docs/site/content/docs/model/worktrees.mdx
[o-mobile]: https://github.com/stablyai/orca/blob/main/docs/site/content/docs/mobile.mdx
[o-design]: https://github.com/stablyai/orca/blob/main/docs/site/content/docs/browser/design-mode.mdx
[o-annotate]: https://github.com/stablyai/orca/blob/main/docs/site/content/docs/review/annotate-ai-diff.mdx
[o-package]: https://github.com/stablyai/orca/blob/main/package.json
[o-license]: https://github.com/stablyai/orca/blob/main/LICENSE
[o-meta]: https://api.github.com/repos/stablyai/orca
[o-release]: https://api.github.com/repos/stablyai/orca/releases/latest
[p-files]: ../modules/files-editor.md
[p-terminal]: ../modules/terminal-commands.md
[p-git]: ../modules/git.md
[p-session]: ../modules/sessions-chat.md
[p-mobile]: ../modules/lan-remote.md
[p-genui]: ../modules/genui.md
