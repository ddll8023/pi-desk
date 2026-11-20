/**
 * 成员轮次的观测记录契约：一次派活跑完后的终态、结论摘要、写入文件、待决项与用量。
 *
 * 记录由宿主在成员一轮结束时写入根会话（自定义条目，不进团长上下文正文），
 * 因此「是否完成、改了哪些文件」不依赖成员自述，也不依赖团长转述。
 * 读侧按条目聚合最新一轮与失败轮数，供摘要注入、打回上限与面板共用同一份口径。
 */

/** 根会话分支里的自定义条目类型；结构变化时升版本，旧记录按无效跳过。 */
export const TEAM_MEMBER_RUN_CUSTOM_TYPE = 'team-member-run.v1'

/** 同一条目允许的失败轮数上限：达到后不再接受再派，只能改派或上报用户。 */
export const MAX_TEAM_ITEM_REJECTIONS = 1
/** 单条目保留的轮次记录上限：超出时丢最早的，避免账本旁枝无界增长。 */
export const MAX_TEAM_MEMBER_RUNS = 64

export const MAX_TEAM_RUN_SUMMARY = 800
export const MAX_TEAM_RUN_FILES = 40
export const MAX_TEAM_RUN_QUESTIONS = 8
export const MAX_TEAM_RUN_TEXT = 400

/** running 只表示进程仍在跑；其余都是终态。 */
export type TeamMemberRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export const TEAM_MEMBER_RUN_STATUSES: readonly TeamMemberRunStatus[] = [
  'running', 'completed', 'failed', 'cancelled'
]

/** 中断与失败的成因；用于区分超时、用户停止与成员自身报错。 */
export type TeamMemberRunFailure = 'timeout' | 'aborted' | 'error' | 'unavailable'

export const TEAM_MEMBER_RUN_STATUS_LABELS: Readonly<Record<TeamMemberRunStatus, string>> = {
  running: '执行中',
  completed: '已完成一轮',
  failed: '失败',
  cancelled: '已中断'
}

export interface TeamMemberRunUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

/** 一条成员轮次记录。`attempt` 从 1 起，同一 itemId 的轮次按它排序。 */
export interface TeamMemberRun {
  readonly itemId: string
  readonly memberExpertId: string
  readonly attempt: number
  readonly status: TeamMemberRunStatus
  readonly startedAt: number
  readonly finishedAt: number | null
  /** 成员结论摘要；取它自己回复的正文，不做二次改写。 */
  readonly summary: string | null
  /** 本轮实际写入的文件，相对项目根；来自执行快照而不是成员自述。 */
  readonly files: readonly string[]
  /** 待决项：成员需要团长拍板的事，由团长决定继续、改派或问用户。 */
  readonly questions: readonly string[]
  readonly usage: TeamMemberRunUsage | null
  readonly failure: TeamMemberRunFailure | null
}

const ITEM_ID_PATTERN = /^[a-z][a-z0-9-]{0,15}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return null
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 解析自定义条目载荷；条目 id 或成员标识不合法时整条作废，不用半份记录推断状态。 */
export function parseTeamMemberRun(value: unknown): TeamMemberRun | null {
  if (!isRecord(value)) return null
  if (typeof value.itemId !== 'string' || !ITEM_ID_PATTERN.test(value.itemId)) return null
  if (typeof value.memberExpertId !== 'string' || value.memberExpertId === '') return null
  const status = TEAM_MEMBER_RUN_STATUSES.find(item => item === value.status)
  if (status === undefined) return null
  const files: string[] = []
  if (Array.isArray(value.files)) {
    for (const file of value.files.slice(0, MAX_TEAM_RUN_FILES)) {
      const path = text(file, MAX_TEAM_RUN_TEXT)
      if (path !== null) files.push(path)
    }
  }
  const questions: string[] = []
  if (Array.isArray(value.questions)) {
    for (const question of value.questions.slice(0, MAX_TEAM_RUN_QUESTIONS)) {
      const item = text(question, MAX_TEAM_RUN_TEXT)
      if (item !== null) questions.push(item)
    }
  }
  const usage = isRecord(value.usage)
    ? {
        inputTokens: count(value.usage.inputTokens),
        outputTokens: count(value.usage.outputTokens),
        totalTokens: count(value.usage.totalTokens)
      }
    : null
  const failure = value.failure === 'timeout' || value.failure === 'aborted'
    || value.failure === 'error' || value.failure === 'unavailable'
    ? value.failure
    : null
  return {
    itemId: value.itemId,
    memberExpertId: value.memberExpertId,
    attempt: count(value.attempt) || 1,
    status,
    startedAt: count(value.startedAt),
    finishedAt: typeof value.finishedAt === 'number' && Number.isFinite(value.finishedAt)
      ? Math.floor(value.finishedAt)
      : null,
    summary: text(value.summary, MAX_TEAM_RUN_SUMMARY),
    files,
    questions,
    usage,
    failure
  }
}

/** 同一条目的最新一轮；按 attempt 取最大而不是数组末位，记录顺序不参与判定。 */
export function latestTeamMemberRun(
  runs: readonly TeamMemberRun[],
  itemId: string
): TeamMemberRun | null {
  let latest: TeamMemberRun | null = null
  for (const run of runs) {
    if (run.itemId !== itemId) continue
    if (latest === null || run.attempt >= latest.attempt) latest = run
  }
  return latest
}

/** 同一条目已经用掉的打回机会：失败与中断都算一次，完成不算。 */
export function teamMemberRunRejections(runs: readonly TeamMemberRun[], itemId: string): number {
  return runs.filter(run => run.itemId === itemId
    && (run.status === 'failed' || run.status === 'cancelled')).length
}

/** 裁到上限：只留最近的若干轮，按 attempt 保留最新的，输出仍按原顺序。 */
export function limitTeamMemberRuns(runs: readonly TeamMemberRun[]): TeamMemberRun[] {
  if (runs.length <= MAX_TEAM_MEMBER_RUNS) return [...runs]
  return runs.slice(runs.length - MAX_TEAM_MEMBER_RUNS)
}
