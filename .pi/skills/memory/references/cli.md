# 用户级记忆 CLI 与候选协议

脚本为 `<实际Skill目录>/scripts/memory_store.py`，普通操作默认使用当前系统用户的 `~/.agents/memory-store/`；不要从工作目录选择数据根。`--store <绝对路径>` 只用于明确批准的隔离操作或迁移。项目本地知识使用文件工作流，不传项目目录给本脚本作为另一个全局库。

需要 Python 3.10+ 和可用 IANA 时区。以下为接口说明，不是初始化、写入、检查、测试或恢复的授权；调用实际解释器时遵循宿主环境约定，不自动安装依赖。

## 查询入口

```text
status
recall --query "任务问题" --offset 0 --limit 50
recall --query "任务问题" --project <明确限定的真实项目ID>
recall --mode recent --query "近期进展"
recall --mode historical --query "已有月摘要主题"
recall --mode month --month YYYY-MM --query "已有月摘要主题"
recall-background --input -
error-recall --input -
rules --query "主题" --offset 0 --limit 50
rules --project <明确限定的真实项目ID> --offset 0 --limit 50
profiles --domain workflow
read <真实记录ID> ...
read <真实记录ID> ... --project <明确限定的真实项目ID>
access-stats <真实记录ID> ...
months
```

- `status` 返回根目录、manifest、项目表、日记和画像数量及独立访问统计状态，不注册项目或创建统计文件。统计不可用时在其状态内报告，不伪装为零次。
- `recall` 默认 `--mode records`，从全局索引按中文词法相关性查询全部已保存日记；项目仅在明确给出 `--project` 时过滤，不依赖当前目录绑定，也不默认限定近期。结果含原始项目、日期、历史状态、`score`、`matched_terms`、`index_version` 和 `coverage`；`content` 返回前 200 字摘要并附带 `content_truncated: true`，完整正文需显式调用 `read` 二次读取。
- `recall-background --input -` 为扩展请求级自动背景专用的只读内部协议。标准输入接收 `query`、可选 `project_id`、`recent`、`date_from`、`date_to`、`cache_key` 与 `cached_ids`。复用现有 BM25 词法核心与来源指纹校验，执行保守相关度筛选并返回 `unchanged` 状态及结果摘要，被替代规则不自动注入；缓存命中仍核对来源与原文指纹。纯只读运行，不记录访问统计。
- `error-recall --input -` 为扩展报错指纹联动专用的只读内部协议。标准输入接收 `fingerprint`、可选 `project_id` 及 `limit`。仅检索 `type=issue` 的日记记录，要求至少命中 2 个词项，返回历史排障经历与避坑经验。纯只读运行，不自动沉淀新记录。
- `--mode recent` 显式使用 manifest 的近期窗口；`historical` 只查已有月摘要，`month` 必须同时给出 `--month YYYY-MM`。非 month 模式不接受月份；月摘要不是默认全局日记查询的前置。
- `recall`、`rules` 支持 `--offset` / `--limit`，每批 1..200；按 `has_more` / `next_offset` 继续，跨页版本变化时重读，不混合不同索引版本。
- `rules` 默认返回全局各项目当前有效决定/约束；显式项目过滤时只返回该项目。不加查询词可分页取得完整清单，有词时复用召回排序，不受近期窗口限制。`content` 截断为前 200 字摘要并附带 `content_truncated: true`，完整正文需显式调用 `read` 二次读取。项目归属和有效状态不表示适用于当前任务。
- `profiles` 按相关领域读取，作用域由 Agent 根据任务筛选；没有 `--scope` 参数，不自动推断或修改画像。
- `read` 从索引定位 1..50 个真实日记 ID，合并同文件读取并核对来源和真实身份。默认不要求项目绑定；显式过滤时，任一 ID 不属于该项目就报错。没有 `--date` 参数，索引未收录 ID 时不扫描历史。
- `access-stats` 只读查询 1..50 个真实日记 ID 的主动读取次数、去重会话数、最近读取时间及 `observed` 状态；查询不计数、不创建文件。`coverage:recorded_accesses_only` 只覆盖采集后事件，零次不表示过去从未使用。身份按当前索引核对，未知 ID 不扫描历史。
- 旧 `search` 保留近期默认及 `--historical` / `--month` 入口，`--all-dates` 选择全部日记索引；它们复用相同检索核心，不再触发原文全历史遍历。新流程使用 `recall`，不混淆两个入口的默认时间范围。
- `months` 返回月份及摘要可用性，不自动生成摘要。

检索依赖 `index/search.json`，不是第二套权威库。来源清单或内容版本不一致时返回索引错误，不伪装为无命中。来源属性用于判脏，返回原文核对内容指纹；查询不补建索引或回退全历史正文扫描。

查询不自动创建缺失锁文件、重建索引或恢复未完成事务；遇 `RECOVERY_REQUIRED` 停止并报告。

## 自动访问统计内部协议

Pi 扩展在 `memory_read` 的完整结果准备好并检查操作状态后默认自动调用 `access-record --input -`，用户无需设置开关或手动初始化。CLI `read` 本身不计数，搜索、规则、画像、项目知识、自动背景（含自动任务召回与缓存校验）及历史回放也不计入。

内部标准输入只接受 `ids`、`session_id`、`tool_call_id`、`index_version`：记录与来源版本来自真实读取结果，会话及调用身份来自宿主。不接受外部计数、时间、正文或查询词，不授予 Agent 手工伪造访问事件的权限。

引擎尝试取得既有独占锁，锁忙时返回 `ACCESS_BUSY` 而不等待或重试；取得锁后核对来源版本，按记录、会话与调用身份持久去重，再原子写入 `.system/access.json`。首次事件可创建该文件，但不初始化库或补建锁文件。只保存计数、采集起点、最近时间和哈希去重身份，不保存原始会话/调用 ID、正文或查询词；哈希关联不等于匿名化。返回 `recorded` / `duplicate` 及本次新增、重复记录数。

统计独立于正文、索引和保存计划指纹，不影响排序。提交开始后不强杀或自动重试；通信失败可能发生在写入之后，不能宣称确定未写入。扩展保留成功原文并返回 `access_statistics.status:unconfirmed`。停用记忆即停止读取及统计，刷新不清空计数；统计损坏不自动修复或从历史补算。

## 两阶段写入

```text
python <脚本> plan save --input -
# 从标准输入传入具体候选 JSON，展示完整返回，等待确认
python <脚本> commit --plan-id <工具实际返回的计划ID> --approved
```

`plan` 会在 `.system/plans/` 缓存短期候选，尚未改权威记忆，不能声称完全不落盘。用当前终端支持的标准输入方式，不在工作项目创建临时 JSON 文件。

当前计划包含 `plan_version:2`；协议版本由脚本生成，不由 Agent 编造。旧协议计划拒绝提交并要求重新预览。计划24小时失效，源内容变化会返回 `STALE_PLAN`，不得盲目重试。`--approved` 只是参数，不能替代用户对具体计划的确认。

多项目或多用途按当前状态依次生成计划，前一次提交会改变指纹，不提前生成多份计划后直接全部提交。

## 保存工作日记

以下仅是格式示意，不能自动提交；项目 ID 和事实须来自实际环境，`agent` 填真实宿主。

```json
{
  "project_id":"已登记项目ID",
  "agent":"pi",
  "records":[
    {"type":"progress","topic":"工作主题","content":"记录实际做过的事、结果和未完成部分，不捏造完成状态。"},
    {"type":"issue","topic":"待处理问题","content":"记录已知现象与未知之处，不编造根因。"},
    {"type":"decision","topic":"当时的决定","rule_key":"稳定语义键","content":"说明决定、理由与适用条件。","source_record_ids":[]}
  ]
}
```

类型为 `decision`、`constraint`、`progress`、`issue`、`fact`、`preference_evidence`。决定/约束必须有稳定 `rule_key`；其他类型不带规则键或替代目标。日记不要求通用性；项目工作归对应真实项目，`general` 用于非项目事项或明确提炼的通用经验。

脚本按库时区的当前保存日期组织记录。补记过去工作在正文注明实际时间，不能假定可传保存日期参数。`session_id` 可选，用于识别已保存的同项目会话；重复会话拒绝，不自动合并增量，也不允许换 ID 堆积重复内容。

`source_record_ids` 可引用已有真实日记，关联跨日进展或有来源的总结；不填文件路径、不编造 ID。日记正文可简述项目经历并指向本地主题，脚本不复制或维护项目文件。

### 决定的替代不是删除

保存前查看 `rules --project <id>`，比对语义与范围。相同键会自动列出当前旧版本；明确跨键替代时给新条目加入：

```json
{
  "supersede_record_ids":["m_实际旧规则ID"],
  "supersession_reason":"用户明确改变了原决定，旧正文作为历史保留"
}
```

显式目标须是同项目当前有效规则；同键已自动列入的 ID 不重复指定。旧字段 `replace_record_ids`、`replacement_reason` 拒绝接收，不能借旧协议触发物理覆盖。

计划预览返回 `new_records`、`superseded_records`、`history_preserved:true`、`withdrawn_months`；逐条展示完整旧/新正文与理由。提交后旧正文、日期和 ID 保留，元数据标为 `status:superseded` 并指向后继；新条目带 `supersedes`。这些生命周期字段由脚本维护，不在候选中手工伪造。

历史及月度来源仍可读取旧版本，`rules` 只返回当前有效版本。旧记录缺少生命周期字段时按有效处理，不自动重写已有用户文件。

## 项目登记

`project_id` 是用户级日记分类，不等于项目本地知识库路径。先由 `status` 将名称/别名映射到已有 ID，不从当前目录名自动生成。

需要新登记时先展示：

```json
{"id":"稳定小写英文ID","name":"已确认项目名","aliases":["已确认别名"]}
```

使用 `plan project --input -`，具体计划确认后提交。新建空库时已有 `general`，不重复登记；记录日记的许可不自动授权新建近似项目或初始化库。

## 明确删除或纠错

```json
{"ids":["m_实际记录ID"]}
```

使用 `plan delete --input -`。预览返回完整 `delete_records`、`affected_record_references`、`affected_profiles`、`affected_access_statistics` 和 `withdrawn_months`；展示删除正文、相关来源/替代引用清理、对应访问统计范围以及月摘要影响后确认。

提交在同一事务中删除指定记录、清理悬空引用并移除目标在提交时的全部对应访问统计；审批期间新增的目标统计同属已展示范围，不影响其他记录。缺少统计范围的旧删除计划须重新预览，统计不可读时不绕过清理。不会让被替代旧规则复活，也不自动删除画像正文。普通更新、画像替换和月度总结不走删除流程。纠错需明确旧记录删除和正确内容保存的范围，不能把正常决定变更伪装成纠错。

## 个人画像

只在用户明确要求提炼或维护画像时准备候选；日记保存、月度总结和一次行为都不触发。

```json
{
  "domain":"learning",
  "scope":"domain:learning",
  "basis":"explicit",
  "title":"稳定偏好",
  "content":"填写用户明确表达或确认的稳定偏好及适用范围。",
  "source_record_ids":[],
  "replace_profile_ids":[]
}
```

`domain` 为 communication/coding/learning/workflow；`scope` 为 global、domain:<id> 或 project:<已登记ID>。`basis` 为 explicit 或 inferred_confirmed，后者须真实确认推测。先查相关画像；更新用同领域 `replace_profile_ids`，经 `plan profile --input -` 展示完整新旧画像并确认后提交。

预览含 `replaced_profiles`、`source_diary_preserved:true`。画像更新不删除过去日记或偏好依据。日记来源只有在用户另行明确要求删除时才清理，画像正文是否删除另按具体请求处理。

## 月度回顾

用户明确要求且月份完结后，默认读取所有项目：

```text
month-source YYYY-MM --offset 0 --limit 50
```

按 `has_more` / `next_offset` 读取完整指定范围；仅限项目时另加 `--project <id>`，不默认只取 general。返回日记包含历史版本与来源状态，回顾实际工作、结果、决定及未决事项，不只输出通用原则。

候选格式：

```json
{
  "month":"YYYY-MM",
  "closed_today_confirmed":false,
  "rebuild_existing":false,
  "groups":[
    {
      "project_id":"真实项目ID",
      "topics":[{"title":"工作主题","content":"依据真实日记描述当月工作与结果。","source_record_ids":["m_当月同项目真实来源ID"]}]
    }
  ]
}
```

用 `plan month --input -` 预览，再确认提交；已有摘要明确重建时设 `rebuild_existing:true`。月最后一天且用户明确结束当日记录时，读取使用 `--closed-today-confirmed`，计划对应字段为 true；其他未完结情况拒绝。

预览返回整月来源覆盖，不为提高覆盖率捏造总结。后来的决定仅改变旧记录有效性，不撤回旧月份历史；显式删除来源或对已整理月份新增日记时，计划列出需撤回月份，之后由用户另行请求整理。月度回顾不自动写项目知识、全局方法或画像。

## 独立维护与恢复

- `init --timezone <用户指定IANA时区>`：仅在用户明确要求首次初始化且目录为空时执行，不覆盖现有库。
- `validate`：检查记录、引用、有效版本与索引；不是读取或写入后的默认收尾。
- `reindex`：在独占锁内读取权威来源，重建 `index/records.json`、`rules.json`、`months.json` 和 `search.json`；使用既有事务发布，须独立授权，不自动迁移或改写记忆正文。正常获批提交也在原事务中更新这些派生索引，读取端不修复它们。
- `recover --approved`：在用户已单独批准恢复范围后处理未完成事务；没有 `--approved` 会拒绝，不因查询遇到事务而自动运行。

所有入口返回 `{"ok":true,"data":...,"error":null}` 或 `{"ok":false,"data":null,"error":{"type":...,"message":...}}`。遇协议旧版、来源变化、权限错误或恢复要求时按真实错误停止，不能改文件绕过约束或声称保存成功。
