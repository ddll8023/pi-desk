/** 终端守护进程的版本化本地协议；快照逐终端分块读取，页面确认恢复完成后才开启实时投递。 */
import type { TerminalSessionInfo, TerminalSessionSnapshot } from './terminal-api'
import { TERMINAL_DATA_MAX_CHARS, TERMINAL_DIMENSION_MIN, TERMINAL_DIMENSION_MAX, TERMINAL_TITLE_MAX_CHARS, TERMINAL_WRITE_MAX_CHARS } from './terminal-api'
export { TERMINAL_SNAPSHOT_MAX_CHARS } from './terminal-api'

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 2
export const TERMINAL_DAEMON_ENTRY_FILE = 'index.cjs'
export const TERMINAL_DAEMON_DIR_NAME = 'terminal-daemon'
export const TERMINAL_DAEMON_HISTORY_DIR_NAME = 'history'
export const TERMINAL_DAEMON_SESSIONS_FILE = 'sessions.json'
export const TERMINAL_DAEMON_TOKEN_MAX_CHARS = 256
/** 构建标识是入口文件的 mtime 与大小；限制长度避免 pid 文件塞入任意文本。 */
export const TERMINAL_DAEMON_BUILD_ID_MAX_CHARS = 96
/** 为输入的 JSON 转义留出空间；输出和快照另按较小的块传送。 */
export const TERMINAL_DAEMON_FRAME_MAX_CHARS = 4 * 1024 * 1024
export const TERMINAL_DAEMON_HANDSHAKE_TIMEOUT_MS = 5_000
export const TERMINAL_DAEMON_REQUEST_TIMEOUT_MS = 15_000
export const TERMINAL_SNAPSHOT_CHUNK_CHARS = TERMINAL_DATA_MAX_CHARS
export const TERMINAL_RECOVERY_TIMEOUT_MS = 30_000

export interface TerminalDaemonStatusData {
  readonly protocolVersion: number
  readonly pid: number
  readonly startedAt: number
  /** 启动该进程的入口构建标识；读不到入口文件时为 null，调用方据此跳过构建比对。 */
  readonly buildId: string | null
  readonly sessionCount: number
  readonly runningCount: number
  readonly restoredCount: number
}

export interface TerminalSnapshotHeader extends Omit<TerminalSessionSnapshot, 'ansi'> {
  readonly totalChars: number
}

export type TerminalDaemonNotice =
  | { readonly type: 'ack'; readonly id: string; readonly deliveryId: string; readonly seqEnd: number }
  | { readonly type: 'detach'; readonly id: string; readonly deliveryId: string }
  | { readonly type: 'reset-delivery' }

export type TerminalDaemonRequest = TerminalDaemonNotice
  | { readonly type: 'status' }
  | { readonly type: 'list'; readonly projectPath: string | null }
  | { readonly type: 'create'; readonly projectPath: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'write'; readonly id: string; readonly data: string }
  | { readonly type: 'resize'; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'rename'; readonly id: string; readonly title: string }
  | { readonly type: 'close'; readonly id: string }
  | { readonly type: 'close-all' }
  | { readonly type: 'snapshot-begin'; readonly id: string; readonly deliveryId: string }
  | { readonly type: 'snapshot-read'; readonly id: string; readonly deliveryId: string; readonly offset: number }
  | { readonly type: 'snapshot-ready'; readonly id: string; readonly deliveryId: string }
  | { readonly type: 'shutdown' }

export interface TerminalDaemonReplyData {
  readonly status: TerminalDaemonStatusData
  readonly list: readonly TerminalSessionInfo[]
  readonly create: TerminalSessionInfo
  readonly 'snapshot-begin': TerminalSnapshotHeader
  readonly 'snapshot-read': { readonly chunk: string; readonly nextOffset: number }
  readonly 'snapshot-ready': null
  readonly write: null
  readonly resize: null
  readonly rename: null
  readonly close: null
  readonly 'close-all': null
  readonly ack: null
  readonly detach: null
  readonly 'reset-delivery': null
  readonly shutdown: null
}
export type TerminalDaemonRequestType = TerminalDaemonRequest['type']
export interface TerminalDaemonHelloFrame {
  readonly hello: { readonly protocolVersion: number; readonly token: string }
}
export interface TerminalDaemonRequestFrame {
  readonly request: string
  readonly body: TerminalDaemonRequest
}
export type TerminalDaemonReplyFrame =
  | { readonly reply: string; readonly ok: true; readonly data: unknown }
  | { readonly reply: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
export type TerminalDaemonEventFrame =
  | { readonly event: 'data'; readonly id: string; readonly deliveryId: string; readonly chunk: string; readonly seqEnd: number }
  | { readonly event: 'exit'; readonly id: string; readonly exitCode: number }
export type TerminalDaemonFrame = TerminalDaemonHelloFrame | TerminalDaemonRequestFrame
  | TerminalDaemonReplyFrame | TerminalDaemonEventFrame | { readonly notice: TerminalDaemonNotice }

export function encodeTerminalDaemonFrame(frame: TerminalDaemonFrame): string {
  const line = JSON.stringify(frame)
  if (line.length > TERMINAL_DAEMON_FRAME_MAX_CHARS) throw new Error('终端通信帧超过容量限制。')
  return `${line}\n`
}

export function parseTerminalDaemonFrame(line: string): TerminalDaemonFrame | null {
  if (line === '' || line.length > TERMINAL_DAEMON_FRAME_MAX_CHARS) return null
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!isRecord(value)) return null
  if ('hello' in value) {
    const hello = value.hello
    return onlyKeys(value, ['hello']) && isRecord(hello)
      && onlyKeys(hello, ['protocolVersion', 'token']) && isCount(hello.protocolVersion)
      && typeof hello.token === 'string' && hello.token !== '' && hello.token.length <= TERMINAL_DAEMON_TOKEN_MAX_CHARS
      ? value as unknown as TerminalDaemonHelloFrame : null
  }
  if ('request' in value) {
    return onlyKeys(value, ['request', 'body']) && isId(value.request) && isTerminalDaemonRequest(value.body)
      ? value as unknown as TerminalDaemonRequestFrame : null
  }
  if ('notice' in value) {
    const body = value.notice
    return onlyKeys(value, ['notice']) && isTerminalDaemonRequest(body)
      && (body.type === 'ack' || body.type === 'detach' || body.type === 'reset-delivery')
      ? { notice: body } : null
  }
  if ('reply' in value) {
    if (!onlyKeys(value, ['reply', 'ok', 'data', 'error']) || !isId(value.reply)) return null
    if (value.ok === true && 'data' in value) return value as unknown as TerminalDaemonReplyFrame
    const error = value.error
    return value.ok === false && isRecord(error) && onlyKeys(error, ['code', 'message'])
      && typeof error.code === 'string' && typeof error.message === 'string'
      ? value as unknown as TerminalDaemonReplyFrame : null
  }
  if (value.event === 'data') {
    return onlyKeys(value, ['event', 'id', 'deliveryId', 'chunk', 'seqEnd']) && isId(value.id) && isId(value.deliveryId)
      && typeof value.chunk === 'string' && value.chunk.length <= TERMINAL_SNAPSHOT_CHUNK_CHARS
      && isCount(value.seqEnd) && value.seqEnd >= value.chunk.length
      ? value as unknown as TerminalDaemonEventFrame : null
  }
  if (value.event === 'exit') {
    return onlyKeys(value, ['event', 'id', 'exitCode']) && isId(value.id)
      && typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)
      ? value as unknown as TerminalDaemonEventFrame : null
  }
  return null
}

export function isTerminalDaemonRequest(value: unknown): value is TerminalDaemonRequest {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'status': case 'close-all': case 'reset-delivery': case 'shutdown':
      return onlyKeys(value, ['type'])
    case 'list':
      return onlyKeys(value, ['type', 'projectPath']) && (value.projectPath === null || isPath(value.projectPath))
    case 'create':
      return onlyKeys(value, ['type', 'projectPath', 'cols', 'rows']) && isPath(value.projectPath)
        && isDimension(value.cols) && isDimension(value.rows)
    case 'write':
      return onlyKeys(value, ['type', 'id', 'data']) && isId(value.id)
        && typeof value.data === 'string' && value.data.length <= TERMINAL_WRITE_MAX_CHARS
    case 'rename':
      return onlyKeys(value, ['type', 'id', 'title']) && isId(value.id) && isTitle(value.title)
    case 'resize':
      return onlyKeys(value, ['type', 'id', 'cols', 'rows']) && isId(value.id)
        && isDimension(value.cols) && isDimension(value.rows)
    case 'close':
      return onlyKeys(value, ['type', 'id']) && isId(value.id)
    case 'snapshot-begin': case 'snapshot-ready': case 'detach':
      return onlyKeys(value, ['type', 'id', 'deliveryId']) && isId(value.id) && isId(value.deliveryId)
    case 'snapshot-read':
      return onlyKeys(value, ['type', 'id', 'deliveryId', 'offset']) && isId(value.id) && isId(value.deliveryId) && isCount(value.offset)
    case 'ack':
      return onlyKeys(value, ['type', 'id', 'deliveryId', 'seqEnd']) && isId(value.id) && isId(value.deliveryId) && isCount(value.seqEnd)
    default: return false
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function isId(value: unknown): value is string { return typeof value === 'string' && value !== '' && value.length <= 128 }
/** 标题用于展示与元数据落盘；空串表示清除用户命名，回退到程序上报或 shell 默认名。 */
function isTitle(value: unknown): value is string { return typeof value === 'string' && value.length <= TERMINAL_TITLE_MAX_CHARS }
function isPath(value: unknown): boolean { return typeof value === 'string' && value !== '' && value.length <= 4096 }
function isDimension(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value >= TERMINAL_DIMENSION_MIN && value <= TERMINAL_DIMENSION_MAX }
function isCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
