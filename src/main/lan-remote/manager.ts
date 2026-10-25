/** 手机访问编排：显式开启 HTTPS 代理的本地回环入口，配对使用外部 HTTPS 地址，关闭和退出均收敛连接。 */
import { randomUUID } from 'node:crypto'
import type { DesktopConfigStore } from '../config/desktop-config-store'
import type { SessionManager } from '../sessions/session-manager'
import type { SdkRuntimeBridge } from '../sessions/sdk-runtime-bridge'
import { isLanControlRequest } from '../../shared/lan-remote-api'
import type { LanControlData, LanControlRequest, LanRemoteState, LanStartOptions } from '../../shared/lan-remote-api'
import { LanAccessError, LanDeviceManager } from './device-manager'
import { LanSessionService } from './session-service'
import { LanServer } from './server'

export class LanRemoteManager {
  private readonly devices: LanDeviceManager
  private server: LanServer | null = null
  private phase: LanRemoteState['phase'] = 'stopped'
  private origin: string | null = null
  private localOrigin: string | null = null
  private serverId: string | null = null
  private lastError: string | null = null
  private shuttingDown = false
  private queue: Promise<unknown> = Promise.resolve()
  private notification = 0
  private readonly listeners = new Set<(state: LanRemoteState) => void>()
  private readonly detachDevices: () => void
  constructor(
    private readonly store: DesktopConfigStore,
    private readonly sessions: SessionManager,
    private readonly runtime: SdkRuntimeBridge
  ) {
    this.devices = new LanDeviceManager(store)
    this.detachDevices = this.devices.onChanged(() => this.publish())
  }

  onChanged(listener: (state: LanRemoteState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async getState(): Promise<LanRemoteState> {
    const devices = await this.devices.list()
    return { phase: this.phase, localOrigin: this.localOrigin, origin: this.origin, serverId: this.serverId,
      devices, lastError: this.lastError }
  }
  private publish(): void {
    const sequence = ++this.notification
    void this.getState().then(state => {
      if (sequence !== this.notification) return
      for (const listener of [...this.listeners]) {
        try { listener(state) } catch { /* 窗口展示不影响监听与设备授权。 */ }
      }
    }).catch(error => console.error('[lan-remote] 状态读取失败：', error))
  }
  control(request: LanControlRequest): Promise<LanControlData> {
    const task = this.queue.then(async (): Promise<LanControlData> => {
      if (this.shuttingDown) throw new LanAccessError('SERVICE_STOPPED', '应用正在退出，不能操作局域网服务。', 409)
      switch (request.action) {
        case 'state': return { kind: 'state', state: await this.getState() }
        case 'start': await this.start(request); break
        case 'stop': await this.stopCurrent(); break
        case 'pair': {
          if (this.phase !== 'running' || !this.origin) throw new LanAccessError('SERVICE_STOPPED', '请先在桌面开启手机访问。', 409)
          const pairing = await this.devices.createPairing(request.projectIds)
          return { kind: 'pairing', url: `${this.origin}/pair#code=${pairing.code}`, expiresAt: pairing.expiresAt }
        }
        case 'revoke': await this.devices.revoke(request.deviceId); break
        case 'grant': await this.devices.grant(request.deviceId, request.projectIds); break
      }
      this.publish()
      return { kind: 'state', state: await this.getState() }
    })
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async start(options: LanStartOptions): Promise<void> {
    if (!isLanControlRequest({ action: 'start', ...options })) {
      throw new LanAccessError('INVALID_REQUEST', '手机访问配置无效，请检查 HTTPS 来源地址与转发端口。', 400)
    }
    await this.stopCurrent()
    this.phase = 'starting'; this.lastError = null; this.publish()
    try {
      if (this.shuttingDown) throw new Error('应用正在退出，已取消手机访问监听。')
      const serverId = randomUUID()
      const service = new LanSessionService(serverId, this.store, this.devices, this.sessions, this.runtime)
      const server: LanServer = new LanServer(new URL(options.publicOrigin).origin, this.devices, service, error => {
        if (this.server !== server) return
        this.lastError = `手机访问监听失败：${error.message}`
        void this.control({ action: 'stop' }).catch(failure => console.error('[lan-remote] 故障状态收敛失败：', failure))
      })
      this.server = server
      const endpoint = await server.start(options.port)
      if (this.shuttingDown) throw new Error('应用正在退出，已取消手机访问监听。')
      this.origin = endpoint.origin; this.serverId = serverId
      this.localOrigin = endpoint.localOrigin; this.phase = 'running'
    } catch (error) {
      await this.stopCurrent()
      this.lastError = error instanceof Error ? error.message : String(error)
      this.publish()
      throw error
    }
  }
  private async stopCurrent(): Promise<void> {
    this.phase = 'stopping'; this.devices.clearPairing()
    const server = this.server; this.server = null
    this.origin = null; this.localOrigin = null; this.serverId = null
    try { if (server) await server.stop() } finally { this.phase = 'stopped'; this.publish() }
  }
  /** 同步阻止新请求，再等待已排队的启停收尾；不要求用户先关闭手机页面。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.devices.clearPairing(); this.detachDevices()
    await this.stopCurrent()
    await this.queue
    await this.stopCurrent()
  }
}
