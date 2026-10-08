/** 只定义当前应用信息 IPC 与跨域共享错误码族的固定通道、结果类型与跨进程响应校验。 */
export const APP_INFO_CHANNEL = 'desktop:get-app-info'

export interface DesktopAppInfo {
  readonly appVersion: string
  readonly electronVersion: string
  readonly platform: string
  readonly arch: string
}

export type DesktopErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | 'INVALID_RESPONSE'
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_CALL_FAILED'
  /** 项目存在受保护资源且尚无信任决定；先完成信任决定再重试。 */
  | 'TRUST_REQUIRED'

export interface DesktopError {
  readonly code: DesktopErrorCode
  readonly message: string
}

export type AppInfoResult =
  | { readonly ok: true; readonly data: DesktopAppInfo }
  | { readonly ok: false; readonly error: DesktopError }

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfoResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isAppInfoResult(value: unknown): value is AppInfoResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && typeof data.appVersion === 'string'
      && typeof data.electronVersion === 'string'
      && typeof data.platform === 'string'
      && typeof data.arch === 'string'
  }

  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && (code === 'FORBIDDEN'
      || code === 'INVALID_REQUEST'
      || code === 'INTERNAL_ERROR'
      || code === 'INVALID_RESPONSE'
      || code === 'BRIDGE_UNAVAILABLE'
      || code === 'BRIDGE_CALL_FAILED'
      || code === 'TRUST_REQUIRED')
}
