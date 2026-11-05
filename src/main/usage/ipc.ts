/**
 * 会话用量统计的 IPC 通道注册：
 * 只接受唯一可信页面调用，参数逐一校验，业务动作全部交给 UsageStatsService。
 */
import type { DesktopError } from '../../shared/desktop-api'
import {
  USAGE_STATS_SUMMARY_CHANNEL,
  isUsageStatsSummaryRequest
} from '../../shared/usage-stats-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { usageStatsService } from '../services'

type Failure = { readonly ok: false; readonly error: DesktopError }

function forbidden(): Failure {
  return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
}

function invalid(): Failure {
  return { ok: false, error: { code: 'INVALID_REQUEST', message: '统计请求参数不合法。' } }
}

export function registerUsageStatsHandlers(pageUrl: string): void {
  handle(USAGE_STATS_SUMMARY_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length > 1 || !isUsageStatsSummaryRequest(request)) return invalid()
    return usageStatsService.getSummary(request?.refresh ?? false)
  })
}
