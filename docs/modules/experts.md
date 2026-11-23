# 专家与专家团

模块标识：`experts`。返回 [项目结构](../项目结构文档.md)。

## 职责与入口

两层能力同属一个模块：**专家**给会话一个固定身份、方法论与能力范围（身份定义 → 装配期收窄 → 系统提示角色段），**专家团**在此基础上把多角色协作变成「团长调度 + 成员独立会话 + 共享任务账本」。两者共用同一套定义解析、标识规则、能力范围与写入范围，团队只在装配期追加一层收窄与一组团队工具。

入口按使用者分三类：

- 用户入口：设置页的「插件」分节里「专家与专家团」插件详情（列表、筛选、创建、编辑、派生、覆盖内置后的「恢复默认」、删除，团队编辑对话框；旧 `experts` 分节标识仍可深链到该详情）；新建会话时输入坞 ＋ 菜单的「专家 / 团队」二级面板；团队会话里输入坞上方的团队面板与成员只读弹窗。
- 会话内入口：`present_card` 的 `expert.draft`（新建与更新专家定义草案，支持更新内置专家的覆盖定义）与 `team.draft`（创建与更新自定义团队）；团队模式下由团长使用的 `team_board`、`team_assign`、`team_stop`。
- 进程入口：`desktop:session-experts`（清单与诊断）、`desktop:expert-*`（派生、读取、保存、删除、能力候选、默认基线）、`desktop:teams-list`／`team-read`／`team-save`／`team-delete`、`desktop:team-sessions-list`／`team-session-read`。

不负责的部分：成员会话的通用会话生命周期、会话打开与删除链归 [会话与聊天](sessions-chat.md)；技能装配与同名冲突归 [资源与 MCP](resources-mcp.md) 与 [会话与聊天](sessions-chat.md) 的技能覆盖一节；一次性的隔离委派归 [子代理](sub-agent.md)；技能可见集的登记与加载证据归 [门禁](skill-guard.md)。

## 关键实现与协作

### 本模块实现

| 文件 | 职责 |
| --- | --- |
| `src/shared-process/expert-definitions.ts` | 专家定义解析、内置与自定义两来源合并、覆盖判定与引用诊断；`EXPERT_ID` 标识校验；三类维度在默认基线上加减得到生效范围（字段契约在 `src/shared/expert-capability.ts`）；`writeScope` 三态解析 |
| `src/shared-process/expert-capability-defaults.ts` | 默认能力基线的读取与原子写：文件缺失或损坏按不限制回退，三个维度各自归一 |
| `src/shared-process/team-definitions.ts` | 团队定义的解析、双来源合并与结构化诊断；团长与成员引用失效只标诊断并让 `ready` 为假；保存侧的声明段生成与草稿校验共用同一套字段口径 |
| `src/shared/expert-capability.ts`、`src/shared/experts-api.ts` | 能力范围字段契约与专家通道（派生、读取、保存、删除、快速模式剔除清单、能力候选、默认基线保存）的请求／结果校验；写入范围上限的唯一定义处 |
| `src/shared/teams-api.ts`、`src/shared/team-session-api.ts`、`src/shared/team-board-api.ts`、`src/shared/team-run-api.ts` | 团队资源通道、成员会话只读通道、账本结构与派活记录的类型与校验 |
| `src/main/sessions/expert-catalog.ts` | 主进程侧专家清单：合并随包与自定义目录（同标识覆盖内置，视图带 `overridesBuiltin`），产出选择器视图、加载诊断、能力候选与默认基线 |
| `src/main/sessions/expert-files.ts` | 专家定义的写操作：派生副本（写 `derivedFrom`）、读取回填（自定义优先）、保存（编辑内置时在 `<agentDir>/experts/<同标识>/` 写覆盖定义）、删除自定义与覆盖；写入面只到 `<agentDir>/experts/` |
| `src/main/sessions/expert-ipc.ts` | 专家相关的七条通道，把清单、诊断与写操作接到页面 |
| `src/main/sessions/session-experts.ts`、`src/main/sessions/session-teams.ts` | 会话绑定解析：已有会话以持久绑定为准，请求值只对新会话生效；落盘在打开成功那一刻 |
| `src/main/sessions/team-catalog.ts`、`src/main/sessions/team-files.ts`、`src/main/sessions/team-ipc.ts` | 团队清单合并与可开团判定、自定义团队读写删、团队与成员会话通道；内置团队只读 |
| `src/main/sessions/team-sessions.ts` | 成员会话登记与只读读取；按「项目路径 + 根会话 + 成员登记标识」定位，不接受文件路径 |
| `src/sdk-host/expert-role.ts` | 把选中专家的正文按上限裁剪后装配成 `expert-role` 分段，段尾说明本次技能／MCP／工具与写入范围 |
| `src/sdk-host/expert-capability.ts` | 由专家定义与默认基线算出许可集，供技能过滤、MCP 停用与工具裁剪使用；同一口径产出 `present_card` 的能力候选段与专家候选段（标识、显示名、简介、内置／自定义／覆盖内置），候选不按许可集裁剪 |
| `src/sdk-host/expert-write-guard.ts` | 写入守卫：仅在专家声明写入范围时装配，拦 `write` 与 `edit` 的目标路径，按真实路径与目录边界判定 |
| `src/sdk-host/write-scope.ts` | 写入路径判定的共享实现：真实路径解析、目录前缀边界比较、绝对范围解析；子代理守卫与专家守卫共用 |
| `src/sdk-host/team-role.ts` | 团队段装配与团长收窄：注入团长身份、职责、成员名册与派活规则，给出团长要移出的四类工具 |
| `src/sdk-host/team-board.ts` | 任务账本工具与账本摘要段：账本存工具结果 `details` 随分支落盘，摘要进独立系统提示分段，`context` 钩子按工具结果计数节流回述 |
| `src/sdk-host/team-dispatch.ts` | 派活与停止：派活前置校验（条目、验收项、依赖、负责成员、打回次数），成员一轮的终态由宿主按执行快照追加到根会话并回报团长 |
| `src/sdk-host/team-runner.ts` | 成员轮的进程载体：`--session-dir` 指向成员会话目录、续派复用同一会话，只带专家角色段与写入守卫参数 |
| `src/renderer/src/experts/stores/expert.ts`、`src/renderer/src/experts/stores/team.ts` | 设置页的专家与团队清单、诊断、草稿与保存状态 |
| `src/renderer/src/experts/components/ExpertSettingsSection.vue` | 「专家与专家团」插件详情：类型筛选与计数只裁剪列表、专家与团队共用行模板、创建动作跟随筛选、诊断折叠、派生、覆盖内置的编辑与「恢复默认」、删除确认（删专家时列出引用它的团队）、页尾折叠的默认能力分组 |
| `src/renderer/src/experts/components/ExpertEditorDialog.vue`、`src/renderer/src/experts/components/TeamEditorDialog.vue` | 专家与团队的编辑对话框：身份、能力三段勾选（工具段受保护项锁定为「必需」）、写入范围三态单选、正文；团队侧为团长单选与成员多选、不进系统提示的协作约定正文 |
| `src/renderer/src/experts/components/ExpertCapabilityPicker.vue`、`src/renderer/src/experts/capability-selection.ts`、`src/renderer/src/experts/skill-source-label.ts` | 能力选择器与勾选换算的单一实现：基线展开、按定义还原勾选、勾选换算成 `skillIds`／`Add`／`Remove`、行尾状态文案；编辑对话框与会话内卡片共用 |
| `src/renderer/src/sessions/components/TeamPanel.vue`、`src/renderer/src/sessions/stores/team-panel.ts`、`src/renderer/src/sessions/components/TeamMemberDialog.vue` | 根会话输入坞上方的只读团队面板（账本、成员状态、写区重叠、成员数与累计用量）与成员只读弹窗；数据来自宿主投影与成员会话通道，面板本身不派活、不停止、不改账本 |

### 跨模块与公共能力

| 来源 | 使用入口 | 协作边界 |
| --- | --- | --- |
| [会话与聊天](sessions-chat.md) | 会话打开链、`session-runtime` 装配、`present-card-extension` | 专家与团队绑定随会话目标下发；卡片刷新走会话域通道 |
| [资源与 MCP](resources-mcp.md) | `bundle.json` 的 `experts`／`teams`／`tools` 段、`agent-resources` | 内置清单是候选集合与可裁剪集合的唯一来源；构建期核对工具声明 |
| [门禁](skill-guard.md) | 技能可见集与系统提示分段 | 角色段与团队段与门禁段并列注入，不改写彼此 |
| [子代理](sub-agent.md) | 写入守卫 `.mjs`、进程控制习惯 | 成员轮不复用委派通道，但共用守卫与超时收尾 |
| [工作区标签](workspace-tabs.md) | 并行会话与标签过滤 | 成员会话不进标签，不改标签模型 |
| [公共记录](shared.md) | `desktop-config-store`、`pi-paths`、`agent-resources` | 绑定与登记写配置中心；目录定位统一走 `pi-paths` |

## 关键链路

### 召唤专家并从下一次装配生效

1. 设置页或会话内卡片写定义：`expert-files.ts` 校验后写 `<agentDir>/experts/<id>/expert.md`（编辑内置时写同标识覆盖），随后重读清单。
2. 新建会话时页面从 `desktop:session-experts` 取清单，选中值随打开请求下发；`session-experts.ts` 对已有会话优先取持久绑定。
3. 宿主装配：`expert-capability.ts` 算许可集 → 技能在 `skillsOverride` 过滤、MCP 在 `loadConfig` 钩子标停用、工具在激活集合移除（受保护项与团队工具保留）→ 声明了写入范围时装载守卫 → `expert-role.ts` 写角色段。
4. 绑定在打开成功时落盘；定义被删后界面标「已失效」但不自动清除绑定，重建同标识即恢复。

### 开团、派活与验收

1. 新建会话选团队：团队就绪时团长覆盖请求里的专家，`team-role.ts` 注入团队段，四个工具在装配期移出，写入范围置为只读。
2. 团长用 `team_board` 提交账本（目标、事实、条目与依赖、验收项）；提交层剔除名单外的指派与悬空依赖，验收项未勾完的条目不能置 `done`。
3. 团长用 `team_assign` 派活：五项校验通过后由 `team-runner.ts` 起子进程跑完一轮；成员会话 id 由根会话与成员标识推出，续派复用同一上下文。
4. 一轮结束：宿主按执行快照把终态、结论摘要、产物引用与待决项写成根会话记录（`team-member-run.v1`）；账本条目状态仍只由团长提交，两份事实分属两个写入方。
5. 收敛：根会话中断、关闭、删除时终止在途轮次并清理成员目录；启动后低频核对孤儿成员目录。

## 状态与关键约束

| 状态／资源 | 权威维护位置 | 生命周期与约束 |
| --- | --- | --- |
| 内置专家与团队 | `resources/agent/experts/`、`resources/agent/teams/`，经 `bundle.json` 声明 | 随包只读、随版本升级；运行期不写不删 |
| 自定义专家定义 | `<agentDir>/experts/<id>/expert.md`，写入口只有 `expert-files.ts` | 目录名即标识、创建后不可改；同标识即覆盖内置；保存保留未识别字段，先写临时文件再改名 |
| 自定义团队定义 | `<agentDir>/teams/<id>/team.md`，写入口只有 `team-files.ts` | 标识由主进程分配 `team-<序号>`；团长与成员必须是当前可用的专家标识，团长不得出现在成员里 |
| 默认能力基线 | `<agentDir>/capability-defaults.json` | 全局一份，`null` 表示不限制；缺失或损坏按不限制回退；只在召唤专家时参与计算 |
| 会话专家绑定／团队绑定 | `desktop-config.json` 的 `sessionExperts`／`sessionTeams` | 打开成功时由主进程写入，页面不回写；首轮后锁定，改定义不影响既有会话 |
| 成员会话登记 | `desktop-config.json` 的 `teamSessions` | 开团时按团队成员物化，只存标识；会话文件是否存在由读取时的磁盘状态决定 |
| 成员会话文件 | `<agentDir>/team-sessions/<根会话 id>/` | 不在项目会话目录，因此不进项目列表、不占标签；不按时间过期，只按根会话是否还在做孤儿清理，删除移系统废纸篓 |
| 任务账本 | `team_board` 工具结果的 `details`，随会话分支落盘 | rewind 或 fork 后自然回到当时那份；条目状态唯一写入方是团长，成员终态由宿主另写 |

- 一次会话只用一个专家；团队模式下专家即团长，身份徽标只渲染一个。
- 团队语义优先于专家工具范围：团长固定移出 `write`、`edit`、`bash`、`delegate_subagent`，写入范围置只读；团队工具不受专家工具范围裁剪。
- 工具范围只裁剪随包清单登记过的工具；门禁、待办清单、记忆组、语气风格组始终保留，内建控制工具与 MCP 管理工具既表达不了也勾不到。
- 写入范围与工具范围正交：守卫只拦 `write`／`edit` 的 `path`，`bash` 重定向不受约束。
- 定义读取失败或标识冲突只影响对应条目，不让整份清单消失；引用失效的专家仍留在列表里并标出来。

## 结构覆盖边界

- 成员会话的会话文件由宿主子进程写入，主进程只按登记读取头部与预览；面板展示的是宿主投影与只读通道的合并结果，不覆盖成员尚未落盘的状态。
- 专家与团队的清单视图在装配期一次性读取，运行中改定义要新建会话才生效；本模块不提供运行期热更新。
- 内置清单缺项、内容指纹不一致时按失败响应上抛，不静默给出空清单。
