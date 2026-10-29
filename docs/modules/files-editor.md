# 文件与编辑器

模块 ID：`files-editor`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责项目内文件树、目录监听、`@` 文件引用检索、条目解析与系统文件管理器定位、条目安全删除（移入系统废纸篓）、文件内容读取／保存／磁盘基线，以及源码编辑、图片预览、Markdown 预览与富文本编辑、HTML 页面预览。

入口为右侧文件树、文件菜单、输入坞文件引用、文件标签及 Markdown 文档链接。输入坞可接受从文件树拖入的条目：只插入项目相对路径文本（目录同样插入路径），不读文件内容，跨项目拖动被拒绝。不执行 Agent 的文件工具，不拥有工作区标签顺序，不把桌面草稿当跨应用重启持久化。

## 专属文件

### 主进程与契约

| 文件 | 用途 |
| --- | --- |
| `src/main/projects/project-directory.ts` | 按层列举目录、解析条目、文件管理器定位及安全删除（移入废纸篓） |
| `src/main/projects/project-directory-watcher.ts` | 已加载目录层的监听集合、变化合并与 overflow |
| `src/main/projects/project-directory-watcher.test.ts` | 现有目录归一、差异与批次调度用例 |
| `src/main/projects/project-entry-path.ts` | 相对条目路径规范化、真实路径与项目边界 |
| `src/main/projects/project-file-index.ts` | 项目文件检索与 Markdown 文档候选 |
| `src/main/projects/project-file-content.ts` | 内容分类、文本／图片读取、磁盘基线与原子保存 |
| `src/main/projects/project-html-preview.ts` | HTML 内存快照、隔离会话、项目内网页资源读取与预览释放 |
| `src/main/projects/project-markdown-assets.ts` | 为所属 Markdown 文档导入本地或剪贴板图片 |
| `src/shared/project-file-api.ts` | 目录、条目、文件读写、监听、HTML 预览与 Markdown 资产契约 |

### 前端状态与主界面

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/editor/stores/project-directory.ts` | 文件树缓存、展开、目录读取与变化订阅 |
| `src/renderer/src/editor/stores/project-file.ts` | `@` 引用候选、查询序号与项目匹配 |
| `src/renderer/src/editor/stores/project-editor.ts` | 按项目与文件保存编辑记录、脏状态、磁盘基线与草稿 |
| `src/renderer/src/editor/file-document-session.ts` | 源码与排版编辑面的提交、保存及视图切换协调 |
| `src/renderer/src/editor/file-markdown-view.ts` | Markdown 编辑能力、格式、查找及渲染适配器契约 |
| `src/renderer/src/editor/services/project-file.ts` | 文件／目录／图片导入／HTML 预览固定桥接与事件 |
| `src/renderer/src/editor/services/external-url.ts` | 文件内文档链接的外链打开封装；主进程执行协议与凭据检查 |
| `src/renderer/src/editor/components/FileTreeView.vue` | 文件树展示、打开、拖拽入口与删除确认交互 |
| `src/renderer/src/editor/components/FileTreeMenu.vue` | 条目菜单、复制、定位、打开、插入终端与移至废纸篓 |
| `src/renderer/src/editor/components/FileEditorView.vue` | 文件标签面板、视图切换、保存与冲突交互 |
| `src/renderer/src/editor/components/CodeMirrorEditor.vue` | 源码编辑器及对外编辑接口 |
| `src/renderer/src/editor/components/FileHtmlPreview.vue` | HTML 隔离页面、快照刷新、加载与错误状态、容器释放 |
| `src/renderer/src/editor/components/FileMarkdownView.vue` | Markdown 预览／可编辑排版、目录、查找及只读降级 |
| `src/renderer/src/editor/components/FileMarkdownPreview.vue` | 只读安全 DOM、资源及阅读交互适配 |
| `src/renderer/src/editor/components/FileMarkdownToolbar.vue` | 文档工具区、编辑能力提示与阅读选项 |
| `src/renderer/src/editor/components/FileMarkdownSearchBar.vue` | 可编辑排版与只读视图共用的查找／替换界面 |
| `src/renderer/src/editor/components/FileMarkdownToc.vue` | Markdown 标题目录 |
| `src/renderer/src/editor/components/FileMarkdownImageViewer.vue` | Markdown 图片查看 |

### 文件排版与富文本实现

| 文件 | 用途 |
| --- | --- |
| `src/renderer/src/editor/file-language.ts` | 文件名、语言、Markdown 与 HTML 类型识别 |
| `src/renderer/src/editor/file-code-highlight.ts` | 文件代码高亮与语言加载 |
| `src/renderer/src/editor/file-images.ts` | 项目内 Markdown 图片读取和显示地址管理 |
| `src/renderer/src/editor/file-markdown.ts` | 文件 Markdown 只读解析、安全渲染与预览支持判定 |
| `src/renderer/src/editor/file-markdown-dom.ts` | 只读 DOM 增强、标题锚点与目录条目提取 |
| `src/renderer/src/editor/file-markdown-links.ts` | 纯路径、链接分类与项目相对目标解析 |
| `src/renderer/src/editor/file-markdown-search.ts` | 只读正文查找、匹配范围与高亮 |
| `src/renderer/src/editor/file-rich-markdown.ts` | Tiptap 扩展组装、节点配置与事件接入 |
| `src/renderer/src/editor/file-rich-markdown-parser.ts` | Markdown 唯一结构转换入口、语法支持判定、schema 规范化与完整检查 |
| `src/renderer/src/editor/file-rich-markdown-session.ts` | 候选准备与接管、源文同步、往返证明及受阻草稿保留 |
| `src/renderer/src/editor/file-rich-markdown-codec.ts` | Markdown 编解码上下文与 Front Matter 分离 |
| `src/renderer/src/editor/file-rich-markdown-source.ts` | 文档等价、字面源码保存与序列化协调 |
| `src/renderer/src/editor/file-rich-markdown-block-source.ts` | 块级源码归属与空行协调 |
| `src/renderer/src/editor/file-rich-markdown-nodes.ts` | 自定义节点、列表、段落、源码片段与拖拽保护 |
| `src/renderer/src/editor/file-rich-markdown-code.ts` | 富文本代码块扩展与 Vue NodeView 接入 |
| `src/renderer/src/editor/file-rich-markdown-details.ts` | 折叠块解析与序列化 |
| `src/renderer/src/editor/file-rich-markdown-media.ts` | 图片与数学公式节点 |
| `src/renderer/src/editor/file-rich-markdown-diagram.ts` | 编辑视图的图解渲染适配 |
| `src/renderer/src/editor/file-rich-markdown-doc-link.ts` | 文档链接节点、候选与链接解析 |
| `src/renderer/src/editor/file-rich-markdown-draft.ts` | 结构草稿捕获、恢复与编辑器状态替换 |
| `src/renderer/src/editor/file-rich-markdown-image-insert.ts` | 图片插入位置和异步结果归属 |
| `src/renderer/src/editor/file-rich-markdown-keyboard.ts` | 列表、段落与选区键盘规则 |
| `src/renderer/src/editor/file-rich-markdown-clipboard.ts` | 结构化复制、剪切及粘贴清洗／解析 |
| `src/renderer/src/editor/file-rich-markdown-commands.ts` | 工具栏与插入命令 |
| `src/renderer/src/editor/file-rich-markdown-suggestions.ts` | 斜杠与文档补全模型 |
| `src/renderer/src/editor/file-rich-markdown-search.ts` | 富文本查找与替换状态／操作 |
| `src/renderer/src/editor/file-rich-markdown-table.ts` | 表格位置与行列动作 |
| `src/renderer/src/editor/components/FileRichMarkdownEditor.vue` | Editor 实例与交互适配、浮层编排；文档装载和提交交给富文本会话 |
| `src/renderer/src/editor/components/FileRichMarkdownCodeBlock.vue` | 代码块 NodeView、高亮和图解展示 |
| `src/renderer/src/editor/components/FileRichMarkdownToolbar.vue` | 工具栏命令入口 |
| `src/renderer/src/editor/components/FileRichMarkdownSuggestions.vue` | 补全菜单 |
| `src/renderer/src/editor/components/FileRichMarkdownLinkPopover.vue` | 链接编辑浮层 |
| `src/renderer/src/editor/components/FileRichMarkdownEmojiPicker.vue` | 表情选择与插入 |
| `src/renderer/src/editor/components/FileRichMarkdownTableControls.vue` | 表格行列操作入口 |

原文回写模块与块级源码模块相互引用，候选 Markdown 的重新解析共用统一结构转换入口；统一解析不消除回写模块间的双向依赖。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`registerProjectFileHandlers` 校验调用者和固定请求；文件面板由 `src/renderer/src/shell/components/WorkspaceView.vue` 渲染，脏文件关闭确认状态在 `src/renderer/src/workspace/stores/workspace-tabs.ts`，经 `src/renderer/src/shell/components/AppDialogHost.vue` 呈现。HTML 预览协议由 `src/main/asset-protocol.ts` 注册，容器校验与窗口级清理由 `src/main/window.ts` 接线。
- [F-ui](shared.md#f-ui前端共享展示共享)：公共按钮、浮层、复制，`ui/markdown-shared.ts` 与 `ui/markdown-math.ts` 的共同排版能力，以及文件树、输入坞与终端共用的 `ui/project-entry-drag.ts` 拖拽载荷、路径引用文本和路径插入文本。
- [F-style](shared.md#f-style全局主题与业务样式混合)：`src/renderer/src/assets/styles/editor.css` 的文件编辑、Markdown、富文本和文件树样式，由 `src/renderer/src/assets/main.css` 统一加载。
- [工作区](workspace-tabs.md)：打开／关闭文件标签和消费锚点请求；编辑状态归本模块，标签状态归工作区。
- [项目](projects-trust.md)：普通树和检索跟随当前项目，文件内容、HTML 预览与图片导入固定已登记的所属项目。
- [终端](terminal-commands.md)：文件菜单与拖拽向活动终端插入路径，不在文件模块执行 shell。
- [偏好](preferences.md)：Markdown 默认视图只决定新打开文件的初始模式。

## 关键调用链与状态

1. `RightPanel.vue` 初始化目录 Store；列举结果按已加载层缓存，再将需观察的目录集合登记到主进程。
2. 主进程监听变化并合并事件，页面收到后重读对应层；变化同时使文件索引失效。overflow 走更大范围的重新读取，不伪造逐文件增量。
3. 打开条目先由工作区登记文件标签，再由 `project-editor` 读取固定项目内文件；内容分为文本、图片或不支持，不把超大或非文本内容伪装成可编辑文本。
4. `file-document-session.ts` 协调源码／排版切换与保存；Store 维护已接受的源文和恢复草稿，编辑实例持有未提交输入、选区及撤销历史。源码变化捕获全文快照，富文本仅将已证明可回写的文本交给 Store。
5. `FileMarkdownView.vue` 统一提供操作区、目录与查找界面，富文本和只读视图通过 `file-markdown-view.ts` 的契约适配。保存进度与编辑能力分开表达，只读原因在操作区展示。
6. 初次装载与外部全文替换先分离 Front Matter，再经 `parseRichMarkdown()` 完成语法支持判定、无损标记规范化及完整结构检查；富文本会话完成候选的序列化往返证明后才接管实例。编辑器从不可编辑的合法空文档启动，不在 Markdown 扩展初始化时隐式装载整篇源文。
7. 同一实例的自身文本回声不重建历史；外部替换须先准备候选，尚有未提交输入时拒绝覆盖。结构草稿先严格检查 JSON 并准备恢复状态与基线，再接管文档和选区，不套用 Markdown 的标记修正规则。
8. 初始装载失败时降级为只读状态并展示原因；已编辑文档无法证明安全序列化时保留结构草稿并允许继续修正。刷新失败会阻止保存或视图切换，不用旧文本冒充当前输入，不静默覆盖源文件。
9. 活动排版视图可查找时，通过 `Cmd/Ctrl + F` 唤起并聚焦共用查找栏，顶部工具区不提供查找按钮；查找栏内按 `Esc` 关闭并返回当前视图。只读视图按 DOM 匹配，富文本视图按 ProseMirror 文档查找并在编辑能力允许时提供替换。
10. 保存携带文本、换行／BOM 语义与磁盘基线。主进程复核路径与符号链接，冲突返回给界面，明确覆盖才允许不带旧基线写入。
11. 图片导入创建文档所属项目内的新资产，正文仍需显式保存；期间项目切换不应将旧结果解释为新项目同名路径。
12. 文件或目录删除由右键菜单或选中行快捷键（Delete / Backspace）触发破坏性二次确认；主进程严格限制在当前项目内并通过 `shell.trashItem` 安全移入系统废纸篓，成功后联动关闭工作区内所有已打开的受影响标签，清空选中状态并主动重载父目录。

### HTML 页面预览

HTML 文件默认显示「页面」，可切回「源码」编辑；类型识别由 `file-language.ts` 决定，不按 Vue／React 或构建配置拦截。预览不启动开发服务、不编译源码；依赖构建或服务的页面需通过服务地址打开。

`FileHtmlPreview.vue` 经 `prepareProjectHtmlPreview` 将当前源文快照交给 `ProjectHtmlPreview`；快照可以包含未保存的编辑，不写入文件。主进程固定文档所属的已登记项目，为预览建立独立内存会话，主文档取内存快照，相对资源经预览专用协议读取项目内的普通文件。

活动页面在源文变化或显式刷新时重建；普通标签切换复用已挂载页面，文件重新载入则重建预览。组件卸载经 `releaseProjectHtmlPreview` 释放预览，项目移除时主进程按项目清理。主窗口文档导航、渲染进程退出或窗口关闭时，主进程清理窗口所属预览，并使旧代际的在途登记失效。

## 数据与安全边界

项目文件是真实外部数据。内容写入使用同目录临时文件与 rename，编辑器草稿和撤销在页面内；关闭脏标签前先确认，关闭不等于保存。目录检索索引与树缓存可再生，不拥有文件真源。

页面只提交契约允许的项目与相对路径，主进程执行项目登记及真实路径边界检查；链接、HTML、图片、数学和代码片段各有渲染入口，不能将可信 UI 组件等同于可信文件内容。

HTML 脚本只在独立沙箱容器运行，不向预览暴露桌面桥接、Node 或本地写入能力。资源条目自身的符号链接、真实路径越界和不支持的资源请求被拒绝；本地资源类型、读取上限和预览 CSP 以 `project-html-preview.ts` 与共享契约定义为准。网络资源仍遵守 Chromium 的跨域与混合内容限制，不因文件预览关闭安全机制；预览禁止弹窗、下载和敏感权限请求。


