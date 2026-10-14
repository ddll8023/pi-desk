/** 只定义 Pi Session 列表（按项目）、打开与重新加载 IPC 的固定通道、请求与结果类型及跨进程响应校验。 */
import type { RuntimeErrorCode } from './runtime-api'

export const SESSION_LIST_CHANNEL = 'desktop:session-list'
export const SESSION_OPEN_CHANNEL = 'desktop:session-open'
/** 重新加载 Pi 资源：在同一 SDK 宿主进程内重建该会话的 services，并尽量恢复当前会话；`allowInterrupt` 与会话打开同义。 */
export const SESSION_RELOAD_CHANNEL = 'desktop:session-reload'

/**
 * 会话列表请求：显式给出要读取的项目路径。侧栏按项目树展示会话，列表读取不再隐式取当前项目；
 * 主进程只接受已添加项目的规范绝对路径，页面不能借它读取任意目录。
 */
export interface SessionListRequest {
  readonly projectPath: string
}

/** 路径长度上限；与界面偏好中的路径字段同口径，只拒绝明显异常的值。 */
const MAX_PROJECT_PATH_LENGTH = 4096

/** 列表请求只放行一个非空的项目路径字符串，不接受多余字段。 */
export function isSessionListRequest(value: unknown): value is SessionListRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'projectPath')) return false
  const { projectPath } = value
  return typeof projectPath === 'string'
    && projectPath !== ''
    && projectPath.length <= MAX_PROJECT_PATH_LENGTH
}

/**
 * 会话摘要只读会话文件的元数据：`createdAt` 来自文件头部的时间戳，`updatedAt` 是文件最后修改
 * 时间（纪元毫秒），`preview` 是有界读取得到的首条用户消息文本（已剔除 Pi 注入的 `[Image: …]` 标记行与
 * `/skill:` 展开的技能块，空白折叠为单个空格），取不到时为 null。
 *
 * `forkedFromSessionId` 是回退（Pi 的 fork）产生的来源会话 id：回退会新建会话文件并保留原文件，
 * 两个文件都留在同一目录里；列表把分叉链折叠为最新一条，来源会话只在分叉来源标注里出现。
 */
export interface SessionSummary {
  readonly sessionId: string
  readonly createdAt: string
  readonly updatedAt: number
  readonly sizeBytes: number
  readonly preview: string | null
  readonly forkedFromSessionId: string | null
}

export interface SessionList {
  readonly sessions: readonly SessionSummary[]
  /** 同一分组目录里无法解析或 cwd 与当前项目不符的文件数，界面应如实提示。 */
  readonly skipped: number
  /** 超过列表上限被省略的会话数。 */
  readonly truncated: number
  /**
   * 本次实际读取的项目路径；等于请求中的路径，未选择项目时不可能出现（列表请求必须带项目）。
   * 页面据此把结果归入对应项目的分片，不把旧项目的列表当成新项目的。
   */
  readonly projectPath: string | null
}

/** `sessionId` 为 null 表示新建会话；`allowInterrupt` 只有用户已确认时才为真。 */
export interface SessionOpenRequest {
  readonly sessionId: string | null
  readonly allowInterrupt: boolean
}

/** 复用 Runtime 错误码族，只追加 Session 专有错误码。 */
export type SessionErrorCode = RuntimeErrorCode | 'SESSION_NOT_FOUND' | 'SESSION_SWITCH_BLOCKED'

/** 打开会话可能被 Project Trust 拦截，错误码集合与 Runtime 族同步维护。 */
const SESSION_EXTRA_ERROR_CODES: readonly string[] = [
  'SESSION_NOT_FOUND',
  'SESSION_SWITCH_BLOCKED'
]

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
  /** 读取指定项目的会话列表；项目必须是已添加项目，不要求它是当前项目。 */
  readonly listSessions: (request: SessionListRequest) => Promise<SessionListResult>
  /**
   * 打开会话；`sessionId` 为 null 表示新建，非空时必须属于当前项目。
   * 新建会话的默认模型由 Pi 自己的 settings.json 决定，不能在这里指定。
   */
  readonly openSession: (
    sessionId: string | null,
    allowInterrupt: boolean
  ) => Promise<SessionOpenResult>
  /**
   * 重新加载 Pi 资源：在同一 SDK 宿主进程内重建该会话的 services（重新读取 Skills、Prompt Templates、
   * MCP 配置与 Extension），并尽量恢复当前会话；`allowInterrupt` 只有用户已确认时才为真。
   */
  readonly reloadSession: (allowInterrupt: boolean) => Promise<SessionOpenResult>
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
  'RUNTIME_NOT_READY',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_EXITED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR',
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
    && (value.forkedFromSessionId === null || typeof value.forkedFromSessionId === 'string')
}

function isSessionList(value: unknown): value is SessionList {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSessionSummary)) return false
  if (value.projectPath !== null && typeof value.projectPath !== 'string') return false
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
