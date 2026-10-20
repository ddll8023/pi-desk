/**
 * 守护进程的本地服务端：在命名管道 / Unix 域套接字上接受一个客户端，做握手鉴权与请求路由。
 *
 * 同一时刻只服务一个客户端：应用是唯一使用者，单实例锁保证不会有两个应用同时连；新连接进来就替换旧连接，
 * 这样应用异常退出后留下的半开连接不会挡住重连。未通过握手的连接不发任何业务帧，直接断开。
 *
 * 传输按行分帧：一行一帧，超过上限的缓冲视为异常对端并断开，避免对端不发换行就撑爆内存。
 * 事件（输出、退出）只在客户端连接期间下发；没有客户端时事件被丢弃，由会话管理保留缓冲与画面。
 *
 * 边界：这里只做传输、握手与路由，不判断终端状态、不写文件；请求处理与错误文案都在会话管理侧。
 */
import { createServer, connect } from 'node:net'
import type { Server, Socket } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import {
  TERMINAL_DAEMON_FRAME_MAX_CHARS,
  TERMINAL_DAEMON_HANDSHAKE_TIMEOUT_MS,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  encodeTerminalDaemonFrame,
  parseTerminalDaemonFrame
} from '../shared/terminal-daemon-protocol'
import type {
  TerminalDaemonEventFrame,
  TerminalDaemonRequest
} from '../shared/terminal-daemon-protocol'

/** 请求处理结果；错误码由调用方给出，这里只负责回帧。 */
export type TerminalDaemonReply =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface TerminalDaemonServerOptions {
  /** 已解析的端点地址（Windows 命名管道或 POSIX 套接字路径）。 */
  readonly endpoint: string
  /** 本次守护进程实例的握手 token；写入 token 文件供客户端读取。 */
  readonly token: string
  /** 请求处理；抛错由服务端统一转成内部错误回帧。 */
  readonly handle: (request: TerminalDaemonRequest) => Promise<TerminalDaemonReply>
  /** 客户端连接状态变化；会话管理据此决定要不要下发。 */
  readonly onClientChange: (attached: boolean) => void
  /** 记录非致命错误；不中断服务。 */
  readonly onError: (error: unknown) => void
}

export class TerminalDaemonServer {
  private server: Server | null = null
  private client: Socket | null = null
  private buffer = ''
  private handshakeTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly options: TerminalDaemonServerOptions) {}

  /** 是否已有通过握手的客户端；没有时事件不排队，直接丢弃。 */
  get attached(): boolean {
    return this.client !== null
  }

  /** 开始监听；端点上已有存活实例时报错，由调用方决定退出。 */
  async listen(): Promise<void> {
    const server = createServer((socket) => this.accept(socket))
    server.on('error', (error) => this.options.onError(error))
    this.server = server
    try {
      await listenOn(server, this.options.endpoint)
    } catch (error) {
      // POSIX 上上一次异常退出会留下套接字文件：先确认无人监听，再清掉重试。
      // 先探测再删除：若对端能连上，说明是另一个存活实例，删掉它的端点会把它变成“接不上的终端”。
      if (process.platform !== 'win32' && existsSync(this.options.endpoint)) {
        if (await isEndpointAlive(this.options.endpoint)) {
          this.options.onError(error)
          throw error
        }
        try {
          unlinkSync(this.options.endpoint)
        } catch {
          this.options.onError(error)
          throw error
        }
        await listenOn(server, this.options.endpoint)
        return
      }
      throw error
    }
  }

  /** 下发一个事件；没有客户端时返回 false，由调用方保留数据。 */
  sendEvent(frame: TerminalDaemonEventFrame): boolean {
    const client = this.client
    if (client === null || client.destroyed) return false
    try {
      client.write(encodeTerminalDaemonFrame(frame))
      return true
    } catch (error) {
      this.options.onError(error)
      return false
    }
  }

  /** 关闭服务端与当前连接；不删除套接字文件之外的任何东西。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.detachClient()
    const server = this.server
    this.server = null
    if (server === null) return
    server.close()
    if (process.platform !== 'win32') {
      // 退出时留下套接字文件会让下一次启动多一次失败重试；确认属于本实例后再删。
      try {
        unlinkSync(this.options.endpoint)
      } catch {
        // 已被替换或不存在：都不影响退出。
      }
    }
  }

  private accept(socket: Socket): void {
    // 新连接替换旧连接：应用异常退出留下的半开连接不能挡住重连。
    this.detachClient()
    this.client = socket
    this.buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', (error) => {
      this.options.onError(error)
      this.dropClient(socket)
    })
    socket.on('close', () => this.dropClient(socket))
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (this.client === socket) socket.destroy()
    }, TERMINAL_DAEMON_HANDSHAKE_TIMEOUT_MS)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > TERMINAL_DAEMON_FRAME_MAX_CHARS) {
      this.detachClient()
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.onLine(line)
      if (this.client === null) return
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    const frame = parseTerminalDaemonFrame(line)
    if (frame === null) {
      this.detachClient()
      return
    }
    if ('hello' in frame) {
      this.onHello(frame.hello.protocolVersion, frame.hello.token)
      return
    }
    if ('request' in frame) {
      void this.onRequest(frame.request, frame.body)
      return
    }
    // 客户端不该发响应或事件帧：按异常对端处理。
    this.detachClient()
  }

  private onHello(protocolVersion: number, token: string): void {
    const client = this.client
    if (client === null) return
    if (protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION || token !== this.options.token) {
      client.destroy()
      return
    }
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.options.onClientChange(true)
  }

  private async onRequest(requestId: string, request: TerminalDaemonRequest): Promise<void> {
    const client = this.client
    if (client === null) return
    let reply: TerminalDaemonReply
    try {
      reply = await this.options.handle(request)
    } catch (error) {
      this.options.onError(error)
      reply = { ok: false, error: { code: 'INTERNAL_ERROR', message: '守护进程处理请求时发生未预期的内部错误。' } }
    }
    const target = this.client
    if (target === null || target.destroyed) return
    try {
      target.write(encodeTerminalDaemonFrame(reply.ok
        ? { reply: requestId, ok: true, data: reply.data }
        : { reply: requestId, ok: false, error: reply.error }))
    } catch (error) {
      this.options.onError(error)
    }
  }

  /** 丢弃指定连接（可能已被替换）：只有仍是当前连接时才通知状态变化。 */
  private dropClient(socket: Socket): void {
    if (this.client !== socket) return
    this.detachClient()
  }

  private detachClient(): void {
    const client = this.client
    this.client = null
    this.buffer = ''
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    if (client === null) return
    this.options.onClientChange(false)
    client.removeAllListeners()
    client.on('error', () => {})
    client.destroy()
  }
}

/** 监听指定端点；失败时把错误原样抛给调用方判断（例如套接字文件残留）。 */
function listenOn(server: Server, endpoint: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(endpoint)
  })
}

/** 端点上是否真的有进程在监听；能连上才算活着，连接被拒或超时都只能说明「连不上」。 */
function isEndpointAlive(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    const socket = connect(endpoint)
    const settle = (alive: boolean): void => {
      socket.destroy()
      resolveProbe(alive)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}
