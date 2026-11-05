/**
 * 会话用量统计索引存储：`<userData>/usage-stats-index.json` 的唯一读写者。
 *
 * 索引是会话 jsonl 文件流式扫描产物的本机缓存。每个会话文件由 `filePath` 及其
 * `fileStamp`（大小与修改时间）标识；未修改的文件直接复用缓存，已修改或新增的文件
 * 重新扫描，已删除的文件在同步时剔除。
 *
 * 索引文件损坏或丢失可随时丢弃重建，不作为唯一真相源。
 * 写入采用同目录临时文件加改名替换，中断时不会留下半份文件。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type {
  UsageDailyStat,
  UsageModelStat,
  UsageTokenBreakdown
} from '../../shared/usage-stats-api'

const FILE_NAME = 'usage-stats-index.json'
const INDEX_VERSION = 1

/** 单个会话文件的缓存统计数据 */
export interface CachedSessionUsage {
  readonly filePath: string
  readonly fileStamp: string
  readonly sessionId: string
  readonly cwd: string
  readonly title: string
  readonly updatedAt: number
  readonly messageCount: number
  readonly totals: UsageTokenBreakdown
  readonly cost: number
  readonly models: readonly UsageModelStat[]
  readonly daily: readonly UsageDailyStat[]
}

interface StoredUsageIndex {
  readonly version: number
  readonly savedAt: number
  readonly sessions: Record<string, CachedSessionUsage>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export class UsageStatsIndexStore {
  private inMemory: Map<string, CachedSessionUsage> = new Map()
  private loaded = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly getFilePath: () => string = () => join(app.getPath('userData'), FILE_NAME)) {}

  /** 读取索引，加载到内存；若文件不存在或结构损坏则初始化为空 Map */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const filePath = this.getFilePath()
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return
      console.warn('[usage-stats-index] 读取索引失败，将重建：', error)
      return
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || parsed.version !== INDEX_VERSION || !isRecord(parsed.sessions)) {
        return
      }
      for (const [key, value] of Object.entries(parsed.sessions)) {
        if (this.isValidCachedSession(value)) {
          this.inMemory.set(key, value)
        }
      }
    } catch (error) {
      console.warn('[usage-stats-index] 解析索引 JSON 失败，将重建：', error)
    }
  }

  /** 获取指定文件的缓存统计 */
  get(filePath: string, fileStamp: string): CachedSessionUsage | null {
    const cached = this.inMemory.get(filePath)
    if (!cached || cached.fileStamp !== fileStamp) return null
    return cached
  }

  /** 更新或插入单个会话文件的统计 */
  set(entry: CachedSessionUsage): void {
    this.inMemory.set(entry.filePath, entry)
  }

  /** 剔除不在当前现存文件列表中的孤立缓存条目 */
  prune(validFilePaths: ReadonlySet<string>): void {
    for (const key of this.inMemory.keys()) {
      if (!validFilePaths.has(key)) {
        this.inMemory.delete(key)
      }
    }
  }

  /** 获取当前内存中的全部条目 */
  all(): readonly CachedSessionUsage[] {
    return Array.from(this.inMemory.values())
  }

  /** 串行原子保存到磁盘 */
  async save(): Promise<void> {
    const filePath = this.getFilePath()
    const payload: StoredUsageIndex = {
      version: INDEX_VERSION,
      savedAt: Date.now(),
      sessions: Object.fromEntries(this.inMemory)
    }
    const serialized = JSON.stringify(payload)

    const op = this.writeTail.then(async () => {
      const dir = dirname(filePath)
      await mkdir(dir, { recursive: true })
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(tmpPath, serialized, 'utf8')
        await rename(tmpPath, filePath)
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => {})
        console.error('[usage-stats-index] 保存索引失败：', error)
      }
    })
    this.writeTail = op.catch(() => {})
    await op
  }

  private isValidCachedSession(value: unknown): value is CachedSessionUsage {
    if (!isRecord(value)) return false
    return typeof value.filePath === 'string'
      && typeof value.fileStamp === 'string'
      && typeof value.sessionId === 'string'
      && typeof value.cwd === 'string'
      && typeof value.title === 'string'
      && typeof value.updatedAt === 'number'
      && typeof value.messageCount === 'number'
      && isRecord(value.totals)
      && typeof value.cost === 'number'
      && Array.isArray(value.models)
      && Array.isArray(value.daily)
  }
}
