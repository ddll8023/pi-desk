/**
 * 团队资源（设置页）的固定通道、请求与结果类型及跨进程响应校验。
 *
 * 读：内置与自定义团队的合并清单、可开团判定与加载诊断；写：自定义团队的读取、保存与删除。
 * 内置团队只读，所有写通道只到产品 agent 目录下的 `teams/`；开团与成员会话在会话侧完成，不经这些通道。
 * 团队与专家是两套标识空间，但字符规则相同（目录名即标识），这里复用会话域的标识校验。
 */
import { isExpertId } from './session-api'

/** 读取团队清单：只返回合并结果与诊断，无请求参数。 */
export const TEAMS_LIST_CHANNEL = 'desktop:teams-list'
/** 读取一份自定义团队的声明与正文，供设置页编辑；内置团队不走这条通道。 */
export const TEAMS_READ_CHANNEL = 'desktop:team-read'
/** 新建或保存一份自定义团队；`teamId` 为空表示新建，由主进程分配标识。 */
export const TEAMS_SAVE_CHANNEL = 'desktop:team-save'
/** 删除一份自定义团队；内置团队只读，不能通过这条通道删除。 */
export const TEAMS_DELETE_CHANNEL = 'desktop:team-delete'

/** 单个团队的成员数上限：团队是人工配置的协作单元，超出说明配置写错而不是真的需要这么多人。 */
export const MAX_TEAM_MEMBERS = 32
/** 团队数量上限：与专家的规模同一量级，超出按清单无效处理，避免一次读入失控。 */
export const MAX_TEAM_ENTRIES = 256
/** 名称与简介的长度上限；超长定义仍可读，保存时由团队写通道拒绝。 */
export const MAX_TEAM_DISPLAY_NAME_LENGTH = 64
export const MAX_TEAM_SUMMARY_LENGTH = 200

export type TeamIssueKind =
  | 'definition-invalid'
  | 'id-conflict'
  | 'lead-reference-missing'
  | 'member-reference-missing'
  | 'no-usable-member'
  | 'lead-in-members'

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

export type TeamErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | 'INVALID_RESPONSE'
  | 'BRIDGE_UNAVAILABLE'
  /** 目标不是可写的自定义团队：内置、不存在或目录里还有别的文件。 */
  | 'NOT_USER_TEAM'
  /** 要读取或保存的自定义团队不存在。 */
  | 'NOT_FOUND'
  /** 定义本身不成立：字段为空、引用失效、成员为空或超限。 */
  | 'INVALID_DEFINITION'

export interface TeamError {
  readonly code: TeamErrorCode
  readonly message: string
}

export type TeamsListResult =
  | { readonly ok: true; readonly data: TeamCatalogView }
  | { readonly ok: false; readonly error: TeamError }

/** 编辑对话框需要的一份自定义团队：声明字段与正文一起返回，只在设置页使用。 */
export interface TeamEditableDefinition {
  readonly id: string
  readonly displayName: string
  readonly summary: string
  readonly leadExpertId: string
  readonly memberExpertIds: readonly string[]
  /** 协作约定正文：不进入系统提示，只供编辑与展示。 */
  readonly body: string
}

export interface TeamReadRequest {
  readonly teamId: string
}

export type TeamReadResult =
  | { readonly ok: true; readonly data: TeamEditableDefinition }
  | { readonly ok: false; readonly error: TeamError }

/**
 * 保存请求：`teamId` 为 `null` 表示新建（标识由主进程分配），否则更新该自定义团队。
 * 团长与成员都必须是当前清单里的专家标识；成员里的团长由主进程剔除。
 */
export interface TeamSaveRequest {
  readonly teamId: string | null
  readonly displayName: string
  readonly summary: string
  readonly leadExpertId: string
  readonly memberExpertIds: readonly string[]
  readonly body: string
}

export type TeamSaveResult =
  | { readonly ok: true; readonly data: { readonly teamId: string } }
  | { readonly ok: false; readonly error: TeamError }

export interface TeamDeleteRequest {
  readonly teamId: string
}

export type TeamDeleteResult =
  | { readonly ok: true; readonly data: { readonly teamId: string } }
  | { readonly ok: false; readonly error: TeamError }

export interface TeamApi {
  /** 读取团队清单与诊断；一次读取给出全部条目，不做分页。 */
  readonly listTeams: () => Promise<TeamsListResult>
  /** 读取一份自定义团队的声明与正文，供编辑对话框回填。 */
  readonly readTeamDefinition: (request: TeamReadRequest) => Promise<TeamReadResult>
  /** 新建或保存自定义团队；保存成功后定义立即出现在清单里。 */
  readonly saveTeam: (request: TeamSaveRequest) => Promise<TeamSaveResult>
  /** 删除一份自定义团队；内置团队与仍带其他文件的目录会被拒绝。 */
  readonly deleteTeam: (request: TeamDeleteRequest) => Promise<TeamDeleteResult>
}

const TEAM_ERROR_CODES: readonly string[] = [
  'FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'INVALID_RESPONSE', 'BRIDGE_UNAVAILABLE',
  'NOT_USER_TEAM', 'NOT_FOUND', 'INVALID_DEFINITION'
]

const TEAM_ISSUE_KINDS: readonly string[] = [
  'definition-invalid', 'id-conflict', 'lead-reference-missing',
  'member-reference-missing', 'no-usable-member', 'lead-in-members'
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

/** 成员名单：每项是合法专家标识，数量在团队上限内；重复项由主进程去重。 */
function isTeamMemberList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TEAM_MEMBERS) return false
  return value.every(item => isExpertId(item))
}

export function isTeamReadRequest(value: unknown): value is TeamReadRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'teamId')) return false
  return isExpertId(value.teamId)
}

export function isTeamDeleteRequest(value: unknown): value is TeamDeleteRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'teamId')) return false
  return isExpertId(value.teamId)
}

/** 保存请求：新建时 `teamId` 必须是 `null`，更新时必须是合法标识；正文可以为空。 */
export function isTeamSaveRequest(value: unknown): value is TeamSaveRequest {
  if (!isRecord(value)) return false
  const allowed = ['teamId', 'displayName', 'summary', 'leadExpertId', 'memberExpertIds', 'body']
  if (Object.keys(value).some(key => !allowed.includes(key))) return false
  if (value.teamId !== null && !isExpertId(value.teamId)) return false
  if (!isShortText(value.displayName, MAX_TEAM_DISPLAY_NAME_LENGTH)) return false
  if (!isShortText(value.summary, MAX_TEAM_SUMMARY_LENGTH)) return false
  if (!isExpertId(value.leadExpertId)) return false
  if (typeof value.body !== 'string') return false
  return isTeamMemberList(value.memberExpertIds)
}

function isTeamEditableDefinition(value: unknown): value is TeamEditableDefinition {
  if (!isRecord(value)) return false
  return isExpertId(value.id)
    && typeof value.displayName === 'string'
    && typeof value.summary === 'string'
    && typeof value.body === 'string'
    && isExpertId(value.leadExpertId)
    && isTeamMemberList(value.memberExpertIds)
}

export function isTeamReadResult(value: unknown): value is TeamReadResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isTeamError(value.error)
  return value.ok === true && isTeamEditableDefinition(value.data)
}

function isTeamIdAcknowledgement(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return false
  return isExpertId(value.data.teamId)
}

export function isTeamSaveResult(value: unknown): value is TeamSaveResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isTeamError(value.error)
  return isTeamIdAcknowledgement(value)
}

export function isTeamDeleteResult(value: unknown): value is TeamDeleteResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isTeamError(value.error)
  return isTeamIdAcknowledgement(value)
}
