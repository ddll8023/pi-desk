/**
 * 内置终端守护进程的本地协议：请求、响应与事件帧，以及两端的帧校验。
 *
 * 守护进程独立于应用进程运行，因此这份协议是跨进程契约：应用退出后它仍持有 PTY 与终端状态，
 * 下次启动按同一端点接回。传输是本地流式套接字（Windows 命名管道 / POSIX Unix socket），
 * 一帧一行 NDJSON：每行一个 JSON 对象，行内不允许换行，因此载荷里的换行必须由 JSON 转义。
 *
 * 连接建立后客户端先发一次 `hello`（协议版本 + token），通过后才允许发请求；服务端拒绝时直接断开，
 * 不回错误帧——认证失败不该给对端任何可区分的额外信息。请求用 `request` 关联响应，事件帧不参与关联。
 *
 * 边界：协议版本与端点名绑定，版本不同就连不上，不做向前兼容；载荷只描述终端语义，不含 shell、
 * 环境变量或工作目录的选择权（这些由守护进程决定）。字符数一律按 UTF-16 码元计，与页面同一口径。
 */
import type { TerminalSessionInfo, TerminalSessionSnapshot } from './terminal-api'

/** 协议版本；改变帧形状、请求集合或事件语义时必须递增，端点名随之改变。 */
export const TERMINAL_DAEMON_PROTOCOL_VERSION = 1

/** 守护进程产物的固定文件名；构建输出到 `out/terminal-daemon/index.cjs`。 */
export const TERMINAL_DAEMON_ENTRY_FILE = 'index.cjs'

/** 守护进程自有的运行目录名（位于 userData 下）；端点、token、pid、元数据与历史都在这里。 */
export const TERMINAL_DAEMON_DIR_NAME = 'terminal-daemon'

/** 会话历史目录名；每个终端一个追加写入的原始输出文件。 */
export const TERMINAL_DAEMON_HISTORY_DIR_NAME = 'history'

/** 会话元数据文件名；守护进程重启后据此恢复终端清单与历史。 */
export const TERMINAL_DAEMON_SESSIONS_FILE = 'sessions.json'

/** token 长度上限；只拒绝明显异常的值，真实比对由守护进程完成。 */
export const TERMINAL_DAEMON_TOKEN_MAX_CHARS = 256

/** 单帧字符上限；超出即视为异常对端，直接断开而不是继续缓冲。 */
export const TERMINAL_DAEMON_FRAME_MAX_CHARS = 16 * 1024 * 1024

/** 握手超时：连接建立后迟迟不发 hello 的对端不算客户端。 */
export const TERMINAL_DAEMON_HANDSHAKE_TIMEOUT_MS = 5_000

/** 单个请求的等待上限；建终端要起 PTY，取快照要等模拟器写完，比普通写入宽松。 */
export const TERMINAL_DAEMON_REQUEST_TIMEOUT_MS = 15_000

/** 守护进程状态：设置页与页面据此展示常驻会话，不暴露端点路径与 token。 */
export interface TerminalDaemonStatusData {
  readonly protocolVersion: number
  /** 守护进程自己的进程号；用于排障，不用于寻址。 */
  readonly pid: number
  /** 守护进程启动时间（毫秒时间戳）。 */
  readonly startedAt: number
  readonly sessionCount: number
  readonly runningCount: number
  /** 由历史恢复、进程已结束的会话数；重启后不为 0 属于正常情况。 */
  readonly restoredCount: number
}

/** 客户端可发的请求；字段与页面契约同名，守护进程不再二次解析项目路径。 */
export type TerminalDaemonRequest =
  | { readonly type: 'status' }
  | { readonly type: 'list'; readonly projectPath: string | null }
  | { readonly type: 'create'; readonly projectPath: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'write'; readonly id: string; readonly data: string }
  | { readonly type: 'resize'; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'close'; readonly id: string }
  | { readonly type: 'close-all' }
  | { readonly type: 'ack'; readonly id: string; readonly chars: number }
  | { readonly type: 'snapshots' }
  | { readonly type: 'reset-delivery' }
  | { readonly type: 'shutdown' }

/** 请求类型与响应的对应关系；表是穷尽 Record，新增请求会在编译期暴露。 */
export interface TerminalDaemonReplyData {
  readonly status: TerminalDaemonStatusData
  readonly list: readonly TerminalSessionInfo[]
  readonly create: TerminalSessionInfo
  readonly snapshots: readonly TerminalSessionSnapshot[]
  readonly write: null
  readonly resize: null
  readonly close: null
  readonly 'close-all': null
  readonly ack: null
  readonly 'reset-delivery': null
  readonly shutdown: null
}

export type TerminalDaemonRequestType = TerminalDaemonRequest['type']

/** 客户端 → 守护进程：握手帧。 */
export interface TerminalDaemonHelloFrame {
  readonly hello: {
    readonly protocolVersion: number
    readonly token: string
  }
}

/** 客户端 → 守护进程：请求帧；`request` 是本次请求的关联标识。 */
export interface TerminalDaemonRequestFrame {
  readonly request: string
  readonly body: TerminalDaemonRequest
}

/** 守护进程 → 客户端：响应帧；`data` 的具体类型由请求类型决定。 */
export type TerminalDaemonReplyFrame =
  | { readonly reply: string; readonly ok: true; readonly data: unknown }
  | { readonly reply: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 守护进程 → 客户端：事件帧。输出与退出只在客户端连接期间下发，不排队等重连。 */
export type TerminalDaemonEventFrame =
  | {
    readonly event: 'data'
    readonly id: string
    readonly chunk: string
    /** 该终端累计已下发的字符数（含本段）；页面据此丢弃快照已覆盖的部分。 */
    readonly seqEnd: number
  }
  | { readonly event: 'exit'; readonly id: string; readonly exitCode: number }

/** 任一方向的帧；解析后由调用方按形状分派。 */
export type TerminalDaemonFrame =
  | TerminalDaemonHelloFrame
  | TerminalDaemonRequestFrame
  | TerminalDaemonReplyFrame
  | TerminalDaemonEventFrame

/** 编码一帧：JSON 压成一行，行尾补 LF；JSON 会转义载荷里的换行，因此一行必然是一帧。 */
export function encodeTerminalDaemonFrame(frame: TerminalDaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/** 解析一行帧；非法 JSON 或形状不符时返回 null，由调用方断开连接。 */
export function parseTerminalDaemonFrame(line: string): TerminalDaemonFrame | null {
  if (line === '' || line.length > TERMINAL_DAEMON_FRAME_MAX_CHARS) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if ('hello' in parsed) return isHelloFrame(parsed) ? { hello: parsed.hello as TerminalDaemonHelloFrame['hello'] } : null
  if ('request' in parsed) {
    if (!isRequestFrame(parsed)) return null
    return { request: parsed.request as string, body: parsed.body as TerminalDaemonRequest }
  }
  if ('reply' in parsed) return isReplyFrame(parsed) ? parsed as unknown as TerminalDaemonReplyFrame : null
  if ('event' in parsed) return isEventFrame(parsed) ? parsed as unknown as TerminalDaemonEventFrame : null
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDimension(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 1000
}

function isId(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && value.length <= 128
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isHelloFrame(value: Record<string, unknown>): boolean {
  const hello = value.hello
  if (!isRecord(hello)) return false
  return Object.keys(hello).every((key) => key === 'protocolVersion' || key === 'token')
    && typeof hello.protocolVersion === 'number'
    && Number.isInteger(hello.protocolVersion)
    && typeof hello.token === 'string'
    && hello.token !== ''
    && hello.token.length <= TERMINAL_DAEMON_TOKEN_MAX_CHARS
}

function isRequestFrame(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => key === 'request' || key === 'body')
    && isId(value.request)
    && isTerminalDaemonRequest(value.body)
}

/** 请求体校验：未知类型或多余字段一律拒绝，避免对端用半合法帧探测实现细节。 */
export function isTerminalDaemonRequest(value: unknown): value is TerminalDaemonRequest {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'status':
      return onlyKeys(value, ['type'])
    case 'list':
      return onlyKeys(value, ['type', 'projectPath'])
        && (value.projectPath === null || (typeof value.projectPath === 'string' && value.projectPath !== ''))
    case 'create':
      return onlyKeys(value, ['type', 'projectPath', 'cols', 'rows'])
        && typeof value.projectPath === 'string'
        && value.projectPath !== ''
        && isDimension(value.cols)
        && isDimension(value.rows)
    case 'write':
      return onlyKeys(value, ['type', 'id', 'data']) && isId(value.id) && typeof value.data === 'string'
    case 'resize':
      return onlyKeys(value, ['type', 'id', 'cols', 'rows'])
        && isId(value.id)
        && isDimension(value.cols)
        && isDimension(value.rows)
    case 'close':
      return onlyKeys(value, ['type', 'id']) && isId(value.id)
    case 'ack':
      return onlyKeys(value, ['type', 'id', 'chars']) && isId(value.id) && isCount(value.chars)
    case 'close-all':
    case 'snapshots':
    case 'reset-delivery':
    case 'shutdown':
      return onlyKeys(value, ['type'])
    default:
      return false
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isReplyFrame(value: Record<string, unknown>): boolean {
  if (!Object.keys(value).every((key) => key === 'reply' || key === 'ok' || key === 'data' || key === 'error')) return false
  if (!isId(value.reply)) return false
  if (value.ok === true) return 'data' in value
  if (value.ok !== false) return false
  const error = value.error
  return isRecord(error)
    && Object.keys(error).every((key) => key === 'code' || key === 'message')
    && typeof error.code === 'string'
    && typeof error.message === 'string'
}

function isEventFrame(value: Record<string, unknown>): boolean {
  if (value.event === 'data') {
    return onlyKeys(value, ['event', 'id', 'chunk', 'seqEnd'])
      && isId(value.id)
      && typeof value.chunk === 'string'
      && isCount(value.seqEnd)
  }
  if (value.event === 'exit') {
    return onlyKeys(value, ['event', 'id', 'exitCode'])
      && isId(value.id)
      && typeof value.exitCode === 'number'
      && Number.isInteger(value.exitCode)
  }
  return false
}
