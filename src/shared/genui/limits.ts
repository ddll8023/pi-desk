/** 生成式界面的全部上限、下限与版本常量：数量、字符数、深度与取值枚举。其他子模块从这里引用数值，不重复声明。 */

/** 协议版本；渲染端按此协商，未知版本按不支持处理并明确降级。 */
export const GENUI_VERSION = 1

/** 单份文档序列化后的字符上限；超限整份丢弃，避免会话文件被单条结果撑爆。 */
export const GENUI_MAX_DOCUMENT_CHARS = 256 * 1024

/** 单份文档的节点总数上限（含嵌套子节点）。 */
export const GENUI_MAX_NODES = 240

/**
 * 容器嵌套深度上限；根节点的子节点为第 1 层。
 * 取 5 而不是 4：新增 collapse / tabs 后，「标签页的一页里放分栏，分栏里再并排指标」
 * 就是 tabs > row > card > row > metric 五层，按 4 层会把常见写法直接拒掉；
 * 只放宽不收紧，历史文档不受影响。
 */
export const GENUI_MAX_DEPTH = 5

/** 表格行数与列数上限。 */
export const GENUI_MAX_TABLE_ROWS = 100
export const GENUI_MAX_TABLE_COLUMNS = 8

/** 步骤条目上限。 */
export const GENUI_MAX_STEPS = 12

/** 时间线时间点个数上限；与 steps 对齐，两类过程节点的体量一致。 */
export const GENUI_MAX_TIMELINE_ITEMS = 12

/**
 * 时间点的字符上限。
 * 时间不解析：`09:12`、`第 3 天`、`2026-03-04 09:12` 都合法，
 * 因此限长而不是限格式——格式校验只会把合理写法挡在外面。
 */
export const GENUI_MAX_TIMELINE_TIME_CHARS = 40

/** 列表条目上限。 */
export const GENUI_MAX_LIST_ITEMS = 40

/** 单段文本的字符上限。 */
export const GENUI_MAX_TEXT_CHARS = 4000

/** 表格单元格的字符上限；单元格是标签与短值，不承担段落。 */
export const GENUI_MAX_CELL_CHARS = 200

/** 行内分栏的列数上限。 */
export const GENUI_MAX_COLUMNS = 4

/** 折叠容器的分组个数上下限。 */
export const GENUI_MIN_COLLAPSE_ITEMS = 1
export const GENUI_MAX_COLLAPSE_ITEMS = 8

/** 标签页的页数上下限；少于两页不构成标签页，直接用 card 即可。 */
export const GENUI_MIN_TABS = 2
export const GENUI_MAX_TABS = 6

/** 标签页页签的字符上限；页签是短标签，不承担句子。 */
export const GENUI_MAX_TAB_LABEL_CHARS = 60

/** 单份文档可声明的参数个数上限。 */
export const GENUI_MAX_PARAMS = 8

/** select 参数的选项个数上限。 */
export const GENUI_MAX_PARAM_OPTIONS = 12

/** select 参数的选项个数下限；少于此数就不构成枚举。 */
export const GENUI_MIN_PARAM_OPTIONS = 2

/** 参数标签的字符上限。 */
export const GENUI_MAX_PARAM_LABEL_CHARS = 100

/** 参数说明的字符上限。 */
export const GENUI_MAX_PARAM_DESCRIPTION_CHARS = 300

/** select 选项文本（值与标签）的字符上限。 */
export const GENUI_MAX_PARAM_OPTION_CHARS = 100

/** 参数单位的字符上限。 */
export const GENUI_MAX_PARAM_UNIT_CHARS = 40

/** 参数分组标题的字符上限；组标题是短标签，不承担句子。 */
export const GENUI_MAX_PARAM_GROUP_CHARS = 60

/**
 * 单行文本参数的字符上限。
 * 文本参数承载的是项目名、备注这类短标识，不是段落；上限同时约束输入框的 maxlength 与提交消息的体积。
 */
export const GENUI_MAX_PARAM_TEXT_CHARS = 200

/** 文本参数占位提示的字符上限。 */
export const GENUI_MAX_PARAM_PLACEHOLDER_CHARS = 100

/** 提交按钮文案的字符上限。 */
export const GENUI_MAX_SUBMIT_LABEL_CHARS = 40

/** 装配拆解的零件个数上下限。 */
export const GENUI_MIN_EXPLODED_PARTS = 2
export const GENUI_MAX_EXPLODED_PARTS = 8

/**
 * 齿轮传动里齿轮个数与单齿轮齿数的上下限。
 * 上限放到 6 级：多级减速是真实需求，但 320px 画布上超过 6 个齿轮就分不清了，
 * 几何层会在半径过小时不画齿数文字，只把齿数留在结论里。
 */
export const GENUI_MIN_GEARS = 2
export const GENUI_MAX_GEARS = 6
export const GENUI_MIN_GEAR_TEETH = 6
export const GENUI_MAX_GEAR_TEETH = 60

/** 力矢量的个数上下限；再多箭头会挤在一起，改用 table 表达分量。 */
export const GENUI_MIN_VECTORS = 1
export const GENUI_MAX_VECTORS = 6

/** 串联电路的元件个数上下限。 */
export const GENUI_MIN_CIRCUIT_PARTS = 1
export const GENUI_MAX_CIRCUIT_PARTS = 6

/** 剖面图的层数上下限；少于两层不构成剖面。 */
export const GENUI_MIN_SECTION_LAYERS = 2
export const GENUI_MAX_SECTION_LAYERS = 6

/** 图示标签与说明的字符上限。 */
export const GENUI_MAX_DIAGRAM_LABEL_CHARS = 60
export const GENUI_MAX_DIAGRAM_NOTE_CHARS = 200

/** 图表分类的个数上下限；与列表上限对齐，避免单份文档被数据点撞爆体积。 */
export const GENUI_MIN_CHART_POINTS = 1
export const GENUI_MAX_CHART_POINTS = 40

/**
 * 图表序列条数上限。三条以上在 320px 画布上已经分不清色块，
 * 再多同类记录应当改用 table，而不是把图例堆到看不见。
 */
export const GENUI_MAX_CHART_SERIES = 3

/** 图表标题、分类标签与序列名的字符上限。 */
export const GENUI_MAX_CHART_TITLE_CHARS = 200
export const GENUI_MAX_CHART_LABEL_CHARS = 60
export const GENUI_MAX_CHART_SERIES_NAME_CHARS = 30

/**
 * 饼图与环形图的切片上限。
 * 超过六片在 320px 画布上已经分不清扇区，也超出可用色槽；这类数据应改用 table。
 */
export const GENUI_MAX_PIE_SLICES = 6

/**
 * 参数标识的匹配源：小写字母开头，只含小写字母、数字与下划线。
 * 它同时是提交消息里展示的键，因此限定成不必转义的形态；目录文本与解析共用同一份定义。
 */
export const GENUI_PARAM_ID_PATTERN_SOURCE = '^[a-z][a-z0-9_]{0,31}$'

/**
 * 参数提交消息的固定前缀。它是扩展层提示词识别回填的唯一依据，
 * 因此定义在这里由渲染端与提示词共用，避免两处各写一份后走偏。
 */
export const GENUI_SUBMIT_PREFIX = '[genui] 界面参数已提交'

/** 一次校验最多报告的诊断条数；再多也只是重复同类错误，不如让模型先改前几处。 */
export const GENUI_MAX_ISSUES = 6

/**
 * 一次交付最多自动修复的处数；超过这个量说明文档本身结构性错误，
 * 继续猜下去只会把模型的错误藏起来，因此整体按不可修处理。
 */
export const GENUI_MAX_REPAIRS = 12

/**
 * 图示种类的唯一事实源：数组供运行时遍历（目录说明、错误文案、绑定表），
 * `GenuiDiagramKind` 从它派生。新增种类只需在这里加一项，`Record` 形状的映射与穷尽
 * `switch` 会立刻报错，不会静默漏改。
 */
export const GENUI_DIAGRAM_KINDS = ['exploded', 'gear', 'crank', 'vector', 'circuit', 'section'] as const

/**
 * 图表种类的唯一事实源；与 `GENUI_DIAGRAM_KINDS` 同一做法：数组供运行时遍历，类型从它派生。
 */
export const GENUI_CHART_KINDS = ['bar', 'line', 'pie', 'donut'] as const
