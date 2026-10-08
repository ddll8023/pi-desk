/** 只定义 Pi Session 列表与打开 IPC 的固定通道、结果类型与跨进程响应校验。 */
import type { RuntimeErrorCode } from './runtime-api'

export const SESSION_LIST_CHANNEL = 'desktop:session-list'
export const SESSION_OPEN_CHANNEL = 'desktop:session-open'

/**
 * 会话摘要只读会话文件的元数据：`createdAt` 来自文件头部的时间戳，`updatedAt` 是文件最后修改
 * 时间（纪元毫秒），`preview` 是有界读取得到的首条用户消息开头，取不到时为 null。
 */
export interface SessionSummary {
  readonly sessionId: string
  readonly createdAt: string
  readonly updatedAt: number
  readonly sizeBytes: number
  readonly preview: string | null
}

export interface SessionList {
  readonly sessions: readonly SessionSummary[]
  /** 同一分组目录里无法解析或 cwd 与当前项目不符的文件数，界面应如实提示。 */
  readonly skipped: number
  /** 超过列表上限被省略的会话数。 */
  readonly truncated: number
}

/** `sessionId` 为 null 表示新建会话；`allowInterrupt` 只有用户已确认时才为真。 */
export interface SessionOpenRequest {
  readonly sessionId: string | null
  readonly allowInterrupt: boolean
}

/** 复用 Runtime 错误码族，只追加 Session 专有错误码。 */
export type SessionErrorCode = RuntimeErrorCode | 'SESSION_NOT_FOUND' | 'SESSION_SWITCH_BLOCKED'

/** 打开会话可能被 Project Trust 拦截，错误码集合与 Runtime 族同步维护。 */
const SESSION_EXTRA_ERROR_CODES: readonly string[] = ['SESSION_NOT_FOUND', 'SESSION_SWITCH_BLOCKED']

export interface SessionError {
  readonly code: SessionErrorCode
  readonly message: string
}

export type SessionListResult =
  | { readonly ok: true; readonly data: SessionList }
  | { readonly ok: false; readonly error: SessionError }

/** 打开会话成功时返回更新后的列表；Runtime 状态仍由状态事件收敛。 */
export type SessionOpenResult =
  | { readonly ok: true; readonly data: SessionList }
  | { readonly ok: false; readonly error: SessionError }

export interface SessionApi {
  readonly listSessions: () => Promise<SessionListResult>
  /** 打开会话；`sessionId` 为 null 表示新建，非空时必须属于当前项目。 */
  readonly openSession: (sessionId: string | null, allowInterrupt: boolean) => Promise<SessionOpenResult>
}

// 与 runtime-api.ts 的共享错误码保持一致，再追加 Session 专有错误码。
const SESSION_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'INVALID_PROJECT_PATH',
  'RUNTIME_ALREADY_RUNNING',
  'RUNTIME_NOT_READY',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_EXITED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR',
  'PROMPT_REJECTED',
  'RUNTIME_COMMAND_REJECTED',
  'TRUST_REQUIRED',
  ...SESSION_EXTRA_ERROR_CODES
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!isRecord(value)) return false
  return typeof value.sessionId === 'string'
    && value.sessionId !== ''
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && typeof value.sizeBytes === 'number'
    && Number.isInteger(value.sizeBytes)
    && value.sizeBytes >= 0
    && (value.preview === null || typeof value.preview === 'string')
}

function isSessionList(value: unknown): value is SessionList {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSessionSummary)) return false
  return typeof value.skipped === 'number'
    && Number.isInteger(value.skipped)
    && value.skipped >= 0
    && typeof value.truncated === 'number'
    && Number.isInteger(value.truncated)
    && value.truncated >= 0
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isSessionListResult(value: unknown): value is SessionListResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isSessionList(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && SESSION_ERROR_CODES.includes(code)
}
