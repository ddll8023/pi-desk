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

/** 读取当前项目的信任状态与探测到的受保护资源。 */
export async function getTrustStatus(): Promise<TrustStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getTrustStatus !== 'function') return unavailable()
  try {
    return await bridge.getTrustStatus()
  } catch (error) {
    return callFailed(error)
  }
}

/** 保存、更新或清除（`unset`）当前项目的信任决定；只接受当前项目。 */
export async function decideTrust(
  projectPath: string,
  decision: TrustDecisionInput
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
    return await bridge.decideTrust(projectPath, decision)
  } catch (error) {
    return callFailed(error)
  }
}
