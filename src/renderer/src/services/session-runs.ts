/** 作为渲染端会话运行状态查询与订阅的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type { SessionRunsResult, SessionRunsSnapshot } from '../../../shared/session-run-api'

function unavailable(): SessionRunsResult {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): SessionRunsResult {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `读取会话运行状态失败：${detail}` }
  }
}

/** 读取应用内全部运行实例的粗粒度状态；零参数，不建立宿主。 */
export async function getSessionRuns(): Promise<SessionRunsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getSessionRuns !== 'function') return unavailable()
  try {
    return await bridge.getSessionRuns()
  } catch (error) {
    return callFailed(error)
  }
}

/** 订阅运行状态变化；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribeSessionRuns(listener: (snapshot: SessionRunsSnapshot) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onSessionRunsChanged !== 'function') return () => {}
  try {
    return bridge.onSessionRunsChanged(listener)
  } catch {
    return () => {}
  }
}
