/** 设备配对与授权：配对码仅在内存中一次消费，持久化只保存凭证摘要；授权变更主动通知连接所有者。 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DesktopConfigStore } from '../config/desktop-config-store'
import { LAN_REMOTE_MAX_DEVICES } from '../../shared/lan-remote-api'
import type { LanDevice, LanStoredDevice } from '../../shared/lan-remote-api'

export const LAN_COOKIE_NAME = '__Host-pi-desk-lan'
export const LAN_DEVICE_LIFETIME_SECONDS = 30 * 24 * 60 * 60
const PAIRING_LIFETIME_MS = 5 * 60_000
interface Pairing {
  readonly code: string
  readonly projectIds: readonly string[]
  readonly expiresAt: number
}
export class LanAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message) }
}

export class LanDeviceManager {
  private pairing: Pairing | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(deviceId: string | null) => void>()
  constructor(private readonly store: DesktopConfigStore) {}

  onChanged(listener: (deviceId: string | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private changed(deviceId: string | null): void {
    for (const listener of [...this.listeners]) {
      try { listener(deviceId) } catch { /* 展示与连接清理失败不能撤销已经落盘的授权决定。 */ }
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }
  async list(): Promise<readonly LanDevice[]> {
    return (await this.store.readLanDevices()).filter(device => device.expiresAt > Date.now()).map(device => ({
      id: device.id, name: device.name, projectIds: [...device.projectIds], createdAt: device.createdAt, expiresAt: device.expiresAt
    }))
  }
  private async requireProjects(projectIds: readonly string[]): Promise<void> {
    const { projects } = await this.store.list()
    if (projectIds.some(id => !projects.some(project => project.id === id))) {
      throw new LanAccessError('INVALID_PROJECT', '授权项目已被移除，请重新选择。')
    }
  }
  createPairing(projectIds: readonly string[]): Promise<Pairing> {
    return this.enqueue(async () => {
      await this.requireProjects(projectIds)
      const pairing = { code: randomBytes(32).toString('base64url'), projectIds: [...projectIds], expiresAt: Date.now() + PAIRING_LIFETIME_MS }
      this.pairing = pairing
      return pairing
    })
  }
  clearPairing(): void { this.pairing = null }

  redeem(code: string, name: string): Promise<{ readonly token: string; readonly device: LanDevice }> {
    return this.enqueue(async () => {
      const pairing = this.pairing
      if (!pairing || pairing.expiresAt <= Date.now() || code.length !== pairing.code.length
        || !timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code))) {
        throw new LanAccessError('PAIRING_EXPIRED', '配对码无效或已过期，请在桌面重新生成。', 401)
      }
      // 提交前就消费：保存失败也不能让同一个配对码在并发请求中被重复使用。
      this.pairing = null
      await this.requireProjects(pairing.projectIds)
      const devices = (await this.store.readLanDevices()).filter(device => device.expiresAt > Date.now())
      if (devices.length >= LAN_REMOTE_MAX_DEVICES) throw new LanAccessError('DEVICE_LIMIT', '已配对设备达到上限，请先撤销旧设备。')
      const token = randomBytes(32).toString('base64url')
      const createdAt = Date.now()
      const record: LanStoredDevice = { id: randomUUID(), name: name.trim(), tokenHash: this.hash(token),
        projectIds: [...pairing.projectIds], createdAt, expiresAt: createdAt + LAN_DEVICE_LIFETIME_SECONDS * 1000 }
      await this.store.saveLanDevices([...devices, record])
      this.changed(null)
      return { token, device: { id: record.id, name: record.name, projectIds: [...record.projectIds], createdAt, expiresAt: record.expiresAt } }
    })
  }

  async authenticate(cookie: string | undefined): Promise<LanStoredDevice> {
    const entries = (cookie ?? '').split(';').map(entry => entry.trim()).filter(entry => entry.startsWith(`${LAN_COOKIE_NAME}=`))
    const token = entries.length === 1 ? entries[0]?.slice(LAN_COOKIE_NAME.length + 1) : null
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new LanAccessError('UNAUTHENTICATED', '设备尚未配对或凭证已失效。', 401)
    const hash = this.hash(token)
    const device = (await this.store.readLanDevices()).find(entry => entry.tokenHash === hash && entry.expiresAt > Date.now())
    if (!device) throw new LanAccessError('UNAUTHENTICATED', '设备授权已撤销或过期，请重新配对。', 401)
    return device
  }
  async requireDevice(deviceId: string): Promise<LanStoredDevice> {
    const device = (await this.store.readLanDevices()).find(entry => entry.id === deviceId && entry.expiresAt > Date.now())
    if (!device) throw new LanAccessError('UNAUTHENTICATED', '设备授权已撤销或过期。', 401)
    return device
  }
  revoke(deviceId: string): Promise<void> {
    return this.enqueue(async () => {
      const devices = await this.store.readLanDevices()
      await this.store.saveLanDevices(devices.filter(device => device.id !== deviceId))
      this.changed(deviceId)
    })
  }
  grant(deviceId: string, projectIds: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      await this.requireProjects(projectIds)
      const devices = await this.store.readLanDevices()
      if (!devices.some(device => device.id === deviceId)) throw new LanAccessError('DEVICE_NOT_FOUND', '设备已不存在。')
      await this.store.saveLanDevices(devices.map(device => device.id === deviceId ? { ...device, projectIds: [...projectIds] } : device))
      this.changed(deviceId)
    })
  }
  private hash(token: string): string { return createHash('sha256').update(token).digest('hex') }
}
