# 开源项目参考

本目录记录外部 Agent 产品的能力、许可边界、与 pi-desk 的重合关系及可借鉴方向，供功能取舍与后续设计按需查阅。包含开源项目，也包含明确标注许可限制的源码可见项目。

本目录**不是本项目的模块文档**，不参与模块索引，不替代实现说明或开发决策。本项目现状以[项目结构文档](../项目结构文档.md)及其模块明细为准。

> **使用注意**：本目录文档仅供宏观对照与线索参考，不构成技术实现的直接依据。若评估某项能力确有可参考或借鉴价值，必须针对对应目标项目的官方文档、实际源码与具体依赖开展专项深入调研，结合本项目实际技术栈与规范独立设计，不得直接依据本目录的快照式结论推进开发。

## 记录约定

- 一个项目一个文件；本页只做索引，不复制项目明细。
- 记录基本信息、许可证、技术栈、能力清单、分级对照、借鉴方向与依赖代价、信息来源；不抄官方正文，不写部署教程。
- 版本、仓库统计和发布产物均标注核实日期，只是快照。GitHub `open_issues_count` 包含未关闭的 Issue 与 PR，不当作纯 Issue 数。
- 能力以官方功能文档和注册清单为依据。文档声明、源码事实、设计推断分别表述；未读取实现的能力不作实现质量排名，未运行的产品不宣称效果已获验证。
- 对照基准是 pi-desk 当前内置产品能力，不把设计稿、待办、可安装扩展或用户在终端自行运行的程序计为已经集成。
- 分级为：**实质重合**（输入、输出与核心目标一致）、**部分重合**（只在某环节重叠）、**无对应**（本项目有、对方确认没有）、**对方独有**（对方有、本项目无）。资料不足时写“未核实”，不以未发现代替不存在。
- 对照结论随本项目实现变化而调整；外部项目的公开能力不自动成为本项目必须实现的需求。
- 根许可不替代第三方目录许可。对源码可见、非商业许可的主体只讨论公开产品方向，不将其实现当成可自由移植的开源代码。
- 借鉴可行性：**高**指现有依赖与架构可覆盖；**中**指需新增外部组件；**低**指需要独立产品级设计。评级不代表已排期或获开发授权。
- **深入调研原则**：宏观对照与借鉴评级不能代替具体实现的工程调研。若在具体架构、协议或能力上确有参考价值，必须深入该项目的官方文档与实际源码进行针对性深入调研，不直接照搬概括性结论。
- 截图以官方仓库的 raw 地址直链引用，不在本仓库保存副本；图注依据官方 README 图注或相邻官方说明撰写，来源 URL 与核实日期记入各文件的「信息来源」。上游改动路径或改名会使图片失效，届时需回看并修正链接。

## 索引

| 项目 | 仓库 | 定位 | 与当前项目的关系 | 明细 |
| --- | --- | --- | --- | --- |
| DeepSeek Harness（DSH） | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 以插件组合构建的 Agent Harness，提供 Web、桌面与程序化入口 | 会话、模型和扩展能力重合；子代理、目标及沙箱策略超出当前内置能力 | [deepseek-harness.md](deepseek-harness.md) |
| dsh-superagent | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | DSH bundle 形式的主动式仓库 Agent：监听 GitHub（可选飞书），按策略把获准请求变成工单并在独立会话中执行 | 会话与项目内执行实质重合，委派与面板部分重合；外部事件源、准入闸门与授权模型、工单编排与影子模式超出当前内置能力 | [dsh-superagent.md](dsh-superagent.md) |
| Orca | [stablyai/orca](https://github.com/stablyai/orca) | 以工作树为中心的多编码 Agent 工作台 | Git、编辑器、终端与手机对话部分重合；任务工作区以稳定 ID 关联会话、文件、Git 与终端，远程执行、任务来源和完整审阅闭环仍有差距 | [orca.md](orca.md) |
| EvoFlow | [EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow) | 面向长任务的 Agent Runtime 与控制平面；主体为非商业源码可见许可 | 聊天、资源配置及串行计划部分重合；Goal、团队、可发布工作流与岗位调度超出当前内置范围 | [evoflow.md](evoflow.md) |
| EditHere | [Inginnng/EditHere](https://github.com/Inginnng/EditHere) | 截图、批注与组件调整的本地 AI 反馈工具；主体为非商业源码可用许可 | 外部工具协议与通用图片点框批注部分重合；系统抓屏、OCR、大爆炸布局拖拽与视频打点超出当前内置能力 | [edithere.md](edithere.md) |
| CoWork OS | [CoWork-OS/CoWork-OS](https://github.com/CoWork-OS/CoWork-OS) | 面向编码、知识工作与自动化的本地优先个人 Agent 桌面应用 | 桌面工作区与终端部分重合；CDP 浏览器自动操控与人机接管超出现状 | [cowork-os.md](cowork-os.md) |
| Lancer | [raylee-ai/lancer](https://github.com/raylee-ai/lancer) | 基于 pi-gui 和 pi 的桌面 AI 工作区，聚焦会话并行分支、事件拓扑图与交付物追溯 | Pi 接入实质重合；会话多分支与审阅部分重合，已有提交式快照服务但代码回退链未贯通；GitTree、独立 Turn 检查点、本地控制 API 与扩展前端沙箱仍有差距 | [lancer.md](lancer.md) |
| OpenBitFun | [GCWing/OpenBitFun](https://github.com/GCWing/OpenBitFun) | 基于 Rust Agent Runtime 与 Tauri 的开源多模式 Agent 工作台 | 会话、终端、Git 与 MCP 实质重合；Mini App、多模式 Harness、跨网多设备切换与 Computer Use 超出当前内置能力；内置受管浏览器与局域网免配置直连为本项目独有 | [openbitfun.md](openbitfun.md) |
| Ekko Studio | [EKKOLearnAI/ekko-studio](https://github.com/EKKOLearnAI/ekko-studio) | 本地优先的多 Agent AI 工作区与工作流工作台；主体为 BSL 1.1 源码可见许可 | 聊天、终端、受管浏览器与移动端部分重合；Vue Flow 可视化工作流、10 大平台网关、群聊房间与 Office 预览超出当前内置能力；声明式 GenUI 为本项目独有 | [ekko-studio.md](ekko-studio.md) |
| TencentDB Agent Memory | [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | 面向 AI Agent 团队的统一记忆中枢，提供分层记忆、Skill、Wiki 与 CodeGraph 四大资产 | 语义分层与白盒持久化实质重合；会话注入、混合检索与 Skill 部分重合；符号化短期记忆与多租户资产管理超出当前内置能力；双阶段审批门禁与主动读取统计为本项目独有 | [tencentdb-agent-memory.md](tencentdb-agent-memory.md) |
| Cline | [cline/cline](https://github.com/cline/cline) | 同一引擎分发为 IDE 扩展、终端 CLI、桌面应用与 SDK 的开源编码 Agent，另有云端托管代理 | 会话工作区、终端、工作树与 MCP 实质重合；技能与子代理委派部分重合；hub/spoke 会话守护、Agent Teams 任务板、看板编排、定时任务、消息连接器与云端沙箱超出当前内置能力；受管内置浏览器、生成式界面与记忆审批门禁为本项目独有 | [cline.md](cline.md) |

## 专题对照

横向机制对照不按项目拆分，也不为索引表增行；各产品的完整能力仍以对应项目文件为准。

- [sub-agent-delegation.md](sub-agent-delegation.md)：主代理如何决定把任务交给子代理，覆盖十个产品的派发入口、主动性来源、路由与策略层、并行与续派。
