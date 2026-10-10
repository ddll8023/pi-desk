/** 作为渲染端界面偏好读取与保存的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type { PreferencesError, PreferencesResult, UiPreferences } from '../../../shared/preferences-api'

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
      thinkingDefaultExpanded: ui.thinkingDefaultExpanded
    })
  } catch (error) {
    return callFailed(error)
  }
}
