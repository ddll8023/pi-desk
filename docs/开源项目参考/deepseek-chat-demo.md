# DeepSeek Chat Demo

返回[开源项目参考](README.md)。本文是外部项目的参考记录，不是本项目的模块文档。

记录对象是 DeepSeek 官方的 `deepseek-ai/chat-demo`，一个无后端的静态聊天演示，与已收录的 [DeepSeek Harness](deepseek-harness.md)（Agent Harness）不是同一仓库，也互不替代。仓库 2026-11-12 创建、仅 2 个提交，本文快照极易过期，引用数值前应重新核实。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) |
| 官网（在线版） | [deepseek-ai.github.io/chat-demo](https://deepseek-ai.github.io/chat-demo/) |
| 文档 | 仓库 [README.md](https://github.com/deepseek-ai/chat-demo/blob/main/README.md)（无独立文档站）；历史归档格式细节在源码 `src/services/chat/history/README.md` |
| 定位 | DeepSeek 官方静态聊天示例：不部署后端，浏览器直连 DeepSeek API 的纯前端演示，面向体验 API 能力的用户 |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `main` |
| 最新 Release | `v0.1.1`（2026-11-13），资产 `chat-demo-v0.1.1.zip` 约 1.8 MB，468 次下载；上一版 `v0.1.0` 同日发布 |
| Star / Fork | 1,036 / 170 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 1，仓库 `has_issues` 为 false，该计数含 PR，不能当纯 Issue 数 |
| 分发形态 | GitHub Pages 在线版 + Release 静态 zip（解压后可直接打开 `index.html`，`file://` 下需浏览器允许本地存储且 API 允许跨域）；无桌面外壳、无服务端包 |

以上数值核实于 **2026-11-14**，仅为快照，来源见[信息来源](#信息来源)。

## 许可证

[根 LICENSE](https://github.com/deepseek-ai/chat-demo/blob/main/LICENSE) 为 MIT，版权方为 DeepSeek（© 2026）。允许免费使用、复制、修改、合并、发布、分发、再许可与销售，条件是在副本或实质部分中保留版权与许可声明；软件按现状提供，不附担保。

根许可未声明例外目录；仓库 API 的 license 字段（MIT）与实际文件内容一致。README 要求分发构建产物时包含随构建复制到 `dist/LICENSE` 的许可文件，第三方依赖各自带许可，本次未逐项审计依赖许可。

结论：仓库内全部代码可按 MIT 复用；但其核心卖点中的搜索、链接阅读、语音等能力由 DeepSeek 服务端实现，不在代码内，复用代码不等于获得等价服务端能力。

## 技术栈

| 层 | 组成 |
| --- | --- |
| 前端 | React 18.3 + zustand 4.4（状态）、CSS Modules；unified/mdast 管线（`mdast-util-from-markdown` + GFM + math，`micromark-extension-llm-math` 解析 LLM 数学定界符）、prismjs 代码高亮、KaTeX 0.16、Mermaid 11.10（流式渲染经 `useThrottleMarkdownRender` 节流） |
| 构建与工具链 | rspack 2.0 + SWC、TypeScript 7.0.2、oxlint / oxfmt、pnpm；`__API_ORIGIN__` 构建期注入 API 源，缺省 `https://api.deepseek.com` |
| 存储与数据 | idb 8（IndexedDB：会话与原始附件，按浏览器 profile/origin 隔离）、localStorage（API 密钥与设置）、fflate 0.8（历史 ZIP 归档） |
| API 链路 | 浏览器直连 `${API_ORIGIN}/anthropic/v1` 的 Messages / Files API（SSE 流式），默认模型 `deepseek-flash`；搜索与读链接以服务端工具声明启用；语音走 ASR / TTS 端点 |

无服务端进程、无桌面外壳——所有业务逻辑在浏览器内执行，这是它与 pi-desk（Electron + SDK 宿主）在架构上的根本差异。

## 能力清单

按官方 README 的功能分组原样记录（README 无截图，无集中功能页之外的独立能力页）：

| 分组 | 能力 |
| --- | --- |
| 会话与消息 | 多会话（自动标题、重命名、删除）、prompt 编辑、重新生成、消息分支切换；流式回复、深度思考、停止生成、继续符合条件的回复 |
| 网络与引用 | 智能搜索、链接阅读、来源引用展示（请求声明服务端工具后由 API 服务端执行） |
| 输入 | 附件上传 / 粘贴 / 拖拽（支持格式由服务端校验）；语音输入与朗读回复，移动端录制时输入区首行显示实时音频频谱 |
| 渲染 | Markdown、语法高亮、KaTeX 数学、Mermaid 图表 |
| 界面与数据 | 简体中文与英文、明暗主题、移动端布局、位置设置、聊天历史 ZIP 导入导出 |

数据与存储口径（README 明确披露）：消息、附件与语音内容都会传送到配置的 API 服务；导入归档经校验后**整体替换**本地会话与附件，导出包含会话与原始图片、不含 API 密钥、设置与非图片附件；「删除全部聊天」只清本地，不删除已上传到 API 的文件。

## 与本项目的对照

总体：4 项实质重合（流式会话、分支、公式渲染、思考展示），5 项部分重合（代码块、附件、停止/继续、网络信息获取、移动端），对方独有集中在引用展示、语音、历史归档与纯静态分发；pi-desk 的 Agent 能力族（工具、终端、Git、技能/MCP、专家、记忆、子代理、受管浏览器）对方完全没有——它是纯聊天演示，无工具调用循环。

### 实质重合

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| 流式多轮会话 | 多会话 + 流式回复 | 对方浏览器内 SSE 直连 Anthropic 兼容 Messages API，会话存 IndexedDB；本项目经 SDK 宿主（pi-coding-agent）产出消息投影，会话历史由 SDK 以 JSONL 管理 |
| 消息分支 / 回退 | prompt 编辑、重新生成、分支切换（`BranchSwitcher`） | 对方在前端重建分支树；本项目按官方条目身份回退建新分支并把当前回复归档至多分支历史栈（`session-branch.ts` + `TurnBranchSwitcher.vue`），代码硬重置尚未贯通 |
| KaTeX 数学公式 | KaTeX | 对方用 `micromark-extension-llm-math` 解析定界符；本项目用 marked 自定义 tokenizer（`markdown-math.ts`），KaTeX 以 `trust:false` 运行并对行内 `$` 设 `${…}` 与金额护栏——两端都专门处理 LLM 输出的数学定界符，护栏策略不同 |
| 思考过程展示 | 深度思考 | 对方 thinking 内容随消息流以专用样式块渲染；本项目为消息内思考抽屉（`ChatMessageItem.vue`） |

### 部分重合

| 本项目能力 | 对方对应 | 差异 |
| --- | --- | --- |
| 代码块展示 | Markdown + prismjs 高亮 + 复制按钮 | 均有围栏代码块与复制按钮；对方经 prismjs 语法高亮；本项目聊天侧输出纯转义文本 + 语言标签、无高亮（`markdown-shared.ts` 的 `renderCodeBlock`），语法高亮只在编辑器侧由 CodeMirror 承担 |
| 附件输入 | 上传 / 粘贴 / 拖拽 | 对方支持通用附件（格式由服务端校验，经 Files API 上传）；本项目仅图片（粘贴、截图提取、文件树拖入）+ 图片标注面板，`@` 文件引用是路径引用、不上传文件 |
| 停止 / 继续 | 停止生成、继续符合条件的回复 | 对方为 API 流级 stop/continue；本项目结束原运行（主进程运行注册表与代际门禁）后由用户续问 |
| 网络信息获取 | `deepseek_web_search` / `deepseek_read_url` 服务端工具 | 对方在请求体声明服务端工具（声明即启用扩展模式，另带 `safety_check: { level: 'high' }`），搜索 / 深搜 / 图片搜索 / 读链接由 DeepSeek 服务端执行，SSE 返回 `server_tool_use` 与结果块（结果含 AES-256-GCM 加密内容、`page_age`）；本项目由 agent 在工具循环中调用受管浏览器（主进程 `BrowserSessionService` 反向协议绑定分屏） |
| 移动端使用 | 响应式移动布局 + 录音频谱 | 对方是响应式网页；本项目为局域网手机访问（lan-remote / lan-mobile 产物），桌面布局的只读子集 |
| 明暗主题 | 手动明暗切换 | 对方手动切换；本项目跟随系统 `prefers-color-scheme`（如 `shell.css:914`），暗色覆盖面未逐文件核实 |

### 无对应

| 本项目能力 | 说明 |
| --- | --- |
| Agent 能力族 | 工具执行、文件编辑、终端、Git、技能/MCP、专家、记忆、子代理、受管浏览器、Token 用量统计均为 pi-desk 产品能力；对方是纯聊天演示，对话不经工具循环 |
| 多供应商接入 | 对方绑定 DeepSeek API 单一服务、密钥手填 localStorage；本项目经 SDK 宿主做多供应商与认证管理 |

### 对方独有

| 类别 | 能力 |
| --- | --- |
| 引用与来源展示 | 行内引用链接（`TextCitation.web_search_result_location` → `CitationLink`）、来源卡片与站点图标（`SourceCard` / `SiteLogo` / `FallbackImage`）、悬浮卡与搜索面板（`HoverCard` / `SearchPanel`） |
| 语音 | 语音输入（ASR 端点）、朗读回复（`ReadAloudButton` / 阅读进度条）、移动端实时录音频谱（`Spectrum`） |
| 历史归档 | ZIP 导入导出（fflate）：导入经校验后整体替换，导出含会话与原图、排除密钥 / 设置 / 非图片附件 |
| 分发形态 | GitHub Pages 在线版 + Release zip 免安装分发，无安装流程 |
| 界面双语 | EN / ZH 文案表（`src/i18n`） |
| 会话自动标题 | 请求级开关（`title.enabled`），标题随 `message_delta` 事件由服务端生成回传 |
| 位置设置 | `location.ts` / `locationData.ts` 向请求提供位置信息 |

本项目聊天侧 Mermaid 图表渲染缺失、聊天代码块无高亮，属双方能力交叉点上对方更完整的位置；均为已确认事实（各自源码可查），未运行对比，不构成渲染质量排名。

## 可借鉴方向

借鉴范围只指功能方向与产品形态；搜索执行与语音识别依赖 DeepSeek 服务端扩展（结果内容字段加密、ASR/TTS 为其专有端点），客户端没有等价自建路径，不列入下表。技术方案回到依赖自身的开源文档。

| 方向 | 可行性 | 依赖代价 |
| --- | --- | --- |
| 聊天内 Mermaid 图表渲染 | 高 | 编辑器侧已有安全 Mermaid 管线（`file-rich-markdown-diagram.ts`：串行渲染、`securityLevel: 'strict'`、DOMPurify 清洗、隔离展示），依赖 mermaid 11.17 已在；聊天 `MarkdownContent.vue` 目前只有 KaTeX、无图表，复用该管线即可，另需处理流式期节流（对方以 `useThrottleMarkdownRender` 限频） |
| 聊天代码块语法高亮 | 高 | 已依赖 CodeMirror / lezer，不必引入对方的 prismjs；改动点在聊天代码块渲染器与 HTML 清洗白名单（现行 `ALLOWED_TAGS` / `ALLOWED_ATTR` 不含高亮所需的 span / class），需同批扩展并复核注入面 |
| 引用与来源展示 UI | 高 | 纯前端展示层：行内引用 + 来源卡片 + 悬浮卡；`ToolResultPreview` 已展示命中内容与来源，有投影基础。前提是浏览器类工具结果提供稳定的结构化来源清单，该字段可用性未核实，属实施前待调研项 |
| 会话历史导出 | 中 | 需新增 zip 依赖（对方用 fflate，KB 级）；「导入整体替换」涉及数据安全，须另设确认流程，可参照对方口径（校验后替换、导出排除敏感项） |

对方做得完整但与本项目形态不匹配的部分：纯浏览器直连与全 localStorage/IndexedDB 存储建立在「无后端演示」定位上，不构成 pi-desk（主进程持有运行注册表与授权链）的存储参照。

## 信息来源

- 仓库：<https://github.com/deepseek-ai/chat-demo>；在线版：<https://deepseek-ai.github.io/chat-demo/>
- README（功能清单、存储与数据披露）：<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/README.md>（2026-11-14 读取）
- 许可证（实际读取全文）：<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/LICENSE>
- 依赖与脚本：`package.json`（<https://raw.githubusercontent.com/deepseek-ai/chat-demo/main/package.json>）
- 搜索 / 引用 / 服务端工具类型：`src/services/api/types.ts`；请求构造与端点：`src/services/api/client.ts`（均经 raw 地址读取，2026-11-14）
- 版本与统计：仓库 API `https://api.github.com/repos/deepseek-ai/chat-demo`、Releases API、git tree API（2026-11-14）
- 本项目侧事实出处：`docs/modules/sessions-chat.md`（会话、分支、输入坞、用量），`src/renderer/src/ui/markdown-math.ts`、`src/renderer/src/ui/markdown-shared.ts`、`src/renderer/src/ui/MarkdownContent.vue`（聊天渲染与代码块），`src/renderer/src/editor/file-rich-markdown-diagram.ts`（Mermaid 安全管线），`src/renderer/src/sessions/components/PromptImageMaterials.vue`（图片附件），`src/renderer/src/assets/styles/shell.css`（暗色媒体查询）
