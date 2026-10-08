/** 只定义界面偏好 IPC 的固定通道、结果类型与跨进程响应校验；窗口状态由主进程独占，不经过 IPC。 */
import type { DesktopErrorCode } from './desktop-api'

export const PREFERENCES_GET_CHANNEL = 'desktop:preferences-get'
export const PREFERENCES_SET_UI_CHANNEL = 'desktop:preferences-set-ui'

/** Desktop 自己的界面偏好；当前只有 Sidebar 折叠状态，主题等仍属后续任务，不复制 Pi settings。 */
export interface UiPreferences {
  readonly sidebarCollapsed: boolean
}

/** 偏好读写失败只影响界面偏好本身，界面已本地生效，不阻断其他操作。 */
export type PreferencesErrorCode = DesktopErrorCode

export interface PreferencesError {
  readonly code: PreferencesErrorCode
  readonly message: string
}

export type PreferencesResult =
  | { readonly ok: true; readonly data: UiPreferences }
  | { readonly ok: false; readonly error: PreferencesError }

export interface PreferencesApi {
  readonly getPreferences: () => Promise<PreferencesResult>
  /** 保存界面偏好；非法的请求由主进程重新校验并拒绝。 */
  readonly setUiPreferences: (ui: UiPreferences) => Promise<PreferencesResult>
}

// 与 desktop-api.ts 的共享错误码保持一致；界面偏好不再追加专有错误码。
const PREFERENCES_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUiPreferences(value: unknown): value is UiPreferences {
  if (!isRecord(value)) return false
  return typeof value.sidebarCollapsed === 'boolean'
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isPreferencesResult(value: unknown): value is PreferencesResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isUiPreferences(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && PREFERENCES_ERROR_CODES.includes(code)
}
