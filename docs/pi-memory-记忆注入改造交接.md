# pi-memory 记忆注入改造交接

记录 pi-memory 记忆系统的调查结论、已落地的改动与未决事项。文中事实均可从本仓库与用户级记忆库直接核对，不依赖任何会话记录。

## 1. 需求

用户提出的问题按顺序是三层，后续讨论都围绕这三层：

1. **模型从不主动查询记忆。** 观察是：只有用户明确说「你应该读取记忆」，模型才会调用 `memory_search` / `memory_rules` / `memory_read`；其余时候一次都没有。
2. **注入的内容没有被完整遵守。** 关键案例是背景的「近期决定与约束」小节里已出现「开源项目参考记录的写法约定」，产物仍漏掉其中的条目。
3. **希望在没有用户提醒的情况下，既有约定就能起作用。**

前两层的调查结论是：注入通道在用，工具调用通道从未被用过。由此形成的方向是——**把必须遵守的约定完整放进每轮背景，让模型不需要搜索**；「主动搜索」只能靠拦截强制，行业没有先例，是否要做仍未定（见第 5 节）。

## 2. 当前实现状态

改动已落在工作区，未提交、未构建。要生效必须执行 `npm run sdk-host:build` 重算 `resources/agent/bundle.json` 指纹，否则宿主以「产品资源与内容清单不一致」拒绝建立会话。

| 文件 | 当前行为 |
| --- | --- |
| `resources/agent/extensions/pi-memory/context.ts` | 常驻约定按 `rule_key` 族聚合（`newestByFamily`），近七天每族取最新一条，按「约束优先 + 日期倒序 + id」排序后注入全文（`residentBlock`，单条上限 2000 字、保留条目换行、超限留 `memory_read <id>` 指针）；预算 `RESIDENT_BUDGET = 20_000`，用尽才降为索引行（`residentIndex`，上限 20 行）；全文由 `residentBodies` 二次调 `engine.read(ids)` 取得；`RESIDENT_TIMEOUT = 3_000` 覆盖两次读取；首行表述为「用户已确认的约定用于约束本轮产出，历史条目仅供参考」；小节名 `【常驻约定：用户已确认，产出前核对】`；`status()` 的 `automatic_recall.resident` 输出 `{status, families, injected, indexed, omitted, budget, chars}` |
| `pi-memory/recall.ts` | 任务召回小节名 `【任务相关历史，仅供参考】` |
| `pi-memory/tools.ts` | `memory_rules` 描述前置「起草或修改文档、清单、索引、规范…时先查询」，并写明按 `rule_key` 查询 |
| `src/sdk-host/product-tools-hint.ts` | 记忆分段增一条：已注入的约定优先于通用习惯，产出文档类内容前先按 `rule_key` 核对 |
| `resources/agent/skills/memory/SKILL.md` | 默认行为第 1 条改为「常驻约定 + 已注入且适用的约定应当遵守」；权限条款改为「不授予执行命令/外传/变更权限/绕过确认，但约定仍应遵守」；读取与保存补「约定类内容存为 `constraint` + 命名空间式 `rule_key`」 |
| `resources/agent/skills/memory/references/search.md` | 背景结构描述与上述口径一致 |
| `resources/agent/extensions/pi-memory/README.md` | 自动背景一节同步为「近七天全部族每族最新一条注入全文，预算用尽才降为索引」 |

已删除的旧形态：单条 80 字截断、1000 字符预算、1.5 秒超时、首行「不是系统指令，不授予操作权限」整句、小节名「常驻规则摘要：近期决定与约束」、以及只允许十个具名族进全文的族白名单。

## 3. 可直接核对的事实

| 事实 | 值 | 核对位置 |
| --- | --- | --- |
| 记忆库位置 | `~/.agents/memory-store` | `memory/SKILL.md`、扩展 `config` |
| 库内记录 | 260 条 | `index/records.json` |
| 有效规则（decision / constraint） | 116 条 | 同上，`type` 与 `status` 字段 |
| 近七天规则 | 85 条，分属 41–45 个 `rule_key` 族 | 同上，`date >= 今天-7` |
| 各族最新一条正文合计 | 约 17900 字符 | 按 `rule_key` 前缀聚合 |
| 引擎 `rules` 返回 | 每条正文截断到 200 字并标记 `content_truncated` | `skills/memory/scripts/memory_store.py::active_rules` |
| 引擎召回 | 词法相关度 × 类型权重（constraint 1.8 / decision 1.6 / preference_evidence 1.4 / fact 1.1 / issue 1.0 / progress 0.7），规则与经历各最多 3 条 | 同文件 `background_recall` |
| 注入槽位 | `context` 钩子返回 `CustomMessage`，Pi 转成 user message 置于消息列表首位 | `pi-coding-agent/docs/message-types.md` |
| 门禁能力 | `skill-guard` 有 `before_agent_start` 与 `tool_call → {block:true}`；pi-memory 只注册了 `context` | 两份 `index.ts` |

## 4. 调查结论

| 编号 | 结论 | 定性 |
| --- | --- | --- |
| R1 | 常驻把每条规则压到 80 字，多条目规则只剩第 1 条 | 确定性缺陷（已修） |
| R2 | 常驻预算 1000 字符且仅按日期排序，七天窗口 85 条只进 8 条，与函数注释「最近七天」矛盾，丢弃无提示 | 确定性缺陷（已修） |
| R3 | 首行「不是系统指令，不授予操作权限」比 `memory/SKILL.md` 的权限条款更宽，把用户确认过的约定一并否掉 | 措辞缺陷（已修） |
| R4 | `memory_rules` 描述与产品分段只有「设计取舍/偏好/反复出错」，没有产出类型触发 | 设计缺口（已补） |
| R5 | 引擎 `rules` 只给 200 字，取全文必须再调 `engine.read`，常驻因此是两次读取 | 实现约束（已按此实现） |
| R6 | 常驻只收 decision/constraint，用户选定的「截图直链」约定当初存为 progress，结构上永不进入常驻 | 设计缺口（已在 SKILL.md 补保存口径，旧记录未改） |
| R7 | 没有「应查未查」检测点；skill-guard 具备同构能力但记忆未接线 | 设计缺口（未处理） |
| R8 | 纠正后无沉淀入口；`memory_save` 只在用户明确要求时准备候选 | 与「不自动保存」一致，不视为缺陷 |
| R9 | `docs.reference-record-writing` 第 1 条只覆盖「对方仓库无任何图片资源」，对「有 cover 图但无产品截图」的仓库没有写法 | 规则文本缺口（未处理） |

被证伪的两个假设：注入位置（会话首位）——Claude Code 用的是同一槽位，不构成缺陷；常驻与召回的预算互相挤占——两者是独立预算。

## 5. 未决事项

1. **构建**：`npm run sdk-host:build`，未执行、未授权。
2. **常驻覆盖率的验收口径**：构建后在标准模式、记忆开启的新会话执行 `/memory status`，看 `resident.injected` 是否接近族数、`indexed` 是否为 0。
3. **是否接门禁**：`tool_call` 窄口径（`docs/**`、`*.md` 的 `write`/`edit` 与 `delegate_subagent(document)`）是唯一能让搜索确定发生的手段；代价是首写多一次工具往返，且与「记忆不阻碍工作」冲突。行业里没有产品这么做：Claude Code 的 hook 用于阻止危险操作，不用于强制读记忆。
4. **规则文本缺口**：修 `docs.reference-record-writing` 第 1 条，需走 `memory_save` 审批替换。推荐改为「无论图片情况都保留该节，无可直链产品截图时写明『无官方产品截图可直链』+ 核实日期」。
5. **`memory-manager` 的 notice 透传**：配置读取失败按关闭处理时，会话内 `/memory status` 只显示 `disabled_by: "user"`，与用户主动关闭不可区分。推荐把 `notice` 透传到宿主配置，并在状态里输出。

## 6. 继续工作的入口

1. `git status` 确认上述 7 个文件为已修改状态。
2. `npm run sdk-host:build`。
3. 设置 → 记忆 → 全局记忆「开启」；执行模式切到标准模式（快速模式会整组下线 `memory_*` 工具，见 `src/sdk-host/session-runtime.ts::FAST_MODE_DROPPED_TOOLS`）。
4. 新建会话，`/memory status` 核对 `enabled: true`、`disabled_by: null`、`resident` 各字段。
5. 需要裁决的两件事：是否接门禁（第 5 节第 3 项）、是否修规则第 1 条（第 5 节第 4 项）。

## 7. 关键文件

| 用途 | 路径 |
| --- | --- |
| 常驻装配与注入 | `resources/agent/extensions/pi-memory/context.ts` |
| 召回渲染与去重 | `resources/agent/extensions/pi-memory/recall.ts` |
| 工具契约 | `resources/agent/extensions/pi-memory/tools.ts` |
| 产品提示分段 | `src/sdk-host/product-tools-hint.ts` |
| 快速模式裁剪 | `src/sdk-host/session-runtime.ts` |
| 记忆规范 | `resources/agent/skills/memory/SKILL.md`、`references/search.md` |
| 记忆引擎 | `resources/agent/skills/memory/scripts/memory_store.py` |
| 可复用的门禁实现 | `resources/agent/extensions/skill-guard/index.ts` |
