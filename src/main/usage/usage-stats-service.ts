/**
 * 会话用量统计主服务：
 * 按已登记项目遍历其会话目录，并另扫成员会话目录（成员会话不在项目会话目录里），
 * 基于文件 mtime+size 增量扫描 JSONL 并维护本地索引缓存，
 * 对外输出「会话明细数组 + 扫描时间」的单一数据源；项目名映射与团队归属标记在这里完成，
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
import { getPiAgentDir } from '../shared/pi-paths'
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

/** 成员会话目录的上级目录：统计需要单独扫一遍，否则团队开销在报表里完全看不到。 */
function teamSessionsRoot(): string {
  return join(getPiAgentDir(), 'team-sessions')
}

/**
 * 成员会话的归属：路径中的 `team-sessions/<根会话 id>/` 段决定团队，会话 id 的前缀去掉后是成员标识。
 * 普通会话返回 null；识别不出根会话的（目录被人改过）也当普通会话，不猜。
 */
function teamRefOf(filePath: string, sessionId: string): { rootSessionId: string; memberExpertId: string } | null {
  const parts = filePath.split(/[\\/]/)
  const index = parts.lastIndexOf('team-sessions')
  const rootSessionId = index >= 0 ? parts[index + 1] : undefined
  if (rootSessionId === undefined || rootSessionId === '') return null
  const prefix = `${rootSessionId}-`
  return {
    rootSessionId,
    memberExpertId: sessionId.startsWith(prefix) ? sessionId.slice(prefix.length) : sessionId
  }
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

      /** 扫一个会话目录：目录缺失或不可读只影响这一处，不中断整份统计。 */
      const collect = async (sessionDir: string): Promise<void> => {
        let fileNames: string[] = []
        try {
          const entries = await readdir(sessionDir, { withFileTypes: true })
          fileNames = entries
            .filter(e => e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('.'))
            .map(e => e.name)
        } catch (error) {
          if (!isMissingPath(error)) {
            console.warn(`[usage-stats-service] 无法读取会话目录 (${sessionDir}):`, error)
          }
          return
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

      // 已登记项目的会话目录
      for (const project of projects) {
        await collect(getProjectSessionDir(project.path))
      }

      // 团队成员会话：每个根会话一个子目录，用量单独归组而不是混回项目会话
      let teamRoots: string[] = []
      try {
        const entries = await readdir(teamSessionsRoot(), { withFileTypes: true })
        teamRoots = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
      } catch (error) {
        if (!isMissingPath(error)) {
          console.warn('[usage-stats-service] 无法读取成员会话目录：', error)
        }
      }
      for (const root of teamRoots) {
        await collect(join(teamSessionsRoot(), root))
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
      const team = teamRefOf(record.filePath, record.sessionId)
      return {
        sessionId: record.sessionId,
        projectPath: matchedProject?.path ?? record.cwd,
        projectName: matchedProject?.name ?? record.cwd.split(/[\\/]/).pop() ?? '未知项目',
        scope: team === null ? 'session' : 'team-member',
        team,
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
