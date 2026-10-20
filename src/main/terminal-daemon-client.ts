/**
 * 主进程侧的终端守护进程客户端：负责把守护进程拉起来、连上去、按帧收发，并在断开后按需重连。
 *
 * 守护进程与应用解耦，所以这里不做「应用退出即关闭」：只在应用收尾时断开连接，进程与会话继续运行。
 * 连接是按需建立的——第一次终端操作才拉起守护进程，避免没用到终端的会话也常驻一个进程。
 *
 * 拉起方式是脱离当前进程的独立进程：只有真正脱离，应用退出（含崩溃）后终端才会继续运行。Windows 上
 * 需要 `detached` 才能让子进程活过父进程；若宿主把应用放进带 kill-on-close 的作业对象，脱离会失败，
 * 此时终端会随应用退出——这是需要在目标机器上实测确认的前提。
 *
 * 边界：只做传输与生命周期，不解析终端语义；项目路径校验、错误文案与页面契约都在调用方。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import { app } from 'electron'
import {
  TERMINAL_DAEMON_DIR_NAME,
  TERMINAL_DAEMON_ENTRY_FILE,
  TERMINAL_DAEMON_FRAME_MAX_CHARS,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  TERMINAL_DAEMON_REQUEST_TIMEOUT_MS,
  encodeTerminalDaemonFrame,
  parseTerminalDaemonFrame
} from '../shared/terminal-daemon-protocol'
import type {
  TerminalDaemonReplyData,
  TerminalDaemonRequest,
  TerminalDaemonRequestType
} from '../shared/terminal-daemon-protocol'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal-api'
import { terminateProcessTree } from './process-tree-termination'
import {
  isProcessAlive,
  listOtherVersionDaemons,
  readTokenFile,
  removeOwnedFile,
  resolveDaemonPaths
} from '../terminal-daemon/endpoint'
import type { TerminalDaemonPaths } from '../terminal-daemon/endpoint'

/** 连接建立后的等待上限：守护进程要恢复历史，比普通连接慢。 */
const CONNECT_TIMEOUT_MS = 15_000

/** 连接重试间隔；守护进程刚拉起时端点还不存在。 */
const CONNECT_RETRY_MS = 120

/** 崩溃环保护：这段时间内最多拉起这么多次，避免守护进程启动即崩时无限重启。 */
const SPAWN_WINDOW_MS = 60_000
const SPAWN_MAX_ATTEMPTS = 3

/** 单个请求的结果；错误码与协议/页面契约同名。 */
export type TerminalDaemonResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** 已连接守护进程的自报信息；会话计数由 `status` 请求单独取。 */
export interface TerminalDaemonConnection {
  readonly protocolVersion: number
  readonly pid: number
  readonly startedAt: number
}

export interface TerminalDaemonClientOptions {
  /** 输出事件；没有页面接收时由调用方决定丢弃还是保留。 */
  readonly onData: (event: TerminalDataEvent) => void
  readonly onExit: (event: TerminalExitEvent) => void
  /** 连接建立或断开后通知；用于把状态变化推给页面。 */
  readonly onConnectionChange?: (connected: boolean) => void
}

export class TerminalDaemonClient {
  private socket: Socket | null = null
  private buffer = ''
  private pending = new Map<string, {
    readonly resolve: (result: TerminalDaemonResult<unknown>) => void
    readonly timer: NodeJS.Timeout
  }>()
  private connecting: Promise<TerminalDaemonResult<void>> | null = null
  private connection: TerminalDaemonConnection | null = null
  private spawnTimes: number[] = []
  /** 最近一次启动失败的诊断尾巴；用于把真实原因带给页面。 */
  private lastSpawnError: string | null = null
  /** 已显式断开（应用收尾）：后续请求不再自动拉起守护进程。 */
  private disposed = false
  /** 已解析的运行目录与端点；首次使用时才解析，见 `resolvePaths`。 */
  private resolvedPaths: TerminalDaemonPaths | null = null
  private readonly entryPath: string

  constructor(private readonly options: TerminalDaemonClientOptions) {
    this.entryPath = resolve(__dirname, '..', 'terminal-daemon', TERMINAL_DAEMON_ENTRY_FILE)
  }

  /**
   * 运行目录首次使用时才解析：本类在模块顶层被构造，早于便携版把 userData 改到程序目录，
   * 构造函数里就读 `app.getPath('userData')` 会拿到系统默认位置，便携版与开发态会共用同一端点。
   */
  private get paths(): TerminalDaemonPaths {
    if (this.resolvedPaths === null) {
      const runtimeDir = resolve(app.getPath('userData'), TERMINAL_DAEMON_DIR_NAME)
      this.resolvedPaths = resolveDaemonPaths(runtimeDir, TERMINAL_DAEMON_PROTOCOL_VERSION)
    }
    return this.resolvedPaths
  }

  /** 是否已连接；断开后下一次请求会自动重连。 */
  get connected(): boolean {
    return this.socket !== null && this.connection !== null
  }

  get info(): TerminalDaemonConnection | null {
    return this.connection
  }

  /** 其他协议版本留下的守护进程；进程已退出或记录失效时返回 null。 */
  staleDaemon(): { readonly pid: number; readonly protocolVersion: number } | null {
    for (const record of listOtherVersionDaemons(this.paths.runtimeDir, TERMINAL_DAEMON_PROTOCOL_VERSION)) {
      if (isProcessAlive(record.pid)) {
        return { pid: record.pid, protocolVersion: record.protocolVersion }
      }
      // 进程已不在：清掉这条失效记录，避免一直提示用户。
      removeOwnedFile(record.file)
    }
    return null
  }

  /** 结束协议版本不符的旧守护进程及其终端；只在用户显式操作时调用。 */
  stopStaleDaemon(): boolean {
    const stale = this.staleDaemon()
    if (stale === null) return true
    const target = { pid: stale.pid, kill: () => true } as unknown as ChildProcess
    terminateProcessTree(target, 'SIGKILL')
    removeOwnedFile(resolveDaemonPaths(this.paths.runtimeDir, stale.protocolVersion).pidFile)
    return true
  }

  /** 发一个请求；连接不可用时先拉起并连接。 */
  async request<T extends TerminalDaemonRequestType>(
    body: TerminalDaemonRequest & { readonly type: T }
  ): Promise<TerminalDaemonResult<TerminalDaemonReplyData[T]>> {
    const ready = await this.ensureConnected()
    if (!ready.ok) return ready
    const result = await this.send(this.socket, body)
    if (!result.ok) return result
    return { ok: true, data: result.data as TerminalDaemonReplyData[T] }
  }

  /** 断开连接；终端与守护进程继续运行。应用收尾时调用。 */
  disconnect(): void {
    this.disposed = true
    this.teardown()
  }

  /** 停止守护进程并结束它的全部终端；用于释放被终端占用的文件。 */
  async stopDaemon(): Promise<TerminalDaemonResult<null>> {
    if (!this.connected) return { ok: true, data: null }
    const closed = await this.request({ type: 'close-all' })
    if (!closed.ok) return closed
    const stopped = await this.request({ type: 'shutdown' })
    this.teardown()
    return stopped
  }

  /** 只在已连接时发送，不建立连接；用于 ACK 这类丢了也不影响正确性的请求。 */
  sendIfConnected(body: TerminalDaemonRequest): void {
    if (this.socket === null) return
    void this.send(this.socket, body)
  }

  /** 建立连接：先试已有守护进程，连不上再拉起一个。 */
  private ensureConnected(): Promise<TerminalDaemonResult<void>> {
    if (this.disposed) {
      return Promise.resolve({
        ok: false,
        error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: '终端守护进程连接已关闭。' }
      })
    }
    if (this.connected) return Promise.resolve({ ok: true, data: undefined })
    if (this.connecting !== null) return this.connecting
    this.connecting = this.connectOrSpawn().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectOrSpawn(): Promise<TerminalDaemonResult<void>> {
    const existing = await this.connectOnce()
    if (existing.ok) return existing
    const spawned = this.spawnDaemon()
    if (!spawned.ok) return spawned
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const attempt = await this.connectOnce()
      if (attempt.ok) return attempt
      await delay(CONNECT_RETRY_MS)
    }
    return {
      ok: false,
      error: {
        code: 'TERMINAL_DAEMON_UNAVAILABLE',
        message: this.lastSpawnError === null
          ? '终端守护进程未能启动。'
          : `终端守护进程未能启动：${this.lastSpawnError}`
      }
    }
  }

  /** 单次连接尝试：读 token、连端点、发握手并确认对端状态；任一步失败都清理干净。 */
  private async connectOnce(): Promise<TerminalDaemonResult<void>> {
    const token = readTokenFile(this.paths.tokenFile)
    if (token === null) {
      return { ok: false, error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: '终端守护进程尚未就绪。' } }
    }
    const socket = await this.openSocket()
    if (socket === null) {
      return { ok: false, error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: '终端守护进程未监听。' } }
    }
    this.attach(socket)
    try {
      socket.write(encodeTerminalDaemonFrame({
        hello: { protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION, token }
      }))
    } catch (error) {
      this.teardown()
      return { ok: false, error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: describe(error, '终端握手失败') } }
    }
    // 握手后直接用这条连接确认对端：走 request 会再次触发连接流程。
    const status = await this.send(socket, { type: 'status' })
    if (!status.ok) {
      this.teardown()
      return { ok: false, error: status.error }
    }
    const data = status.data as TerminalDaemonReplyData['status']
    this.connection = { protocolVersion: data.protocolVersion, pid: data.pid, startedAt: data.startedAt }
    this.options.onConnectionChange?.(true)
    return { ok: true, data: undefined }
  }

  /** 在已连接的套接字上发一个请求并等响应；不建立连接，也不重试。 */
  private send(
    socket: Socket | null,
    body: TerminalDaemonRequest
  ): Promise<TerminalDaemonResult<unknown>> {
    if (socket === null) {
      return Promise.resolve({
        ok: false,
        error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: '终端守护进程未连接。' }
      })
    }
    const requestId = randomUUID()
    return new Promise<TerminalDaemonResult<unknown>>((resolveRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolveRequest({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: '终端守护进程响应超时。' }
        })
      }, TERMINAL_DAEMON_REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve: resolveRequest, timer })
      try {
        socket.write(encodeTerminalDaemonFrame({ request: requestId, body }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolveRequest({
          ok: false,
          error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: describe(error, '发送终端请求失败') }
        })
      }
    })
  }

  /** 打开套接字；端点不存在或拒绝连接时返回 null。 */
  private openSocket(): Promise<Socket | null> {
    return new Promise<Socket | null>((resolveSocket) => {
      const socket = connect(this.paths.endpoint)
      const onError = (): void => {
        socket.destroy()
        resolveSocket(null)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.setNoDelay(true)
        socket.setEncoding('utf8')
        resolveSocket(socket)
      })
    })
  }

  /** 接管连接：注册读帧与断开处理。 */
  private attach(socket: Socket): void {
    this.socket = socket
    this.buffer = ''
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', () => this.teardown())
    socket.on('close', () => this.teardown())
  }

  /** 读帧：一行一帧，响应交给等待者，事件交给调用方；非法帧直接断开。 */
  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > TERMINAL_DAEMON_FRAME_MAX_CHARS) {
      this.teardown()
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.onLine(line)
      if (this.socket === null) return
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    const frame = parseTerminalDaemonFrame(line)
    if (frame === null) {
      this.teardown()
      return
    }
    if ('reply' in frame) {
      const waiter = this.pending.get(frame.reply)
      if (waiter === undefined) return
      this.pending.delete(frame.reply)
      clearTimeout(waiter.timer)
      waiter.resolve(frame.ok
        ? { ok: true, data: frame.data }
        : { ok: false, error: { code: frame.error.code, message: frame.error.message } })
      return
    }
    if ('event' in frame) {
      if (frame.event === 'data') {
        this.options.onData({ id: frame.id, chunk: frame.chunk, chars: frame.chunk.length, seqEnd: frame.seqEnd })
      } else {
        this.options.onExit({ id: frame.id, exitCode: frame.exitCode })
      }
      return
    }
    // 守护进程不该发握手或请求帧：按协议失配处理。
    this.teardown()
  }

  /** 拉起守护进程：脱离当前进程，输出只留一小段用于诊断。 */
  private spawnDaemon(): TerminalDaemonResult<void> {
    const now = Date.now()
    this.spawnTimes = this.spawnTimes.filter((time) => now - time < SPAWN_WINDOW_MS)
    if (this.spawnTimes.length >= SPAWN_MAX_ATTEMPTS) {
      return {
        ok: false,
        error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: '终端守护进程反复启动失败，请检查日志。' }
      }
    }
    this.spawnTimes.push(now)
    // 不在这里删旧 token：它可能属于一个仍在运行的守护进程，删掉会让那个实例再也连不上。
    // 新实例启动时会先写 token 再开始监听，而连接重试每次都重读 token，因此旧值不会被误用。
    try {
      const child = spawn(process.execPath, [this.entryPath, `--runtime-dir=${this.paths.runtimeDir}`], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true
      })
      let stderrTail = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000)
        this.lastSpawnError = stderrTail.trim().split('\n').pop() ?? null
      })
      child.on('error', (error) => {
        this.lastSpawnError = describe(error, '启动终端守护进程失败')
      })
      child.unref()
      return { ok: true, data: undefined }
    } catch (error) {
      return { ok: false, error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: describe(error, '启动终端守护进程失败') } }
    }
  }

  /** 断开并拒绝所有等待中的请求；终端本身不受影响。 */
  private teardown(): void {
    const wasConnected = this.connection !== null
    const socket = this.socket
    this.socket = null
    this.connection = null
    this.buffer = ''
    for (const [requestId, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.resolve({
        ok: false,
        error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message: '与终端守护进程的连接已断开。' }
      })
      this.pending.delete(requestId)
    }
    if (socket !== null) {
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.destroy()
    }
    if (wasConnected) this.options.onConnectionChange?.(false)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function describe(error: unknown, prefix: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${prefix}：${detail}`
}
