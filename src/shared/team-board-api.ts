/**
 * 任务账本的契约与形状校验。
 *
 * 账本是团队模式下团长维护的唯一任务状态来源：目标、已确认事实、计划条目（状态、依赖、指派成员、验收项）。
 * 它只存在工具结果的 `details` 里，随会话分支落盘，rewind 或 fork 后自然回到当时那份，不需要外部存储或清理。
 * 本文件只做纯数据的形状与上限校验，不做状态推进判定——推进规则由工具描述与团队分段约束。
 */

export const TEAM_BOARD_TOOL_NAME = 'team_board'
/** details 结构版本；与实现同时升级，旧版本按无效处理而不是猜字段。 */
export const TEAM_BOARD_VERSION = 1

export const MAX_TEAM_BOARD_ITEMS = 32
export const MAX_TEAM_BOARD_FACTS = 20
export const MAX_TEAM_BOARD_CHECKS = 8
export const MAX_TEAM_BOARD_DEPENDENCIES = 8
/** 单条文本上限：目标、标题、事实、验收项共用；超出截断，不整条丢弃。 */
export const MAX_TEAM_BOARD_TEXT = 400
export const MAX_TEAM_BOARD_GOAL = 1_000

/** 条目状态机：pending → assigned → running → review → done，失败走 failed。 */
export type TeamBoardItemStatus = 'pending' | 'assigned' | 'running' | 'review' | 'done' | 'failed'

export const TEAM_BOARD_STATUSES: readonly TeamBoardItemStatus[] = [
  'pending', 'assigned', 'running', 'review', 'done', 'failed'
]

/** 未终态：摘要与回述只列这些，已完成与已失败不占注意力。 */
export const TEAM_BOARD_OPEN_STATUSES: readonly TeamBoardItemStatus[] = [
  'pending', 'assigned', 'running', 'review'
]

export const TEAM_BOARD_STATUS_LABELS: Readonly<Record<TeamBoardItemStatus, string>> = {
  pending: '待分配',
  assigned: '已分配',
  running: '执行中',
  review: '待验收',
  done: '已完成',
  failed: '已失败'
}

/** 一条验收项：只有团长在 review 阶段勾选，成员不能自行标记。 */
export interface TeamBoardCheck {
  readonly text: string
  readonly done: boolean
}

/** 一个任务条目。`assignee` 是成员专家标识；`blockedBy` 引用其他条目标识。 */
export interface TeamBoardItem {
  readonly id: string
  readonly title: string
  readonly status: TeamBoardItemStatus
  readonly assignee: string | null
  readonly blockedBy: readonly string[]
  readonly checks: readonly TeamBoardCheck[]
  /** 一句话备注：为什么卡住、打回了什么；不写长篇过程。 */
  readonly note: string | null
}

export interface TeamBoard {
  readonly goal: string
  readonly facts: readonly string[]
  readonly items: readonly TeamBoardItem[]
}

/** 工具结果 details：在账本之上加版本号。 */
export interface TeamBoardDetails extends TeamBoard {
  readonly version: 1
}

const ITEM_ID_PATTERN = /^[a-z][a-z0-9-]{0,15}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 文本归一：折叠空白并按上限截断；空串返回 null，由调用方决定丢弃。 */
function normalizeText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return null
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

function teamBoardStatus(value: unknown): TeamBoardItemStatus {
  return TEAM_BOARD_STATUSES.find(item => item === value) ?? 'pending'
}

/**
 * 解析工具结果里的账本；结构版本不符或目标缺失时返回 null。
 * 单条非法只丢这一条，其余照常保留——整份账本失效比缺一条更糟。
 */
export function parseTeamBoardDetails(value: unknown): TeamBoardDetails | null {
  if (!isRecord(value) || value.version !== TEAM_BOARD_VERSION) return null
  const goal = normalizeText(value.goal, MAX_TEAM_BOARD_GOAL)
  if (goal === null) return null

  const facts: string[] = []
  if (Array.isArray(value.facts)) {
    for (const fact of value.facts.slice(0, MAX_TEAM_BOARD_FACTS)) {
      const item = normalizeText(fact, MAX_TEAM_BOARD_TEXT)
      if (item !== null) facts.push(item)
    }
  }

  const items: TeamBoardItem[] = []
  const seen = new Set<string>()
  if (Array.isArray(value.items)) {
    for (const raw of value.items.slice(0, MAX_TEAM_BOARD_ITEMS)) {
      if (!isRecord(raw)) continue
      if (typeof raw.id !== 'string' || !ITEM_ID_PATTERN.test(raw.id) || seen.has(raw.id)) continue
      const title = normalizeText(raw.title, MAX_TEAM_BOARD_TEXT)
      if (title === null) continue
      seen.add(raw.id)
      const blockedBy: string[] = []
      if (Array.isArray(raw.blockedBy)) {
        for (const dependency of raw.blockedBy.slice(0, MAX_TEAM_BOARD_DEPENDENCIES)) {
          if (typeof dependency === 'string' && ITEM_ID_PATTERN.test(dependency) && dependency !== raw.id) {
            blockedBy.push(dependency)
          }
        }
      }
      const checks: TeamBoardCheck[] = []
      if (Array.isArray(raw.checks)) {
        for (const check of raw.checks.slice(0, MAX_TEAM_BOARD_CHECKS)) {
          if (!isRecord(check)) continue
          const label = normalizeText(check.text, MAX_TEAM_BOARD_TEXT)
          if (label !== null) checks.push({ text: label, done: check.done === true })
        }
      }
      items.push({
        id: raw.id,
        title,
        status: teamBoardStatus(raw.status),
        assignee: typeof raw.assignee === 'string' && raw.assignee !== '' ? raw.assignee : null,
        blockedBy,
        checks,
        note: normalizeText(raw.note, MAX_TEAM_BOARD_TEXT)
      })
    }
  }

  return { version: TEAM_BOARD_VERSION, goal, facts, items }
}

/** 各状态的条目数；摘要行与面板计数共用。 */
export function teamBoardCounts(board: TeamBoard): Readonly<Record<TeamBoardItemStatus, number>> {
  const counts: Record<TeamBoardItemStatus, number> = {
    pending: 0, assigned: 0, running: 0, review: 0, done: 0, failed: 0
  }
  for (const item of board.items) counts[item.status] += 1
  return counts
}

/** 未完成条目：摘要与回述只列这些，避免已完成项反复占据上下文末尾。 */
export function teamBoardOpenItems(board: TeamBoard): TeamBoardItem[] {
  return board.items.filter(item => TEAM_BOARD_OPEN_STATUSES.includes(item.status))
}
