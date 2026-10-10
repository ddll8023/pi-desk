/** 作为渲染端会话列表、打开与重新加载的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type { SessionError, SessionListResult, SessionOpenResult } from '../../../shared/session-api'

function unavailable(): { ok: false; error: SessionError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: SessionError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取当前项目的会话列表；会话归属与文件解析都在主进程完成。 */
export async function listSessions(): Promise<SessionListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.listSessions !== 'function') return unavailable()
  try {
    return await bridge.listSessions()
  } catch (error) {
    return callFailed(error)
  }
}

/** 打开会话；`sessionId` 为 null 表示新建，`allowInterrupt` 表示用户已确认可以停止运行中的操作。 */
export async function openSession(
  sessionId: string | null,
  allowInterrupt: boolean
): Promise<SessionOpenResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.openSession !== 'function') return unavailable()
  try {
    return await bridge.openSession(sessionId, allowInterrupt)
  } catch (error) {
    return callFailed(error)
  }
}

/** 重新加载 Pi 资源：重启 Runtime 并尽量恢复当前会话；`allowInterrupt` 表示用户已确认可以中断。 */
export async function reloadSession(allowInterrupt: boolean): Promise<SessionOpenResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.reloadSession !== 'function') return unavailable()
  try {
    return await bridge.reloadSession(allowInterrupt)
  } catch (error) {
    return callFailed(error)
  }
}

