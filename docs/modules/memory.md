# 记忆

模块 ID：`memory`。返回 [总览](../项目结构文档.md)。

## 职责与入口

负责用户级全局记忆的开关、随包受管运行环境状态、记忆库状态探测与首次创建，以及把这些状态推送给已就绪的 SDK 宿主。入口为设置页“记忆”分节。

记忆库是当前系统用户的 `~/.agents/memory-store/memory.db`（SQLite，WAL），所有项目共用同一库，不按目录或项目身份过滤，不写入项目目录；开关默认开启，用户可在设置页关闭。引擎由随包 CPython 与 IANA 时区数据执行，不使用系统 Python、不依赖项目虚拟环境；运行资源或配套引擎缺失时明确报告，不回退其他解释器。

不自动创建或迁移记忆库、不重建词项、不强杀已启动的提交。旧 Markdown 库只经显式 `migrate` 一次性导入，旧目录改名为 `<原目录>-archive-<时间戳>` 保留可读；导出快照只供人阅读，不参与写回。开关保存成功后才生效；宿主未确认采纳时只报“未确认生效”，不把已保存的真相改写为失败。

## 专属文件

### 主进程、桥接与契约

| 文件 | 用途 |
| --- | --- |
| `src/main/memory/memory-manager.ts` | 开关、配置版本、运行环境与库状态探测、经用户确认的首次创建、向宿主推送配置 |
| `src/main/memory/ipc.ts` | 状态、开关与创建三个固定通道的调用者与参数校验 |
| `src/shared/memory-api.ts` | 通道名、快照与结果契约及入参校验 |
| `src/shared-process/memory-runtime.ts` | 受管运行环境布局与清单校验、全局库位置、宿主配置的受限校验与序列化 |
| `src/preload/memory.ts` | 固定通道调用与结果契约校验 |
| `src/renderer/src/memory/services/memory.ts` | 页面桥接定位与响应校验 |
| `src/renderer/src/memory/components/MemorySettingsSection.vue` | 开关、运行环境、库状态与创建表单 |

### 宿主与产品资源

| 文件 | 用途 |
| --- | --- |
| `src/sdk-host/memory-configuration.ts` | 宿主内配置持有者：写进程环境并向已加载扩展推送变更 |
| `src/sdk-host/product-resources.ts` | 产品资源装配、从共享目录只读加载用户级 `AGENTS.md` 与 skills、扩展加载结果分级与必要组件核验，并核对配置是否已注入 |
| `resources/agent/extensions/pi-memory/` | 记忆扩展：请求级背景、工具注册、会话控制与写入闸门 |
| `resources/agent/skills/memory/` | 配套规范、引用与 SQLite 存储引擎 `scripts/memory_store.py`（库文件固定为 `<store>/memory.db`） |
| `resources/agent/bundle.json` | 上述扩展、Skill 与引擎入口及组成文件声明 |
| `resources/memory-runtime/manifest.json` | 受管 Python 与时区归档的固定地址、SHA-256 与目标布局 |
| `scripts/prepare-memory-runtime.mjs`、`scripts/stage-memory-runtime.mjs` | 显式准备归档、校验后解压缓存；把当前平台的一份暂存到宿主产物旁 |

扩展与引擎的具体行为见 `resources/agent/extensions/pi-memory/README.md` 与 `resources/agent/skills/memory/SKILL.md`；本文只记录请求背景的注入通道、范围与边界，不复述工具参数与检索实现。

## 公共与跨模块引用

- [F-assembly](shared.md#f-assembly进程与页面组装混合)：`src/main/app-lifecycle.ts` 注册记忆通道；`src/main/services.ts` 建立唯一的记忆管理器并注入宿主创建参数。
- [F-config](shared.md#f-configdesktop-配置混合)：开关经 `MemoryManager` 写入 `desktop-config.json`，只读降级时不假称已保存。
- [F-process](shared.md#f-process受管进程与-sdk-公共设施共享)：`memory-runtime.ts` 的布局与清单校验；`pi-paths.ts` 的 agentDir 与宿主产物定位。
- [F-build](shared.md#f-build构建与发行上下文)：`sdk-host:build` 依次暂存产品资源与受管运行环境，随 `out/**` 进包；macOS 签名排除其中的时区数据。
- [会话](sessions-chat.md)：宿主初始化与配置推送走 `src/main/sessions/sdk-host-manager.ts` 的协议请求；会话创建时装配产品资源。会话内 `/memory off|on` 只控制当前分支，不能绕过桌面全局关闭。
- [资源与 MCP](resources-mcp.md)、[偏好](preferences.md)：技能与扩展命令的展示沿用资源模块；本模块只拥有记忆开关与库生命周期，不接管偏好存储与资源预读。

## 请求背景的注入通道

每轮请求的背景由扩展在宿主侧装配：`context` 钩子调用 `MemoryRuntime.background`，把结果作为 `display: false` 的 request-only 自定义消息置于消息列表首位再交给模型。因此背景不经过模型调用工具、不在界面渲染、也不写入会话记录；能观察到的只有 `/memory status` 的 `automatic_recall` 字段。

| 内容 | 时间范围 | 选取规则 | 上限 |
| --- | --- | --- | --- |
| 适用画像 | 不限 | 仅 `scope=global` 或已选领域的当前画像 | 正文超过 20000 字符时不截断，改为提示按领域读取 |
| 常驻约定 | 近七天滚动窗口 | 只收 `decision` 与 `constraint`，按 `rule_key` 首段聚族，每族每个项目归属只取最新一条；只注入当前项目与通用（无项目归属的跨项目约定）两类族，其他项目的族不进入常驻 | 约定预算 17000 字符，用尽后候选族降为索引行 |
| 当前项目近况 | 近七天滚动窗口 | 只收当前项目归属的 `progress`／`issue`／`fact`／`preference_evidence`，按日期倒序取有限条，不做族收敛与词法筛选，逐条标注类型 | 最多 3 条、共 3000 字符，单条正文 1200 字符 |
| 任务召回 | 不限；提示词含「近期／最近」或明确日期时才收窄 | 词法相关度乘类型权重，任何类型都可能命中 | 最多 6 条、背景 4000 字符，按请求键缓存并跳过已读 |
| 报错召回 | 不限 | 上一条工具报错按输出指纹匹配 | 最多 3 条 |

需要模型自己调用工具的情形有六种：记录在七天外且未被词法召回命中；记录在窗口内但类型不是决定或约束，且不在这三条近况之内；同族中不是最新的一条；该族因预算被降为索引行；记录属于其他项目（不进入常驻，背景末尾只报族数）；近况超出 3 条或 3000 字符的部分。七天外的记录只要词法命中同样会被注入，时间不是「用不用工具」的分界。未识别当前项目时（未登记目录、独立 CLI）不做归属过滤，也不生成近况段，正文仍按日期倒序、同日约束在前。

装配失败或超时都不扩大查询，也不把读取故障当成无命中：常驻失败不缓存正文，下一次请求重试一次，仍失败才停止；近况与常驻分缓存，失败同样最多重试一次且不影响约定段；画像失败不重试；两者都返回空或明确说明，召回返回「不可用（不是无命中）」。背景只是数据，不授予执行命令、外传信息或变更权限，也不改变当前用户要求与已核实事实的优先级。

## 数据流与边界

1. 设置页读状态：主进程只读探测运行环境与库形态，返回开关、运行环境版本、库路径、库状态与时区。
2. 用户切换开关：主进程保存配置后递增配置版本，再把新配置推给所有已就绪宿主；未就绪宿主在下次初始化时读到最新值。
3. 首次创建：仅当库根既不存在或缺少 `memory.db` 时可用；先展示目标位置与时区并取得真实用户确认，再由受管解释器执行 `init`，创建后重新探测，失败不留下半成品结论。
4. 会话使用：宿主在建立会话前把配置写入进程环境，扩展据此决定可用性；配置版本变化使旧会话状态与缓存整体作废。
5. 库内容本身（记录、画像、月摘要、词项、访问统计、待确认计划）由扩展与存储引擎维护，本模块不读写正文，也不把库状态当作内容质量结论。
6. 没有「应查未查」检测：模型是否调用记忆工具不受约束，也不因此阻断任何写操作。只读的记忆工具（`memory_status`、`memory_search`、`memory_rules`、`memory_read`、`memory_access_stats`、`memory_profiles`）已加入门禁放行集合，写工具经写入闸门后直接提交。
7. 配置读取失败与用户主动关闭在会话内不可区分：两者都表现为 `disabled_by: "user"`，`/memory status` 不单独报告读取故障。
8. 记录的项目归属由宿主按项目注册表解析后随保存写入，写入的是记录级字段而非新的段标记；项目 id 由项目名派生（见 [项目归属设计](../pi-memory-项目归属设计.md#11-项目身份的派生规则)），同一名称在任意机器与任意 userData 下一致，旧随机 ID 由首次启动自动迁移，但启动只遍历当前注册表里的旧 ID；不在本机注册表内的旧归属由 `scripts/align-project-identity.mjs` 按「旧 ID → 项目名」映射改判。无项目归属即通用记忆，承载跨项目的方法与写法约定，未登记项目与独立 CLI 同样留空，读取与召回仍覆盖全库。
