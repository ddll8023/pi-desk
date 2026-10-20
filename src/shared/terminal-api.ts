/**
 * 定义内置终端（PTY）的固定通道、载荷类型与跨进程校验。
 *
 * 页面逐终端取得有容量上限的画面，解析完成后确认恢复，随后接收实时输出。
 * 数据确认带投递代际与累计进度；迟到或重复确认不会释放其他页面的额度。
 *
 * 边界：页面只能给出已登记项目的路径与终端标识，shell、环境变量与工作目录都由主进程决定；
 * 终端进程与其缓冲由独立守护进程持有，应用退出后继续运行，页面卸载、标签切换、项目切换与应用重启
 * 都不结束终端。重新接回时先取快照（滚动历史与模式恢复序列），再接实时输出。
 * 字符数一律按 UTF-16 码元（JS 字符串长度）计，下发与确认必须同一口径。
 */
export const TERMINAL_CREATE_CHANNEL = 'desktop:terminal-create'
export const TERMINAL_WRITE_CHANNEL = 'desktop:terminal-write'
export const TERMINAL_RESIZE_CHANNEL = 'desktop:terminal-resize'
export const TERMINAL_CLOSE_CHANNEL = 'desktop:terminal-close'
export const TERMINAL_CLOSE_ALL_CHANNEL = 'desktop:terminal-close-all'
export const TERMINAL_LIST_CHANNEL = 'desktop:terminal-list'
export const TERMINAL_SNAPSHOTS_CHANNEL = 'desktop:terminal-snapshots'
export const TERMINAL_RECOVERY_CHANNEL = 'desktop:terminal-recovery'
export const TERMINAL_ACK_CHANNEL = 'desktop:terminal-ack'
export const TERMINAL_DAEMON_STATUS_CHANNEL = 'desktop:terminal-daemon-status'
export const TERMINAL_DAEMON_STOP_STALE_CHANNEL = 'desktop:terminal-daemon-stop-stale'
export const TERMINAL_DAEMON_STOP_CHANNEL = 'desktop:terminal-daemon-stop'
export const TERMINAL_DATA_EVENT = 'desktop:terminal-data'
export const TERMINAL_EXIT_EVENT = 'desktop:terminal-exit'
export const TERMINAL_DAEMON_STATUS_EVENT = 'desktop:terminal-daemon-status-event'

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
export const TERMINAL_DATA_MAX_CHARS = 64 * 1024
/** 单个恢复画面的字符容量；超出时由守护进程减少回滚部分或明确拒绝。 */
export const TERMINAL_SNAPSHOT_MAX_CHARS = 8 * 1024 * 1024

/** 终端状态：`exited` 的终端记录保留到页面显式关闭，以便标签如实展示退出码。 */
export type TerminalStatus = 'running' | 'exited'

/**
 * 终端快照：重新接回时用来还原画面。`ansi` 是 xterm 序列化结果（含滚动历史与模式恢复序列），
 * `seq` 是画面覆盖的累计输出进度；`deliveryId` 标识本次恢复，旧视图的事件与确认不进入新视图。
 */
export interface TerminalSessionSnapshot {
  readonly id: string
  readonly deliveryId: string
  readonly ansi: string
  readonly cols: number
  readonly rows: number
  readonly status: TerminalStatus
  readonly exitCode: number | null
  readonly seq: number
}

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

/** 逐终端恢复；调用方每次挂载生成新的投递代际。 */
export interface TerminalSnapshotRequest {
  readonly id: string
  readonly deliveryId: string
}
export interface TerminalRecoveryRequest extends TerminalSnapshotRequest {
  readonly action: 'ready' | 'detach'
}
/** 累计确认只能前进，且必须属于当前投递代际。 */
export interface TerminalAckRequest extends TerminalSnapshotRequest {
  readonly seqEnd: number
}

export interface TerminalDataEvent {
  readonly id: string
  readonly deliveryId: string
  readonly chunk: string
  /** 本段字符数，用于判断累计输出进度是否连续。 */
  readonly chars: number
  /** 该段覆盖到的累计输出进度；解析完成后按代际原样回报。 */
  readonly seqEnd: number
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
  /** 终端守护进程不可用（未安装、启动失败或协议版本不符）；终端功能整体不可用。 */
  | 'TERMINAL_DAEMON_UNAVAILABLE'

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

export type TerminalSnapshotsResult =
  | { readonly ok: true; readonly data: { readonly snapshot: TerminalSessionSnapshot } }
  | { readonly ok: false; readonly error: TerminalError }

/**
 * 守护进程状态：`stale` 表示存在一个协议版本不符的旧守护进程，它持有的终端当前版本接不回来。
 * 结束它需要用户显式操作——静默杀掉会中断其中仍在运行的命令。
 */
export interface TerminalDaemonStatus {
  readonly connected: boolean
  readonly protocolVersion: number | null
  readonly pid: number | null
  readonly startedAt: number | null
  readonly sessionCount: number
  readonly runningCount: number
  readonly restoredCount: number
  readonly stale: { readonly pid: number; readonly protocolVersion: number } | null
}

export type TerminalDaemonStatusResult =
  | { readonly ok: true; readonly data: TerminalDaemonStatus }
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
  /** 读取一个终端的受限快照；解析完成后必须确认恢复，才能开启实时投递。 */
  readonly fetchTerminalSnapshots: (request: TerminalSnapshotRequest) => Promise<TerminalSnapshotsResult>
  readonly recoverTerminal: (request: TerminalRecoveryRequest) => Promise<TerminalCommandResult>
  /** 关闭全部终端（含其他项目）；用于清理常驻会话。 */
  readonly closeAllTerminals: () => Promise<TerminalCommandResult>
  /** 读取守护进程状态；不可用时也回成功结果，用 `connected` 表达。 */
  readonly getTerminalDaemonStatus: () => Promise<TerminalDaemonStatusResult>
  /** 结束协议版本不符的旧守护进程及其全部终端；只在用户显式操作时调用。 */
  readonly stopStaleTerminalDaemon: () => Promise<TerminalCommandResult>
  /** 停止当前守护进程（含全部终端）；用于释放被终端占用的文件，下次开终端会重新拉起。 */
  readonly stopTerminalDaemon: () => Promise<TerminalCommandResult>
  /** 订阅守护进程状态变化；返回释放函数，页面卸载时必须调用。 */
  readonly onTerminalDaemonStatus: (listener: (status: TerminalDaemonStatus) => void) => () => void
  /** 回报当前代际的累计已消费进度；重复确认无副作用。 */
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
  'TERMINAL_LIMIT_REACHED',
  'TERMINAL_DAEMON_UNAVAILABLE'
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
    && isTerminalId(value.deliveryId)
    && typeof value.chunk === 'string'
    && value.chunk.length <= TERMINAL_DATA_MAX_CHARS
    && typeof value.chars === 'number'
    && Number.isInteger(value.chars)
    && value.chars >= 0
    && value.chars === value.chunk.length
    && typeof value.seqEnd === 'number'
    && Number.isInteger(value.seqEnd)
    && value.seqEnd >= value.chars
}

/** 快照校验：`seq` 必须与已下发量同口径，非整数或负数会让页面的重复丢弃判定失效。 */
export function isTerminalSessionSnapshot(value: unknown): value is TerminalSessionSnapshot {
  if (!isRecord(value)) return false
  return isTerminalId(value.id)
    && isTerminalId(value.deliveryId)
    && typeof value.ansi === 'string'
    && value.ansi.length <= TERMINAL_SNAPSHOT_MAX_CHARS
    && isDimension(value.cols)
    && isDimension(value.rows)
    && typeof value.status === 'string'
    && TERMINAL_STATUSES.includes(value.status)
    && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
    && typeof value.seq === 'number'
    && Number.isInteger(value.seq)
    && value.seq >= 0
}

export function isTerminalSnapshotsResult(value: unknown): value is TerminalSnapshotsResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    const data = value.data
    return isRecord(data) && isTerminalSessionSnapshot(data.snapshot)
  }
  if (value.ok !== false) return false
  return isTerminalError(value.error)
}

export function isTerminalDaemonStatus(value: unknown): value is TerminalDaemonStatus {
  if (!isRecord(value)) return false
  const stale = value.stale
  const staleValid = stale === null || (isRecord(stale)
    && typeof stale.pid === 'number'
    && Number.isInteger(stale.pid)
    && typeof stale.protocolVersion === 'number'
    && Number.isInteger(stale.protocolVersion))
  return typeof value.connected === 'boolean'
    && (value.protocolVersion === null || typeof value.protocolVersion === 'number')
    && (value.pid === null || (typeof value.pid === 'number' && Number.isInteger(value.pid)))
    && (value.startedAt === null || typeof value.startedAt === 'number')
    && typeof value.sessionCount === 'number'
    && typeof value.runningCount === 'number'
    && typeof value.restoredCount === 'number'
    && staleValid
}

export function isTerminalDaemonStatusResult(value: unknown): value is TerminalDaemonStatusResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isTerminalDaemonStatus(value.data)
  if (value.ok !== false) return false
  return isTerminalError(value.error)
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

export function isTerminalSnapshotRequest(value: unknown): value is TerminalSnapshotRequest {
  return isRecord(value) && Object.keys(value).every((key) => key === 'id' || key === 'deliveryId')
    && isTerminalId(value.id) && isTerminalId(value.deliveryId)
}
export function isTerminalRecoveryRequest(value: unknown): value is TerminalRecoveryRequest {
  return isRecord(value) && Object.keys(value).every((key) => key === 'id' || key === 'deliveryId' || key === 'action')
    && isTerminalId(value.id) && isTerminalId(value.deliveryId) && (value.action === 'ready' || value.action === 'detach')
}
export function isTerminalAckRequest(value: unknown): value is TerminalAckRequest {
  return isRecord(value) && Object.keys(value).every((key) => key === 'id' || key === 'deliveryId' || key === 'seqEnd')
    && isTerminalId(value.id) && isTerminalId(value.deliveryId)
    && typeof value.seqEnd === 'number' && Number.isSafeInteger(value.seqEnd) && value.seqEnd >= 0
}
