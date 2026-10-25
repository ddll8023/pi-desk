# EvoFlow

返回[开源项目参考](README.md)。本文记录 `EvovexAI/EvoFlow` 的公开产品形态。**项目主体是 PolyForm Noncommercial 源码可见软件，不是 OSI 意义上的开源软件**；收录用于能力对照，不表示其主体实现可以自由商用或移植。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow) |
| 官网 | [evovexai.com](https://www.evovexai.com) |
| 文档 | [仓库文档入口][e-docs]、[官网文档](https://www.evovexai.com/docs/chat/evopanel) |
| 定位 | 面向长任务的 Agent Runtime 与控制平面，组织规划、团队执行、恢复、调度和结果管理 |
| 主语言（仓库统计） | TypeScript；不代表后端也是 TypeScript |
| 默认分支 | `main` |
| 最新 Release | `v1.1.6`，2026-10-24 16:25:51 UTC 发布 |
| Star / Fork | 512 / 139 |
| 未关闭事项（Issue/PR） | API `open_issues_count` 为 8；非纯 Issue 数 |
| 桌面与 Web 形态 | Tauri 桌面壳、React 面板、Python Gateway 与 Harness；官方文档也描述 Web 入口 |
| 本次 Release 资产 | macOS aarch64/x64 DMG、Windows x64 安装 EXE 及校验文件；没有在该次 Release 资产中看到 Linux 安装包 |

以上版本、统计与发布产物核实于 **2026-10-25**，仅为快照，依据[仓库 API][e-meta]和[Release API][e-release]。README 声明 Windows / macOS / Linux 支持，但平台声明不能替代某次 Release 的实际产物清单，不推定 Linux 从未提供安装包。

## 许可证

### 主体许可

[根 LICENSE][e-license]为 **PolyForm Noncommercial License 1.0.0**，Required Notice 的版权方为景银泰（EvovexAI）。其核心边界是：

- 为许可目的授予使用、复制、修改、衍生和分发权；许可目的包括非商业用途及条款规定的个人、研究和特定组织用途。
- 个人研究、学习或兴趣使用不能预期商业应用；“个人使用”不等于可以不受限制地用于商业工作。
- 分发需提供许可文本或其 URL，并保留 `Required Notice`。
- 没有额外的一般商用授权；[README][e-readme]明确要求商业使用取得书面授权。
- 包含专利防御、违约处理和免责条款；不是简单的“允许看源码、其他不限”。

仓库 API 将许可识别为 `Other / NOASSERTION`，而实际根文件清楚写明 PolyForm Noncommercial。这是 API 未给出标准 SPDX 识别的边界，不以元数据覆盖实际条款。

### 第三方与目录例外

以下由[根 NOTICE][e-notice]定位，并核对实际许可文本；第三方许可仅适用于相应部分，不能扩展到整个 EvoFlow，也不自动消除 EvoFlow 修改部分的主许可约束。

| 范围 | 实际许可与核实边界 |
| --- | --- |
| DeerFlow 派生部分 | [`licenses/deerflow-MIT.txt`][e-deerlicense] 为 MIT；NOTICE 没有提供可穷举的逐文件清单，不能据此把全部后端判为 MIT |
| ZCode 派生目录 | [`licenses/zcode-APACHE-2.0.txt`][e-zlicense] 为 Apache-2.0；NOTICE 明列 `evopanel/src/` 下的 `zcode-ui`、`zcode-shared`、`zcode-rpc`、`zcode-provider`、`zcode-provider-node`、`zcode-services`、`zcode-model-option-map`，以及 `evopanel/vendor/zcode-cua` |
| `evopanel/vendor/liquid-glass-theme/` | [目录 LICENSE][e-glasslicense] 为 MIT；不将其许可自动扩展到所有运行时界面文件 |
| `skills/public/canvas-design/` | [LICENSE.txt][e-canvaslicense] 为 Apache-2.0；NOTICE 另称所带字体有 OFL 文本，本次未逐字体核实，不能统一按 Apache-2.0 分发字体 |
| `skills/public/frontend-design/` | [LICENSE.txt][e-frontendlicense] 为 Apache-2.0 |
| `skills/public/skill-creator/` | [LICENSE.txt][e-skilllicense] 为 Apache-2.0 |
| 安装器携带的 Z.ai 官方插件 | NOTICE 列出 MIT 或 Apache-2.0 的插件示例，并要求以打包副本中的 `plugin.json` 和许可为准；本次未下载或解包安装器，实际随包许可未核实 |

MIT 部分要求保留声明；Apache-2.0 部分还涉及随附许可、修改标记、相关 NOTICE 与专利条款，均不授予品牌权。NOTICE 明确 PDF / Office 等部分 Anthropic 品牌 Skill 没有包含在仓库中，不能把同名能力当成那些专有材料的再分发授权。

**本项目借鉴边界**：只参考公开功能方向与产品边界，不移植非商业主体实现。确需利用 MIT / Apache-2.0 上游能力时，优先回到 DeerFlow、ZCode 或对应依赖的原始项目，并核对拟引入文件及其修改归属；不能把 NOTICE 中的上游名称当作整个混合目录的商用通行证。

## 技术栈

本节仅依据公开依赖与载体配置识别运行层，不以依赖存在推定所有功能均已启用。

| 运行层 | 组成与作用 |
| --- | --- |
| 桌面 | Rust / Tauri 2，声明 Shell、对话框、通知、更新和快捷键插件；桌面 Cargo 直接指向根许可 |
| 面板 | React、TypeScript、Vite、Zustand；XYFlow 参与节点画布，xterm 参与终端界面，图表与 Markdown 各有展示依赖 |
| Gateway | Python / FastAPI、Uvicorn、SSE / WebSocket，提供 Runtime API 和控制面；包含飞书、Slack、Telegram、钉钉相关渠道依赖 |
| Harness | 独立 Python 工作区包，声明 LangChain / LangGraph、MCP 适配、Claude Agent SDK 与执行组件 |
| 检索 | Harness 声明 tree-sitter / Java 解析、jieba、SQLite 向量扩展和 sentence-transformers，覆盖代码及资料检索所需基础；本地向量模型具有平台条件与权重依赖 |
| 执行组件 | 声明 agent-sandbox、Kubernetes、Playwright 等依赖；依赖声明不是默认使用容器、集群或完整隔离的证明 |

依据：[面板 package.json][e-panel]、[Cargo.toml][e-cargo]、[Gateway pyproject][e-gateway]、[Harness pyproject][e-harness]。引入这些技术需要重新核对各自许可与分发条件，本记录不把依赖名称视为统一开源授权。

## 能力清单

以官方[产品总览的“功能地图（按侧栏心智）”][e-overview]为分组依据，而不是只抄根 README 的宣传列表。以下是**官方文档声明的产品能力**；本次未读取受限主体的业务实现，也未运行产品，不能据此证明可靠性、性能或所有安装包中的可用性。

| 官方入口 | 能力与关键边界 |
| --- | --- |
| 新建对话 | Ask / Agent / Plan / Goal；绑定工作空间。Plan 先修订计划再启动，Goal 面向开放长任务，不等于普通聊天自动无限续跑 |
| 任务中心 | 用户待办、协作派发、看板、交付处理；小V 协调派发与结果反馈，不等于会话消息列表 |
| 工作流（旧名“应用中心”） | 多节点画布编排、发布、填参再运行；与自由规划任务分开 |
| 自动化 | 按时执行提示词 Agent 或已发布工作流，保留执行历史与结果推送；不是员工岗位合同 |
| 员工 | 岗位、职责、值班、转交审批、汇报、工作空间、知识库与预算；区别于单次 @ 智能体 |
| 智能体 | 人设、模型、工具、Skill 和连接器（MCP）的能力配置；定义“会什么”，不自动获得值班语义 |
| 资产中心 | 画像、记忆、经验、反思与专长；文档区分用户资产与员工独立记忆，不能推定员工共享全部工作记忆 |
| 知识库 | 上传文档、检索、问 AI，并绑定聊天或员工；不同于会话附件和资产记忆 |
| Agent 应用 | 将业务网页／系统组织在统一入口，连接工作流、员工或知识库；不等于多节点工作流本身 |
| 设置治理套件 | 模型、IM、多账号、SSO、安全、费用、代码索引、资源中心／市场等；具体覆盖与组织级保证未核实 |
| 运维观测 | 官方列有独立观测入口，任务、工具和用量可见；不据此推定具备完整生产审计能力 |

跨入口能力包括：项目团队参与软件类 Plan、工作空间绑定与代码索引、沙箱作业、IM 派发／结果推送。它们属于文档描述的协作链，不能以菜单名推导底层隔离、事务或恢复保证。

## 与本项目的对照

基准为 pi-desk 当前内置实现。EvoFlow 侧以公开文档和依赖清单为证；本节不分析受限主体算法，不做实现质量排名。

### 实质重合

| 能力 | EvoFlow 对应 | 与 pi-desk 的关键差异 |
| --- | --- | --- |
| 绑定工作空间与 Agent 对话 | 对话绑定工作空间、工具执行和结果展示 | pi-desk 使用 Pi SDK 独立宿主，前端消费有界会话投影；EvoFlow 声明 Gateway / Harness 与模式化控制面。聊天目标重合，任务协议不同。见[会话模块][p-session] |
| 模型供应商配置 | 设置中的模型与凭据配置 | pi-desk 配合 Pi Provider、认证辅助进程和运行时模型选择；EvoFlow 的模型设置服务于其自身 Harness。配置不能直接互换。见[项目总览][p-map] |
| Skill / MCP 扩展会话能力 | 智能体的技能与连接器 | pi-desk 使用 Pi 资源体系并区分预读、配置、探测和会话状态；EvoFlow 将它们绑定智能体能力，扩展生命周期与包装形式不同。见[资源模块][p-resources] |

### 部分重合

| 能力 | 重叠环节 | 不可视作替代的原因 |
| --- | --- | --- |
| 多任务可观测 | 看到任务正在做什么及其工具活动 | pi-desk 有会话运行清单、消息／工具／文件活动和用量，但没有岗位、派发、任务交付状态；会话活动栏不是任务中心 |
| 工作空间与代码检索 | 都围绕项目目录和文件工作 | pi-desk 的文件树、文件候选和编辑接口不是符号／引用图谱及向量检索服务；EvoFlow 依赖清单包含 AST 和向量组件 |
| 手机或渠道继续交互 | 从桌面之外回应 Agent | pi-desk 提供经用户配置的可信 HTTPS 代理接入、受项目授权的聊天网页；EvoFlow 的 IM 是消息渠道及调度推送，不是同一种客户端链路 |
| 参数化交互 | 用户提交结构化参数 | pi-desk 的生成式界面参数回到当前会话；EvoFlow 工作流参数触发已发布流程。输入、输出和生命周期不同，不能把表单相似视为实质重合 |
| 记忆与长期资料 | 都可利用项目资料辅助 Agent | 本项目有按需读取的项目记忆文件，但没有内置资产中心或知识库服务；文件约定不等于自动沉淀、RAG 或员工独立记忆产品 |

### 对方独有

| 类别 | EvoFlow 官方描述的能力 | pi-desk 当前边界 |
| --- | --- | --- |
| 长任务控制面 | Plan / Goal、项目团队、任务派发与恢复流程 | 无等价内置模块；[子代理文档][p-subdesign]仍是初步设计，多会话不等于团队编排 |
| 工作流与调度 | 节点画布、发布运行、定时触发 | 无内置工作流引擎、定时调度与执行历史中心 |
| 岗位员工 | 值班、职责、审批、预算、汇报 | 无对应内置产品模型 |
| 资料与资产服务 | 知识库、向量检索、画像、经验和反思入口 | 无对应内置服务；现有文件检索不承担相同目标 |
| 平台集成与治理 | IM、多账号、SSO、资源市场与组织配置 | 无等价平台模块；Pi Provider 凭据不是组织账号或 SSO |

### 尚不能判定为“无对应”的项

EvoFlow 文档包含广泛的桌面与预览能力，但本次没有核实其是否存在与 pi-desk **同协议的声明式界面、节点补丁、版本和会话参数回填**，也没有核实是否存在与本项目终端守护进程完全等价的生命周期。均保持未知，不由依赖名称或菜单缺项推定不存在。

**结论类型**：产品边界差异有公开资料和本项目出处支持；“长任务更可靠”“检索更准确”“恢复更完整”缺少双方实现与量化数据，不作事实陈述。

## 可借鉴方向

范围限定为公开产品概念与交互组织；技术实现应依据本项目事实和依赖自身文档重新设计，不从非商业主体复制。

| 方向 | 可行性 | 依据与依赖代价 |
| --- | --- | --- |
| 区分计划、执行、任务和会话状态 | 高 | 本项目已有会话与活动投影，可先明确展示术语和状态来源，无新增依赖；这不包含新增 Plan / Goal 运行模式 |
| 区分一次附件、长期资料与记忆 | 高 | 本项目已有文件引用及项目记忆约定，可明确边界而不引入数据库；不因此声称具有知识库服务 |
| 父子任务和团队进度展示 | 低 | 已有 SDK 宿主和工具卡可供组合，但需独立设计任务身份、授权、取消、用量及历史；不能将并行会话包装成完整团队 |
| 发布后可重跑的参数化工作流 | 低 | 生成式界面只负责参数采集与展示，尚缺流程定义、执行、持久状态和调度；需要独立产品设计，不是新增一个表单节点 |
| 知识库与语义代码检索 | 低 | 当前依赖没有等价的向量索引和模型管理；若采用类似方向，需新增存储／解析／嵌入组件及权重，影响安装体积、首次下载、平台和许可边界 |
| IM 或后台岗位调度 | 低 | 需新增渠道 SDK、凭据、事件入口、常驻调度及去重／权限模型；与当前经 HTTPS 代理接入的手机网页不是同质扩展 |

以上可行性是**设计推断**，没有工时、精度或吞吐对比。EvoFlow 将通用对话平台、岗位调度与治理并置，不代表 pi-desk 必须接受相同产品范围或后端依赖规模。

## 信息来源

### 对方官方资料与清单

- [README][e-readme]、[文档入口][e-docs]、[产品总览][e-overview]：模式、功能地图及概念边界。
- [根 LICENSE][e-license]、[NOTICE][e-notice]：主体非商业许可与第三方范围。
- 已实际读取的例外文本：[DeerFlow MIT][e-deerlicense]、[ZCode Apache-2.0][e-zlicense]、[Liquid Glass MIT][e-glasslicense]、[Canvas Skill Apache-2.0][e-canvaslicense]、[Frontend Skill Apache-2.0][e-frontendlicense]、[Skill Creator Apache-2.0][e-skilllicense]。
- [面板包声明][e-panel]、[桌面 Cargo][e-cargo]、[Gateway 依赖][e-gateway]、[Harness 依赖][e-harness]：运行层和组件，不作为完整实现证明。
- [仓库 API][e-meta]、[最新 Release API][e-release]：2026-10-25 快照。

### 本项目事实出处

- [项目结构文档][p-map]：现有模块及多进程、存储边界；与设计稿分开登记。
- [会话模块][p-session]、[`src/sdk-host/session-runtime.ts`](../../src/sdk-host/session-runtime.ts)：`SdkSessionRuntime` 与 SDK 内置扩展装配。
- [文件模块][p-files]、[资源模块][p-resources]、[手机模块][p-mobile]、[生成式界面模块][p-genui]：对应能力与明确不做项。
- [`src/sdk-host/genui/tools.ts`](../../src/sdk-host/genui/tools.ts)：声明式文档和补丁入口；不持有任务执行状态。
- [子代理初步设计][p-subdesign]：只用于说明设计不等于实现，不把设计内容计入已实现能力。
- [`package.json`](../../package.json)、[项目记忆索引](../../.agents/memory/INDEX.md)：现有依赖与项目记忆的文件入口，不据此声称存在内置知识库服务。

[e-readme]: https://github.com/EvovexAI/EvoFlow/blob/main/README.md
[e-docs]: https://github.com/EvovexAI/EvoFlow/blob/main/docs/index.md
[e-overview]: https://github.com/EvovexAI/EvoFlow/blob/main/docs/user/getting-started/product-overview.md
[e-license]: https://github.com/EvovexAI/EvoFlow/blob/main/LICENSE
[e-notice]: https://github.com/EvovexAI/EvoFlow/blob/main/NOTICE
[e-deerlicense]: https://github.com/EvovexAI/EvoFlow/blob/main/licenses/deerflow-MIT.txt
[e-zlicense]: https://github.com/EvovexAI/EvoFlow/blob/main/licenses/zcode-APACHE-2.0.txt
[e-glasslicense]: https://github.com/EvovexAI/EvoFlow/blob/main/evopanel/vendor/liquid-glass-theme/LICENSE
[e-canvaslicense]: https://github.com/EvovexAI/EvoFlow/blob/main/skills/public/canvas-design/LICENSE.txt
[e-frontendlicense]: https://github.com/EvovexAI/EvoFlow/blob/main/skills/public/frontend-design/LICENSE.txt
[e-skilllicense]: https://github.com/EvovexAI/EvoFlow/blob/main/skills/public/skill-creator/LICENSE.txt
[e-panel]: https://github.com/EvovexAI/EvoFlow/blob/main/evopanel/package.json
[e-cargo]: https://github.com/EvovexAI/EvoFlow/blob/main/evopanel/src-tauri/Cargo.toml
[e-gateway]: https://github.com/EvovexAI/EvoFlow/blob/main/backend/pyproject.toml
[e-harness]: https://github.com/EvovexAI/EvoFlow/blob/main/backend/packages/harness/pyproject.toml
[e-meta]: https://api.github.com/repos/EvovexAI/EvoFlow
[e-release]: https://api.github.com/repos/EvovexAI/EvoFlow/releases/latest
[p-map]: ../项目结构文档.md
[p-session]: ../modules/sessions-chat.md
[p-files]: ../modules/files-editor.md
[p-resources]: ../modules/resources-mcp.md
[p-mobile]: ../modules/lan-remote.md
[p-genui]: ../modules/genui.md
[p-subdesign]: ../subagents-design.md
