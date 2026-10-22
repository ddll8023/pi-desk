/** 生成式界面的图表：柱状、折线、饼图与环形图，以及数据点与序列结构。 */

import { GENUI_CHART_KINDS } from './limits'


/** 图表种类：柱状图用于分类对比，折线图用于趋势，饼图与环形图用于占比。 */
export type GenuiChartKind = (typeof GENUI_CHART_KINDS)[number]

/**
 * 旧形状的一个数据点：分类标签加数值。
 * 只用于把历史会话里的 `points` 归一化成单序列，新文档请写 `labels` + `series`。
 */
export interface GenuiChartPoint {
  readonly label: string
  readonly value: number
}

/**
 * 一条序列：可选的名称与逐分类取值。
 * `values` 与文档的 `labels` 一一对应且等长，错位在解析期就被拒，
 * 因此几何层不需要按标签对齐，也不存在「缺点按 0 补齐」的歧义。
 */
export interface GenuiChartSeries {
  readonly name?: string
  readonly values: readonly number[]
}

/** 柱状图：分类轴上的数值对比；多条序列时同一分类分组并列出图例。 */
export interface GenuiBarChart {
  readonly type: 'chart'
  readonly kind: 'bar'
  readonly labels: readonly string[]
  readonly series: readonly GenuiChartSeries[]
  readonly title?: string
  readonly caption?: string
  readonly unit?: string
}

/** 折线图：分类轴上的趋势；多条序列时各自连线并出图例。 */
export interface GenuiLineChart {
  readonly type: 'chart'
  readonly kind: 'line'
  readonly labels: readonly string[]
  readonly series: readonly GenuiChartSeries[]
  readonly title?: string
  readonly caption?: string
  readonly unit?: string
}

/**
 * 饼图：各分类占总量的比例。
 * 只允许一条序列（占比只有一个维度），切片数、非负与总和在解析期就把关，
 * 否则渲染端要面对「占比除零」「负面积」这类画不出来的数据。
 */
export interface GenuiPieChart {
  readonly type: 'chart'
  readonly kind: 'pie'
  readonly labels: readonly string[]
  readonly series: readonly GenuiChartSeries[]
  readonly title?: string
  readonly caption?: string
  readonly unit?: string
}

/** 环形图：与饼图同数据，中间留空显示总计，适合把总量一并写出来。 */
export interface GenuiDonutChart {
  readonly type: 'chart'
  readonly kind: 'donut'
  readonly labels: readonly string[]
  readonly series: readonly GenuiChartSeries[]
  readonly title?: string
  readonly caption?: string
  readonly unit?: string
}

/** 图表节点联合；只画图，不绑定参数；悬停数值提示由渲染端提供，属只读增强，不进协议。 */
export type GenuiChartNode = GenuiBarChart | GenuiLineChart | GenuiPieChart | GenuiDonutChart
