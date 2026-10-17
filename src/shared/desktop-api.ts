/** 只定义当前应用信息、受控外链打开 IPC 与跨域共享错误码族的固定通道、结果类型与跨进程响应校验。 */
export const APP_INFO_CHANNEL = 'desktop:get-app-info'
/** 用系统浏览器打开外部链接；页面只能提交 http(s) 地址，其余协议由主进程拒绝。 */
export const OPEN_EXTERNAL_URL_CHANNEL = 'desktop:open-external-url'

/** 外链地址长度上限；主进程与本契约共用这一个常量，超出直接拒绝。 */
export const OPEN_EXTERNAL_URL_MAX_CHARS = 2_048

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
  /** 写入前发现磁盘文件已被外部改动；由界面提示用户继续编辑或覆盖保存。 */
  | 'CONFLICT'
  /** 目标目录不是 Git 仓库（或仓库根无法确定）；界面据此显示空态，不当作故障。 */
  | 'NOT_A_REPOSITORY'
  /** 系统里没有可用的 git，或它无法执行。 */
  | 'GIT_UNAVAILABLE'
  /** git 命令失败（退出码非零、超时或被中止）；message 是可展示的原因。 */
  | 'GIT_FAILED'

export interface DesktopError {
  readonly code: DesktopErrorCode
  readonly message: string
}

export type AppInfoResult =
  | { readonly ok: true; readonly data: DesktopAppInfo }
  | { readonly ok: false; readonly error: DesktopError }

export interface DesktopApi {
  readonly getAppInfo: () => Promise<AppInfoResult>
  /** 请主进程用系统浏览器打开一个 http(s) 地址；只接受地址，不接受其他参数。 */
  readonly openExternalUrl: (request: OpenExternalUrlRequest) => Promise<OpenExternalUrlResult>
}

/** 外链打开请求；只有 `url` 一个字段。 */
export interface OpenExternalUrlRequest {
  readonly url: string
}

/** 外链打开结果：成功不回传数据，失败带可展示的原因。 */
export type OpenExternalUrlResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: DesktopError }

/** 请求校验：只接受 `url` 一个字段，长度受上限约束；协议与凭据检查在主进程完成。 */
export function isOpenExternalUrlRequest(value: unknown): value is OpenExternalUrlRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'url')) return false
  return typeof value.url === 'string'
    && value.url.length > 0
    && value.url.length <= OPEN_EXTERNAL_URL_MAX_CHARS
}

/** 结果校验：成功没有数据，失败沿用同一份错误结构。 */
export function isOpenExternalUrlResult(value: unknown): value is OpenExternalUrlResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return true
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
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
      || code === 'TRUST_REQUIRED'
      || code === 'CONFLICT')
}
