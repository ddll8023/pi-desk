# EditHere

返回[开源项目参考](README.md)。本文记录 `Inginnng/EditHere` 的公开产品形态。**项目主体采用 PolyForm Noncommercial 1.0.0 源码可用许可，不是 OSI 意义上的开源软件**；收录用于能力对照，不表示其主体实现可以自由商用或代码移植。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [Inginnng/EditHere](https://github.com/Inginnng/EditHere) |
| 官网 | 无独立产品官网；以 GitHub 仓库为发布、文档及更新中心，README 指向 [Gitee 镜像][eh-gitee] |
| 文档 | [使用指南][eh-userguide]、[AI 与命令行][eh-agentcli]、[Web 版文档][eh-webdocs] |
| 定位 | 面向 AI 界面迭代的本地视觉反馈工具：截图、圈画、拖拽调整布局或视频暂停打点，生成 AI 可直接执行的结构化反馈 |
| 主语言（仓库统计） | C++（桌面核心） |
| 默认分支 | `codex/native` |
| 最新 Release | `v0.12.1`，2026-10-25 08:46:15 UTC 发布 |
| Star / Fork | 635 / 54 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 5 |
| 分发形态 | Windows 安装器与免安装 ZIP；macOS 通用 DMG；Linux AppImage；独立 CLI；离线单文件 Web 与 Web Agent 包 |
| 本次 Release 资产 | `EditHere-win-x64-setup.exe`、`EditHere-win-x64.zip`、`EditHere-macos-universal.dmg`、`EditHere-linux-x86_64.AppImage`、`edithere-cli`、`EditHere-web.zip`、`EditHere-web-agent.zip` 及校验和 |

以上版本、统计与发布产物核实于 **2026-10-26**，仅为快照，依据[仓库 API][eh-meta]和[Release API][eh-release]。

## 许可证

### 主体许可

[根 LICENSE][eh-license] 为 **PolyForm Noncommercial License 1.0.0**（SPDX: `PolyForm-Noncommercial-1.0.0`），版权方为 `2026 Inginnng`。核心条款要点：

- **授权范围**：允许个人非商业用途免费使用、修改、基于其创作新作品及分发副本（包括修改版）；允许慈善组织、教育机构、公共研究与政府机构免费使用，无论经费来源。
- **商业限制**：商业用途明确**不在授权范围内**。凡以商业优势或金钱报酬为目的的活动、营利性企业经营业务部署或集成、打包随附于对外销售/收费的产品或以其提供付费服务，均须取得作者书面商业授权（联系方式见 [COMMERCIAL-LICENSE.md][eh-commercial]）。
- **义务要求**：分发时必须随附许可文本（或 URL）及保留以 `Required Notice:` 开头的版权声明行（保留项目根的 `LICENSE` 与 `NOTICE`）。
- **商标与品牌**：[TRADEMARK-POLICY.md][eh-trademark] 明确保留 EditHere 名称、标识与品牌元素所有权，未经许可不得以官方名义宣传或暗示背书。
- **元数据冲突**：GitHub API 将许可识别为 `Other / NOASSERTION`，系检测器未内置标准 PolyForm SPDX 匹配；实际权利边界以仓库实际 `LICENSE`、`LICENSING.md` 与 `NOTICE` 为准。

### 第三方与独立组件

- 桌面端依赖 Qt 6（LGPLv3）、MinGW、zlib 等开源组件，遵循各自许可证；EditHere 许可不削减第三方的 LGPL 权利。
- 连接器包含 Node.js MCP SDK（遵循其自身 MIT 开源协议）。

**本项目借鉴边界**：`pi-desk` 主体采用 MIT 许可。**严禁直接复制或移植 EditHere 的 C++ 原创代码及图形资产**；仅借鉴其对外公开的产品交互理念、视觉反馈 Schema 与工具通信契约，或作为独立的外部工具通过 MCP / CLI 接口配合使用。

## 技术栈

| 运行层 | 组成与作用 |
| --- | --- |
| 桌面端核心 | C++20、CMake 3.24+、Qt 6.8（Core、Gui、Widgets、Svg、Network、Concurrent、Multimedia、MultimediaWidgets），承载窗口、图像画布与本地事件 |
| 操作系统接口 | **Windows**：Win32 GDI/DWM 抓屏，嵌入式 PowerShell 驱动 `Windows.Media.Ocr`；<br>**macOS**：Objective-C++、Cocoa、ScreenCaptureKit 截屏、Vision 框架 OCR、Carbon/ApplicationServices；<br>**Linux**：X11/Xtst、AT-SPI2、PipeWire 0.3+ 与 XDG Desktop Portal 选区捕获 |
| 命令行与通信 | 原生 `edithere-cli`（C++），通过本地套接字与桌面 GUI 通信，提供 `annotate`、`open`、`capture`、`export`、`status` 等命令并输出单行 JSON |
| Agent 接入与 MCP | Node.js 18+ 编写的 `connector/`（`edithere-mcp`），提供基于 stdio 的 MCP 协议服务；支持通过 `pageContext` 注入页面上下文 |
| 网页端与 MCP Apps | 单文件离线 HTML（Vanilla JS + HTML5 Canvas），集成官方 MCP Apps SDK（`_meta.ui.resourceUri` 宿主内嵌），可在浏览器本地完成选块、批注与大爆炸拖拽 |

依据：[CMakeLists.txt][eh-cmake]、[package.json][eh-connector-pkg]、[Web README][eh-webdocs]、[AI 命令行文档][eh-agentcli]。

## 能力清单

依据官方文档与已核实的实现划分：

| 官方分组 / 功能 | 已公开能力与技术边界 |
| --- | --- |
| 截图 · 智能选块 · 贴图 | 全局快捷键呼出屏幕冻结；基于色块和操作系统可访问性边界识别候选元素；滚轮切换容器层级；放大镜像素取色（RGB/HEX/HSV/HSL）；跨会话选区历史回溯；多张置顶贴图。 |
| 文字识别（OCR） | 使用平台内置无网络离线 OCR（Windows OCR / macOS Vision / Linux Tesseract），框选后逐行提取并可原图高亮对应行，结果可选回填至批注的 `ocrtext` 字段。 |
| 长截图 | 滚动区域双向拼接与实时预览，自动去重固定顶栏；macOS/Linux/Windows 各自对接原生捕获后端。 |
| 批注系统 | 智能选块批注、点批注（像素坐标点）、矩形框选批注、针对整图的全局意见；每条意见独立编号并与画面坐标联动。 |
| 大爆炸（组件布局调整） | 图像分块拆解成独立图层，支持拖拽移动、等比缩放、精确坐标录入；移动后原始位置透明留空，自动计算位移向量 `dx/dy` 与缩放比例 `scaleX/scaleY`。 |
| 视频按时间点批注 | 视频载入与时间轴控制；暂停于目标帧进行批注与分块；不同时间戳保留独立批注帧，输出带时间戳与帧画面的 `video-feedback-1`。 |
| 一键交给 AI | 导出面向对象的结构化反馈 JSON（当前标准为 `feedback-minimal-4`）；支持同目录图片文件（`file`）、Base64 内嵌（`embedded`）或纯描述（`none`），并可选输出带编号的 JPEG 示意预览图。 |
| 离线 Web / MCP Apps | 双击单 HTML 离线运行；或在支持 MCP Apps 的 Agent 工具内以内嵌网页形态展示，通过 SDK 桥接完成保存与消息投递。 |

## 与本项目的对照

基准为 pi-desk 当前内置实现。两者定位不同：pi-desk 是**全流程桌面编码工作台**，EditHere 是**专用型本地视觉反馈输入工具**。

### 实质重合

| 能力 | EditHere 对应 | 与 pi-desk 的关键差异 |
| --- | --- | --- |
| 外部工具与 Agent 交互契约 | `edithere-mcp`、`edithere-cli annotate` | 两者均遵循标准 Agent 工具调用与等待协议：pi-desk 可管理并调用外部 MCP/CLI 工具；EditHere 提供封装好的 MCP 工具和等待用户提交的 CLI 阻塞调用链。见[资源与 MCP 模块][p-resources] |

### 部分重合

| 能力 | 重叠环节 | 不可视作替代的原因 |
| --- | --- | --- |
| 结构化交互与消除歧义 | 用户与 Agent 之间的结构化意图传递 | pi-desk 的生成式界面（GenUI）由 Agent 主动生成声明式文档让用户填写参数回填；EditHere 是由用户在已有界面截图上圈画、位移并生成结构化 JSON 反馈给 Agent。传递方向相反，不能互相替代。见[生成式界面模块][p-genui] |
| 远程与移动访问 | 跨设备或轻量化访问 | pi-desk 内置局域网 HTTP 扫码服务，手机直接连接并访问完整会话；EditHere 网页版是单文件静态 Canvas 工具与 MCP 嵌入页，不具备会话宿主或局域网配对网络服务。见[手机访问模块][p-mobile] |
| 视觉批注 | 点／框定位、编号意见及图片交给 AI | pi-desk 限于内置浏览器的固定画面与网页元素，意见在原位悬浮编辑并加入指定对话草稿；不提供通用图片导入批注、图像分块和布局拖拽，也不实现 EditHere 的反馈格式。见[工作区批注][p-workspace] |

### 对方独有

| 类别 | EditHere 已公开能力 | pi-desk 当前边界 |
| --- | --- | --- |
| 原生屏幕捕获与长截图 | 跨平台系统底层抓屏、滚动拼图、全局快捷键、像素级放大镜取色 | pi-desk 仅内置网页可见区域截图，不包含系统抓屏、长截图与取色；常规图片仍可作为对话附件导入。 |
| 图像分块与大爆炸拖拽 | 图像分块识别、组件位移向量计算与留空导出 | pi-desk 的浏览器点框批注不拆解图像图层，也不提供组件拖拽、缩放与布局重建。 |
| 本地离线 OCR | 调用系统原生 Vision / Windows.Media 离线提取图像文字并回填 | pi-desk 无内置图像 OCR 文字识别引擎。 |
| 视频时间轴标注 | 逐帧播放暂停、多时间戳打点及视频复合反馈 JSON | pi-desk 不含视频时间轴标注与帧管理功能。 |

### 本项目独有

| 类别 | pi-desk 当前能力 | EditHere 边界 |
| --- | --- | --- |
| Coding Agent 完整工作台 | Pi SDK UtilityProcess 隔离宿主、多项目信任、多会话并行与活动投影 | EditHere 自身不调用大模型，不编排 Agent 生命周期。 |
| 常驻终端与流控接回 | 独立 PTY 守护进程、历史快照恢复、序号流控 | EditHere 无终端仿真与命令行执行宿主能力。 |
| 代码与富文本编辑 | CodeMirror 源码高亮编辑、Tiptap 富 Markdown 回写 | EditHere 专注于像素画布与批注，不提供源代码阅读与编辑。 |
| 版本控制 (Git) | 工作区状态、差异审阅、暂存、提交、拉取与推送 | EditHere 无 Git 仓库管理能力。 |
| 供应商与模型凭据管理 | 统一管理 Pi Provider 鉴权、密钥与默认模型切换 | EditHere 不涉及模型服务凭据。 |

### 尚不能判定为“无对应”的项

本次未核实 EditHere 网页端在大规模长视频标注下的内存与性能边界，亦未核实其 Linux AppImage 在不同 Wayland 合成器（如 KDE Plasma / Sway）下的滚动截图兼容性；保持未知，不作推测。

## 可借鉴方向

范围限定为公开交互范式与数据协议；**不从非商业主体直接复制代码**。

| 方向 | 可行性 | 依据与依赖代价 |
| --- | :---: | --- |
| **将 EditHere 作为外部 MCP 挂载到 pi-desk** | **高** | 通过 Pi 的 MCP 配置接入 stdio 服务，配置来源及信任边界见[资源与 MCP 模块][p-resources]；Desktop 设置只列举配置并提供探测与会话动作，不编辑 MCP 配置，`desktop-config.json` 不是服务器配置入口。独立使用仍须遵守上文的使用许可，不代表可移植其主体实现。 |
| **输入区解析与结构化反馈卡片化渲染** | **中** | 在 `PromptComposer` 或会话列表中，针对 `feedback-minimal-4` 的 JSON 数据和配套图片进行结构化识别，以卡片形式展示“批注列表”、“位移变更”、“目标原图”，提高视觉走查的可读性；仅需前端解析展示逻辑。 |
| **将浏览器批注扩展为系统抓屏与布局画板** | **低（不建议）** | 现有内置浏览器已有截图与点框批注，但系统捕获权限、滚动拼图和图层变换仍是独立能力。EditHere 主体的非商业许可不授权本项目自由移植其实现，不把浏览器标注视作通用截图工具的替代。 |

## 信息来源

### 对方官方资料

- [README.md][eh-readme]、[使用指南 (USER-GUIDE.md)][eh-userguide]：核心定位、截图、OCR、大爆炸与快捷键。
- [AI 与命令行 (AGENT-CLI.md)][eh-agentcli]：`edithere-cli` 命令集、`feedback-minimal-4` 结构化反馈与错误码。
- [网页版文档 (web/README.md)][eh-webdocs]：MCP Apps SDK 接入、离线单页与 Web 架构。
- [CMakeLists.txt][eh-cmake]、[LICENSE][eh-license]、[LICENSING.md][eh-licensing]、[NOTICE][eh-notice]：技术栈依赖与许可边界。
- [仓库 API][eh-meta]、[最新 Release API][eh-release]：2026-10-26 快照。

### 本项目事实出处

- [资源与 MCP 模块][p-resources]、[`src/main/resources/ipc.ts`](../../src/main/resources/ipc.ts)：MCP 配置列举、探测与运行中会话的受限动作；连接与工具执行由实际 SDK／服务器承担。
- [工作区批注][p-workspace]、[`src/main/browser/ipc.ts`](../../src/main/browser/ipc.ts)、[`BrowserAnnotationPanel.vue`](../../src/renderer/src/browser/components/BrowserAnnotationPanel.vue)：网页截图、元素采集、点框意见与草稿交付。
- [生成式界面模块][p-genui]、[`src/shared/genui-contract.ts`](../../src/shared/genui-contract.ts)：声明式 UI 协议与参数回填。
- [会话模块][p-session]、[`src/main/sessions/session-manager.ts`](../../src/main/sessions/session-manager.ts)：Pi SDK 宿主与执行流。
- [手机访问模块][p-mobile]、[`src/lan-mobile/`](../../src/lan-mobile/)：局域网 HTTP 扫码直连与受限会话。
- [终端模块][p-terminal]、[`src/terminal-daemon/`](../../src/terminal-daemon/)：PTY 守护进程与流控。

[eh-gitee]: https://gitee.com/InnGing/EditHere
[eh-readme]: https://github.com/Inginnng/EditHere/blob/codex/native/README.md
[eh-userguide]: https://github.com/Inginnng/EditHere/blob/codex/native/docs/USER-GUIDE.md
[eh-agentcli]: https://github.com/Inginnng/EditHere/blob/codex/native/docs/AGENT-CLI.md
[eh-webdocs]: https://github.com/Inginnng/EditHere/blob/codex/native/web/README.md
[eh-cmake]: https://github.com/Inginnng/EditHere/blob/codex/native/CMakeLists.txt
[eh-connector-pkg]: https://github.com/Inginnng/EditHere/blob/codex/native/connector/package.json
[eh-license]: https://github.com/Inginnng/EditHere/blob/codex/native/LICENSE
[eh-licensing]: https://github.com/Inginnng/EditHere/blob/codex/native/LICENSING.md
[eh-commercial]: https://github.com/Inginnng/EditHere/blob/codex/native/COMMERCIAL-LICENSE.md
[eh-trademark]: https://github.com/Inginnng/EditHere/blob/codex/native/TRADEMARK-POLICY.md
[eh-notice]: https://github.com/Inginnng/EditHere/blob/codex/native/NOTICE
[eh-meta]: https://api.github.com/repos/Inginnng/EditHere
[eh-release]: https://api.github.com/repos/Inginnng/EditHere/releases/latest
[p-resources]: ../modules/resources-mcp.md
[p-genui]: ../modules/genui.md
[p-session]: ../modules/sessions-chat.md
[p-mobile]: ../modules/lan-remote.md
[p-terminal]: ../modules/terminal-commands.md
[p-workspace]: ../modules/workspace-tabs.md#浏览器批注
