/**
 * 渲染端用量统计服务：封装 window.desktop.getUsageStats 桥接调用，收敛未就绪与调用异常。
 */
import type { DesktopError } from '../../../../shared/desktop-api'
import type {
  UsageStatsSummaryRequest,
  UsageStatsSummaryResult
} from '../../../../shared/usage-stats-api'

function unavailable(): { ok: false; error: DesktopError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

function callFailed(error: unknown): { ok: false; error: DesktopError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `读取用量统计失败：${detail}` }
  }
}

export async function getUsageStats(request?: UsageStatsSummaryRequest): Promise<UsageStatsSummaryResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getUsageStats !== 'function') return unavailable()
  try {
    return await bridge.getUsageStats(request)
  } catch (error) {
    return callFailed(error)
  }
}
