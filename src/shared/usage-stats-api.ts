/**
 * 会话用量统计共享 API 契约：
 * 主进程只回传「meta + 会话明细数组」这一份单一数据源，每条会话携带按日、模型×日与子代理×日明细；
 * 概览、趋势、分布与会话列表等全部报表视图由渲染层按统一时间范围从明细派生。
 * 费用只采信供应商上报的价格，缺失时保持 null，不推算金额。
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

/** 会话内按日聚合条目（日期为本地时区键 YYYY-MM-DD） */
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

/** 会话内单个模型单日的用量条目；模型分布按时间范围筛选的唯一依据 */
export interface UsageModelDailyStat {
  readonly provider: string
  readonly modelId: string
  readonly date: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly messageCount: number
  /** 该模型该日已上报价格的调用合计；没有计价调用时为 null。 */
  readonly cost: number | null
}

/** 会话内单日的子代理用量：委派调用未记录模型归属，单独携带以支撑「未归属模型」行 */
export interface UsageSubAgentDailyStat {
  readonly date: string
  readonly input: number
  readonly output: number
  readonly totalTokens: number
}

/** 会话所属范畴：普通会话，或团队成员的会话（后者的用量单独归组）。 */
export type UsageSessionScope = 'session' | 'team-member'

/** 成员会话的归属：根会话与成员标识，用于把成员用量按团队归组。 */
export interface UsageTeamRef {
  readonly rootSessionId: string
  readonly memberExpertId: string
}

/** 单个会话的用量明细：渲染层所有报表视图的唯一数据来源 */
export interface UsageSessionStat {
  readonly sessionId: string
  readonly projectPath: string
  readonly projectName: string
  /** 普通会话为 `session`；团队成员会话为 `team-member`，后者同时带 `team`。 */
  readonly scope: UsageSessionScope
  /** 团队成员会话的根会话与成员标识；普通会话为 null。 */
  readonly team: UsageTeamRef | null
  readonly title: string
  readonly updatedAt: number
  /** 助手回复条数（子代理调用不计入） */
  readonly messageCount: number
  /** 会话 token 总计，含子代理开销 */
  readonly totals: UsageTokenBreakdown
  /** 已上报价格的调用合计；没有任何计价调用时为 null。 */
  readonly cost: number | null
  /** 已上报价格的助手消息数 */
  readonly costMessages: number
  readonly daily: readonly UsageDailyStat[]
  readonly modelDaily: readonly UsageModelDailyStat[]
  readonly subAgentDaily: readonly UsageSubAgentDailyStat[]
}

/** 完整统计汇总：只含会话明细与扫描时间，其余读数由渲染层派生 */
export interface UsageStatsSummary {
  readonly sessions: readonly UsageSessionStat[]
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

const isDateKey = (value: unknown): value is string => (
  typeof value === 'string' && (value === 'unknown' || /^\d{4}-\d{2}-\d{2}$/.test(value))
)

function isBreakdown(value: unknown): value is UsageTokenBreakdown {
  return isRecord(value)
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
}

function isDailyStat(value: unknown): value is UsageDailyStat {
  return isRecord(value)
    && isDateKey(value.date)
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
    && isNonNegativeInteger(value.messageCount)
    && isNullableCost(value.cost)
}

function isModelDailyStat(value: unknown): value is UsageModelDailyStat {
  return isRecord(value)
    && typeof value.provider === 'string'
    && typeof value.modelId === 'string'
    && isDateKey(value.date)
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.cacheRead)
    && isNonNegativeInteger(value.cacheWrite)
    && isNonNegativeInteger(value.totalTokens)
    && isNonNegativeInteger(value.messageCount)
    && isNullableCost(value.cost)
}

function isSubAgentDailyStat(value: unknown): value is UsageSubAgentDailyStat {
  return isRecord(value)
    && isDateKey(value.date)
    && isNonNegativeInteger(value.input)
    && isNonNegativeInteger(value.output)
    && isNonNegativeInteger(value.totalTokens)
}

function isSessionStat(value: unknown): value is UsageSessionStat {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && typeof value.projectPath === 'string'
    && typeof value.projectName === 'string'
    && (value.scope === 'session' || value.scope === 'team-member')
    && (value.team === null || (isRecord(value.team)
      && typeof value.team.rootSessionId === 'string'
      && typeof value.team.memberExpertId === 'string'))
    && typeof value.title === 'string'
    && isFiniteNumber(value.updatedAt)
    && isNonNegativeInteger(value.messageCount)
    && isBreakdown(value.totals)
    && isNullableCost(value.cost)
    && isNonNegativeInteger(value.costMessages)
    && Array.isArray(value.daily) && value.daily.every(isDailyStat)
    && Array.isArray(value.modelDaily) && value.modelDaily.every(isModelDailyStat)
    && Array.isArray(value.subAgentDaily) && value.subAgentDaily.every(isSubAgentDailyStat)
}

function isSummary(value: unknown): value is UsageStatsSummary {
  return isRecord(value)
    && Array.isArray(value.sessions) && value.sessions.every(isSessionStat)
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
