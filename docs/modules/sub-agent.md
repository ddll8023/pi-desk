# 子代理

模块 ID：`sub-agent`。返回 [总览](../项目结构文档.md)。

## 职责与入口

把可独立完成的工作交给隔离子代理执行，并在主对话里给出归属、取消、失败与用量的所有者。入口是宿主内联扩展 `src/sdk-host/sub-agent/delegation-extension.ts` 注册的 `delegate_subagent` 工具，模型可调用、用户不直接触发，执行模式为串行：同一会话内不会并发跑两次委派。

任务类型有四种：`query`（代码查询）、`research`（技术调研）、`review`（代码审查）、`document`（受限文档修改）。调研与主会话的调研链路一致：子进程拿到内置的 `web_search`、`fetch_content`、`get_search_content`、`source_check`，用外部资料作依据；扩展由宿主在装配时注入子进程入口、技能目录、写入守卫路径与取消控制端，不从资源目录按文件路径加载；对应规范正文取自随包技能 `resources/agent/skills/sub-agent-*/SKILL.md`。委派时机由系统提示的产品工具分段（`src/sdk-host/product-tools-hint.ts`）与工具自身的类型描述共同承载；四类子代理规范只供子进程按目录读取，不进入主会话技能列表（清单里以 `subAgentOnly` 标记）。

## 执行与隔离

每次委派为独立子进程：`out/sdk-host/pi-cli.mjs --mode json`，经 `ELECTRON_RUN_AS_NODE` 让 Electron 二进制以 Node 模式启动。能力边界由进程参数强制，不是提示词劝阻：

- `--tools` 白名单：只读任务为 `read/grep/find/ls`，调研任务另加 `web_search/fetch_content/get_search_content/source_check`，文档任务另加 `edit/write`；
- `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp --no-session`：不继承用户级与项目级配置、不装载其他扩展、不落盘会话；文档任务在该组合之外以 `-e` 显式加载写入守卫；调研任务同样以 `-e` 显式加载用户安装的 `pi-web-access`，入口缺失时直接返回 `web_unavailable`，不降级成只读本地的调研；
- 子进程没有委派工具，因此不能递归委派；不下发 `bash`。

任务说明由规范正文、本次请求 JSON 与输出要求组成，不注入父会话历史。预算按实测设定并写入请求约束，具体取值见 `TASK_PROFILES`（`src/sdk-host/sub-agent/delegation-extension.ts`）。

## 批次与并行

一次委派可带多个互相独立的任务（`tasks[]`），批内每个任务是独立子进程、独立预算、独立结论，并发数有上限。快照以任务数组交付，部分失败不影响其他任务的结论。同批两个文档任务在目标文件冲突时在派发阶段直接拒绝，同目录下的不同文件可以并行；冲突判定只看 `target_file`，不按目录范围字符串比较。

审查任务的两种形态：维度之间不并行，单个 review 任务按 `dimensions` 顺序逐项审，跨维度重复的问题只记一条；需要维度级并行时，把维度拆成同一批里的多个任务。

```json
{ "subagent_type": "review", "objective": "审查登录接口重写",
  "payload": { "code_to_review": "...",
               "dimensions": ["security", "performance", "convention", "logic"],
               "related_files": ["src/auth.ts"] } }
```

```json
{ "tasks": [
  { "subagent_type": "review", "objective": "审查登录接口重写：security",
    "payload": { "code_to_review": "...", "dimensions": ["security"], "related_files": ["src/auth.ts"] } },
  { "subagent_type": "review", "objective": "审查登录接口重写：logic",
    "payload": { "code_to_review": "...", "dimensions": ["logic"], "related_files": ["src/auth.ts"] } } ] }
```

拆分的代价：`code_to_review` 按任务重复传输，用量按任务分别计入，跨维度重复的问题会在各任务里各报一次，任务数受批内上限约束。

规范核对不单列维度：`payload.standards` 给出条款时，由 `convention` 维度逐条对照，`finding.reference` 记条款出处；条款不符按 `warning`/`info` 记，不改变 `pass` 判定（仍只看有无 `critical`）。子代理不会自行加载规范 Skill，条款必须由主 Agent 自包含传入。

## 文档写入边界

- 产品级硬上限：`docs/` 下的路径与仓库根 `README.md`。
- 任务级 `write_scope`（1–8 项）只能是该上限的子集，`payload.target_file` 必须已在其中；越界在派发阶段即判 `invalid_payload`，不启动子进程。
- 写入由守卫扩展 `src/sdk-host/sub-agent/write-guard.ts` 在子进程内执行：拦截 `write`/`edit`，按解析后的真实路径比对允许范围，范围缺失、格式非法或路径无法解析一律阻断，不按默认放行兜底。
- 守卫随宿主构建产出为独立入口 `out/sdk-host/sub-agent-write-guard.mjs`，不进入产品资源包，主会话不加载它。

## 可观察性与契约

子进程以 JSONL 事件流输出，扩展据此生成有界快照：对话时间线（assistant 叙述与工具调用按发生顺序交错，工具输出正文不进入快照）、工具活动、真实用量、终态与结论，另有实际写入的文件路径。快照在运行中随工具开始/结束与 assistant 消息结束推送、结束时随最终结果交付，两处都写入 `details.subAgents`，一个数组元素对应一项任务。契约与上限在 `src/shared/sub-agent-view.ts`；历史记录没有对话时间线字段时归一为空数组，快照仍可展示。宿主投影只从 `details.subAgents` 读取并重新校验一次，历史记录里只有单个 `details.subAgent` 的卡片归一为单元素数组。

页面在发生委派的位置渲染入口行 `SubAgentCard.vue`：给出一行摘要（任务类型、目标、状态、调用数与耗时），批内多任务另加一行汇总。点击后在 `SubAgentDialog.vue` 的弹窗里按对话阅读：执行中的叙述与工具调用交错展示，另有写入文件、用量、结论、错误与未解决事项，批次内可切换任务；没有对话时间线的历史快照降级为工具活动列表。关闭弹窗不中断执行，停止仍走单项取消。状态文案区分执行中、已请求停止、已完成、失败、已中断，不显示缺乏依据的进度。

任务状态用专用契约表达，不借用生成式界面载荷：两者的生命周期不同。

## 单项取消

页面按任务标识发起取消（`RUNTIME_SUB_AGENT_CANCEL_CHANNEL`），主进程核对运行实例与绑定代际后转给宿主，宿主按登记表把请求送到对应委派；未知标识直接忽略，不改变其他任务与当前轮。请求送达与真正停下是两个状态，终态仍以工具快照为准；取消走与整轮中断相同的收敛路径（`SIGTERM` 后 2s 内未退出则 `SIGKILL`）。

## 专属文件

| 文件 | 用途 |
| --- | --- |
| `src/sdk-host/sub-agent/delegation-extension.ts` | 委派工具注册、任务校验、子进程装载与事件流快照、批次调度与定向取消 |
| `src/sdk-host/sub-agent/control.ts` | 取消登记表：按任务标识登记与注销取消入口 |
| `src/sdk-host/sub-agent/write-guard.ts` | 文档写入守卫扩展：按绝对路径范围拦截 `write`/`edit` |
| `src/shared/sub-agent-view.ts` | 执行快照契约、字段上限与跨进程校验 |
| `src/shared/sub-agent-types.ts` | 任务类型、任务契约校验与文档写入产品上限 |
| `src/renderer/src/sessions/components/SubAgentCard.vue` | 子任务入口行：单项与批次共用，点击打开执行对话 |
| `src/renderer/src/sessions/components/SubAgentDialog.vue` | 执行对话弹窗：对话时间线、结论、写入、用量与单项停止 |

## 公共与跨模块引用

- [会话与聊天](sessions-chat.md)：工具执行投影携带快照，页面据此渲染卡片；子代理用量单列进会话用量与跨会话统计。
- [公共记录](shared.md#f-runtime-state综合-runtime-状态混合)：运行时通道与请求校验承载单项取消。
- 随包技能 `resources/agent/skills/sub-agent-*` 与 `resources/agent/bundle.json` 的技能声明。

## 状态与边界

- 归属是隐式的：子任务生命周期等于这次工具调用的生命周期，父级中断经工具 `signal` 收敛全部在途子进程，会话关闭与宿主退出时扩展主动终止在途子进程。没有主进程父子登记表，因此没有排队、没有跨调用归属，也不支持子任务脱离工具调用继续运行。
- 记录随会话走：快照作为工具结果的一部分进入会话记录，不另建独立存储，没有保留策略与访问边界；记录缺失时卡片降级为普通工具结果。
- 用量单列：子代理是另起的模型调用，其用量在会话用量与日统计各计一次，不与父会话累计混算；日统计不按模型拆分。
- 子进程是故障域隔离，不是文件隔离：与父会话操作同一份工作区，不构成 OS 沙箱；关闭扩展的代价是不继承宿主的安全钩子与供应商装配。
- 结果要过结构校验：状态取值、类型与任务标识一致、按类型必备的结论结构都必须满足，否则整体判 `invalid_output`。超时先收回子进程再返回结果：SIGTERM 未生效则强杀，强杀后仍收不到退出事件就按已终止收敛；结果带回工具调用次数、最后一次工具、已写入文件、收回方式与退出码；文档任务写入已生效时返回 `partial`，由主代理先核对文件现状再决定是否重试。
