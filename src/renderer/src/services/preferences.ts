/** 封装界面偏好、对话页模型展示偏好与快捷发送短语读写，重建普通载荷并保留桥接失败原因。 */
import type {
  ModelDisplayPreference,
  ModelDisplayResult,
  PreferencesError,
  PreferencesResult,
  QuickSendPreference,
  QuickSendResult,
  UiPreferences
} from '../../../shared/preferences-api'

function unavailable(): { ok: false; error: PreferencesError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: PreferencesError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取界面偏好；失败时界面按默认值展示。 */
export async function getPreferences(): Promise<PreferencesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getPreferences !== 'function') return unavailable()
  try {
    return await bridge.getPreferences()
  } catch (error) {
    return callFailed(error)
  }
}

/** 保存界面偏好；返回值是主进程确认后的状态。 */
export async function setUiPreferences(ui: UiPreferences): Promise<PreferencesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.setUiPreferences !== 'function') return unavailable()
  try {
    // 服务层重建普通对象，避免响应式代理跨 contextBridge，也只传递协议声明的字段。
    return await bridge.setUiPreferences({
      sidebarCollapsed: ui.sidebarCollapsed,
      theme: ui.theme,
      expandedProjects: [...ui.expandedProjects]
    })
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取对话页模型展示偏好；失败时不应用任何过滤。 */
export async function getModelDisplay(): Promise<ModelDisplayResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getModelDisplay !== 'function') return unavailable()
  try {
    return await bridge.getModelDisplay()
  } catch (error) {
    return callFailed(error)
  }
}

/** 保存对话页模型展示偏好；只搬运已声明的字段。 */
export async function setModelDisplay(preference: ModelDisplayPreference): Promise<ModelDisplayResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.setModelDisplay !== 'function') return unavailable()
  try {
    return await bridge.setModelDisplay({
      hiddenModels: preference.hiddenModels.map((model) => ({ provider: model.provider, modelId: model.modelId }))
    })
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取快捷发送短语；失败时页面回落到默认列表。 */
export async function getQuickSend(): Promise<QuickSendResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getQuickSend !== 'function') return unavailable()
  try {
    return await bridge.getQuickSend()
  } catch (error) {
    return callFailed(error)
  }
}

/** 保存快捷发送短语；返回值是主进程规范化后的列表。 */
export async function setQuickSend(preference: QuickSendPreference): Promise<QuickSendResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.setQuickSend !== 'function') return unavailable()
  try {
    // 服务层重建普通数组，避免响应式代理跨 contextBridge。
    return await bridge.setQuickSend({ messages: [...preference.messages] })
  } catch (error) {
    return callFailed(error)
  }
}
