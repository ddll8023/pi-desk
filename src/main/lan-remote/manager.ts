/** 局域网能力编排：实例化不监听、不生成证书；桌面显式启用后才建立 HTTPS 服务，关闭和退出均收敛连接。 */
import { randomUUID } from 'node:crypto'
import type { DesktopConfigStore } from '../config/desktop-config-store'
import type { SessionManager } from '../sessions/session-manager'
import type { SdkRuntimeBridge } from '../sessions/sdk-runtime-bridge'
import type { LanControlData, LanControlRequest, LanRemoteState, LanCertificateInfo, LanAddress } from '../../shared/lan-remote-api'
import { LanAccessError, LanDeviceManager } from './device-manager'
import { listLanAddresses, requireLanAddress, isBindingCurrent } from './network'
import { LanSessionService } from './session-service'
import { LanTlsManager } from './tls'
import { LanServer } from './server'

export class LanRemoteManager {
  private readonly devices: LanDeviceManager
  private readonly tls = new LanTlsManager()
  private server: LanServer | null = null
  private binding: LanAddress | null = null
  private phase: LanRemoteState['phase'] = 'stopped'
  private origin: string | null = null
  private serverId: string | null = null
  private certificate: LanCertificateInfo | null = null
  private lastError: string | null = null
  private shuttingDown = false
  private monitor: ReturnType<typeof setInterval> | null = null
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
    return { phase: this.phase, origin: this.origin, serverId: this.serverId, addresses: listLanAddresses(),
      devices, certificate: this.certificate, lastError: this.lastError }
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
        case 'start': await this.start(request.address, request.port); break
        case 'stop': await this.stopCurrent(); break
        case 'pair': {
          if (this.phase !== 'running' || !this.origin) throw new LanAccessError('SERVICE_STOPPED', '请先在桌面开启局域网访问。', 409)
          const pairing = await this.devices.createPairing(request.projectIds)
          return { kind: 'pairing', url: `${this.origin}/pair#code=${pairing.code}`, expiresAt: pairing.expiresAt }
        }
        case 'revoke': await this.devices.revoke(request.deviceId); break
        case 'grant': await this.devices.grant(request.deviceId, request.projectIds); break
        case 'export-certificate': throw new LanAccessError('INVALID_REQUEST', '证书导出必须通过桌面文件选择器。', 400)
      }
      this.publish()
      return { kind: 'state', state: await this.getState() }
    })
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async start(address: string, port: number): Promise<void> {
    await this.stopCurrent()
    this.phase = 'starting'; this.lastError = null; this.publish()
    try {
      const binding = requireLanAddress(address)
      const material = await this.tls.issue(address)
      if (this.shuttingDown) throw new Error('应用正在退出，已取消局域网监听。')
      requireLanAddress(address)
      const serverId = randomUUID()
      const service = new LanSessionService(serverId, this.store, this.devices, this.sessions, this.runtime)
      const server: LanServer = new LanServer(binding, this.devices, service, error => {
        if (this.server !== server) return
        this.lastError = `局域网监听失败：${error.message}`
        void this.control({ action: 'stop' }).catch(failure => console.error('[lan-remote] 故障状态收敛失败：', failure))
      })
      this.server = server
      const origin = await server.start(port, material)
      if (this.shuttingDown) throw new Error('应用正在退出，已取消局域网监听。')
      this.binding = binding; this.origin = origin; this.serverId = serverId
      this.certificate = material.info; this.phase = 'running'
      this.monitor = setInterval(() => {
        if (!this.binding || isBindingCurrent(this.binding)) return
        this.lastError = '所选网卡地址已变化，局域网访问已关闭，请重新选择地址。'
        void this.control({ action: 'stop' }).catch(error => console.error('[lan-remote] 网卡变化后的关闭失败：', error))
      }, 5_000)
      this.monitor.unref()
    } catch (error) {
      await this.stopCurrent()
      this.lastError = error instanceof Error ? error.message : String(error)
      this.publish()
      throw error
    }
  }
  private async stopCurrent(): Promise<void> {
    this.phase = 'stopping'; this.devices.clearPairing()
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = null
    const server = this.server; this.server = null
    this.origin = null; this.serverId = null; this.binding = null
    try { if (server) await server.stop() } finally { this.phase = 'stopped'; this.publish() }
  }
  async exportCertificate(): Promise<Buffer> {
    if (this.shuttingDown) throw new Error('应用正在退出，不能导出证书。')
    const exported = await this.tls.exportAuthority()
    this.certificate = exported.info; this.publish()
    return exported.bytes
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
