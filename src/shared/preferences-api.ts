/** 定义界面偏好与对话页模型展示偏好的受限 IPC；窗口状态由主进程独占，不经过 IPC。 */
import type { DesktopErrorCode } from './desktop-api'
import type { ModelIdentity } from './runtime-api'
import { isModelIdentity } from './runtime-api'

export const PREFERENCES_GET_CHANNEL = 'desktop:preferences-get'
export const PREFERENCES_SET_UI_CHANNEL = 'desktop:preferences-set-ui'
export const PREFERENCES_GET_MODEL_DISPLAY_CHANNEL = 'desktop:preferences-get-model-display'
export const PREFERENCES_SET_MODEL_DISPLAY_CHANNEL = 'desktop:preferences-set-model-display'

/** 主题三档取值，与 Electron `nativeTheme.themeSource` 状态机一一对应；默认跟随系统。 */
export type UiTheme = 'system' | 'light' | 'dark'

const UI_THEMES: readonly UiTheme[] = ['system', 'light', 'dark']

export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && UI_THEMES.includes(value as UiTheme)
}

/** Desktop 自己的界面偏好；不复制 Pi settings，也不保存单个消息块的临时开合状态。 */
export interface UiPreferences {
  readonly sidebarCollapsed: boolean
  readonly theme: UiTheme
}

/** 复用桌面错误码；界面偏好本地先生效，模型展示偏好保存成功后才提交。 */
export type PreferencesErrorCode = DesktopErrorCode

export interface PreferencesError {
  readonly code: PreferencesErrorCode
  readonly message: string
}

export type PreferencesResult =
  | { readonly ok: true; readonly data: UiPreferences }
  | { readonly ok: false; readonly error: PreferencesError }

/** 对话页模型切换器的展示偏好：要隐藏的模型；为空表示全部显示。 */
export interface ModelDisplayPreference {
  readonly hiddenModels: readonly ModelIdentity[]
}

export type ModelDisplayResult =
  | { readonly ok: true; readonly data: ModelDisplayPreference }
  | { readonly ok: false; readonly error: PreferencesError }

export interface PreferencesApi {
  /** 读取对话页模型展示偏好；隐藏列表为空表示全部显示，不读取或修改 Pi 配置。 */
  readonly getModelDisplay: () => Promise<ModelDisplayResult>
  /** 保存对话页模型展示偏好；返回主进程确认后的结果，不修改 Pi 配置。 */
  readonly setModelDisplay: (preference: ModelDisplayPreference) => Promise<ModelDisplayResult>
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
    && isUiTheme(value.theme)
}

/** 隐藏模型的数量上限；只用于展示过滤，与模型身份的边界保持一致。 */
const MAX_HIDDEN_MODELS = 4096

/** 逐项复用模型身份校验，并拒绝多余字段；去重与截断由主进程存储层完成。 */
export function isModelDisplayPreference(value: unknown): value is ModelDisplayPreference {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'hiddenModels')) return false
  return Array.isArray(value.hiddenModels)
    && value.hiddenModels.length <= MAX_HIDDEN_MODELS
    && value.hiddenModels.every((model) => isModelIdentity(model))
}

/** 与模型偏好同一形状：成功返回已确认的展示偏好，失败保留主进程错误。 */
export function isModelDisplayResult(value: unknown): value is ModelDisplayResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isModelDisplayPreference(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
    && PREFERENCES_ERROR_CODES.includes(value.error.code)
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
