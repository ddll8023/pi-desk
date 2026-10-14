/** 作为渲染端版本检查的读取、重查与订阅入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type { UpdatesResult, UpdatesSnapshot } from '../../../shared/updates-api'

function unavailable(): UpdatesResult {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): UpdatesResult {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取最近一次检查的快照；不触发新的检查。 */
export async function getUpdates(): Promise<UpdatesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getUpdates !== 'function') return unavailable()
  try {
    return await bridge.getUpdates()
  } catch (error) {
    return callFailed(error)
  }
}

/** 重新检查一次；进行中时主进程会复用同一次检查。 */
export async function checkUpdates(): Promise<UpdatesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.checkUpdates !== 'function') return unavailable()
  try {
    return await bridge.checkUpdates()
  } catch (error) {
    return callFailed(error)
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
