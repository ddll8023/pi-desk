/** 本地终端服务端：认证后才接管连接，响应绑定原 socket，发送等待可写水位且不保留无界网络队列。 */
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import {
  TERMINAL_DAEMON_FRAME_MAX_CHARS, TERMINAL_DAEMON_HANDSHAKE_TIMEOUT_MS,
  TERMINAL_DAEMON_PROTOCOL_VERSION, encodeTerminalDaemonFrame, parseTerminalDaemonFrame
} from '../shared/terminal-daemon-protocol'
import type { TerminalDaemonEventFrame, TerminalDaemonFrame, TerminalDaemonRequest } from '../shared/terminal-daemon-protocol'

export type TerminalDaemonReply =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
export interface TerminalDaemonServerOptions {
  readonly endpoint: string
  readonly token: string
  readonly handle: (request: TerminalDaemonRequest) => Promise<TerminalDaemonReply>
  readonly onClientChange: (attached: boolean) => void
  readonly onWritable: () => void
  readonly onError: (error: unknown) => void
}
interface Peer {
  readonly socket: Socket
  buffer: string
  authenticated: boolean
  timer: NodeJS.Timeout | null
  requests: number
}
const MAX_REQUESTS = 32
const MAX_UNAUTHENTICATED_PEERS = 4
const SOCKET_BACKLOG_BYTES = 1024 * 1024

export class TerminalDaemonServer {
  private server: Server | null = null
  private client: Peer | null = null
  private readonly peers = new Set<Peer>()
  private closed = false
  constructor(private readonly options: TerminalDaemonServerOptions) {}
  get attached(): boolean { return this.client !== null }

  async listen(): Promise<void> {
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    // 调用方已持有本版本独占锁；此处只删除崩溃遗留的端点，不探测并扰动其他客户端。
    if (process.platform !== 'win32' && existsSync(this.options.endpoint)) unlinkSync(this.options.endpoint)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
      const onListening = (): void => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.endpoint)
    })
    server.on('error', this.options.onError)
  }

  sendEvent(frame: TerminalDaemonEventFrame): boolean {
    const peer = this.client
    if (peer === null || peer.socket.destroyed) return false
    // 超出传输预算时断开并按画面接回，不假称已送达，也不在 socket 内无限堆积。
    if (peer.socket.writableLength > SOCKET_BACKLOG_BYTES) { this.drop(peer); return false }
    try { peer.socket.write(encodeTerminalDaemonFrame(frame)); return true }
    catch (error) { this.options.onError(error); this.drop(peer); return false }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const peer of [...this.peers]) this.drop(peer)
    const server = this.server
    this.server = null
    if (server === null) return
    server.close()
    if (process.platform !== 'win32') {
      try { unlinkSync(this.options.endpoint) } catch { /* 已不存在。 */ }
    }
  }

  private accept(socket: Socket): void {
    if (this.closed || this.peers.size >= MAX_UNAUTHENTICATED_PEERS + 1) { socket.destroy(); return }
    const peer: Peer = { socket, buffer: '', authenticated: false, timer: null, requests: 0 }
    this.peers.add(peer)
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.on('data', (chunk: string) => this.onData(peer, chunk))
    socket.on('error', () => this.drop(peer))
    socket.on('close', () => this.drop(peer))
    socket.on('drain', () => { if (this.client === peer) this.options.onWritable() })
    peer.timer = setTimeout(() => this.drop(peer), TERMINAL_DAEMON_HANDSHAKE_TIMEOUT_MS)
  }

  private onData(peer: Peer, chunk: string): void {
    peer.buffer += chunk
    let newline = peer.buffer.indexOf('\n')
    while (newline !== -1) {
      if (newline > TERMINAL_DAEMON_FRAME_MAX_CHARS) { this.drop(peer); return }
      const line = peer.buffer.slice(0, newline)
      peer.buffer = peer.buffer.slice(newline + 1)
      const frame = parseTerminalDaemonFrame(line)
      if (frame === null) { this.drop(peer); return }
      this.onFrame(peer, frame)
      if (peer.socket.destroyed) return
      newline = peer.buffer.indexOf('\n')
    }
    if (peer.buffer.length > TERMINAL_DAEMON_FRAME_MAX_CHARS) this.drop(peer)
  }

  private onFrame(peer: Peer, frame: TerminalDaemonFrame): void {
    if ('hello' in frame) {
      if (peer.authenticated || frame.hello.protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION || frame.hello.token !== this.options.token) {
        this.drop(peer); return
      }
      if (peer.timer !== null) clearTimeout(peer.timer)
      peer.timer = null
      if (this.client !== null) this.drop(this.client)
      peer.authenticated = true
      this.client = peer
      this.options.onClientChange(true)
      return
    }
    if (!peer.authenticated || this.client !== peer) { this.drop(peer); return }
    if ('notice' in frame) {
      // ACK 是累计进度，不创建响应、关联标识或等待定时器。
      void this.options.handle(frame.notice).catch(this.options.onError)
      return
    }
    if ('request' in frame) {
      if (peer.requests >= MAX_REQUESTS) { this.drop(peer); return }
      peer.requests += 1
      void this.onRequest(peer, frame.request, frame.body)
      return
    }
    this.drop(peer)
  }

  private async onRequest(peer: Peer, requestId: string, request: TerminalDaemonRequest): Promise<void> {
    try {
      let reply: TerminalDaemonReply
      try { reply = await this.options.handle(request) }
      catch (error) {
        this.options.onError(error)
        reply = { ok: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '终端处理请求失败。' } }
      }
      if (this.client !== peer || peer.socket.destroyed) return
      if (peer.socket.writableLength > SOCKET_BACKLOG_BYTES) { this.drop(peer); return }
      const frame: TerminalDaemonFrame = reply.ok
        ? { reply: requestId, ok: true, data: reply.data }
        : { reply: requestId, ok: false, error: reply.error }
      // write=false 表示本帧已进入有界缓冲；等 drain 再完成该请求，阻止响应生产者继续堆积。
      if (!peer.socket.write(encodeTerminalDaemonFrame(frame))) await this.waitForDrain(peer)
    } catch (error) { this.options.onError(error); this.drop(peer) }
    finally { peer.requests -= 1 }
  }

  private waitForDrain(peer: Peer): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        peer.socket.off('drain', settle)
        peer.socket.off('close', settle)
        resolve()
      }
      peer.socket.once('drain', settle)
      peer.socket.once('close', settle)
    })
  }

  private drop(peer: Peer): void {
    if (!this.peers.delete(peer)) return
    if (peer.timer !== null) clearTimeout(peer.timer)
    peer.timer = null
    peer.buffer = ''
    if (this.client === peer) { this.client = null; this.options.onClientChange(false) }
    // 不移除 close 监听：等待 drain 的请求也需要由 close 收尾。
    peer.socket.destroy()
  }
}
