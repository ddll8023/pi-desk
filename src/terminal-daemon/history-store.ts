/** 终端历史与冷画面的落盘：输出批量追加、积压可计量，画面及元数据原子写入且同一路径不并发写。 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TERMINAL_TITLE_MAX_CHARS } from '../shared/terminal-api'
import { TERMINAL_SNAPSHOT_MAX_CHARS } from '../shared/terminal-daemon-protocol'

const MAX_HISTORY_CHARS = 4 * 1024 * 1024
const RESTORE_HISTORY_CHARS = 2 * 1024 * 1024
const SESSIONS_FILE_VERSION = 1
const APPEND_INTERVAL_MS = 16
const APPEND_BATCH_CHARS = 256 * 1024

export interface PersistedSessionRecord {
  readonly id: string
  readonly projectPath: string
  readonly shell: string
  readonly cwd: string
  /** 用户命名的标题；null 表示用户未命名，回退到程序上报标题或 shell 默认名。 */
  readonly userTitle: string | null
  /** 程序通过 OSC 上报的标题；null 表示从未上报，恢复时用 shell 默认名。 */
  readonly title: string | null
  /** 新建时的 shell 默认名；作为最后回退，保证标签永远不会空。 */
  readonly defaultTitle: string
  readonly cols: number
  readonly rows: number
  readonly createdAt: number
}
export interface PersistedScreen {
  readonly ansi: string
  readonly cols: number
  readonly rows: number
}
export interface HistoryStoreOptions {
  readonly directory: string
  readonly sessionsFile: string
  readonly onError: (error: unknown) => void
  readonly onConsumed?: (id: string) => void
}
interface OutputBuffer {
  chunks: string[]
  chars: number
  timer: NodeJS.Timeout | null
  draining: boolean
}

export class HistoryStore {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly buffers = new Map<string, OutputBuffer>()
  private readonly written = new Map<string, number>()
  private directoryReady: Promise<unknown> | null = null
  private recordsPending: readonly PersistedSessionRecord[] | null = null
  private recordsWriting: Promise<void> | null = null

  constructor(private readonly options: HistoryStoreOptions) {}

  private ensureDirectory(): Promise<unknown> {
    this.directoryReady ??= mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    return this.directoryReady
  }

  getPendingChars(id: string): number { return this.buffers.get(id)?.chars ?? 0 }

  append(id: string, chunk: string): void {
    if (chunk === '') return
    let buffer = this.buffers.get(id)
    if (buffer === undefined) {
      buffer = { chunks: [], chars: 0, timer: null, draining: false }
      this.buffers.set(id, buffer)
    }
    buffer.chunks.push(chunk)
    buffer.chars += chunk.length
    if (buffer.draining) return
    if (buffer.chars >= APPEND_BATCH_CHARS) { this.drain(id, buffer); return }
    if (buffer.timer === null) buffer.timer = setTimeout(() => this.drain(id, buffer), APPEND_INTERVAL_MS)
  }

  /** 仅文件批次进入串行链；PTY 小块不再各自创建文件操作与 Promise。 */
  private drain(id: string, buffer: OutputBuffer): void {
    if (buffer.timer !== null) clearTimeout(buffer.timer)
    buffer.timer = null
    if (buffer.draining || buffer.chunks.length === 0) return
    buffer.draining = true
    void this.enqueue(id, async () => {
      try {
        await this.ensureDirectory()
        while (buffer.chunks.length > 0) {
          const content = buffer.chunks.join('')
          buffer.chunks = []
          try {
            await appendFile(this.fileOf(id), content, { encoding: 'utf8', mode: 0o600 })
            const total = (this.written.get(id) ?? 0) + content.length
            this.written.set(id, total)
            if (total > MAX_HISTORY_CHARS) await this.trim(id)
          } finally {
            buffer.chars = Math.max(0, buffer.chars - content.length)
            this.options.onConsumed?.(id)
          }
        }
      } finally {
        buffer.draining = false
        // 磁盘失败时释放剩余引用，错误由队列统一上报；不把失败输出永久留在内存。
        buffer.chunks = []
        buffer.chars = 0
        if (this.buffers.get(id) === buffer) this.buffers.delete(id)
        this.options.onConsumed?.(id)
      }
    })
  }

  async readRestorable(id: string): Promise<string> {
    let content: string
    try { content = await readFile(this.fileOf(id), 'utf8') } catch { return '' }
    if (content.length <= RESTORE_HISTORY_CHARS) return content
    const tail = content.slice(-RESTORE_HISTORY_CHARS)
    const firstBreak = tail.indexOf('\n')
    return firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
  }

  async readScreen(id: string): Promise<PersistedScreen | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.screenOf(id), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return null
      const value = parsed as Record<string, unknown>
      if (typeof value.ansi !== 'string' || value.ansi.length > TERMINAL_SNAPSHOT_MAX_CHARS
        || !isDimension(value.cols) || !isDimension(value.rows)) return null
      return { ansi: value.ansi, cols: value.cols, rows: value.rows }
    } catch { return null }
  }

  async writeScreen(id: string, screen: PersistedScreen): Promise<void> {
    this.flushBuffer(id)
    await this.enqueue(id, async () => {
      await this.ensureDirectory()
      await this.atomicWrite(this.screenOf(id), JSON.stringify(screen))
    })
  }

  /** 已退出会话不再保留写入计数；文件和画面留在磁盘供按需读取。 */
  async seal(id: string): Promise<void> {
    this.flushBuffer(id)
    await this.queues.get(id)
    this.written.delete(id)
  }

  remove(id: string): void {
    const buffer = this.buffers.get(id)
    if (buffer !== undefined) {
      if (buffer.timer !== null) clearTimeout(buffer.timer)
      buffer.timer = null
      buffer.chunks = []
      if (!buffer.draining) this.buffers.delete(id)
    }
    void this.enqueue(id, async () => {
      await rm(this.fileOf(id), { force: true })
      await rm(this.screenOf(id), { force: true })
      this.written.delete(id)
    })
  }

  private flushBuffer(id: string): void {
    const buffer = this.buffers.get(id)
    if (buffer !== undefined) this.drain(id, buffer)
  }

  async flush(): Promise<void> {
    for (const id of this.buffers.keys()) this.flushBuffer(id)
    await Promise.all([...this.queues.values()])
    await this.recordsWriting
  }

  async readSessionRecords(): Promise<readonly PersistedSessionRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.sessionsFile, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return []
      const file = parsed as { version?: unknown; sessions?: unknown }
      if (file.version !== SESSIONS_FILE_VERSION || !Array.isArray(file.sessions)) return []
      const records: PersistedSessionRecord[] = []
      const ids = new Set<string>()
      for (const entry of file.sessions) {
        const record = parseRecord(entry)
        if (record !== null && !ids.has(record.id)) { records.push(record); ids.add(record.id) }
      }
      return records
    } catch { return [] }
  }

  /** 最多保留一个最新待写版本，慢盘不会把尺寸变化排成无界元数据队列。 */
  writeSessionRecords(records: readonly PersistedSessionRecord[]): Promise<void> {
    this.recordsPending = records
    if (this.recordsWriting !== null) return this.recordsWriting
    this.recordsWriting = (async () => {
      while (this.recordsPending !== null) {
        const next = this.recordsPending
        this.recordsPending = null
        try {
          await this.ensureDirectory()
          await this.atomicWrite(this.options.sessionsFile, JSON.stringify({ version: SESSIONS_FILE_VERSION, sessions: next }))
        } catch (error) { this.options.onError(error) }
      }
    })().finally(() => { this.recordsWriting = null })
    return this.recordsWriting
  }

  private fileOf(id: string): string { return join(this.options.directory, `${id}.log`) }
  private screenOf(id: string): string { return join(this.options.directory, `${id}.screen.json`) }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(operation).catch(this.options.onError)
    this.queues.set(id, next)
    void next.then(() => { if (this.queues.get(id) === next) this.queues.delete(id) })
    return next
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const temporary = `${file}.tmp-${process.pid}`
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }

  private async trim(id: string): Promise<void> {
    const file = this.fileOf(id)
    const content = await readFile(file, 'utf8')
    const tail = content.slice(-MAX_HISTORY_CHARS / 2)
    const firstBreak = tail.indexOf('\n')
    const kept = firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
    await this.atomicWrite(file, kept)
    this.written.set(id, kept.length)
  }
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 1000
}
function parseRecord(value: unknown): PersistedSessionRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  // 记录来自磁盘，标识仍需限制为单个文件名，不能借恢复访问历史目录之外。
  if (typeof record.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(record.id)) return null
  for (const key of ['projectPath', 'shell', 'cwd'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '') return null
  }
  if (!isDimension(record.cols) || !isDimension(record.rows)
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null
  const title = parseOptionalTitle(record.title)
  return {
    id: record.id, projectPath: record.projectPath as string, shell: record.shell as string,
    cwd: record.cwd as string, userTitle: parseOptionalTitle(record.userTitle),
    title, defaultTitle: parseOptionalTitle(record.defaultTitle) ?? title ?? shellNameOf(record.shell as string),
    cols: record.cols, rows: record.rows, createdAt: record.createdAt
  }
}
/**
 * 旧版本记录只有 `title`（当时存的就是 shell 默认名），没有 `defaultTitle`。
 * 这类记录按 shell 文件名补出默认名，避免升级后整条会话记录被判非法而丢失。
 */
function shellNameOf(shell: string): string {
  const name = shell.slice(shell.lastIndexOf('/') + 1).slice(shell.lastIndexOf('\\') + 1)
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name
}
/** 可选标题：非法或缺失一律按未设置处理，不让一条脏记录拖掉整份会话清单。 */
function parseOptionalTitle(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= TERMINAL_TITLE_MAX_CHARS ? value : null
}
