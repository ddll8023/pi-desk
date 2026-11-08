/**
 * 用量统计视图的纯函数与展示格式化：
 * 提供日期范围切片、堆叠柱与明细表的行数据、构成条与趋势轴线刻度、缓存命中率与占比计算，
 * 供用量统计分节与构成条组件复用。
 * 范围按「有记录的日期」取末尾 N 天，不按自然日补零；费用缺失时保持 null，不推算金额。
 */
import type { UsageDailyStat } from '../../../shared/usage-stats-api'
import { cacheHitRate, formatCost, formatCostOrDash, formatTokens } from './usage-format'

export { cacheHitRate, formatTokens }

/** 趋势图可选范围：近 7 / 30 / 90 个有记录日期，或全部。 */
export type UsageRange = 7 | 30 | 90 | 'all'

/** 趋势图指标：Token 量，或供应商上报的费用。 */
export type UsageMetric = 'tokens' | 'cost'

/** 范围选项按从短到长排列，默认选中 30 天。 */
export const USAGE_RANGE_OPTIONS: readonly { readonly value: UsageRange; readonly label: string }[] = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
  { value: 'all', label: '全部' }
]

/**
 * 堆叠柱的四个 token 分项。
 * 颜色取用量专用色阶：同一青蓝色相的四级明度 + 一处暖色强调。
 * 分类色槽（chart-1..6）适合并列类别，在缓存读取占九成以上的用量构成里会失衡。
 */
export type UsageSegmentKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite'

export const USAGE_SEGMENTS: readonly {
  readonly key: UsageSegmentKey
  readonly label: string
  /** 直接取主题 CSS 变量：浅色与暗色各自成立，也不依赖类名扫描。 */
  readonly color: string
}[] = [
  { key: 'input', label: '输入', color: 'var(--color-desk-usage-1)' },
  { key: 'output', label: '输出', color: 'var(--color-desk-usage-2)' },
  { key: 'cacheRead', label: '缓存读取', color: 'var(--color-desk-usage-3)' },
  { key: 'cacheWrite', label: '缓存写入', color: 'var(--color-desk-usage-4)' }
]

/**
 * 构成条的一段：宽度百分比与已格式化的读数。
 * 组件只负责画，占比口径、分母与文本都在这里定好，避免同一条构成关系在两处各算一遍。
 */
export interface CompositionSegment {
  readonly key: UsageSegmentKey
  readonly label: string
  readonly color: string
  /** 相对构成条整宽的百分比；零值段保留在结果里，由组件跳过。 */
  readonly percent: number
  /** 已格式化的占比文本，例如 "42.5%"。 */
  readonly share: string
  /** 已格式化的数值文本，例如 "1.2M"。 */
  readonly value: string
  /** 未格式化的原始 token 数：图例靠它在悬停时给出精确值。 */
  readonly raw: number
}

/**
 * 把四个 token 分项组装成构成条。
 * 分母取四项之和而不是总量：供应商上报的 totalTokens 可能包含未分项的余额
 * （如推理 token），用总量归一会让四段之和不足整宽、条尾留出无法解释的空隙。
 */
export function buildCompositionSegments(
  values: Readonly<Record<UsageSegmentKey, number>>
): readonly CompositionSegment[] {
  const sum = USAGE_SEGMENTS.reduce((total, segment) => total + Math.max(0, values[segment.key]), 0)
  if (sum <= 0) return []
  return USAGE_SEGMENTS.map((segment) => {
    const value = Math.max(0, values[segment.key])
    return {
      key: segment.key,
      label: segment.label,
      color: segment.color,
      percent: (value / sum) * 100,
      share: calculateSharePercent(value, sum),
      value: formatTokens(value),
      raw: value
    }
  })
}

/** 趋势图 Y 轴的一档刻度：`ratio` 是相对峰值的比例，标签是已格式化读数。 */
export interface UsageAxisTick {
  readonly ratio: number
  readonly label: string
}

/**
 * 取峰值、半峰值与 0 三档刻度；单位随所选指标，费用缺失不在这里推算。
 * 刻度量级跟随峰值而不是整数档位，避免短范围下出现 0/2M/4M 这类无意义的空档。
 */
export function buildAxisTicks(
  bars: readonly DailyBarItem[],
  metric: UsageMetric
): readonly UsageAxisTick[] {
  const peak = Math.max(0, ...bars.map(bar => bar.metricValue))
  const formatValue = (value: number): string => (
    metric === 'cost' ? `$${formatCost(value)}` : formatTokens(Math.round(value))
  )
  return [
    { ratio: 1, label: formatValue(peak) },
    { ratio: 0.5, label: formatValue(peak / 2) },
    { ratio: 0, label: metric === 'cost' ? '$0' : '0' }
  ]
}

/** 格式化完整时间：年-月-日 时:分 */
export function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}`
}

/** 格式化日期柱状图 X 轴简写标签：MM-DD */
export function formatShortDate(dateStr: string): string {
  if (dateStr.length >= 10) {
    return dateStr.slice(5)
  }
  return dateStr
}

/** 日期键无法解析时扫描器写入 `unknown`，展示层统一写成人话。 */
export function formatDateLabel(dateStr: string): string {
  return dateStr === 'unknown' ? '未知日期' : dateStr
}

/** 计算某一项 token 在总 token 中的占比百分比文本：例如 "42.5%" */
export function calculateSharePercent(value: number, total: number): string {
  if (total <= 0 || !Number.isFinite(value) || value <= 0) return '0.0%'
  const percent = (value / total) * 100
  return `${percent.toFixed(1)}%`
}

/** 按范围取末尾 N 个有记录日期；全部范围原样返回。 */
export function sliceDaily(daily: readonly UsageDailyStat[], range: UsageRange): readonly UsageDailyStat[] {
  if (range === 'all') return daily
  return daily.length > range ? daily.slice(daily.length - range) : daily
}

/** 柱体的一段：占该柱高度的百分比，柱高本身由当天指标值与峰值归一化。 */
export interface DailyBarSegment {
  readonly key: UsageSegmentKey
  readonly percent: number
}

/** 柱状图条目数据结构 */
export interface DailyBarItem {
  readonly date: string
  readonly label: string
  readonly totalTokens: number
  readonly cost: number | null
  /** 该日按当前指标取到的原始值，Axis 刻度据此取峰值。 */
  readonly metricValue: number
  /** 该日当前指标是否有值；无值（含费用视图下未计价）只画基线条，不画柱。 */
  readonly hasValue: boolean
  readonly heightPercent: number
  readonly segments: readonly DailyBarSegment[]
  /** 是否渲染 X 轴日期标签：日期较多时全量标注会互相重叠，只标注首末与等距的少数几根。 */
  readonly showLabel: boolean
  readonly ariaLabel: string
}

export interface DailyBarsOptions {
  readonly range: UsageRange
  readonly metric: UsageMetric
}

/** 供读屏使用的单日描述，费用未知时如实说明而不是省略。 */
function describeDay(item: UsageDailyStat): string {
  const parts = [
    `输入 ${formatTokens(item.input)}`,
    `输出 ${formatTokens(item.output)}`,
    `缓存读 ${formatTokens(item.cacheRead)}`,
    `缓存写 ${formatTokens(item.cacheWrite)}`,
    `${item.messageCount} 条回复`
  ]
  return `${formatDateLabel(item.date)}：总计 ${formatTokens(item.totalTokens)}（${parts.join('，')}）；费用 ${item.cost === null ? '未提供价格' : `$${formatCostOrDash(item.cost)}`}`
}

/**
 * 将日度趋势归一化为堆叠柱；柱高按所选指标取峰值归一化，
 * 段高按当天四项之和归一，保证「柱高 = 当天该指标、段和 = 100%」。
 */
export function buildDailyBars(
  daily: readonly UsageDailyStat[],
  options: DailyBarsOptions
): readonly DailyBarItem[] {
  const sliced = sliceDaily(daily, options.range)
  if (sliced.length === 0) return []

  const readMetric = (item: UsageDailyStat): number | null => (
    options.metric === 'cost' ? item.cost : item.totalTokens
  )
  const maxValue = Math.max(1, ...sliced.map(item => readMetric(item) ?? 0))
  const lastIndex = sliced.length - 1
  // 标签间隔按「最多约 8 个标签」反推；末位附近不足一个间隔时让位给末位，避免最后两个标签贴在一起。
  const labelStep = Math.max(1, Math.ceil(sliced.length / (options.range === 7 ? 7 : 8)))

  return sliced.map((item, index) => {
    const value = readMetric(item) ?? 0
    // 有值但极小的日子保留 4% 可见高度；无值（如当天没有计价调用）不画柱。
    const ratio = value > 0 ? Math.max(0.04, value / maxValue) : 0
    const heightPercent = Math.min(100, Math.round(ratio * 100))
    // 段高按四项之和归一：上报的总量可能含未分项的余额，用总量归一会让柱顶留出空缺。
    const segmentTotal = USAGE_SEGMENTS.reduce(
      (total, segment) => total + Math.max(0, item[segment.key]),
      0
    )
    const segments: readonly DailyBarSegment[] = segmentTotal > 0
      ? USAGE_SEGMENTS.map(segment => ({
          key: segment.key,
          percent: (Math.max(0, item[segment.key]) / segmentTotal) * 100
        }))
      : []
    const description = describeDay(item)

    return {
      date: item.date,
      label: item.date === 'unknown' ? '未知' : formatShortDate(item.date),
      totalTokens: item.totalTokens,
      cost: item.cost,
      metricValue: value,
      hasValue: value > 0,
      heightPercent,
      segments,
      showLabel:
        index === 0 ||
        index === lastIndex ||
        (index % labelStep === 0 && lastIndex - index >= labelStep),
      ariaLabel: description
    }
  })
}

/** 按日明细表的一行，顺序为最新在前。 */
export interface DailyDetailRow {
  readonly date: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly messageCount: number
  readonly cost: number | null
}

/** 明细表用于精确读数与键盘浏览，行序与柱状图相反：最新日期在最上方。 */
export function buildDailyDetailRows(
  daily: readonly UsageDailyStat[],
  range: UsageRange
): readonly DailyDetailRow[] {
  return sliceDaily(daily, range)
    .map(item => ({
      date: formatDateLabel(item.date),
      input: item.input,
      output: item.output,
      cacheRead: item.cacheRead,
      cacheWrite: item.cacheWrite,
      totalTokens: item.totalTokens,
      messageCount: item.messageCount,
      cost: item.cost
    }))
    .reverse()
}
