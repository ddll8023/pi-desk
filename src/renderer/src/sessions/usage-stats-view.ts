/**
 * 用量统计视图的纯函数与展示格式化：
 * 提供图表柱高归一化、缓存命中率计算、占比计算及日期时间显示，供用量统计分节组件复用。
 */
import type { UsageDailyStat } from '../../../../shared/usage-stats-api'
import { cacheHitRate, formatTokens } from './usage-format'

export { cacheHitRate, formatTokens }

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

/** 柱状图条目数据结构 */
export interface DailyBarItem {
  readonly date: string
  readonly label: string
  readonly totalTokens: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly heightPercent: number
  /** 是否渲染 X 轴日期标签：近 30 根柱全量标注会互相重叠，只标注首末与等距的少数几根。 */
  readonly showLabel: boolean
  readonly tooltip: string
}

/**
 * 将日度趋势数组归一化为柱状图高度百分比；默认至多展示近 30 个有记录的日期，
 * 避免无限撑宽横向容器。
 */
export function buildDailyBars(daily: readonly UsageDailyStat[], maxBars = 30): readonly DailyBarItem[] {
  if (daily.length === 0) return []
  const sliced = daily.length > maxBars ? daily.slice(daily.length - maxBars) : daily
  const maxTokens = Math.max(1, ...sliced.map(item => item.totalTokens))
  const lastIndex = sliced.length - 1
  // 标签间隔按「最多约 7 个标签」反推；末位附近不足一个间隔时让位给末位，避免最后两个标签贴在一起。
  const labelStep = Math.max(1, Math.ceil(sliced.length / 7))

  return sliced.map((item, index) => {
    const ratio = Math.max(0.04, item.totalTokens / maxTokens)
    const heightPercent = Math.min(100, Math.round(ratio * 100))
    const tooltip = `${item.date}：总计 ${formatTokens(item.totalTokens)} (输入 ${formatTokens(item.input)}, 输出 ${formatTokens(item.output)}, 缓存读 ${formatTokens(item.cacheRead)})`
    return {
      date: item.date,
      label: formatShortDate(item.date),
      totalTokens: item.totalTokens,
      input: item.input,
      output: item.output,
      cacheRead: item.cacheRead,
      heightPercent,
      showLabel:
        index === 0 ||
        index === lastIndex ||
        (index % labelStep === 0 && lastIndex - index >= labelStep),
      tooltip
    }
  })
}
