/** 作为渲染端版本检查、扩展更新与内置 Pi agent 安装的读取、重查、执行与订阅入口，
 * 把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  AgentInstallProgress,
  AgentInstallResult,
  PackageUpdateProgress,
  PackageUpdateResult,
  UpdatesError,
  UpdatesResult,
  UpdatesSnapshot
} from '../../../shared/updates-api'

/** 桥接不可用时的失败载荷；检查与更新两种结果共用同一份错误形状。 */
function unavailableError(): UpdatesError {
  return {
    code: 'BRIDGE_UNAVAILABLE',
    message: '桌面桥接不可用，请通过 Electron 打开此页面。'
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailedError(error: unknown): UpdatesError {
  const detail = error instanceof Error ? error.message : String(error)
  return { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
}

/** 读取最近一次检查的快照；不触发新的检查。 */
export async function getUpdates(): Promise<UpdatesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getUpdates !== 'function') return { ok: false, error: unavailableError() }
  try {
    return await bridge.getUpdates()
  } catch (error) {
    return { ok: false, error: callFailedError(error) }
  }
}

/** 重新检查一次；进行中时主进程会复用同一次检查。 */
export async function checkUpdates(): Promise<UpdatesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.checkUpdates !== 'function') return { ok: false, error: unavailableError() }
  try {
    return await bridge.checkUpdates()
  } catch (error) {
    return { ok: false, error: callFailedError(error) }
  }
}

/** 订阅检查状态；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribeUpdates(listener: (snapshot: UpdatesSnapshot) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onUpdatesChanged !== 'function') return () => {}
  try {
    return bridge.onUpdatesChanged(listener)
  } catch {
    return () => {}
  }
}

/** 执行一次扩展更新；省略来源时更新全部已声明的包。 */
export async function updatePackages(source?: string): Promise<PackageUpdateResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.updatePackages !== 'function') return { ok: false, error: unavailableError() }
  try {
    return await bridge.updatePackages(source)
  } catch (error) {
    return { ok: false, error: callFailedError(error) }
  }
}

/** 订阅更新进度；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribePackageUpdateProgress(listener: (progress: PackageUpdateProgress) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onPackageUpdateProgress !== 'function') return () => {}
  try {
    return bridge.onPackageUpdateProgress(listener)
  } catch {
    return () => {}
  }
}

/** 安装或切换内置 Pi agent 的运行时版本；省略版本时取官方最新。 */
export async function installAgentRuntime(version?: string): Promise<AgentInstallResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.installAgentRuntime !== 'function') return { ok: false, error: unavailableError() }
  try {
    return await bridge.installAgentRuntime(version)
  } catch (error) {
    return { ok: false, error: callFailedError(error) }
  }
}

/** 订阅内置 Pi agent 安装进度；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribeAgentInstallProgress(listener: (progress: AgentInstallProgress) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onAgentInstallProgress !== 'function') return () => {}
  try {
    return bridge.onAgentInstallProgress(listener)
  } catch {
    return () => {}
  }
}
