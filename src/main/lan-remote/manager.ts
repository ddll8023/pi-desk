/** 手机访问编排：自动发现局域网地址并分配端口，显式开启后提供扫码连接，关闭和退出均收敛连接。 */
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { DesktopConfigStore } from '../config/desktop-config-store'
import type { SessionManager } from '../sessions/session-manager'
import type { SdkRuntimeBridge } from '../sessions/sdk-runtime-bridge'
import { isLanAddress } from '../../shared/lan-remote-api'
import type { LanControlData, LanControlRequest, LanRemoteState } from '../../shared/lan-remote-api'
import { LanAccessError, LanDeviceManager } from './device-manager'
import { LanSessionService } from './session-service'
import { LanServer } from './server'

/** 优先使用实体网卡的私有地址；保留其他网卡作为备用，不要求用户手填网络参数。 */
function localAddresses(): string[] {
  const addresses: { address: string; rank: number }[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    const virtual = /loopback|docker|veth|virbr|vmnet|vbox|utun|tailscale|zerotier|hamachi|bridge|^br-|^tun|^tap/i.test(name)
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isLanAddress(entry.address) || entry.address.startsWith('127.')) continue
      addresses.push({ address: entry.address, rank: (virtual ? 2 : 0) + (entry.address.startsWith('169.254.') ? 1 : 0) })
    }
  }
  return [...new Set(addresses.sort((a, b) => a.rank - b.rank).map(entry => entry.address))]
}

export class LanRemoteManager {
  private readonly devices: LanDeviceManager
  private server: LanServer | null = null
  private phase: LanRemoteState['phase'] = 'stopped'
  private origin: string | null = null
  private origins: readonly string[] = []
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
    return { phase: this.phase, origin: this.origin, origins: [...this.origins], serverId: this.serverId,
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
        case 'start': await this.start(); break
        case 'stop': await this.stopCurrent(); break
        case 'pair': {
          const origin = this.origin
          const serverId = this.serverId
          if (this.phase !== 'running' || !origin || !serverId) throw new LanAccessError('SERVICE_STOPPED', '请先在桌面开启手机访问。', 409)
          const pairing = await this.devices.createPairing()
          if (this.shuttingDown || this.serverId !== serverId) throw new LanAccessError('SERVICE_STOPPED', '手机访问已关闭。', 409)
          return { kind: 'pairing', url: `${origin}/pair#code=${pairing.code}`, expiresAt: pairing.expiresAt, serverId }
        }
        case 'revoke': await this.devices.revoke(request.deviceId); break
      }
      this.publish()
      return { kind: 'state', state: await this.getState() }
    })
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async start(): Promise<void> {
    await this.stopCurrent()
    this.phase = 'starting'; this.lastError = null; this.publish()
    try {
      if (this.shuttingDown) throw new Error('应用正在退出，已取消手机访问监听。')
      const addresses = localAddresses()
      if (!addresses.length) throw new Error('未找到局域网连接，请先让电脑连接 Wi-Fi 或有线网络，再重新开启。')
      const serverId = randomUUID()
      const service = new LanSessionService(serverId, this.store, this.devices, this.sessions, this.runtime)
      const server: LanServer = new LanServer(addresses, this.devices, service, error => {
        if (this.server !== server) return
        this.lastError = `手机访问监听失败：${error.message}`
        void this.control({ action: 'stop' }).catch(failure => console.error('[lan-remote] 故障状态收敛失败：', failure))
      })
      this.server = server
      const endpoint = await server.start()
      if (this.shuttingDown) throw new Error('应用正在退出，已取消手机访问监听。')
      this.origin = endpoint.origin; this.serverId = serverId
      this.origins = endpoint.origins; this.phase = 'running'
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
    this.origin = null; this.origins = []; this.serverId = null
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
