/**
 * 团队清单（设置页与后续开团选择器）的固定通道、结果类型与跨进程响应校验。
 *
 * 只读：读取内置与自定义团队的合并结果、可开团判定与加载诊断；本通道不创建团队、不写盘，
 * 也不创建成员会话；开团在会话侧完成，不经本通道。
 * 团队与专家是两套标识空间，但字符规则相同（目录名即标识），这里复用会话域的标识校验。
 */
import { isExpertId } from './session-api'

/** 读取团队清单：只返回合并结果与诊断，无请求参数。 */
export const TEAMS_LIST_CHANNEL = 'desktop:teams-list'

/** 单个团队的成员数上限：团队是人工配置的协作单元，超出说明配置写错而不是真的需要这么多人。 */
export const MAX_TEAM_MEMBERS = 32
/** 团队数量上限：与专家的规模同一量级，超出按清单无效处理，避免一次读入失控。 */
export const MAX_TEAM_ENTRIES = 256
/** 名称与简介的长度上限；超长定义仍可读，只在新保存时由后续写入通道拒绝。 */
export const MAX_TEAM_DISPLAY_NAME_LENGTH = 64
export const MAX_TEAM_SUMMARY_LENGTH = 200

export type TeamIssueKind =
  | 'definition-invalid'
  | 'id-conflict'
  | 'lead-reference-missing'
  | 'member-reference-missing'
  | 'no-usable-member'

/** 团队清单里的一项：只带结构信息，不带正文。 */
export interface TeamView {
  readonly id: string
  readonly displayName: string
  readonly summary: string
  readonly leadExpertId: string
  readonly memberExpertIds: readonly string[]
  readonly source: 'builtin' | 'user'
  /** 团长与至少一名成员都在专家清单里时为真；为假时界面应禁止开团并给出诊断。 */
  readonly ready: boolean
}

export interface TeamIssueView {
  readonly kind: TeamIssueKind
  readonly teamId: string | null
  /** 引用类诊断指向的专家标识；其余为 null。 */
  readonly expertId: string | null
  readonly path: string
}

export interface TeamCatalogView {
  readonly teams: readonly TeamView[]
  readonly issues: readonly TeamIssueView[]
}

export interface TeamError {
  readonly code: string
  readonly message: string
}

export type TeamsListResult =
  | { readonly ok: true; readonly data: TeamCatalogView }
  | { readonly ok: false; readonly error: TeamError }

export interface TeamApi {
  /** 读取团队清单与诊断；一次读取给出全部条目，不做分页。 */
  readonly listTeams: () => Promise<TeamsListResult>
}

const TEAM_ERROR_CODES: readonly string[] = [
  'FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'INVALID_RESPONSE', 'BRIDGE_UNAVAILABLE'
]

const TEAM_ISSUE_KINDS: readonly string[] = [
  'definition-invalid', 'id-conflict', 'lead-reference-missing',
  'member-reference-missing', 'no-usable-member'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isShortText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function isTeamView(value: unknown): value is TeamView {
  if (!isRecord(value)) return false
  if (!isExpertId(value.id) || !isShortText(value.displayName, MAX_TEAM_DISPLAY_NAME_LENGTH)) return false
  if (!isShortText(value.summary, MAX_TEAM_SUMMARY_LENGTH)) return false
  if (!isExpertId(value.leadExpertId)) return false
  if (value.source !== 'builtin' && value.source !== 'user') return false
  if (typeof value.ready !== 'boolean') return false
  if (!Array.isArray(value.memberExpertIds) || value.memberExpertIds.length > MAX_TEAM_MEMBERS) return false
  return value.memberExpertIds.every(item => isExpertId(item))
}

function isTeamIssueView(value: unknown): value is TeamIssueView {
  if (!isRecord(value)) return false
  if (typeof value.kind !== 'string' || !TEAM_ISSUE_KINDS.includes(value.kind)) return false
  if (value.teamId !== null && !isExpertId(value.teamId)) return false
  if (value.expertId !== null && !isExpertId(value.expertId)) return false
  return typeof value.path === 'string' && value.path.length > 0
}

function isTeamError(value: unknown): value is TeamError {
  if (!isRecord(value)) return false
  return typeof value.code === 'string' && TEAM_ERROR_CODES.includes(value.code)
    && typeof value.message === 'string'
}

/** 团队清单响应校验：跨进程结果先按这份契约收口，页面不信任桥接层的形状。 */
export function isTeamsListResult(value: unknown): value is TeamsListResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isTeamError(value.error)
  if (value.ok !== true || !isRecord(value.data)) return false
  const { teams, issues } = value.data
  if (!Array.isArray(teams) || teams.length > MAX_TEAM_ENTRIES) return false
  if (!Array.isArray(issues)) return false
  return teams.every(isTeamView) && issues.every(isTeamIssueView)
}
