/**
 * 团队任务账本：一个状态型工具、一份系统提示摘要，加一层按需回述。
 *
 * 账本只存在工具结果的 `details` 里，随会话分支落盘：rewind 或 fork 之后自然回到当时那份，
 * 不需要额外同步或清理；重建从分支倒查最近一次 `team_board` 结果，压缩掉旧工具结果也能恢复。
 *
 * 只在团队模式的根会话注册：成员会话没有这个工具，任务状态因此只有一个写入方（团长）。
 * 摘要进独立的系统提示分段而不写进团队分段，避免两个扩展抢同一段文本的写入权；
 * 回述走 `context` 钩子按工具结果计数节流，间隔比待办清单稀疏，两条回述不会互相挤压。
 */
import type { ExtensionAPI, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { TeamBoardDetails } from '../shared/team-board-api'
import {
  MAX_TEAM_BOARD_CHECKS,
  MAX_TEAM_BOARD_DEPENDENCIES,
  MAX_TEAM_BOARD_FACTS,
  MAX_TEAM_BOARD_GOAL,
  MAX_TEAM_BOARD_ITEMS,
  MAX_TEAM_BOARD_TEXT,
  TEAM_BOARD_STATUS_LABELS,
  TEAM_BOARD_STATUSES,
  TEAM_BOARD_TOOL_NAME,
  TEAM_BOARD_VERSION,
  parseTeamBoardDetails,
  teamBoardCounts,
  teamBoardOpenItems
} from '../shared/team-board-api'
import type { TeamBoard, TeamBoardItem } from '../shared/team-board-api'

/** 账本摘要段在系统提示里的键；与团队分段并列，按轮重写。 */
export const TEAM_BOARD_SECTION_KEY = 'team-board'
export const TEAM_BOARD_EXTENSION_NAME = 'team-board'

/**
 * 回述间隔（工具结果个数）：账本比待办清单变化慢，间隔更疏；
 * 与待办清单的间隔取不成整数倍，避免两条回述总在同一批工具结果后同时出现。
 */
const RECITE_INTERVAL = 5
const RECITE_CUSTOM_TYPE = 'team-board.recitation.v1'
const RECITE_PREFIX = '【账本回述】当前团队任务账本，不是用户的新消息，也不要回复它：据此刻状态校准分工，'
  + `某项状态变化时立刻用 ${TEAM_BOARD_TOOL_NAME} 重新提交整份账本。`

type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

/** 参数与 details 同构；上限写进 schema，让模型在提交前就知道边界。 */
const BOARD_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'items'],
  properties: {
    goal: {
      type: 'string',
      description: `本轮团队要达成的目标，一句话到一段话（上限 ${MAX_TEAM_BOARD_GOAL} 字）。`
    },
    facts: {
      type: 'array',
      maxItems: MAX_TEAM_BOARD_FACTS,
      description: '已确认的事实：来自用户或代码的证据，不写推测。',
      items: { type: 'string' }
    },
    items: {
      type: 'array',
      maxItems: MAX_TEAM_BOARD_ITEMS,
      description: '完整任务条目；每次提交覆盖上一版，只交变化项会丢掉其余条目。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'status'],
        properties: {
          id: { type: 'string', description: '短标识：小写字母开头，只含小写字母、数字与连字符，如 t1。' },
          title: { type: 'string', description: `一句话说清这个条目要产出什么（上限 ${MAX_TEAM_BOARD_TEXT} 字）。` },
          status: { type: 'string', enum: TEAM_BOARD_STATUSES, description: '条目状态；默认 pending。' },
          assignee: { type: 'string', description: '承担的成员专家标识；未分配时不传。' },
          blockedBy: {
            type: 'array',
            maxItems: MAX_TEAM_BOARD_DEPENDENCIES,
            description: '依赖的条目标识；这些条目未完成时本条不应开始。',
            items: { type: 'string' }
          },
          checks: {
            type: 'array',
            maxItems: MAX_TEAM_BOARD_CHECKS,
            description: '验收项：能不能收这条的标准，验收时逐项勾选。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text'],
              properties: {
                text: { type: 'string' },
                done: { type: 'boolean', description: '团长验收通过后才勾选。' }
              }
            }
          },
          note: { type: 'string', description: '一句话备注：为什么卡住或打回了什么。' }
        }
      }
    }
  }
} as unknown as ToolParameters

function statusMark(status: TeamBoardItem['status']): string {
  return TEAM_BOARD_STATUS_LABELS[status]
}

/** 一行摘要：目标截断到一句，状态计数按固定顺序给出，供系统提示逐轮使用。 */
export function renderBoardSummary(board: TeamBoard): string {
  const counts = teamBoardCounts(board)
  const parts = TEAM_BOARD_STATUSES.filter(status => counts[status] > 0)
    .map(status => `${statusMark(status)} ${counts[status]}`)
  const goal = board.goal.length > 120 ? `${board.goal.slice(0, 120)}…` : board.goal
  return `团队账本：${goal}（共 ${board.items.length} 项；${parts.join('、') || '暂无条目'}）`
}

/** 条目行：标识、标题、承担者、依赖与验收进度；回述与工具回执共用。 */
function renderItem(item: TeamBoardItem): string {
  const parts = [`${item.id} ${item.title}`, statusMark(item.status)]
  if (item.assignee !== null) parts.push(`@${item.assignee}`)
  if (item.blockedBy.length > 0) parts.push(`依赖 ${item.blockedBy.join('、')}`)
  if (item.checks.length > 0) {
    const done = item.checks.filter(check => check.done).length
    parts.push(`验收 ${done}/${item.checks.length}`)
  }
  const line = `- ${parts.join(' · ')}`
  return item.note === null ? line : `${line}\n  ${item.note}`
}

/** 未完成条目的完整清单；没有未完成项时给一句收尾提示。 */
export function renderBoardOpenItems(board: TeamBoard): string {
  const open = teamBoardOpenItems(board)
  if (open.length === 0) return '（没有未完成条目；如任务已交付，说明结论与遗留项。）'
  return open.map(renderItem).join('\n')
}

/** 从分支倒查最近一次账本结果；账本跨轮有效，因此不按用户消息截断。 */
export function readTeamBoard(entries: readonly SessionEntry[]): TeamBoardDetails | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'toolResult' || message.toolName !== TEAM_BOARD_TOOL_NAME) continue
    const parsed = parseTeamBoardDetails(message.details)
    return parsed
  }
  return null
}

/** 本轮自上次提交账本之后产生了多少个工具结果；本轮还没提交过时返回 null。 */
function countToolResultsSinceBoard(entries: readonly SessionEntry[]): number | null {
  let count = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'toolResult') continue
    if (message.toolName === TEAM_BOARD_TOOL_NAME) return count
    count += 1
  }
  return null
}

/**
 * 把账本收敛到本团队：指派到名单外的人会被后续派活当成无效目标，
 * 依赖不存在的条目会让依赖图永远等不到，两者都在提交时剔掉并告诉模型。
 */
function bindToTeam(board: TeamBoardDetails, members: ReadonlySet<string>): {
  board: TeamBoardDetails
  ignored: string[]
} {
  const ids = new Set(board.items.map(item => item.id))
  const ignored: string[] = []
  const items = board.items.map(item => {
    let assignee = item.assignee
    if (assignee !== null && !members.has(assignee)) {
      ignored.push(`${item.id}：成员 ${assignee} 不在本团队，已清空指派`)
      assignee = null
    }
    const blockedBy = item.blockedBy.filter(dependency => ids.has(dependency))
    if (blockedBy.length !== item.blockedBy.length) {
      const missing = item.blockedBy.filter(dependency => !ids.has(dependency))
      ignored.push(`${item.id}：依赖 ${missing.join('、')} 不存在，已移除`)
    }
    // 完成只能由验收项判定：未勾完就置 done 的条目退回代码里的 review，由团长补齐验收或改状态。
    let status = item.status
    if (status === 'done' && item.checks.some(check => !check.done)) {
      status = 'review'
      ignored.push(`${item.id}：验收项还没全部勾选，状态保持 review`)
    }
    return { ...item, status, assignee, blockedBy }
  })
  return { board: { ...board, items }, ignored }
}

/** 账本只能有一个团长写入方：登记为团队模式专用工具，成员会话不注册本扩展。 */
export function createTeamBoardExtension(options: {
  /** 本团队成员专家标识；指派到名单外的人会让后续派活找不到目标，提交时就剔掉。 */
  readonly memberExpertIds: readonly string[]
}): ExtensionFactory {
  const members = new Set(options.memberExpertIds)
  return pi => {
    pi.registerTool<ToolParameters, TeamBoardDetails>({
      name: TEAM_BOARD_TOOL_NAME,
      label: '团队任务账本',
      description: '提交或更新团队任务账本：目标、已确认事实与任务条目（状态、依赖、指派成员、验收项）。'
        + '每次提交覆盖上一版，全部条目都要带上。条目状态由团长推进：'
        + 'pending（待分配）→ assigned（已分配）→ running（执行中）→ review（待验收）→ done（已完成），'
        + '失败走 failed 并在 note 里写原因。验收项只有 review 阶段才勾选。账本跨轮有效，任务结束时也要提交一次终态。',
      promptSnippet: 'team_board — 提交或更新团队任务账本（团队模式的任务状态只由它承载）',
      promptGuidelines: [
        '团队模式下任务是账本条目：拆解后立刻提交账本，再开始派活；只交变化项会丢掉其余条目。',
        '条目状态按 pending → assigned → running → review → done 推进，失败走 failed 并在 note 写一句原因。',
        '验收项在 review 阶段逐项勾选；未勾完的条目不改成 done，打回时在 note 里写清缺什么。',
        '账本跨轮有效：新一轮不必重建，但状态有变化就要立刻重新提交整份账本。',
        '账本不替代用户审批：需要用户确认的改动仍要在对话里单独列出。'
      ],
      parameters: BOARD_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const parsed = parseTeamBoardDetails({ ...(params as Record<string, unknown>), version: TEAM_BOARD_VERSION })
        // 目标缺失或结构不合法时原样报错，不用空账本冒充已提交。
        if (parsed === null) {
          return {
            content: [{ type: 'text' as const, text: '账本提交失败：至少需要 goal，且条目要有合法的 id 与 title。' }],
            details: { version: TEAM_BOARD_VERSION, goal: '（未提交）', facts: [], items: [] }
          }
        }
        // 成员与依赖在这里才对得上号：形状校验不知道团队名单，也看不到整份条目集合。
        const { board: details, ignored } = bindToTeam(parsed, members)
        const counts = teamBoardCounts(details)
        const summary = TEAM_BOARD_STATUSES.filter(status => counts[status] > 0)
          .map(status => `${statusMark(status)} ${counts[status]}`).join('、')
        const open = renderBoardOpenItems(details)
        const notice = ignored.length === 0
          ? ''
          : `\n已忽略不成立的指向：\n${ignored.map(item => `- ${item}`).join('\n')}`
        return {
          content: [{
            type: 'text' as const,
            text: `已提交团队账本：${details.items.length} 项（${summary || '暂无条目'}）。\n未完成条目：\n${open}${notice}`
          }],
          details
        }
      }
    })

    /**
     * 摘要段：每轮按账本重写，只给目标与各状态计数，具体条目留给回述与工具回执，
     * 避免把整份账本每轮塞进系统提示。
     */
    pi.on('before_agent_start', (event, ctx) => {
      const board = readTeamBoard(ctx.sessionManager.getBranch())
      if (board === null) return undefined
      event.systemPromptOptions.sections[TEAM_BOARD_SECTION_KEY] =
        `${renderBoardSummary(board)}\n条目状态、依赖与验收项以 ${TEAM_BOARD_TOOL_NAME} 的最新一次提交为准。`
      return undefined
    })

    /** 请求级回述：只在账本存在、且有未完成条目、本轮又走过整倍数个工具结果时追加。 */
    pi.on('context', (event, ctx) => {
      const branch = ctx.sessionManager.getBranch()
      const board = readTeamBoard(branch)
      if (board === null || teamBoardOpenItems(board).length === 0) return undefined
      const stale = countToolResultsSinceBoard(branch)
      if (stale === null || stale === 0 || stale % RECITE_INTERVAL !== 0) return undefined
      const reminder = {
        role: 'custom' as const,
        customType: RECITE_CUSTOM_TYPE,
        content: `${RECITE_PREFIX}\n${renderBoardSummary(board)}\n${renderBoardOpenItems(board)}`,
        display: false,
        details: { requestOnly: true, version: 1 },
        timestamp: Date.now()
      }
      return { messages: [...event.messages, reminder] }
    })
  }
}
