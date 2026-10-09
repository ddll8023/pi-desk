/** 作为渲染端会话列表与打开、分叉消息读取与分叉发起的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  ForkMessageListResult,
  ForkStartResult,
  SessionError,
  SessionListResult,
  SessionOpenResult
} from '../../../shared/session-api'

function unavailable(): { ok: false; error: SessionError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

function callFailed(): { ok: false; error: SessionError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: '桌面桥接调用失败，可以重试。' }
  }
}

/** 读取当前项目的会话列表；会话归属与文件解析都在主进程完成。 */
export async function listSessions(): Promise<SessionListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.listSessions !== 'function') return unavailable()
  try {
    return await bridge.listSessions()
  } catch {
    return callFailed()
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
  } catch {
    return callFailed()
  }
}

/** 读取当前 Runtime 会话里可分叉的用户消息；要求 Runtime 就绪。 */
export async function getForkMessages(): Promise<ForkMessageListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getForkMessages !== 'function') return unavailable()
  try {
    return await bridge.getForkMessages()
  } catch {
    return callFailed()
  }
}

/** 从指定条目分叉；成功后主进程重启式切换到新会话并返回刷新后的列表。 */
export async function startFork(entryId: string, allowInterrupt: boolean): Promise<ForkStartResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.startFork !== 'function') return unavailable()
  try {
    return await bridge.startFork(entryId, allowInterrupt)
  } catch {
    return callFailed()
  }
}
