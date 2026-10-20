/**
 * 终端历史的落盘：每个终端一份追加写入的原始输出，另有一份会话元数据清单。
 *
 * 为什么同时保留原始输出与模拟器快照：快照只活在守护进程内存里，机器重启或守护进程崩溃后就没了；
 * 原始输出可以重放，用来把「上一次看到的画面与历史」重建出来。两者互补，落盘只做前者。
 *
 * 写入是排队追加的：PTY 输出频率高，逐段同步写会把守护进程卡在磁盘上；队列同时保证同一终端的
 * 追加、裁剪与删除不会互相穿插。单个文件超过上限时按行边界裁掉前半段，避免无界增长。
 *
 * 边界：这里只负责文件读写与裁剪，不判断会话状态、不决定保留哪些终端；元数据由调用方按当前清单给出。
 */
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 单个终端历史文件的上限（字符）；超过后裁到一半，按行边界切。 */
const MAX_HISTORY_CHARS = 4 * 1024 * 1024

/** 恢复时最多重放的历史长度；只为让启动不被超长历史拖住。 */
const RESTORE_HISTORY_CHARS = 2 * 1024 * 1024

/** 元数据文件的格式版本；结构变化时递增，读到不认识的版本按空清单处理。 */
const SESSIONS_FILE_VERSION = 1

/** 一条会话记录：足以在守护进程重启后重建「已结束但保留历史」的终端。 */
export interface PersistedSessionRecord {
  readonly id: string
  readonly projectPath: string
  readonly shell: string
  readonly cwd: string
  readonly title: string
  readonly cols: number
  readonly rows: number
  readonly createdAt: number
}

export interface HistoryStoreOptions {
  /** 历史文件目录；由守护进程在启动时创建。 */
  readonly directory: string
  /** 会话元数据文件路径。 */
  readonly sessionsFile: string
  /** 记录非致命错误；不抛出，落盘失败只影响重启恢复。 */
  readonly onError: (error: unknown) => void
}

export class HistoryStore {
  /** 每个终端一条写入队列；追加、裁剪与删除都排在同一条链上。 */
  private readonly queues = new Map<string, Promise<void>>()
  /** 已写入的字符数（近似值）；用于判断何时裁剪，不必每次读文件大小。 */
  private readonly written = new Map<string, number>()
  private directoryReady: Promise<void> | null = null

  constructor(private readonly options: HistoryStoreOptions) {}

  /** 创建历史目录；失败只记日志，后续追加会自然失败并被忽略。 */
  private ensureDirectory(): Promise<void> {
    if (this.directoryReady === null) {
      this.directoryReady = mkdir(this.options.directory, { recursive: true, mode: 0o700 }).then(
        () => undefined,
        (error: unknown) => {
          this.options.onError(error)
        }
      )
    }
    return this.directoryReady
  }

  /** 追加一段输出；不等待落盘，失败只记日志。 */
  append(id: string, chunk: string): void {
    if (chunk === '') return
    const file = this.fileOf(id)
    const next = this.enqueue(id, async () => {
      await this.ensureDirectory()
      await appendFile(file, chunk, 'utf8')
      const total = (this.written.get(id) ?? 0) + chunk.length
      this.written.set(id, total)
      if (total > MAX_HISTORY_CHARS) await this.trim(id, file)
    })
    void next
  }

  /**
   * 读取用于恢复的历史：只取尾部，并在行边界切开，避免首行是半截转义序列。
   * 文件不存在时返回空串。
   */
  async readRestorable(id: string): Promise<string> {
    const file = this.fileOf(id)
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      return ''
    }
    if (content.length <= RESTORE_HISTORY_CHARS) return content
    const tail = content.slice(content.length - RESTORE_HISTORY_CHARS)
    const firstBreak = tail.indexOf('\n')
    return firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
  }

  /** 删除一个终端的历史文件；终端被关闭或项目被移除时调用。 */
  remove(id: string): void {
    const file = this.fileOf(id)
    void this.enqueue(id, async () => {
      this.written.delete(id)
      try {
        await rm(file, { force: true })
      } catch (error) {
        this.options.onError(error)
      }
    })
  }

  /** 等全部排队写入落盘；守护进程收尾前调用。 */
  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()])
  }

  /** 读取会话元数据；文件缺失、损坏或版本不认识时返回空清单。 */
  async readSessionRecords(): Promise<readonly PersistedSessionRecord[]> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.options.sessionsFile, 'utf8'))
    } catch {
      return []
    }
    if (typeof parsed !== 'object' || parsed === null) return []
    const file = parsed as { version?: unknown; sessions?: unknown }
    if (file.version !== SESSIONS_FILE_VERSION || !Array.isArray(file.sessions)) return []
    const records: PersistedSessionRecord[] = []
    for (const entry of file.sessions) {
      const record = parseRecord(entry)
      if (record !== null) records.push(record)
    }
    return records
  }

  /** 原子写入会话元数据：先写临时文件再改名，避免读到半截 JSON。 */
  async writeSessionRecords(records: readonly PersistedSessionRecord[]): Promise<void> {
    const payload = JSON.stringify({ version: SESSIONS_FILE_VERSION, sessions: records })
    const temporary = `${this.options.sessionsFile}.tmp-${process.pid}`
    try {
      await this.ensureDirectory()
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.options.sessionsFile)
    } catch (error) {
      this.options.onError(error)
    }
  }

  private fileOf(id: string): string {
    return join(this.options.directory, `${id}.log`)
  }

  /** 把一次操作排到该终端的队列尾部，返回本次操作的完成承诺。 */
  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(operation).catch((error: unknown) => {
      this.options.onError(error)
    })
    this.queues.set(id, next)
    // 队列排空后清掉引用，避免长期运行后按终端累积空链。
    void next.then(() => {
      if (this.queues.get(id) === next) this.queues.delete(id)
    })
    return next
  }

  /** 裁剪：保留后半段，并从第一个换行之后开始，避免留下半截转义序列。 */
  private async trim(id: string, file: string): Promise<void> {
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      return
    }
    if (content.length <= MAX_HISTORY_CHARS / 2) return
    const tail = content.slice(content.length - MAX_HISTORY_CHARS / 2)
    const firstBreak = tail.indexOf('\n')
    const kept = firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
    const temporary = `${file}.tmp-${process.pid}`
    await writeFile(temporary, kept, 'utf8')
    await rename(temporary, file)
    this.written.set(id, kept.length)
  }

  /** 历史文件当前大小（字节）；只用于状态展示，读取失败按 0 处理。 */
  async sizeOf(id: string): Promise<number> {
    try {
      return (await stat(this.fileOf(id))).size
    } catch {
      return 0
    }
  }
}

/** 校验一条持久化记录；字段不全或类型不符时丢弃这一条，不影响其他记录。 */
function parseRecord(value: unknown): PersistedSessionRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const strings = ['id', 'projectPath', 'shell', 'cwd', 'title'] as const
  for (const key of strings) {
    if (typeof record[key] !== 'string' || (record[key] as string) === '') return null
  }
  const numbers = ['cols', 'rows', 'createdAt'] as const
  for (const key of numbers) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key] as number)) return null
  }
  return {
    id: record.id as string,
    projectPath: record.projectPath as string,
    shell: record.shell as string,
    cwd: record.cwd as string,
    title: record.title as string,
    cols: record.cols as number,
    rows: record.rows as number,
    createdAt: record.createdAt as number
  }
}
