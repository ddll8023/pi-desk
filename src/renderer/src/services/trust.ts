/** 作为渲染端 Project Trust 的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  TrustDecisionInput,
  TrustDecisionResult,
  TrustStatusResult
} from '../../../shared/trust-api'

function unavailable(): TrustStatusResult {
  return {
    ok: false,
    error: {
      code: 'BRIDGE_UNAVAILABLE',
      message: '桌面桥接不可用，请通过 Electron 打开此页面。'
    }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): TrustStatusResult {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取信任状态与探测到的受保护资源；`runId` 给定时读该运行实例的归属项目。 */
export async function getTrustStatus(runId?: number): Promise<TrustStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getTrustStatus !== 'function') return unavailable()
  try {
    return await bridge.getTrustStatus(runId)
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * 保存、更新或清除（`unset`）信任决定；只接受当前项目或已登记运行实例的归属项目。
 * `runId` 把决定绑定到来源会话的项目，重载其他项目的会话时不必先切换前台项目。
 */
export async function decideTrust(
  projectPath: string,
  decision: TrustDecisionInput,
  runId?: number
): Promise<TrustDecisionResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.decideTrust !== 'function') {
    return {
      ok: false,
      error: {
        code: 'BRIDGE_UNAVAILABLE',
        message: '桌面桥接不可用，请通过 Electron 打开此页面。'
      }
    }
  }
  try {
    return await bridge.decideTrust(projectPath, decision, runId)
  } catch (error) {
    return callFailed(error)
  }
}
