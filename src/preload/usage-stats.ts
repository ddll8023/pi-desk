/**
 * 会话用量统计：preload 的 usage-stats 域，只经固定 channel 与主进程通信，载荷与响应在此校验。
 */
import { ipcRenderer } from 'electron'
import {
  USAGE_STATS_SUMMARY_CHANNEL,
  isUsageStatsSummaryResult
} from '../shared/usage-stats-api'
import type {
  UsageStatsApi,
  UsageStatsSummaryRequest,
  UsageStatsSummaryResult
} from '../shared/usage-stats-api'

const INVALID_RESPONSE_MESSAGE = '桌面接口返回了无法识别的用量统计结果。'

function invalidResponse<T>(): T {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RESPONSE_MESSAGE } } as T
}

export const usageStatsApi: UsageStatsApi = {
  async getUsageStats(request?: UsageStatsSummaryRequest): Promise<UsageStatsSummaryResult> {
    const payload = request?.refresh !== undefined ? { refresh: request.refresh } : undefined
    const response: unknown = await ipcRenderer.invoke(USAGE_STATS_SUMMARY_CHANNEL, payload)
    return isUsageStatsSummaryResult(response) ? response : invalidResponse<UsageStatsSummaryResult>()
  }
}
