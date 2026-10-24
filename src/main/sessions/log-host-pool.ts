/**
 * 只读宿主池：按项目保活用于解析会话文件的宿主进程，让「查看历史」不必等执行宿主建立。
 *
 * 边界：池里的宿主没有会话授权回路，不承载会话、不登记运行实例、不参与前台选择与占用判定，
 * 只做日志解析。会话真正绑定时，绑定层可以把池中宿主接管过去（`claim`），接管后它才成为运行实例，
 * 因此「查看」与「执行」共用一套进程与同一份投影检查点，而不会被同一个进程的两种身份混在一起。
 * 读取持有租约，最后一份租约释放后才开始空闲计时；回收确认后移出池，应用退出时统一关闭。
 */
import { HOST_IDLE_RECLAIM_MS, SdkHostError } from './sdk-host-manager'
import type { SdkHostManager } from './sdk-host-manager'

/**
 * 解析宿主容量的软上限：只裁剪可回收的空闲项目。
 * 读取中、回收中与关闭未确认的宿主不强制裁剪，池内登记数量可能超过该值；
 * 该值是资源守卫，不是进程数硬限制，也不代表实测最优值。
 */
const LOG_HOST_CAPACITY = 2

interface PooledHost {
  readonly hostId: number
  readonly host: SdkHostManager
  readonly projectPath: string
  timer: ReturnType<typeof setTimeout> | null
  readers: number
  releasing: boolean
  /** 关闭结果未知时保留监督，但不能再借用或接管这个宿主。 */
  unconfirmed: boolean
}

/** 池中宿主的读取租约：释放幂等，宿主被执行链接管后不再触碰原池的计时器。 */
export interface LogHostHandle {
  readonly hostId: number
  readonly host: SdkHostManager
  readonly release: () => void
}

export interface LogHostPoolOptions {
  /** 建立只读宿主；编号由本池分配，不与运行实例编号共用命名空间语义。 */
  readonly create: (hostId: number) => SdkHostManager
}

export class LogHostPool {
  private readonly entries = new Map<number, PooledHost>()
  /** 池编号与运行实例编号错开：两类宿主在日志与状态里不会互相冒充。 */
  private hostSeed = 10_000
  private shuttingDown = false

  constructor(private readonly options: LogHostPoolOptions) {}

  /**
   * 取得该项目的解析宿主：命中同项目的可用宿主就复用，否则新建一个。
   * 宿主正在关闭或已失败时不复用，避免一次读取撞上正在收敛的进程。
   */
  acquire(projectPath: string, excluded?: SdkHostManager): LogHostHandle {
    if (this.shuttingDown) throw new SdkHostError('HOST_CLOSED', '应用正在退出，不能建立只读宿主。')
    const existing = this.findUsable(projectPath, undefined, excluded)
    if (existing !== null) return this.lease(existing)
    const hostId = ++this.hostSeed
    const host = this.options.create(hostId)
    const entry: PooledHost = { hostId, host, projectPath, timer: null, readers: 0, releasing: false, unconfirmed: false }
    this.entries.set(hostId, entry)
    return this.lease(entry)
  }

  /** 只借指定的原宿主；身份已移交或正在回收时返回 null，不悄悄创建替代进程。 */
  acquireExisting(projectPath: string, host: SdkHostManager): LogHostHandle | null {
    if (this.shuttingDown) return null
    const entry = this.findUsable(projectPath, host)
    return entry === null ? null : this.lease(entry)
  }

  /** 预热：为该项目保住一个已就绪宿主，失败只是退回冷启动，不向页面报错。 */
  warm(projectPath: string): void {
    if (this.shuttingDown) return
    try {
      const lease = this.acquire(projectPath)
      void lease.host.ensureStarted().catch(() => undefined).finally(lease.release)
    } catch {
      /* 预热是可放弃的优化。 */
    }
  }

  /** 按宿主对象与项目接管；已有读取仍在同一进程完成，不再受原池的回收安排影响。 */
  claim(projectPath: string, host: SdkHostManager): SdkHostManager | null {
    if (this.shuttingDown) return null
    const entry = this.findUsable(projectPath, host)
    if (entry === null) return null
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    this.entries.delete(entry.hostId)
    return entry.host
  }

  /** 退出编排：阻止新宿主并并行关闭；全部任务结束后报告原始失败。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) if (entry.timer !== null) clearTimeout(entry.timer)
    const results = await Promise.allSettled(entries.map(async entry => { await entry.host.shutdown() }))
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
  }

  /** 仅返回仍归本池、项目匹配且未进入回收的宿主；坏宿主留到回收确认后再移出登记。 */
  private findUsable(projectPath: string, preferred?: SdkHostManager, excluded?: SdkHostManager): PooledHost | null {
    for (const entry of this.entries.values()) {
      if (entry.projectPath !== projectPath || entry.releasing || entry.unconfirmed || entry.host === excluded
        || (preferred !== undefined && entry.host !== preferred)) continue
      const state = entry.host.getStatus().state
      if (state === 'failed' || state === 'stopping') {
        void this.release(entry)
        continue
      }
      return entry
    }
    return null
  }

  /** 租约在首次等待前固定；嵌套或并发读取只有最后一次释放才恢复空闲计时。 */
  private lease(entry: PooledHost): LogHostHandle {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    entry.readers += 1
    this.entries.delete(entry.hostId)
    this.entries.set(entry.hostId, entry)
    let released = false
    return { hostId: entry.hostId, host: entry.host, release: () => {
      if (released) return
      released = true
      entry.readers -= 1
      if (entry.readers !== 0 || this.entries.get(entry.hostId) !== entry || this.shuttingDown) return
      this.touch(entry)
      this.trim()
    } }
  }

  /** 从最后一次读取结束起算空闲；迟到的旧租约或计时器不能影响已被接管的宿主。 */
  private touch(entry: PooledHost): void {
    if (this.shuttingDown || entry.releasing || entry.readers > 0 || this.entries.get(entry.hostId) !== entry) return
    this.entries.delete(entry.hostId)
    this.entries.set(entry.hostId, entry)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.release(entry)
    }, HOST_IDLE_RECLAIM_MS)
  }

  /** 回收完成才删除登记；被占用或关闭失败时保留对象，稍后重新安排而不是丢失监督。 */
  private async release(entry: PooledHost): Promise<void> {
    if (this.shuttingDown || entry.releasing || entry.readers > 0 || this.entries.get(entry.hostId) !== entry) return
    if (entry.host.hasHistoryReads()) { this.touch(entry); return }
    entry.releasing = true
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    let suspended = false
    try {
      suspended = await entry.host.suspend()
    } catch {
      // 关闭未确认时保留池内登记，但不能重新借用；后续计时回收与退出编排仍能找到它。
      entry.unconfirmed = true
    } finally {
      entry.releasing = false
    }
    if (this.entries.get(entry.hostId) !== entry || this.shuttingDown) return
    if (!suspended) { this.touch(entry); return }
    this.entries.delete(entry.hostId)
    this.trim()
  }

  /** 容量是软上限：只裁剪最久未用的空闲项目，跳过读取中及已经进入回收的宿主。 */
  private trim(): void {
    let excess = -LOG_HOST_CAPACITY
    for (const entry of this.entries.values()) if (!entry.releasing && !entry.unconfirmed) excess += 1
    for (const entry of this.entries.values()) {
      if (excess <= 0) break
      if (entry.releasing || entry.unconfirmed || entry.readers > 0 || entry.host.hasHistoryReads()) continue
      excess -= 1
      void this.release(entry)
    }
  }
}
