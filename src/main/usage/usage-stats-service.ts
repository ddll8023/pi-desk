/**
 * 会话用量统计主服务：
 * 按已登记项目遍历其会话目录，基于文件 mtime+size 增量扫描 JSONL 并维护本地索引缓存，
 * 对外输出「会话明细数组 + 扫描时间」的单一数据源；项目名映射在这里完成，
 * 概览、趋势、分布等报表读数全部由渲染层按时间范围从明细派生，本服务不再维护第二份聚合。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project } from '../../shared/project-api'
import type {
  UsageSessionStat,
  UsageStatsSummary,
  UsageStatsSummaryResult
} from '../../shared/usage-stats-api'
import { getProjectSessionDir } from '../sessions/session-store'
import type { CachedSessionUsage } from './usage-stats-index'
import { UsageStatsIndexStore } from './usage-stats-index'
import { scanSessionJsonl } from './usage-stats-scan'

export interface UsageStatsServiceOptions {
  readonly readProjects: () => Promise<readonly Project[]>
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function normalizePath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

export class UsageStatsService {
  private readonly indexStore = new UsageStatsIndexStore()
  private scanTail: Promise<UsageStatsSummaryResult> | null = null

  constructor(private readonly options: UsageStatsServiceOptions) {}

  /** 获取用量统计汇总；如果已有扫描正在进行则单飞复用，refresh=true 时强制全量重扫 */
  async getSummary(refresh = false): Promise<UsageStatsSummaryResult> {
    if (this.scanTail !== null && !refresh) {
      return this.scanTail
    }
    const task = this.runScan(refresh)
    this.scanTail = task
    try {
      return await task
    } finally {
      if (this.scanTail === task) {
        this.scanTail = null
      }
    }
  }

  private async runScan(forceRefresh: boolean): Promise<UsageStatsSummaryResult> {
    try {
      await this.indexStore.load()
      const projects = await this.options.readProjects()
      const projectMap = new Map<string, Project>()
      for (const p of projects) {
        projectMap.set(normalizePath(p.path), p)
      }

      const allFoundFiles = new Set<string>()
      const sessionRecords: CachedSessionUsage[] = []

      // 遍历每个已登记项目的会话目录
      for (const project of projects) {
        const sessionDir = getProjectSessionDir(project.path)
        let fileNames: string[] = []
        try {
          const entries = await readdir(sessionDir, { withFileTypes: true })
          fileNames = entries
            .filter(e => e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('.'))
            .map(e => e.name)
        } catch (error) {
          if (!isMissingPath(error)) {
            console.warn(`[usage-stats-service] 无法读取项目会话目录 (${sessionDir}):`, error)
          }
          continue
        }

        for (const fileName of fileNames) {
          const filePath = join(sessionDir, fileName)
          allFoundFiles.add(filePath)

          let size = 0
          let mtimeMs = 0
          try {
            const st = await stat(filePath, { bigint: true })
            if (!st.isFile()) continue
            size = Number(st.size)
            mtimeMs = Number(st.mtimeNs / 1_000_000n)
          } catch {
            continue
          }

          const fileStamp = `${size}_${mtimeMs}`

          if (!forceRefresh) {
            const cached = this.indexStore.get(filePath, fileStamp)
            if (cached !== null) {
              sessionRecords.push(cached)
              continue
            }
          }

          // 执行流式扫描
          const scanned = await scanSessionJsonl(filePath, fileStamp, mtimeMs)
          if (scanned !== null) {
            this.indexStore.set(scanned)
            sessionRecords.push(scanned)
          }
        }
      }

      // 剔除失效条目并异步持久化索引
      this.indexStore.prune(allFoundFiles)
      void this.indexStore.save().catch(err => {
        console.error('[usage-stats-service] 保存索引失败：', err)
      })

      const summary = this.buildSummary(sessionRecords, projectMap)
      return { ok: true, summary }
    } catch (error) {
      console.error('[usage-stats-service] 扫描会话用量失败：', error)
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : '无法统计会话用量。'
        }
      }
    }
  }

  /**
   * 把缓存明细映射为对外契约：只做项目名映射与扫描时间戳，不做任何聚合；
   * 会话的 cwd 匹配不到已登记项目时回退到目录名，保证来源仍可读。
   */
  private buildSummary(
    records: readonly CachedSessionUsage[],
    projectMap: ReadonlyMap<string, Project>
  ): UsageStatsSummary {
    const sessions: UsageSessionStat[] = records.map(record => {
      const matchedProject = projectMap.get(normalizePath(record.cwd))
      return {
        sessionId: record.sessionId,
        projectPath: matchedProject?.path ?? record.cwd,
        projectName: matchedProject?.name ?? record.cwd.split(/[\\/]/).pop() ?? '未知项目',
        title: record.title,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount,
        totals: record.totals,
        cost: record.costMessages > 0 ? record.cost : null,
        costMessages: record.costMessages,
        daily: record.daily,
        modelDaily: record.modelDaily,
        subAgentDaily: record.subAgentDaily
      }
    })

    return {
      sessions,
      scannedAt: Date.now()
    }
  }
}
