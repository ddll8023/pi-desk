/** 作为渲染端会话运行状态查询、订阅、释放与结束的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  SessionRunReleaseResult,
  SessionRunsResult,
  SessionRunsSnapshot
} from '../../../../shared/session-run-api'

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

/**
 * 释放一个未确认退出或宿主已失败的运行实例；只传运行实例身份。
 * 失败原因原样保留：释放未确认时占用仍被保留，页面必须看到真实原因。
 */
export async function releaseSessionRun(runId: number): Promise<SessionRunReleaseResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.releaseSessionRun !== 'function') {
    return {
      ok: false,
      error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
    }
  }
  try {
    return await bridge.releaseSessionRun({ runId })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'BRIDGE_CALL_FAILED', message: `释放运行实例失败：${detail}` }
    }
  }
}

/**
 * 结束一个运行实例：中断在途工作、解除占用并关闭它的宿主进程，保留会话历史文件。
 * 失败原因原样保留：关闭未确认时占用仍被保留，页面必须看到真实原因。
 */
export async function closeSessionRun(runId: number): Promise<SessionRunReleaseResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.closeSessionRun !== 'function') {
    return {
      ok: false,
      error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
    }
  }
  try {
    return await bridge.closeSessionRun({ runId })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'BRIDGE_CALL_FAILED', message: `结束运行实例失败：${detail}` }
    }
  }
}
