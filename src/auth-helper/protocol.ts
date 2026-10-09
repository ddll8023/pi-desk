/**
 * 认证辅助进程与主进程之间的 JSONL 帧定义与形状校验。
 *
 * 只描述帧结构，不引入官方 SDK，便于主进程打包与辅助进程构建共用同一份契约；
 * 帧的载荷只包含认证状态、提示形态与进度文本，凭据内容从不进入任何帧。
 */
import type { AuthFlowDeviceCode, AuthMethod, AuthPrompt, AuthPromptKind, AuthPromptOption, AuthProviderStatus, AuthSource } from '../shared/auth-api'

/** 单条记录上限；超限按协议错误处理，不无界缓存。 */
export const AUTH_HELPER_MAX_RECORD_CHARS = 1_048_576

/** 主进程 → 辅助进程的请求。 */
export type AuthHelperRequest =
  | { readonly id: string; readonly type: 'status' }
  | {
    readonly id: string
    readonly type: 'login'
    readonly flowId: string
    readonly providerId: string
    readonly method: AuthMethod
    /** 安装级 UUID；只在登录流程需要时传给 Pi，辅助进程自身不持久化它。 */
    readonly deviceId: string | null
  }
  | { readonly id: string; readonly type: 'prompt-response'; readonly flowId: string; readonly promptId: string; readonly value: string | null }
  | { readonly id: string; readonly type: 'cancel'; readonly flowId: string }
  | { readonly id: string; readonly type: 'logout'; readonly providerId: string }
  | { readonly id: string; readonly type: 'shutdown' }

/** 辅助进程 → 主进程的登录进度事件；与官方通知类型一一对应，不含凭据内容。 */
export type AuthNotifyEvent =
  | { readonly kind: 'auth_url'; readonly url: string; readonly instructions: string | null }
  | { readonly kind: 'device_code'; readonly userCode: string; readonly verificationUri: string }
  | { readonly kind: 'progress'; readonly message: string }
  | { readonly kind: 'info'; readonly message: string }

/** 主进程侧发送请求时不带 id：id 由主进程在写入前生成。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 主进程 → 辅助进程的请求（未附带请求 id）。 */
export type AuthHelperRequestInput = DistributiveOmit<AuthHelperRequest, 'id'>

/** 辅助进程错误码；主进程把未列出的取值一律按 `AUTH_UNAVAILABLE` 处理。 */
export type AuthHelperErrorCode =
  | 'AUTH_PROVIDER_UNKNOWN'
  | 'AUTH_LOGIN_NOT_FOUND'
  | 'AUTH_PROMPT_MISMATCH'
  | 'INVALID_REQUEST'
  | 'AUTH_HELPER_ERROR'

/** 辅助进程 → 主进程的帧。 */
export type AuthHelperFrame =
  | { readonly type: 'response'; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly type: 'response'; readonly id: string; readonly ok: false; readonly code: AuthHelperErrorCode; readonly message: string }
  | { readonly type: 'prompt'; readonly flowId: string; readonly prompt: AuthPrompt }
  | { readonly type: 'prompt-void'; readonly flowId: string; readonly promptId: string }
  | { readonly type: 'notify'; readonly flowId: string; readonly event: AuthNotifyEvent }
  | {
    readonly type: 'flow-end'
    readonly flowId: string
    readonly ok: boolean
    readonly cancelled: boolean
    readonly message: string | null
  }

/** 状态响应载荷；由辅助进程从官方 `ModelRuntime` 投影得到。 */
export interface AuthStatusPayload {
  readonly providers: readonly AuthProviderStatus[]
  readonly configError: string | null
}

const HELPER_ERROR_CODES: readonly string[] = [
  'AUTH_PROVIDER_UNKNOWN',
  'AUTH_LOGIN_NOT_FOUND',
  'AUTH_PROMPT_MISMATCH',
  'INVALID_REQUEST',
  'AUTH_HELPER_ERROR'
]

/** 状态投影里的来源取值；与 shared/auth-api.ts 的 AuthSource 保持一致。 */
const AUTH_SOURCES: readonly string[] = ['stored', 'runtime', 'environment', 'config']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isAuthMethod(value: unknown): value is AuthMethod {
  return value === 'api_key' || value === 'oauth'
}

function isPromptKind(value: unknown): value is AuthPromptKind {
  return value === 'secret' || value === 'text' || value === 'manual_code' || value === 'select'
}

function isPromptOption(value: unknown): value is AuthPromptOption {
  if (!isRecord(value)) return false
  return isIdentifier(value.id)
    && isString(value.label)
    && (value.description === null || isString(value.description))
}

function isPrompt(value: unknown): value is AuthPrompt {
  if (!isRecord(value)) return false
  if (!isIdentifier(value.promptId) || !isPromptKind(value.kind) || !isString(value.message)) return false
  if (value.placeholder !== null && !isString(value.placeholder)) return false
  return Array.isArray(value.options) && value.options.every(isPromptOption)
}

function isDeviceCode(value: unknown): value is AuthFlowDeviceCode {
  if (!isRecord(value)) return false
  return isString(value.userCode) && value.userCode !== ''
    && isString(value.verificationUri) && value.verificationUri !== ''
}

function isProviderStatus(value: unknown): value is AuthProviderStatus {
  if (!isRecord(value)) return false
  if (!isIdentifier(value.providerId) || !isString(value.name)) return false
  if (!Array.isArray(value.authTypes) || !value.authTypes.every(isAuthMethod)) return false
  if (typeof value.subscription !== 'boolean') return false
  if (value.oauthLoginLabel !== null && !isString(value.oauthLoginLabel)) return false
  if (typeof value.configured !== 'boolean') return false
  if (value.source !== null && !isString(value.source)) return false
  if (value.sourceLabel !== null && !isString(value.sourceLabel)) return false
  if (value.storedType !== null && !isAuthMethod(value.storedType)) return false
  return typeof value.modelCount === 'number' && Number.isInteger(value.modelCount) && value.modelCount >= 0
}

/** 状态响应载荷校验；来源取值只在归一化后的固定集合内。 */
export function isAuthStatusPayload(value: unknown): value is AuthStatusPayload {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.providers) || !value.providers.every(isProviderStatus)) return false
  return value.configError === null || isString(value.configError)
}

/** 归一化官方来源取值；未列出的取值按 `config` 处理，避免把未知来源伪装成已识别来源。 */
export function normalizeAuthSource(value: unknown): AuthSource | null {
  if (typeof value !== 'string') return null
  return AUTH_SOURCES.includes(value) ? (value as AuthSource) : 'config'
}

/** 主进程侧校验：辅助进程的输出同样只放行本契约。 */
export function isAuthHelperFrame(value: unknown): value is AuthHelperFrame {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'response': {
      if (!isString(value.id)) return false
      if (value.ok === true) return 'data' in value
      if (value.ok !== false) return false
      return isString(value.code) && HELPER_ERROR_CODES.includes(value.code) && isString(value.message)
    }
    case 'prompt':
      return isIdentifier(value.flowId) && isPrompt(value.prompt)
    case 'prompt-void':
      return isIdentifier(value.flowId) && isIdentifier(value.promptId)
    case 'notify': {
      if (!isIdentifier(value.flowId) || !isRecord(value.event)) return false
      const event = value.event
      switch (event.kind) {
        case 'auth_url':
          return isString(event.url) && event.url !== ''
            && (event.instructions === null || isString(event.instructions))
        case 'device_code':
          return isDeviceCode(event)
        case 'progress':
        case 'info':
          return isString(event.message)
        default:
          return false
      }
    }
    case 'flow-end':
      return isIdentifier(value.flowId)
        && typeof value.ok === 'boolean'
        && typeof value.cancelled === 'boolean'
        && (value.message === null || isString(value.message))
    default:
      return false
  }
}

/** 辅助进程侧校验：只接受主进程声明的请求形态。 */
export function isAuthHelperRequest(value: unknown): value is AuthHelperRequest {
  if (!isRecord(value) || !isString(value.id)) return false
  switch (value.type) {
    case 'status':
    case 'shutdown':
      return true
    case 'login':
      return isIdentifier(value.flowId)
        && isIdentifier(value.providerId)
        && isAuthMethod(value.method)
        && (value.deviceId === null || isString(value.deviceId))
    case 'prompt-response':
      return isIdentifier(value.flowId)
        && isIdentifier(value.promptId)
        && (value.value === null || isString(value.value))
    case 'cancel':
      return isIdentifier(value.flowId)
    case 'logout':
      return isIdentifier(value.providerId)
    default:
      return false
  }
}
