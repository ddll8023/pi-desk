/**
 * 只定义认证状态读取、Provider 登录流程（API Key 与 OAuth）、退出登录与外链打开的固定通道、
 * 请求与结果类型、登录流程快照与跨进程校验。
 *
 * 凭据本身从不进入本契约：状态只描述「是否已配置、来源与类型」，流程快照只描述输入形态与进度；
 * 密钥只经 `desktop:auth-login-respond` 单向提交给主进程，主进程不回传任何已有凭据内容。
 */
import type { DesktopErrorCode } from './desktop-api'

/** 零参数：读取 Provider 列表与认证状态（含当前登录流程快照）。 */
export const AUTH_STATUS_CHANNEL = 'desktop:auth-status'
/** 只接受 `{ providerId, method }`：启动一次官方登录流程。 */
export const AUTH_LOGIN_START_CHANNEL = 'desktop:auth-login-start'
/** 只接受 `{ flowId, promptId, value }`：回应流程中的当前提示（密钥由此单向提交）。 */
export const AUTH_LOGIN_RESPOND_CHANNEL = 'desktop:auth-login-respond'
/** 只接受 `{ flowId }`：取消指定登录流程。 */
export const AUTH_LOGIN_CANCEL_CHANNEL = 'desktop:auth-login-cancel'
/** 只接受 `{ flowId }`：在系统浏览器中打开该流程记录的授权地址；不接受页面传入 URL。 */
export const AUTH_OPEN_URL_CHANNEL = 'desktop:auth-open-url'
/** 只接受 `{ providerId }`：删除该 Provider 已保存的凭据。 */
export const AUTH_LOGOUT_CHANNEL = 'desktop:auth-logout'
/** 主进程到渲染进程的单向登录流程通知，payload 是 AuthFlowSnapshot。 */
export const AUTH_FLOW_EVENT = 'desktop:auth-flow-changed'

/** 标识符与输入的长度上限：只限制形状，合法性由 Pi 判定。 */
export const AUTH_MAX_PROVIDER_ID_CHARS = 128
export const AUTH_MAX_FLOW_ID_CHARS = 128
export const AUTH_MAX_PROMPT_ID_CHARS = 128
export const AUTH_MAX_SELECT_VALUE_CHARS = 128
/** 密钥输入上限；超限按参数拒绝，不静默截断。 */
export const AUTH_MAX_SECRET_CHARS = 8_192

/** 官方支持的两类 Provider 认证方式；与 Pi 的 `AuthType` 一一对应。 */
export type AuthMethod = 'api_key' | 'oauth'

/**
 * 凭据来源。Pi 的 `AuthStatus.source` 取值更多（含 `fallback`、`models_json_key`、
 * `models_json_command`），这里只归一到页面需要的四类，其余一律按 `config` 处理；
 * 原始细节经 `sourceLabel` 如实展示，但不包含凭据内容。
 */
export type AuthSource = 'stored' | 'runtime' | 'environment' | 'config'

/** 单个 Provider 的认证状态；`configured` 只表示解析到了可用凭据，不代表上游已接受它。 */
export interface AuthProviderStatus {
  readonly providerId: string
  readonly name: string
  /**
   * 可在本应用内配置的登录方式：`oauth` 只对支持账户登录的 Provider 有值，
   * `api_key` 只在 Provider 支持交互式录入密钥时有值；仅依赖环境变量、云凭据或
   * models.json 配置的 Provider 这里是空数组（凭据需要在 Pi 外部配置）。
   */
  readonly authTypes: readonly AuthMethod[]
  /** OAuth 是否由 Provider 订阅支撑（例如账户订阅而非按量计费）。 */
  readonly subscription: boolean
  /** OAuth 登录方式在 Pi 中的展示名；不支持 OAuth 时为 null。 */
  readonly oauthLoginLabel: string | null
  readonly configured: boolean
  readonly source: AuthSource | null
  /** 来源细节，例如环境变量名；不含任何凭据内容。 */
  readonly sourceLabel: string | null
  /** 已保存的凭据类型；没有保存记录时为 null（环境变量与 models.json 配置不在此列）。 */
  readonly storedType: AuthMethod | null
  /** 该 Provider 已知的模型数；只统计模型目录，不代表已经可用。 */
  readonly modelCount: number
}

/** 提示形态；与 Pi 的登录提示类型一一对应，不含凭据内容。 */
export type AuthPromptKind = 'secret' | 'text' | 'manual_code' | 'select'

export interface AuthPromptOption {
  readonly id: string
  readonly label: string
  readonly description: string | null
}

export interface AuthPrompt {
  readonly promptId: string
  readonly kind: AuthPromptKind
  readonly message: string
  readonly placeholder: string | null
  /** 只有 `select` 有值；其他形态为空数组。 */
  readonly options: readonly AuthPromptOption[]
}

/**
 * `waiting` 表示流程进行中且当前没有等待输入；`prompt` 表示等待用户输入；
 * `cancelling` 表示已请求取消；其余为终态。
 */
export type AuthFlowPhase = 'waiting' | 'prompt' | 'cancelling' | 'completed' | 'failed' | 'cancelled'

/** 设备码流程的展示值；`verificationUri` 只按文本展示，可由主进程在系统浏览器中打开。 */
export interface AuthFlowDeviceCode {
  readonly userCode: string
  readonly verificationUri: string
}

/** 登录流程快照；主进程按代际持有，页面只做展示与回应。 */
export interface AuthFlowSnapshot {
  readonly flowId: string
  readonly providerId: string
  readonly method: AuthMethod
  readonly phase: AuthFlowPhase
  readonly prompt: AuthPrompt | null
  /** Pi 给出的进度与提示文本（有界保留）；一律按不可信纯文本展示。 */
  readonly messages: readonly string[]
  readonly deviceCode: AuthFlowDeviceCode | null
  /** 授权地址是否已经由主进程交给系统浏览器打开。 */
  readonly browserOpened: boolean
  /** 是否还有可由主进程打开的地址；地址本身不交给页面。 */
  readonly hasOpenableUrl: boolean
  /** 终态的原因文本（已脱敏）；流程未结束时为 null。 */
  readonly message: string | null
}

/** Provider 状态读取结果；`flow` 是当前登录流程，没有进行中的流程时为 null。 */
export interface AuthStatus {
  readonly providers: readonly AuthProviderStatus[]
  /** models.json 等本地状态问题（含组合错误与本地可用性检查失败）；null 表示没有发现问题。 */
  readonly configError: string | null
  readonly flow: AuthFlowSnapshot | null
}

export type AuthErrorCode =
  | DesktopErrorCode
  /** 认证辅助进程不可用（未构建、启动失败、退出或写入失败）。 */
  | 'AUTH_UNAVAILABLE'
  /** flowId 不存在或流程已结束。 */
  | 'AUTH_LOGIN_NOT_FOUND'
  /** 已有登录流程在进行中；同一时刻只允许一个。 */
  | 'AUTH_LOGIN_CONFLICT'
  /** 回应的提示与当前挂起的提示不一致（可能是过期页面或重复提交）。 */
  | 'AUTH_PROMPT_MISMATCH'
  /** Pi 不认识该 Provider，或该 Provider 不支持请求的登录方式。 */
  | 'AUTH_PROVIDER_UNKNOWN'
  /** 交给系统浏览器打开授权地址失败。 */
  | 'AUTH_OPEN_URL_FAILED'
  /** 认证辅助进程缺少运行依赖（官方 SDK 未安装或未构建），无法读取状态与登录。 */
  | 'AUTH_HELPER_DEPENDENCY_MISSING'

export interface AuthError {
  readonly code: AuthErrorCode
  /** 面向用户的一句话结论；技术细节放在 `detail` 里。 */
  readonly message: string
  /** 原始错误文本与辅助进程诊断；没有额外细节时为 null。页面按纯文本展示，可复制。 */
  readonly detail: string | null
}

export type AuthStatusResult =
  | { readonly ok: true; readonly data: AuthStatus }
  | { readonly ok: false; readonly error: AuthError }

export type AuthFlowResult =
  | { readonly ok: true; readonly data: AuthFlowSnapshot }
  | { readonly ok: false; readonly error: AuthError }

export type AuthLogoutResult =
  | { readonly ok: true; readonly data: AuthStatus }
  | { readonly ok: false; readonly error: AuthError }

export interface AuthLoginStartRequest {
  readonly providerId: string
  readonly method: AuthMethod
}

export interface AuthLoginRespondRequest {
  readonly flowId: string
  readonly promptId: string
  /** 用户输入或选中的值；`select` 用选项 id。密钥不落日志、不进配置。 */
  readonly value: string
}

export interface AuthLogoutRequest {
  readonly providerId: string
}

export interface AuthOpenUrlRequest {
  readonly flowId: string
}

export interface AuthApi {
  /** 读取 Provider 与认证状态；不返回任何已有凭据内容。 */
  readonly getAuthStatus: () => Promise<AuthStatusResult>
  /** 启动官方登录流程；成功只表示流程已开始，结果以流程快照收敛。 */
  readonly startAuthLogin: (providerId: string, method: AuthMethod) => Promise<AuthFlowResult>
  /** 回应流程中的当前提示；密钥只经此单向提交。 */
  readonly respondAuthLogin: (flowId: string, promptId: string, value: string) => Promise<AuthFlowResult>
  /** 取消登录流程；取消后凭据不会保存。 */
  readonly cancelAuthLogin: (flowId: string) => Promise<AuthFlowResult>
  /** 在系统浏览器中打开该流程的授权地址；页面不传 URL。 */
  readonly openAuthFlowUrl: (flowId: string) => Promise<AuthFlowResult>
  /** 删除已保存的凭据（不影响环境变量与 models.json 配置）；成功返回刷新后的状态。 */
  readonly logoutAuthProvider: (providerId: string) => Promise<AuthLogoutResult>
  /** 订阅登录流程变化；返回释放函数，页面卸载时必须调用。 */
  readonly onAuthFlowChanged: (listener: (snapshot: AuthFlowSnapshot) => void) => () => void
}

const AUTH_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'TRUST_REQUIRED',
  'AUTH_UNAVAILABLE',
  'AUTH_LOGIN_NOT_FOUND',
  'AUTH_LOGIN_CONFLICT',
  'AUTH_PROMPT_MISMATCH',
  'AUTH_PROVIDER_UNKNOWN',
  'AUTH_OPEN_URL_FAILED',
  'AUTH_HELPER_DEPENDENCY_MISSING'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
}

export function isAuthMethod(value: unknown): value is AuthMethod {
  return value === 'api_key' || value === 'oauth'
}

function isAuthSource(value: unknown): value is AuthSource {
  return value === 'stored' || value === 'runtime' || value === 'environment' || value === 'config'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isAuthProviderStatus(value: unknown): value is AuthProviderStatus {
  if (!isRecord(value)) return false
  if (!isBoundedString(value.providerId, AUTH_MAX_PROVIDER_ID_CHARS)) return false
  if (typeof value.name !== 'string') return false
  if (!Array.isArray(value.authTypes) || !value.authTypes.every(isAuthMethod)) return false
  if (typeof value.subscription !== 'boolean') return false
  if (!isNullableString(value.oauthLoginLabel)) return false
  if (typeof value.configured !== 'boolean') return false
  if (value.source !== null && !isAuthSource(value.source)) return false
  if (!isNullableString(value.sourceLabel)) return false
  if (value.storedType !== null && !isAuthMethod(value.storedType)) return false
  return typeof value.modelCount === 'number' && Number.isInteger(value.modelCount) && value.modelCount >= 0
}

function isAuthPromptKind(value: unknown): value is AuthPromptKind {
  return value === 'secret' || value === 'text' || value === 'manual_code' || value === 'select'
}

function isAuthPromptOption(value: unknown): value is AuthPromptOption {
  if (!isRecord(value)) return false
  return isBoundedString(value.id, AUTH_MAX_SELECT_VALUE_CHARS)
    && typeof value.label === 'string'
    && isNullableString(value.description)
}

function isAuthPrompt(value: unknown): value is AuthPrompt {
  if (!isRecord(value)) return false
  if (!isBoundedString(value.promptId, AUTH_MAX_PROMPT_ID_CHARS)) return false
  if (!isAuthPromptKind(value.kind)) return false
  if (typeof value.message !== 'string') return false
  if (!isNullableString(value.placeholder)) return false
  return Array.isArray(value.options) && value.options.every(isAuthPromptOption)
}

function isAuthFlowPhase(value: unknown): value is AuthFlowPhase {
  return value === 'waiting' || value === 'prompt' || value === 'cancelling'
    || value === 'completed' || value === 'failed' || value === 'cancelled'
}

function isAuthFlowDeviceCode(value: unknown): value is AuthFlowDeviceCode {
  if (!isRecord(value)) return false
  return typeof value.userCode === 'string' && value.userCode !== ''
    && typeof value.verificationUri === 'string' && value.verificationUri !== ''
}

/** 流程快照跨进程校验；登录流程事件与结果都只放行本契约。 */
export function isAuthFlowSnapshot(value: unknown): value is AuthFlowSnapshot {
  if (!isRecord(value)) return false
  if (!isBoundedString(value.flowId, AUTH_MAX_FLOW_ID_CHARS)) return false
  if (!isBoundedString(value.providerId, AUTH_MAX_PROVIDER_ID_CHARS)) return false
  if (!isAuthMethod(value.method)) return false
  if (!isAuthFlowPhase(value.phase)) return false
  if (value.prompt !== null && !isAuthPrompt(value.prompt)) return false
  if (!Array.isArray(value.messages) || !value.messages.every((message) => typeof message === 'string')) {
    return false
  }
  if (value.deviceCode !== null && !isAuthFlowDeviceCode(value.deviceCode)) return false
  if (typeof value.browserOpened !== 'boolean' || typeof value.hasOpenableUrl !== 'boolean') return false
  return isNullableString(value.message)
}

function isAuthStatus(value: unknown): value is AuthStatus {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.providers) || !value.providers.every(isAuthProviderStatus)) return false
  if (!isNullableString(value.configError)) return false
  return value.flow === null || isAuthFlowSnapshot(value.flow)
}

/** 只放行契约内的错误码；未列出的取值一律按响应不符处理。 */
function isAuthErrorResult(value: unknown): value is { ok: false; error: AuthError } {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) return false
  const { code, message, detail } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && AUTH_ERROR_CODES.includes(code)
    && (detail === null || typeof detail === 'string')
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isAuthStatusResult(value: unknown): value is AuthStatusResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isAuthStatus(value.data)
  return isAuthErrorResult(value)
}

export function isAuthFlowResult(value: unknown): value is AuthFlowResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isAuthFlowSnapshot(value.data)
  return isAuthErrorResult(value)
}

export function isAuthLogoutResult(value: unknown): value is AuthLogoutResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isAuthStatus(value.data)
  return isAuthErrorResult(value)
}

/** 启动请求只校验形状；长度上限与字符集由主进程校验。 */
export function isAuthLoginStartRequest(value: unknown): value is AuthLoginStartRequest {
  if (!isRecord(value)) return false
  return isBoundedString(value.providerId, AUTH_MAX_PROVIDER_ID_CHARS) && isAuthMethod(value.method)
}

/** 回应请求只校验形状；密钥长度上限与 select 取值由主进程校验。 */
export function isAuthLoginRespondRequest(value: unknown): value is AuthLoginRespondRequest {
  if (!isRecord(value)) return false
  return isBoundedString(value.flowId, AUTH_MAX_FLOW_ID_CHARS)
    && isBoundedString(value.promptId, AUTH_MAX_PROMPT_ID_CHARS)
    && typeof value.value === 'string'
}

export function isAuthLogoutRequest(value: unknown): value is AuthLogoutRequest {
  if (!isRecord(value)) return false
  return isBoundedString(value.providerId, AUTH_MAX_PROVIDER_ID_CHARS)
}

export function isAuthOpenUrlRequest(value: unknown): value is AuthOpenUrlRequest {
  if (!isRecord(value)) return false
  return isBoundedString(value.flowId, AUTH_MAX_FLOW_ID_CHARS)
}
