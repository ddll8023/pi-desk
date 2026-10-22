/**
 * 生成式 UI 的按需字段目录：模型在不确定节点形状时按主题取一段说明，而不是把全部字段
 * 常驻在工具描述里。
 *
 * 只返回静态文本，不读写文档、不接触会话；内容与 `src/shared/genui-api.ts` 的解析规则
 * 一一对应，字段上限以该模块的常量为准，这里不重复声明数值。
 */
import {
  GENUI_CHART_KINDS,
  GENUI_DIAGRAM_KINDS,
  GENUI_MAX_CHART_LABEL_CHARS,
  GENUI_MAX_CHART_POINTS,
  GENUI_MAX_CHART_SERIES,
  GENUI_MAX_CHART_SERIES_NAME_CHARS,
  GENUI_MAX_CHART_TITLE_CHARS,
  GENUI_MAX_PIE_SLICES,
  GENUI_MAX_CELL_CHARS,
  GENUI_MAX_COLLAPSE_ITEMS,
  GENUI_MAX_COLUMNS,
  GENUI_MAX_DEPTH,
  GENUI_MAX_DIAGRAM_LABEL_CHARS,
  GENUI_MAX_DIAGRAM_NOTE_CHARS,
  GENUI_MAX_EXPLODED_PARTS,
  GENUI_MAX_VECTORS,
  GENUI_MAX_CIRCUIT_PARTS,
  GENUI_MAX_SECTION_LAYERS,
  GENUI_MAX_GEARS,
  GENUI_MAX_GEAR_TEETH,
  GENUI_MAX_LIST_ITEMS,
  GENUI_MAX_NODES,
  GENUI_MAX_PARAM_OPTIONS,
  GENUI_MAX_PARAMS,
  GENUI_MAX_PARAM_LABEL_CHARS,
  GENUI_MAX_PARAM_GROUP_CHARS,
  GENUI_MAX_PARAM_OPTION_CHARS,
  GENUI_MAX_PARAM_PLACEHOLDER_CHARS,
  GENUI_MAX_PARAM_TEXT_CHARS,
  GENUI_MAX_STEPS,
  GENUI_MAX_TABS,
  GENUI_MAX_TAB_LABEL_CHARS,
  GENUI_MAX_TIMELINE_ITEMS,
  GENUI_MAX_TIMELINE_TIME_CHARS,
  GENUI_MAX_SUBMIT_LABEL_CHARS,
  GENUI_MAX_TABLE_COLUMNS,
  GENUI_MAX_TABLE_ROWS,
  GENUI_MAX_TEXT_CHARS,
  GENUI_MIN_CHART_POINTS,
  GENUI_MIN_COLLAPSE_ITEMS,
  GENUI_MIN_EXPLODED_PARTS,
  GENUI_MIN_VECTORS,
  GENUI_MIN_CIRCUIT_PARTS,
  GENUI_MIN_SECTION_LAYERS,
  GENUI_MIN_GEARS,
  GENUI_MIN_GEAR_TEETH,
  GENUI_MIN_PARAM_OPTIONS,
  GENUI_MIN_TABS,
  GENUI_PARAM_ID_PATTERN_SOURCE,
  GENUI_SUBMIT_PREFIX,
  GENUI_VERSION
} from '../../shared/genui-api'
import type { GenuiChartKind, GenuiDiagramKind } from '../../shared/genui-api'

/** 目录主题；未知主题由调用方拒绝并列出可选项。 */
export type GenuiCatalogTopic = 'overview' | 'nodes' | 'params' | 'diagram' | 'chart' | 'update' | 'examples'

/** 图解用途的一句话概括；`OVERVIEW` 与 `DIAGRAM` 的引导段共用，避免两处措辞分叉。 */
const DIAGRAM_PURPOSE = '把装配关系、传动比、运动规律、受力、串联回路与层状剖面画成图解'

/** 图表用途的一句话概括；`OVERVIEW` / `NODES` 与 `CHART` 的引导段共用。 */
const CHART_PURPOSE = '把分类数据画成柱状图、折线图、饼图或环形图'

const OVERVIEW = `生成式 UI 用一份声明式文档描述界面，由桌面端渲染成原生组件。
文档形状：{version:${GENUI_VERSION}, title, fallback, params?, submitLabel?, nodes:[...]}。
- title：界面标题，不超过 200 字符。
- fallback：界面无法渲染时的替代文本，必填。它同时是纯文本客户端与导出场景唯一可见的内容，
  必须能独立读懂，不能写"见上图"之类依赖视觉的措辞。
- nodes：至少一个节点，总数不超过 ${GENUI_MAX_NODES}（含嵌套），容器最多嵌套 ${GENUI_MAX_DEPTH} 层。
- params / submitLabel：可选，声明界面内可调参数与提交按钮文案，字段见 ui_catalog({topic:"params"})。
- diagram：可选节点，${DIAGRAM_PURPOSE}，字段见 ui_catalog({topic:"diagram"})。
- chart：可选节点，${CHART_PURPOSE}，字段见 ui_catalog({topic:"chart"})。
只有两个渲染入口：ui_render 交付整份文档，ui_patch 按 documentId 只发改动部分。同一次回答可以多次调用，生成不同主题的独立界面。
先判断是否真的需要界面：纯叙述、简短结论与路径清单用正文，不用 card 把整篇回答重新包装。
方案对比用 row 并排，指标用 metric，真实先后顺序用 steps，带具体时间点的过程用 timeline；有参数时才提供 controls。
参数多时用 group 分块、用 visibleWhen 做条件显示；界面底部自带重置按钮，无需声明。
次要内容收纳用 collapse（可同时展开），并列互斥的内容用 tabs（一次看一页）；两者的开合与选中页是视图状态，不写进文档。
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
        排序与筛选由桌面端自动提供，不需要在文档里声明 sortable、filter 之类的字段。
steps   {type:"steps", items:[{title, description?}]}    1..${GENUI_MAX_STEPS} 条；步骤不带状态字段，
        静态说明不伪装成任务进度。只表达先后，不表达时刻。
timeline {type:"timeline", items:[{time, title, description?}]}   1..${GENUI_MAX_TIMELINE_ITEMS} 个时间点；
        time 是自由文本（1..${GENUI_MAX_TIMELINE_TIME_CHARS} 字符，如 "09:12"、"第 3 天"、"2026-03-04 09:12"），
        桌面端不解析、不排序，按数组顺序原样渲染，因此要自己按时间先后传入；同样不带状态字段，
        不要把时间点写成“进行中/已完成”的任务进度。
card    {type:"card", title?, children:[...]}            子节点至少一个
row     {type:"row", columns?, children:[...]}           columns 1..${GENUI_MAX_COLUMNS}，作为期望列数上限；窄容器自动减列，省略时自适应；子节点至少一个
collapse {type:"collapse", items:[{title, open?, children:[...]}]}
        ${GENUI_MIN_COLLAPSE_ITEMS}..${GENUI_MAX_COLLAPSE_ITEMS} 组，默认全部收起，open:true 才默认展开；title 不超过 200 字符
        （手风琴：同一主题下的次要细节，可同时展开多组）
tabs    {type:"tabs", items:[{label, children:[...]}]}
        ${GENUI_MIN_TABS}..${GENUI_MAX_TABS} 页，默认选中第一页；label 不超过 ${GENUI_MAX_TAB_LABEL_CHARS} 字符且不重复
        （并列互斥的内容，一次只看一页）
controls {type:"controls", params?:[string]}             参数控件组，params 省略时渲染全部已声明参数；
        只能引用文档 params 里已声明的 id，且每个声明的参数都必须被某个 controls 引用；
        不能放在 collapse 或 tabs 里——收起或切页会把参数藏起来，提交却仍会带上
diagram {type:"diagram", kind, ...}                       机制图解，${GENUI_DIAGRAM_KINDS.length} 种 kind（${GENUI_DIAGRAM_KINDS.join(' / ')}），字段见 ui_catalog({topic:"diagram"})
chart   {type:"chart", kind, labels:[string], series:[{name?,values}], ...}   ${CHART_PURPOSE}（${GENUI_CHART_KINDS.join(' / ')}），字段见 ui_catalog({topic:"chart"})

布局与阅读：
- 方案对比用 row 包含并列 card，指标并列用 row 包含 metric；不要把可比较项全排成纵向长文。
- card 的标题就是分区标题，内部直接放数据或说明；不要再套一张只装相同内容的 card。
- table 只放同类记录，列内内容尽量简短。长解释用 text，不把整段报告压进表格。
- 长表默认显示前 6 行并提供展开全部；仍须传入完整 rows，不要把显示折叠误当成数据截断。
- 次要内容收纳用 collapse，并列互斥的内容用 tabs；开合与选中页是视图状态，不写文档、不参与参数提交。
- collapse / tabs 比 card 多一层路径：0.1 是第 2 组，0.1.0 是组内第一个节点（ui_inspect 大纲会把组这一层打出来）。
- 不要在 collapse / tabs 里放 controls：收起或切页会让参数看不见却仍被提交。
- 表格的排序与筛选是用户侧的视图操作，不影响文档本身；需要固定顺序时按期望顺序传 rows，不要指望默认排序。
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
description 可选。四类参数都可用 group 与 visibleWhen（见下）：
number  {type:"number", id, label, description?, group?, visibleWhen?, min, max, step?, default, unit?}
        min < max，default 必须落在 [min, max]；step 省略时由渲染端决定，写了必须大于 0。
select  {type:"select", id, label, description?, group?, visibleWhen?, options:[{value,label}], default}
        选项 ${GENUI_MIN_PARAM_OPTIONS}..${GENUI_MAX_PARAM_OPTIONS} 个，value 不重复，default 必须是某个选项的 value。
        value 与 label 都限 ${GENUI_MAX_PARAM_OPTION_CHARS} 字符；value 是提交时回填的原始值，label 是界面文案。
toggle  {type:"toggle", id, label, description?, group?, visibleWhen?, default}      default 必须是布尔值
text    {type:"text", id, label, description?, group?, visibleWhen?, default?, placeholder?}
        单行自由输入（项目名、备注），上限 ${GENUI_MAX_PARAM_TEXT_CHARS} 字符，placeholder 限 ${GENUI_MAX_PARAM_PLACEHOLDER_CHARS} 字符。
        default 省略即空串，交给用户填；用户留空时提交内容会写成「（未填写）」，不会自动拦下提交。

group：可选，不超过 ${GENUI_MAX_PARAM_GROUP_CHARS} 字符的分组标题。只有声明顺序上相邻且组名相同的参数会归到同一个带标题的区块；
同一个组名出现在不相邻的位置会被拆成两块，所以要把同组参数排在一起。不用分组的参数直接跟在后面。

visibleWhen：可选，参数的条件显示 {id, equals}。只在参数 id 取到 equals 时才显示这个控件。
- 目标只能是 select 或 toggle（取值集合在解析期就已知，equals 才能被校验），不能用 number 或 text。
- equals 必须是目标 select 的某个选项 value，或布尔值（目标是 toggle）。
- 目标参数自己不能再声明 visibleWhen（不支持多级依赖）；自引用也会被拒。
- 不能是图示 binds 的绑定目标（被隐藏的控件不该驱动图解）。
- 条件不满足时参数仍会随提交带出去，但会标注「条件未满足，未生效」；不要靠隐藏来表达「这个参数不用管了」。
典型用法：选了「过期时间」才显示超时秒数；开了压缩才显示压缩级别。

重置按钮：界面上自动有一个「重置为默认值」按钮，不需要在文档里声明任何字段。

submitLabel 可选，不超过 ${GENUI_MAX_SUBMIT_LABEL_CHARS} 字符，用于提交按钮；省略时按钮叫「提交参数」。

用户提交后你会收到一条形如以下内容的用户消息：
${GENUI_SUBMIT_PREFIX}：《界面标题》 documentId=… revision=…
- 缓存容量（capacity）：256 MB
按 documentId 认定是同一份界面的回填，直接基于这些取值继续，不要重画同一界面。`

/** 图解目录的引导段；不写种类数，新增种类时不必改这里。 */
const DIAGRAM_INTRO = `机制图解用几何公式把关系画出来，适合装配顺序、传动比、运动规律、受力、串联回路与层状剖面；不适合画任意示意图。
所有 kind 共用的字段：caption?（1..400 字符）与 binds?（绑定，见下）。`

/**
 * 每种图示的字段说明；键集合由 `GenuiDiagramKind` 约束，新增种类时缺键会立刻编译报错。
 * 拼进目录的顺序取 `GENUI_DIAGRAM_KINDS`，与解析分派顺序一致。
 */
const DIAGRAM_KIND_DOCS: Readonly<Record<GenuiDiagramKind, string>> = {
  exploded: `exploded  装配拆解：纵向展开零件
  {type:"diagram", kind:"exploded", parts:[{label, note?}], caption?, binds?:{spread?}}
  parts ${GENUI_MIN_EXPLODED_PARTS}..${GENUI_MAX_EXPLODED_PARTS} 个；label 不超过 ${GENUI_MAX_DIAGRAM_LABEL_CHARS} 字符，note 不超过 ${GENUI_MAX_DIAGRAM_NOTE_CHARS} 字符。
  spread 取 0..1，控制拆解间距：0 最紧、1 最松。`,
  gear: `gear  齿轮传动：节圆半径正比于齿数，相邻齿轮相切
  {type:"diagram", kind:"gear", gears:[{label, teeth}], caption?, binds?:{angle?}}
  gears ${GENUI_MIN_GEARS}..${GENUI_MAX_GEARS} 级；teeth 是 ${GENUI_MIN_GEAR_TEETH}..${GENUI_MAX_GEAR_TEETH} 的整数。
  转速比由齿数推出（上一级齿数/本级齿数），转向交替；angle 是主动轮的驱动角，单位度。
  级数超过 4 时单个齿轮变小，齿数文字可能不画，但齿数仍在结论里。`,
  crank: `crank  曲柄连杆：活塞位移 x = r·cosθ + √(l² − r²sin²θ)
  {type:"diagram", kind:"crank", crank, rod, unit?, caption?, binds?:{angle?}}
  crank 与 rod 都是大于 0 的有限数字，且必须 rod > crank，否则曲柄转不过一周、整份被拒。
  unit 是长度单位（如 mm）；angle 是曲柄角，单位度，默认 0。`,
  vector: `vector  力矢量：多个力共起点，末端画箭头，并给出合力
  {type:"diagram", kind:"vector", vectors:[{label, magnitude, angle}], unit?, caption?, binds?:{angle?}}
  vectors ${GENUI_MIN_VECTORS}..${GENUI_MAX_VECTORS} 个；magnitude 是大于 0 的有限数字。
  angle 是方向角，单位度，0 表示向右、逆时针为正（与曲柄角同口径）；unit 是力或长度的单位（如 N）。
  合力由分量求和推出；模长几乎相抵时结论会写“合力为 0（受力平衡）”。angle 绑定把整个力系一起旋转。`,
  circuit: `circuit  串联电路：单一回路，电源在左，元件依次串入
  {type:"diagram", kind:"circuit", voltage, components:[{kind, label, value?}], caption?, binds?:{voltage?}}
  voltage 是大于 0 的有限数字（伏）；components ${GENUI_MIN_CIRCUIT_PARTS}..${GENUI_MAX_CIRCUIT_PARTS} 个。
  元件 kind 只能是 resistor（电阻）、lamp（灯泡）或 switch（开关）；resistor 与 lamp 必须给 value（阻值，> 0），
  switch 不接受 value。只支持串联：并联与分支需要节点图自动布局，请改用 table 表达。
  结论给 R总、I=U/R总、各元件压降与总功率；回路含断开的开关时写“回路不通，电流 0”而不给假值。`,
  section: `section  剖面：同心圆环，由内到外逐层包裹
  {type:"diagram", kind:"section", layers:[{label, thickness, note?}], unit?, caption?, binds?:{}}
  layers ${GENUI_MIN_SECTION_LAYERS}..${GENUI_MAX_SECTION_LAYERS} 层，数组顺序就是由内到外；thickness 大于 0。
  结论给各层外径、总外径与环形面积占比（面积按外圆减内圆算，不是厚度占比）。
  剖面没有天然可调量，不接受 binds。`
}

const DIAGRAM_OUTRO = `绑定 binds 不是表达式：只有 spread（exploded）、angle（gear / crank / vector）与 voltage（circuit）三个键，
值必须是文档 params 里已声明的 number 参数 id。绑到 select、toggle 或 text 会被拒。
注意：绑定不会让参数免于被控件组引用——要让用户能调，仍然必须有 controls 节点引用它。

图示是叶子节点，内部不再嵌套其他节点；几何与推导结论由桌面端算出并以文本同时给出。`

const DIAGRAM = [
  DIAGRAM_INTRO,
  ...GENUI_DIAGRAM_KINDS.map((kind) => DIAGRAM_KIND_DOCS[kind]),
  DIAGRAM_OUTRO
].join('\n\n')

/** 图表目录的引导段；不写种类数，新增种类时不必改这里。 */
const CHART_INTRO = '图表画分类轴 + 数据。按用途选 kind：'

/**
 * 每种图表的用途说明；键集合由 `GenuiChartKind` 约束，新增种类时缺键会立刻编译报错。
 * 拼进目录的顺序取 `GENUI_CHART_KINDS`，与解析分派顺序一致。
 */
const CHART_KIND_DOCS: Readonly<Record<GenuiChartKind, string>> = {
  bar: `bar   柱状图：分类对比，从零线起算，正负方向相反，同一分类的多条序列并排分组；1~${GENUI_MAX_CHART_SERIES} 条序列。`,
  line: `line  折线图：趋势与变化，每条序列各一条线；1~${GENUI_MAX_CHART_SERIES} 条序列。`,
  pie: 'pie   饼图：占比表达，只画一条序列，每片是一个分类。',
  donut: 'donut 环形图：与饼图同数据，中间显示总计，适合把总量一并写出来。'
}

const CHART_DETAIL = `占比、构成、份额优先用 pie/donut，不要用柱状图让人硬读比例；超过 ${GENUI_MAX_PIE_SLICES} 片或需要跨分类对比时用 table。

形状：{type:"chart", kind:${GENUI_CHART_KINDS.map((kind) => `"${kind}"`).join('|')}, labels:[string], series:[{name?,values}], title?, caption?, unit?}
- labels 是分类轴，${GENUI_MIN_CHART_POINTS}..${GENUI_MAX_CHART_POINTS} 个，每个不超过 ${GENUI_MAX_CHART_LABEL_CHARS} 字符；超过 4 个字符时轴标签会截断（完整值仍在无障碍说明里）。
- series ${GENUI_MAX_CHART_SERIES} 条以内，每条 {name?, values}；values 是数字数组，长度必须等于 labels，按位置一一对应。
- 多条序列时 name 必填且不重复（不超过 ${GENUI_MAX_CHART_SERIES_NAME_CHARS} 字符），图例靠它区分；单序列可以省略 name。
- values 必须是有限数字；bar/line 允许负数，pie/donut 不允许负数。不要传字符串化的数字，也不要用 null 表示缺失。
- pie/donut 额外约束：只能一条序列、切片不超过 ${GENUI_MAX_PIE_SLICES} 个、每个值 ≥ 0 且总和 > 0；百分比由桌面端按总和算，不要自己写“45%”这类字符串值。
- title 不超过 ${GENUI_MAX_CHART_TITLE_CHARS} 字符；caption 不超过 400 字符；unit 是数值单位（如 ms、MB），所有序列共用一个单位。
- bar/line 的坐标轴范围与刻度由桌面端按全部序列自动取整，不要自己补零值或占位分类。
- 画布只有 320px 宽，多序列建议分类不超过 8 个；多序列不标每点数值，饼图只在占比 ≥10% 的切片上标百分比，完整占比靠图例与说明文字承载。

图表不绑定参数；桌面端提供悬停数值提示，那是只读增强（不改数据、不参与参数提交），
因此仍需把关键结论写进 fallback 与 caption。需要随参数变化的图形用 diagram。
图表与 fallback 的分工：fallback 里要写清结论（每序列的最大值、占比最大的分类与百分比、趋势或差距），不能只写“见下图”。`

const CHART = [
  CHART_INTRO,
  ...GENUI_CHART_KINDS.map((kind) => CHART_KIND_DOCS[kind]),
  CHART_DETAIL
].join('\n')

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
- op=insert：把 node 插到 path 指向的容器（顶层 nodes、card / row 的子节点、collapse / tabs 的某一组）的 index 处；
  index 省略则追加到末尾。
- op=remove：删掉 path 指向的节点（不能删到剩零个节点）。
- 分组容器多一层：collapse / tabs 里 "0.1" 指第 2 组本身，"0.1.0" 指组内第一个节点。
  insert 可以指向组；replace / remove 只能指向节点——要增删整组请 replace 整个 collapse / tabs 节点。
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

示例四：图解与参数并排（宽度不足时自动上下排列，两边读取同一份参数；齿轮最多 6 级）
{"version":${GENUI_VERSION},"title":"四级减速","fallback":"四级齿轮减速：齿数 12→36→18→54→20，总传动比 1.67，末级转向与主动轮相反。",
 "params":[{"id":"angle","type":"number","label":"驱动角","min":0,"max":360,"step":5,"default":30,"unit":"°"}],
 "nodes":[
  {"type":"row","columns":2,"children":[
    {"type":"diagram","kind":"gear","binds":{"angle":"angle"},"caption":"齿数 12 / 36 / 18 / 54 / 20",
     "gears":[{"label":"主动轮","teeth":12},{"label":"一级轮","teeth":36},{"label":"二级轮","teeth":18},
              {"label":"三级轮","teeth":54},{"label":"输出轮","teeth":20}]},
    {"type":"controls"}
  ]}
 ]}

示例五：力矢量（方向角 0 表示向右、逆时针为正；合力由分量求和推出）
{"version":${GENUI_VERSION},"title":"斜面受力","fallback":"重力 100 N 向下、支持力 80 N 向上偏右 30°、摩擦力 20 N 向左；合力约 36.6 N，方向向下偏右。","nodes":[
  {"type":"diagram","kind":"vector","unit":"N","caption":"三个力共起点，虚线为合力",
   "vectors":[
    {"label":"重力","magnitude":100,"angle":270},
    {"label":"支持力","magnitude":80,"angle":60},
    {"label":"摩擦力","magnitude":20,"angle":180}
   ]}
 ]}

示例六：柱状图（单序列，省略 name 时不出图例）
{"version":${GENUI_VERSION},"title":"各方案构建耗时","fallback":"四个方案的构建耗时：冷构建 92 秒最长，增量构建 11 秒最短。","nodes":[
  {"type":"chart","kind":"bar","unit":"s","caption":"示例数据，不代表本机实测",
   "labels":["冷构建","增量","并行","缓存"],
   "series":[{"values":[92,11,34,27]}]}
 ]}

示例七：双序列折线（多序列必须给 name，图例自动生成）
{"version":${GENUI_VERSION},"title":"一周接口耗时","fallback":"p95 从 180 毫秒降到 120 毫秒，p50 稳定在 40 毫秒上下；这是示例数据。","nodes":[
  {"type":"chart","kind":"line","unit":"ms","title":"接口耗时",
   "labels":["周一","周二","周三","周四","周五"],
   "series":[
    {"name":"p50","values":[42,40,38,41,39]},
    {"name":"p95","values":[180,165,150,132,120]}
   ],
   "caption":"示例数据，不代表本机实测"}
 ]}

示例八：环形图（占比表达，只能一条序列，中间显示总计）
{"version":${GENUI_VERSION},"title":"缓存占用构成","fallback":"图片缓存占 60%（600 MB）最多，其次是构建产物 20%，其余两类各占 10%。","nodes":[
  {"type":"chart","kind":"donut","unit":"MB","title":"缓存占用",
   "labels":["图片缓存","构建产物","日志","临时文件"],
   "series":[{"values":[600,200,100,100]}],
   "caption":"示例数据，不代表本机实测"}
 ]}

示例九：带时间点的时间线（按时间先后传入；时间原样展示，不解析不排序）
{"version":${GENUI_VERSION},"title":"一次回滚的经过","fallback":"09:12 开始灰度，09:18 错误率升高后中止，09:25 完成回滚，09:40 恢复稳定。","nodes":[
  {"type":"timeline","items":[
    {"time":"09:12","title":"开始灰度","description":"先放 5% 流量。"},
    {"time":"09:18","title":"中止放量","description":"错误率从 0.2% 升到 3.1%。"},
    {"time":"09:25","title":"完成回滚","description":"全部实例回到上一版。"},
    {"time":"09:40","title":"指标恢复","description":"错误率回到 0.2%。"}
  ]}
 ]}

示例十：标签页 + 折叠（并列互斥的内容放 tabs，次要清单收进 collapse；两者都不放 controls）
{"version":${GENUI_VERSION},"title":"一次发布的三个阶段","fallback":"准备阶段确认变更范围与回滚点；发布阶段先灰度 5% 再放全量；收尾阶段核对错误率与耗时是否回到基线。","nodes":[
  {"type":"tabs","items":[
    {"label":"准备","children":[
      {"type":"list","items":["确认本次变更的文件范围","记录当前错误率与 p95 作为基线","写好回滚命令"]}
    ]},
    {"label":"发布","children":[
      {"type":"steps","items":[
        {"title":"灰度 5%","description":"观察 10 分钟错误率与耗时。"},
        {"title":"放量到 100%","description":"灰度无异常后一次放完。"}
      ]}
    ]},
    {"label":"收尾","children":[
      {"type":"collapse","items":[
        {"title":"核对清单","open":true,"children":[
          {"type":"list","items":["错误率回到基线","p95 无明显上升","监控告警已复位"]}
        ]},
        {"title":"回滚命令（备用）","children":[
          {"type":"text","text":"回滚只在上一步不通过时使用；执行后重新核对基线。"}
        ]}
      ]}
    ]}
  ]}
 ]}

示例十一：参数分组 + 条件显示（选「过期时间」才出现超时秒数；开了压缩才出现级别；界面自带重置按钮）
{"version":${GENUI_VERSION},"title":"缓存参数","fallback":"缓存容量 256 MB，淘汰策略为 LRU，开启压缩、级别 6；选「过期时间」时额外给超时秒数。",
 "params":[
  {"id":"capacity","type":"number","label":"缓存容量","group":"基本","min":64,"max":2048,"step":64,"default":256,"unit":"MB"},
  {"id":"strategy","type":"select","label":"淘汰策略","group":"基本","default":"lru","options":[
    {"value":"lru","label":"LRU"},{"value":"lfu","label":"LFU"},{"value":"ttl","label":"过期时间"}]},
  {"id":"ttlSeconds","type":"number","label":"超时秒数","group":"基本","visibleWhen":{"id":"strategy","equals":"ttl"},
   "min":30,"max":3600,"step":30,"default":300,"unit":"s"},
  {"id":"compression","type":"toggle","label":"启用压缩","group":"压缩","default":true},
  {"id":"level","type":"number","label":"压缩级别","group":"压缩","visibleWhen":{"id":"compression","equals":true},
   "min":1,"max":9,"step":1,"default":6}
 ],
 "submitLabel":"按这组参数继续",
 "nodes":[{"type":"controls"}]}`

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
