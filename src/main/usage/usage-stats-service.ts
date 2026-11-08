/**
 * 会话用量统计主服务：
 * 按已登记项目遍历其会话目录，基于文件 mtime+size 增量扫描 JSONL 并维护本地索引缓存，
 * 对外输出按模型、项目、按日趋势和 Top 会话的聚合统计摘要，费用只汇总上报价格的调用并附计价消息数。
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project } from '../../shared/project-api'
import type {
  UsageDailyStat,
  UsageModelStat,
  UsageProjectStat,
  UsageStatsSummary,
  UsageStatsSummaryResult,
  UsageTokenBreakdown,
  UsageTopSession
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

      // 聚合数据
      const summary = this.aggregateSummary(sessionRecords, projectMap)
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

  private aggregateSummary(
    records: readonly CachedSessionUsage[],
    projectMap: ReadonlyMap<string, Project>
  ): UsageStatsSummary {
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0
    let totalTokens = 0
    let totalCost = 0
    let totalCostMessages = 0
    let totalMessages = 0

    const modelAggregation = new Map<string, {
      provider: string
      modelId: string
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      totalTokens: number
      messageCount: number
      /** 已上报价格的调用合计；null 表示该模型没有任何计价调用。 */
      cost: number | null
    }>()

    const projectAggregation = new Map<string, {
      projectPath: string
      projectName: string
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      totalTokens: number
      sessionCount: number
      cost: number | null
    }>()

    const dailyAggregation = new Map<string, {
      date: string
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      totalTokens: number
      messageCount: number
      cost: number | null
    }>()

    const topSessions: UsageTopSession[] = []

    for (const record of records) {
      totalInput += record.totals.input
      totalOutput += record.totals.output
      totalCacheRead += record.totals.cacheRead
      totalCacheWrite += record.totals.cacheWrite
      totalTokens += record.totals.totalTokens
      totalMessages += record.messageCount
      if (record.costMessages > 0) {
        totalCost += record.cost
        totalCostMessages += record.costMessages
      }

      // 映射项目名称
      const normCwd = normalizePath(record.cwd)
      const matchedProject = projectMap.get(normCwd)
      const projectName = matchedProject?.name ?? record.cwd.split(/[\\/]/).pop() ?? '未知项目'
      const projectPath = matchedProject?.path ?? record.cwd

      // 累加模型
      for (const m of record.models) {
        const key = `${m.provider}:${m.modelId}`
        let bucket = modelAggregation.get(key)
        if (!bucket) {
          bucket = {
            provider: m.provider,
            modelId: m.modelId,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            messageCount: 0,
            cost: null
          }
          modelAggregation.set(key, bucket)
        }
        bucket.input += m.input
        bucket.output += m.output
        bucket.cacheRead += m.cacheRead
        bucket.cacheWrite += m.cacheWrite
        bucket.totalTokens += m.totalTokens
        bucket.messageCount += m.messageCount
        if (m.cost !== null) bucket.cost = (bucket.cost ?? 0) + m.cost
      }

      // 累加项目
      let projBucket = projectAggregation.get(normCwd)
      if (!projBucket) {
        projBucket = {
          projectPath,
          projectName,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          sessionCount: 0,
          cost: null
        }
        projectAggregation.set(normCwd, projBucket)
      }
      projBucket.input += record.totals.input
      projBucket.output += record.totals.output
      projBucket.cacheRead += record.totals.cacheRead
      projBucket.cacheWrite += record.totals.cacheWrite
      projBucket.totalTokens += record.totals.totalTokens
      projBucket.sessionCount += 1
      if (record.costMessages > 0) projBucket.cost = (projBucket.cost ?? 0) + record.cost

      // 累加日期
      for (const d of record.daily) {
        let dailyBucket = dailyAggregation.get(d.date)
        if (!dailyBucket) {
          dailyBucket = {
            date: d.date,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            messageCount: 0,
            cost: null
          }
          dailyAggregation.set(d.date, dailyBucket)
        }
        dailyBucket.input += d.input
        dailyBucket.output += d.output
        dailyBucket.cacheRead += d.cacheRead
        dailyBucket.cacheWrite += d.cacheWrite
        dailyBucket.totalTokens += d.totalTokens
        dailyBucket.messageCount += d.messageCount
        if (d.cost !== null) dailyBucket.cost = (dailyBucket.cost ?? 0) + d.cost
      }

      // 放入 Top 候选
      topSessions.push({
        projectPath,
        projectName,
        sessionId: record.sessionId,
        title: record.title,
        updatedAt: record.updatedAt,
        input: record.totals.input,
        output: record.totals.output,
        cacheRead: record.totals.cacheRead,
        cacheWrite: record.totals.cacheWrite,
        totalTokens: record.totals.totalTokens,
        messageCount: record.messageCount,
        cost: record.costMessages > 0 ? record.cost : null
      })
    }

    // 排序
    const sortedModels: UsageModelStat[] = Array.from(modelAggregation.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)

    const sortedProjects: UsageProjectStat[] = Array.from(projectAggregation.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)

    const sortedDaily: UsageDailyStat[] = Array.from(dailyAggregation.values())
      .sort((a, b) => a.date.localeCompare(b.date))

    const sortedTopSessions = topSessions
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 50)

    const totals: UsageTokenBreakdown = {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      totalTokens
    }

    return {
      totalSessions: records.length,
      totalMessages,
      costMessages: totalCostMessages,
      totals,
      totalCost: totalCostMessages > 0 ? totalCost : null,
      models: sortedModels,
      projects: sortedProjects,
      daily: sortedDaily,
      topSessions: sortedTopSessions,
      scannedAt: Date.now()
    }
  }
}
