# TencentDB Agent Memory

返回 [开源项目参考](README.md)。本文是外部项目的参考记录，不是本项目的模块文档。

## 基本信息

| 项 | 值 |
| --- | --- |
| 仓库 | [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) |
| 官网 | [TencentDB Agent Memory 官方主页](https://tencentcloud.github.io/TencentDB-Agent-Memory/) |
| 文档 | [中文文档 (README_CN.md)](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/README_CN.md) · [安装指南 (INSTALL.md)](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/INSTALL.md) |
| 定位 | 面向 AI Agent 团队的统一记忆中枢，将对话、文档、代码提炼沉淀为可跨 Agent 流转共享的四类记忆资产（Chat Memory、Skill、LLM-Wiki、Code-Graph） |
| 主语言（仓库统计） | TypeScript |
| 默认分支 | `feat/server_team` |
| 最新 Release | `v2.0.3`（2026-10-26） |
| Star / Fork | 30,386 / 2,947 |
| 未关闭事项（Issue/PR） | 890（GitHub API `open_issues_count` 快照） |
| 分发形态 | Docker 容器镜像（Memory Core + Memory Hub + Proxy 三合一）、npm 插件包（`@tencentdb-agent-memory/memory-tencentdb`）、OpenClaw 插件、Hermes Gateway 适配器、Pi 编码代理扩展（`MemoryCore/pi-plugin`） |

以上数值核实于 2026-11-03，仅为快照。

## 许可证

根目录 [LICENSE](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/LICENSE) 为标准 MIT 许可证，版权归属于 Tencent（Copyright (C) 2026 Tencent. All rights reserved.）。

根许可未声明专有闭源或限制商业使用的例外子目录。GitHub API 的 `license` 字段识别为 `NOASSERTION`，系 monorepo 内各子包（如 `openclaw-plugin`、`pi-plugin` 等）独立元数据及第三方依赖声明所致，不影响根目录 MIT 授权效力。

**复用边界**：属于根 MIT 许可的代码在保留原版权与许可声明前提下可自由修改与复用。但需注意：其集成的商业云端服务（如腾讯云向量数据库 TCVDB、腾讯云大模型知识引擎 LKE）属于外部云服务，不因开源代码而免除使用凭证与费用；生产环境接入外部组件时需遵守其各自的服务协议。

## 技术栈

| 层 | 组成 |
| --- | --- |
| 核心引擎（Memory Core） | Node.js (>=22.16.0) / TypeScript；采用 `@ai-sdk/openai`、`undici`、`zod` 处理模型交互与结构化校验，对外暴露 8420 端口 REST API |
| 数据与检索层 | 默认本地 `SQLite + sqlite-vec`（单机零依赖运行）；支持扩展为腾讯云向量数据库 TCVDB（`@tencentdb-agent-memory/tcvdb-text`）与实验性 MongoDB（`mongodb` + `mongot` BM25 检索）；支持 Redis 缓存与消息分发 |
| 协议网关（Proxy） | 独立双协议网关（8096 端口），支持 Anthropic Messages 与 OpenAI Chat Completions 协议，负责会话交互式绑定（sessionInit）与 System Prompt 资产注入 |
| 控制台与知识层（Memory Hub） | Web UI 管理面板（8125 端口，支持 Team/Agent/Task/Asset 管理）与 Knowledge 服务（8424 端口，基于 Fastify/Swagger 提供 Wiki 与 Code-Graph 处理） |
| Agent 客户端适配 | 原生 OpenClaw 插件、Hermes Agent Gateway 适配器，以及针对 Pi Coding Agent 的专用扩展（`pi-tdai-client`） |

## 能力清单

按官方最新版本（v2.0.3）的资产分类与架构规范，其核心能力包括：

| 分组 | 能力 |
| --- | --- |
| 长期个性化记忆（Chat Memory） | **L0 Conversation**（原始对话全量捕获）→ **L1 Atom**（结构化原子事实提取，支持向量去重与冲突检测）→ **L2 Scenario**（场景归纳块，Markdown 存储）→ **L3 Persona**（用户画像提炼，Markdown 存储）；提供基于 `node_id` 与 `result_ref` 的 100% 溯源下钻链条 |
| 符号化短期记忆与上下文卸载 | 工具调用厚重过程日志（搜索、代码、报错）卸载至外部文件系统（`refs/*.md`）；上下文仅保留高信息密度的 Mermaid 任务状态拓扑图与画布；Agent 可通过 `node_id` 随时 grep 恢复原文 |
| 团队技能资产（Skill） | 从复杂任务执行轨迹与报错日志中提炼标准操作流程（SOP）；包含触发边界、执行步骤与校验规则；支持私有 Skill 经人工审核后发布至团队共享池 |
| 团队知识图谱（Knowledge） | **LLM-Wiki**：将 Word、Excel、PowerPoint、PDF、Markdown 与 HTML 等富文档转化为带链接图谱的结构化页面；<br>**Code-Graph**：面向代码仓库构建调用拓扑与语义索引 |
| 客户端与网络适配 | 零侵入透明代理（支持 Claude Code、CodeBuddy、WorkBuddy、Codex、DSH、OpenCode）；原生插件支持（OpenClaw、Hermes、Pi）；支持基于请求头的免交互直接绑定（`x-team-id`、`x-agent-id`、`x-task-id`） |

## 与本项目的对照

本项目（pi-desk）内置基于 Python 文件引擎的本地记忆系统（工作日记、个人画像、月度总结、派生 BM25 索引及项目本地知识），并通过用户级 `pi-memory` 扩展与桌面端工具语义提取器协作。双方在设计哲学上均高度认同**白盒可读**与**语义分层**，但在系统边界、召回机制及管控策略上存在显著差异。

### 实质重合

| 本项目能力 | 对方对应 | 关键差异 |
| --- | --- | --- |
| **记忆语义分层** | **Chat Memory (L0 → L3 金字塔)** | 双方均反对将历史对话暴力平铺或压成不可逆的黑盒摘要。对方采用严格的四层语义金字塔（L0 对话 → L1 事实 → L2 场景 → L3 画像）；本项目划分为工作日记（事实/决策/约束记录）→ 个人画像（领域偏好）→ 月度总结（关联日记来源）→ 项目本地知识。双方均实现高层保留结构、底层保留证据的追溯链路。 |
| **本地优先与白盒持久化** | **SQLite + Markdown 异构存储** | 双方均支持脱离云端数据库独立运行。对方默认采用本地 SQLite 存储事实索引，并将 L2 场景与 L3 画像存为磁盘上可直观查看的 Markdown 文件；本项目基于 Python 文件引擎，日记、画像与总结统一以 Markdown 存储，检索索引为派生 JSON，开发者均可直接通过文件系统检查与排障。 |

### 部分重合

| 本项目能力 | 对方对应 | 差异 |
| --- | --- | --- |
| **会话捕获与上下文注入** | **Proxy 管道注入 (Session Binding & System Prompt)** | 对方通过独立双协议 Proxy 服务拦截 Agent 流量，在 System Prompt 强行拼装注入 Agent 记忆、Skill 与 Wiki 上下文；本项目通过用户级扩展在 `context` 钩子注入画像、项目索引及按任务自动召回的相关规则与日记，正文不修改系统提示词与用户输入，深入细节仍由模型通过显式工具自主按需深入读取。 |
| **检索与相关度排序** | **混合检索 (BM25 + 向量 + RRF)** | 对方采用 BM25 词法检索与本地/云端向量检索（sqlite-vec / TCVDB）并通过倒数排名融合（RRF）进行混合打分；本项目检索核心目前仅采用中文双字词元与英文词元的 BM25 词法相关性，尚未引入向量检索与 Embedding 计算。 |
| **Skill 资产与沉淀** | **Skill 库提炼与管理** | 对方提供从会话执行轨迹中自动提取 Skill 并进行团队资产化分发的闭环；本项目遵循 Pi 原生 `SKILL.md` 标准，强调任务执行前的 `skill_guard` 运行时门禁、上下文全文加载证据审查与逐文件清单审批。 |

### 无对应

| 本项目能力 | 说明 |
| --- | --- |
| **双阶段修改审批通道** | 本项目所有权威日记与画像的生成、替代与废除，必须由扩展生成具体计划并经真实用户在交互界面显式核准后才落盘；对方以 Agent 自动提炼录入为主，未设置严格的人工两阶段写入确认门禁。 |
| **独立持久去重的主动读取统计** | 本项目内置独立技术文件记录日记的主动定向读取次数、去重会话数及最近访问时间，与记忆正文解耦，专门用于观察记忆调用广度与复核热点；对方仅记录管道消费与模型 Token 指标，无针对具体记忆条目持久去重的读取行为可观察性设计。 |

### 对方独有

| 类别 | 能力 |
| --- | --- |
| **长任务短期记忆压缩** | **上下文卸载与 Mermaid 符号图谱**：将厚重的工具过程日志分层卸载到外部磁盘文件，上下文内仅保留带 `node_id` 的轻量级 Mermaid 画布，显著降低长任务的上下文 Token 消耗并保留下钻回溯能力。 |
| **团队协同与知识治理** | **多租户资产中枢**：基于 Team / Agent / Task 的多层级隔离与管理后台面板（Panel UI）；配套完整的富文档 LLM-Wiki 与代码库 Code-Graph 知识图谱服务。 |

## 可借鉴方向

本项目的借鉴仅针对架构设计模式与产品形态，技术实现须结合本项目既有技术栈（Electron + TypeScript 前端、Python 文件引擎、Pi SDK 扩展）独立设计。

| 方向 | 可行性 | 说明 |
| --- | --- | --- |
| **报错指纹与避坑经验联动** | **高** | 借鉴 DSH 报错指纹与腾讯 Agent 避坑机制：对命令执行报错提取稳定特征行，发生复发时优先匹配项目避坑知识（`topics/gotchas/`）或日记排错记录，阻断同类环境问题反复踩坑。纯词法与逻辑匹配，无需新增模型或存储依赖。 |
| **长任务工具过程日志卸载与 Mermaid 画布注入** | **中** | 本项目当前 Coding Agent 运行日志（如大文件查找、长构建日志、复杂测试输出）全部堆叠在上下文或依赖截断。借鉴其思路：在桌面端或会话层将超大工具输出持久化到临时会话工作区，并向模型返回带有拓扑关系的 Mermaid 摘要或轻量符号索引，由模型根据节点 ID 下钻查看细节。需要设计独立的临时文件生命周期与清理机制，不影响现有长期记忆体系。 |
| **主题型场景卡片聚合（Scenario / Wiki）** | **高** | 借鉴其 L2 Scenario 与 Wiki 聚合思想：命中同一主题或规则替代链时，在请求背景装配层以只读结构化卡片（现行有效结论 + 废弃原因 + 来源出处）组织，避免跨日期离散日记的平铺阅读负担。属于纯展示层派生视图，不破坏现有 Markdown 物理存储。 |
| **静态代码拓扑与影响分析（CodeGraph）** | **中** | 借鉴其预索引代码图谱的思路：面向项目源码提供轻量静态 AST / 符号调用链（Callers / Callees）分析工具，在 Agent 修改代码前直接提供影响范围分析，避免盲目全文 `ffgrep` 尝试。 |
| **BM25 + 向量检索混合召回（RRF）** | **中** | 本项目当前记忆引擎仅支持 BM25 词法检索，在用户查询表述与日记关键词不匹配时存在召回盲区。借鉴其 SQLite + sqlite-vec 模式，在 Python 引擎端评估引入本地嵌入与轻量向量检索，结合现有 BM25 实现 RRF 混合排序。代价是需要在 Python 虚拟环境中增加轻量向量或嵌入模型依赖，需评估跨平台打包体积与初始化延迟。 |
| **Pi 原生 Proxy Provider 方案参考** | **高** | 对方在其 `MemoryCore/pi-plugin` 中展示了标准的 Pi Extension 适配模式（通过 `registerProvider` 注册自定义 upstream 代理，并在 `before_provider_headers` 注入动态会话标头 `x-conversation-id`）。这为 pi-desk 后续设计多端协作或远程 Harness 网关提供了极佳的开源工程范式。 |

## 信息来源

- **官方文档与仓库**：
  - [TencentCloud/TencentDB-Agent-Memory 官方仓库](https://github.com/TencentCloud/TencentDB-Agent-Memory)
  - 根目录授权协议：[LICENSE](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/LICENSE)
  - 中文主文档：[README_CN.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/README_CN.md)
  - 部署与配置文档：[INSTALL.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/INSTALL.md)
  - Pi 扩展源码与文档：[`MemoryCore/pi-plugin/index.ts`](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/pi-plugin/index.ts) 与 [`MemoryCore/pi-plugin/README.md`](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/pi-plugin/README.md)
- **版本与统计**：
  - GitHub 仓库元数据接口：`https://api.github.com/repos/TencentCloud/TencentDB-Agent-Memory`（核实于 2026-11-03）
  - GitHub 最新 Release 接口：`https://api.github.com/repos/TencentCloud/TencentDB-Agent-Memory/releases/latest`（标签 `v2.0.3`，核实于 2026-11-03）
- **本项目侧事实依据**：
  - 记忆系统架构设计与现状：[docs/memory-research-design.md](../memory-research-design.md)
  - 记忆访问统计与召回分析：[docs/memory-access-analysis.md](../memory-access-analysis.md)
  - 项目参考目录规范：[docs/开源项目参考/README.md](README.md)
