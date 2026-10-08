/** 只定义 Runtime 启动与状态 IPC 的固定通道、结果类型与跨进程响应校验。 */
import type { DesktopErrorCode } from './desktop-api'

export const RUNTIME_START_CHANNEL = 'desktop:runtime-start'
export const RUNTIME_STATUS_CHANNEL = 'desktop:runtime-status'

/** 启动请求只接受项目目录；其他启动参数一律不接受。 */
export interface RuntimeStartRequest {
  readonly projectPath: string
}

export type RuntimeState = 'idle' | 'starting' | 'ready' | 'failed'

/** 只投影页面需要的会话信息，不搬运 Pi 的完整状态或消息。 */
export interface RuntimeInfo {
  readonly model: string | null
  readonly thinkingLevel: string | null
  readonly sessionId: string | null
  readonly messageCount: number
  readonly isStreaming: boolean
}

export interface RuntimeStatus {
  readonly state: RuntimeState
  readonly runtimeId: number | null
  readonly info: RuntimeInfo | null
  readonly lastError: string | null
}

export type RuntimeErrorCode =
  | DesktopErrorCode
  | 'INVALID_PROJECT_PATH'
  | 'RUNTIME_ALREADY_RUNNING'
  | 'RUNTIME_SPAWN_FAILED'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_PROTOCOL_ERROR'

export interface RuntimeError {
  readonly code: RuntimeErrorCode
  readonly message: string
}

export type RuntimeResult =
  | { readonly ok: true; readonly data: RuntimeStatus }
  | { readonly ok: false; readonly error: RuntimeError }

export interface RuntimeApi {
  readonly startRuntime: (projectPath: string) => Promise<RuntimeResult>
  readonly getRuntimeStatus: () => Promise<RuntimeResult>
}

// 与 desktop-api.ts 的共享错误码保持一致，再追加 Runtime 启动与运行专有错误码。
const RUNTIME_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'INVALID_PROJECT_PATH',
  'RUNTIME_ALREADY_RUNNING',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_EXITED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return value === 'idle' || value === 'starting' || value === 'ready' || value === 'failed'
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (!isRecord(value)) return false
  return (value.model === null || typeof value.model === 'string')
    && (value.thinkingLevel === null || typeof value.thinkingLevel === 'string')
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && typeof value.messageCount === 'number'
    && typeof value.isStreaming === 'boolean'
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!isRecord(value) || !isRuntimeState(value.state)) return false
  if (value.runtimeId !== null && typeof value.runtimeId !== 'number') return false
  if (value.lastError !== null && typeof value.lastError !== 'string') return false
  return value.info === null || isRuntimeInfo(value.info)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isRuntimeResult(value: unknown): value is RuntimeResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isRuntimeStatus(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}
