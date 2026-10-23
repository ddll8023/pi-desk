/** 作为渲染端会话列表、打开、重新加载与删除的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  SessionDeleteRequest,
  SessionDeleteResult,
  SessionError,
  SessionListRequest,
  SessionListResult,
  SessionOpenRequest,
  SessionOpenResult
} from '../../../../shared/session-api'

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

/** 读取指定项目的会话列表窗口；项目范围、会话归属与窗口上限都在主进程完成。 */
export async function listSessions(projectPath: string, limit: number): Promise<SessionListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.listSessions !== 'function') return unavailable()
  try {
    // 服务层重建普通对象，避免响应式代理跨 contextBridge。
    const request: SessionListRequest = { projectPath, limit }
    return await bridge.listSessions(request)
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * 打开会话；`sessionId` 为 null 表示新建。打开其他会话不中断任何正在运行的会话，
 * `allowInterrupt` 仅在用户已确认必须改变现有绑定时为真。
 * 新建会话的默认模型由 Pi 自己的 settings.json 决定，本服务不读取或传递模型覆盖。
 * `listLimit` 只决定回传列表的窗口大小：页面按自己已加载的深度提交，打开后不会把列表塌回首屏。
 */
export async function openSession(
  projectPath: string,
  sessionId: string | null,
  allowInterrupt: boolean,
  listLimit: number
): Promise<SessionOpenResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.openSession !== 'function') return unavailable()
  try {
    const request: SessionOpenRequest = { projectPath, sessionId, allowInterrupt, listLimit }
    return await bridge.openSession(request)
  } catch (error) {
    return callFailed(error)
  }
}

/** 重新加载 Pi 资源：在同一 SDK 宿主进程内重建该会话的 services，并尽量恢复当前会话；`allowInterrupt` 表示用户已确认可以中断，`listLimit` 与打开会话同义。 */
export async function reloadSession(allowInterrupt: boolean, listLimit: number): Promise<SessionOpenResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.reloadSession !== 'function') return unavailable()
  try {
    return await bridge.reloadSession(allowInterrupt, listLimit)
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * 删除会话：`projectPath` 是会话所属的已添加项目路径；占用收敛与文件删除都在主进程。
 * `allowInterrupt` 表示用户已确认可以中断该会话的在途操作；`listLimit` 是回传列表的窗口大小。
 * 成功时返回删除后的列表快照。
 */
export async function deleteSession(
  projectPath: string,
  sessionId: string,
  allowInterrupt: boolean,
  listLimit: number
): Promise<SessionDeleteResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.deleteSession !== 'function') return unavailable()
  try {
    // 服务层重建普通对象，避免响应式代理跨 contextBridge。
    const request: SessionDeleteRequest = { projectPath, sessionId, allowInterrupt, listLimit }
    return await bridge.deleteSession(request)
  } catch (error) {
    return callFailed(error)
  }
}

