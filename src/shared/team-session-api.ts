/**
 * 成员会话的固定通道、结果类型与跨进程响应校验。
 *
 * 只读：列出某个根会话下的成员登记、按登记读取成员会话的头部与首条预览。
 * 成员会话的会话文件落在产品 agent 目录的 team-sessions 下，不属于项目会话目录，
 * 因此这里的标识只用于本族通道，页面不能借此读取任意路径。
 * 派活与账本在宿主侧：派活会把消息发给成员会话并跑完一轮，账本随根会话记录；本通道不提供任何写入或启动入口。
 */
import { isExpertId, MAX_PROJECT_PATH_LENGTH } from './session-api'

/** 列出某个根会话的成员登记；请求是根会话标识。 */
export const TEAM_SESSIONS_LIST_CHANNEL = 'desktop:team-sessions-list'
/** 读取单个成员会话的头部与预览；请求是根会话标识加成员登记标识。 */
export const TEAM_SESSION_READ_CHANNEL = 'desktop:team-session-read'
/** 读取成员会话最近若干条消息；请求在同一对标识上另给条数。 */
export const TEAM_SESSION_HISTORY_CHANNEL = 'desktop:team-session-history'

/** 单个根会话的成员登记上限：与团队成员上限同一量级，超出按清单不完整处理。 */
export const MAX_TEAM_SESSIONS = 64
/** 预览文本上限：只用于列表里的一行摘要，不承载完整对话。 */
export const MAX_TEAM_SESSION_PREVIEW = 200
/** 单次读取的消息条数上限：成员会话的只读查看只看最近若干轮。 */
export const MAX_TEAM_SESSION_MESSAGES = 50
/** 单条消息正文上限；超出按截断处理，不把整篇内容塞进载荷。 */
export const MAX_TEAM_SESSION_MESSAGE_CHARS = 4_000

/** 成员会话状态：尚未派活、已有内容、登记存在但会话文件不见。 */
export type TeamSessionState = 'idle' | 'active' | 'missing'

/** 一条成员登记：只带标识与定位信息，不带正文。 */
export interface TeamSessionView {
  /** 登记标识：根会话内唯一，等于成员专家标识。 */
  readonly id: string
  readonly teamId: string
  readonly memberExpertId: string
  /** 成员会话 id：由根会话与成员确定性推出；会话文件尚不存在时也给出该 id。 */
  readonly sessionId: string | null
  readonly createdAt: string
  readonly state: TeamSessionState
}

/** 成员会话的只读内容：头部身份与首条预览，不含完整对话。 */
export interface TeamSessionContent {
  readonly id: string
  readonly sessionId: string | null
  readonly preview: string | null
  /** 会话文件的最后修改时间（毫秒）；文件不存在时为 null。 */
  readonly updatedAt: number | null
}

export interface TeamSessionError {
  readonly code: string
  readonly message: string
}

export type TeamSessionsListResult =
  | { readonly ok: true; readonly data: { readonly sessions: readonly TeamSessionView[] } }
  | { readonly ok: false; readonly error: TeamSessionError }

export type TeamSessionReadResult =
  | { readonly ok: true; readonly data: TeamSessionContent }
  | { readonly ok: false; readonly error: TeamSessionError }

/** 成员会话的一条消息：只保留角色与文本，工具调用与附件不进历史。 */
export interface TeamSessionMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** 成员会话的近期消息：`truncated` 为真表示文件里还有更早的消息未读出。 */
export interface TeamSessionHistory {
  readonly id: string
  readonly sessionId: string
  readonly messages: readonly TeamSessionMessage[]
  readonly truncated: boolean
}

export type TeamSessionHistoryResult =
  | { readonly ok: true; readonly data: TeamSessionHistory }
  | { readonly ok: false; readonly error: TeamSessionError }

export interface TeamSessionApi {
  /** 列出某个根会话的成员登记；一次给出全部，不分页。 */
  readonly listTeamSessions: (request: TeamSessionsListRequest) => Promise<TeamSessionsListResult>
  /** 读取单个成员会话的头部与预览。 */
  readonly readTeamSession: (request: TeamSessionReadRequest) => Promise<TeamSessionReadResult>
  /** 读取成员会话最近若干条消息；更早的消息不返回，由 `truncated` 标出。 */
  readonly readTeamSessionHistory: (request: TeamSessionHistoryRequest) => Promise<TeamSessionHistoryResult>
}

export interface TeamSessionsListRequest {
  /** 根会话所属项目；与其它会话通道一致，主进程会校验它是不是已添加项目。 */
  readonly projectPath: string
  readonly rootSessionId: string
}

export interface TeamSessionReadRequest {
  readonly projectPath: string
  readonly rootSessionId: string
  readonly teamSessionId: string
}

export interface TeamSessionHistoryRequest extends TeamSessionReadRequest {
  /** 要读取的最近消息条数；上限由 `MAX_TEAM_SESSION_MESSAGES` 约束。 */
  readonly limit: number
}

const TEAM_SESSION_ERROR_CODES: readonly string[] = [
  'FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'INVALID_RESPONSE', 'BRIDGE_UNAVAILABLE', 'NOT_FOUND'
]

const TEAM_SESSION_STATES: readonly string[] = ['idle', 'active', 'missing']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 会话标识：与项目会话 id 同一字符集，只做形状校验。
 * 这里不校验存在性——成员会话可以还没有文件。
 */
export function isTeamSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && /^[A-Za-z0-9._-]+$/.test(value)
}

/** 根会话标识沿用同一形状：两者都是 pi 的会话 id。 */
export function isTeamRootSessionId(value: unknown): value is string {
  return isTeamSessionId(value)
}

/** 项目路径只做形状校验：是否已添加项目由主进程用项目清单判定，页面不能借此探测目录。 */
function isProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_PROJECT_PATH_LENGTH
}

export function isTeamSessionsListRequest(value: unknown): value is TeamSessionsListRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => !['projectPath', 'rootSessionId'].includes(key))) return false
  return isProjectPath(value.projectPath) && isTeamRootSessionId(value.rootSessionId)
}

export function isTeamSessionReadRequest(value: unknown): value is TeamSessionReadRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => !['projectPath', 'rootSessionId', 'teamSessionId'].includes(key))) return false
  return isProjectPath(value.projectPath) && isTeamRootSessionId(value.rootSessionId)
    && isExpertId(value.teamSessionId)
}

export function isTeamSessionHistoryRequest(value: unknown): value is TeamSessionHistoryRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => !['projectPath', 'rootSessionId', 'teamSessionId', 'limit'].includes(key))) {
    return false
  }
  if (!isProjectPath(value.projectPath) || !isTeamRootSessionId(value.rootSessionId)) return false
  if (!isExpertId(value.teamSessionId)) return false
  return typeof value.limit === 'number' && Number.isSafeInteger(value.limit)
    && value.limit >= 1 && value.limit <= MAX_TEAM_SESSION_MESSAGES
}

function isTeamSessionView(value: unknown): value is TeamSessionView {
  if (!isRecord(value)) return false
  if (!isExpertId(value.id) || !isExpertId(value.teamId) || !isExpertId(value.memberExpertId)) return false
  if (value.sessionId !== null && !isTeamSessionId(value.sessionId)) return false
  if (typeof value.createdAt !== 'string' || value.createdAt === '') return false
  return typeof value.state === 'string' && TEAM_SESSION_STATES.includes(value.state)
}

function isTeamSessionError(value: unknown): value is TeamSessionError {
  if (!isRecord(value)) return false
  return typeof value.code === 'string' && TEAM_SESSION_ERROR_CODES.includes(value.code)
    && typeof value.message === 'string'
}

export function isTeamSessionsListResult(value: unknown): value is TeamSessionsListResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isTeamSessionError(value.error)
  if (value.ok !== true || !isRecord(value.data)) return false
  const sessions = value.data.sessions
  if (!Array.isArray(sessions) || sessions.length > MAX_TEAM_SESSIONS) return false
  return sessions.every(isTeamSessionView)
}

export function isTeamSessionHistoryResult(value: unknown): value is TeamSessionHistoryResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isTeamSessionError(value.error)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  if (!isExpertId(data.id) || !isTeamSessionId(data.sessionId)) return false
  if (typeof data.truncated !== 'boolean') return false
  if (!Array.isArray(data.messages) || data.messages.length > MAX_TEAM_SESSION_MESSAGES) return false
  return data.messages.every(message => isRecord(message)
    && (message.role === 'user' || message.role === 'assistant')
    && typeof message.text === 'string' && message.text.length <= MAX_TEAM_SESSION_MESSAGE_CHARS)
}

export function isTeamSessionReadResult(value: unknown): value is TeamSessionReadResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isTeamSessionError(value.error)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  if (!isExpertId(data.id)) return false
  if (data.sessionId !== null && !isTeamSessionId(data.sessionId)) return false
  if (data.preview !== null && (typeof data.preview !== 'string' || data.preview.length > MAX_TEAM_SESSION_PREVIEW)) {
    return false
  }
  return data.updatedAt === null || (typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt))
}
