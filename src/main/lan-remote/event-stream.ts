/** 单个手机连接的 SSE 同步：先观察增量再读取基准；独立背压和断流，不向 SDK 转发手机确认水位。 */
import type { ServerResponse } from 'node:http'
import type { LanSessionTarget } from '../../shared/lan-remote-api'
import type { ProjectionBatch, RuntimeStatus } from '../../shared/runtime-api'
import type { ExtensionUiSnapshot } from '../../shared/extension-ui-api'
import { LanAccessError, LanDeviceManager } from './device-manager'
import type { LanSessionService } from './session-service'

type PendingEvent = { readonly type: 'projection'; readonly data: ProjectionBatch }
  | { readonly type: 'status'; readonly data: RuntimeStatus }
  | { readonly type: 'interaction'; readonly data: ExtensionUiSnapshot }
  | { readonly type: 'heartbeat'; readonly data: null }
const MAX_QUEUE_BYTES = 16 * 1024 * 1024
const MAX_QUEUE_EVENTS = 64

export class LanEventStream {
  private closed = false
  private ready = false
  private draining = false
  private sequence = 0
  private projectionSeq = 0
  private interactionSeq = 0
  private queuedBytes = 0
  private readonly queue: { readonly event: PendingEvent; readonly bytes: number }[] = []
  private readonly detach: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(
    private readonly response: ServerResponse,
    private readonly deviceId: string,
    private readonly ref: LanSessionTarget,
    private readonly service: LanSessionService,
    private readonly devices: LanDeviceManager
  ) {}

  async start(): Promise<void> {
    await this.service.authorizeTarget(this.deviceId, this.ref)
    this.response.on('close', () => this.close())
    this.detach.push(this.devices.onChanged(id => { if (id === this.deviceId) this.close() }))
    this.detach.push(this.service.runtime.onProjectionBatch(data => {
      if (data.runId === this.ref.target.runId) this.enqueue({ type: 'projection', data })
    }))
    this.detach.push(this.service.runtime.onRunStatusChanged(data => {
      if (data.runId === this.ref.target.runId) this.enqueue({ type: 'status', data })
    }))
    this.detach.push(this.service.runtime.onExtensionUi(data => {
      if (data.runId === this.ref.target.runId) this.enqueue({ type: 'interaction', data })
    }))
    // 释放／关闭可能只改变登记，所以同时观察粗粒度清单，触发一次目标复核。
    this.detach.push(this.service.runtime.onRunsChanged(() => this.enqueue({ type: 'heartbeat', data: null })))
    try {
      const snapshot = await this.service.snapshot(this.deviceId, this.ref)
      if (this.closed || this.response.destroyed) { this.close(); return }
      await this.service.authorizeTarget(this.deviceId, this.ref)
      this.projectionSeq = snapshot.projection.seq
      this.interactionSeq = snapshot.interaction.seq
      // 基准读取期间的状态由最新完整快照覆盖；投影／交互仍按水位保留有效增量。
      const retained = this.queue.filter(entry => entry.event.type !== 'status')
      this.queue.length = 0
      this.queue.push(...retained)
      this.queuedBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0)
      this.response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      await this.send('snapshot', { ...snapshot, status: this.service.runtime.getStatusOfRun(this.ref.target.runId) })
      if (this.closed) return
      this.ready = true
      this.timer = setInterval(() => this.enqueue({ type: 'heartbeat', data: null }), 15_000)
      this.timer.unref()
      void this.flush()
    } catch (error) {
      if (!this.response.headersSent) { this.close(false); throw error }
      this.fail(error)
    }
  }

  private enqueue(event: PendingEvent): void {
    if (this.closed) return
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.queue.length >= MAX_QUEUE_EVENTS || this.queuedBytes + bytes > MAX_QUEUE_BYTES) {
      this.fail(new LanAccessError('RESYNC_REQUIRED', '手机连接积压，请重新连接并获取会话快照。', 409))
      return
    }
    this.queue.push({ event, bytes }); this.queuedBytes += bytes
    if (this.ready) void this.flush()
  }
  private async flush(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    try {
      while (!this.closed && this.queue.length > 0) {
        const entry = this.queue.shift()
        if (!entry) break
        this.queuedBytes -= entry.bytes
        await this.service.authorizeTarget(this.deviceId, this.ref)
        if (this.closed) break
        const event = entry.event
        if (event.type === 'projection') {
          if (event.data.runtimeId !== this.ref.target.runtimeId || event.data.resyncRequired) {
            throw new LanAccessError('RESYNC_REQUIRED', '会话增量已失效，请重新获取快照。', 409)
          }
          if (event.data.seq <= this.projectionSeq) continue
          if (event.data.seq !== this.projectionSeq + 1) throw new LanAccessError('RESYNC_REQUIRED', '会话增量有缺口，请重新获取快照。', 409)
          this.projectionSeq = event.data.seq
        }
        if (event.type === 'interaction') {
          if (event.data.runtimeId !== this.ref.target.runtimeId) throw new LanAccessError('TARGET_CHANGED', '会话已换代，请重新打开。', 409)
          if (event.data.seq <= this.interactionSeq) continue
          this.interactionSeq = event.data.seq
        }
        await this.send(event.type, event.type === 'heartbeat'
          ? { serverId: this.service.serverId, status: this.service.runtime.getStatusOfRun(this.ref.target.runId) } : event.data)
      }
    } catch (error) { this.fail(error) } finally { this.draining = false }
  }

  private async send(type: string, data: unknown): Promise<void> {
    if (this.closed || this.response.destroyed) return
    const payload = `id: ${++this.sequence}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    if (Buffer.byteLength(payload) > MAX_QUEUE_BYTES) throw new LanAccessError('PAYLOAD_TOO_LARGE', '会话快照超出手机传输上限，请在桌面查看。', 413)
    if (this.response.write(payload)) return
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.response.off('drain', drain); this.response.off('close', close)
        if (error) reject(error); else resolve()
      }
      const drain = (): void => finish()
      const close = (): void => finish(new Error('手机连接已关闭。'))
      const timer = setTimeout(() => finish(new LanAccessError('SLOW_CLIENT', '手机连接持续阻塞，请重新连接。', 409)), 5_000)
      this.response.once('drain', drain); this.response.once('close', close)
    })
  }
  private fail(error: unknown): void {
    if (this.closed) return
    if (this.response.headersSent && !this.response.destroyed && this.response.writableLength < 4096) {
      const message = error instanceof LanAccessError ? error.message : '会话同步中断，请重新连接。'
      this.response.write(`event: invalidated\ndata: ${JSON.stringify({ code: error instanceof LanAccessError ? error.code : 'STREAM_CLOSED', message })}\n\n`)
    }
    this.close()
  }
  close(endResponse = true): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    for (const detach of this.detach.splice(0)) detach()
    this.queue.length = 0; this.queuedBytes = 0
    if (endResponse && !this.response.destroyed) {
      // 已阻塞的大缓冲不能等手机继续读取，否则超时断流仍会占住内存和 socket。
      if (this.response.writableLength > 64 * 1024) this.response.destroy()
      else this.response.end()
    }
  }
}
