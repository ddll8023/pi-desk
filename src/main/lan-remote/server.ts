/** 手机访问载体：自动端口提供局域网 HTTP 直连，扫码自动登记设备，同源与设备身份校验先于业务分派。 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { Socket } from 'node:net'
import { isLanAddress, isLanRecord, hasLanKeys, isLanRequest, isLanSessionTarget, LAN_REMOTE_PROTOCOL_VERSION } from '../../shared/lan-remote-api'
import { LanAccessError, LanDeviceManager, LAN_COOKIE_NAME, LAN_DEVICE_LIFETIME_SECONDS } from './device-manager'
import type { LanSessionService } from './session-service'
import { LanEventStream } from './event-stream'
import { LanMobileAssets } from './static-assets'

const MAX_BODY_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
export class LanServer {
  private server: Server | null = null
  private readonly assets = new LanMobileAssets()
  private origins: readonly string[] = []
  private stopped = false
  private readonly sockets = new Set<Socket>()
  private readonly principals = new Map<Socket, string>()
  private readonly streams = new Map<string, Set<LanEventStream>>()
  private readonly rates = new Map<string, { start: number; count: number }>()
  private readonly active = new Map<string, number>()
  private detachDevices: (() => void) | null = null
  constructor(
    private readonly addresses: readonly string[],
    private readonly devices: LanDeviceManager,
    private readonly service: LanSessionService,
    private readonly onFailure: (error: Error) => void
  ) {}

  async start(): Promise<{ readonly origin: string; readonly origins: readonly string[] }> {
    await this.assets.prepare()
    if (this.stopped) throw new Error('手机访问监听已被取消。')
    const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handle(request, response).catch(error => {
        const failure = error instanceof LanAccessError ? error : new LanAccessError('INTERNAL_ERROR', '手机访问请求失败，请查看桌面日志。', 500)
        if (!(error instanceof LanAccessError)) console.error('[lan-remote] 请求处理失败：', error)
        if (!response.headersSent) this.json(response, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
        else response.destroy()
      })
    }
    const server = createServer({ maxHeaderSize: 8192 }, handleRequest)
    this.server = server
    server.maxHeadersCount = 32; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000
    server.on('connection', (socket: Socket) => {
      if (this.stopped || this.sockets.size >= 32 || !this.acceptsPeer(socket.remoteAddress)) { socket.destroy(); return }
      this.sockets.add(socket)
      socket.once('close', () => { this.sockets.delete(socket); this.principals.delete(socket) })
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', ready); reject(error) }
      const ready = (): void => { server.off('error', failed); resolve() }
      server.once('error', failed); server.once('listening', ready)
      server.listen(0, '0.0.0.0')
    })
    server.on('error', (error: Error) => {
      console.error('[lan-remote] 监听服务错误：', error)
      void this.stop().catch(failure => console.error('[lan-remote] 故障关闭失败：', failure))
      this.onFailure(error)
    })
    const address = server.address()
    if (!address || typeof address === 'string' || this.stopped) {
      // 退出可能发生在 listen 尚未完成时，仍用本次局部对象关闭迟到的监听句柄。
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw new Error('手机访问监听未就绪或已被取消。')
    }
    const origins = this.addresses.map(host => `http://${host}:${address.port}`)
    const origin = origins[0]
    if (!origin) throw new Error('未找到可供手机连接的局域网地址。')
    this.origins = [...origins, `http://127.0.0.1:${address.port}`]
    this.detachDevices = this.devices.onChanged(id => {
      if (id === null) return
      for (const stream of this.streams.get(id) ?? []) stream.close()
      for (const [socket, principal] of this.principals) if (principal === id) socket.destroy()
    })
    return { origin, origins }
  }

  /** 只依据真实连接来源，不通过转发头向公网连接授予局域网身份。 */
  private acceptsPeer(peer: string | undefined): boolean {
    return typeof peer === 'string' && isLanAddress(peer.startsWith('::ffff:') ? peer.slice(7) : peer)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    response.setHeader('Referrer-Policy', 'no-referrer')
    const origin = this.origins.find(value => new URL(value).host === request.headers.host)
    if (this.stopped || !origin || !this.acceptsPeer(request.socket.remoteAddress)) {
      throw new LanAccessError('FORBIDDEN', '手机访问尚未就绪，或请求不是来自局域网。')
    }
    const site = request.headers['sec-fetch-site']
    if ((request.headers.origin !== undefined && request.headers.origin !== origin)
      || (request.method === 'POST' && request.headers.origin !== origin)) {
      throw new LanAccessError('FORBIDDEN', '请求来源或页面来源不受信任。')
    }
    if (!request.url || request.url.length > 4096 || !request.url.startsWith('/')) throw new LanAccessError('INVALID_REQUEST', '请求地址无效。', 400)
    const url = new URL(request.url, origin)
    if (url.origin !== origin) throw new LanAccessError('FORBIDDEN', '不允许访问其他地址。')
    // 入口限额按真实来源计算，认证后的业务限额按设备独立计算。
    const peerKey = `peer:${request.socket.remoteAddress ?? ''}`
    this.admitRate(peerKey, 1200)
    if (!url.search && await this.assets.serve(url.pathname, request.method, response)) return
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new LanAccessError('FORBIDDEN', '请从手机访问页面发起操作。')
    }
    if (request.method === 'POST' && url.pathname === '/api/pair' && !url.search) {
      this.admitRate(`pair:${peerKey}`, 10)
      const body = await this.body(request)
      if (!isLanRecord(body) || !hasLanKeys(body, ['code']) || typeof body.code !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(body.code)) {
        throw new LanAccessError('INVALID_REQUEST', '连接链接无效，请重新扫描电脑上的二维码。', 400)
      }
      const agent = request.headers['user-agent'] ?? ''
      const name = /iPad/i.test(agent) ? 'iPad' : /iPhone/i.test(agent) ? 'iPhone' : /Android/i.test(agent) ? 'Android 手机' : '手机浏览器'
      const pairing = await this.devices.redeem(body.code, name)
      if (this.stopped || response.destroyed) return
      response.setHeader('Set-Cookie', `${LAN_COOKIE_NAME}=${pairing.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LAN_DEVICE_LIFETIME_SECONDS}`)
      this.json(response, 200, { ok: true, data: { device: pairing.device, serverId: this.service.serverId, protocolVersion: LAN_REMOTE_PROTOCOL_VERSION } })
      return
    }
    const device = await this.devices.authenticate(request.headers.cookie)
    if (this.stopped || response.destroyed) return
    this.admitRate(`device:${device.id}`, 120)
    if (!this.principals.has(request.socket)) request.socket.once('close', () => this.principals.delete(request.socket))
    this.principals.set(request.socket, device.id)
    const active = this.active.get(device.id) ?? 0
    if (active >= 8) throw new LanAccessError('REQUEST_LIMIT', '该设备的并发请求过多。', 429)
    this.active.set(device.id, active + 1)
    response.once('close', () => {
      const count = (this.active.get(device.id) ?? 1) - 1
      if (count > 0) this.active.set(device.id, count); else this.active.delete(device.id)
    })
    if (request.method === 'GET' && url.pathname === '/api/state' && !url.search) {
      this.json(response, 200, { ok: true, data: { serverId: this.service.serverId, protocolVersion: LAN_REMOTE_PROTOCOL_VERSION, deviceId: device.id } })
    } else if (request.method === 'POST' && url.pathname === '/api/request' && !url.search) {
      const body = await this.body(request)
      if (!isLanRequest(body)) throw new LanAccessError('INVALID_REQUEST', '远程请求包含不支持的字段或操作。', 400)
      if (body.deviceId !== device.id) throw new LanAccessError('DEVICE_CHANGED', '设备配对身份已变化，未使用新身份重放旧请求；请先核对原会话结果。', 409)
      this.json(response, 200, { ok: true, data: await this.service.execute(device.id, body) })
    } else if (request.method === 'GET' && url.pathname === '/api/events') {
      if (url.searchParams.size !== 4 || [...url.searchParams.keys()].some(key => !['projectId', 'sessionId', 'runId', 'runtimeId'].includes(key))) {
        throw new LanAccessError('INVALID_REQUEST', '事件订阅只接受项目、会话与绑定身份。', 400)
      }
      const ref = { projectId: url.searchParams.get('projectId'), sessionId: url.searchParams.get('sessionId'),
        target: { runId: Number(url.searchParams.get('runId')), runtimeId: Number(url.searchParams.get('runtimeId')) } }
      if (!isLanSessionTarget(ref)) throw new LanAccessError('INVALID_REQUEST', '事件订阅目标无效。', 400)
      const streams = this.streams.get(device.id) ?? new Set<LanEventStream>()
      if (streams.size >= 2) throw new LanAccessError('STREAM_LIMIT', '该设备已打开过多会话连接，请关闭旧页面。', 429)
      const stream = new LanEventStream(response, device.id, ref, this.service, this.devices)
      streams.add(stream); this.streams.set(device.id, streams)
      response.once('close', () => { stream.close(); streams.delete(stream); if (streams.size === 0) this.streams.delete(device.id) })
      await stream.start()
    } else throw new LanAccessError('NOT_FOUND', '该局域网接口不存在。', 404)
  }

  private admitRate(peer: string, limit: number): void {
    const now = Date.now()
    for (const [key, rate] of this.rates) if (now - rate.start >= 60_000) this.rates.delete(key)
    let rate = this.rates.get(peer)
    if (!rate) {
      if (this.rates.size >= 256) throw new LanAccessError('REQUEST_LIMIT', '局域网请求来源过多，请稍后重试。', 429)
      rate = { start: now, count: 0 }; this.rates.set(peer, rate)
    }
    if (++rate.count > limit) throw new LanAccessError('REQUEST_LIMIT', '请求过于频繁，请稍后重试。', 429)
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json' || request.headers['content-encoding']) {
      throw new LanAccessError('INVALID_REQUEST', '接口只接受未压缩的 JSON 请求。', 415)
    }
    const chunks: Buffer[] = []; let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BODY_BYTES) throw new LanAccessError('PAYLOAD_TOO_LARGE', '请求正文超出上限。', 413)
      chunks.push(buffer)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new LanAccessError('INVALID_REQUEST', '请求不是有效 JSON。', 400) }
  }
  private json(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed || response.writableEnded) return
    const body = JSON.stringify(payload)
    if (body === undefined) throw new LanAccessError('INVALID_RESPONSE', '局域网响应无法编码。', 500)
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new LanAccessError('PAYLOAD_TOO_LARGE', '响应超出手机传输上限，请在桌面查看。', 413)
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(body)
  }
  async stop(): Promise<void> {
    this.stopped = true; this.service.stop(); this.devices.clearPairing()
    this.detachDevices?.(); this.detachDevices = null
    for (const streams of this.streams.values()) for (const stream of streams) stream.close()
    for (const socket of this.sockets) socket.destroy()
    const server = this.server; this.server = null
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    this.streams.clear(); this.principals.clear(); this.rates.clear(); this.active.clear()
  }
}
