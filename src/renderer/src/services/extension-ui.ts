/** 作为渲染端 Extension UI 状态读取、dialog 响应提交与快照订阅的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  ExtensionDialogResponseInput,
  ExtensionUiResult,
  ExtensionUiSnapshot
} from '../../../shared/extension-ui-api'

function unavailable(): ExtensionUiResult {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

function callFailed(): ExtensionUiResult {
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: '桌面桥接调用失败，可以重试。' }
  }
}

/** 取得 Extension UI 状态快照；无活动 Runtime 时状态为空。 */
export async function getExtensionUiState(): Promise<ExtensionUiResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getExtensionUiState !== 'function') return unavailable()
  try {
    return await bridge.getExtensionUiState()
  } catch {
    return callFailed()
  }
}

/** 提交 Extension dialog 响应；id 不存在或已结束时按错误结果返回。 */
export async function respondExtensionDialog(
  dialogId: string,
  response: ExtensionDialogResponseInput
): Promise<ExtensionUiResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.respondExtensionDialog !== 'function') return unavailable()
  try {
    return await bridge.respondExtensionDialog(dialogId, response)
  } catch {
    return callFailed()
  }
}

/** 订阅 Extension UI 快照；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribeExtensionUi(listener: (snapshot: ExtensionUiSnapshot) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onExtensionUiChanged !== 'function') return () => {}
  try {
    return bridge.onExtensionUiChanged(listener)
  } catch {
    return () => {}
  }
}
