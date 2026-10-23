/**
 * 侧栏项目树的纯计算：把项目列表、按项目分片的会话列表与运行实例状态聚合成两级节点，
 * 供 ProjectSidebar 直接渲染，不在组件里做归属判断。
 *
 * 归属规则：会话只出现在自己项目的节点下；尚未落盘的当前会话与已登记但还没有文件条目的运行实例
 * 按运行实例报告的归属项目放置，因此切换项目后不会出现张冠李戴的条目。
 * 文案规则：会话行右侧只保留一项信息——需要用户动作或正在工作的状态优先于时间，
 * 已就绪的驻留实例保持安静，仍显示相对时间；完整时间与分叉来源留在操作浮层里。
 * 折叠规则：回退（Pi 的 fork）保留来源文件，分叉链只展示最新一条；当前会话与仍承载运行实例的会话不折叠。
 * 分页规则：会话列表是“最近 limit 条”的窗口而不是全量，节点同时带上窗口外的剩余数与加载状态，
 * 侧栏据此展示“加载更多”；占位条目只用于尚未落盘的会话，不用“不在已加载窗口里”判断。
 */
import { MAX_SESSION_WINDOW } from '../../../shared/session-api'
import type { Project } from '../../../shared/project-api'
import type { SessionSummary } from '../../../shared/session-api'
import { formatRelativeTime } from '../ui/relative-time'
import { collapseForkedSessions } from '../ui/forked-sessions'
import type { SessionRunState } from '../../../shared/session-run-api'
import { sessionRunBadge } from '../sessions/stores/session-runs'
import type { SessionRunBadge, UnboundSessionRun } from '../sessions/stores/session-runs'
import type { SessionViewState } from '../sessions/stores/session'

/** 各会话的运行状态文案；等待回应、未确认退出与已回收必须与普通空闲区分开。 */
export const SESSION_RUN_LABELS: Record<SessionRunBadge, string> = {
  unconfirmed: '上次退出未确认',
  failed: '宿主已失败',
  waiting: '等待回应',
  running: '正在执行',
  ready: '已就绪',
  suspended: '已回收',
  transitioning: '正在切换'
}

/** 项目节点上只展示需要留意的状态；已就绪、已回收与切换中不占用折叠项目的提示位。 */
const PROJECT_ACTIVITY_RANK: Readonly<Record<SessionRunBadge, number>> = {
  unconfirmed: 4,
  failed: 3,
  waiting: 2,
  running: 1,
  transitioning: 0,
  suspended: 0,
  ready: 0
}

/** 侧栏会话行；`title` 与 `meta` 已是可直接展示的文案。 */
export interface SidebarSessionRow {
  readonly session: SessionSummary
  readonly title: string
  /** 右侧元信息：状态短词或相对时间；标题因此获得整行宽度。 */
  readonly meta: string
  readonly badge: SessionRunBadge | null
  /** 分叉来源标题；没有来源或来源不可读时为 null。 */
  readonly forkedFrom: string | null
  /** 没有会话文件条目（尚未落盘的新会话或未绑定实例），不提供基于文件的操作。 */
  readonly pending: boolean
  /** 阻塞态（未确认退出或宿主失败），需要用户显式释放运行实例。 */
  readonly needsRelease: boolean
}

/** 一个项目节点及其会话；`expanded` 为假时不渲染会话行。 */
export interface SidebarProjectNode {
  readonly project: Project
  readonly current: boolean
  readonly expanded: boolean
  /** 该项目下最需要留意的运行状态；没有活动时为 null。 */
  readonly activity: SessionRunBadge | null
  readonly view: SessionViewState
  readonly sessions: readonly SidebarSessionRow[]
  readonly unboundRuns: readonly UnboundSessionRun[]
  readonly skipped: number
  /** 窗口之外仍未读取的会话文件数；大于 0 时侧栏提供“加载更多”。 */
  readonly remaining: number
  /** 正在扩大窗口；侧栏据此把“加载更多”显示为进行中。 */
  readonly loadingMore: boolean
  /** 窗口已达上限；到达后不再提供“加载更多”，避免无界读取与无界渲染。 */
  readonly windowFull: boolean
}

export interface SidebarTreeInput {
  readonly projects: readonly Project[]
  readonly currentProjectPath: string | null
  readonly expandedProjects: readonly string[]
  readonly sessionsOf: (projectPath: string) => readonly SessionSummary[]
  readonly viewOf: (projectPath: string) => SessionViewState
  readonly countsOf: (projectPath: string) => {
    readonly skipped: number
    readonly remaining: number
    readonly limit: number
  }
  /** 该项目是否正在扩大列表窗口。 */
  readonly loadingMoreOf: (projectPath: string) => boolean
  readonly runs: readonly SessionRunState[]
  /** 前台实例的会话身份；未落盘的当前会话按它造占位条目。 */
  readonly foregroundSessionId: string | null
  /**
   * 确实尚未落盘的当前会话身份（由运行状态给出）；只有它需要占位条目。
   * 已落盘的会话一定有会话文件，因此不能因为不在已加载窗口里就被补成占位行。
   */
  readonly unsavedSessionId: string | null
  /** 当前时刻，用于相对时间；由调用方传入，避免每次渲染取时钟。 */
  readonly now: number
}

/** 同一路径比较在页面侧折叠 Windows 大小写，与主进程口径一致。 */
function samePath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return left.toLowerCase() === right.toLowerCase()
}

/** 会话标题：优先会话文件里的首条用户消息，没有时按是否是当前会话给出中性标题。 */
function sessionTitle(session: SessionSummary, currentSessionId: string | null): string {
  const preview = session.preview?.trim()
  if (preview !== undefined && preview !== '') return preview
  return session.sessionId === currentSessionId ? '当前会话' : '未命名会话'
}

/** 没有文件条目的会话占位：没有可展示的元数据，也没有回退来源。 */
function placeholderSession(sessionId: string): SessionSummary {
  return {
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    sizeBytes: 0,
    preview: null,
    forkedFromSessionId: null
  }
}

/** 项目下最需要留意的运行状态；只统计需要动作或正在工作的状态。 */
function projectActivity(runs: readonly SessionRunState[]): SessionRunBadge | null {
  let found: SessionRunBadge | null = null
  for (const run of runs) {
    const badge = sessionRunBadge(run)
    if (PROJECT_ACTIVITY_RANK[badge] === 0) continue
    if (found === null || PROJECT_ACTIVITY_RANK[badge] > PROJECT_ACTIVITY_RANK[found]) found = badge
  }
  return found
}

/** 会话行：状态优先于时间；未落盘的会话没有文件时间，显示进行中而不是伪造时间。 */
function toSessionRow(
  session: SessionSummary,
  options: {
    readonly run: SessionRunState | null
    readonly pending: boolean
    readonly unsaved: boolean
    readonly currentSessionId: string | null
    readonly now: number
    readonly forkLabelOf: (sourceId: string) => string | null
  }
): SidebarSessionRow {
  const badge = options.run === null ? null : sessionRunBadge(options.run)
  const meta = badge !== null && badge !== 'ready'
    ? SESSION_RUN_LABELS[badge]
    : options.unsaved
      ? '进行中'
      : formatRelativeTime(session.updatedAt, options.now)
  return {
    session,
    title: sessionTitle(session, options.currentSessionId),
    meta,
    badge,
    forkedFrom: session.forkedFromSessionId === null
      ? null
      : options.forkLabelOf(session.forkedFromSessionId),
    pending: options.pending,
    needsRelease: badge === 'unconfirmed' || badge === 'failed'
  }
}

/** 按项目聚合成树；顺序与项目列表一致，展开状态只影响是否列出会话。 */
export function buildSidebarTree(input: SidebarTreeInput): readonly SidebarProjectNode[] {
  const { runs, foregroundSessionId, now } = input
  const currentSessionId = foregroundSessionId
  const unbound: UnboundSessionRun[] = runs
    .filter(run => run.sessionId === null)
    .map(run => ({ runId: run.runId, projectPath: run.projectPath, badge: sessionRunBadge(run) }))

  return input.projects.map((project) => {
    const projectRuns = runs.filter(run => samePath(run.projectPath, project.path))
    const listed = input.sessionsOf(project.path)
    const counts = input.countsOf(project.path)
    const listedIds = new Set(listed.map(session => session.sessionId))
    /** 分叉来源标题：来源不在本项目列表时退回 id 前缀，不显示空标注。 */
    const forkLabelOf = (sourceId: string): string | null => {
      const source = listed.find(candidate => candidate.sessionId === sourceId)
      return source === undefined ? `${sourceId.slice(0, 8)}…` : sessionTitle(source, currentSessionId)
    }

    const rows: SidebarSessionRow[] = []
    const seen = new Set<string>()
    const runOf = (sessionId: string): SessionRunState | null => (
      projectRuns.find(run => run.sessionId === sessionId) ?? null
    )
    // 分叉链只展示最新一条：当前会话与仍承载运行实例的会话即使被取代也保留。
    const visible = collapseForkedSessions(listed,
      sessionId => sessionId === currentSessionId || runOf(sessionId) !== null)

    // 尚未落盘的当前会话：新建后到首次写入之间只有运行身份，先按占位条目显示。
    // 判据是“确实尚未落盘”（由运行状态给出），不是“不在已加载窗口里”：列表分页后，
    // 后者会把窗口外已落盘的历史会话误报成占位行。
    if (currentSessionId !== null && currentSessionId === input.unsavedSessionId
      && samePath(input.currentProjectPath, project.path) && !listedIds.has(currentSessionId)) {
      const session = placeholderSession(currentSessionId)
      rows.push(toSessionRow(session, {
        run: runOf(currentSessionId), pending: true, unsaved: true, currentSessionId, now, forkLabelOf
      }))
      seen.add(currentSessionId)
    }
    // 已登记运行实例但还没有文件条目的会话（含已切到后台的）：文件落盘后由真实摘要接管。
    // 已知限制：这里仍以“不在已加载窗口里”判断，因此窗口外已落盘的历史会话会被补成占位行；
    // 当前只有“按 id 打开未加载会话”才可能触发，而现在没有这样的入口，所以不额外传会话文件信息。
    for (const run of projectRuns) {
      if (run.phase === 'idle' || run.sessionId === null || listedIds.has(run.sessionId) || seen.has(run.sessionId)) {
        continue
      }
      const session = placeholderSession(run.sessionId)
      rows.push(toSessionRow(session, {
        run, pending: true, unsaved: false, currentSessionId, now, forkLabelOf
      }))
      seen.add(run.sessionId)
    }
    // 文件会话已按最近活动降序返回，保持该顺序。
    for (const session of visible) {
      if (seen.has(session.sessionId)) continue
      rows.push(toSessionRow(session, {
        run: runOf(session.sessionId),
        pending: false,
        unsaved: false,
        currentSessionId,
        now,
        forkLabelOf
      }))
    }

    return {
      project,
      current: samePath(input.currentProjectPath, project.path),
      expanded: input.expandedProjects.includes(project.path),
      activity: projectActivity(projectRuns),
      view: input.viewOf(project.path),
      sessions: rows,
      unboundRuns: unbound.filter(run => samePath(run.projectPath, project.path)),
      skipped: counts.skipped,
      remaining: counts.remaining,
      loadingMore: input.loadingMoreOf(project.path),
      windowFull: counts.limit >= MAX_SESSION_WINDOW
    }
  })
}
