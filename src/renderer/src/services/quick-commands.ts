/**
 * 封装快捷命令清单的读写，重建普通载荷并保留桥接失败原因。
 *
 * 只搬运已声明的字段：清单逐条重建，避免 Vue 响应式代理跨 contextBridge（会直接抛出
 * “An object could not be cloned.”）。桥接异常保留原始文本，便于定位真实原因。
 */
import type { PreferencesError } from '../../../shared/preferences-api'
import type { QuickCommand, QuickCommandsPreference, QuickCommandsResult } from '../../../shared/quick-commands-api'

/** 桥接缺失时的固定失败；读取与保存共用同一份错误结构。 */
function unavailable(): { readonly ok: false; readonly error: PreferencesError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { readonly ok: false; readonly error: PreferencesError } {
  const detail = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` } }
}

/** 读取快捷命令清单；失败时页面按空清单展示，不影响终端与会话。 */
export async function getQuickCommands(): Promise<QuickCommandsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getQuickCommands !== 'function') return unavailable()
  try {
    return await bridge.getQuickCommands()
  } catch (error) {
    return callFailed(error)
  }
}

/** 保存快捷命令清单；返回值是主进程规范化后的清单。 */
export async function setQuickCommands(commands: readonly QuickCommand[]): Promise<QuickCommandsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.setQuickCommands !== 'function') return unavailable()
  const payload: QuickCommandsPreference = {
    commands: commands.map((command): QuickCommand => ({
      id: command.id,
      label: command.label,
      command: command.command,
      appendEnter: command.appendEnter,
      scope: command.scope,
      projectPath: command.projectPath
    }))
  }
  try {
    return await bridge.setQuickCommands(payload)
  } catch (error) {
    return callFailed(error)
  }
}
