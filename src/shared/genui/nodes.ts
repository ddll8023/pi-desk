/** 生成式界面的展示节点：文本、列表、指标、表格、步骤、时间线、卡片、行、折叠、标签页与控件容器。 */

import type { GenuiNode } from './parse'


/** 语义色调；只表达语义，界面不据数值自动推断成功或危险。 */
export type GenuiTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger'

/** 文本层级：正文、辅助小字与强调大字。 */
export type GenuiTextSize = 'small' | 'body' | 'large'

/** 纯文本段落。 */
export interface GenuiTextNode {
  readonly type: 'text'
  readonly text: string
  readonly tone?: GenuiTone
  readonly size?: GenuiTextSize
}

/** 有序或无序列表。 */
export interface GenuiListNode {
  readonly type: 'list'
  readonly items: readonly string[]
  readonly ordered?: boolean
}

/** 指标：标签 + 数值 + 可选单位。 */
export interface GenuiMetricNode {
  readonly type: 'metric'
  readonly label: string
  readonly value: string | number
  readonly unit?: string
  readonly tone?: GenuiTone
}

/** 表格列定义。 */
export interface GenuiTableColumn {
  readonly key: string
  readonly label: string
}

/** 表格单元格：只接受字符串与有限数字，不承载嵌套结构。 */
export type GenuiTableCell = string | number

/** 表格行：按列 key 取值。 */
export type GenuiTableRow = Readonly<Record<string, GenuiTableCell>>

/** 表格。 */
export interface GenuiTableNode {
  readonly type: 'table'
  readonly columns: readonly GenuiTableColumn[]
  readonly rows: readonly GenuiTableRow[]
  readonly caption?: string
}

/** 步骤条目；不带状态字段，静态说明不伪装成任务进度。 */
export interface GenuiStepItem {
  readonly title: string
  readonly description?: string
}

/** 步骤序列。 */
export interface GenuiStepsNode {
  readonly type: 'steps'
  readonly items: readonly GenuiStepItem[]
}

/**
 * 时间线的一个时间点：自由文本的时间 + 事件标题 + 可选说明。
 * `time` 不做格式校验也不做排序：桌面端按数组顺序原样渲染，
 * 传入方应按时间先后排列；这样既不用为时区与格式兼容付出代价，也不会把合法写法拒掉。
 */
export interface GenuiTimelineItem {
  readonly time: string
  readonly title: string
  readonly description?: string
}

/**
 * 时间线：带具体时间点的过程。
 * 与 steps 的分工：steps 表达「第几步」，timeline 表达「什么时刻发生了什么」。
 * 同样不带状态字段——时间点只陈述事实，不伪装成任务进度。
 */
export interface GenuiTimelineNode {
  readonly type: 'timeline'
  readonly items: readonly GenuiTimelineItem[]
}

/** 卡片：可选标题 + 子节点。 */
export interface GenuiCardNode {
  readonly type: 'card'
  readonly title?: string
  readonly children: readonly GenuiNode[]
}

/** 分栏容器：按可用宽度换行，不固定列数语义。 */
export interface GenuiRowNode {
  readonly type: 'row'
  readonly columns?: number
  readonly children: readonly GenuiNode[]
}

/**
 * 折叠容器的一组内容：组标题 + 是否默认展开 + 子节点。
 * `open` 只描述初次渲染时的开合；开合是视图状态，不写回文档、不参与参数提交，
 * 文档改版（新工具结果）后回到声明值，与表格的排序筛选同一口径。
 */
export interface GenuiCollapseItem {
  readonly title: string
  readonly open?: boolean
  readonly children: readonly GenuiNode[]
}

/**
 * 折叠容器（手风琴）：把次要内容收进可展开的分组，默认全部收起。
 * 与 tabs 的分工：collapse 是同一主题下可同时展开的细节，tabs 是并列互斥、一次只看一页的内容。
 * 分组会隐藏内容，因此组内不允许放 controls——那会让参数看不见却仍随提交带出去。
 */
export interface GenuiCollapseNode {
  readonly type: 'collapse'
  readonly items: readonly GenuiCollapseItem[]
}

/** 标签页的一页：页签文本 + 子节点。 */
export interface GenuiTabItem {
  readonly label: string
  readonly children: readonly GenuiNode[]
}

/**
 * 标签页：并列互斥的内容，一次只显示一页，默认选中第一页。
 * 选中页是视图状态，不写文档、不参与提交；页签不重复，否则无法用文案定位页。
 * 与 collapse 一样不允许页内放 controls：未选中的页会把参数藏起来。
 */
export interface GenuiTabsNode {
  readonly type: 'tabs'
  readonly items: readonly GenuiTabItem[]
}

/**
 * 控件组：按声明顺序渲染参数的输入控件。`params` 省略时渲染文档声明的全部参数。
 * 文档声明了参数就必须被某个控件组引用，否则整份拒绝——避免出现界面上看不见、
 * 提交却带出去的隐藏参数。
 */
export interface GenuiControlsNode {
  readonly type: 'controls'
  readonly params?: readonly string[]
}
