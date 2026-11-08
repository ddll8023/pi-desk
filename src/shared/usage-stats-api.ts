/**
 * 会话用量统计共享 API 契约：
 * 定义跨项目与跨会话的 token 与费用统计摘要、按日趋势、模型与项目分布、Top 会话的 IPC 通道及类型校验。
 */
import type { DesktopError } from './desktop-api'

export const USAGE_STATS_SUMMARY_CHANNEL = 'desktop:usage-stats-summary'

/** Token 四项基本分项与总计 */
export interface UsageTokenBreakdown {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
}

/** 单个模型的累计用量条目 */
export interface UsageModelStat {
  readonly provider: string
  readonly modelId: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly messageCount: number
  /** 该模型已上报价格的调用合计；没有任何计价调用时为 null，不用 0 冒充。 */
  readonly cost: number | null
}

/** 单个已登记项目的累计用量条目 */
export interface UsageProjectStat {
  readonly projectPath: string
  readonly projectName: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly sessionCount: number
  /** 该项目内已上报价格的会话合计；没有任何计价会话时为 null。 */
  readonly cost: number | null
}

/** 按日聚合的用量趋势条目（以会话消息本地日期 YYYY-MM-DD 为键，覆盖全部有记录日期） */
export interface UsageDailyStat {
  readonly date: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly messageCount: number
  /** 该日已上报价格的调用合计；当天没有计价调用时为 null。 */
  readonly cost: number | null
}

/** 单个高用量会话的摘要条目 */
export interface UsageTopSession {
  readonly projectPath: string
  readonly projectName: string
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly messageCount: number
  /** 该会话已上报价格的调用合计；没有任何计价调用时为 null。 */
  readonly cost: number | null
}

/** 完整统计汇总数据 */
export interface UsageStatsSummary {
  /** 纳入统计的会话总数 */
  readonly totalSessions: number
  /** 纳入统计的助手消息总数 */
  readonly totalMessages: number
  /** 已上报价格的助手消息数；用来说明费用统计的覆盖范围。 */
  readonly costMessages: number
  /** 总 token 分项 */
  readonly totals: UsageTokenBreakdown
  /**
   * 官方上报的累计费用；没有任何计价消息时保持 null 表示未提供，
   * 有计价消息则如实给出合计（全免费模型显示 0.000，而不是“未提供”）。
   */
  readonly totalCost: number | null
  /** 模型分布列表（按总 token 降序） */
  readonly models: readonly UsageModelStat[]
  /** 项目分布列表（按总 token 降序） */
  readonly projects: readonly UsageProjectStat[]
  /** 日期趋势（按日期升序，近 30 天或有数据的全部天数） */
  readonly daily: readonly UsageDailyStat[]
  /** 消耗最高的会话明细（按总 token 降序，至多 50 条） */
  readonly topSessions: readonly UsageTopSession[]
  /** 索引扫描时间戳 */
  readonly scannedAt: number
}

/** 查询请求；`refresh` 为 true 时跳过文件戳缓存强制重新扫描 */
export interface UsageStatsSummaryRequest {
  readonly refresh?: boolean
}

export type UsageStatsSummaryResult =
  | { readonly ok: true; readonly summary: UsageStatsSummary }
  | { readonly ok: false; readonly error: DesktopError }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonNegativeInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
)

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
)

/** 费用字段：null 表示未提供价格，其余必须是非负有限数。 */
const isNullableCost = (value: unknown): value is number | null => (
  value === null || (isFiniteNumber(value) && value >= 0)
)

function isBreakdown(value: unknown): value is UsageTokenBreakdown {
  return isRecord(value)
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
}

function isModelStat(value: unknown): value is UsageModelStat {
  return isRecord(value)
    && typeof value.provider === 'string'
    && typeof value.modelId === 'string'
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
    && isNonNegativeInteger(value.messageCount)
    && isNullableCost(value.cost)
}

function isProjectStat(value: unknown): value is UsageProjectStat {
  return isRecord(value)
    && typeof value.projectPath === 'string'
    && typeof value.projectName === 'string'
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
    && isNonNegativeInteger(value.sessionCount)
    && isNullableCost(value.cost)
}

function isDailyStat(value: unknown): value is UsageDailyStat {
  return isRecord(value)
    && typeof value.date === 'string'
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
    && isNonNegativeInteger(value.messageCount)
    && isNullableCost(value.cost)
}

function isTopSession(value: unknown): value is UsageTopSession {
  return isRecord(value)
    && typeof value.projectPath === 'string'
    && typeof value.projectName === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.title === 'string'
    && isFiniteNumber(value.updatedAt)
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
    && isNonNegativeInteger(value.messageCount)
    && isNullableCost(value.cost)
}

function isSummary(value: unknown): value is UsageStatsSummary {
  return isRecord(value)
    && isNonNegativeInteger(value.totalSessions)
    && isNonNegativeInteger(value.totalMessages)
    && isNonNegativeInteger(value.costMessages)
    && isBreakdown(value.totals)
    && (value.totalCost === null || (isFiniteNumber(value.totalCost) && value.totalCost >= 0))
    && Array.isArray(value.models) && value.models.every(isModelStat)
    && Array.isArray(value.projects) && value.projects.every(isProjectStat)
    && Array.isArray(value.daily) && value.daily.every(isDailyStat)
    && Array.isArray(value.topSessions) && value.topSessions.every(isTopSession)
    && isFiniteNumber(value.scannedAt)
}

function hasFailure(value: Record<string, unknown>): boolean {
  return value.ok === false && isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
}

export function isUsageStatsSummaryRequest(value: unknown): value is UsageStatsSummaryRequest {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return value.refresh === undefined || typeof value.refresh === 'boolean'
}

export function isUsageStatsSummaryResult(value: unknown): value is UsageStatsSummaryResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return hasFailure(value)
  return value.ok === true && isSummary(value.summary)
}

export interface UsageStatsApi {
  getUsageStats(request?: UsageStatsSummaryRequest): Promise<UsageStatsSummaryResult>
}
