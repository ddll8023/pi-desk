# pi-memory 注入范围开发任务

## 1. 文档定位

本文是 [`pi-memory-注入范围设计.md`](./pi-memory-注入范围设计.md) 的开发侧配套：把设计确定的口径拆成可执行任务，标明每项的准确文件、依赖顺序与进入该阶段前需要先定的事项。

分工：口径、取舍与不做项以设计文档为准，本文不重复；本文只写任务、文件与依赖。测试、构建、运行与验收安排不在本文范围，按开发阶段单独讨论与授权。文件行号会随改动漂移，本文以「路径 + 符号名」定位，行号仅作当前参考。

## 2. 阶段总览与依赖

| 阶段 | 范围 | 依赖 |
| --- | --- | --- |
| 1 | 扩展装配：共享池合并结算、整体缓存、停用判定迁移 | 无 |
| 2 | 删除任务召回与报错召回整链 | 阶段 1（停用判定需先迁走） |
| 3 | 注入审计、跨进程契约与记忆注入卡片改为三段 | 阶段 1 |
| 4 | memory-manager-web：装配复刻、视图、需求文档 | 阶段 1 确定的口径 |
| 5 | 两仓文档与静态检索收尾 | 阶段 2、3、4 |

阶段 2 与阶段 3 在阶段 1 完成后可并行；阶段 4 只依赖阶段 1 的口径，不依赖 pi-desk 的界面改动。阶段 1 与阶段 4 的口径必须同批确定——查看器复刻的是同一份结算规则，分开落地会出现预览与实际注入不一致。

### 2.1 阶段 1 已定事项

| 事项 | 结论 |
| --- | --- |
| 单条正文上限 | 保持约定 2,000、近况 1,200，不随合计预算下调 |
| 状态字段 | `automatic_recall` 改名 `background`，保留 `resident`、`notes` 子键，新增池级字段（合计上限、已用、剩余、截止日期、丢弃条数） |
| 纳入统计的正文 | 只累计正文块；索引行、段标题与段尾提示不占额度，与现有「预算只约束正文块」一致 |

## 3. 阶段 1：扩展装配

目标：把两段独立预算换成一份按日期统一结算的共享池，并把缓存收敛为一份。

| # | 任务 | 文件与符号 |
| --- | --- | --- |
| 1.1 | 预算常量收敛为单一池，删除分段预算常量 | `resources/agent/extensions/pi-memory/context.ts` 顶部常量：保留 `RESIDENT_BUDGET`（改为 10,000）、`RESIDENT_MAX_RULE_CHARS`、`RESIDENT_NOTE_MAX_CHARS`、`RESIDENT_INDEX_ROWS`、`RESIDENT_NOTES_LIMIT`；删除 `RESIDENT_RULES_BUDGET`、`RESIDENT_NOTES_BUDGET` |
| 1.2 | 停用判定迁入装配模块 | 从 `resources/agent/extensions/pi-memory/recall.ts` 迁出 `memoryDisabledByRequest` 及其依赖 `userText`、`CONTINUATION`、`SUPPLEMENT`，落到 `context.ts`（或同级新模块）；`index.ts` 的导入同步改；行为不变 |
| 1.3 | 合并结算 | `context.ts` 的 `residentSummary` 与 `projectNotes` 合并为一次结算：取规则候选（近七天、`rule_key` 非空、当前项目与通用归属）→ 取近况候选（近七天、当前项目、非规则类、最多 3 条）→ 合并 → 按日期降序、同日 `constraint` 先于 `decision`、规则先于近况、ID 降序 → 逐条装入，装不下即停 → 产出两段正文、条目身份（`recordEntry`）、统计（合计上限、已用、剩余、截止日期、丢弃条数） |
| 1.4 | 段内约束保留 | 近况 3 条名额在合并前裁剪，不参与跨段排序；索引行最多 20 行，只展示被预算挤出的规则候选 |
| 1.5 | 缓存与重试收敛 | `State` 中 `resident`／`notes`／`residentAttempts`／`notesAttempts`／`residentStats`／`notesStats`／`residentEntries`／`notesEntries`／`notesDropped` 合并为单份结算结果；任一段读取失败整份不缓存，下一次请求整份重算；缓存失效点（`shutdown`、`beginSave` 回调、`reset`）同步改 |
| 1.6 | 状态与摘要 | `context.ts` 的 `status()` 与 `statusSummary()`：`automatic_recall` 改名 `background`；删除 `recallLine`、`SKIP_REASONS` 与召回专用状态标签（`no_match`／`skipped`／`budget_omitted`／`already_present`）；摘要改为报「注入 N 条 · 覆盖至 YYYY-MM-DD · 未注入 M 条」 |
| 1.7 | 背景文本 | `context.ts` 的 `background()`：去掉 `【任务相关记忆】` 与报错段拼接；段标题顺序保持「适用偏好 → 常驻约定 → 当前项目近况」；近况段保留「另有 N 条因预算未注入」与新增的截止日期说明 |

交付物：一次结算函数、单份缓存结构、新的统计字段与状态摘要文案。

## 4. 阶段 2：删除召回与报错整链

目标：删除两条只有自动注入使用的调用链，不留第二套无人使用的路径。

| # | 任务 | 文件与符号 |
| --- | --- | --- |
| 2.1 | 扩大装配入口 | `resources/agent/extensions/pi-memory/context.ts`：删除 `automaticBackground`、`errorBackground`、`errorEntries`、`recall`、`recallStatus`、`lastAuditKey` 中与召回相关的分支，以及 `import { acceptRecall, renderRecall, selectTask }` |
| 2.2 | 删除召回模块 | 删除 `resources/agent/extensions/pi-memory/recall.ts` 整份文件 |
| 2.3 | 删除引擎方法 | `resources/agent/extensions/pi-memory/engine.ts`：删除 `backgroundRecall`、`errorRecall`；`maintenance` 那句「不自动重建词项」保留 |
| 2.4 | 删除引擎子命令 | `resources/agent/skills/memory/scripts/memory_store.py`：删除 `background_recall`、`error_recall`、`add_parser('recall-background')`、`add_parser('error-recall')` 与分发分支；`BACKGROUND_POLICY` 若确认仅召回使用则删除，`SEARCH_ALGORITHM` 与词法核心保留（`memory_search` 仍用） |
| 2.5 | 改写使用说明 | `resources/agent/extensions/pi-memory/README.md`（自动背景与 `recall-background`／`error-recall` 两条）；`resources/agent/skills/memory/references/cli.md`（两个子命令的入参与返回）；`resources/agent/skills/memory/SKILL.md`（第 1 条「与任务相关历史」、第 8 条的 `automatic_recall` 与无命中原因） |

交付物：召回相关符号在仓库内引用归零；三处说明只描述三段背景与主动检索工具。

## 5. 阶段 3：注入审计、契约与卡片

目标：审计段集合与卡片 tab 改为三段，新旧审计由版本区分。

| # | 任务 | 文件与符号 |
| --- | --- | --- |
| 3.1 | 契约改版 | `src/shared/runtime/memory.ts`：`MemoryInjectionSnapshot.version` 改为 `2`；`MemoryInjectionEntries` 只保留 `profiles`、`resident`、`notes`；删除 `requestKey`；`isMemoryInjectionSnapshot` 收紧为「`version === 2` + 三段齐全」，文件头注释同步 |
| 3.2 | 扩展写入 | `resources/agent/extensions/pi-memory/context.ts`：`InjectionSegments` 三段、`recordInjection` 与 `recordSkip` 写 `version: 2` 并去掉 `requestKey` |
| 3.3 | 宿主侧扫描 | `src/sdk-host/session-runtime.ts` 的 `MEMORY_INJECTION_CUSTOM_TYPE` 保持 `pi-memory.injection.v1`（条目类型名不变，新旧由 `version` 区分）；`readMemoryInjection` 的反向扫描不改 |
| 3.4 | 卡片 | `src/renderer/src/sessions/components/MemoryInjectionDialog.vue`：`SegmentKey` 与 `SEGMENTS` 改为三段；删除召回专用状态标签；`segments` computed 与空段提示、`focusDefaultSegment`、tab 无障碍 id 随段集合调整 |
| 3.5 | 链路传导核对 | `src/sdk-host/protocol.ts`（`memory-injection` 与 `memory-injection-result` 帧与校验）、`src/sdk-host/index.ts` 分发表、`src/main/sessions/sdk-host-manager.ts`（请求→结果映射与 `readMemoryInjection`）、`src/main/sessions/sdk-runtime-bridge.ts`、`src/main/resources/ipc.ts`、`src/preload/runtime.ts`、`src/renderer/src/sessions/services/runtime.ts`：确认只透传类型、无需各自改字段 |

交付物：三段审计条目、三段卡片；旧五段条目在读取侧判为「没有审计」。

## 6. 阶段 4：memory-manager-web

目标：预览复刻与真实注入同口径，仓库路径 `/Users/mima1234/Desktop/code/memory-manager-web`。

| # | 任务 | 文件与符号 |
| --- | --- | --- |
| 4.1 | 装配复刻 | `server/store.mjs`：常量改为单一 `RESIDENT_BUDGET`；`resident()`（当前约在 1582 行）改为合并结算，返回合计上限、已用、剩余、截止日期、两段条目与丢弃条数；`server/store.mjs` 顶部注释与 `resident()` 上方说明同步 |
| 4.2 | 视图口径 | `src/views/ResidentView.vue`：预算条 `usedPct` 按合计用量计算；页面顶部说明从「约定预算 17000 / 近况 3000」改为合计口径与截止日期 |
| 4.3 | 桥 | `server/bridge/context.mjs` 的 `formatContext`：结构不变，增补一行截止日期说明；「预算外索引」段逻辑随新字段核对 |
| 4.4 | 文档数字 | `README.md`（常驻约定段）、`docs/REQUIREMENTS.md`（R-0.4 行的「预算 20000」）改写为合计 10,000 与按日期统一结算 |
| 4.5 | 现有断言 | `tests/store.test.mjs`（预算断言与「constraint 优先拿到正文」用例）、`tests/bridge-tools.test.mjs`（`formatContext` 空内容与归属过滤用例）按新口径调整 |

交付物：预览与桥的注入结果与 pi-desk 一致；文档数字单一来源。

## 7. 阶段 5：文档与静态检索收尾

| # | 任务 | 文件 |
| --- | --- | --- |
| 5.1 | 模块文档 | `docs/modules/memory.md`（背景装配、展示端、内容上限表、无需工具的情形几处）、`docs/modules/sessions-chat.md`（记忆注入卡片的分段描述与关键调用链） |
| 5.2 | 结构文档 | `docs/项目结构文档.md`、`docs/project-map.html` 中描述注入段与召回的行 |
| 5.3 | 设计文档状态 | `docs/pi-memory-注入范围设计.md` §9 阶段表状态与当前事项 |
| 5.4 | 引用归零 | 用 `grep -F` 逐项确认：`recall-background`、`error-recall`、`任务召回`、`报错召回`、`五段`、`17000`、`20000`、`automatic_recall`、`requestKey`；留存项需说明保留理由 |

交付物：仓库内不再有描述已删除能力的段落；设计文档阶段状态与实际一致。

## 8. 跨阶段约束

1. 同一口径只在一处维护：结算规则在 `context.ts` 与 `store.mjs` 各一份实现，字段名可以不同，语义一一对应；改一处必须同批改另一处。
2. 不保留双轨：删除的符号不留在注释、文档或测试里做「历史说明」，需要说明的只在设计文档的取舍段。
3. 阶段内不扩大到主动检索工具：`memory_search`、`memory_rules`、`memory_read`、`memory_profiles`、`memory_save` 的行为与描述不变，`SEARCH_ALGORITHM` 与词法核心保留。
4. 记录与库不动：本任务不改任何记忆记录、库结构、词表与画像，不执行迁移。

## 9. 未决项

无。三处原待定项已定：memory-manager-web 进入阶段 4 时只有 `package-lock.json` 为 modified；桥已加覆盖范围行；截止日期与丢弃条数按「本次背景覆盖至 …，另有 N 条更早记录未注入」表述。
