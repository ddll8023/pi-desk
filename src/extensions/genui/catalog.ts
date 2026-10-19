/**
 * 生成式 UI 的按需字段目录：模型在不确定节点形状时按主题取一段说明，而不是把全部字段
 * 常驻在工具描述里。
 *
 * 只返回静态文本，不读写文档、不接触会话；内容与 `src/shared/genui-api.ts` 的解析规则
 * 一一对应，字段上限以该模块的常量为准，这里不重复声明数值。
 */
import {
  GENUI_MAX_CHART_LABEL_CHARS,
  GENUI_MAX_CHART_POINTS,
  GENUI_MAX_CHART_TITLE_CHARS,
  GENUI_MAX_CELL_CHARS,
  GENUI_MAX_COLUMNS,
  GENUI_MAX_DIAGRAM_LABEL_CHARS,
  GENUI_MAX_DIAGRAM_NOTE_CHARS,
  GENUI_MAX_EXPLODED_PARTS,
  GENUI_MAX_GEARS,
  GENUI_MAX_GEAR_TEETH,
  GENUI_MAX_LIST_ITEMS,
  GENUI_MAX_NODES,
  GENUI_MAX_PARAM_OPTIONS,
  GENUI_MAX_PARAMS,
  GENUI_MAX_PARAM_LABEL_CHARS,
  GENUI_MAX_PARAM_OPTION_CHARS,
  GENUI_MAX_PARAM_PLACEHOLDER_CHARS,
  GENUI_MAX_PARAM_TEXT_CHARS,
  GENUI_MAX_STEPS,
  GENUI_MAX_SUBMIT_LABEL_CHARS,
  GENUI_MAX_TABLE_COLUMNS,
  GENUI_MAX_TABLE_ROWS,
  GENUI_MAX_TEXT_CHARS,
  GENUI_MIN_CHART_POINTS,
  GENUI_MIN_EXPLODED_PARTS,
  GENUI_MIN_GEARS,
  GENUI_MIN_GEAR_TEETH,
  GENUI_MIN_PARAM_OPTIONS,
  GENUI_PARAM_ID_PATTERN_SOURCE,
  GENUI_SUBMIT_PREFIX,
  GENUI_VERSION
} from '../../shared/genui-api'

/** 目录主题；未知主题由调用方拒绝并列出可选项。 */
export type GenuiCatalogTopic = 'overview' | 'nodes' | 'params' | 'diagram' | 'chart' | 'update' | 'examples'

const OVERVIEW = `生成式 UI 用一份声明式文档描述界面，由桌面端渲染成原生组件。
文档形状：{version:${GENUI_VERSION}, title, fallback, params?, submitLabel?, nodes:[...]}。
- title：界面标题，不超过 200 字符。
- fallback：界面无法渲染时的替代文本，必填。它同时是纯文本客户端与导出场景唯一可见的内容，
  必须能独立读懂，不能写"见上图"之类依赖视觉的措辞。
- nodes：至少一个节点，总数不超过 ${GENUI_MAX_NODES}（含嵌套），容器最多嵌套 4 层。
- params / submitLabel：可选，声明界面内可调参数与提交按钮文案，字段见 ui_catalog({topic:"params"})。
- diagram：可选节点，把装配关系、传动比与运动规律画成图解，字段见 ui_catalog({topic:"diagram"})。
- chart：可选节点，把单序列数据画成柱状图或折线图，字段见 ui_catalog({topic:"chart"})。
只有两个渲染入口：ui_render 交付整份文档，ui_patch 按 documentId 只发改动部分。同一次回答可以多次调用，生成不同主题的独立界面。
先判断是否真的需要界面：纯叙述、简短结论与路径清单用正文，不用 card 把整篇回答重新包装。
方案对比用 row 并排，指标用 metric，真实先后顺序用 steps；有参数时才提供 controls。
card 只表达主题分组，不用多层嵌套来制造层级；解释和结论写在相关数据旁边。
参数变化不会请求模型；只有用户点提交时，才会发一条以 ${GENUI_SUBMIT_PREFIX} 开头的用户消息回填当前取值。
要修改已交付的界面，见 ui_catalog({topic:"update"})。`

const NODES = `节点类型（未知 type 会被整份拒绝，不做降级猜测）：
text    {type:"text", text, tone?, size?}                 tone: default|muted|accent|success|warning|danger；size: small|body|large
list    {type:"list", items:[string], ordered?}          条目 1..${GENUI_MAX_LIST_ITEMS}
metric  {type:"metric", label, value, unit?, tone?}      value 只接受字符串或有限数字
table   {type:"table", columns:[{key,label}], rows:[{...}], caption?}
        columns 1..${GENUI_MAX_TABLE_COLUMNS} 且 key 不重复；rows 最多 ${GENUI_MAX_TABLE_ROWS} 行；
        单元格只接受字符串（不超过 ${GENUI_MAX_CELL_CHARS} 字符）或有限数字，未声明的列会被忽略。
steps   {type:"steps", items:[{title, description?}]}    1..${GENUI_MAX_STEPS} 条；步骤不带状态字段，
        静态说明不伪装成任务进度。
card    {type:"card", title?, children:[...]}            子节点至少一个
row     {type:"row", columns?, children:[...]}           columns 1..${GENUI_MAX_COLUMNS}，作为期望列数上限；窄容器自动减列，省略时自适应；子节点至少一个
controls {type:"controls", params?:[string]}             参数控件组，params 省略时渲染全部已声明参数；
        只能引用文档 params 里已声明的 id，且每个声明的参数都必须被某个 controls 引用
diagram {type:"diagram", kind, ...}                       机制图解，三种 kind 字段见 ui_catalog({topic:"diagram"})
chart   {type:"chart", kind, points:[{label,value}], ...}   柱状图与折线图，字段见 ui_catalog({topic:"chart"})

布局与阅读：
- 方案对比用 row 包含并列 card，指标并列用 row 包含 metric；不要把可比较项全排成纵向长文。
- card 的标题就是分区标题，内部直接放数据或说明；不要再套一张只装相同内容的 card。
- table 只放同类记录，列内内容尽量简短。长解释用 text，不把整段报告压进表格。
- 长表默认显示前 6 行并提供展开全部；仍须传入完整 rows，不要把显示折叠误当成数据截断。
- 重要结论、警告和限制单独放 text，使用正确 tone；不要把唯一的重要提示放在长表尾部。

通用约束：
- 单段文本不超过 ${GENUI_MAX_TEXT_CHARS} 字符；空字符串按缺失处理，会导致整份文档被拒绝。
- 数值必须是有限数字，不要传字符串化的数字（metric.value 除外，它允许字符串）。
- tone 只表达语义：success 表示已确认的成功，warning 表示假设或提醒，danger 表示已确认的危险；
  不要仅凭数值大小自动推断成功或危险。
- 不需要为界面写 HTML、CSS 或脚本；这些字段不存在。`

const PARAMS = `参数只在用户点提交时才回填，参数变化不会请求模型。声明了 params 就必须用 controls 节点
把它们渲染出来，否则整份文档被拒绝——不允许界面上看不见、提交却带出去的参数。

参数个数 1..${GENUI_MAX_PARAMS}，id 唯一，形如 /${GENUI_PARAM_ID_PATTERN_SOURCE}/；label 不超过 ${GENUI_MAX_PARAM_LABEL_CHARS} 字符，
description 可选。四类参数：
number  {type:"number", id, label, description?, min, max, step?, default, unit?}
        min < max，default 必须落在 [min, max]；step 省略时由渲染端决定，写了必须大于 0。
select  {type:"select", id, label, description?, options:[{value,label}], default}
        选项 ${GENUI_MIN_PARAM_OPTIONS}..${GENUI_MAX_PARAM_OPTIONS} 个，value 不重复，default 必须是某个选项的 value。
        value 与 label 都限 ${GENUI_MAX_PARAM_OPTION_CHARS} 字符；value 是提交时回填的原始值，label 是界面文案。
toggle  {type:"toggle", id, label, description?, default}      default 必须是布尔值
text    {type:"text", id, label, description?, default?, placeholder?}
        单行自由输入（项目名、备注），上限 ${GENUI_MAX_PARAM_TEXT_CHARS} 字符，placeholder 限 ${GENUI_MAX_PARAM_PLACEHOLDER_CHARS} 字符。
        default 省略即空串，交给用户填；用户留空时提交内容会写成「（未填写）」，不会自动拦下提交。

submitLabel 可选，不超过 ${GENUI_MAX_SUBMIT_LABEL_CHARS} 字符，用于提交按钮；省略时按钮叫「提交参数」。

用户提交后你会收到一条形如以下内容的用户消息：
${GENUI_SUBMIT_PREFIX}：《界面标题》 documentId=… revision=…
- 缓存容量（capacity）：256 MB
按 documentId 认定是同一份界面的回填，直接基于这些取值继续，不要重画同一界面。`

const DIAGRAM = `机制图解用几何公式把关系画出来，适合装配顺序、传动比、运动规律；不适合画任意示意图。
三种 kind 共用的字段：caption?（1..400 字符）与 binds?（绑定，见下）。

exploded  装配拆解：纵向展开零件
  {type:"diagram", kind:"exploded", parts:[{label, note?}], caption?, binds?:{spread?}}
  parts ${GENUI_MIN_EXPLODED_PARTS}..${GENUI_MAX_EXPLODED_PARTS} 个；label 不超过 ${GENUI_MAX_DIAGRAM_LABEL_CHARS} 字符，note 不超过 ${GENUI_MAX_DIAGRAM_NOTE_CHARS} 字符。
  spread 取 0..1，控制拆解间距：0 最紧、1 最松。

gear  齿轮传动：节圆半径正比于齿数，相邻齿轮相切
  {type:"diagram", kind:"gear", gears:[{label, teeth}], caption?, binds?:{angle?}}
  gears ${GENUI_MIN_GEARS}..${GENUI_MAX_GEARS} 个；teeth 是 ${GENUI_MIN_GEAR_TEETH}..${GENUI_MAX_GEAR_TEETH} 的整数。
  转速比由齿数推出（上一级齿数/本级齿数），转向交替；angle 是主动轮的驱动角，单位度。

crank  曲柄连杆：活塞位移 x = r·cosθ + √(l² − r²sin²θ)
  {type:"diagram", kind:"crank", crank, rod, unit?, caption?, binds?:{angle?}}
  crank 与 rod 都是大于 0 的有限数字，且必须 rod > crank，否则曲柄转不过一周、整份被拒。
  unit 是长度单位（如 mm）；angle 是曲柄角，单位度，默认 0。

绑定 binds 不是表达式：只有 spread（exploded）与 angle（gear/crank）两个键，值必须是
文档 params 里已声明的 number 参数 id。绑到 select、toggle 或 text 会被拒。
注意：绑定不会让参数免于被控件组引用——要让用户能调，仍然必须有 controls 节点引用它。

图示是叶子节点，内部不再嵌套其他节点；几何与推导结论由桌面端算出并以文本同时给出。`

const CHART = `图表只画单序列：分类轴 + 数值。多序列对比用 table，不要硬塞进图表。
两种 kind 字段相同，只差渲染方式：
bar   柱状图：从零线起算，正负方向相反，适合数值对比。
line  折线图：适合趋势与变化。

形状：{type:"chart", kind:"bar"|"line", points:[{label,value}], title?, caption?, unit?}
- points ${GENUI_MIN_CHART_POINTS}..${GENUI_MAX_CHART_POINTS} 个；label 不超过 ${GENUI_MAX_CHART_LABEL_CHARS} 字符，超过 4 个字符时轴标签会截断（完整值仍在无障碍说明里）。
- value 必须是有限数字，允许负数；不要传字符串化的数字。
- title 不超过 ${GENUI_MAX_CHART_TITLE_CHARS} 字符；caption 不超过 400 字符；unit 是数值单位（如 ms、MB）。
- 坐标轴范围与刻度由桌面端按数据自动取整，不要自己补零值或占位数据点。

图表不绑定参数、不做交互；需要随参数变化的图形用 diagram。
图表与 fallback 的分工：fallback 里要写清结论（最大值、趋势），不能只写“见下图”。`

const UPDATE = `修改已交付的界面分两步：
1. ui_inspect 查看现有界面。不带参数列出当前会话分支上的全部界面（documentId、标题、当前版本）；
   带 documentId 返回结构大纲（节点路径、类型、短预览与参数声明）。
2. 选一个入口交付新版本：
   - ui_patch：只发改动部分，适合改文案、换数据、增删一两个节点。
   - ui_render：重发整份文档，适合结构大改（重排大部分节点）或改动超过文档一半。

ui_patch 的形状：
{documentId, ops?:[{op, path?, index?, node?}], title?, fallback?, submitLabel?, params?}
- path 就是 ui_inspect 大纲里的节点位置："0"、"0.1"；省略或 "" 表示文档顶层的 nodes。
- op=replace：用 node 整节点替换 path 指向的节点。
- op=insert：把 node 插到 path 指向的容器（card / row 的子节点，或顶层 nodes）的 index 处；
  index 省略则追加到末尾。
- op=remove：删掉 path 指向的节点（不能删到剩零个节点）。
- title / fallback / submitLabel 省略即不变；params 给数组则整体替换，给 null 则清空全部参数。
- 粒度是节点：改表格里的一行也要 replace 整个 table 节点；没有行级、项级补丁。
- 合并后仍过整份校验：改 params 时要同步改 controls，删参数时一起删掉引用它的 controls。

版本语义：
- ui_render 不带 documentId 是新建，revision 从 0 开始；带 documentId 且该界面在当前分支上时，revision 自动加一。
- ui_patch 必须带 documentId，且总是应用到当前分支上的最新版；documentId 不在当前分支上会直接报错。
- 旧版本会折叠成一行只读记录，不能调参也不能提交；只有最新版可交互。回退（rewind）到修改之前时，
  那个版本会重新成为最新版并恢复可交互。
- 每个版本都存完整文档（不是补丁链），所以任何一版都能单独渲染。

什么时候应该改、什么时候应该新开：
- 同一份内容需要迭代（换数据、改文案、加节点）时带 documentId 修改，保持用户在流里的位置不变。
- 不同主题、不同用途的界面用新 documentId，不要合并进同一份。

用户回填参数后怎么续：以 ${GENUI_SUBMIT_PREFIX} 开头的用户消息里的 documentId 就是该界面，
直接基于那些取值给结论；需要把新取值画进界面时，用 ui_patch 改相关节点或参数默认值。`

const EXAMPLES = `示例一：方案对比（两个配置并排，不把说明重复写成表格）
{"version":${GENUI_VERSION},"title":"日志保留策略","fallback":"短期方案保留 7 天，占用较小；长期方案保留 30 天，排查跨度更长。这是配置示例，不是实测结果。","nodes":[
  {"type":"row","columns":2,"children":[
    {"type":"card","title":"短期排查","children":[
      {"type":"metric","label":"保留时间","value":7,"unit":"天"},
      {"type":"text","text":"适合临时排错，到期自动清理。"}
    ]},
    {"type":"card","title":"长期追溯","children":[
      {"type":"metric","label":"保留时间","value":30,"unit":"天"},
      {"type":"text","text":"适合跨周追查，需要预留更多存储空间。"}
    ]}
  ]},
  {"type":"text","tone":"muted","size":"small","text":"以上为配置示例；实际占用取决于每日日志量。"}
]}

示例二：有先后依赖的步骤（不冒充正在运行的任务状态）
{"version":${GENUI_VERSION},"title":"从现象定位到修复范围","fallback":"先定位调用入口，再追踪状态归属，最后列出具体文件和修改范围。","nodes":[
  {"type":"steps","items":[
    {"title":"定位入口","description":"找到触发问题的组件及其直接调用方。"},
    {"title":"追踪状态归属","description":"确认数据由谁持有、异步结果写回到哪里。"},
    {"title":"列出修改范围","description":"明确具体文件和改动内容，再提交审核。"}
  ]}
]}

示例三：带可调参数（用户提交后会收到 ${GENUI_SUBMIT_PREFIX} 开头的用户消息）
{"version":${GENUI_VERSION},"title":"缓存参数","fallback":"可调缓存容量、淘汰策略、压缩开关与备注，提交后按这些取值继续。",
 "params":[
  {"id":"capacity","type":"number","label":"缓存容量","min":64,"max":2048,"step":64,"default":256,"unit":"MB"},
  {"id":"strategy","type":"select","label":"淘汰策略","default":"lru","options":[
    {"value":"lru","label":"LRU"},{"value":"lfu","label":"LFU"},{"value":"ttl","label":"过期时间"}]},
  {"id":"compression","type":"toggle","label":"启用压缩","default":true},
  {"id":"note","type":"text","label":"备注","placeholder":"可选，例如本次只针对图片缓存"}
 ],
 "submitLabel":"按这组参数继续",
 "nodes":[{"type":"controls"}]}

示例四：图解与参数并排（宽度不足时自动上下排列，两边读取同一份参数）
{"version":${GENUI_VERSION},"title":"两级减速","fallback":"两级齿轮减速：齿数 12→36→18，第一级减速 3 倍，第二级加速 2 倍。",
 "params":[{"id":"angle","type":"number","label":"驱动角","min":0,"max":360,"step":5,"default":30,"unit":"°"}],
 "nodes":[
  {"type":"row","columns":2,"children":[
    {"type":"diagram","kind":"gear","binds":{"angle":"angle"},"caption":"齿数 12 / 36 / 18",
     "gears":[{"label":"主动轮","teeth":12},{"label":"中间轮","teeth":36},{"label":"输出轮","teeth":18}]},
    {"type":"controls"}
  ]}
 ]}

示例五：柱状图（分类对比）
{"version":${GENUI_VERSION},"title":"各方案构建耗时","fallback":"四个方案的构建耗时：冷构建 92 秒最长，增量构建 11 秒最短。","nodes":[
  {"type":"chart","kind":"bar","unit":"s","caption":"示例数据，不代表本机实测",
   "points":[
    {"label":"冷构建","value":92},
    {"label":"增量","value":11},
    {"label":"并行","value":34},
    {"label":"缓存","value":27}
   ]}
 ]}`

const TOPICS: Readonly<Record<GenuiCatalogTopic, string>> = {
  overview: OVERVIEW,
  nodes: NODES,
  params: PARAMS,
  diagram: DIAGRAM,
  chart: CHART,
  update: UPDATE,
  examples: EXAMPLES
}

/** 目录可用的主题名；用于错误提示，避免模型反复试探。 */
export const GENUI_CATALOG_TOPICS: readonly GenuiCatalogTopic[] = [
  'overview', 'nodes', 'params', 'diagram', 'chart', 'update', 'examples'
]

/** 取一个主题的说明；调用方保证 topic 已通过类型校验。 */
export function genuiCatalog(topic: GenuiCatalogTopic): string {
  return TOPICS[topic]
}
