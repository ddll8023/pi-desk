/**
 * 项目目录监听：只监听页面当前已加载的目录层，把变化按批推给页面，右侧文件树因此不必手动刷新。
 *
 * 不递归、也不做 gitignore 过滤：树是按层懒加载的，需要感知的只有已展开的那几层，逐目录 `fs.watch`
 * 因此天然不会进入 `node_modules` 与 `.git`，也不需要维护忽略表。页面提交目录集合，这里按集合做增删；
 * 项目根变化时整体重建，页面不需要自己拆监听。目录相对路径一律经 `normalizeRelativeDirectory` 归一，
 * 绝对路径与越界路径直接丢弃，页面无法借此监听项目外的东西。
 *
 * 事件按批发送：同一目录只报一次，连续变化用 150ms 合并窗口、自首个事件起最多 500ms 必发，避免一次
 * 依赖安装把 IPC 打满。批内目录过多或监听本身出错时只发一条 `overflow`，由页面退回整树重读。
 * 发送前对每个目录做一次 `stat`：目录已被删除或移走时改报它最近的仍然存在的父目录，页面据此重读父层
 * 并清掉过期的展开状态；这些失效目录的监听同时摘掉，等页面重新列举成功后再登记。
 */
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_DIRECTORY_WATCH_LIMIT } from '../../shared/project-file-api.ts'
import type {
  ProjectDirectoryChange,
  ProjectDirectoryWatchResult
} from '../../shared/project-file-api.ts'
import { normalizeRelativeDirectory } from './project-entry-path.ts'

/** 连续事件的合并窗口：最后一条事件之后等这么久再发，把一次批量写盘收成一条。 */
const WATCH_TRAILING_MS = 150
/** 自首个事件起的最大等待：持续写入时也必须定期发一条，不能一直等安静下来。 */
const WATCH_MAX_WAIT_MS = 500
/** 一批最多带多少个目录：超过说明变化规模已不适合逐层重读，改发 overflow。 */
const WATCH_BATCH_LIMIT = 200

/** 定时器句柄；注入的调度器只要求可比较，具体类型由实现决定。 */
type TimerHandle = unknown

/** 一批待发的变化；`overflow` 为真时 `directories` 一定为空。 */
export interface DirectoryBatch {
  readonly directories: readonly string[]
  readonly overflow: boolean
}

export interface DirectoryBatcherOptions {
  readonly trailingMs: number
  readonly maxWaitMs: number
  readonly limit: number
  readonly flush: (batch: DirectoryBatch) => void
  /** 时钟与调度器可注入，便于按虚拟时间测试合并窗口与上限。 */
  readonly now?: () => number
  readonly schedule?: (run: () => void, delayMs: number) => TimerHandle
  readonly cancel?: (handle: TimerHandle) => void
}

export interface DirectoryBatcher {
  /** 登记一个变化目录；重复登记只保留一次。 */
  request(directory: string): void
  /** 放弃逐层上报，改为一次整树重读。 */
  overflow(): void
  /** 丢弃待发批次但保持可用；切换项目与拆除监听时用。 */
  clear(): void
}

/**
 * 目录变化合并器：把零散事件收成一批。首个事件启动合并窗口，窗口内继续到达的事件只延长到
 * `maxWaitMs` 上限，到达上限立即发；批内目录数触顶时直接降级成 overflow。
 */
export function createDirectoryBatcher(options: DirectoryBatcherOptions): DirectoryBatcher {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs))
  const cancelTimer = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const pending = new Set<string>()
  let firstAt = 0
  let timer: TimerHandle | null = null
  let overflowing = false

  /** 清掉在途定时器；重复调用安全。 */
  function clearTimer(): void {
    if (timer === null) return
    cancelTimer(timer)
    timer = null
  }

  /** 立即发一批并清空状态；空批次不发。 */
  function flushNow(): void {
    clearTimer()
    const batch: DirectoryBatch = { directories: [...pending], overflow: overflowing }
    pending.clear()
    overflowing = false
    firstAt = 0
    if (batch.overflow || batch.directories.length > 0) options.flush(batch)
  }

  /** 按「合并窗口」与「最大等待」取较小值重排定时器。 */
  function scheduleFlush(): void {
    clearTimer()
    const elapsed = now() - firstAt
    const wait = Math.max(0, Math.min(options.trailingMs, options.maxWaitMs - elapsed))
    timer = schedule(() => {
      timer = null
      flushNow()
    }, wait)
  }

  return {
    request(directory: string): void {
      if (pending.size === 0) firstAt = now()
      pending.add(directory)
      if (pending.size >= options.limit) {
        overflowing = true
        pending.clear()
        flushNow()
        return
      }
      scheduleFlush()
    },
    overflow(): void {
      overflowing = true
      pending.clear()
      flushNow()
    },
    clear(): void {
      clearTimer()
      pending.clear()
      overflowing = false
      firstAt = 0
    }
  }
}

/** 归一监听集合：丢弃非法与越界路径、去重、按上限截断；根目录 `''` 原样保留。 */
export function normalizeWatchDirectories(directories: readonly string[]): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const directory of directories) {
    if (unique.length >= PROJECT_DIRECTORY_WATCH_LIMIT) break
    const normalized = normalizeRelativeDirectory(directory)
    if (normalized === null || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }
  return unique
}

/** 比较当前监听集合与目标集合，给出要新增与要摘掉的目录；顺序沿用目标集合。 */
export function planWatchDirectories(
  current: readonly string[],
  next: readonly string[]
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const currentSet = new Set(current)
  const nextSet = new Set(next)
  return {
    added: next.filter((directory) => !currentSet.has(directory)),
    removed: current.filter((directory) => !nextSet.has(directory))
  }
}

/** 项目内相对目录对应的绝对路径；根目录传 `''`。 */
function absoluteOf(root: string, directory: string): string {
  return directory === '' ? root : join(root, ...directory.split('/'))
}

/** 目录是否存在且确实是目录；不可读、已删除与权限问题都按「不存在」处理。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export interface ProjectDirectoryWatcherOptions {
  /** 当前项目路径的内存快照；未选择项目时为 null，不触发磁盘访问。 */
  readonly currentProjectPath: () => string | null
  /** 变化只发给当前窗口；页面已关闭时调用方自行丢弃。 */
  readonly sendChange: (change: ProjectDirectoryChange) => void
  /** 确实有目录发生变化时回调一次；用于丢弃文件索引等派生缓存，overflow 也会触发。 */
  readonly onChanged?: () => void
}

export class ProjectDirectoryWatcher {
  /** 监听所属的项目根；与当前项目不一致时整体重建。 */
  private root: string | null = null
  /** 已建立的监听：键是项目内相对目录，根目录为 `''`。 */
  private readonly entries = new Map<string, FSWatcher>()
  /** 系统级监听额度用尽后本次登记周期内不再尝试，避免反复失败抖动。 */
  private degraded = false
  private readonly options: ProjectDirectoryWatcherOptions
  private readonly batcher: DirectoryBatcher

  constructor(options: ProjectDirectoryWatcherOptions) {
    this.options = options
    this.batcher = createDirectoryBatcher({
      trailingMs: WATCH_TRAILING_MS,
      maxWaitMs: WATCH_MAX_WAIT_MS,
      limit: WATCH_BATCH_LIMIT,
      flush: (batch) => void this.flush(batch)
    })
  }

  /**
   * 按页面给出的目录集合调整监听：切项目时先拆掉旧根的全部监听，再按新集合登记。
   * 返回实际生效的目录数；不存在的目录不计入，也不会让整体失败。
   */
  async sync(directories: readonly string[]): Promise<ProjectDirectoryWatchResult> {
    const root = this.options.currentProjectPath()
    if (root !== this.root) {
      // 旧根的在途批次已不属于新项目：连同监听一起丢掉。
      this.batcher.clear()
      this.stopAll()
      this.root = root
      this.degraded = false
    }
    if (root === null) return { ok: true, data: { watching: 0 } }

    const next = normalizeWatchDirectories(directories)
    const plan = planWatchDirectories([...this.entries.keys()], next)
    for (const directory of plan.removed) this.unwatch(directory)

    // 保留的监听已经就位，新增的逐个建立；建立失败（目录刚被删）只是不计入生效数。
    let watching = next.length - plan.added.length
    for (const directory of plan.added) {
      if (this.attach(directory)) watching += 1
    }
    return { ok: true, data: { watching } }
  }

  /**
   * 拆掉全部监听并回到未选择项目的状态；窗口关闭与退出时调用。
   * 页面切项目不需要走到这里：下次登记时根不一致，`sync` 会自己重建。
   */
  dispose(): void {
    this.batcher.clear()
    this.stopAll()
    this.root = null
    this.degraded = false
  }

  /** 建立一层目录的监听；目录还不存在或没有权限时返回 false，等页面重新列举后再登记。 */
  private attach(directory: string): boolean {
    const root = this.root
    if (root === null || this.degraded) return false

    const target = absoluteOf(root, directory)
    try {
      const watcher = watch(target, { persistent: false }, () => this.batcher.request(directory))
      watcher.on('error', (error: unknown) => this.onWatcherError(directory, error))
      this.entries.set(directory, watcher)
      return true
    } catch {
      return false
    }
  }

  /** 摘掉一层监听；重复调用安全。 */
  private unwatch(directory: string): void {
    const watcher = this.entries.get(directory)
    if (watcher === undefined) return
    this.entries.delete(directory)
    try {
      watcher.close()
    } catch {
      // 已关闭的监听再关一次会抛错，忽略即可。
    }
  }

  /** 单层监听出错：摘掉它并让页面重读这一层；额度用尽则整体降级，不再重试。 */
  private onWatcherError(directory: string, error: unknown): void {
    this.unwatch(directory)
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'EMFILE' || code === 'ENOSPC') {
      this.degraded = true
      this.stopAll()
    }
    this.batcher.overflow()
  }

  private stopAll(): void {
    for (const directory of [...this.entries.keys()]) this.unwatch(directory)
  }

  /** 发一批变化：先把失效目录折算到最近的仍然存在的父目录，再交给页面。 */
  private async flush(batch: DirectoryBatch): Promise<void> {
    const root = this.root
    if (root === null) return
    this.options.onChanged?.()
    if (batch.overflow) {
      this.options.sendChange({ kind: 'overflow', projectPath: root, directories: [] })
      return
    }

    const affected: string[] = []
    const seen = new Set<string>()
    for (const directory of batch.directories) {
      const existing = await this.existingAncestor(root, directory)
      // 期间切换了项目：这一批已经不属于当前根，整批丢弃。
      if (root !== this.root) return
      if (existing === null || seen.has(existing)) continue
      seen.add(existing)
      affected.push(existing)
    }
    if (affected.length === 0) return
    this.options.sendChange({ kind: 'changed', projectPath: root, directories: affected })
  }

  /**
   * 取这一层仍然存在的最近祖先：目录还在就是它自己，已被删除或移走就上溯到父目录。
   * 上溯过程中顺带摘掉失效目录的监听，避免继续持有已删除 inode 的句柄。
   */
  private async existingAncestor(root: string, directory: string): Promise<string | null> {
    let current = directory
    for (;;) {
      if (await isDirectory(absoluteOf(root, current))) return current
      this.unwatch(current)
      if (current === '') return null
      const slash = current.lastIndexOf('/')
      current = slash < 0 ? '' : current.slice(0, slash)
    }
  }
}
