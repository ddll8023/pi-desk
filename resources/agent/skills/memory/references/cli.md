# 用户级全局记忆 CLI 与候选协议

脚本为 `<实际Skill目录>/scripts/memory_store.py`，库为当前用户的 `~/.agents/memory-store/memory.db`（`--store` 指向目录，库文件名固定为 `memory.db`）。不根据 cwd 推断库位置，不要求项目登记或项目表。`--store <绝对路径>` 与 `--tzdata <IANA 目录>` 用于明确指定的数据位置与时区数据；桌面由宿主固定传入，独立 CLI 使用默认值。

需要 Python 3.10+ 与可用 IANA 时区。桌面由应用自带受管 Python 3.12 与随包时区数据运行，不使用系统解释器；两者缺失时直接报告，不回退。以下仅说明接口，不构成初始化、写入、检查、构建或恢复授权，不自动安装依赖。

## 查询

```text
status
recall --query "任务主题" --offset 0 --limit 50
recall --mode auto --project <UUID> --query "项目内的任务主题"
recall --mode records --query "需要远期细节的旧主题"
recall --mode recent --query "近期工作"
recall --mode historical --query "已有月摘要主题"
recall --mode month --month YYYY-MM --query "已有月摘要主题"
rules --query "规则主题" --offset 0 --limit 50
profiles --domain workflow
read <真实记录ID> ...
access-stats <真实记录ID> ...
month-source YYYY-MM --offset 0 --limit 50
months
```

- `recall` 与 `rules` 接受 `--project <UUID>`：只收窄来源项目，无归属的通用记录仍返回；UUID 须来自桌面项目注册表，独立 CLI 没有注册表时不传。不接受项目登记计划或项目绑定参数，项目名称也不能当作范围参数（只作普通主题关键词）。
- `status` 返回库路径、库版本（`store_version`）、变更序号、时区、记录／画像／摘要数量及统计状态，不建库、不修复。
- `recall` 默认 `--mode auto`：按时间分层——近 `recent_window_days` 天的日记直接参与排序，更早的月份优先用月摘要代表，缺摘要的月份回退该月最多两条日记；返回体带 `layer`、`cutoff`、`window_days`、`layers` 与 `missing_summaries`。`records` 才是全历史，recent 明确限近期，historical 仅查已有月摘要，month 必须明确月份且不接受与 auto 混用。旧 `search` 保留近期默认及 `--all-dates`，不与 recall 默认范围混淆。
- `recall`、`rules` 返回摘要；需全文时按真实 ID 调用 `read`。历史来源和有效状态不证明事实正确或当前适用。
- 分页使用 `offset`、`limit` 和返回的 `has_more`、`next_offset`，每批 1..200；跨页核对 `store_version`。
- `read` 按 1..50 个真实日记 ID 定位原文并核对版本，不扫描未索引历史。CLI read 本身不记录访问统计。
- `profiles` 按领域返回原始条目，包括历史作用域；自动背景及扩展工具只采纳全局或适用领域画像，不升级旧项目画像。
- `month-source` 返回指定月份的全部日记及真实来源，未完结月份拒绝；最后一天经用户确认结束可使用 `--closed-today-confirmed`。

全局接口通过 `memory_scope:"global"` 明确范围；`project` 回显本次收窄的来源项目，为 null 表示未收窄。旧条目可能携带 `project_id` 或 `source_project` 作为来源信息，只作来源标注，不构成当前项目绑定。

## 主动读取统计

`access-record --input -` 仅供扩展在完整原文准备好后调用。输入为真实 `ids`、宿主 `session_id`、`tool_call_id`、`store_version`，不接受外部计数、时间、正文或查询词。

在写事务内按调用身份去重，库忙即报告；不自动初始化或重试。首次成功事件写入库内统计表，统计不改正文、词项或库版本，不参与排序。

`access-stats` 只读取得次数、会话数、最近时间及 observed 状态；搜索、规则摘要、画像、自动背景和历史回放不计数。统计失败保留成功原文与未确认状态；写入开始后的取消不是撤销。

## 写入

```text
python <脚本> plan save --input -
# 人工核对该份计划内容后提交（扩展侧生成计划后直接提交）
python <脚本> commit --plan-id <实际返回ID> --approved
```

计划版本为 4，并明确 `memory_scope:"global"`。计划写入库内待确认表，24 小时失效；源、候选或引擎变化后重新预览。提交在写事务内核对库变更序号与引用关系，旧项目语义计划拒绝提交，不自动改写旧缓存。

`plan` 不是完全不落盘；`--approved` 只是引擎内部标记，不代表用户已逐份批准。桌面使用 memory_save 或 memory_profile_save：扩展经写入闸门判定宿主可写后直接提交并返回回执，模型不能传入 approved 或外部计划 ID。

### 日记候选

```json
{
  "agent":"pi",
  "records":[
    {"type":"progress","topic":"工作主题","content":"记录实际工作、结果与未完成部分。","status":"active"},
    {"type":"issue","topic":"已关闭问题","content":"问题、根因与处理结果。","status":"resolved"},
    {"type":"decision","topic":"明确决定","rule_key":"稳定语义键","content":"决定、理由及适用条件。","source_record_ids":[]}
  ],
  "status_updates":[
    {"id":"m_XXXXXXXXXXXXXXXXXXXXXXXXXX","status":"archived","reason":"工作已完成，不再影响后续决策"}
  ]
}
```

不传项目字段，不登记或默认使用 general。日期按库时区生成；补记过去事件在正文说明时间。可选 session_id 表示真实会话，不能更换 ID 绕过重复限制；扩展稳定编码宿主会话身份，不承诺旧版编码与新版自动对应。

类型为 decision、constraint、progress、issue、fact、preference_evidence。只有规则类提供 rule_key。先查语义重复和适用范围，同键只自动替代全局旧规则，不因历史来源同键而合并。

非规则记录可在候选中直接带 `status`：`progress`／`fact`／`preference_evidence` 支持 `active`／`archived`，`issue` 支持 `active`／`resolved`／`archived`；`resolved`／`archived` 不进入当前项目近况，仍可检索。关闭已有活跃记录用 `status_updates`，每项包含 `id`、`status`（`resolved`／`archived`）与 `reason`；只作用于 `active` 的非规则记录。

明确替代有效历史记录或跨键规则时提供 `supersede_record_ids` 与 `supersession_reason`。计划展示完整旧来源、旧新正文和理由，旧 ID、日期和正文保留；旧物理替换字段不接受。

返回 `new_records`、`superseded_records`、`status_updates`、`history_preserved`、`withdrawn_months`。新增记录进入已有当月摘要时列出撤回影响，不自动重建。

### 画像候选

```json
{
  "domain":"learning",
  "scope":"domain:learning",
  "basis":"explicit",
  "title":"稳定偏好",
  "content":"用户明确表达或确认的偏好与适用条件。",
  "source_record_ids":[],
  "replace_profile_ids":[]
}
```

scope 只能为 global 或所选 domain。basis 为 explicit 或 inferred_confirmed。替换 ID 必须属于同领域，完整展示 `replaced_profiles`；画像更新不删除日记来源。

### 月度摘要候选

```json
{
  "month":"YYYY-MM",
  "closed_today_confirmed":false,
  "rebuild_existing":false,
  "topics":[
    {"title":"工作主题","content":"基于当月真实日记归纳。","source_record_ids":["m_真实来源ID"]}
  ]
}
```

先完整取得月度来源再调用 plan month。主题来源必须属于该月，不要求同项目；展示 source_total、source_used、source_uncovered_ids。已有摘要仅经明确重建并展示覆盖内容后修改。

### 明确删除

`plan delete --input -` 接收 `{"ids":["m_真实记录ID"]}`。计划列出目标原文、来源、受影响引用、画像来源、访问统计及月摘要；独立 CLI 逐份核对后提交。

删除统计范围绑定目标 ID，提交时新增的对应统计也在范围内；不含完整范围的旧计划拒绝。删除后继不恢复过时规则，画像已确认正文不自动删除。删除不涵盖外部备份、Git 或其他设备。

## 独立维护

- `init --timezone <用户确认IANA时区>`：仅首次明确授权且目标目录为空时创建 `memory.db`，不创建项目表，不覆盖已有库。
- `migrate [--from <旧库目录>]`：独立获批后把旧 Markdown 库一次性导入，旧目录改名为 `<原目录>-archive-<时间戳>`；导入失败回滚改名，不保留半成品库。
- `validate`：检查记录、引用与摘要一致性，不是默认收尾。
- `integrity`：完整性检查（`quick_check`、词项长度与库版本），不是默认收尾。
- `reindex`：独立获批后从记录重算词项表，不改写正文，不在查询端自动运行。
- `export --out <目录>`：生成只读 Markdown 快照供人阅读，不参与写回，引擎不读取这些文件。
- `plan-show --plan-id <ID>`：读取待确认计划原文，供扩展核对预览与计划内容一致。
- `reassign --from <旧归属> --to <新归属> --approved`：独立获批后改判记录归属，只改归属、保留记录与替代链；目标归属下已有同键有效规则时拒绝并列出 ID。

接口返回 `{ok,data,error}`。缺库、版本不符、权限错误、库忙、计划失效与引用不一致分别报告。禁止直接改写库文件绕过这些状态，也不把未执行操作描述为通过。
