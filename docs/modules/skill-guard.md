# 门禁

模块 ID：`skill-guard`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责登记主模型选择的执行技能、仅审查对象与必读引用，核对已登记正文是否以当前版本完整进入有效模型上下文，并在修改类工具执行前阻断未满足条件的调用。入口是宿主扩展 `resources/agent/extensions/skill-guard/`：注册 `skill_guard_select` 工具，挂钩 `before_agent_start`、`context_with_system`、`tool_call`、`tool_result` 与会话分支／压缩／关闭事件，经 `systemPromptOptions.sections.skill_guard` 向每次请求注入门禁说明与当前登记摘要；`/skill-guard` 命令只比对内存加载版本与磁盘差异，不重载。

门禁不替模型选择技能，扩展内不维护技能名称、业务触发词或引用文件名；`read`、`grep`、`ls`、`ffgrep`、`fffind` 等只读检索工具、只读记忆工具（`memory_status`、`memory_search`、`memory_rules`、`memory_read`、`memory_access_stats`、`memory_profiles`）与选择工具本身不受拦截。它也不是命令沙箱，不构成方案、文件清单、测试、构建或重启的授权。

## 登记与沿用

登记范围是本轮执行技能、仅审查对象（其正文不作为执行规范）和必读引用；引用必须位于所属技能目录内，技能入口不能重复登记为引用。登记只接受当前已具备完整入口证据的选择；登记本身不代表正文已读，新登记也不能为同一批其他调用放行。

同一会话内的新请求默认沿用上一次登记：`before_agent_start` 置 `inherited` 并保留执行技能、审查对象与引用，不再逐轮要求重新登记。以下情况作废登记并要求重新判断：

- 已登记正文离开有效上下文——压缩或裁剪后只补读不足以恢复，须重新加载后重新登记；
- 技能路径或内容版本变化，或技能不再属于宿主候选；
- 本次 `edit`／`write` 的目标技术栈族与上次实际改动的族没有交集；
- 用户显式加载技能（`/skill:` 协议外壳或宿主注入的技能块）；
- 会话分支切换或上下文压缩。

系统提示每轮输出当前沿用的登记摘要，模型据实际任务决定是否替换清单，门禁不判断该替换是否必要。

## 技术栈族

`stackFamilies` 按文件扩展名把改动目标归并为 `web`、`python`、`java`、`jvm`、`go`、`rust`、`sql`、`shell` 等族，只用于判断沿用的登记是否仍然适配，不映射到任何技能，也不据此推断该用哪份规范。文档、配置、锁文件与无扩展名文件视为栈中性，不触发撤销。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `resources/agent/extensions/skill-guard/index.ts` | 会话状态、工具注册、事件挂钩、系统提示注入、审计条目与阻断说明 |
| `resources/agent/extensions/skill-guard/routing.ts` | 宿主候选校验、显式技能识别、显式加载资格、文件目标提取、扩展名到技术栈族归并 |
| `resources/agent/extensions/skill-guard/context.ts` | 每次请求重建加载证据、分段读取覆盖核对、缺失与版本变化判定 |
| `resources/agent/extensions/skill-guard/references.ts` | 必读引用归属与目录边界校验、从实际读取路径建立候选 |
| `resources/agent/bundle.json` | 扩展入口与组成文件声明 |

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：宿主装配产品资源，并从共享目录只读加载用户级 `AGENTS.md` 与 skills；只有非产品路径争用产品工具名才拒绝建立会话，其余资源问题只作诊断。
- [F-build](shared.md#f-build构建与发行上下文)：`scripts/stage-agent-resources.mjs` 把 `resources/agent/` 原样暂存到 `out/sdk-host/agent-resources/` 并生成内容指纹；`src/shared-process/agent-resources.ts` 读取清单、校验指纹，并要求组件中包含门禁扩展。源码改动未经构建不会进入桌面运行的副本。
- `src/sdk-host/projection/activity-projection.ts` 只消费 `context-loaded` 审计条目生成会话技能活动，其余审计事件不进入投影。
- 工具卡片：`src/shared/tool-operation.ts` 把选择工具归为控制类操作，`src/sdk-host/projection/tool-presentation.ts` 与 `src/renderer/src/sessions/tool-summary.ts` 摘要选择结果。
- [会话与聊天](sessions-chat.md)、[资源与 MCP](resources-mcp.md)：宿主建立会话时装配产品资源，技能目录与扩展命令的展示归资源模块；门禁只消费宿主已发现的技能候选。

## 关键链路

1. 模型判断适用性并读取技能入口与必读引用，随后调用 `skill_guard_select` 登记。
2. 扩展校验候选资格、显式加载资格与引用边界，把当前证据连同 `generation` 写入会话状态，追加 `selection-registered` 审计。
3. 下一次模型请求重建证据：`context_with_system` 从真实消息重放系统段与 `read` 结果，核对正文全文覆盖后写 `context-loaded`。
4. `tool_call` 依次核对审计可写、登记存在、登记批次、技能版本与正文证据、技术栈族；通过则放行，否则写 `blocked` 并返回未执行原因。
5. 沿用的登记在正文失效或技术栈变化时写 `inheritance-revoked`，退回“须重新加载并登记”。

## 状态与边界

| 状态／资源 | 权威维护位置 | 生命周期与约束 |
| --- | --- | --- |
| 会话门禁状态 | `index.ts` 的 `stateFor`，以 `sessionManager` 为键的 `WeakMap` | 进程内存，作用域为会话 ID 与工作目录；分支切换、上下文压缩与关闭分别失效或清除 |
| 加载证据 | `context.ts` 的 `SkillContext.loaded` | 每次模型请求整体重建，工具调用阶段不追加；磁盘版本或路径变化即判缺失 |
| 审计条目 | `appendEntry`（自定义类型 `skill-guard`） | 随会话分支保存，只记身份、版本、来源与状态，不复制选择参数、理由或正文 |

门禁不写用户文件、不写记忆库，也不改变宿主对工具的既有权限。

## 结构覆盖边界

加载证据只认当前有效上下文中的全文，模型自述、工具完成事件与旧审计条目都不构成放行依据；运行中的桌面使用 `out/sdk-host/agent-resources/` 的构建副本，`/skill-guard` 仅报告差异，不触发重载。
