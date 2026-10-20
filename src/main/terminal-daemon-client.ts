/** 主进程终端客户端：仅显式创建允许启动，状态读取不启动；ACK 合并为单向累计通知，停止不触发重连。 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { resolve } from 'node:path'
import { app } from 'electron'
import {
  TERMINAL_DAEMON_DIR_NAME, TERMINAL_DAEMON_ENTRY_FILE, TERMINAL_DAEMON_FRAME_MAX_CHARS,
  TERMINAL_DAEMON_PROTOCOL_VERSION, TERMINAL_DAEMON_REQUEST_TIMEOUT_MS,
  encodeTerminalDaemonFrame, parseTerminalDaemonFrame
} from '../shared/terminal-daemon-protocol'
import type {
  TerminalDaemonNotice, TerminalDaemonReplyData, TerminalDaemonRequest, TerminalDaemonRequestType
} from '../shared/terminal-daemon-protocol'
import type { TerminalDataEvent, TerminalExitEvent } from '../shared/terminal-api'
import { terminateProcessTree } from './process-tree-termination'
import { isProcessAlive, listOtherVersionDaemons, readPidFile, readTokenFile, removeOwnedFile, resolveDaemonPaths } from '../terminal-daemon/endpoint'
import type { TerminalDaemonPaths } from '../terminal-daemon/endpoint'

const CONNECT_TIMEOUT_MS = 15_000
const CONNECT_RETRY_MS = 120
const SPAWN_WINDOW_MS = 60_000
const SPAWN_MAX_ATTEMPTS = 3
const MAX_PENDING_REQUESTS = 128
const SOCKET_BACKLOG_BYTES = 1024 * 1024
export type TerminalDaemonResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
export interface TerminalDaemonConnection {
  readonly protocolVersion: number
  readonly pid: number
  readonly startedAt: number
}
export interface TerminalDaemonClientOptions {
  readonly onData: (event: TerminalDataEvent) => void
  readonly onExit: (event: TerminalExitEvent) => void
  readonly onConnectionChange?: (connected: boolean) => void
}
function unavailable(message = '终端守护进程未连接。'): TerminalDaemonResult<never> {
  return { ok: false, error: { code: 'TERMINAL_DAEMON_UNAVAILABLE', message } }
}
export class TerminalDaemonClient {
  private socket: Socket | null = null
  private buffer = ''
  private readonly pending = new Map<string, {
    readonly resolve: (result: TerminalDaemonResult<unknown>) => void
    readonly timer: NodeJS.Timeout
  }>()
  private readonly notices = new Map<string, TerminalDaemonNotice>()
  private connecting: Promise<TerminalDaemonResult<void>> | null = null
  private spawnRequested = false
  private connection: TerminalDaemonConnection | null = null
  private spawnTimes: number[] = []
  private lastSpawnError: string | null = null
  private disposed = false
  private stopping = false
  private manuallyStopped = false
  private resolvedPaths: TerminalDaemonPaths | null = null
  private readonly entryPath = resolve(__dirname, '..', 'terminal-daemon', TERMINAL_DAEMON_ENTRY_FILE)
  constructor(private readonly options: TerminalDaemonClientOptions) {}

  /** 便携版设置 userData 后才解析，避免模块顶层构造时误用系统目录。 */
  private get paths(): TerminalDaemonPaths {
    this.resolvedPaths ??= resolveDaemonPaths(resolve(app.getPath('userData'), TERMINAL_DAEMON_DIR_NAME), TERMINAL_DAEMON_PROTOCOL_VERSION)
    return this.resolvedPaths
  }
  get connected(): boolean { return this.socket !== null && this.connection !== null }
  get info(): TerminalDaemonConnection | null { return this.connection }
  get hasLiveProcess(): boolean {
    const record = readPidFile(this.paths.pidFile)
    return record !== null && isProcessAlive(record.pid)
  }
  staleDaemon(): { readonly pid: number; readonly protocolVersion: number } | null {
    for (const record of listOtherVersionDaemons(this.paths.runtimeDir, TERMINAL_DAEMON_PROTOCOL_VERSION)) {
      if (isProcessAlive(record.pid)) return { pid: record.pid, protocolVersion: record.protocolVersion }
      removeOwnedFile(record.file)
    }
    return null
  }
  stopStaleDaemon(): boolean {
    const stale = this.staleDaemon()
    if (stale === null) return true
    terminateProcessTree({ pid: stale.pid, kill: () => true } as unknown as ChildProcess, 'SIGKILL')
    // 不抢删活实例的所有权资料；由它的收尾或下次死进程识别清理。
    return true
  }

  async request<T extends TerminalDaemonRequestType>(
    body: TerminalDaemonRequest & { readonly type: T }, startIfMissing = false
  ): Promise<TerminalDaemonResult<TerminalDaemonReplyData[T]>> {
    if (this.stopping || (this.manuallyStopped && !startIfMissing)) return unavailable('终端守护进程已停止。')
    if (startIfMissing) this.manuallyStopped = false
    const ready = await this.ensureConnected(startIfMissing)
    if (!ready.ok) return ready
    const result = await this.send(this.socket, body)
    return result.ok ? { ok: true, data: result.data as TerminalDaemonReplyData[T] } : result
  }
  disconnect(): void { this.disposed = true; this.teardown() }

  async stopDaemon(): Promise<TerminalDaemonResult<null>> {
    this.stopping = true
    this.manuallyStopped = true
    try {
      const ready = await this.ensureConnected(false)
      if (!ready.ok) {
        const record = readPidFile(this.paths.pidFile)
        return record !== null && isProcessAlive(record.pid) ? ready : { ok: true, data: null }
      }
      // shutdown 本身保留历史；close-all 是另外一个明确的删除动作。
      const pid = this.connection?.pid
      const stopped = await this.send(this.socket, { type: 'shutdown' })
      if (!stopped.ok) return stopped
      const deadline = Date.now() + TERMINAL_DAEMON_REQUEST_TIMEOUT_MS
      while (pid !== undefined && isProcessAlive(pid)) {
        if (Date.now() >= deadline) return unavailable('终端守护进程仍在保存历史，尚未确认退出。')
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50))
      }
      return { ok: true, data: null }
    } finally { this.teardown(); this.stopping = false }
  }

  /** 通知按终端和类型合并；累计 ACK 丢掉中间值仍能释放全部已消费额度。 */
  sendIfConnected(body: TerminalDaemonNotice): void {
    if (this.socket === null || this.manuallyStopped || this.disposed) return
    if (body.type === 'reset-delivery') this.notices.clear()
    if (body.type === 'detach') this.notices.delete(`ack:${body.id}`)
    const key = body.type === 'reset-delivery' ? body.type : `${body.type}:${body.id}`
    const previous = this.notices.get(key)
    if (body.type === 'ack' && previous?.type === 'ack' && previous.deliveryId === body.deliveryId && previous.seqEnd > body.seqEnd) return
    this.notices.set(key, body)
    this.flushNotices()
  }
  private flushNotices(): void {
    const socket = this.socket
    if (socket === null || socket.destroyed) return
    const reset = this.notices.get('reset-delivery')
    if (reset !== undefined) {
      this.notices.delete('reset-delivery')
      try { socket.write(encodeTerminalDaemonFrame({ notice: reset })) }
      catch { this.teardown(); return }
    }
    for (const [key, notice] of this.notices) {
      if (socket.writableNeedDrain) return
      this.notices.delete(key)
      try { socket.write(encodeTerminalDaemonFrame({ notice })) }
      catch { this.teardown(); return }
    }
  }

  private ensureConnected(startIfMissing: boolean): Promise<TerminalDaemonResult<void>> {
    if (this.disposed) return Promise.resolve(unavailable('终端连接已关闭。'))
    if (this.connected) return Promise.resolve({ ok: true, data: undefined })
    if (startIfMissing) this.spawnRequested = true
    if (this.connecting !== null) return this.connecting
    this.connecting = this.connectOrSpawn().finally(() => { this.connecting = null; this.spawnRequested = false })
    return this.connecting
  }
  private async connectOrSpawn(): Promise<TerminalDaemonResult<void>> {
    const existing = await this.connectOnce()
    if (existing.ok || !this.spawnRequested || this.manuallyStopped || this.disposed) return existing
    const record = readPidFile(this.paths.pidFile)
    // 存活但暂时忙的实例不能被当成不存在，避免重启风暴及覆盖凭据。
    if (record === null || !isProcessAlive(record.pid)) {
      const spawned = this.spawnDaemon()
      if (!spawned.ok) return spawned
    }
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    while (Date.now() < deadline && !this.disposed && !this.manuallyStopped) {
      const attempt = await this.connectOnce()
      if (attempt.ok) return attempt
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, CONNECT_RETRY_MS))
    }
    return unavailable(this.lastSpawnError === null ? '终端守护进程未能就绪。' : `终端守护进程未能启动：${this.lastSpawnError}`)
  }
  private async connectOnce(): Promise<TerminalDaemonResult<void>> {
    if (this.disposed) return unavailable()
    const token = readTokenFile(this.paths.tokenFile)
    if (token === null) return unavailable()
    const socket = await this.openSocket()
    if (socket === null) return unavailable()
    if (this.disposed) { socket.destroy(); return unavailable() }
    this.attach(socket)
    try { socket.write(encodeTerminalDaemonFrame({ hello: { protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION, token } })) }
    catch { this.teardown(); return unavailable('终端握手失败。') }
    const status = await this.send(socket, { type: 'status' })
    if (!status.ok) { this.teardown(); return status }
    const data = status.data as Partial<TerminalDaemonReplyData['status']> | null
    if (data === null || typeof data !== 'object' || data.protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION
      || typeof data.pid !== 'number' || typeof data.startedAt !== 'number') {
      this.teardown(); return unavailable('终端守护进程状态不合法。')
    }
    this.connection = { protocolVersion: data.protocolVersion, pid: data.pid, startedAt: data.startedAt }
    this.options.onConnectionChange?.(true)
    return { ok: true, data: undefined }
  }

  private send(socket: Socket | null, body: TerminalDaemonRequest): Promise<TerminalDaemonResult<unknown>> {
    if (socket === null || socket.destroyed) return Promise.resolve(unavailable())
    // 导航撤销必须排在新页面的 snapshot-begin 前，不能让控制通知被新请求越过。
    this.flushNotices()
    if (this.socket !== socket) return Promise.resolve(unavailable())
    if (this.pending.size >= MAX_PENDING_REQUESTS || socket.writableLength > SOCKET_BACKLOG_BYTES) {
      return Promise.resolve(unavailable('终端通信繁忙，请稍后重试。'))
    }
    const requestId = randomUUID()
    return new Promise((resolveRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolveRequest(unavailable('终端守护进程响应超时。'))
      }, TERMINAL_DAEMON_REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve: resolveRequest, timer })
      try { socket.write(encodeTerminalDaemonFrame({ request: requestId, body })) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolveRequest(unavailable(error instanceof Error ? error.message : '发送终端请求失败。'))
      }
    })
  }
  private openSocket(): Promise<Socket | null> {
    return new Promise((resolveSocket) => {
      const socket = connect(this.paths.endpoint)
      const timer = setTimeout(() => settle(false), 2000)
      const settle = (ok: boolean): void => {
        clearTimeout(timer)
        socket.off('error', onError)
        socket.off('connect', onConnect)
        if (!ok) { socket.on('error', () => {}); socket.destroy() }
        else { socket.setNoDelay(true); socket.setEncoding('utf8') }
        resolveSocket(ok ? socket : null)
      }
      const onError = (): void => settle(false)
      const onConnect = (): void => settle(true)
      socket.once('error', onError)
      socket.once('connect', onConnect)
    })
  }
  private attach(socket: Socket): void {
    this.socket = socket
    this.buffer = ''
    socket.on('data', (chunk: string) => { if (this.socket === socket) this.onData(chunk) })
    socket.on('error', () => { if (this.socket === socket) this.teardown() })
    socket.on('close', () => { if (this.socket === socket) this.teardown() })
    socket.on('drain', () => { if (this.socket === socket) this.flushNotices() })
  }
  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      if (newline > TERMINAL_DAEMON_FRAME_MAX_CHARS) { this.teardown(); return }
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const frame = parseTerminalDaemonFrame(line)
      if (frame === null) { this.teardown(); return }
      if ('reply' in frame) {
        const waiter = this.pending.get(frame.reply)
        if (waiter !== undefined) {
          this.pending.delete(frame.reply)
          clearTimeout(waiter.timer)
          waiter.resolve(frame.ok ? { ok: true, data: frame.data } : { ok: false, error: frame.error })
        }
      } else if ('event' in frame) {
        if (frame.event === 'data') this.options.onData({ id: frame.id, deliveryId: frame.deliveryId, chunk: frame.chunk, chars: frame.chunk.length, seqEnd: frame.seqEnd })
        else this.options.onExit({ id: frame.id, exitCode: frame.exitCode })
      } else { this.teardown(); return }
      if (this.socket === null) return
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > TERMINAL_DAEMON_FRAME_MAX_CHARS) this.teardown()
  }
  private spawnDaemon(): TerminalDaemonResult<void> {
    const now = Date.now()
    this.spawnTimes = this.spawnTimes.filter((time) => now - time < SPAWN_WINDOW_MS)
    if (this.spawnTimes.length >= SPAWN_MAX_ATTEMPTS) return unavailable('终端守护进程反复启动失败，请检查日志。')
    this.spawnTimes.push(now)
    this.lastSpawnError = null
    try {
      // 不保留 stderr 管道，避免常驻子进程持有应用句柄；诊断由守护进程限量落盘。
      const child = spawn(process.execPath, [this.entryPath, `--runtime-dir=${this.paths.runtimeDir}`], {
        detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true
      })
      child.once('error', (error) => { this.lastSpawnError = error.message })
      child.unref()
      return { ok: true, data: undefined }
    } catch (error) { return unavailable(error instanceof Error ? error.message : '启动终端守护进程失败。') }
  }
  private teardown(): void {
    const wasConnected = this.connection !== null
    const socket = this.socket
    this.socket = null
    this.connection = null
    this.buffer = ''
    this.notices.clear()
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.resolve(unavailable('与终端守护进程的连接已断开。')) }
    this.pending.clear()
    if (socket !== null) { socket.removeAllListeners(); socket.on('error', () => {}); socket.destroy() }
    if (wasConnected) this.options.onConnectionChange?.(false)
  }
}
