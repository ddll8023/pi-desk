# pi-desk 项目长期记忆

## pi-memory 常驻预算与窗口（已定，不再讨论）

**结论：`RESIDENT_RULES_BUDGET = 17,000` 保持不动。** 不要因为“近七天规则装不下”去压缩规则、合并规则或上调预算。

判断依据（2026-11-12 由用户确认）：

- **17,000 是随手拍的数，不是从需求推导的。** 它既不用来证明“规则太多”，也不用来自我实现。把它当目标去优化是错的。
- **重点是近期，不是全部。** 近期装得下就够了；远期规则降为索引行是设计意图，不是缺陷。不要为了“把近七天全装入”而改动内容。
- **只有真契约装不下时才考虑调预算。** 判据：所有 `constraint` + 仍需生效的 `decision` 在近三天装不下，或真契约总量超过约 40 条。当前状态远未到。
- **禁止用“当前总量 + 余量”反推预算。** 曾据此算出 27,000，是把症状当需求，已被否决。
- **“降级为索引行”不能当兜底。** `access_events` 从 2026-11-04 起仅 59 次、覆盖 52 条记录——按需检索在实践中几乎不发生，掉出预算的规则接近无效。因此要么让它进预算，要么别把它存成 `decision`。
- **缩减靠降低流入，不靠调上限。** 主因是“做完即失效”的实施记录被存成了 `decision`；正确处理是转 `archived` 或降级为 `progress`。

判断一条记录该不该常驻，只问一句：**这条规则会不会在下周改变某个具体决定。** 不会的就不该是 `decision`。

## pi-memory 数据口径

- 常驻候选 = `status='active'` 且 `type IN (decision,constraint)` 且 `date >= 今天-7` 且 `project_id` 是当前项目或为空。**其他项目的规则整族排除，不计入预算**（曾误算进去，报成 72 条 / 37,622 字，实际 55 条 / 26,101 字）。
- 近况段与常驻段是两套预算：近况 3 条 / 3,000 字符 / 单条 1,200；常驻总 20,000 / 约定段 17,000 / 单条 2,000 / 索引行 20。
- 引擎在 `resources/agent/skills/memory/scripts/memory_store.py`，扩展在 `resources/agent/extensions/pi-memory/`，库在 `~/.agents/memory-store/memory.db`（git 仓库，可回溯）。
- 预演必须在**新副本**上做（`cp` 后 `--store` 指向它），副本提交一次就脏，下一次要重新复制。

## genui 模块已移除（现状基线，2026-11-13）

**结论：项目不再有「生成式界面」能力，不要再按它存在去找代码或文档。**

- 已删 `src/sdk-host/genui/`、`src/shared/genui/`、`src/main/genui/`、`src/renderer/src/genui/`、`preload/genui.ts`、`shared/genui-api.ts`、`shared/genui-params-api.ts`、`assets/genui.css`、`docs/modules/genui.md`。工具 `ui_render`/`ui_patch`/`ui_catalog`/`ui_inspect` 不再注册。
- **Extension UI 与被删模块无关**，桥接现在在 `src/preload/extension-ui.ts`（导出 `extensionUiApi`），主进程侧在 `main/sessions/extension-ui-*`。不要因为找不到 `preload/genui.ts` 而重建这层。
- 契约层已无 `ToolExecution.ui`/`latestRevision`、`SessionActivity.genui`/`genuiCount`、`SessionTarget.genui`、`desktop-config.json` 的 `genuiEnabled`。旧会话里的界面工具结果仍在 JSONL 中，只按普通工具卡片展示。
- **检索教训**：本机 BSD grep 不支持 `\|` 交替与 `\b`，带这些的模式会静默返回空、被误判成“已清理干净”。本仓检索一律用 `grep -F` 或 `grep -E`。

