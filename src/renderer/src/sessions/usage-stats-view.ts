/**
 * 用量统计视图的纯函数与展示格式化：
 * 从「会话明细数组」这一份单一数据源按统一时间范围派生全部报表视图——
 * 自然日窗口、概览读数与构成、趋势柱与按日明细、模型/项目分布（含子代理行）、会话列表与下钻过滤、日度热力图。
 * 范围按自然日窗口结算（缺失日为零），「全部」从最早记录日到今天；热力图固定近 53 周、按自然日补齐。
 * 日期无法解析的条目（date 为 `unknown`）无法落在自然日轴上，派生时统一跳过。
 * 费用缺失时保持 null，不推算金额。
 */
import type {
  UsageDailyStat,
  UsageSessionStat,
  UsageTokenBreakdown
} from '../../../shared/usage-stats-api'
import { cacheHitRate, formatCost, formatCostOrDash, formatTokens } from './usage-format'

export { cacheHitRate, formatTokens }

/** 趋势图可选范围：近 7 / 14 / 30 / 90 个自然日，或全部（最早记录日至今） */
export type UsageRange = 7 | 14 | 30 | 90 | 'all'

/** 趋势图指标：Token 量、回复条数，或供应商上报的费用 */
export type UsageMetric = 'tokens' | 'messages' | 'cost'

/** 范围选项按从短到长排列，默认选中 30 天 */
export const USAGE_RANGE_OPTIONS: readonly { readonly value: UsageRange; readonly label: string }[] = [
  { value: 7, label: '近 7 天' },
  { value: 14, label: '近 14 天' },
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

/** 柱体段与构成条的配色统一从这里取，模板里不重复硬编码色值。 */
export function usageSegmentColor(key: UsageSegmentKey): string {
  return USAGE_SEGMENTS.find(segment => segment.key === key)?.color ?? 'var(--color-desk-usage-1)'
}

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
  const formatValue = (value: number): string => {
    if (metric === 'cost') return `$${formatCost(value)}`
    if (metric === 'messages') return String(Math.round(value))
    return formatTokens(Math.round(value))
  }
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

/** 计算某一项 token 在总 token 中的占比百分比文本：例如 "42.5%" */
export function calculateSharePercent(value: number, total: number): string {
  if (total <= 0 || !Number.isFinite(value) || value <= 0) return '0.0%'
  const percent = (value / total) * 100
  return `${percent.toFixed(1)}%`
}

// ---------------------------------------------------------------------------
// 自然日窗口
// ---------------------------------------------------------------------------

/** 自然日窗口：两端都是本地时区的 YYYY-MM-DD 日期键，含端点 */
export interface UsageWindow {
  readonly startKey: string
  readonly endKey: string
  readonly days: number
}

function dateKeyOf(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateOfKey(key: string): Date {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
}

/** 从 startKey 到 endKey（含端点）逐日枚举日期键；逆序或非法区间退化为单日 */
function iterateDateKeys(startKey: string, endKey: string): readonly string[] {
  if (startKey > endKey) return [endKey]
  const keys: string[] = []
  const end = dateOfKey(endKey)
  for (let cursor = dateOfKey(startKey); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
    keys.push(dateKeyOf(cursor))
  }
  return keys
}

/** 日期键是否为可解析的自然日（`unknown` 是扫描器对无法解析时间戳的兜底写法） */
function isNaturalDateKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key)
}

/** 数据里最早的日期键（跳过无法解析的日期）；没有可解析日期时返回 null */
function earliestDateKeyOf(sessions: readonly UsageSessionStat[]): string | null {
  let earliest: string | null = null
  for (const session of sessions) {
    for (const item of session.daily) {
      if (!isNaturalDateKey(item.date)) continue
      if (earliest === null || item.date < earliest) earliest = item.date
    }
  }
  return earliest
}

/** 解析时间范围：固定 N 天为「今天往前 N 天」（含今天），全部为最早记录日到今天 */
export function buildWindow(range: UsageRange, today: Date, earliestKey: string | null): UsageWindow {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const endKey = dateKeyOf(end)
  let startKey = endKey
  if (range === 'all') {
    if (earliestKey !== null && earliestKey < endKey) startKey = earliestKey
  } else {
    startKey = dateKeyOf(new Date(end.getFullYear(), end.getMonth(), end.getDate() - (range - 1)))
  }
  return { startKey, endKey, days: iterateDateKeys(startKey, endKey).length }
}

function isDateInWindow(key: string, window: UsageWindow): boolean {
  return isNaturalDateKey(key) && key >= window.startKey && key <= window.endKey
}

// ---------------------------------------------------------------------------
// 窗口聚合：一次遍历会话明细，产出全部视图共用的窗口内聚合
// ---------------------------------------------------------------------------

interface MutableDailyBucket {
  date: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  messageCount: number
  cost: number
  costDays: number
}

interface MutableModelBucket {
  provider: string
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  messageCount: number
  cost: number
  costDays: number
}

interface MutableProjectBucket {
  projectPath: string
  projectName: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  messageCount: number
  sessionCount: number
  cost: number
  costDays: number
}

/** 窗口内单个模型的聚合读数 */
export interface UsageModelAggregate {
  readonly provider: string
  readonly modelId: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly messageCount: number
  readonly cost: number | null
}

/** 窗口内单个项目的聚合读数 */
export interface UsageProjectAggregate {
  readonly projectPath: string
  readonly projectName: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly sessionCount: number
  readonly cost: number | null
}

/** 全部视图共用的窗口内聚合结果 */
export interface WindowAggregate {
  readonly window: UsageWindow
  /** 窗口内 token 总计，含子代理开销 */
  readonly totals: UsageTokenBreakdown
  /** 窗口内回复条数（子代理调用不计入） */
  readonly messageCount: number
  /** 窗口内费用；没有任何计价调用时为 null */
  readonly cost: number | null
  /** 窗口内有消耗记录的会话数 */
  readonly activeSessions: number
  /** 窗口内自然日序列（按日补零，升序） */
  readonly daily: readonly UsageDailyStat[]
  /** 窗口内模型分布（按总 token 降序） */
  readonly models: readonly UsageModelAggregate[]
  /** 窗口内子代理开销（未归属模型）；子代理不单独计费，只累计 token */
  readonly subAgent: { readonly input: number; readonly output: number; readonly totalTokens: number }
  /** 窗口内项目分布（按总 token 降序） */
  readonly projects: readonly UsageProjectAggregate[]
}

/**
 * 把会话明细按窗口聚合。
 * 模型、项目与子代理只统计窗口内的条目；会话级总计、回复数与费用也从同一批窗口内日条目求和，
 * 保证概览、分布与趋势在同一口径上可对账（模型行 + 子代理行 = 总计）。
 */
export function buildWindowAggregate(
  sessions: readonly UsageSessionStat[],
  range: UsageRange,
  today: Date
): WindowAggregate {
  const window = buildWindow(range, today, earliestDateKeyOf(sessions))

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  let messageCount = 0
  const costState = { cost: 0, costDays: 0 }
  const subAgent = { input: 0, output: 0, totalTokens: 0 }

  const dailyMap = new Map<string, MutableDailyBucket>()
  const modelMap = new Map<string, MutableModelBucket>()
  const projectMap = new Map<string, MutableProjectBucket>()
  let activeSessions = 0

  for (const session of sessions) {
    let sessionActive = false
    let projectBucket: MutableProjectBucket | null = null

    for (const item of session.daily) {
      if (!isDateInWindow(item.date, window)) continue
      if (!sessionActive) {
        sessionActive = true
        activeSessions += 1
        // 同项目多会话共用一个项目桶：先取再建，避免第二个会话覆盖第一个的累计
        projectBucket = projectMap.get(session.projectPath) ?? {
          projectPath: session.projectPath,
          projectName: session.projectName,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          messageCount: 0,
          sessionCount: 0,
          cost: 0,
          costDays: 0
        }
        projectBucket.sessionCount += 1
        projectMap.set(session.projectPath, projectBucket)
      }

      totals.input += item.input
      totals.output += item.output
      totals.cacheRead += item.cacheRead
      totals.cacheWrite += item.cacheWrite
      totals.totalTokens += item.totalTokens
      messageCount += item.messageCount
      if (item.cost !== null) {
        costState.cost += item.cost
        costState.costDays += 1
      }

      let dayBucket = dailyMap.get(item.date)
      if (!dayBucket) {
        dayBucket = {
          date: item.date,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          messageCount: 0,
          cost: 0,
          costDays: 0
        }
        dailyMap.set(item.date, dayBucket)
      }
      dayBucket.input += item.input
      dayBucket.output += item.output
      dayBucket.cacheRead += item.cacheRead
      dayBucket.cacheWrite += item.cacheWrite
      dayBucket.totalTokens += item.totalTokens
      dayBucket.messageCount += item.messageCount
      if (item.cost !== null) {
        dayBucket.cost += item.cost
        dayBucket.costDays += 1
      }

      // projectBucket 在本会话首个窗口内条目时已创建
      const bucket = projectBucket
      if (bucket !== null) {
        bucket.input += item.input
        bucket.output += item.output
        bucket.cacheRead += item.cacheRead
        bucket.cacheWrite += item.cacheWrite
        bucket.totalTokens += item.totalTokens
        bucket.messageCount += item.messageCount
        if (item.cost !== null) {
          bucket.cost += item.cost
          bucket.costDays += 1
        }
      }
    }

    for (const item of session.modelDaily) {
      if (!isDateInWindow(item.date, window)) continue
      const key = `${item.provider}\u0000${item.modelId}`
      let modelBucket = modelMap.get(key)
      if (!modelBucket) {
        modelBucket = {
          provider: item.provider,
          modelId: item.modelId,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          messageCount: 0,
          cost: 0,
          costDays: 0
        }
        modelMap.set(key, modelBucket)
      }
      modelBucket.input += item.input
      modelBucket.output += item.output
      modelBucket.cacheRead += item.cacheRead
      modelBucket.cacheWrite += item.cacheWrite
      modelBucket.totalTokens += item.totalTokens
      modelBucket.messageCount += item.messageCount
      if (item.cost !== null) {
        modelBucket.cost += item.cost
        modelBucket.costDays += 1
      }
    }

    for (const item of session.subAgentDaily) {
      if (!isDateInWindow(item.date, window)) continue
      subAgent.input += item.input
      subAgent.output += item.output
      subAgent.totalTokens += item.totalTokens
    }
  }

  const daily: UsageDailyStat[] = iterateDateKeys(window.startKey, window.endKey).map((key) => {
    const bucket = dailyMap.get(key)
    return {
      date: key,
      input: bucket?.input ?? 0,
      output: bucket?.output ?? 0,
      cacheRead: bucket?.cacheRead ?? 0,
      cacheWrite: bucket?.cacheWrite ?? 0,
      totalTokens: bucket?.totalTokens ?? 0,
      messageCount: bucket?.messageCount ?? 0,
      cost: bucket !== null && bucket.costDays > 0 ? bucket.cost : null
    }
  })

  const models: readonly UsageModelAggregate[] = Array.from(modelMap.values())
    .map(bucket => ({
      provider: bucket.provider,
      modelId: bucket.modelId,
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      totalTokens: bucket.totalTokens,
      messageCount: bucket.messageCount,
      cost: bucket.costDays > 0 ? bucket.cost : null
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const projects: readonly UsageProjectAggregate[] = Array.from(projectMap.values())
    .map(bucket => ({
      projectPath: bucket.projectPath,
      projectName: bucket.projectName,
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      totalTokens: bucket.totalTokens,
      sessionCount: bucket.sessionCount,
      cost: bucket.costDays > 0 ? bucket.cost : null
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  return {
    window,
    totals,
    messageCount,
    cost: costState.costDays > 0 ? costState.cost : null,
    activeSessions,
    daily,
    models,
    subAgent,
    projects
  }
}

// ---------------------------------------------------------------------------
// 趋势柱与按日明细
// ---------------------------------------------------------------------------

/** 柱体的一段：占该柱高度的百分比，柱高本身由当天指标值与峰值归一化。 */
export interface DailyBarSegment {
  readonly key: UsageSegmentKey
  readonly percent: number
}

/** 柱状图条目数据结构 */
export interface DailyBarItem {
  readonly date: string
  readonly label: string
  readonly cost: number | null
  /** Token 指标下柱体由四项分项堆叠；费用与回复数等单值指标不拆段。 */
  readonly stacked: boolean
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

/** 供读屏使用的单日描述，费用未知时如实说明而不是省略。 */
function describeDay(item: UsageDailyStat): string {
  const parts = [
    `输入 ${formatTokens(item.input)}`,
    `输出 ${formatTokens(item.output)}`,
    `缓存读 ${formatTokens(item.cacheRead)}`,
    `缓存写 ${formatTokens(item.cacheWrite)}`,
    `${item.messageCount} 条回复`
  ]
  return `${item.date}：总计 ${formatTokens(item.totalTokens)}（${parts.join('，')}）；费用 ${item.cost === null ? '未提供价格' : `$${formatCostOrDash(item.cost)}`}`
}

/**
 * 把窗口内自然日序列归一化为堆叠柱；柱高按所选指标取峰值归一化，
 * 段高按当天四项之和归一，保证「柱高 = 当天该指标、段和 = 100%」。
 * 序列已按自然日补零，无值日只画基线条，保留日期位置。
 */
export function buildTrendBars(
  aggregate: WindowAggregate,
  metric: UsageMetric
): readonly DailyBarItem[] {
  const sliced = aggregate.daily
  if (sliced.length === 0) return []

  const readMetric = (item: UsageDailyStat): number => {
    if (metric === 'cost') return item.cost ?? 0
    if (metric === 'messages') return item.messageCount
    return item.totalTokens
  }
  const maxValue = Math.max(1, ...sliced.map(item => readMetric(item)))
  const lastIndex = sliced.length - 1
  // 标签间隔按「最多约 8 个标签」反推；末位附近不足一个间隔时让位给末位，避免最后两个标签贴在一起。
  const labelStep = Math.max(1, Math.ceil(sliced.length / 8))

  return sliced.map((item, index) => {
    const value = readMetric(item)
    // 有值但极小的日子保留 4% 可见高度；无值（如当天没有计价调用）不画柱。
    const ratio = value > 0 ? Math.max(0.04, value / maxValue) : 0
    const heightPercent = Math.min(100, Math.round(ratio * 100))
    // 段高按四项之和归一：上报的总量可能含未分项的余额，用总量归一会让柱顶留出空缺。
    const segmentTotal = USAGE_SEGMENTS.reduce(
      (total, segment) => total + Math.max(0, item[segment.key]),
      0
    )
    // 只有 Token 指标按四项拆段；回复数等单值指标整柱同色，拆段会给出并不存在的构成关系。
    const segments: readonly DailyBarSegment[] = metric === 'tokens' && segmentTotal > 0
      ? USAGE_SEGMENTS.map(segment => ({
          key: segment.key,
          percent: (Math.max(0, item[segment.key]) / segmentTotal) * 100
        }))
      : []
    const description = describeDay(item)

    return {
      date: item.date,
      label: formatShortDate(item.date),
      cost: item.cost,
      stacked: metric === 'tokens',
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

/** 按日明细表的一行，顺序为最新在前；`active` 表示当天有回复或消耗。 */
export interface DailyDetailRow {
  readonly date: string
  readonly active: boolean
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly messageCount: number
  readonly cost: number | null
}

/** 明细表用于精确读数与键盘浏览，行序与柱状图相反：最新日期在最上方。 */
export function buildDailyDetailRows(aggregate: WindowAggregate): readonly DailyDetailRow[] {
  return [...aggregate.daily]
    .reverse()
    .map(item => ({
      date: item.date,
      active: item.totalTokens > 0 || item.messageCount > 0,
      input: item.input,
      output: item.output,
      cacheRead: item.cacheRead,
      cacheWrite: item.cacheWrite,
      totalTokens: item.totalTokens,
      messageCount: item.messageCount,
      cost: item.cost
    }))
}

// ---------------------------------------------------------------------------
// 分布行与会话列表（下钻）
// ---------------------------------------------------------------------------

/**
 * 下钻目标：把分布行、趋势柱、热力图格的点击统一收敛到「会话明细」列表。
 * `label` 是下钻上下文标签，供列表标题与清除按钮使用。
 */
export type SessionDrill =
  | { readonly kind: 'model'; readonly provider: string; readonly modelId: string; readonly label: string }
  | { readonly kind: 'project'; readonly projectPath: string; readonly label: string }
  | { readonly kind: 'day'; readonly date: string; readonly label: string }
  | { readonly kind: 'subagent'; readonly label: string }

/** 分布行（模型、项目与子代理共用同一套字段与排布） */
export interface UsageDistributionRow {
  /** v-for 的稳定 key，不用于解析下钻目标 */
  readonly key: string
  readonly name: string
  /** 模型行的供应商标记；项目与子代理行为 null。 */
  readonly badge: string | null
  /** 名称下方的次级标识：模型的输入/输出分项，项目的路径。 */
  readonly detail: string
  /** 路径这类可能被截断的次级标识的悬停全文；不需要时为 null。 */
  readonly detailTitle: string | null
  readonly totalTokens: string
  readonly share: string
  readonly meta: string
  readonly segments: readonly CompositionSegment[]
  readonly drill: SessionDrill
}

/** 窗口内模型分布行（按 token 降序），子代理开销非零时追加「未归属模型」行保证构成可对账 */
export function buildModelDistributionRows(aggregate: WindowAggregate): readonly UsageDistributionRow[] {
  // 分母取含子代理的总计：各模型行 + 子代理行加起来等于总量，占比不会被稀释
  const total = aggregate.totals.totalTokens
  const rows: UsageDistributionRow[] = aggregate.models.map(model => ({
    key: `model:${model.provider}:${model.modelId}`,
    name: model.modelId,
    badge: model.provider,
    detail: `输入 ${formatTokens(model.input)} · 输出 ${formatTokens(model.output)}`,
    detailTitle: null,
    totalTokens: formatTokens(model.totalTokens),
    share: calculateSharePercent(model.totalTokens, total),
    meta: model.cost === null
      ? `${model.messageCount} 次回复`
      : `$${formatCost(model.cost)} · ${model.messageCount} 次回复`,
    segments: buildCompositionSegments(model),
    drill: {
      kind: 'model',
      provider: model.provider,
      modelId: model.modelId,
      label: model.modelId
    } satisfies SessionDrill
  }))
  if (aggregate.subAgent.totalTokens > 0) {
    rows.push({
      key: 'subagent',
      name: '子代理（未归属模型）',
      badge: null,
      detail: '委派子代理产生的调用，未记录模型归属',
      detailTitle: null,
      totalTokens: formatTokens(aggregate.subAgent.totalTokens),
      share: calculateSharePercent(aggregate.subAgent.totalTokens, total),
      meta: '',
      segments: buildCompositionSegments({
        input: aggregate.subAgent.input,
        output: aggregate.subAgent.output,
        cacheRead: 0,
        cacheWrite: 0
      }),
      drill: { kind: 'subagent', label: '子代理（未归属模型）' }
    })
  }
  return rows
}

/** 窗口内项目分布行（按 token 降序） */
export function buildProjectDistributionRows(aggregate: WindowAggregate): readonly UsageDistributionRow[] {
  const total = aggregate.totals.totalTokens
  return aggregate.projects.map(project => ({
    key: `project:${project.projectPath}`,
    name: project.projectName,
    badge: null,
    detail: project.projectPath,
    detailTitle: project.projectPath,
    totalTokens: formatTokens(project.totalTokens),
    share: calculateSharePercent(project.totalTokens, total),
    meta: project.cost === null
      ? `${project.sessionCount} 个会话`
      : `$${formatCost(project.cost)} · ${project.sessionCount} 个会话`,
    segments: buildCompositionSegments(project),
    drill: { kind: 'project', projectPath: project.projectPath, label: project.projectName }
  }))
}

/** 会话明细列表的一行：数值随视图口径（Top 或下钻）按范围结算 */
export interface UsageSessionRow {
  readonly sessionId: string
  readonly projectPath: string
  readonly projectName: string
  readonly title: string
  readonly updatedAt: number
  readonly messageCount: number
  readonly totalTokens: number
  readonly input: number
  readonly output: number
  readonly cost: number | null
}

/** 会话明细列表的统一上限：Top 与下钻共用，避免无界列表 */
export const SESSION_ROWS_LIMIT = 50

interface MutableSessionSum {
  input: number
  output: number
  totalTokens: number
  messageCount: number
  cost: number
  costKnown: boolean
}

function sumSessionWindow(
  session: UsageSessionStat,
  window: UsageWindow
): MutableSessionSum | null {
  let sum: MutableSessionSum | null = null
  for (const item of session.daily) {
    if (!isDateInWindow(item.date, window)) continue
    if (sum === null) sum = { input: 0, output: 0, totalTokens: 0, messageCount: 0, cost: 0, costKnown: false }
    sum.input += item.input
    sum.output += item.output
    sum.totalTokens += item.totalTokens
    sum.messageCount += item.messageCount
    if (item.cost !== null) {
      sum.cost += item.cost
      sum.costKnown = true
    }
  }
  return sum
}

/**
 * 会话明细列表：无下钻时为窗口内消耗 Top（按窗口 token 降序，至多 SESSION_ROWS_LIMIT 条）；
 * 有下钻时按模型、项目、单日或子代理过滤，数值只统计该口径在窗口内的部分。
 */
export function buildSessionRows(
  sessions: readonly UsageSessionStat[],
  aggregate: WindowAggregate,
  drill: SessionDrill | null
): readonly UsageSessionRow[] {
  const rows: UsageSessionRow[] = []

  for (const session of sessions) {
    let sum: MutableSessionSum | null = null

    if (drill === null || drill.kind === 'project') {
      if (drill !== null && drill.projectPath !== session.projectPath) continue
      sum = sumSessionWindow(session, aggregate.window)
    } else if (drill.kind === 'day') {
      const entry = session.daily.find(item => item.date === drill.date)
      if (entry === undefined) continue
      sum = {
        input: entry.input,
        output: entry.output,
        totalTokens: entry.totalTokens,
        messageCount: entry.messageCount,
        cost: entry.cost ?? 0,
        costKnown: entry.cost !== null
      }
    } else if (drill.kind === 'model') {
      for (const item of session.modelDaily) {
        if (item.provider !== drill.provider || item.modelId !== drill.modelId) continue
        if (!isDateInWindow(item.date, aggregate.window)) continue
        if (sum === null) sum = { input: 0, output: 0, totalTokens: 0, messageCount: 0, cost: 0, costKnown: false }
        sum.input += item.input
        sum.output += item.output
        sum.totalTokens += item.totalTokens
        sum.messageCount += item.messageCount
        if (item.cost !== null) {
          sum.cost += item.cost
          sum.costKnown = true
        }
      }
    } else {
      for (const item of session.subAgentDaily) {
        if (!isDateInWindow(item.date, aggregate.window)) continue
        if (sum === null) sum = { input: 0, output: 0, totalTokens: 0, messageCount: 0, cost: 0, costKnown: false }
        sum.input += item.input
        sum.output += item.output
        sum.totalTokens += item.totalTokens
      }
      // 子代理调用不计回复数：列表行带窗口内回复数作上下文，避免出现无法解释的 0
      for (const item of session.daily) {
        if (sum === null || !isDateInWindow(item.date, aggregate.window)) continue
        sum.messageCount += item.messageCount
      }
    }

    if (sum === null || sum.totalTokens <= 0) continue
    rows.push({
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      projectName: session.projectName,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: sum.messageCount,
      totalTokens: sum.totalTokens,
      input: sum.input,
      output: sum.output,
      cost: sum.costKnown ? sum.cost : null
    })
  }

  rows.sort((a, b) => b.totalTokens - a.totalTokens)
  return rows.slice(0, SESSION_ROWS_LIMIT)
}

// ---------------------------------------------------------------------------
// 日度热力图（固定近 53 周，不随范围筛选变化）
// ---------------------------------------------------------------------------

/** 日度热力图的一格；`level` 只是颜色强度分级，真实读数在 `title` 与 `ariaLabel` 里。 */
export interface HeatmapCell {
  readonly date: string
  readonly tokens: number
  readonly messages: number
  readonly level: 0 | 1 | 2 | 3 | 4
  /** 今天之后的格子只占位、不承载数据。 */
  readonly future: boolean
  /** 有记录的格子可点击查看当日会话；无记录与未来格子不可点。 */
  readonly clickable: boolean
  readonly title: string
  readonly ariaLabel: string
}

/** 热力图的一列即一周，固定周一起始、周日结束。 */
export interface HeatmapWeek {
  readonly key: string
  /** 该列列首所在月份变化时才给标签，避免每周都重复月名。 */
  readonly monthLabel: string | null
  readonly cells: readonly HeatmapCell[]
}

/** 近 53 周（一年）的日度用量热力图。 */
export interface HeatmapModel {
  readonly weeks: readonly HeatmapWeek[]
  /** 范围内有记录日期的 Token 合计，口径与概览一致。 */
  readonly totalTokens: number
  readonly activeDays: number
  readonly peakTokens: number
  readonly peakDate: string
  readonly ariaLabel: string
}

/**
 * 热力图 0–4 级填充色：0 级是无记录时的底槽色，1–4 级由用量基色按比例混入底槽色，
 * 不新增主题令牌，浅色与暗色主题各自跟着基色走。
 */
export const HEATMAP_LEVEL_COLORS = [
  'var(--color-desk-canvas-sunken)',
  'color-mix(in oklab, var(--color-desk-usage-1) 18%, var(--color-desk-canvas-sunken))',
  'color-mix(in oklab, var(--color-desk-usage-1) 40%, var(--color-desk-canvas-sunken))',
  'color-mix(in oklab, var(--color-desk-usage-1) 68%, var(--color-desk-canvas-sunken))',
  'color-mix(in oklab, var(--color-desk-usage-1) 95%, var(--color-desk-canvas-sunken))'
] as const

/** 默认回溯的周数：53 列覆盖一年并容纳跨年月份。 */
export const HEATMAP_WEEKS = 53

/** 非零用量的分位阈值，用来把颜色切成四级；样本为空时全部退化为 0。 */
function heatmapThresholds(values: readonly number[]): readonly [number, number, number] {
  if (values.length === 0) return [0, 0, 0]
  const sorted = [...values].sort((a, b) => a - b)
  // 样本非空时索引一定落在合法范围内，这里的回退只为满足索引访问的类型收窄。
  const at = (ratio: number): number => {
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))
    return sorted[index] ?? 0
  }
  return [at(0.25), at(0.5), at(0.75)]
}

/**
 * 把会话明细排成近 N 周的日历热力图。
 * 热力图是固定时间轴视图，不随顶部范围筛选变化；按自然日补齐空白格（否则列会错位），
 * 缺失日期填 0、未来日期只占位。有记录的格子可点击进入当日会话明细。
 */
export function buildHeatmap(
  sessions: readonly UsageSessionStat[],
  today: Date = new Date(),
  weeks: number = HEATMAP_WEEKS
): HeatmapModel {
  const byDate = new Map<string, UsageDailyStat>()
  for (const session of sessions) {
    for (const item of session.daily) {
      if (!isNaturalDateKey(item.date)) continue
      const existing = byDate.get(item.date)
      if (existing === undefined) {
        byDate.set(item.date, item)
        continue
      }
      // 同一天跨会话累加；费用只累加已上报价格的条目，全缺价时保持 null
      const costKnown = existing.cost !== null || item.cost !== null
      byDate.set(item.date, {
        date: item.date,
        input: existing.input + item.input,
        output: existing.output + item.output,
        cacheRead: existing.cacheRead + item.cacheRead,
        cacheWrite: existing.cacheWrite + item.cacheWrite,
        totalTokens: existing.totalTokens + item.totalTokens,
        messageCount: existing.messageCount + item.messageCount,
        cost: costKnown ? (existing.cost ?? 0) + (item.cost ?? 0) : null
      })
    }
  }

  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const endKey = dateKeyOf(end)
  // 以周一为一周起点：先回到本周周一，再往前推满整周。
  const offsetToMonday = (end.getDay() + 6) % 7
  const start = new Date(
    end.getFullYear(),
    end.getMonth(),
    end.getDate() - offsetToMonday - (weeks - 1) * 7
  )

  const nonzero = Array.from(byDate.values())
    .map(item => item.totalTokens)
    .filter(value => value > 0)
  const [p25, p50, p75] = heatmapThresholds(nonzero)

  let totalTokens = 0
  let activeDays = 0
  let peakTokens = 0
  let peakDate = ''
  let previousMonth = -1
  const weekList: HeatmapWeek[] = []

  for (let index = 0; index < weeks; index += 1) {
    const cells: HeatmapCell[] = []
    let monthLabel: string | null = null

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + index * 7 + dayIndex
      )
      const key = dateKeyOf(date)
      const future = key > endKey
      const item = byDate.get(key)
      const tokens = future ? 0 : item?.totalTokens ?? 0
      const messages = future ? 0 : item?.messageCount ?? 0

      if (dayIndex === 0 && date.getMonth() !== previousMonth) {
        previousMonth = date.getMonth()
        monthLabel = `${previousMonth + 1}月`
      }
      if (tokens > 0) {
        totalTokens += tokens
        activeDays += 1
        if (tokens > peakTokens) {
          peakTokens = tokens
          peakDate = key
        }
      }

      const level: HeatmapCell['level'] = tokens <= 0
        ? 0
        : tokens >= p75
          ? 4
          : tokens >= p50
            ? 3
            : tokens >= p25
              ? 2
              : 1

      cells.push({
        date: key,
        tokens,
        messages,
        level,
        future,
        clickable: !future && tokens > 0,
        title: future
          ? ''
          : tokens > 0
            ? `${key} · ${formatTokens(tokens)} tokens · ${messages} 条回复（点击查看当日会话）`
            : `${key} · 无记录`,
        ariaLabel: future
          ? ''
          : `${key}：${formatTokens(tokens)} tokens，${messages} 条回复`
      })
    }

    weekList.push({ key: keyOfWeekStart(start, index), monthLabel, cells })
  }

  const ariaLabel = peakDate === ''
    ? `近 ${weeks} 周每日用量热力图：还没有记录`
    : `近 ${weeks} 周每日用量热力图：${activeDays} 天有记录，最高 ${formatTokens(peakTokens)} tokens（${peakDate}）`

  return { weeks: weekList, totalTokens, activeDays, peakTokens, peakDate, ariaLabel }
}

/** 列 key 用列首日期，避免用下标而让 v-for 在范围变化时错误复用。 */
function keyOfWeekStart(start: Date, index: number): string {
  return dateKeyOf(
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index * 7)
  )
}
