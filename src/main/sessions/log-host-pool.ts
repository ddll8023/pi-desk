/**
 * 只读宿主池：按项目保活用于解析会话文件的宿主进程，让「查看历史」不必等执行宿主建立。
 *
 * 边界：池里的宿主没有会话授权回路，不承载会话、不登记运行实例、不参与前台选择与占用判定，
 * 只做日志解析。会话真正绑定时，绑定层可以把池中宿主接管过去（`claim`），接管后它才成为运行实例，
 * 因此「查看」与「执行」共用一套进程与同一份投影检查点，而不会被同一个进程的两种身份混在一起。
 * 空闲超时后挂起进程并移出池；应用退出时统一关闭。
 */
import { HOST_IDLE_RECLAIM_MS, SdkHostError } from './sdk-host-manager'
import type { SdkHostManager, SdkHostStatus } from './sdk-host-manager'

/**
 * 池容量的项目上限：防止连续浏览多个项目时解析进程无界增长。
 * 裁剪只在某个宿主空闲收敛时进行，因此连续浏览期间可以短暂超过该值，最终由空闲回收收敛；
 * 取这个数是守卫值而不是实测最优值，进程数与首次查看延迟都还没有测量依据。
 */
const LOG_HOST_CAPACITY = 2

interface PooledHost {
  readonly hostId: number
  readonly host: SdkHostManager
  readonly projectPath: string
  timer: ReturnType<typeof setTimeout> | null
}

/** 池中宿主的对外句柄：宿主编号在建立时分配，接管或释放都按它定位。 */
export interface LogHostHandle {
  readonly hostId: number
  readonly host: SdkHostManager
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
  acquire(projectPath: string): LogHostHandle {
    if (this.shuttingDown) throw new SdkHostError('HOST_CLOSED', '应用正在退出，不能建立只读宿主。')
    const existing = this.findUsable(projectPath)
    if (existing !== null) {
      this.touch(existing)
      return { hostId: existing.hostId, host: existing.host }
    }
    const hostId = ++this.hostSeed
    const host = this.options.create(hostId)
    const entry: PooledHost = { hostId, host, projectPath, timer: null }
    this.entries.set(hostId, entry)
    // 容量裁剪只在宿主空闲收敛时进行：刚建立的宿主可能立刻就要解析，不在此时挤掉别人。
    this.touch(entry)
    return { hostId, host }
  }

  /** 预热：为该项目保住一个已就绪宿主，失败只是退回冷启动，不向页面报错。 */
  warm(projectPath: string): void {
    if (this.shuttingDown) return
    try {
      const { host } = this.acquire(projectPath)
      void host.ensureStarted().catch(() => undefined)
    } catch {
      /* 预热是可放弃的优化。 */
    }
  }

  /** 把池中宿主交给执行链：随后由调用方登记运行实例并接上授权回路。 */
  claim(hostId: number): SdkHostManager | null {
    const entry = this.entries.get(hostId)
    if (entry === undefined) return null
    if (entry.timer !== null) clearTimeout(entry.timer)
    this.entries.delete(hostId)
    const state = entry.host.getStatus().state
    if (state === 'failed' || state === 'stopping') {
      // 已失败或正在关闭的宿主不能接管：顺手收敛掉，别把它留给下一次读取。
      void entry.host.suspend().catch(() => undefined)
      return null
    }
    return entry.host
  }

  /** 退出编排：先阻止新宿主，再逐个关闭；失败如实抛出。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) if (entry.timer !== null) clearTimeout(entry.timer)
    await Promise.all(entries.map(async entry => { await entry.host.shutdown() }))
  }

  private findUsable(projectPath: string): PooledHost | null {
    for (const entry of this.entries.values()) {
      if (entry.projectPath !== projectPath) continue
      const state: SdkHostStatus['state'] = entry.host.getStatus().state
      if (state === 'failed' || state === 'stopping') {
        // 不能复用的宿主直接移出池：保留只会让下一次读取继续撞上它。
        if (entry.timer !== null) clearTimeout(entry.timer)
        this.entries.delete(entry.hostId)
        void entry.host.suspend().catch(() => undefined)
        continue
      }
      return entry
    }
    return null
  }

  /** 重新计时：每次使用后从当前时刻起算空闲，到期且没有会话时挂起进程并移出池。 */
  private touch(entry: PooledHost): void {
    // 移到队尾：容量裁剪按插入顺序丢最久未用的那个项目。
    this.entries.delete(entry.hostId)
    this.entries.set(entry.hostId, entry)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.release(entry.hostId)
    }, HOST_IDLE_RECLAIM_MS)
  }

  private async release(hostId: number): Promise<void> {
    const entry = this.entries.get(hostId)
    if (entry === undefined) return
    this.entries.delete(hostId)
    try {
      await entry.host.suspend()
    } catch {
      // 挂起未收敛时进程仍由宿主自身监督，下一次需要解析时再取新的宿主。
    }
    this.trim()
  }

  /**
   * 超出容量的项目按最久未用丢弃：只保留最近查看过的项目各一个解析进程。
   * 只在一个宿主刚收敛为空闲时调用，因此被丢掉的都是更久未用的项目，不会打断正在进行的读取。
   */
  private trim(): void {
    while (this.entries.size > LOG_HOST_CAPACITY) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      void this.release(oldest)
    }
  }
}
