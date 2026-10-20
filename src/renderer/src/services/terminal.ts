/**
 * 作为渲染端终端操作的调用入口，把桥接缺失与通信异常转换为安全的展示结果。
 *
 * 只搬运声明字段：项目路径、终端标识、输入文本与行列数；shell、环境变量与工作目录都由主进程决定。
 * 数据确认不重试也不上报失败：它只释放主进程的背压额度，丢一次只影响后续下发的节奏。
 */
import type { TerminalError } from '../../../shared/terminal-api'
import type {
  TerminalCommandResult,
  TerminalCreateRequest,
  TerminalDaemonStatus,
  TerminalDaemonStatusResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeRequest,
  TerminalSessionResult,
  TerminalSessionsResult,
  TerminalSnapshotsResult,
  TerminalWriteRequest
} from '../../../shared/terminal-api'

/** 桥接缺失时的固定失败；三种结果类型共用同一份错误结构。 */
function unavailable(): { readonly ok: false; readonly error: TerminalError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown, action: string): { readonly ok: false; readonly error: TerminalError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `${action}失败：${detail}` }
  }
}

/** 在已添加的项目内新建终端；尺寸只是初始值，真实尺寸由终端视图测量后同步。 */
export async function createTerminal(request: TerminalCreateRequest): Promise<TerminalSessionResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.createTerminal !== 'function') return unavailable()
  try {
    return await bridge.createTerminal(request)
  } catch (error) {
    return callFailed(error, '创建终端')
  }
}

/** 把用户输入写入终端。 */
export async function writeTerminal(request: TerminalWriteRequest): Promise<TerminalCommandResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.writeTerminal !== 'function') return unavailable()
  try {
    return await bridge.writeTerminal(request)
  } catch (error) {
    return callFailed(error, '写入终端')
  }
}

/** 同步终端尺寸；尺寸变化会让全屏程序按新尺寸重排。 */
export async function resizeTerminal(request: TerminalResizeRequest): Promise<TerminalCommandResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.resizeTerminal !== 'function') return unavailable()
  try {
    return await bridge.resizeTerminal(request)
  } catch (error) {
    return callFailed(error, '调整终端尺寸')
  }
}

/** 关闭终端并收敛其进程树；关闭不存在的终端按已关闭处理。 */
export async function closeTerminal(id: string): Promise<TerminalCommandResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.closeTerminal !== 'function') return unavailable()
  try {
    return await bridge.closeTerminal({ id })
  } catch (error) {
    return callFailed(error, '关闭终端')
  }
}

/** 读取终端清单；项目路径为 null 时列全部。 */
export async function listTerminals(projectPath: string | null): Promise<TerminalSessionsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.listTerminals !== 'function') return unavailable()
  try {
    return await bridge.listTerminals({ projectPath })
  } catch (error) {
    return callFailed(error, '读取终端清单')
  }
}

/** 回报已消费的字符数；桥接缺失时静默跳过，主进程按在途上限自行收敛。 */
export function acknowledgeTerminalData(id: string, chars: number): void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.ackTerminalData !== 'function') return
  bridge.ackTerminalData({ id, chars })
}

/** 订阅终端输出与退出；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribeTerminalEvents(handlers: {
  readonly onData: (event: TerminalDataEvent) => void
  readonly onExit: (event: TerminalExitEvent) => void
}): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onTerminalData !== 'function' || typeof bridge.onTerminalExit !== 'function') {
    return () => {}
  }
  try {
    const stopData = bridge.onTerminalData(handlers.onData)
    const stopExit = bridge.onTerminalExit(handlers.onExit)
    return () => {
      stopData()
      stopExit()
    }
  } catch {
    return () => {}
  }
}

/** 读取全部终端的画面快照；页面重挂载后用它还原滚动历史。 */
export async function fetchTerminalSnapshots(): Promise<TerminalSnapshotsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.fetchTerminalSnapshots !== 'function') return unavailable()
  try {
    return await bridge.fetchTerminalSnapshots()
  } catch (error) {
    return callFailed(error, '读取终端快照')
  }
}

/** 关闭全部终端（含其他项目）；用于用户显式清理常驻会话。 */
export async function closeAllTerminals(): Promise<TerminalCommandResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.closeAllTerminals !== 'function') return unavailable()
  try {
    return await bridge.closeAllTerminals()
  } catch (error) {
    return callFailed(error, '关闭全部终端')
  }
}

/** 读取终端守护进程状态；桥接不可用时回一个「未连接」的结果，不把异常当断线。 */
export async function getTerminalDaemonStatus(): Promise<TerminalDaemonStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getTerminalDaemonStatus !== 'function') {
    return {
      ok: true,
      data: {
        connected: false,
        protocolVersion: null,
        pid: null,
        startedAt: null,
        sessionCount: 0,
        runningCount: 0,
        restoredCount: 0,
        stale: null
      }
    }
  }
  try {
    return await bridge.getTerminalDaemonStatus()
  } catch (error) {
    return callFailed(error, '读取终端守护进程状态')
  }
}

/** 结束协议版本不符的旧守护进程；只在用户显式操作时调用。 */
export async function stopStaleTerminalDaemon(): Promise<TerminalCommandResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.stopStaleTerminalDaemon !== 'function') return unavailable()
  try {
    return await bridge.stopStaleTerminalDaemon()
  } catch (error) {
    return callFailed(error, '结束旧终端守护进程')
  }
}

/** 订阅守护进程状态变化；桥接缺失时返回无操作的释放函数。 */
export function subscribeTerminalDaemonStatus(listener: (status: TerminalDaemonStatus) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onTerminalDaemonStatus !== 'function') return () => {}
  try {
    return bridge.onTerminalDaemonStatus(listener)
  } catch {
    return () => {}
  }
}
