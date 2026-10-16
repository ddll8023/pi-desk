/**
 * 定义内置终端（PTY）的固定通道、载荷类型与跨进程校验。
 *
 * 通道分工：创建、写入、改尺寸、关闭与清单读取走 invoke 并只回受限结果；终端输出与退出走单向事件；
 * 数据确认沿用运行时投影的做法，用 invoke 只回报已消费的字符数、不回传结果。
 *
 * 边界：页面只能给出已登记项目的路径与终端标识，shell、环境变量与工作目录都由主进程决定；
 * 终端进程与其缓冲只存在于主进程，页面卸载、标签切换与项目切换都不结束终端。
 * 字符数一律按 UTF-16 码元（JS 字符串长度）计，下发与确认必须同一口径。
 */
export const TERMINAL_CREATE_CHANNEL = 'desktop:terminal-create'
export const TERMINAL_WRITE_CHANNEL = 'desktop:terminal-write'
export const TERMINAL_RESIZE_CHANNEL = 'desktop:terminal-resize'
export const TERMINAL_CLOSE_CHANNEL = 'desktop:terminal-close'
export const TERMINAL_LIST_CHANNEL = 'desktop:terminal-list'
export const TERMINAL_ACK_CHANNEL = 'desktop:terminal-ack'
export const TERMINAL_DATA_EVENT = 'desktop:terminal-data'
export const TERMINAL_EXIT_EVENT = 'desktop:terminal-exit'

/** 终端标识长度上限；只拒绝明显异常的值，真实存在性由主进程核对。 */
export const TERMINAL_ID_MAX_CHARS = 128

/** 项目路径长度上限；只拒绝明显异常的值，是否为已登记项目由主进程核对。 */
export const TERMINAL_PATH_MAX_CHARS = 4096

/** 单次写入的字符上限；超出拒绝，避免一次粘贴把主进程的缓冲撑爆。 */
export const TERMINAL_WRITE_MAX_CHARS = 512 * 1024

/** 终端行列的取值边界；只拒绝明显异常的尺寸，不代替 PTY 自身的限制。 */
export const TERMINAL_DIMENSION_MIN = 2
export const TERMINAL_DIMENSION_MAX = 1000

/** 单个终端一次下发的字符上限；超出由主进程切片，页面无需感知。 */
export const TERMINAL_DATA_MAX_CHARS = 256 * 1024

/** 终端状态：`exited` 的终端记录保留到页面显式关闭，以便标签如实展示退出码。 */
export type TerminalStatus = 'running' | 'exited'

export interface TerminalSessionInfo {
  readonly id: string
  /** 终端所属项目路径；终端的展示与收敛都按它分组。 */
  readonly projectPath: string
  /** 默认标题取 shell 可执行文件名；重命名由页面自己保存，不回传主进程。 */
  readonly title: string
  /** 实际启动的 shell 可执行文件；用于界面展示与排障。 */
  readonly shell: string
  /** 终端启动时的工作目录；等于创建时的项目路径。 */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly status: TerminalStatus
  /** 已退出终端的退出码；仍在运行时为 null。 */
  readonly exitCode: number | null
}

/** 创建请求：只接受已登记项目路径与初始尺寸，不接受 shell、环境变量或工作目录。 */
export interface TerminalCreateRequest {
  readonly projectPath: string
  readonly cols: number
  readonly rows: number
}

export interface TerminalWriteRequest {
  readonly id: string
  readonly data: string
}

export interface TerminalResizeRequest {
  readonly id: string
  readonly cols: number
  readonly rows: number
}

export interface TerminalCloseRequest {
  readonly id: string
}

/** 清单请求：给出项目路径只列该项目的终端，给 null 列全部（页面重新挂载后重建标签用）。 */
export interface TerminalListRequest {
  readonly projectPath: string | null
}

/** 数据确认：只回报一个终端已消费的字符数；主进程按已下发的在途量收敛，不信任超出部分。 */
export interface TerminalAckRequest {
  readonly id: string
  readonly chars: number
}

export interface TerminalDataEvent {
  readonly id: string
  readonly chunk: string
  /** 本次下发的字符数；页面原样回报，主进程据此释放背压额度。 */
  readonly chars: number
}

export interface TerminalExitEvent {
  readonly id: string
  readonly exitCode: number
}

/** 终端专有错误码，前四项与共享错误码族一致。 */
export type TerminalErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | 'INVALID_RESPONSE'
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_CALL_FAILED'
  /** 终端不存在或已关闭；页面据此丢弃该标签的迟到操作。 */
  | 'TERMINAL_NOT_FOUND'
  /** 同时运行的终端数达到上限；页面提示先关闭一个。 */
  | 'TERMINAL_LIMIT_REACHED'

export interface TerminalError {
  readonly code: TerminalErrorCode
  readonly message: string
}

export type TerminalSessionResult =
  | { readonly ok: true; readonly data: TerminalSessionInfo }
  | { readonly ok: false; readonly error: TerminalError }

export type TerminalSessionsResult =
  | { readonly ok: true; readonly data: { readonly sessions: readonly TerminalSessionInfo[] } }
  | { readonly ok: false; readonly error: TerminalError }

/** 写入、改尺寸与关闭的结果：成功不需要回传数据，失败带可展示的原因。 */
export type TerminalCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: TerminalError }

export interface TerminalApi {
  /** 在已添加的项目内新建终端；shell、环境变量与工作目录都由主进程决定。 */
  readonly createTerminal: (request: TerminalCreateRequest) => Promise<TerminalSessionResult>
  /** 把用户输入写入终端；数据长度有上限，超出按非法请求拒绝。 */
  readonly writeTerminal: (request: TerminalWriteRequest) => Promise<TerminalCommandResult>
  /** 同步终端尺寸；尺寸变化会转给 PTY，让全屏程序按新尺寸重排。 */
  readonly resizeTerminal: (request: TerminalResizeRequest) => Promise<TerminalCommandResult>
  /** 关闭终端并收敛其进程树；关闭不存在的终端按已关闭处理。 */
  readonly closeTerminal: (request: TerminalCloseRequest) => Promise<TerminalCommandResult>
  /**
   * 读取终端清单。页面应先订阅数据与退出事件再列出终端，避免重挂载期间的下发无人接收。
   */
  readonly listTerminals: (request: TerminalListRequest) => Promise<TerminalSessionsResult>
  /** 回报已消费的字符数；只用于释放背压额度，失败不重试。 */
  readonly ackTerminalData: (request: TerminalAckRequest) => void
  /** 订阅终端输出；返回释放函数，页面卸载时必须调用。 */
  readonly onTerminalData: (listener: (event: TerminalDataEvent) => void) => () => void
  /** 订阅终端退出；返回释放函数，页面卸载时必须调用。 */
  readonly onTerminalExit: (listener: (event: TerminalExitEvent) => void) => () => void
}

const TERMINAL_STATUSES: readonly string[] = ['running', 'exited']

// 与 desktop-api.ts 的共享错误码保持一致，再追加终端专有错误码。
const TERMINAL_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_LIMIT_REACHED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= TERMINAL_ID_MAX_CHARS
}

function isTerminalProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= TERMINAL_PATH_MAX_CHARS
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= TERMINAL_DIMENSION_MIN
    && value <= TERMINAL_DIMENSION_MAX
}

function isTerminalSessionInfo(value: unknown): value is TerminalSessionInfo {
  if (!isRecord(value)) return false
  return isTerminalId(value.id)
    && isTerminalProjectPath(value.projectPath)
    && typeof value.title === 'string'
    && typeof value.shell === 'string'
    && value.shell !== ''
    && typeof value.cwd === 'string'
    && value.cwd !== ''
    && isDimension(value.cols)
    && isDimension(value.rows)
    && typeof value.status === 'string'
    && TERMINAL_STATUSES.includes(value.status)
    && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
}

function isTerminalError(value: unknown): value is TerminalError {
  if (!isRecord(value)) return false
  const { code, message } = value
  return typeof code === 'string' && TERMINAL_ERROR_CODES.includes(code) && typeof message === 'string'
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isTerminalSessionResult(value: unknown): value is TerminalSessionResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isTerminalSessionInfo(value.data)
  if (value.ok !== false) return false
  return isTerminalError(value.error)
}

export function isTerminalSessionsResult(value: unknown): value is TerminalSessionsResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && Array.isArray(data.sessions)
      && data.sessions.every(isTerminalSessionInfo)
  }
  if (value.ok !== false) return false
  return isTerminalError(value.error)
}

export function isTerminalCommandResult(value: unknown): value is TerminalCommandResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return true
  if (value.ok !== false) return false
  return isTerminalError(value.error)
}

/** 事件载荷同样不可信：契约不符时由调用方丢弃，等后续输出或退出事件收敛。 */
export function isTerminalDataEvent(value: unknown): value is TerminalDataEvent {
  if (!isRecord(value)) return false
  return isTerminalId(value.id)
    && typeof value.chunk === 'string'
    && typeof value.chars === 'number'
    && Number.isInteger(value.chars)
    && value.chars >= 0
    && value.chars === value.chunk.length
}

export function isTerminalExitEvent(value: unknown): value is TerminalExitEvent {
  if (!isRecord(value)) return false
  return isTerminalId(value.id)
    && typeof value.exitCode === 'number'
    && Number.isInteger(value.exitCode)
}

export function isTerminalCreateRequest(value: unknown): value is TerminalCreateRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'projectPath' && key !== 'cols' && key !== 'rows')) return false
  return isTerminalProjectPath(value.projectPath) && isDimension(value.cols) && isDimension(value.rows)
}

export function isTerminalWriteRequest(value: unknown): value is TerminalWriteRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'id' && key !== 'data')) return false
  return isTerminalId(value.id)
    && typeof value.data === 'string'
    && value.data.length <= TERMINAL_WRITE_MAX_CHARS
}

export function isTerminalResizeRequest(value: unknown): value is TerminalResizeRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'id' && key !== 'cols' && key !== 'rows')) return false
  return isTerminalId(value.id) && isDimension(value.cols) && isDimension(value.rows)
}

export function isTerminalCloseRequest(value: unknown): value is TerminalCloseRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'id')) return false
  return isTerminalId(value.id)
}

export function isTerminalListRequest(value: unknown): value is TerminalListRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'projectPath')) return false
  return value.projectPath === null || isTerminalProjectPath(value.projectPath)
}

export function isTerminalAckRequest(value: unknown): value is TerminalAckRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'id' && key !== 'chars')) return false
  return isTerminalId(value.id)
    && typeof value.chars === 'number'
    && Number.isInteger(value.chars)
    && value.chars >= 0
    && value.chars <= TERMINAL_DATA_MAX_CHARS
}
