/**
 * Pi 默认模型（Pi 的 `<agent-dir>/settings.json` 的 `defaultProvider`/`defaultModel`）的受限 IPC 契约：
 * 只定义固定通道、结果形状、长度边界与跨进程响应校验，不含任何凭据内容。
 *
 * 边界：桌面端只读写这两个键，settings.json 的其他键（主题、包声明、思考等级等）一律原样保留；
 * 具体文件读写与并发防护在主进程的 `PiSettingsManager`，本契约只描述页面能看到的结果。
 */
import type { DesktopErrorCode } from './desktop-api'
import type { ModelIdentity } from './runtime-api'
import { isModelIdentity } from './runtime-api'

/** 零参数：读取 Pi 的默认模型；settings.json 没有设置时为 null。 */
export const PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL = 'desktop:pi-settings-get-default-model'
/** 只接受 `{ provider, modelId }`：写入 Pi 的默认模型。 */
export const PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL = 'desktop:pi-settings-set-default-model'

/** 复用桌面错误码；写失败时保留主进程给出的原因文本。 */
export type PiDefaultModelErrorCode = DesktopErrorCode

export interface PiDefaultModelError {
  readonly code: PiDefaultModelErrorCode
  readonly message: string
}

/** 默认模型读取结果；null 表示 settings.json 未设置这两个键。 */
export type PiDefaultModelResult =
  | { readonly ok: true; readonly data: ModelIdentity | null }
  | { readonly ok: false; readonly error: PiDefaultModelError }

export interface PiSettingsApi {
  /** 读取 Pi 的默认模型；不启动 Runtime，也不修改任何文件。 */
  readonly getPiDefaultModel: () => Promise<PiDefaultModelResult>
  /** 写入 Pi 的默认模型；settings.json 的其他键原样保留。 */
  readonly setPiDefaultModel: (model: ModelIdentity) => Promise<PiDefaultModelResult>
}

// 与 desktop-api.ts 的共享错误码保持一致；本契约不追加专有错误码。
const PI_DEFAULT_MODEL_ERROR_CODES: readonly string[] = [
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

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isPiDefaultModelResult(value: unknown): value is PiDefaultModelResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return value.data === null || isModelIdentity(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && PI_DEFAULT_MODEL_ERROR_CODES.includes(code)
}

/** 写请求校验：只接受模型身份本身，拒绝多余字段。 */
export function isPiDefaultModelSetRequest(value: unknown): value is ModelIdentity {
  return isModelIdentity(value)
}
